import { useEffect, useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { IconArrowLeft, IconLogin2, IconPlus } from '@tabler/icons-react'
import { api, unwrap } from '../../lib/api'
import { Button, Chip, ErrorText, Field, Light, cx } from '../../ui'
import { FALLBACK_MODELS, PERMISSION_MODES, profilesQuery, type PermissionMode } from './data'

type Profile = { name: string; loggedIn: boolean; authMethod: string | null; email: string | null; plan: string | null }

export function SetupPage() {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const q = useQuery(profilesQuery)
  const profiles = (q.data?.profiles as Profile[] | undefined) ?? []
  const [name, setName] = useState('')
  const create = useMutation({
    mutationFn: () => unwrap(api.api.claude.profiles.$post({ json: { name } })),
    onSuccess: () => { setName(''); void qc.invalidateQueries({ queryKey: profilesQuery.queryKey }) },
  })
  const login = (p: string) => navigate({ to: '/terminal', search: { open: `login-${p}` } })

  return (
    <div className="pb-10">
      <header className="flex items-center gap-2 px-2 lg:px-6 pt-[max(8px,env(safe-area-inset-top))] pb-2">
        <Link to="/claude" aria-label="Back" className="size-10 flex items-center justify-center rounded-lg text-muted hover:text-text"><IconArrowLeft size={20} /></Link>
        <h1 className="font-head text-[26px] m-0">Claude setup</h1>
      </header>
      <div className="px-4 lg:px-8 flex flex-col gap-7 max-w-xl">
        <section className="flex flex-col gap-3">
          <h2 className="font-head text-[20px] m-0">Profiles</h2>
          <p className="m-0 text-muted text-[14px]">
            A profile is its own Claude configuration: settings, skills, agents, plugins, memory and login. Use several to keep
            setups apart. The same Claude account can sign in to any number of profiles.
          </p>
          <ErrorText error={q.error} />
          {q.isPending && <p className="text-muted m-0">Checking sign-in status…</p>}
          <ul className="m-0 p-0 list-none border-t border-line">
            {profiles.map((p) => (
              <li key={p.name} className="flex items-center gap-3 py-3 border-b border-line">
                <Light state={p.loggedIn ? 'live' : 'idle'} />
                <div className="flex-1 min-w-0">
                  <div className="font-medium">{p.name === 'default' ? 'Default' : p.name}</div>
                  <div className="text-[13px] text-muted truncate">
                    {p.loggedIn ? [p.email, p.plan, p.authMethod === 'apiKey' ? 'API key' : null].filter(Boolean).join(', ') || 'Signed in' : 'Not signed in'}
                  </div>
                </div>
                <Button size="sm" variant={p.loggedIn ? 'default' : 'primary'} onClick={() => login(p.name)}>
                  <IconLogin2 size={16} />{p.loggedIn ? 'Sign in again' : 'Sign in'}
                </Button>
              </li>
            ))}
          </ul>
          <form onSubmit={(e: FormEvent) => { e.preventDefault(); if (name) create.mutate() }} className="flex gap-2 items-end">
            <Field label="New profile" className="flex-1" placeholder="work" value={name}
              onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))} maxLength={21} />
            <Button type="submit" disabled={!name || create.isPending}><IconPlus size={16} />Add</Button>
          </form>
          <ErrorText error={create.error} />
          <p className="m-0 text-[13px] text-muted">
            Signing in opens a terminal running Claude's own sign-in. Open the link it prints, approve, then paste the code back.
            DevDash never sees your Claude credentials.
          </p>
        </section>
        {q.data && <Defaults profiles={profiles} initial={q.data.defaults} />}
      </div>
    </div>
  )
}

type DefaultsRow = { profile: string; model: string | null; effort: string | null; permission_mode: string; open_in: 'chat' | 'cli' }

function Defaults({ profiles, initial }: { profiles: Profile[]; initial: DefaultsRow }) {
  const qc = useQueryClient()
  const [d, setD] = useState(initial)
  useEffect(() => setD(initial), [initial])
  const save = useMutation({
    mutationFn: (next: DefaultsRow) => unwrap(api.api.claude.defaults.$put({ json: { ...next, effort: null, permission_mode: next.permission_mode as PermissionMode } })),
    onSuccess: () => void qc.invalidateQueries({ queryKey: profilesQuery.queryKey }),
  })
  const set = (patch: Partial<DefaultsRow>) => {
    const next = { ...d, ...patch }
    setD(next)
    save.mutate(next)
  }
  const Row = ({ label, value, options, onPick }: { label: string; value: string; options: { value: string; label: string }[]; onPick: (v: string) => void }) => (
    <div className="flex flex-col gap-1.5">
      <span className="text-[13px] text-muted">{label}</span>
      <div className="flex flex-wrap gap-1.5">
        {options.map((o) => (
          <button key={o.value || 'default'} onClick={() => onPick(o.value)} aria-pressed={value === o.value}
            className={cx('px-3 h-9 rounded-lg text-[14px]', value === o.value ? 'bg-accent text-on-accent' : 'bg-surface-2')}>{o.label}</button>
        ))}
      </div>
    </div>
  )
  return (
    <section className="flex flex-col gap-3.5">
      <h2 className="font-head text-[20px] m-0">Defaults for new sessions</h2>
      {profiles.length > 1 && <Row label="Profile" value={d.profile} onPick={(v) => set({ profile: v })} options={profiles.map((p) => ({ value: p.name, label: p.name }))} />}
      <Row label="Model" value={d.model ?? ''} onPick={(v) => set({ model: v || null })} options={FALLBACK_MODELS.map((m) => ({ value: m.value, label: m.displayName }))} />
      <Row label="Permissions" value={d.permission_mode} onPick={(v) => set({ permission_mode: v })} options={PERMISSION_MODES.map((p) => ({ value: p.value, label: p.label }))} />
      <Row label="Open sessions in" value={d.open_in} onPick={(v) => set({ open_in: v as 'chat' | 'cli' })} options={[{ value: 'chat', label: 'Chat' }, { value: 'cli', label: 'CLI' }]} />
      {save.isSuccess && <Chip tone="ok">Saved</Chip>}
      <ErrorText error={save.error} />
    </section>
  )
}
