import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { Check, X } from 'lucide-react'
import { toast } from 'sonner'
import { PageBody, PageHeader } from '@/components/app/page'
import { Button } from '@/components/ui/button'
import { SidebarMenuBadge } from '@/components/ui/sidebar'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { Textarea } from '@/components/ui/textarea'
import { api, unwrap } from '@/lib/api'
import { cn } from '@/lib/utils'
import { ErrorAlert } from '../auth/LoginPage'
import { relativeTime } from '../claude/data'
import { Prose } from '../claude/Prose'
import { approvalsCountQuery, approvalsQuery, KIND_LABELS, useLiveTeam, type Proposal } from './data'
import { RoleMark } from './TeamTab'

/** What a role wants to do that needs a person: approve, reject, or reply with what you think. */
export function ProposalCard({ x, showProject = true }: { x: Proposal; showProject?: boolean }) {
  const qc = useQueryClient()
  const [replying, setReplying] = useState(false)
  const [reply, setReply] = useState('')
  const decide = useMutation({
    mutationFn: (approve: boolean) => unwrap(api.api.team.proposals[':id'].decide.$post({ param: { id: String(x.id) }, json: { approve, reply } })),
    onSuccess: (r, approve) => {
      void qc.invalidateQueries({ queryKey: ['team'] })
      void qc.invalidateQueries({ queryKey: ['tasks'] })
      toast.success(approve ? 'Approved.' : `Rejected. ${x.role.name} will see why.`, { description: approve && r.proposal.outcome ? r.proposal.outcome.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') : undefined })
    },
    onError: (e) => toast.error(e.message),
  })
  const p = x.payload as { prompt?: string; tasks?: { title: string; priority?: string }[]; goal?: { title: string; measure?: string; due?: string }; details?: string }
  const pending = x.status === 'pending'
  return (
    <article className="flex flex-col gap-3 rounded-xl border p-4">
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-sm">
        <RoleMark id={x.role.id} name={x.role.name} className="size-7 rounded-md text-[10px]" />
        <span className="font-medium">{x.role.name}</span>
        <span className="text-muted-foreground">
          {showProject && <><Link to="/projects/$slug" params={{ slug: x.project.slug }} className="hover:underline">{x.project.name}</Link> · </>}
          {relativeTime(x.createdAt)}
        </span>
        <span className="ml-auto rounded-full bg-muted px-2.5 py-0.5 text-xs font-medium">{KIND_LABELS[x.kind] ?? x.kind}</span>
      </div>
      <h3 className="text-base font-semibold">{x.title}</h3>
      {x.why && <div className="text-sm"><Prose text={x.why} /></div>}
      {x.kind === 'code' && p.prompt && (
        <details className="rounded-lg border bg-muted/30 text-sm">
          <summary className="cursor-pointer px-3 py-2 text-muted-foreground">What Claude will be asked to do</summary>
          <div className="px-3 pb-3 whitespace-pre-wrap">{p.prompt}</div>
        </details>
      )}
      {x.kind === 'task' && p.tasks?.length ? (
        <ul className="flex flex-col gap-1 rounded-lg border bg-muted/30 px-3 py-2 text-sm">
          {p.tasks.map((t, i) => <li key={i}>{t.title}{t.priority && t.priority !== 'none' ? <span className="text-muted-foreground"> · {t.priority}</span> : null}</li>)}
        </ul>
      ) : null}
      {x.kind === 'goal' && p.goal && (
        <p className="rounded-lg border bg-muted/30 px-3 py-2 text-sm">
          {p.goal.title}{p.goal.measure ? <span className="text-muted-foreground"> · measured by {p.goal.measure}</span> : null}{p.goal.due ? <span className="text-muted-foreground"> · by {p.goal.due}</span> : null}
        </p>
      )}
      {x.kind === 'other' && p.details && <p className="rounded-lg border bg-muted/30 px-3 py-2 text-sm whitespace-pre-wrap">{p.details}</p>}

      {pending ? (
        <>
          {replying && (
            <Textarea rows={2} value={reply} maxLength={4000} onChange={(e) => setReply(e.target.value)} autoFocus aria-label={`Your reply to ${x.role.name}`}
              placeholder={`Tell ${x.role.name} what you think. It goes into its notebook either way.`} />
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" disabled={decide.isPending} onClick={() => decide.mutate(true)}>{decide.isPending && decide.variables ? <Spinner /> : <Check />}Approve</Button>
            <Button size="sm" variant="outline" disabled={decide.isPending} onClick={() => decide.mutate(false)}><X />Reject</Button>
            {!replying && <Button size="sm" variant="ghost" onClick={() => setReplying(true)}>Reply…</Button>}
            <span className="ml-auto text-xs text-muted-foreground">{x.kind === 'code' ? 'Approving starts Claude on its own branch, as you.' : x.kind === 'other' ? 'Approving makes it a task for you.' : ''}</span>
          </div>
        </>
      ) : (
        <div className={cn('text-sm', x.status === 'rejected' ? 'text-destructive' : x.status === 'expired' ? 'text-muted-foreground' : 'text-live')}>
          {x.status === 'done' ? (x.decidedBy ? `Approved by ${x.decidedBy}` : 'Done on its own') : x.status === 'rejected' ? `Rejected by ${x.decidedBy}` : 'Expired without an answer'}
          {x.decidedAt ? `, ${relativeTime(x.decidedAt)}` : ''}
          {x.reply && <span className="text-muted-foreground">: "{x.reply}"</span>}
          {x.outcome && <div className="mt-1 text-foreground"><Prose text={x.outcome} /></div>}
        </div>
      )}
    </article>
  )
}

/** Everything waiting for the team, across projects. */
export function ApprovalsPage() {
  useLiveTeam()
  const pending = useQuery(approvalsQuery('pending'))
  const decided = useQuery(approvalsQuery('decided'))
  return (
    <>
      <PageHeader title="Approvals" description="What your AI team wants to do that needs a person" />
      <PageBody>
        <ErrorAlert error={pending.error} />
        {!pending.data ? <Skeleton className="h-48" /> : pending.data.proposals.length ? (
          <div className="flex max-w-3xl flex-col gap-3">
            {pending.data.proposals.map((x) => <ProposalCard key={x.id} x={x} />)}
          </div>
        ) : (
          <p className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
            Nothing waiting. When a role wants a coding job, a new goal, or something only people can do, it shows up here and on your phone.
          </p>
        )}
        {!!decided.data?.proposals.length && (
          <section className="flex max-w-3xl flex-col gap-3">
            <h2 className="mt-4 text-sm font-semibold">Recently decided</h2>
            {decided.data.proposals.map((x) => <ProposalCard key={x.id} x={x} />)}
          </section>
        )}
      </PageBody>
    </>
  )
}

/** The count beside Approvals in the sidebar. */
export function ApprovalsBadge() {
  useLiveTeam()
  const n = useQuery(approvalsCountQuery).data?.pending ?? 0
  return n > 0 ? <SidebarMenuBadge className="bg-attention-soft text-attention-foreground">{n}</SidebarMenuBadge> : null
}
