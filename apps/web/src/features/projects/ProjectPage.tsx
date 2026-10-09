import { useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useParams } from '@tanstack/react-router'
import { Copy, GitBranch, GitCommitHorizontal, Plus, RefreshCw, Sparkles, StickyNote } from 'lucide-react'
import { toast } from 'sonner'
import { StatusLight } from '@/components/app/brand'
import { PageBody, PageHeader, Section } from '@/components/app/page'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabCount, TabsTrigger } from '@/components/ui/tabs'
import { ErrorAlert } from '../auth/LoginPage'
import { relativeTime, sessionsQuery, STATUS_LABEL, type Session } from '../claude/data'
import { NewSession } from '../claude/SessionsPage'
import { Board } from '../work/Board'
import { activityQuery, commitsQuery, notesQuery, projectQuery, STATUSES, tasksQuery, useLiveWork, type Task } from '../work/data'
import { StatusIcon, TaskRow } from '../work/TaskBits'
import { cn } from '@/lib/utils'
import { ActivityList } from '../work/Activity'
import { NoteList } from '../notes/NotesPage'
import { repoLabel } from './ProjectsPage'
import { BuildsTab } from '../builds/BuildsTab'
import { api, unwrap } from '@/lib/api'

/** Keyed by the URL, so moving to another one starts from a clean slate. */
export function ProjectPage() {
  const p = useParams({ from: '/app/projects/$slug' })
  return <ProjectPageView key={p.slug} />
}

function ProjectPageView() {
  useLiveWork()
  const { slug } = useParams({ from: '/app/projects/$slug' })
  const qc = useQueryClient()
  const q = useQuery(projectQuery(slug))
  const tasks = useQuery(tasksQuery({ project: slug }))
  const [session, setSession] = useState(false)
  const [tab, setTab] = useState('overview')
  const fetchNow = useMutation({
    mutationFn: () => unwrap(api.api.projects[':slug'].fetch.$post({ param: { slug } })),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['projects'] }); toast.success('Fetched.') },
    onError: (e) => toast.error(e.message),
  })
  const p = q.data?.project

  if (q.error) return <><PageHeader title={slug} back="/projects" /><div className="p-4"><ErrorAlert error={q.error} /></div></>
  if (!p) return <><PageHeader title={slug} back="/projects" /><div className="p-4"><Skeleton className="h-40" /></div></>

  return (
    <>
      <PageHeader back="/projects" title={p.name}
        description={<span className="flex items-center gap-1.5"><span className="truncate font-mono">{repoLabel(p.repoUrl)}</span><GitBranch className="size-3.5 shrink-0" />{p.defaultBranch}</span>}
        actions={<>
          {p.repoUrl && <Button size="icon-sm" variant="ghost" aria-label="Fetch now" disabled={fetchNow.isPending} onClick={() => fetchNow.mutate()}><RefreshCw className={fetchNow.isPending ? 'animate-spin' : ''} /></Button>}
          <Button size="sm" variant="outline" onClick={() => setSession(true)}><Sparkles /><span className="hidden sm:inline">Claude</span></Button>
        </>} />
      <PageBody>
        {p.fetchError && (
          <Alert variant="destructive"><AlertDescription>Couldn't fetch: {p.fetchError}</AlertDescription></Alert>
        )}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <button className="flex items-center gap-1 font-mono hover:text-foreground" onClick={() => void navigator.clipboard.writeText(p.path).then(() => toast.success('Path copied'))}>
            <Copy className="size-3.5" />{p.path}
          </button>
          {p.repoUrl && <span>{p.fetchedAt ? `Fetched ${relativeTime(p.fetchedAt)}` : 'Not fetched yet'}, every 5 minutes</span>}
          <span>Task numbers here are DevDash's own: <span className="font-mono">fixes #N</span> in a commit refers to {p.slug}#N.</span>
        </div>

        <Tabs value={tab} onValueChange={setTab} className="gap-4">
          <TabsList variant="line">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="tasks">Tasks{p.openTasks > 0 && <TabCount>{p.openTasks}</TabCount>}</TabsTrigger>
            <TabsTrigger value="notes">Notes</TabsTrigger>
            <TabsTrigger value="sessions">
              Claude
              {p.live.working + p.live.waiting > 0 ? <StatusLight state={p.live.working ? 'live' : 'waiting'} /> : p.sessions > 0 && <TabCount>{p.sessions}</TabCount>}
            </TabsTrigger>
            <TabsTrigger value="builds">Builds</TabsTrigger>
            <TabsTrigger value="commits">Commits</TabsTrigger>
            <TabsTrigger value="activity">Activity</TabsTrigger>
          </TabsList>
          <TabsContent value="overview">
            <Overview slug={slug} live={p.live} tasks={tasks.data?.tasks} onTab={setTab} onNew={() => setSession(true)} />
          </TabsContent>
          <TabsContent value="tasks">
            <ErrorAlert error={tasks.error} />
            {tasks.data && <Board tasks={tasks.data.tasks} project={slug} showProject={false} />}
          </TabsContent>
          <TabsContent value="notes"><ProjectNotes slug={slug} /></TabsContent>
          <TabsContent value="sessions"><ProjectSessions slug={slug} onNew={() => setSession(true)} /></TabsContent>
          <TabsContent value="builds"><BuildsTab slug={slug} isGithub={/github\.com/.test(p.repoUrl ?? '')} /></TabsContent>
          <TabsContent value="commits"><Commits slug={slug} /></TabsContent>
          <TabsContent value="activity"><ProjectActivity slug={slug} /></TabsContent>
        </Tabs>
      </PageBody>
      <NewSession open={session} onClose={() => setSession(false)} initialProject={slug} />
    </>
  )
}

function ProjectNotes({ slug }: { slug: string }) {
  const notes = useQuery(notesQuery(slug))
  return (
    <Section action={<Button size="sm" variant="outline" asChild><Link to="/notes/$id" params={{ id: 'new' }} search={{ project: slug }}><StickyNote />New note</Link></Button>}>
      <ErrorAlert error={notes.error} />
      {notes.data && <NoteList notes={notes.data.notes} empty="No notes in this project yet. Pin decisions, setup steps and links here." />}
    </Section>
  )
}

const isActive = (s: Session) => s.status === 'working' || s.status === 'waiting'
const projectSessions = (all: Session[] | undefined, slug: string) =>
  (all ?? []).filter((s) => s.project?.slug === slug).sort((a, b) => Number(isActive(b)) - Number(isActive(a)))

function SessionList({ sessions }: { sessions: Session[] }) {
  return (
    <ul className="overflow-hidden rounded-xl border">
      {sessions.map((s) => (
        <li key={s.id} className="border-b last:border-b-0">
          <Link to="/claude/$id" params={{ id: s.id }} className="flex items-center gap-3 px-3 py-2.5 text-sm hover:bg-accent/50">
            <StatusLight state={s.status === 'working' ? 'live' : s.status === 'waiting' ? 'waiting' : s.status === 'error' ? 'error' : 'idle'} />
            <span className="min-w-0 flex-1">
              <span className="block truncate">{s.title}</span>
              {isActive(s) && <span className="block text-xs text-muted-foreground">{STATUS_LABEL[s.status]}</span>}
            </span>
            {s.worktree && <span className="hidden shrink-0 items-center gap-1 font-mono text-xs text-muted-foreground sm:flex"><GitBranch className="size-3.5" />dd/{s.worktree.split('/').pop()}</span>}
            <span className="shrink-0 text-xs text-muted-foreground">{s.owner.name.split(' ')[0]}, {relativeTime(s.lastActivityAt)}</span>
          </Link>
        </li>
      ))}
    </ul>
  )
}

function ProjectSessions({ slug, onNew }: { slug: string; onNew: () => void }) {
  const sessions = projectSessions(useQuery(sessionsQuery(false)).data?.sessions, slug)
  return (
    <Section action={<Button size="sm" variant="outline" onClick={onNew}><Plus />New session</Button>}>
      {!sessions.length ? <p className="text-sm text-muted-foreground">No Claude sessions in this project yet.</p> : <SessionList sessions={sessions} />}
    </Section>
  )
}

/** The project at a glance: whose Claude is on it now, where the tasks stand, the latest commits and activity. */
function Overview({ slug, live, tasks, onTab, onNew }: {
  slug: string; live: { working: number; waiting: number; people: string[] }; tasks: Task[] | undefined
  onTab: (tab: string) => void; onNew: () => void
}) {
  const active = projectSessions(useQuery(sessionsQuery(false)).data?.sessions, slug).filter(isActive)
  // Private sessions of other people: counted by the server, never listed.
  const hidden = Math.max(0, live.working + live.waiting - active.length)
  const shown = new Set(active.map((s) => s.owner.name))
  const others = live.people.filter((n) => !shown.has(n)).map((n) => n.split(' ')[0])
  const open = (tasks ?? []).filter((t) => t.status !== 'done')
  const moving = open.filter((t) => t.status === 'in_progress' || t.status === 'review')
  const commits = useQuery(commitsQuery(slug))
  const activity = useQuery(activityQuery(slug))
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card title="Claude right now" className="md:col-span-2" action={<Button size="sm" variant="outline" onClick={onNew}><Plus />New session</Button>}>
        {active.length > 0 && <SessionList sessions={active} />}
        {hidden > 0 && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <StatusLight state="live" />
            {hidden} private {hidden === 1 ? 'session' : 'sessions'} working here{others.length ? ` (${others.join(', ')})` : ''}
          </p>
        )}
        {!active.length && !hidden && <p className="text-sm text-muted-foreground">Nobody's Claude is working in this project right now.</p>}
        <button className="self-start text-xs text-muted-foreground hover:text-foreground hover:underline" onClick={() => onTab('sessions')}>All sessions</button>
      </Card>

      <Card title="Tasks" action={<Button size="sm" variant="ghost" onClick={() => onTab('tasks')}>Board</Button>}>
        {!tasks ? <Skeleton className="h-24" /> : <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 md:grid-cols-2 xl:grid-cols-4">
            {STATUSES.filter((st) => st.value !== 'done').map((st) => (
              <button key={st.value} onClick={() => onTab('tasks')} className="flex min-w-0 flex-col items-start gap-1 rounded-lg border px-2.5 py-2 text-left hover:bg-accent/50">
                <span className="text-lg font-semibold tabular-nums">{open.filter((t) => t.status === st.value).length}</span>
                <span className="flex w-full min-w-0 items-center gap-1 text-xs text-muted-foreground"><StatusIcon status={st.value} className="size-3.5" /><span className="truncate">{st.label}</span></span>
              </button>
            ))}
          </div>
          {moving.length > 0
            ? <div className="overflow-hidden rounded-xl border">{moving.slice(0, 6).map((t) => <TaskRow key={t.id} t={t} showProject={false} />)}</div>
            : <p className="text-sm text-muted-foreground">Nothing in progress or in review.</p>}
        </>}
      </Card>

      <Card title="Latest commits" action={<Button size="sm" variant="ghost" onClick={() => onTab('commits')}>All</Button>}>
        {commits.isPending ? <Skeleton className="h-24" /> : commits.error ? <ErrorAlert error={commits.error} />
          : !commits.data.commits.length ? <p className="text-sm text-muted-foreground">No commits yet.</p>
          : <CommitList commits={commits.data.commits.slice(0, 5)} />}
      </Card>

      <Card title="Activity" className="md:col-span-2" action={<Button size="sm" variant="ghost" onClick={() => onTab('activity')}>All</Button>}>
        {activity.data ? <ActivityList items={activity.data.activity.slice(0, 6)} /> : <Skeleton className="h-24" />}
      </Card>
    </div>
  )
}

function Card({ title, action, className, children }: { title: string; action?: ReactNode; className?: string; children: ReactNode }) {
  return (
    <section className={cn('flex min-w-0 flex-col gap-3 rounded-xl border p-4', className)}>
      <div className="flex min-h-8 items-center justify-between gap-2"><h2 className="text-sm font-semibold">{title}</h2>{action}</div>
      {children}
    </section>
  )
}

function Commits({ slug }: { slug: string }) {
  const q = useQuery(commitsQuery(slug))
  if (q.isPending) return <Skeleton className="h-40" />
  if (q.error) return <ErrorAlert error={q.error} />
  if (!q.data.commits.length) return <p className="text-sm text-muted-foreground">No commits yet.</p>
  return <CommitList commits={q.data.commits} />
}

function CommitList({ commits }: { commits: { sha: string; subject: string; author: string; at: number }[] }) {
  return (
    <ul className="overflow-hidden rounded-xl border">
      {commits.map((c) => (
        <li key={c.sha} className="flex items-start gap-3 border-b px-3 py-2.5 text-sm last:border-b-0">
          <GitCommitHorizontal className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1">
            <span className="line-clamp-2">{c.subject}</span>
            <span className="text-xs text-muted-foreground">{c.author}, {relativeTime(c.at)}</span>
          </span>
          <span className="shrink-0 font-mono text-xs text-muted-foreground">{c.sha.slice(0, 7)}</span>
        </li>
      ))}
    </ul>
  )
}

function ProjectActivity({ slug }: { slug: string }) {
  const q = useQuery(activityQuery(slug))
  return q.data ? <ActivityList items={q.data.activity} /> : <Skeleton className="h-32" />
}
