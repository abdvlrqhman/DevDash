import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useParams } from '@tanstack/react-router'
import { Archive, Check, ChevronDown, Circle, Ellipsis, FileCode, Gauge, LoaderCircle, MessageSquare, Pencil, Share2, SquareTerminal } from 'lucide-react'
import { toast } from 'sonner'
import { StatusLight } from '@/components/app/brand'
import { PageHeader } from '@/components/app/page'
import { ResponsiveDialog } from '@/components/app/responsive-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem,
  DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { api, meQuery, unwrap } from '@/lib/api'
import { ErrorAlert } from '../auth/LoginPage'
import { KeyBar } from '../terminal/KeyBar'
import { TerminalView, type Mods, type Status as TermStatus, type TerminalHandle } from '../terminal/TerminalView'
import { Blocks, Prose } from './Blocks'
import { Composer, type Img } from './Composer'
import {
  EFFORTS, FALLBACK_MODELS, PERMISSION_MODES, commandsQuery, modeLabel, profilesQuery, sessionQuery, shortPath, STATUS_LABEL,
  type Effort, type PendingRequest, type PermissionMode, type Session,
} from './data'
import { createLiveText, type LiveTextStore } from './live-text'
import { Requests } from './Requests'
import { PlanUsage } from './Usage'
import { servicesQuery, stateOf } from '../services/data'
import { buildTranscript, mergeRaw, sessionFacts, type Raw } from './transcript'
import { useTopic } from '@/lib/live'

const light = (s: Session['status']) => (s === 'working' ? 'live' : s === 'waiting' ? 'waiting' : s === 'error' ? 'error' : 'idle')
const termSize = () => ({ cols: Math.max(40, Math.min(220, Math.floor(innerWidth / 8.2))), rows: Math.max(15, Math.min(80, Math.floor(innerHeight / 19))) })

/** One view per session: switching sessions mounts a fresh one, so no messages or requests carry over. */
export function SessionPage() {
  const { id } = useParams({ from: '/app/claude/$id' })
  return <SessionView key={id} id={id} />
}

function SessionView({ id }: { id: string }) {
  const me = useQuery(meQuery).data!
  const qc = useQueryClient()
  const info = useQuery(sessionQuery(id))
  // The transcript on disk is the truth: the CLI, other devices and other people add to it while this page isn't
  // looking. Re-read it whenever the page opens or comes back, and when the CLI hands back to Chat.
  const history = useQuery({
    queryKey: ['claude', 'history', id],
    queryFn: () => unwrap(api.api.claude.sessions[':id'].messages.$get({ param: { id } })),
    staleTime: 0,
    refetchOnMount: 'always',
  })
  const [raw, setRaw] = useState<Raw[]>([])
  const [liveText] = useState(createLiveText)
  const [pending, setPending] = useState<PendingRequest[]>([])
  const [settings, setSettings] = useState(false)
  const [usage, setUsage] = useState(false)
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
        if (m.event?.type === 'message_start') liveText.reset()
        else if (m.event?.delta?.type === 'text_delta') liveText.append(m.event!.delta!.text ?? '')
        return
      }
      if (m.type === 'assistant' && !m.parent_tool_use_id) liveText.reset()
      setRaw((r) => mergeRaw(r, [m]))
    }
  }, () => {
    void info.refetch()
    void history.refetch()
  })

  useEffect(() => { if (history.data) setRaw((live) => mergeRaw(history.data.messages as Raw[], live)) }, [history.data])
  const mode = info.data?.session.mode
  const lastMode = useRef(mode)
  useEffect(() => {
    if (lastMode.current === 'cli' && mode === 'chat') void history.refetch()
    lastMode.current = mode
  }, [mode, history])
  useEffect(() => { if (info.data) setPending(info.data.pending as PendingRequest[]) }, [info.data])
  const blocks = useMemo(() => buildTranscript(raw), [raw])
  const toBottom = () => {
    const el = scroller.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }
  useEffect(toBottom, [blocks, pending])

  const send = async (text: string, images: Img[]) => {
    const { uuid } = await unwrap(api.api.claude.sessions[':id'].messages.$post({ param: { id }, json: { text, images } }))
    stick.current = true
    // The server also broadcasts it (for other devices) and may get here first: merge by uuid, never append twice.
    setRaw((r) => mergeRaw(r, [{
      type: 'user', uuid,
      message: { role: 'user', content: [...images.map((i) => ({ type: 'image', source: { type: 'base64', media_type: i.mediaType, data: i.data } })), ...(text ? [{ type: 'text', text }] : [])] },
    }]))
  }
  const interrupt = useMutation({ mutationFn: () => unwrap(api.api.claude.sessions[':id'].interrupt.$post({ param: { id } })) })
  const switchMode = useMutation({
    mutationFn: (mode: 'chat' | 'cli') => unwrap(api.api.claude.sessions[':id'].mode.$post({ param: { id }, json: { mode, ...termSize() } })),
    onSuccess: (r) => setSession(r.session),
    onError: (e) => toast.error(e.message),
  })
  const update = useMutation({
    mutationFn: (json: { model?: string | null; effort?: Effort | null; permissionMode?: PermissionMode; shared?: boolean; sharedCanSend?: boolean; archived?: boolean; title?: string }) =>
      unwrap(api.api.claude.sessions[':id'].$patch({ param: { id }, json })),
    onSuccess: (r) => setSession(r.session),
    onError: (e) => toast.error(e.message),
  })
  const defaults = useQuery(profilesQuery).data?.defaults
  const afterPlanApproved = () => unwrap(api.api.claude.sessions[':id'].$patch({
    param: { id }, json: { permissionMode: defaults && defaults.permission_mode !== 'plan' ? defaults.permission_mode as PermissionMode : 'acceptEdits' },
  }))

  if (info.error) {
    return (
      <>
        <PageHeader title="Session" back="/claude" />
        <div className="p-4"><ErrorAlert error={info.error} /></div>
      </>
    )
  }
  if (!s) return <><PageHeader title="Session" back="/claude" /><div className="flex flex-col gap-3 p-4">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-16" />)}</div></>

  const canSend = info.data!.canSend
  const isOwner = info.data!.isOwner
  const working = s.status === 'working'

  return (
    <div className="flex h-full flex-col">
      <PageHeader back="/claude" backOnSmall
        title={s.title}
        description={
          <span className="flex items-center gap-1.5">
            <StatusLight state={light(s.status)} />{STATUS_LABEL[s.status]}
            <span className="truncate font-mono">{shortPath(s.cwd, s.owner.username)}</span>
          </span>
        }
        actions={<>
          <Tabs value={s.mode} onValueChange={(v) => v !== s.mode && switchMode.mutate(v as 'chat' | 'cli')}>
            <TabsList>
              <TabsTrigger value="chat" disabled={!canSend || switchMode.isPending}><MessageSquare /><span className="hidden sm:inline">Chat</span></TabsTrigger>
              <TabsTrigger value="cli" disabled={!canSend || switchMode.isPending}><SquareTerminal /><span className="hidden sm:inline">CLI</span></TabsTrigger>
            </TabsList>
          </Tabs>
          <SessionMenu s={s} isOwner={isOwner} canSend={canSend} onUpdate={(v) => update.mutate(v)} onRename={() => setSettings(true)} onUsage={() => setUsage(true)} />
        </>} />

      <div className="flex items-center gap-1.5 overflow-x-auto border-b px-3 py-2 md:px-4">
        <ModelMenu s={s} disabled={!canSend} onUpdate={(v) => update.mutate(v)} />
        {s.owner.id !== me.id && <Badge variant="secondary">{s.owner.name}'s session</Badge>}
        {s.shared && s.owner.id === me.id && <Badge variant="secondary"><Share2 />Shared{s.sharedCanSend ? ', others can type' : ''}</Badge>}
      </div>

      {s.mode === 'cli' ? (
        <CliView id={id} onEnded={() => void info.refetch()} />
      ) : (
        <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <div ref={scroller} onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80 }}
            className="min-h-0 flex-1 overflow-y-auto px-4 py-4 md:px-6">
            <div className="mx-auto flex max-w-4xl flex-col gap-4">
              {history.isPending && s.started && [0, 1].map((i) => <Skeleton key={i} className="h-20" />)}
              <ErrorAlert error={history.error} />
              {!s.started && !raw.length && <p className="py-10 text-center text-muted-foreground">Tell Claude what to work on.</p>}
              <Blocks blocks={blocks} senders={history.data?.senders} />
              <LiveText store={liveText} working={working} onGrow={toBottom} />
              {s.status === 'error' && s.statusDetail && <ErrorAlert error={s.statusDetail} />}
              <Requests sessionId={id} requests={pending} canAnswer={canSend} afterPlanApproved={afterPlanApproved} />
            </div>
          </div>
          <div className="border-t bg-background px-2 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] md:px-6 md:pt-3 md:pb-3">
            <div className="mx-auto max-w-4xl">
              <Composer profile={s.profile} working={working || s.status === 'waiting'} onSend={send} onStop={() => interrupt.mutate()}
                disabledReason={canSend ? undefined : `${s.owner.name} shared this session to watch. Only they can send messages.`} />
            </div>
          </div>
        </div>
        <SessionAside s={s} blocks={blocks} isOwner={isOwner} />
        </div>
      )}
      {isOwner && <RenameDialog open={settings} onOpenChange={setSettings} s={s} onSave={(title) => update.mutate({ title })} />}
      {isOwner && (
        <ResponsiveDialog open={usage} onOpenChange={setUsage} title="Plan usage" description="Your Claude plan's limits, the same as /usage in Claude Code.">
          <PlanUsage profile={s.profile} className="pb-2 text-sm" />
        </ResponsiveDialog>
      )}
    </div>
  )
}

/** Only this re-renders while Claude types, at most once per frame (see live-text.ts). */
const LiveText = memo(function LiveText({ store, working, onGrow }: { store: LiveTextStore; working: boolean; onGrow: () => void }) {
  const text = useSyncExternalStore(store.subscribe, store.get)
  const grow = useRef(onGrow)
  grow.current = onGrow
  useLayoutEffect(() => grow.current(), [text])
  if (text) return <Prose text={text} />
  return working ? <p className="flex items-center gap-2 text-sm text-muted-foreground"><StatusLight state="live" />Claude is working…</p> : null
})

/** Wide screens: what Claude is doing at a glance, beside the conversation. */
function SessionAside({ s, blocks, isOwner }: { s: Session; blocks: ReturnType<typeof buildTranscript>; isOwner: boolean }) {
  const { todos, files } = useMemo(() => sessionFacts(blocks), [blocks])
  const services = useQuery(servicesQuery).data?.services.filter((x) => x.session?.id === s.id) ?? []
  const done = todos.filter((t) => t.status === 'completed').length
  return (
    <aside aria-label="Session details" className="hidden w-72 shrink-0 flex-col gap-6 overflow-y-auto border-l p-4 text-sm xl:flex">
      {services.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="font-medium">Services</h2>
          <ul className="flex flex-col gap-1">
            {services.map((x) => (
              <li key={x.name}>
                <Link to="/services/$name" params={{ name: x.name }} className="flex items-center gap-2 rounded-md py-0.5 hover:underline">
                  <StatusLight state={stateOf(x).light} /><span className="font-mono">{x.name}</span><span className="ml-auto font-mono text-xs text-muted-foreground">:{x.port}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
      {todos.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="flex items-baseline justify-between font-medium">To-dos <span className="text-xs font-normal text-muted-foreground">{done} of {todos.length}</span></h2>
          <ul className="flex flex-col gap-1.5">
            {todos.map((t, i) => (
              <li key={i} className={t.status === 'completed' ? 'flex gap-2 text-muted-foreground line-through' : 'flex gap-2'}>
                {t.status === 'completed' ? <Check className="mt-0.5 size-3.5 shrink-0 text-live" />
                  : t.status === 'in_progress' ? <LoaderCircle className="mt-0.5 size-3.5 shrink-0 animate-spin" />
                  : <Circle className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />}
                <span>{t.content}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      <section className="flex flex-col gap-2">
        <h2 className="font-medium">Changed files</h2>
        {files.length ? (
          <ul className="flex flex-col gap-1">
            {files.map((f) => (
              <li key={f.path} className="flex items-center gap-2" title={f.path}>
                <FileCode className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate font-mono text-xs">{f.path.split('/').pop()}</span>
                <span className="shrink-0 font-mono text-xs"><span className="text-live">+{f.added}</span> <span className="text-destructive">-{f.removed}</span></span>
              </li>
            ))}
          </ul>
        ) : <p className="text-muted-foreground">Nothing yet.</p>}
      </section>
      {isOwner && (
        <section className="flex flex-col gap-2">
          <h2 className="font-medium">Plan usage</h2>
          <PlanUsage profile={s.profile} />
        </section>
      )}
      <section className="flex flex-col gap-2">
        <h2 className="font-medium">Details</h2>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs">
          <dt className="text-muted-foreground">Folder</dt><dd className="truncate font-mono" title={s.cwd}>{shortPath(s.cwd, s.owner.username)}</dd>
          <dt className="text-muted-foreground">Profile</dt><dd>{s.profile}</dd>
          <dt className="text-muted-foreground">Model</dt><dd>{s.model ?? 'Default'}</dd>
          <dt className="text-muted-foreground">Permissions</dt><dd>{modeLabel(s.permissionMode)}</dd>
          <dt className="text-muted-foreground">Owner</dt><dd>{s.owner.name}</dd>
          <dt className="text-muted-foreground">Started</dt><dd>{new Date(s.createdAt * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</dd>
        </dl>
      </section>
    </aside>
  )
}

function CliView({ id, onEnded }: { id: string; onEnded: () => void }) {
  const [status, setStatus] = useState<TermStatus>('connecting')
  const [mods, setMods] = useState<Mods>({ ctrl: false, alt: false })
  const term = useRef<TerminalHandle>(null)
  useEffect(() => { if (status === 'ended') onEnded() }, [status, onEnded])
  return (
    <>
      <div className="relative m-2 min-h-0 flex-1 overflow-hidden rounded-lg bg-term-bg p-2 md:m-4">
        <TerminalView ref={term} path={`/api/claude/sessions/${id}/cli`} onStatus={setStatus} onMods={setMods} />
        {status === 'ended' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-term-bg/95 px-6 text-center text-term-fg">
            <SquareTerminal className="size-5" />
            <p>Claude CLI exited. The conversation continues in Chat.</p>
          </div>
        )}
      </div>
      <KeyBar term={term} mods={mods} />
    </>
  )
}

type Updater = (v: { model?: string | null; effort?: Effort | null; permissionMode?: PermissionMode; shared?: boolean; sharedCanSend?: boolean; archived?: boolean }) => void

/** Model, effort and permissions, changed in place from the chip row. */
function ModelMenu({ s, disabled, onUpdate }: { s: Session; disabled: boolean; onUpdate: Updater }) {
  const models = useQuery({ ...commandsQuery(s.profile), enabled: !disabled }).data?.models as { value: string; displayName: string }[] | undefined
  const list = models?.length ? models : FALLBACK_MODELS
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <Button variant="outline" size="sm" className="shrink-0">
          {list.find((m) => m.value === (s.model ?? ''))?.displayName ?? s.model ?? 'Default model'}
          <span className="text-muted-foreground">{modeLabel(s.permissionMode)}{s.effort ? `, ${s.effort}` : ''}</span>
          <ChevronDown />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel>Model</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={s.model ?? ''} onValueChange={(v) => onUpdate({ model: v || null })}>
          {list.map((m) => <DropdownMenuRadioItem key={m.value || 'default'} value={m.value}>{m.displayName}</DropdownMenuRadioItem>)}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>Permissions: {modeLabel(s.permissionMode)}</DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-72">
            <DropdownMenuRadioGroup value={s.permissionMode} onValueChange={(v) => onUpdate({ permissionMode: v as PermissionMode })}>
              {PERMISSION_MODES.map((p) => (
                <DropdownMenuRadioItem key={p.value} value={p.value} className="items-start">
                  <span className="flex flex-col"><span>{p.label}</span><span className="text-xs text-muted-foreground">{p.hint}</span></span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>Effort: {s.effort ?? 'auto'}</DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuRadioGroup value={s.effort ?? ''} onValueChange={(v) => onUpdate({ effort: (v || null) as Effort | null })}>
              <DropdownMenuRadioItem value="">Auto</DropdownMenuRadioItem>
              {EFFORTS.map((e) => <DropdownMenuRadioItem key={e} value={e} className="capitalize">{e}</DropdownMenuRadioItem>)}
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <p className="px-2 py-1.5 text-xs text-muted-foreground">{s.mode === 'cli' ? 'In the CLI it applies when the CLI next opens; use /effort to change it right away.' : 'Applies right away, even mid-answer.'}</p>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function SessionMenu({ s, isOwner, canSend, onUpdate, onRename, onUsage }: { s: Session; isOwner: boolean; canSend: boolean; onUpdate: Updater; onRename: () => void; onUsage: () => void }) {
  const navigate = useNavigate()
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Session options"><Ellipsis /></Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        {isOwner ? (
          <>
            <DropdownMenuItem onSelect={onRename}><Pencil />Rename</DropdownMenuItem>
            <DropdownMenuItem onSelect={onUsage}><Gauge />Plan usage</DropdownMenuItem>
            <DropdownMenuSeparator />
            <div className="flex items-center justify-between gap-3 px-2 py-1.5 text-sm">
              <span>Share with the team</span>
              <Switch checked={s.shared} onCheckedChange={(v) => onUpdate({ shared: v })} />
            </div>
            {s.shared && (
              <div className="flex items-center justify-between gap-3 px-2 py-1.5 text-sm">
                <span>Others can send messages</span>
                <Switch checked={s.sharedCanSend} onCheckedChange={(v) => onUpdate({ sharedCanSend: v })} />
              </div>
            )}
            <p className="px-2 pb-1.5 text-xs text-muted-foreground">
              {s.shared ? 'Claude still runs as you, with your account and permissions.' : 'Only you can see this session.'}
            </p>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={() => { onUpdate({ archived: true }); navigate({ to: '/claude' }) }}><Archive />Archive</DropdownMenuItem>
          </>
        ) : (
          <p className="px-2 py-1.5 text-sm text-muted-foreground">
            {s.owner.name} shared this session. Claude runs as {s.owner.name}{canSend ? '; you can send messages.' : '.'}
          </p>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild><Link to="/claude/setup">Claude setup</Link></DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function RenameDialog({ open, onOpenChange, s, onSave }: { open: boolean; onOpenChange: (v: boolean) => void; s: Session; onSave: (t: string) => void }) {
  const [title, setTitle] = useState(s.title)
  useEffect(() => setTitle(s.title), [s.title, open])
  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange} title="Rename session">
      <form onSubmit={(e) => { e.preventDefault(); onSave(title); onOpenChange(false) }}>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="title">Title</FieldLabel>
            <Input id="title" className="h-10" value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} autoFocus />
            <FieldDescription>Shown in the session list and on Home.</FieldDescription>
          </Field>
          <Button type="submit" className="h-10" disabled={!title.trim() || title.trim() === s.title}>Save title</Button>
        </FieldGroup>
      </form>
    </ResponsiveDialog>
  )
}
