import { useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { IconLock, IconMail, IconShieldLock } from '@tabler/icons-react'
import { api, meQuery, spaceQuery, unwrap } from '../../lib/api'
import { Button, Card, ErrorText, Field, Logo, OtpInput, Toggle } from '../../ui'

export function LoginPage() {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const space = useQuery(spaceQuery)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [useBackup, setUseBackup] = useState(false)
  const [remember, setRemember] = useState(true)

  const login = useMutation({
    mutationFn: () => unwrap(api.api.auth.login.$post({ json: { email, password, code, remember } })),
    onSuccess: ({ user }) => {
      qc.setQueryData(meQuery.queryKey, user)
      navigate({ to: '/' })
    },
    onError: () => setCode(''),
  })

  const ready = email && password && (useBackup ? code.length >= 16 : code.length === 6)
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (ready && !login.isPending) login.mutate()
  }

  return (
    <main className="min-h-full bg-bg flex justify-center px-6 pt-[max(40px,env(safe-area-inset-top))] pb-[max(24px,env(safe-area-inset-bottom))]">
      <form onSubmit={submit} className="w-full max-w-sm flex flex-col gap-3.5">
        <Logo />
        <div>
          <h1 className="font-head font-medium text-[30px] leading-tight m-0">Welcome back</h1>
          <p className="text-muted m-0">Sign in to {space.data?.name ?? 'your space'}</p>
        </div>
        <Field label="Email" icon={<IconMail size={18} />} type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
        <Field label="Password" icon={<IconLock size={18} />} type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        <Card>
          <p className="font-semibold m-0">Two-step check</p>
          <p className="text-muted text-[12px] mt-0 mb-2.5">
            {useBackup ? 'Enter one of your backup codes. Each works once.' : 'Enter the 6-digit code from your authenticator.'}
          </p>
          {useBackup
            ? <Field label="Backup code" autoComplete="off" spellCheck={false} className="font-mono" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} />
            : <OtpInput label="Authenticator code" value={code} onChange={setCode} />}
        </Card>
        <Toggle label="Remember me for 30 days" checked={remember} onChange={setRemember} />
        <ErrorText error={login.error} />
        <Button type="submit" variant="primary" full className="h-12" disabled={!ready || login.isPending}>
          {login.isPending ? 'Signing in…' : 'Sign in'}
        </Button>
        <button type="button" className="text-muted text-[13px] underline-offset-2 hover:underline min-h-11" onClick={() => { setUseBackup(!useBackup); setCode('') }}>
          {useBackup ? 'Use my authenticator instead' : 'Use a backup code instead'}
        </button>
        <div className="flex-1" />
        <p className="flex items-center justify-center gap-1 text-muted text-[11px] m-0"><IconShieldLock size={14} />Private space · invite only</p>
      </form>
    </main>
  )
}
