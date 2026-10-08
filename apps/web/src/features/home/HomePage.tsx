import { useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { ChevronRight, ListTodo, Plus, Search, Sparkles, StickyNote } from 'lucide-react'
import { initials, StatusLight } from '@/components/app/brand'
import { PageHeader } from '@/components/app/page'
import { showSearch } from '@/components/app/search'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { api, meQuery, spaceQuery, unwrap } from '@/lib/api'
import { cn } from '@/lib/utils'
import { relativeTime, sessionsQuery, shortPath, type Session } from '@/features/claude/data'
import { NewSession } from '@/features/claude/SessionsPage'
import { servicesQuery, useLiveServices } from '@/features/services/data'
import { ActivityList } from '@/features/work/Activity'
import { activityQuery, dueLabel, tasksQuery, useLiveWork, type Task } from '@/features/work/data'
import { Due, NewTask, PriorityIcon, StatusIcon } from '@/features/work/TaskBits'

const greeting = () => {
  const h = new Date().getHours()
  return h < 5 ? 'Up late' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'
}
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const today = () => new Date().toISOString().slice(0, 10)

/**
 * Home answers four questions, in this order: what needs me, what's running, what's on my plate, what did the
 * team do. The sentence at the top says it all at a glance; every part of it is a link.
 */
export function HomePage() {
  useLiveWork()
  useLiveServices()
  const me = useQuery(meQuery).data!
  const space = useQuery(spaceQuery).data
  const sessions = useQuery(sessionsQuery(false)).data?.sessions ?? []
  const myTasks = (useQuery(tasksQuery({ assignee: 'me' })).data?.tasks ?? []).filter((t) => t.status !== 'done')
  const services = useQuery(servicesQuery).data?.services ?? []
  const activity = useQuery(activityQuery()).data?.activity ?? []
  const members = useQuery({ queryKey: ['members'], queryFn: () => unwrap(api.api.members.$get()) }).data?.users ?? []
  const [creating, setCreating] = useState(false)
  const [newTask, setNewTask] = useState(false)

  const waiting = sessions.filter((s) => s.status === 'waiting' && s.owner.id === me.id)
  const working = sessions.filter((s) => s.status === 'working')
  const recent = sessions.filter((s) => s.status !== 'waiting' && s.status !== 'working' && s.owner.id === me.id).slice(0, 4)
  const urgent = myTasks.filter((t) => t.due && t.due <= today()).sort((a, b) => a.due!.localeCompare(b.due!))
  const upcoming = myTasks.filter((t) => !urgent.includes(t))
    .sort((a, b) => (a.due ?? '9999').localeCompare(b.due ?? '9999') || rank(a) - rank(b))
  const crashed = services.filter((s) => s.state === 'crashed' && s.owner.id === me.id)
  const up = services.filter((s) => s.state === 'running')
  const needsYou = waiting.length + urgent.length + crashed.length

  return (
    <>
      <PageHeader title={space?.name ?? 'Home'} actions={<Button size="sm" onClick={() => setCreating(true)}><Plus />New session</Button>} />
      <div className="mx-auto grid w-full max-w-6xl gap-x-10 gap-y-8 px-4 py-6 md:px-6 md:py-8 lg:grid-cols-[minmax(0,1fr)_19rem]">
        <div className="flex min-w-0 flex-col gap-8">
          <Briefing name={me.name.split(' ')[0]!} waiting={waiting.length} working={working.length} urgent={urgent} up={up.length} total={services.length} crashed={crashed.length} />
          <div className="-mx-4 -mt-4 flex gap-2 overflow-x-auto px-4 lg:hidden">
            <Button variant="outline" size="sm" className="rounded-full" onClick={() => setNewTask(true)}><ListTodo />New task</Button>
            <Button variant="outline" size="sm" className="rounded-full" asChild><Link to="/notes/$id" params={{ id: 'new' }}><StickyNote />New note</Link></Button>
            <Button variant="outline" size="sm" className="rounded-full" onClick={showSearch}><Search />Search</Button>
          </div>

          <Block title="Needs you" count={needsYou}>
            {needsYou === 0 ? <Calm>Nothing needs you right now.</Calm> : (
              <ul className="flex flex-col gap-2">
                {waiting.map((s) => (
                  <Row key={s.id} to={`/claude/${s.id}`} tone="attention" lead={<Sparkles className="size-4 text-attention-foreground" />}
                    title={s.title} detail={`Claude is waiting for your answer${s.project ? ` in ${s.project.name}` : ''}`} />
                ))}
                {crashed.map((s) => (
                  <Row key={s.name} to={`/services/${s.name}`} tone="error" lead={<StatusLight state="error" />}
                    title={<span className="font-mono">{s.name}</span>} detail="Crashed and stopped restarting. Check its logs." />
                ))}
                {urgent.map((t) => (
                  <Row key={t.key} to={`/tasks/${t.project.slug}/${t.number}`} lead={<StatusIcon status={t.status} />}
                    title={t.title} detail={<span className="flex items-center gap-2"><span className="font-mono">{t.key}</span><Due due={t.due} /></span>} />
                ))}
              </ul>
            )}
          </Block>

          <Block title="Running now" count={working.length + up.length}>
            {working.length + up.length === 0 ? <Calm>Nothing is running. Claude sessions and services show here while they work.</Calm> : (
              <div className="flex flex-col gap-3">
                {working.length > 0 && (
                  <ul className="flex flex-col gap-2">
                    {working.map((s) => <WorkingRow key={s.id} s={s} mine={s.owner.id === me.id} />)}
                  </ul>
                )}
                {up.length > 0 && (
                  <ul className="flex flex-wrap gap-2">
                    {up.map((s) => (
                      <li key={s.name}>
                        <Link to="/services/$name" params={{ name: s.name }}
                          className="flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm hover:bg-accent/50">
                          <StatusLight state={s.listening ? 'live' : 'idle'} />
                          <span className="font-mono">{s.name}</span>
                          <span className="font-mono text-xs text-muted-foreground">:{s.port}</span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </Block>

          <Block title="Your tasks" count={upcoming.length} link={{ to: '/tasks', label: 'Board' }}>
            {upcoming.length === 0 ? <Calm>{urgent.length ? 'Nothing else on your plate.' : 'No tasks assigned to you.'} <button className="underline underline-offset-4" onClick={() => setNewTask(true)}>Add one</button></Calm> : (
              <ul className="overflow-hidden rounded-xl border">
                {upcoming.slice(0, 7).map((t) => <TaskLine key={t.key} t={t} />)}
              </ul>
            )}
          </Block>

          {recent.length > 0 && (
            <Block title="Pick up where you left off" link={{ to: '/claude', label: 'All sessions' }}>
              <ul className="grid gap-2 sm:grid-cols-2">
                {recent.map((s) => (
                  <li key={s.id}>
                    <Link to="/claude/$id" params={{ id: s.id }} className="flex h-full flex-col gap-1 rounded-xl border p-3 text-sm hover:bg-accent/40">
                      <span className="line-clamp-1 font-medium">{s.title}</span>
                      <span className="line-clamp-1 text-xs text-muted-foreground">
                        {relativeTime(s.lastActivityAt)}, {s.project ? s.project.name : <span className="font-mono">{shortPath(s.cwd, s.owner.username)}</span>}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </Block>
          )}
        </div>

        <aside className="flex flex-col gap-8">
          <div className="hidden grid-cols-2 gap-2 lg:grid">
            <Quick icon={<Sparkles />} label="New session" onClick={() => setCreating(true)} />
            <Quick icon={<ListTodo />} label="New task" onClick={() => setNewTask(true)} />
            <Quick icon={<StickyNote />} label="New note" to="/notes/new" />
            <Quick icon={<Search />} label="Search" hint="⌘K" onClick={showSearch} />
          </div>

          {members.length > 1 && (
            <Block title="Team">
              <ul className="flex flex-col gap-2.5">
                {members.map((u) => {
                  const busy = working.filter((s) => s.owner.id === u.id).length
                  return (
                    <li key={u.id} className="flex items-center gap-3 text-sm">
                      <Avatar className="size-8"><AvatarFallback className="text-[11px]">{initials(u.name)}</AvatarFallback></Avatar>
                      <span className="min-w-0 flex-1 truncate">{u.name}{u.id === me.id && <span className="text-muted-foreground"> (you)</span>}</span>
                      {busy > 0 && <span className="flex items-center gap-1.5 text-xs text-muted-foreground"><StatusLight state="live" />{plural(busy, 'session')}</span>}
                    </li>
                  )
                })}
              </ul>
            </Block>
          )}

          <Block title="Activity">
            <ActivityList items={activity.slice(0, 12)} showProject />
          </Block>
        </aside>
      </div>
      <NewSession open={creating} onClose={() => setCreating(false)} />
      <NewTask open={newTask} onClose={() => setNewTask(false)} />
    </>
  )
}

const rank = (t: Task) => ['urgent', 'high', 'medium', 'low', 'none'].indexOf(t.priority)

/** The sentence at the top. Calm when nothing is going on; each fact links to where you act on it. */
function Briefing({ name, waiting, working, urgent, up, total, crashed }: {
  name: string; waiting: number; working: number; urgent: Task[]; up: number; total: number; crashed: number
}) {
  const late = urgent.filter((t) => dueLabel(t.due)?.late).length
  const parts: ReactNode[] = []
  if (waiting) parts.push(<Fact key="w" to="/claude" tone="attention">{plural(waiting, 'Claude session')} {waiting === 1 ? 'needs' : 'need'} you</Fact>)
  if (late) parts.push(<Fact key="l" to="/tasks" tone="error">{plural(late, 'task')} overdue</Fact>)
  if (urgent.length - late) parts.push(<Fact key="t" to="/tasks" tone="attention">{plural(urgent.length - late, 'task')} due today</Fact>)
  if (crashed) parts.push(<Fact key="c" to="/services" tone="error">{plural(crashed, 'service')} crashed</Fact>)
  if (working) parts.push(<Fact key="r" to="/claude" tone="live">{plural(working, 'session')} working</Fact>)
  if (total) parts.push(<Fact key="s" to="/services">{up} of {plural(total, 'service')} up</Fact>)
  return (
    <header className="flex flex-col gap-2">
      <p className="text-sm text-muted-foreground">{greeting()}, {name}.</p>
      <h2 className="max-w-[40ch] text-2xl leading-snug font-semibold tracking-tight text-balance md:text-[1.75rem]">
        {parts.length === 0 ? 'All quiet. Nothing needs you and nothing is running.' : parts.map((p, i) => (
          <span key={i}>{p}{i < parts.length - 2 ? ', ' : i === parts.length - 2 ? ' and ' : '.'}</span>
        ))}
      </h2>
    </header>
  )
}

function Fact({ to, tone, children }: { to: string; tone?: 'attention' | 'error' | 'live'; children: ReactNode }) {
  return (
    <Link to={to} className={cn('underline decoration-1 decoration-foreground/20 underline-offset-[6px] hover:decoration-current',
      tone === 'attention' && 'text-attention', tone === 'error' && 'text-destructive', tone === 'live' && 'text-live')}>
      {children}
    </Link>
  )
}

function Block({ title, count, link, children }: { title: string; count?: number; link?: { to: string; label: string }; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-sm font-medium">{title}{count ? <span className="ml-1.5 text-muted-foreground tabular-nums">{count}</span> : null}</h3>
        {link && <Link to={link.to} className="text-sm text-muted-foreground hover:text-foreground">{link.label}</Link>}
      </div>
      {children}
    </section>
  )
}

const Calm = ({ children }: { children: ReactNode }) => <p className="text-sm text-muted-foreground">{children}</p>

function Row({ to, lead, title, detail, tone }: { to: string; lead: ReactNode; title: ReactNode; detail: ReactNode; tone?: 'attention' | 'error' }) {
  return (
    <li>
      <Link to={to} className={cn('flex items-center gap-3 rounded-xl border px-3.5 py-3 text-sm transition-colors hover:bg-accent/40',
        tone === 'attention' && 'border-attention/40 bg-attention-soft hover:bg-attention-soft', tone === 'error' && 'border-destructive/40')}>
        <span className="flex size-4 shrink-0 items-center justify-center">{lead}</span>
        <span className="min-w-0 flex-1">
          <span className="line-clamp-1 font-medium">{title}</span>
          <span className="line-clamp-1 text-xs text-muted-foreground">{detail}</span>
        </span>
        <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
      </Link>
    </li>
  )
}

function WorkingRow({ s, mine }: { s: Session; mine: boolean }) {
  return (
    <li>
      <Link to="/claude/$id" params={{ id: s.id }} className="flex items-center gap-3 rounded-xl border px-3.5 py-3 text-sm hover:bg-accent/40">
        <StatusLight state="live" />
        <span className="min-w-0 flex-1">
          <span className="line-clamp-1 font-medium">{s.title}</span>
          <span className="line-clamp-1 text-xs text-muted-foreground">
            {s.statusDetail || 'Working'}, {s.project ? s.project.name : <span className="font-mono">{shortPath(s.cwd, s.owner.username)}</span>}
          </span>
        </span>
        {!mine && <Avatar className="size-7" title={s.owner.name}><AvatarFallback className="text-[10px]">{initials(s.owner.name)}</AvatarFallback></Avatar>}
      </Link>
    </li>
  )
}

function TaskLine({ t }: { t: Task }) {
  return (
    <li className="border-b last:border-b-0">
      <Link to="/tasks/$slug/$number" params={{ slug: t.project.slug, number: String(t.number) }} className="flex items-center gap-3 px-3.5 py-2.5 text-sm hover:bg-accent/40">
        <StatusIcon status={t.status} />
        <span className="min-w-0 flex-1 truncate">{t.title}</span>
        <PriorityIcon priority={t.priority} />
        <Due due={t.due} />
        <span className="hidden font-mono text-xs text-muted-foreground sm:inline">{t.key}</span>
      </Link>
    </li>
  )
}

function Quick({ icon, label, hint, onClick, to }: { icon: ReactNode; label: string; hint?: string; onClick?: () => void; to?: string }) {
  const cls = 'flex h-20 flex-col items-start justify-between rounded-xl border p-3 text-left text-sm font-medium transition-colors hover:bg-accent/40 [&_svg]:size-4 [&_svg]:text-muted-foreground'
  const body = <>{icon}<span className="flex w-full items-baseline justify-between">{label}{hint && <kbd className="font-mono text-[10px] text-muted-foreground">{hint}</kbd>}</span></>
  return to ? <Link to={to} className={cls}>{body}</Link> : <button className={cls} onClick={onClick}>{body}</button>
}

