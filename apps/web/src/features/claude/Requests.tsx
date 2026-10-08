import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { IconHelpCircle, IconMap, IconShieldQuestion } from '@tabler/icons-react'
import { api, unwrap } from '../../lib/api'
import { Button, Card, ErrorText, Light, cx } from '../../ui'
import { Prose } from './Blocks'
import type { PendingRequest } from './data'

type Answer = { behavior: 'allow'; updatedInput?: Record<string, unknown>; updatedPermissions?: unknown[] } | { behavior: 'deny'; message: string }

function useAnswer(sessionId: string, requestId: string, after?: () => Promise<unknown>) {
  return useMutation({
    mutationFn: async (result: Answer) => {
      await unwrap(api.api.claude.sessions[':id'].answer.$post({ param: { id: sessionId }, json: { requestId, result } }))
      await after?.()
    },
  })
}

/** Everything Claude is waiting on, in the order it asked. Read-only for viewers who may not send. */
export function Requests({ sessionId, requests, canAnswer, afterPlanApproved }: {
  sessionId: string; requests: PendingRequest[]; canAnswer: boolean; afterPlanApproved: () => Promise<unknown>
}) {
  return (
    <div className="flex flex-col gap-3">
      {requests.map((r) =>
        r.toolName === 'AskUserQuestion' ? <QuestionCard key={r.requestId} sessionId={sessionId} req={r} disabled={!canAnswer} />
        : r.toolName === 'ExitPlanMode' ? <PlanCard key={r.requestId} sessionId={sessionId} req={r} disabled={!canAnswer} after={afterPlanApproved} />
        : <PermissionCard key={r.requestId} sessionId={sessionId} req={r} disabled={!canAnswer} />,
      )}
    </div>
  )
}

type Question = { question: string; header?: string; multiSelect?: boolean; options: { label: string; description?: string }[] }

function QuestionCard({ sessionId, req, disabled }: { sessionId: string; req: PendingRequest; disabled: boolean }) {
  const questions = (req.input.questions as Question[] | undefined) ?? []
  const [picked, setPicked] = useState<Record<string, string[]>>({})
  const [other, setOther] = useState<Record<string, string>>({})
  const answer = useAnswer(sessionId, req.requestId)
  const value = (q: Question) => (picked[q.question]?.includes('__other') ? other[q.question]?.trim() : picked[q.question]?.join(', ')) ?? ''
  const ready = questions.every((q) => value(q))
  const toggle = (q: Question, label: string) => setPicked((p) => {
    const cur = p[q.question] ?? []
    return { ...p, [q.question]: q.multiSelect ? (cur.includes(label) ? cur.filter((x) => x !== label) : [...cur.filter((x) => x !== '__other'), label]) : [label] }
  })

  return (
    <Card tone="accent">
      <div className="flex items-center gap-2 font-medium mb-2"><IconHelpCircle size={18} className="text-accent" />Claude has a question</div>
      <div className="flex flex-col gap-4">
        {questions.map((q) => (
          <fieldset key={q.question} className="border-0 p-0 m-0 flex flex-col gap-1.5" disabled={disabled}>
            <legend className="mb-2 text-[15px]">{q.question}</legend>
            {[...q.options, { label: '__other', description: undefined }].map((o) => {
              const on = picked[q.question]?.includes(o.label) ?? false
              return (
                <label key={o.label} className={cx('flex items-start gap-2.5 rounded-xl px-3 py-2.5 cursor-pointer', on ? 'bg-surface ring-2 ring-inset ring-accent' : 'bg-surface')}>
                  <input type={q.multiSelect ? 'checkbox' : 'radio'} name={q.question} checked={on} onChange={() => (o.label === '__other' ? setPicked((p) => ({ ...p, [q.question]: ['__other'] })) : toggle(q, o.label))}
                    className="mt-1 accent-[var(--accent)]" />
                  <span className="flex-1 min-w-0">
                    <span className="block font-medium text-[14px]">{o.label === '__other' ? 'Something else' : o.label}</span>
                    {o.description && <span className="block text-[13px] text-muted">{o.description}</span>}
                    {o.label === '__other' && on && (
                      <input autoFocus value={other[q.question] ?? ''} onChange={(e) => setOther((x) => ({ ...x, [q.question]: e.target.value }))}
                        placeholder="Type your answer" className="mt-1.5 w-full h-10 rounded-lg bg-surface-2 px-3 outline-none focus:ring-2 focus:ring-accent" />
                    )}
                  </span>
                </label>
              )
            })}
          </fieldset>
        ))}
      </div>
      <ErrorText error={answer.error} />
      {!disabled && (
        <Button variant="primary" full className="mt-3" disabled={!ready || answer.isPending}
          onClick={() => answer.mutate({ behavior: 'allow', updatedInput: { ...req.input, answers: Object.fromEntries(questions.map((q) => [q.question, value(q)])) } })}>
          Answer
        </Button>
      )}
    </Card>
  )
}

function PlanCard({ sessionId, req, disabled, after }: { sessionId: string; req: PendingRequest; disabled: boolean; after: () => Promise<unknown> }) {
  const [feedback, setFeedback] = useState('')
  const approve = useAnswer(sessionId, req.requestId, after)
  const keep = useAnswer(sessionId, req.requestId)
  return (
    <Card tone="brass">
      <div className="flex items-center gap-2 font-medium mb-2"><IconMap size={18} className="text-warning" />Plan ready for review</div>
      <div className="bg-surface rounded-xl px-3.5 py-3 max-h-[50vh] overflow-auto"><Prose text={String(req.input.plan ?? '')} /></div>
      <ErrorText error={approve.error ?? keep.error} />
      {!disabled && (
        <div className="flex flex-col gap-2 mt-3">
          <Button variant="primary" disabled={approve.isPending} onClick={() => approve.mutate({ behavior: 'allow', updatedInput: req.input })}>Approve and build</Button>
          <div className="flex gap-2">
            <input value={feedback} onChange={(e) => setFeedback(e.target.value)} placeholder="What should change? (optional)"
              className="flex-1 min-w-0 h-11 rounded-xl bg-surface px-3 outline-none focus:ring-2 focus:ring-accent" />
            <Button disabled={keep.isPending} onClick={() => keep.mutate({ behavior: 'deny', message: feedback.trim() ? `Keep planning. Feedback: ${feedback.trim()}` : 'Keep planning.' })}>Keep planning</Button>
          </div>
        </div>
      )}
    </Card>
  )
}

function describe(req: PendingRequest) {
  const i = req.input
  if (req.toolName === 'Bash') return String(i.command ?? '')
  if (typeof i.file_path === 'string') return i.file_path
  if (typeof i.url === 'string') return i.url
  return JSON.stringify(i, null, 2).slice(0, 600)
}

function PermissionCard({ sessionId, req, disabled }: { sessionId: string; req: PendingRequest; disabled: boolean }) {
  const answer = useAnswer(sessionId, req.requestId)
  return (
    <Card tone="brass">
      <div className="flex items-center gap-2 font-medium mb-2">
        <Light state="waiting" /><IconShieldQuestion size={18} className="text-warning" />Allow {req.toolName}?
      </div>
      <pre className="font-mono text-[12.5px] bg-surface rounded-lg px-3 py-2 m-0 whitespace-pre-wrap break-all max-h-60 overflow-auto">{describe(req)}</pre>
      <ErrorText error={answer.error} />
      {!disabled && (
        <div className="flex flex-wrap gap-2 mt-3">
          <Button size="sm" variant="primary" disabled={answer.isPending} onClick={() => answer.mutate({ behavior: 'allow', updatedInput: req.input })}>Allow</Button>
          {!!req.suggestions?.length && (
            <Button size="sm" disabled={answer.isPending} onClick={() => answer.mutate({ behavior: 'allow', updatedInput: req.input, updatedPermissions: req.suggestions })}>Always allow</Button>
          )}
          <Button size="sm" disabled={answer.isPending} className="text-danger" onClick={() => answer.mutate({ behavior: 'deny', message: 'The user denied this.' })}>Deny</Button>
        </div>
      )}
    </Card>
  )
}
