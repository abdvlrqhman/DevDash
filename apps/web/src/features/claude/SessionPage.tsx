import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useParams } from '@tanstack/react-router'
import { IconAdjustmentsHorizontal, IconArrowLeft, IconDots, IconTerminal2 } from '@tabler/icons-react'
import { api, meQuery, unwrap } from '../../lib/api'
import { useTopic } from '../../lib/live'
import { Button, Chip, Dialog, ErrorText, Field, Light, Toggle, cx } from '../../ui'
import { TerminalView, type Status as TermStatus } from '../terminal/TerminalView'
import { Blocks, Prose } from './Blocks'
import { Composer, type Img } from './Composer'
import { EFFORTS, FALLBACK_MODELS, PERMISSION_MODES, commandsQuery, modeLabel, profilesQuery, sessionQuery, shortPath, STATUS_LABEL, type Effort, type PendingRequest, type PermissionMode, type Session } from './data'
import { Requests } from './Requests'
import { buildTranscript, mergeRaw, type Raw } from './transcript'

const light = (s: Session['status']) => (s === 'working' ? 'live' : s === 'waiting' ? 'waiting' : s === 'error' ? 'error' : 'idle')

export function SessionPage() {
  const { id } = useParams({ from: '/app/claude/$id' })
  const me = useQuery(meQuery).data!
  const qc = useQueryClient()
  const info = useQuery(sessionQuery(id))
  const history = useQuery({
    queryKey: ['claude', 'history', id],
    queryFn: () => unwrap(api.api.claude.sessions[':id'].messages.$get({ param: { id } })),
    staleTime: Infinity,
  })
  const [raw, setRaw] = useState<Raw[]>([])
  const [liveText, setLiveText] = useState('')
  const [pending, setPending] = useState<PendingRequest[]>([])
  const [sheet, setSheet] = useState<'model' | 'settings' | null>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const stick = useRef(true)

  const s = info.data?.session
  const setSession = (session: Session) => qc.setQueryData(sessionQuery(id).queryKey, (old) => (old ? { ...old, session } : old))

  useTopic(`session:${id}`, (e) => {
    if (e.type === 'session') setSession(e.session as Session)
    else if (e.type === 'permission') {
      const r = e.request as PendingRequest
      setPending((p) => [...p.filter((x) => x.requestId !== r.requestId), r])
    } else if (e.type === 'permission_done') setPending((p) => p.filter((x) => x.requestId !== e.requestId))
    else if (e.type === 'msg') {
      const m = e.msg as Raw & { event?: { type?: string; delta?: { type?: string; text?: string } } }
      if (m.type === 'stream_event') {
        if (m.parent_tool_use_id) return
        if (m.event?.type === 'message_start') setLiveText('')
        else if (m.event?.delta?.type === 'text_delta') setLiveText((t) => t + (m.event!.delta!.text ?? ''))
        return
      }
      if (m.type === 'assistant' && !m.parent_tool_use_id) setLiveText('')
      setRaw((r) => mergeRaw(r, [m]))
    }
  }, () => {
    void info.refetch()
    void history.refetch()
  })

  useEffect(() => { if (history.data) setRaw((live) => mergeRaw(history.data.messages as Raw[], live)) }, [history.data])
  useEffect(() => { if (info.data) setPending(info.data.pending as PendingRequest[]) }, [info.data])

  const blocks = useMemo(() => buildTranscript(raw), [raw])
  useEffect(() => {
    const el = scroller.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [blocks, liveText, pending])

  const send = async (text: string, images: Img[]) => {
    const { uuid } = await unwrap(api.api.claude.sessions[':id'].messages.$post({ param: { id }, json: { text, images } }))
    stick.current = true
    setRaw((r) => [...r, {
      type: 'user', uuid,
      message: { role: 'user', content: [...images.map((i) => ({ type: 'image', source: { type: 'base64', media_type: i.mediaType, data: i.data } })), ...(text ? [{ type: 'text', text }] : [])] },
    }])
  }
  const interrupt = useMutation({ mutationFn: () => unwrap(api.api.claude.sessions[':id'].interrupt.$post({ param: { id } })) })
  const switchMode = useMutation({
    mutationFn: (mode: 'chat' | 'cli') => unwrap(api.api.claude.sessions[':id'].mode.$post({
      param: { id }, json: { mode, cols: Math.max(40, Math.min(220, Math.floor(innerWidth / 8.2))), rows: Math.max(15, Math.min(80, Math.floor(innerHeight / 19))) },
    })),
    onSuccess: (r) => setSession(r.session),
  })
  const defaults = useQuery(profilesQuery).data?.defaults
  const afterPlanApproved = () =>
    unwrap(api.api.claude.sessions[':id'].$patch({ param: { id }, json: { permissionMode: defaults && defaults.permission_mode !== 'plan' ? defaults.permission_mode as PermissionMode : 'acceptEdits' } }))

  if (info.error) return <div className="p-6"><ErrorText error={info.error} /><Link to="/claude" className="text-accent">Back to sessions</Link></div>
  if (!s) return <p className="p-6 text-muted">Loading…</p>

  const isCli = s.mode === 'cli'
  const canSend = info.data!.canSend
  const working = s.status === 'working'

  return (
    <div className="h-full flex flex-col">
      <header className="flex items-center gap-2 px-2 lg:px-6 pt-[max(8px,env(safe-area-inset-top))] pb-2 border-b border-line">
        <Link to="/claude" aria-label="Back to sessions" className="size-10 flex items-center justify-center rounded-lg text-muted hover:text-text"><IconArrowLeft size={20} /></Link>
        <div className="flex-1 min-w-0">
          <h1 className="font-head text-[17px] leading-tight m-0 truncate">{s.title}</h1>
          <p className="m-0 text-[12.5px] text-muted flex items-center gap-1.5 min-w-0">
            <Light state={light(s.status)} />
            <span className="shrink-0">{STATUS_LABEL[s.status]}</span>
            <span className="truncate font-mono">{shortPath(s.cwd, s.owner.username)}</span>
          </p>
        </div>
        <div role="radiogroup" aria-label="View" className="flex bg-surface-2 rounded-[10px] p-0.5 shrink-0">
          {(['chat', 'cli'] as const).map((m) => (
            <button key={m} role="radio" aria-checked={s.mode === m} disabled={!canSend || switchMode.isPending}
              onClick={() => s.mode !== m && switchMode.mutate(m)}
              className={cx('px-3 h-8 rounded-lg text-[13px]', s.mode === m ? 'bg-surface text-text shadow-sm' : 'text-muted')}>
              {m === 'chat' ? 'Chat' : 'CLI'}
            </button>
          ))}
        </div>
        <button aria-label="Session settings" onClick={() => setSheet('settings')} className="size-10 flex items-center justify-center rounded-lg text-muted hover:text-text"><IconDots size={20} /></button>
      </header>

      <div className="flex items-center gap-1.5 px-3 lg:px-6 py-2 overflow-x-auto">
        <button onClick={() => setSheet('model')} disabled={!canSend} className="flex items-center gap-1.5 shrink-0">
          <Chip>{s.model ?? 'Default model'}</Chip>
          <Chip tone={s.permissionMode === 'bypassPermissions' ? 'warn' : s.permissionMode === 'plan' ? 'accent' : 'default'}>{modeLabel(s.permissionMode)}</Chip>
          {s.effort && <Chip>Effort {s.effort}</Chip>}
          {canSend && <IconAdjustmentsHorizontal size={16} className="text-muted" />}
        </button>
        {s.owner.id !== me.id && <Chip tone="accent">{s.owner.name}'s session</Chip>}
        {s.shared && s.owner.id === me.id && <Chip tone="accent">Shared</Chip>}
      </div>
      <ErrorText error={switchMode.error} />

      {isCli ? (
        <div className="flex-1 min-h-0 m-2 lg:mx-6 rounded-xl overflow-hidden bg-term-bg p-2.5 relative">
          <CliView id={id} onEnded={() => void info.refetch()} />
        </div>
      ) : (
        <>
          <div ref={scroller} onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80 }}
            className="flex-1 min-h-0 overflow-y-auto px-4 lg:px-6 py-3">
            <div className="max-w-3xl mx-auto flex flex-col gap-3.5">
              {history.isPending && s.started && <p className="text-muted text-center">Loading conversation…</p>}
              <ErrorText error={history.error} />
              {!s.started && !raw.length && <p className="text-muted text-center py-10">Say what Claude should work on.</p>}
              <Blocks blocks={blocks} senders={history.data?.senders} />
              {liveText && <Prose text={liveText} />}
              {working && !liveText && <p className="flex items-center gap-2 text-[13px] text-muted m-0"><Light state="live" />Claude is working…</p>}
              {s.status === 'error' && s.statusDetail && <ErrorText error={s.statusDetail} />}
              <Requests sessionId={id} requests={pending} canAnswer={canSend} afterPlanApproved={afterPlanApproved} />
            </div>
          </div>
          <div className="px-3 lg:px-6 pb-[max(10px,env(safe-area-inset-bottom))] pt-2">
            <div className="max-w-3xl mx-auto">
              <Composer profile={s.profile} working={working || s.status === 'waiting'} onSend={send} onStop={() => interrupt.mutate()}
                disabledReason={canSend ? undefined : `${s.owner.name} shared this session to watch. Only they can send messages.`} />
            </div>
          </div>
        </>
      )}

      <ModelSheet open={sheet === 'model'} onClose={() => setSheet(null)} session={s} onChange={setSession} />
      <SettingsSheet open={sheet === 'settings'} onClose={() => setSheet(null)} session={s} isOwner={info.data!.isOwner} onChange={setSession} />
    </div>
  )
}

function CliView({ id, onEnded }: { id: string; onEnded: () => void }) {
  const [status, setStatus] = useState<TermStatus>('connecting')
  useEffect(() => { if (status === 'ended') onEnded() }, [status, onEnded])
  return (
    <>
      <TerminalView path={`/api/claude/sessions/${id}/cli`} onStatus={setStatus} />
      {status === 'ended' && (
        <div className="absolute inset-0 bg-term-bg/90 flex flex-col items-center justify-center gap-2 text-term-fg text-center px-6">
          <IconTerminal2 size={22} />
          <p className="m-0">Claude CLI exited. The conversation continues in Chat.</p>
        </div>
      )}
    </>
  )
}

function ModelSheet({ open, onClose, session: s, onChange }: { open: boolean; onClose: () => void; session: Session; onChange: (s: Session) => void }) {
  const models = (useQuery({ ...commandsQuery(s.profile), enabled: open }).data?.models as { value: string; displayName: string; description?: string }[] | undefined)
  const list = models?.length ? models : FALLBACK_MODELS
  const update = useMutation({
    mutationFn: (json: { model?: string | null; effort?: Effort | null; permissionMode?: PermissionMode }) =>
      unwrap(api.api.claude.sessions[':id'].$patch({ param: { id: s.id }, json })),
    onSuccess: (r) => onChange(r.session),
  })
  return (
    <Dialog open={open} onClose={onClose} title="Model and mode">
      <div className="flex flex-col gap-4">
        <fieldset className="border-0 p-0 m-0 flex flex-col gap-1.5">
          <legend className="text-[13px] text-muted mb-1.5">Model</legend>
          {list.map((m) => (
            <label key={m.value || 'default'} className={cx('flex items-center gap-2.5 rounded-xl px-3 py-2 cursor-pointer', (s.model ?? '') === m.value ? 'bg-accent-soft' : 'bg-surface-2')}>
              <input type="radio" name="model" checked={(s.model ?? '') === m.value} onChange={() => update.mutate({ model: m.value || null })} className="accent-[var(--accent)]" />
              <span className="flex-1"><span className="block text-[14px] font-medium">{m.displayName}</span>{m.description && <span className="block text-[12px] text-muted">{m.description}</span>}</span>
            </label>
          ))}
        </fieldset>
        <fieldset className="border-0 p-0 m-0">
          <legend className="text-[13px] text-muted mb-1.5">Effort (applies from the next message)</legend>
          <div className="flex bg-surface-2 rounded-xl p-1">
            {[null, ...EFFORTS].map((e) => (
              <button key={e ?? 'auto'} onClick={() => update.mutate({ effort: e })}
                className={cx('flex-1 h-8 rounded-lg text-[13px]', s.effort === e ? 'bg-surface shadow-sm' : 'text-muted')}>{e ?? 'Auto'}</button>
            ))}
          </div>
        </fieldset>
        <fieldset className="border-0 p-0 m-0 flex flex-col gap-1.5">
          <legend className="text-[13px] text-muted mb-1.5">Permissions</legend>
          {PERMISSION_MODES.map((p) => (
            <label key={p.value} className={cx('flex items-center gap-2.5 rounded-xl px-3 py-2 cursor-pointer', s.permissionMode === p.value ? 'bg-accent-soft' : 'bg-surface-2')}>
              <input type="radio" name="perm" checked={s.permissionMode === p.value} onChange={() => update.mutate({ permissionMode: p.value })} className="accent-[var(--accent)]" />
              <span><span className="block text-[14px] font-medium">{p.label}</span><span className="block text-[12px] text-muted">{p.hint}</span></span>
            </label>
          ))}
        </fieldset>
        <ErrorText error={update.error} />
        <Button onClick={onClose}>Done</Button>
      </div>
    </Dialog>
  )
}

function SettingsSheet({ open, onClose, session: s, isOwner, onChange }: { open: boolean; onClose: () => void; session: Session; isOwner: boolean; onChange: (s: Session) => void }) {
  const navigate = useNavigate()
  const [title, setTitle] = useState(s.title)
  useEffect(() => setTitle(s.title), [s.title])
  const update = useMutation({
    mutationFn: (json: { title?: string; shared?: boolean; sharedCanSend?: boolean; archived?: boolean }) =>
      unwrap(api.api.claude.sessions[':id'].$patch({ param: { id: s.id }, json })),
    onSuccess: (r) => {
      onChange(r.session)
      if (r.session.archived) navigate({ to: '/claude' })
    },
  })
  return (
    <Dialog open={open} onClose={onClose} title="Session">
      {isOwner ? (
        <div className="flex flex-col gap-3">
          <form onSubmit={(e) => { e.preventDefault(); update.mutate({ title }) }} className="flex gap-2 items-end">
            <Field label="Title" className="flex-1" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} />
            <Button type="submit" disabled={title.trim() === s.title || !title.trim()}>Rename</Button>
          </form>
          <Toggle label="Share with the team" checked={s.shared} onChange={(v) => update.mutate({ shared: v })} />
          {s.shared && <Toggle label="Others can send messages" checked={s.sharedCanSend} onChange={(v) => update.mutate({ sharedCanSend: v })} />}
          <p className="text-[13px] text-muted m-0">
            {s.shared
              ? s.sharedCanSend ? 'Everyone can watch and type. Claude still runs as you, with your account and permissions.' : 'Everyone can watch. Only you can type.'
              : 'Only you can see this session.'}
          </p>
          <ErrorText error={update.error} />
          <div className="flex gap-2 justify-end">
            <Button className="text-danger" onClick={() => update.mutate({ archived: true })}>Archive</Button>
            <Button variant="primary" onClick={onClose}>Done</Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <p className="m-0">{s.owner.name} shared this session. Claude runs as {s.owner.name}.</p>
          <Button onClick={onClose}>Done</Button>
        </div>
      )}
    </Dialog>
  )
}
