import { useEffect, useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { Archive, ChevronRight, Plus, Settings2, Sparkles } from 'lucide-react'
import { initials, StatusLight } from '@/components/app/brand'
import { PageBody, PageHeader, Section } from '@/components/app/page'
import { ResponsiveDialog } from '@/components/app/responsive-dialog'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle } from '@/components/ui/item'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { Textarea } from '@/components/ui/textarea'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { api, meQuery, unwrap } from '@/lib/api'
import { ErrorAlert } from '../auth/LoginPage'
import { byFolder, FALLBACK_MODELS, PERMISSION_MODES, profilesQuery, relativeTime, sessionsQuery, shortPath, type PermissionMode, type Session } from './data'

export function SessionsPage() {
  const me = useQuery(meQuery).data!
  const [archived, setArchived] = useState(false)
  const list = useQuery(sessionsQuery(archived))
  const [creating, setCreating] = useState(false)

  const sessions = list.data?.sessions ?? []
  const waiting = sessions.filter((s) => s.status === 'waiting')
  const groups = byFolder(archived ? sessions : sessions.filter((s) => s.status !== 'waiting'))

  return (
    <>
      <PageHeader title={archived ? 'Archived sessions' : 'Claude'}
        actions={<>
          <Button variant="ghost" size="icon" asChild aria-label="Claude setup"><Link to="/claude/setup"><Settings2 /></Link></Button>
          <Button size="sm" onClick={() => setCreating(true)}><Plus />New</Button>
        </>} />
      <PageBody>
        <ErrorAlert error={list.error} />
        {list.isPending && <div className="flex flex-col gap-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-14 rounded-xl" />)}</div>}
        {!archived && waiting.length > 0 && (
          <Section title="Needs you">
            <ItemGroup className="gap-2">
              {waiting.map((s) => <SessionRow key={s.id} s={s} me={me.id} highlight />)}
            </ItemGroup>
          </Section>
        )}
        {groups.map((g) => (
          <SessionList key={g.cwd} title={<span className="font-mono">{shortPath(g.cwd, me.username)}</span>} sessions={g.sessions} me={me.id} />
        ))}
        {list.isSuccess && !sessions.length && (
          <Empty className="border">
            <EmptyHeader>
              <EmptyMedia variant="icon">{archived ? <Archive /> : <Sparkles />}</EmptyMedia>
              <EmptyTitle>{archived ? 'Nothing archived' : 'No sessions yet'}</EmptyTitle>
              <EmptyDescription>{archived ? 'Archived sessions show up here.' : 'Start a session and Claude works on the server as you, even after you close the app.'}</EmptyDescription>
            </EmptyHeader>
            {!archived && <EmptyContent><Button onClick={() => setCreating(true)}><Plus />New session</Button></EmptyContent>}
          </Empty>
        )}
        <div>
          <Button variant="link" size="sm" className="h-auto p-0 text-muted-foreground" onClick={() => setArchived(!archived)}>
            {archived ? 'Back to active sessions' : 'Show archived sessions'}
          </Button>
        </div>
      </PageBody>
      <NewSession open={creating} onClose={() => setCreating(false)} />
    </>
  )
}

const light = (s: Session) => (s.status === 'working' ? 'live' : s.status === 'waiting' ? 'waiting' : s.status === 'error' ? 'error' : 'idle')

function SessionRow({ s, me, highlight }: { s: Session; me: number; highlight?: boolean }) {
  return (
    <Item asChild className={highlight ? 'border-attention/40 bg-attention-soft' : 'rounded-none border-0 border-b last:border-b-0'}>
      <Link to="/claude/$id" params={{ id: s.id }}>
        <ItemMedia><StatusLight state={light(s)} /></ItemMedia>
        <ItemContent className="min-w-0">
          <ItemTitle className="line-clamp-1">{s.title}</ItemTitle>
          <ItemDescription className="line-clamp-1">
            {s.owner.id !== me && <span className="text-foreground">{s.owner.name.split(' ')[0]}, </span>}
            {s.status === 'working' ? 'Working' : s.status === 'waiting' ? 'Needs you' : relativeTime(s.lastActivityAt)}{highlight ? <>, <span className="font-mono">{shortPath(s.cwd, s.owner.username)}</span></> : null}
          </ItemDescription>
        </ItemContent>
        <ItemActions>
          {s.mode === 'cli' && <Badge variant="outline">CLI</Badge>}
          {s.owner.id === me && s.shared && <Badge variant="secondary">Shared</Badge>}
          {s.owner.id !== me && <Avatar className="size-7"><AvatarFallback className="text-[11px]">{initials(s.owner.name)}</AvatarFallback></Avatar>}
          <ChevronRight className="size-4 text-muted-foreground" />
        </ItemActions>
      </Link>
    </Item>
  )
}

function SessionList({ title, sessions, me }: { title?: React.ReactNode; sessions: Session[]; me: number }) {
  return (
    <Section title={title}>
      <ItemGroup className="rounded-xl border">{sessions.map((s) => <SessionRow key={s.id} s={s} me={me} />)}</ItemGroup>
    </Section>
  )
}

function Choice({ id, label, value, options, onChange, description }: {
  id: string; label: string; value: string; options: { value: string; label: string }[]; onChange: (v: string) => void; description?: string
}) {
  return (
    <Field>
      <FieldLabel id={id}>{label}</FieldLabel>
      <ToggleGroup type="single" variant="outline" aria-labelledby={id} value={value} onValueChange={(v) => v !== undefined && onChange(v)} className="w-full flex-wrap">
        {options.map((o) => <ToggleGroupItem key={o.value || 'default'} value={o.value} className="flex-1">{o.label}</ToggleGroupItem>)}
      </ToggleGroup>
      {description && <FieldDescription>{description}</FieldDescription>}
    </Field>
  )
}

export function NewSession({ open, onClose, initialPrompt = '', initialCwd }: { open: boolean; onClose: () => void; initialPrompt?: string; initialCwd?: string }) {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const setup = useQuery({ ...profilesQuery, enabled: open })
  const d = setup.data?.defaults
  const [prompt, setPrompt] = useState(initialPrompt)
  const [cwd, setCwd] = useState(initialCwd ?? '~')
  const [profile, setProfile] = useState('default')
  const [model, setModel] = useState('')
  const [perm, setPerm] = useState<PermissionMode>('bypassPermissions')
  const [openIn, setOpenIn] = useState<'chat' | 'cli'>('chat')
  useEffect(() => {
    if (!d) return
    setProfile(d.profile)
    setModel(d.model ?? '')
    setPerm(d.permission_mode as PermissionMode)
    setOpenIn(d.open_in)
  }, [d])
  useEffect(() => { if (open) { setPrompt(initialPrompt); if (initialCwd) setCwd(initialCwd) } }, [open, initialPrompt, initialCwd])

  const profiles = (setup.data?.profiles as { name: string; loggedIn: boolean }[] | undefined) ?? []
  const chosen = profiles.find((p) => p.name === profile)
  const create = useMutation({
    mutationFn: () => unwrap(api.api.claude.sessions.$post({
      json: {
        prompt, images: [], cwd, profile, model: model || null, effort: null, permissionMode: perm, mode: openIn,
        cols: Math.max(40, Math.min(220, Math.floor(innerWidth / 8.2))), rows: Math.max(15, Math.min(80, Math.floor(innerHeight / 19))),
      },
    })),
    onSuccess: ({ session }) => {
      void qc.invalidateQueries({ queryKey: ['claude', 'sessions'] })
      onClose()
      navigate({ to: '/claude/$id', params: { id: session.id } })
    },
  })
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!create.isPending && (openIn === 'cli' || prompt.trim())) create.mutate()
  }

  return (
    <ResponsiveDialog open={open} onOpenChange={(v) => !v && onClose()} title="New session" description="Claude works in this folder as you, and keeps going when you close the app.">
      <form onSubmit={submit}>
        <FieldGroup className="gap-5">
          {openIn === 'chat' && (
            <Field>
              <FieldLabel htmlFor="ns-prompt">What should Claude work on?</FieldLabel>
              <Textarea id="ns-prompt" value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={4} required autoFocus className="min-h-24 text-base md:text-sm" />
            </Field>
          )}
          <Field>
            <FieldLabel htmlFor="ns-cwd">Folder</FieldLabel>
            <Input id="ns-cwd" className="h-10 font-mono" value={cwd} onChange={(e) => setCwd(e.target.value)} spellCheck={false} autoCapitalize="none" />
            <FieldDescription>~ is your home folder on the server.</FieldDescription>
          </Field>
          {profiles.length > 1 && (
            <Choice id="ns-profile" label="Claude profile" value={profile} onChange={setProfile} options={profiles.map((p) => ({ value: p.name, label: p.name }))} />
          )}
          {chosen && !chosen.loggedIn && (
            <Alert variant="destructive">
              <AlertDescription>This profile isn't signed in to Claude. <Link to="/claude/setup" className="underline" onClick={onClose}>Sign in first</Link>.</AlertDescription>
            </Alert>
          )}
          <Choice id="ns-model" label="Model" value={model} onChange={setModel} options={FALLBACK_MODELS.map((m) => ({ value: m.value, label: m.displayName }))} />
          <Choice id="ns-perm" label="Permissions" value={perm} onChange={(v) => setPerm(v as PermissionMode)}
            options={PERMISSION_MODES.slice(0, 4).map((p) => ({ value: p.value, label: p.label }))}
            description={PERMISSION_MODES.find((p) => p.value === perm)?.hint} />
          <Choice id="ns-open" label="Open in" value={openIn} onChange={(v) => setOpenIn(v as 'chat' | 'cli')}
            options={[{ value: 'chat', label: 'Chat' }, { value: 'cli', label: 'CLI' }]}
            description={openIn === 'cli' ? 'The real Claude Code terminal. You can switch to Chat any time.' : 'A chat view of Claude Code. You can switch to the CLI any time.'} />
          <ErrorAlert error={create.error} />
          <Button type="submit" size="lg" className="h-10" disabled={create.isPending || (openIn === 'chat' && !prompt.trim())}>
            {create.isPending && <Spinner />}Start session
          </Button>
        </FieldGroup>
      </form>
    </ResponsiveDialog>
  )
}
