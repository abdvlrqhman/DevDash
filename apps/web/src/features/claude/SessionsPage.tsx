import { useEffect, useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { IconFolder, IconPlus, IconSettings } from '@tabler/icons-react'
import { PageHeader } from '../../app/AppShell'
import { api, meQuery, unwrap } from '../../lib/api'
import { Avatar, Button, Dialog, ErrorText, Field, Light, cx } from '../../ui'
import { FALLBACK_MODELS, PERMISSION_MODES, modeLabel, profilesQuery, relativeTime, sessionsQuery, shortPath, useLiveSessions, type PermissionMode, type Session } from './data'

export function SessionsPage() {
  const me = useQuery(meQuery).data!
  const [archived, setArchived] = useState(false)
  const list = useQuery(sessionsQuery(archived))
  const [creating, setCreating] = useState(false)
  useLiveSessions()

  const sessions = list.data?.sessions ?? []
  const waiting = sessions.filter((s) => s.status === 'waiting')
  const running = sessions.filter((s) => s.status === 'working')
  const rest = sessions.filter((s) => s.status !== 'waiting' && s.status !== 'working')

  return (
    <>
      <PageHeader title="Claude">
        <Link to="/claude/setup" aria-label="Claude setup" className="size-10 flex items-center justify-center rounded-lg text-muted hover:text-text"><IconSettings size={20} /></Link>
        <Button size="sm" variant="primary" onClick={() => setCreating(true)}><IconPlus size={16} />New</Button>
      </PageHeader>
      <div className="px-4 lg:px-8 pb-8 flex flex-col gap-5 max-w-3xl">
        <ErrorText error={list.error} />
        {!archived && waiting.length > 0 && (
          <section className="flex flex-col gap-2">
            <h2 className="text-[13px] text-muted font-normal m-0">Needs you</h2>
            {waiting.map((s) => (
              <Link key={s.id} to="/claude/$id" params={{ id: s.id }} className="block rounded-2xl bg-warning-soft px-4 py-3">
                <div className="flex items-center gap-2.5"><Light state="waiting" /><span className="font-medium truncate flex-1">{s.title}</span></div>
                <Meta s={s} me={me.id} />
              </Link>
            ))}
          </section>
        )}
        {!archived && running.length > 0 && <Group title="Running" sessions={running} me={me.id} />}
        {rest.length > 0 && <Group title={archived ? 'Archived' : 'Idle'} sessions={rest} me={me.id} />}
        {list.isSuccess && !sessions.length && (
          <div className="text-center py-10 flex flex-col items-center gap-3">
            <p className="m-0 text-muted">{archived ? 'Nothing archived.' : 'No sessions yet. Start one and Claude works on the server, even after you close the app.'}</p>
            {!archived && <Button variant="primary" onClick={() => setCreating(true)}><IconPlus size={16} />Start a session</Button>}
          </div>
        )}
        <button className="text-[13px] text-muted self-start underline-offset-2 hover:underline" onClick={() => setArchived(!archived)}>
          {archived ? 'Back to active sessions' : 'Show archived'}
        </button>
      </div>
      <NewSession open={creating} onClose={() => setCreating(false)} />
    </>
  )
}

function Meta({ s, me }: { s: Session; me: number }) {
  return (
    <div className="text-[13px] text-muted truncate mt-0.5 flex items-center gap-1.5">
      {s.owner.id !== me && <span className="text-text">{s.owner.name.split(' ')[0]},</span>}
      <span className="font-mono truncate">{shortPath(s.cwd, s.owner.username)}</span>
      <span className="shrink-0">{s.mode === 'cli' ? 'in CLI,' : ''} {relativeTime(s.lastActivityAt)}</span>
    </div>
  )
}

function Group({ title, sessions, me }: { title: string; sessions: Session[]; me: number }) {
  return (
    <section className="flex flex-col">
      <h2 className="text-[13px] text-muted font-normal m-0 mb-1">{title}</h2>
      <ul className="m-0 p-0 list-none border-t border-line">
        {sessions.map((s) => (
          <li key={s.id} className="border-b border-line">
            <Link to="/claude/$id" params={{ id: s.id }} className="flex items-start gap-3 py-3">
              <span className="mt-[7px]"><Light state={s.status === 'working' ? 'live' : s.status === 'error' ? 'error' : 'idle'} /></span>
              <div className="flex-1 min-w-0">
                <div className="truncate">{s.title}</div>
                <Meta s={s} me={me} />
              </div>
              {s.owner.id !== me ? <Avatar name={s.owner.name} seed={s.owner.id} /> : s.shared && <span className="text-[12px] text-accent mt-0.5">Shared</span>}
            </Link>
          </li>
        ))}
      </ul>
    </section>
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
    <Dialog open={open} onClose={onClose} title="New session">
      <form onSubmit={submit} className="flex flex-col gap-3.5">
        <Field label="Folder" icon={<IconFolder size={18} />} value={cwd} onChange={(e) => setCwd(e.target.value)} spellCheck={false} autoCapitalize="none"
          hint="Claude works in this folder, as you. ~ is your home folder." />
        {profiles.length > 1 && (
          <Choice label="Claude profile" value={profile} onChange={setProfile} options={profiles.map((p) => ({ value: p.name, label: p.name }))} />
        )}
        {chosen && !chosen.loggedIn && (
          <p className="m-0 text-[13px] text-danger bg-danger-soft rounded-xl px-3 py-2">
            This profile isn't signed in to Claude. <Link to="/claude/setup" className="underline">Sign in first</Link>.
          </p>
        )}
        <Choice label="Model" value={model} onChange={setModel} options={FALLBACK_MODELS.map((m) => ({ value: m.value, label: m.displayName }))} />
        <Choice label="Permissions" value={perm} onChange={(v) => setPerm(v as PermissionMode)}
          options={PERMISSION_MODES.slice(0, 4).map((p) => ({ value: p.value, label: p.label }))} />
        <Choice label="Open in" value={openIn} onChange={(v) => setOpenIn(v as 'chat' | 'cli')} options={[{ value: 'chat', label: 'Chat' }, { value: 'cli', label: 'CLI' }]} />
        {openIn === 'chat' && (
          <label className="flex flex-col gap-1.5">
            <span className="text-[13px] text-muted">What should Claude work on?</span>
            <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={4} required
              className="rounded-xl bg-surface-2 px-3.5 py-3 outline-none focus:ring-2 focus:ring-accent resize-y text-[15px]" />
          </label>
        )}
        <p className="m-0 text-[12px] text-muted">{modeLabel(perm)}: {PERMISSION_MODES.find((p) => p.value === perm)?.hint}.</p>
        <ErrorText error={create.error} />
        <Button type="submit" variant="primary" disabled={create.isPending || (openIn === 'chat' && !prompt.trim())}>
          {create.isPending ? 'Starting…' : 'Start session'}
        </Button>
      </form>
    </Dialog>
  )
}

function Choice({ label, value, options, onChange }: { label: string; value: string; options: { value: string; label: string }[]; onChange: (v: string) => void }) {
  return (
    <fieldset className="border-0 p-0 m-0">
      <legend className="text-[13px] text-muted mb-1.5">{label}</legend>
      <div className="flex flex-wrap gap-1.5">
        {options.map((o) => (
          <label key={o.value || 'default'} className={cx('px-3 h-9 rounded-lg text-[14px] flex items-center cursor-pointer', value === o.value ? 'bg-accent text-on-accent' : 'bg-surface-2')}>
            <input type="radio" className="sr-only" checked={value === o.value} onChange={() => onChange(o.value)} />{o.label}
          </label>
        ))}
      </div>
    </fieldset>
  )
}
