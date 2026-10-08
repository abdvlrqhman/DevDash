import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useParams } from '@tanstack/react-router'
import { Copy, GitBranch, GitCommitHorizontal, Plus, RefreshCw, Sparkles, StickyNote } from 'lucide-react'
import { toast } from 'sonner'
import { StatusLight } from '@/components/app/brand'
import { PageBody, PageHeader, Section } from '@/components/app/page'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ErrorAlert } from '../auth/LoginPage'
import { relativeTime, sessionsQuery } from '../claude/data'
import { NewSession } from '../claude/SessionsPage'
import { Board } from '../work/Board'
import { activityQuery, commitsQuery, notesQuery, projectQuery, tasksQuery, useLiveWork } from '../work/data'
import { ActivityList } from '../work/Activity'
import { NoteList } from '../notes/NotesPage'
import { repoLabel } from './ProjectsPage'
import { BuildsTab } from '../builds/BuildsTab'
import { api, unwrap } from '@/lib/api'

export function ProjectPage() {
  useLiveWork()
  const { slug } = useParams({ from: '/app/projects/$slug' })
  const qc = useQueryClient()
  const q = useQuery(projectQuery(slug))
  const tasks = useQuery(tasksQuery({ project: slug }))
  const [session, setSession] = useState(false)
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
      <PageBody className="max-w-none">
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

        <Tabs defaultValue="tasks" className="gap-4">
          <TabsList className="max-w-full justify-start overflow-x-auto [&>*]:flex-none">
            <TabsTrigger value="tasks">Tasks<span className="text-muted-foreground tabular-nums">{p.openTasks}</span></TabsTrigger>
            <TabsTrigger value="notes">Notes</TabsTrigger>
            <TabsTrigger value="sessions">Claude</TabsTrigger>
            <TabsTrigger value="builds">Builds</TabsTrigger>
            <TabsTrigger value="commits">Commits</TabsTrigger>
            <TabsTrigger value="activity">Activity</TabsTrigger>
          </TabsList>
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

function ProjectSessions({ slug, onNew }: { slug: string; onNew: () => void }) {
  const sessions = useQuery(sessionsQuery(false)).data?.sessions.filter((s) => s.project?.slug === slug) ?? []
  return (
    <Section action={<Button size="sm" variant="outline" onClick={onNew}><Plus />New session</Button>}>
      {!sessions.length ? <p className="text-sm text-muted-foreground">No Claude sessions in this project yet.</p> : (
        <ul className="overflow-hidden rounded-xl border">
          {sessions.map((s) => (
            <li key={s.id} className="border-b last:border-b-0">
              <Link to="/claude/$id" params={{ id: s.id }} className="flex items-center gap-3 px-3 py-2.5 text-sm hover:bg-accent/50">
                <StatusLight state={s.status === 'working' ? 'live' : s.status === 'waiting' ? 'waiting' : s.status === 'error' ? 'error' : 'idle'} />
                <span className="min-w-0 flex-1 truncate">{s.title}</span>
                {s.worktree && <span className="flex shrink-0 items-center gap-1 font-mono text-xs text-muted-foreground"><GitBranch className="size-3.5" />dd/{s.worktree.split('/').pop()}</span>}
                <span className="shrink-0 text-xs text-muted-foreground">{s.owner.name.split(' ')[0]}, {relativeTime(s.lastActivityAt)}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Section>
  )
}

function Commits({ slug }: { slug: string }) {
  const q = useQuery(commitsQuery(slug))
  if (q.isPending) return <Skeleton className="h-40" />
  if (q.error) return <ErrorAlert error={q.error} />
  if (!q.data.commits.length) return <p className="text-sm text-muted-foreground">No commits yet.</p>
  return (
    <ul className="overflow-hidden rounded-xl border">
      {q.data.commits.map((c) => (
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
