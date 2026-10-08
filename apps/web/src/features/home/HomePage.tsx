import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { ChevronRight, ListTodo, Plus, Settings2, Sparkles, SquareTerminal, UserPlus } from 'lucide-react'
import { initials, StatusLight } from '@/components/app/brand'
import { PageBody, PageHeader, Section } from '@/components/app/page'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle } from '@/components/ui/item'
import { api, meQuery, spaceQuery, unwrap } from '@/lib/api'
import { NewSession } from '@/features/claude/SessionsPage'
import { ActivityList } from '@/features/work/Activity'
import { activityQuery, tasksQuery, useLiveWork } from '@/features/work/data'
import { NewTask, TaskRow } from '@/features/work/TaskBits'
import { relativeTime, sessionsQuery, shortPath } from '@/features/claude/data'

const greeting = () => {
  const h = new Date().getHours()
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'
}

export function HomePage() {
  const me = useQuery(meQuery).data!
  const space = useQuery(spaceQuery).data
  const sessions = useQuery(sessionsQuery(false))
  const members = useQuery({ queryKey: ['members'], queryFn: () => unwrap(api.api.members.$get()) })
  const [creating, setCreating] = useState(false)
  const [newTask, setNewTask] = useState(false)
  useLiveWork()
  const myTasks = (useQuery(tasksQuery({ assignee: 'me' })).data?.tasks ?? [])
    .filter((t) => t.status !== 'done')
    .sort((a, b) => (a.due ?? '9999').localeCompare(b.due ?? '9999') || ['urgent', 'high', 'medium', 'low', 'none'].indexOf(a.priority) - ['urgent', 'high', 'medium', 'low', 'none'].indexOf(b.priority))
  const activity = useQuery(activityQuery()).data?.activity ?? []

  const all = sessions.data?.sessions ?? []
  const waiting = all.filter((s) => s.status === 'waiting')
  const running = all.filter((s) => s.status === 'working')
  const recent = all.filter((s) => s.status !== 'waiting' && s.status !== 'working').slice(0, 5)

  return (
    <>
      <PageHeader title={space?.name ?? 'Home'} actions={<Button size="sm" onClick={() => setCreating(true)}><Plus />New session</Button>} />
      <PageBody className="max-w-6xl">
        <h2 className="text-2xl font-semibold tracking-tight">{greeting()}, {me.name.split(' ')[0]}</h2>
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_18rem] lg:items-start">
        <div className="flex min-w-0 flex-col gap-6">

        {waiting.length > 0 && (
          <Section title="Needs you">
            <ItemGroup className="gap-2">
              {waiting.map((s) => (
                <Item key={s.id} asChild className="border-attention/40 bg-attention-soft">
                  <Link to="/claude/$id" params={{ id: s.id }}>
                    <ItemMedia><StatusLight state="waiting" /></ItemMedia>
                    <ItemContent>
                      <ItemTitle>{s.title}</ItemTitle>
                      <ItemDescription>Claude is waiting for your answer in <span className="font-mono">{shortPath(s.cwd, s.owner.username)}</span></ItemDescription>
                    </ItemContent>
                    <ItemActions><ChevronRight className="size-4 text-muted-foreground" /></ItemActions>
                  </Link>
                </Item>
              ))}
            </ItemGroup>
          </Section>
        )}

        <Section title="Claude" action={<Button variant="link" size="sm" asChild className="h-auto p-0"><Link to="/claude">All sessions</Link></Button>}>
          {running.length + recent.length === 0 ? (
            <Empty className="border">
              <EmptyHeader>
                <EmptyMedia variant="icon"><Sparkles /></EmptyMedia>
                <EmptyTitle>No sessions yet</EmptyTitle>
                <EmptyDescription>Start one and Claude works on the server as you, even after you close the app.</EmptyDescription>
              </EmptyHeader>
              <EmptyContent><Button onClick={() => setCreating(true)}><Plus />New session</Button></EmptyContent>
            </Empty>
          ) : (
            <ItemGroup className="rounded-xl border">
              {[...running, ...recent].map((s) => (
                <Item key={s.id} asChild className="rounded-none border-0 border-b last:border-b-0">
                  <Link to="/claude/$id" params={{ id: s.id }}>
                    <ItemMedia><StatusLight state={s.status === 'working' ? 'live' : s.status === 'error' ? 'error' : 'idle'} /></ItemMedia>
                    <ItemContent>
                      <ItemTitle className="line-clamp-1">{s.title}</ItemTitle>
                      <ItemDescription className="line-clamp-1">
                        {s.status === 'working' ? 'Working' : relativeTime(s.lastActivityAt)}, <span className="font-mono">{shortPath(s.cwd, s.owner.username)}</span>
                      </ItemDescription>
                    </ItemContent>
                    {s.owner.id !== me.id && (
                      <ItemActions>
                        <Avatar className="size-7"><AvatarFallback className="text-[11px]">{initials(s.owner.name)}</AvatarFallback></Avatar>
                      </ItemActions>
                    )}
                  </Link>
                </Item>
              ))}
            </ItemGroup>
          )}
        </Section>

        {myTasks.length > 0 && (
          <Section title="Your tasks" action={<Button variant="link" size="sm" asChild className="h-auto p-0"><Link to="/tasks">All tasks</Link></Button>}>
            <div className="overflow-hidden rounded-xl border">
              {myTasks.slice(0, 8).map((t) => <TaskRow key={t.key} t={t} showProject />)}
            </div>
          </Section>
        )}

        {activity.length > 0 && (
          <Section title="Activity">
            <ActivityList items={activity.slice(0, 15)} showProject />
          </Section>
        )}
        </div>

        <div className="flex flex-col gap-6">
          <Section title="Shortcuts">
            <ItemGroup className="rounded-xl border">
              <Item asChild size="sm" className="rounded-none border-0 border-b">
                <button onClick={() => setCreating(true)}><ItemMedia variant="icon"><Plus /></ItemMedia><ItemContent><ItemTitle>New Claude session</ItemTitle></ItemContent></button>
              </Item>
              <Item asChild size="sm" className="rounded-none border-0 border-b">
                <button onClick={() => setNewTask(true)}><ItemMedia variant="icon"><ListTodo /></ItemMedia><ItemContent><ItemTitle>New task</ItemTitle></ItemContent></button>
              </Item>
              <Item asChild size="sm" className="rounded-none border-0 border-b">
                <Link to="/terminal"><ItemMedia variant="icon"><SquareTerminal /></ItemMedia><ItemContent><ItemTitle>Open a terminal</ItemTitle></ItemContent></Link>
              </Item>
              <Item asChild size="sm" className="rounded-none border-0 border-b last:border-b-0">
                <Link to="/claude/setup"><ItemMedia variant="icon"><Settings2 /></ItemMedia><ItemContent><ItemTitle>Claude setup</ItemTitle></ItemContent></Link>
              </Item>
              {me.role === 'admin' && (
                <Item asChild size="sm" className="rounded-none border-0">
                  <Link to="/members"><ItemMedia variant="icon"><UserPlus /></ItemMedia><ItemContent><ItemTitle>Invite someone</ItemTitle></ItemContent></Link>
                </Item>
              )}
            </ItemGroup>
          </Section>
          {members.data && (
            <Section title="Team" action={<Button variant="link" size="sm" asChild className="h-auto p-0"><Link to="/members">All</Link></Button>}>
              <ItemGroup className="rounded-xl border">
                {members.data.users.slice(0, 6).map((u) => (
                  <Item key={u.id} size="sm" className="rounded-none border-0 border-b last:border-b-0">
                    <ItemMedia><Avatar className="size-7"><AvatarFallback className="text-[11px]">{initials(u.name)}</AvatarFallback></Avatar></ItemMedia>
                    <ItemContent><ItemTitle>{u.name}</ItemTitle><ItemDescription>{u.role === 'admin' ? 'Admin' : 'Member'}</ItemDescription></ItemContent>
                  </Item>
                ))}
              </ItemGroup>
            </Section>
          )}
        </div>
        </div>
      </PageBody>
      <NewSession open={creating} onClose={() => setCreating(false)} />
      <NewTask open={newTask} onClose={() => setNewTask(false)} />
    </>
  )
}
