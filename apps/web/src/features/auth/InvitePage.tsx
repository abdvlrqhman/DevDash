import { useEffect, useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate, useParams } from '@tanstack/react-router'
import { IconCopy, IconDownload, IconExternalLink, IconLock, IconUser } from '@tabler/icons-react'
import QRCode from 'qrcode'
import { api, meQuery, unwrap } from '../../lib/api'
import { Button, Card, Chip, ErrorText, Field, Logo, OtpInput } from '../../ui'

export function InvitePage() {
  const { token } = useParams({ from: '/invite/$token' })
  const invite = useQuery({
    queryKey: ['invite', token],
    queryFn: () => unwrap(api.api.auth.invites[':token'].$get({ param: { token } })),
    retry: false,
    staleTime: Infinity,
  })
  const [backupCodes, setBackupCodes] = useState<string[] | null>(null)

  return (
    <main className="min-h-full bg-bg flex justify-center px-6 pt-[max(40px,env(safe-area-inset-top))] pb-[max(24px,env(safe-area-inset-bottom))]">
      <div className="w-full max-w-sm flex flex-col gap-3.5">
        <Logo />
        {invite.isPending && <p className="text-muted">Checking your invite…</p>}
        {invite.isError && (
          <>
            <h1 className="font-head font-medium text-[28px] m-0">Invite unavailable</h1>
            <ErrorText error={invite.error} />
          </>
        )}
        {invite.data && !backupCodes && <AcceptForm token={token} invite={invite.data} onDone={setBackupCodes} />}
        {backupCodes && <BackupCodes codes={backupCodes} space={invite.data?.spaceName ?? 'DevDash'} />}
      </div>
    </main>
  )
}

type Invite = { email: string; username: string; role: string; spaceName: string; totpSecret: string; totpUri: string }

function AcceptForm({ token, invite, onDone }: { token: string; invite: Invite; onDone: (codes: string[]) => void }) {
  const qc = useQueryClient()
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [qr, setQr] = useState('')
  useEffect(() => { QRCode.toDataURL(invite.totpUri, { margin: 1, width: 360 }).then(setQr) }, [invite.totpUri])

  const accept = useMutation({
    mutationFn: () => unwrap(api.api.auth.invites[':token'].$post({ param: { token }, json: { name, password, code } })),
    onSuccess: (r) => {
      qc.setQueryData(meQuery.queryKey, r.user)
      onDone(r.backupCodes)
    },
    onError: () => setCode(''),
  })

  const ready = name.trim() && password && code.length === 6
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (ready && !accept.isPending) accept.mutate()
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3.5">
      <div>
        <h1 className="font-head font-medium text-[30px] leading-tight m-0">Join {invite.spaceName}</h1>
        <p className="text-muted m-0">{invite.email} · <span className="font-mono">@{invite.username}</span> {invite.role === 'admin' && <Chip tone="accent">admin</Chip>}</p>
      </div>
      <Field label="Your name" icon={<IconUser size={18} />} autoComplete="name" required value={name} onChange={(e) => setName(e.target.value)} />
      <Field label="Password" icon={<IconLock size={18} />} type="password" autoComplete="new-password" required
        value={password} onChange={(e) => setPassword(e.target.value)} />
      <input type="hidden" autoComplete="username" value={invite.email} readOnly />
      <Card>
        <p className="font-semibold m-0">Set up two-step sign-in</p>
        <p className="text-muted text-[12px] mt-0 mb-3">Add this space to an authenticator app (Google Authenticator, 1Password, Aegis…), then enter the code it shows.</p>
        <a href={invite.totpUri} className="lg:hidden flex items-center justify-center gap-1.5 h-11 rounded-xl border border-accent text-accent font-medium text-[14px] mb-3">
          <IconExternalLink size={16} />Add to authenticator app
        </a>
        {qr && <img src={qr} alt="QR code for your authenticator app" className="w-44 h-44 mx-auto rounded-xl bg-white p-1" />}
        <SecretRow secret={invite.totpSecret} />
        <div className="mt-3"><OtpInput label="Code from the app" value={code} onChange={setCode} /></div>
      </Card>
      <ErrorText error={accept.error} />
      <Button type="submit" variant="primary" full className="h-12" disabled={!ready || accept.isPending}>
        {accept.isPending ? 'Creating account…' : 'Create account'}
      </Button>
    </form>
  )
}

function SecretRow({ secret }: { secret: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="mt-2 flex items-center gap-2">
      <code className="flex-1 min-w-0 break-words text-[11.5px] font-mono text-muted">{secret.match(/.{1,4}/g)!.join(' ')}</code>
      <Button type="button" size="sm" onClick={() => navigator.clipboard.writeText(secret).then(() => setCopied(true))}>
        <IconCopy size={16} />{copied ? 'Copied' : 'Copy'}
      </Button>
    </div>
  )
}

function BackupCodes({ codes, space }: { codes: string[]; space: string }) {
  const navigate = useNavigate()
  const [saved, setSaved] = useState(false)
  const text = `${space} backup codes. Each code works once.\n\n${codes.join('\n')}\n`
  const download = () => {
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }))
    a.download = `${space.toLowerCase().replace(/\W+/g, '-')}-backup-codes.txt`
    a.click()
    URL.revokeObjectURL(a.href)
    setSaved(true)
  }
  return (
    <div className="flex flex-col gap-3.5">
      <div>
        <h1 className="font-head font-medium text-[30px] leading-tight m-0">Save your backup codes</h1>
        <p className="text-muted m-0">If you lose your phone, each code signs you in once. They won't be shown again.</p>
      </div>
      <Card>
        <ul className="grid grid-cols-2 gap-x-4 gap-y-1.5 font-mono text-[13px] m-0 p-0 list-none">
          {codes.map((c) => <li key={c}>{c}</li>)}
        </ul>
      </Card>
      <div className="flex gap-2">
        <Button className="flex-1" onClick={download}><IconDownload size={16} />Download</Button>
        <Button className="flex-1" onClick={() => navigator.clipboard.writeText(text).then(() => setSaved(true))}><IconCopy size={16} />Copy</Button>
      </div>
      <Button variant="primary" full className="h-12" disabled={!saved} onClick={() => navigate({ to: '/' })}>
        {saved ? 'Continue' : 'Save the codes to continue'}
      </Button>
    </div>
  )
}
