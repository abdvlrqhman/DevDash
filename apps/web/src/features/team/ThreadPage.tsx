import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useParams } from '@tanstack/react-router'
import { CheckCheck, RotateCcw, SendHorizontal, SquareTerminal } from 'lucide-react'
import { toast } from 'sonner'
import { initials, StatusLight } from '@/components/app/brand'
import { PageBody, PageHeader } from '@/components/app/page'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { api, unwrap } from '@/lib/api'
import { cn } from '@/lib/utils'
import { ErrorAlert } from '../auth/LoginPage'
import { relativeTime } from '../claude/data'
import { Prose } from '../claude/Prose'
import { ProposalCard } from './Approvals'
import { MESSAGE_KINDS, threadQuery, useLiveTeam, type ThreadDetail } from './data'
import { RoleMark } from './TeamTab'

export function ThreadPage() {
  const { slug, thread } = useParams({ from: '/app/projects/$slug/team/threads/$thread' })
  return <ThreadView key={thread} slug={slug} id={Number(thread)} />
}

function ThreadView({ slug, id }: { slug: string; id: number }) {
  useLiveTeam()
  const qc = useQueryClient()
  const q = useQuery(threadQuery(id))
  const [body, setBody] = useState('')
  const refresh = () => void qc.invalidateQueries({ queryKey: ['team'] })
  const reply = useMutation({
    mutationFn: () => unwrap(api.api.team.threads[':id'].messages.$post({ param: { id: String(id) }, json: { kind: 'reply', body } })),
    onSuccess: () => { setBody(''); refresh() },
    onError: (e) => toast.error(e.message),
  })
  const resolve = useMutation({
    mutationFn: () => unwrap(api.api.team.threads[':id'].resolve.$post({ param: { id: String(id) }, json: { resolution: '' } })),
    onSuccess: refresh,
  })
  const reopen = useMutation({ mutationFn: () => unwrap(api.api.team.threads[':id'].reopen.$post({ param: { id: String(id) } })), onSuccess: refresh })

  if (q.error) return <><PageHeader title="Thread" back={`/projects/${slug}`} /><PageBody><ErrorAlert error={q.error} /></PageBody></>
  if (!q.data) return <><PageHeader title="Thread" back={`/projects/${slug}`} /><PageBody><Skeleton className="h-64" /></PageBody></>
  const { thread: t, messages, proposals } = q.data
  const open = t.status === 'open'

  return (
    <>
      <PageHeader back={`/projects/${slug}`} title={t.title}
        description={<span className="flex items-center gap-1.5">
          <StatusLight state={!open ? 'idle' : t.needsPeople ? 'waiting' : 'live'} />
          {!open ? 'Resolved' : t.needsPeople ? 'Waiting for people' : 'Open'}
          <span className="truncate">· {t.owner ? `${t.owner.name} owns it` : 'Nobody owns it'}{t.roles.length > 1 ? ` · with ${t.roles.filter((r) => r.id !== t.owner?.id).map((r) => r.name).join(', ')}` : ''}</span>
        </span>}
        actions={open
          ? <Button size="sm" variant="outline" disabled={resolve.isPending} onClick={() => resolve.mutate()}><CheckCheck />Resolve</Button>
          : <Button size="sm" variant="outline" disabled={reopen.isPending} onClick={() => reopen.mutate()}><RotateCcw />Reopen</Button>} />
      <PageBody>
        <div className="flex max-w-3xl flex-col gap-5">
          {open && t.needsPeople && (
            <p className="rounded-xl border border-attention/40 bg-attention-soft px-4 py-3 text-sm text-attention-foreground dark:bg-attention/10 dark:text-attention">
              {t.owner ? 'The roles went back and forth without a decision. Reply to settle it; they carry on after you.' : 'No role owns this. Reply, or resolve it.'}
            </p>
          )}
          {/* Proposals sit where they were made, so the newest message is always the one above the reply box. */}
          <ol className="flex flex-col gap-5">
            {[...messages.map((m) => ({ at: m.at, el: <Message key={`m${m.id}`} m={m} /> })),
              ...proposals.map((x) => ({ at: x.createdAt, el: <li key={`p${x.id}`} className="sm:pl-11"><ProposalCard x={x} showProject={false} /></li> }))]
              .sort((a, b) => a.at - b.at).map((i) => i.el)}
          </ol>
          <form className="flex items-end gap-2" onSubmit={(e) => { e.preventDefault(); if (body.trim()) reply.mutate() }}>
            <Textarea rows={2} value={body} maxLength={8000} onChange={(e) => setBody(e.target.value)} aria-label="Reply"
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !matchMedia('(pointer: coarse)').matches) { e.preventDefault(); if (body.trim()) reply.mutate() } }}
              placeholder={t.owner ? `Reply to everyone here. ${t.owner.name} picks it up right away.` : 'Reply to everyone here.'}
              className="max-h-48 min-h-11 flex-1 resize-none [field-sizing:content]" />
            <Button type="submit" size="icon" className="size-11 shrink-0" aria-label="Send" disabled={!body.trim() || reply.isPending}><SendHorizontal /></Button>
          </form>
          {t.resolution && <p className="text-sm text-muted-foreground">Outcome: {t.resolution}</p>}
          <p className="text-xs text-muted-foreground">Opened by {t.openedBy}, {relativeTime(t.createdAt)}. <Link to="/projects/$slug" params={{ slug }} className="hover:underline">Back to the team</Link></p>
        </div>
      </PageBody>
    </>
  )
}

function Message({ m }: { m: ThreadDetail['messages'][number] }) {
  const kind = MESSAGE_KINDS[m.kind]
  return (
    <li className="flex gap-3">
      {m.role ? <RoleMark id={m.role.id} name={m.author} className="size-8 rounded-lg text-[10px]" />
        : m.sessionId ? <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground"><SquareTerminal className="size-4" /></div>
        : <Avatar className="size-8"><AvatarFallback className="text-[11px]">{initials(m.author)}</AvatarFallback></Avatar>}
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm">
          {m.sessionId ? <Link to="/claude/$id" params={{ id: m.sessionId }} className="font-medium hover:underline">{m.author}</Link> : <span className="font-medium">{m.author}</span>}
          {kind?.label && <span className={cn('rounded-full px-2 py-0.5 text-[11px] font-medium', kind.tone)}>{kind.label}</span>}
          <span className="text-xs text-muted-foreground">{relativeTime(m.at)}</span>
        </div>
        <Prose text={m.body} />
        {m.evidence && (
          <details className="rounded-lg border bg-muted/30 text-sm">
            <summary className="cursor-pointer px-3 py-1.5 text-muted-foreground">Evidence</summary>
            <div className="px-3 pb-2"><Prose text={m.evidence} /></div>
          </details>
        )}
      </div>
    </li>
  )
}
