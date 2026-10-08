import { useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { IconLock, IconShieldLock, IconUser } from '@tabler/icons-react'
import { api, meQuery, spaceQuery, unwrap } from '../../lib/api'
import { Button, ErrorText, Field, Logo, OtpInput, Toggle } from '../../ui'

export function LoginPage() {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const space = useQuery(spaceQuery)
  const [login, setLogin] = useState('')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [useBackup, setUseBackup] = useState(false)
  const [remember, setRemember] = useState(true)

  const signIn = useMutation({
    mutationFn: () => unwrap(api.api.auth.login.$post({ json: { login, password, code, remember } })),
    onSuccess: ({ user }) => {
      qc.setQueryData(meQuery.queryKey, user)
      navigate({ to: '/' })
    },
    onError: () => setCode(''),
  })

  const ready = login.trim() && password && (useBackup ? code.length >= 16 : code.length === 6)
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (ready && !signIn.isPending) signIn.mutate()
  }

  return (
    <main className="min-h-full bg-bg flex justify-center px-6 pt-[max(40px,env(safe-area-inset-top))] pb-[max(24px,env(safe-area-inset-bottom))]">
      <form onSubmit={submit} className="w-full max-w-sm flex flex-col gap-3.5">
        <Logo size={52} />
        <div>
          <h1 className="font-head text-[28px] leading-tight m-0">Sign in to {space.data?.name ?? 'DevDash'}</h1>
          <p className="text-muted m-0 mt-1">{location.host}</p>
        </div>
        <Field label="Email or username" icon={<IconUser size={18} />} autoComplete="username" autoCapitalize="none" spellCheck={false} required value={login} onChange={(e) => setLogin(e.target.value)} />
        <Field label="Password" icon={<IconLock size={18} />} type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        {useBackup
          ? <Field label="Backup code (each works once)" autoComplete="off" spellCheck={false} className="font-mono" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} />
          : <OtpInput label="Code from your authenticator" value={code} onChange={setCode} />}
        <Toggle label="Remember this device for 30 days" checked={remember} onChange={setRemember} />
        <ErrorText error={signIn.error} />
        <Button type="submit" variant="primary" full className="h-12" disabled={!ready || signIn.isPending}>
          {signIn.isPending ? 'Signing in…' : 'Sign in'}
        </Button>
        <button type="button" className="text-muted text-[13px] underline-offset-2 hover:underline min-h-11" onClick={() => { setUseBackup(!useBackup); setCode('') }}>
          {useBackup ? 'Use my authenticator instead' : 'Use a backup code'}
        </button>
        <div className="flex-1" />
        <p className="flex items-center justify-center gap-1.5 text-muted text-[13px] m-0"><IconShieldLock size={15} />Invite only. Ask an admin for a link.</p>
      </form>
    </main>
  )
}
