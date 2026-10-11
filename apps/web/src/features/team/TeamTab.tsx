import { useEffect, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { Plus, Trash2, Users } from 'lucide-react'
import { toast } from 'sonner'
import { StatusLight } from '@/components/app/brand'
import { Button } from '@/components/ui/button'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { api, unwrap } from '@/lib/api'
import { cn } from '@/lib/utils'
import { ErrorAlert } from '../auth/LoginPage'
import { relativeTime } from '../claude/data'
import { firstLine, roleMark, roleTone, teamQuery, useLiveTeam, type Role, type Team } from './data'
import { RoleDialog } from './RoleDialog'

/** A project's AI team: its roles, the brief and decisions they work from, and the journal of what happened. */
export function TeamTab({ slug }: { slug: string }) {
  useLiveTeam()
  const q = useQuery(teamQuery(slug))
  if (q.error) return <ErrorAlert error={q.error} />
  if (!q.data) return <Skeleton className="h-64" />
  return q.data.enabled ? <TeamView t={q.data} /> : <TurnOn slug={slug} name={q.data.project.name} />
}

function TurnOn({ slug, name }: { slug: string; name: string }) {
  const qc = useQueryClient()
  const on = useMutation({
    mutationFn: () => unwrap(api.api.team.projects[':slug'].$put({ param: { slug }, json: { enabled: true } })),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['team'] }),
    onError: (e) => toast.error(e.message),
  })
  return (
    <Empty className="border">
      <EmptyHeader>
        <EmptyMedia variant="icon"><Users /></EmptyMedia>
        <EmptyTitle>An AI team for {name}</EmptyTitle>
        <EmptyDescription>
          Roles like a CEO, CTO or Marketing that know this project, work on their own, keep notes and tell you what to do next.
          They run as you, on your Claude plan. They can read and suggest; they can't change code, publish or spend.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent><Button disabled={on.isPending} onClick={() => on.mutate()}>Turn on Team</Button></EmptyContent>
    </Empty>
  )
}

function TeamView({ t }: { t: Team }) {
  const slug = t.project.slug
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [adding, setAdding] = useState(false)
  const off = useMutation({
    mutationFn: () => unwrap(api.api.team.projects[':slug'].$put({ param: { slug }, json: { enabled: false } })),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['team'] }),
  })
  return (
    <div className="flex flex-col gap-6">
      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="flex min-w-0 flex-col gap-6">
          <Block title="Roles" action={t.roles.length > 0 && <Button size="sm" variant="outline" onClick={() => setAdding(true)}><Plus />New role</Button>}>
            {t.roles.length ? (
              <div className="grid grid-cols-[repeat(auto-fill,minmax(16rem,1fr))] gap-3">
                {t.roles.map((r) => <RoleCard key={r.id} slug={slug} r={r} />)}
              </div>
            ) : (
              <button onClick={() => setAdding(true)} className="flex flex-col items-center gap-1 rounded-xl border border-dashed p-8 text-center hover:bg-accent/40">
                <Plus className="size-5 text-muted-foreground" />
                <span className="font-medium">Add the first role</span>
                <span className="text-sm text-muted-foreground">Start with a CEO: it looks at the whole project and says what matters next.</span>
              </button>
            )}
          </Block>
          <Block title="Journal" description="What happened in the project. Claude sessions get a short summary after each stretch of work.">
            {t.journal.length ? (
              <ol className="flex flex-col divide-y rounded-xl border">
                {t.journal.map((j) => (
                  <li key={j.id} className="flex gap-3 px-3.5 py-2.5 text-sm">
                    <span className="w-16 shrink-0 text-xs text-muted-foreground tabular-nums">{relativeTime(j.at)}</span>
                    <span className="min-w-0">
                      {j.who && <span className="text-muted-foreground">{j.who}{j.kind === 'session' ? "'s Claude" : ''}: </span>}
                      {j.url ? <a href={j.url} className="hover:underline">{j.text}</a> : j.text}
                    </span>
                  </li>
                ))}
              </ol>
            ) : <p className="text-sm text-muted-foreground">Nothing yet. Work in this project's Claude sessions shows up here.</p>}
          </Block>
        </div>
        <div className="flex min-w-0 flex-col gap-6">
          <Brief slug={slug} brief={t.brief} />
          <Decisions slug={slug} decisions={t.decisions} />
        </div>
      </div>
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span>Roles run as {t.runsAs?.name}, on their Claude plan.</span>
        <button className="underline-offset-2 hover:underline" disabled={off.isPending}
          onClick={() => { if (confirm('Turn off Team for this project? Roles stop working; their notes and history stay.')) off.mutate() }}>
          Turn off Team
        </button>
      </p>
      <RoleDialog open={adding} onOpenChange={setAdding} slug={slug}
        onSaved={(id) => void navigate({ to: '/projects/$slug/team/$role', params: { slug, role: String(id) } })} />
    </div>
  )
}

function Block({ title, description, action, children }: { title: string; description?: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex min-h-8 items-end justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">{title}</h2>
          {description && <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  )
}

export function RoleMark({ id, name, className }: { id: number; name: string; className?: string }) {
  return <div aria-hidden className={cn('flex size-9 shrink-0 items-center justify-center rounded-lg text-xs font-semibold', roleTone(id), className)}>{roleMark(name)}</div>
}

function RoleCard({ slug, r }: { slug: string; r: Role }) {
  const last = r.lastShift
  return (
    <Link to="/projects/$slug/team/$role" params={{ slug, role: String(r.id) }}
      className={cn('flex flex-col gap-3 rounded-xl border p-4 transition-colors hover:bg-accent/40', r.working && 'border-live/40')}>
      <div className="flex items-center gap-3">
        <RoleMark id={r.id} name={r.name} />
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium">{r.name}</div>
          {r.summary && <div className="truncate text-xs text-muted-foreground">{r.summary}</div>}
        </div>
        {r.working
          ? <span className="flex shrink-0 items-center gap-1.5 text-xs text-live"><StatusLight state="live" />Working</span>
          : <span className="shrink-0 text-xs text-muted-foreground">Idle</span>}
      </div>
      <p className="line-clamp-2 text-sm text-muted-foreground">
        {r.shift ? `On a shift since ${relativeTime(r.shift.startedAt)}.`
          : last ? `${relativeTime(last.at)}: ${firstLine(last.report) || (last.status === 'error' ? 'Stopped with an error.' : 'Finished.')}`
          : 'No shifts yet. Open it to run one or chat.'}
      </p>
    </Link>
  )
}

function Brief({ slug, brief }: { slug: string; brief: Team['brief'] }) {
  const qc = useQueryClient()
  const [body, setBody] = useState(brief.body)
  const [editing, setEditing] = useState(!brief.body)
  useEffect(() => setBody(brief.body), [brief.body])
  const save = useMutation({
    mutationFn: () => unwrap(api.api.team.projects[':slug'].brief.$put({ param: { slug }, json: { body } })),
    onSuccess: () => { setEditing(false); void qc.invalidateQueries({ queryKey: ['team'] }) },
    onError: (e) => toast.error(e.message),
  })
  return (
    <Block title="Brief" description="What this is, who it's for, and where it stands. Every role reads it first."
      action={!editing && <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>Edit</Button>}>
      {editing ? (
        <form className="flex flex-col gap-2" onSubmit={(e) => { e.preventDefault(); save.mutate() }}>
          <Textarea rows={7} value={body} onChange={(e) => setBody(e.target.value)} aria-label="Brief"
            placeholder={'Seevil is an Android app for … \nFor: …\nStage: beta, aiming for v1 on the Play Store by …'} />
          <div className="flex gap-2">
            <Button size="sm" type="submit" disabled={save.isPending || body.trim() === brief.body}>Save brief</Button>
            {brief.body && <Button size="sm" type="button" variant="ghost" onClick={() => { setBody(brief.body); setEditing(false) }}>Cancel</Button>}
          </div>
        </form>
      ) : (
        <div className="rounded-xl border p-3.5 text-sm whitespace-pre-wrap">
          {brief.body}
          {brief.updatedBy && brief.updatedAt && <p className="mt-2 text-xs text-muted-foreground">{brief.updatedBy}, {relativeTime(brief.updatedAt)}</p>}
        </div>
      )}
    </Block>
  )
}

function Decisions({ slug, decisions }: { slug: string; decisions: Team['decisions'] }) {
  const qc = useQueryClient()
  const [body, setBody] = useState('')
  const refresh = () => void qc.invalidateQueries({ queryKey: ['team'] })
  const add = useMutation({
    mutationFn: () => unwrap(api.api.team.projects[':slug'].decisions.$post({ param: { slug }, json: { body } })),
    onSuccess: () => { setBody(''); refresh() },
    onError: (e) => toast.error(e.message),
  })
  const remove = useMutation({
    mutationFn: (id: number) => unwrap(api.api.team.projects[':slug'].decisions[':id'].$delete({ param: { slug, id: String(id) } })),
    onSuccess: refresh,
  })
  return (
    <Block title="Decisions" description="Settled, so nobody argues them again.">
      <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (body.trim()) add.mutate() }}>
        <Input className="h-9" value={body} maxLength={2000} onChange={(e) => setBody(e.target.value)} placeholder="No paid ads before v1" aria-label="New decision" />
        <Button size="sm" className="h-9" type="submit" disabled={!body.trim() || add.isPending}>Add</Button>
      </form>
      {decisions.length > 0 && (
        <ul className="flex flex-col divide-y rounded-xl border">
          {decisions.map((d) => (
            <li key={d.id} className="group flex items-start gap-2 px-3.5 py-2.5 text-sm">
              <div className="min-w-0 flex-1">
                <p>{d.body}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">{d.by ?? 'Someone'}, {relativeTime(d.at)}</p>
              </div>
              <Button size="icon" variant="ghost" className="size-7 shrink-0 opacity-60 hover:opacity-100" aria-label="Remove decision" onClick={() => remove.mutate(d.id)}><Trash2 /></Button>
            </li>
          ))}
        </ul>
      )}
    </Block>
  )
}
