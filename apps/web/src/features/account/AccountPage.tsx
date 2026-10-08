import { useState, type FormEvent, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Download, LogOut } from 'lucide-react'
import { toast } from 'sonner'
import { PageBody, PageHeader } from '@/components/app/page'
import { useSignOut } from '@/components/app/shell'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { api, meQuery, unwrap } from '@/lib/api'
import { APP_DOWNLOADS, inShell, openExternal } from '@/lib/shell'
import { setTheme, useTheme, type ThemePref } from '@/lib/theme'
import { CodeInput, ErrorAlert } from '../auth/LoginPage'
import { NotificationsPanel } from '../notifications/Notifications'

function Panel({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  )
}

export function AccountPage() {
  const me = useQuery(meQuery).data!
  const signOut = useSignOut()
  const theme = useTheme()

  return (
    <>
      <PageHeader title="Account" />
      <PageBody className="max-w-2xl">
        <Panel title="Profile" description="You can sign in with your email or your username.">
          <dl className="grid grid-cols-[auto_1fr] gap-x-8 gap-y-2 text-sm">
            <dt className="text-muted-foreground">Name</dt><dd>{me.name}</dd>
            <dt className="text-muted-foreground">Username</dt><dd className="font-mono">{me.username}</dd>
            <dt className="text-muted-foreground">Email</dt><dd className="break-all">{me.email}</dd>
            <dt className="text-muted-foreground">Role</dt><dd>{me.role === 'admin' ? <Badge variant="outline">Admin</Badge> : 'Member'}</dd>
          </dl>
        </Panel>
        <Panel title="Password" description="Changing it signs you out on your other devices."><PasswordForm /></Panel>
        <Panel title="Email"><EmailForm /></Panel>
        {me.role === 'admin' && (
          <Panel title="Server password" description={`The Linux password for ${me.username} on the server. sudo asks for it, for example in the admin shell.`}>
            <ServerPasswordForm />
          </Panel>
        )}
        <Panel title="Notifications" description="Choose what DevDash tells you about. These apply to all your devices.">
          <NotificationsPanel />
        </Panel>
        <Panel title="Appearance">
          <ToggleGroup type="single" variant="outline" value={theme} onValueChange={(v) => v && setTheme(v as ThemePref)}>
            <ToggleGroupItem value="system">Match device</ToggleGroupItem>
            <ToggleGroupItem value="light">Light</ToggleGroupItem>
            <ToggleGroupItem value="dark">Dark</ToggleGroupItem>
          </ToggleGroup>
        </Panel>
        {!inShell() && (
          <Panel title="Apps" description="Windows and Android installers, and an iPhone build for AltStore or SideStore. On iPhone you can also open this site in Safari and use Share, then Add to Home Screen.">
            <Button variant="outline" onClick={() => openExternal(APP_DOWNLOADS)}><Download />Download DevDash</Button>
          </Panel>
        )}
        <div><Button variant="destructive" onClick={() => void signOut()}><LogOut />Sign out</Button></div>
      </PageBody>
    </>
  )
}

function PasswordForm() {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const change = useMutation({
    mutationFn: () => unwrap(api.api.auth.password.$post({ json: { current, next } })),
    onSuccess: (r) => {
      setCurrent('')
      setNext('')
      toast.success(r.signedOutSessions ? `Password changed. Signed out ${r.signedOutSessions} other ${r.signedOutSessions === 1 ? 'device' : 'devices'}.` : 'Password changed.')
    },
  })
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (current && next) change.mutate()
  }
  return (
    <form onSubmit={submit}>
      <FieldGroup>
        <input type="hidden" autoComplete="username" />
        <Field>
          <FieldLabel htmlFor="pw-current">Current password</FieldLabel>
          <Input id="pw-current" type="password" autoComplete="current-password" required className="h-10" value={current} onChange={(e) => setCurrent(e.target.value)} />
        </Field>
        <Field>
          <FieldLabel htmlFor="pw-next">New password</FieldLabel>
          <Input id="pw-next" type="password" autoComplete="new-password" required className="h-10" value={next} onChange={(e) => setNext(e.target.value)} />
        </Field>
        <ErrorAlert error={change.error} />
        <div><Button type="submit" disabled={!current || !next || change.isPending}>Change password</Button></div>
      </FieldGroup>
    </form>
  )
}

function ServerPasswordForm() {
  const [password, setPassword] = useState('')
  const [current, setCurrent] = useState('')
  const [code, setCode] = useState('')
  const set = useMutation({
    mutationFn: () => unwrap(api.api.terminals.admin.password.$post({ json: { password, currentPassword: current, code } })),
    onSuccess: () => {
      setPassword('')
      setCurrent('')
      setCode('')
      toast.success('Server password set. Use it when sudo asks.')
    },
    onError: () => setCode(''),
  })
  const ready = password.length >= 8 && current && code.length === 6
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (ready) set.mutate()
  }
  return (
    <form onSubmit={submit}>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="sp-new">New server password</FieldLabel>
          <Input id="sp-new" type="password" autoComplete="new-password" minLength={8} required className="h-10" value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <Field>
          <FieldLabel htmlFor="sp-current">Your DevDash password</FieldLabel>
          <Input id="sp-current" type="password" autoComplete="current-password" required className="h-10" value={current} onChange={(e) => setCurrent(e.target.value)} />
        </Field>
        <Field>
          <FieldLabel htmlFor="sp-code">Code from your authenticator</FieldLabel>
          <CodeInput id="sp-code" value={code} onChange={setCode} />
        </Field>
        <ErrorAlert error={set.error} />
        <div><Button type="submit" disabled={!ready || set.isPending}>Set server password</Button></div>
      </FieldGroup>
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
      toast.success('Email changed.')
    },
  })
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (email && password) change.mutate()
  }
  return (
    <form onSubmit={submit}>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="em-new">New email</FieldLabel>
          <Input id="em-new" type="email" autoComplete="email" required className="h-10" value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field>
          <FieldLabel htmlFor="em-pw">Current password</FieldLabel>
          <Input id="em-pw" type="password" autoComplete="current-password" required className="h-10" value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <ErrorAlert error={change.error} />
        <div><Button type="submit" disabled={!email || !password || change.isPending}>Change email</Button></div>
      </FieldGroup>
    </form>
  )
}
