import { useState, type FormEvent, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { IconCheck, IconLock, IconLogout, IconMail } from '@tabler/icons-react'
import { PageHeader } from '../../app/AppShell'
import { api, meQuery, unwrap } from '../../lib/api'
import { getTheme, setTheme, type ThemePref } from '../../lib/theme'
import { Button, Chip, ErrorText, Field, cx } from '../../ui'

export function AccountPage() {
  const me = useQuery(meQuery).data!
  const qc = useQueryClient()
  const navigate = useNavigate()
  const signOut = async () => {
    await api.api.auth.logout.$post()
    qc.clear()
    navigate({ to: '/login' })
  }

  return (
    <>
      <PageHeader title="Account" />
      <div className="px-4 lg:px-8 pb-8 flex flex-col gap-7 max-w-xl">
        <Section title="Profile">
          <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 m-0 text-[14px]">
            <dt className="text-muted">Name</dt><dd className="m-0">{me.name}</dd>
            <dt className="text-muted">Username</dt><dd className="m-0 font-mono">{me.username}</dd>
            <dt className="text-muted">Email</dt><dd className="m-0 break-all">{me.email}</dd>
            <dt className="text-muted">Role</dt><dd className="m-0">{me.role === 'admin' ? <Chip tone="accent">Admin</Chip> : 'Member'}</dd>
          </dl>
          <p className="text-muted text-[12px] mt-2 mb-0">You can sign in with your email or your username.</p>
        </Section>
        <Section title="Password"><PasswordForm /></Section>
        <Section title="Email"><EmailForm /></Section>
        <Section title="Appearance"><ThemePicker /></Section>
        <div><Button onClick={signOut} className="text-danger"><IconLogout size={18} />Sign out</Button></div>
      </div>
    </>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="font-head font-medium text-[20px] m-0">{title}</h2>
      {children}
    </section>
  )
}

function Saved({ children }: { children: ReactNode }) {
  return <p role="status" className="flex items-center gap-1.5 text-[13px] text-success m-0"><IconCheck size={16} />{children}</p>
}

function PasswordForm() {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const change = useMutation({
    mutationFn: () => unwrap(api.api.auth.password.$post({ json: { current, next } })),
    onSuccess: () => { setCurrent(''); setNext('') },
  })
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (current && next) change.mutate()
  }
  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <input type="hidden" autoComplete="username" />
      <Field label="Current password" icon={<IconLock size={18} />} type="password" autoComplete="current-password" required
        value={current} onChange={(e) => { setCurrent(e.target.value); change.reset() }} />
      <Field label="New password" icon={<IconLock size={18} />} type="password" autoComplete="new-password" required
        value={next} onChange={(e) => { setNext(e.target.value); change.reset() }} />
      <ErrorText error={change.error} />
      {change.isSuccess && (
        <Saved>
          Password changed.{change.data.signedOutSessions ? ` Signed out ${change.data.signedOutSessions} other ${change.data.signedOutSessions === 1 ? 'device' : 'devices'}.` : ''}
        </Saved>
      )}
      <div><Button type="submit" variant="primary" disabled={!current || !next || change.isPending}>Change password</Button></div>
    </form>
  )
}

function EmailForm() {
  const qc = useQueryClient()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const change = useMutation({
    mutationFn: () => unwrap(api.api.auth.email.$post({ json: { email, password } })),
    onSuccess: (r) => {
      qc.setQueryData(meQuery.queryKey, r.user)
      setEmail('')
      setPassword('')
    },
  })
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (email && password) change.mutate()
  }
  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <Field label="New email" icon={<IconMail size={18} />} type="email" autoComplete="email" required
        value={email} onChange={(e) => { setEmail(e.target.value); change.reset() }} />
      <Field label="Current password" icon={<IconLock size={18} />} type="password" autoComplete="current-password" required
        value={password} onChange={(e) => { setPassword(e.target.value); change.reset() }} />
      <ErrorText error={change.error} />
      {change.isSuccess && <Saved>Email changed.</Saved>}
      <div><Button type="submit" variant="primary" disabled={!email || !password || change.isPending}>Change email</Button></div>
    </form>
  )
}

const THEMES: { v: ThemePref; label: string }[] = [
  { v: 'system', label: 'Match device' },
  { v: 'light', label: 'Light' },
  { v: 'dark', label: 'Dark' },
]

function ThemePicker() {
  const [theme, set] = useState(getTheme)
  return (
    <div role="radiogroup" aria-label="Theme" className="flex bg-surface-2 rounded-xl p-1 self-start">
      {THEMES.map((t) => (
        <button key={t.v} role="radio" aria-checked={theme === t.v} onClick={() => { setTheme(t.v); set(t.v) }}
          className={cx('px-3.5 h-9 rounded-[10px] text-[14px]', theme === t.v ? 'bg-surface text-text shadow-sm' : 'text-muted')}>
          {t.label}
        </button>
      ))}
    </div>
  )
}
