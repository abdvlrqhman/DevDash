import { useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { IconAt, IconCopy, IconMail } from '@tabler/icons-react'
import { PageHeader } from '../../app/AppShell'
import { api, meQuery, unwrap } from '../../lib/api'
import { Avatar, Button, Card, Chip, ErrorText, Field, cx } from '../../ui'

const membersQuery = { queryKey: ['members'], queryFn: () => unwrap(api.api.members.$get()) }
const daysLeft = (unix: number) => Math.max(0, Math.ceil((unix * 1000 - Date.now()) / 86_400_000))

export function MembersPage() {
  const me = useQuery(meQuery).data!
  const { data, error } = useQuery(membersQuery)

  return (
    <>
      <PageHeader title="Members" />
      <div className="px-4 lg:px-8 pb-6 flex flex-col gap-2.5 max-w-3xl">
        {me.role === 'admin' && <InviteCard />}
        <ErrorText error={error} />
        <ul className="bg-surface border border-line rounded-2xl overflow-hidden m-0 p-0 list-none">
          {data?.users.map((u) => (
            <li key={u.id} className="flex items-center gap-2.5 px-3.5 py-2.5 border-t border-line first:border-t-0">
              <Avatar name={u.name} seed={u.id} />
              <div className="flex-1 min-w-0">
                <div className="truncate">{u.name}{u.id === me.id && <span className="text-muted"> (you)</span>}</div>
                <div className="text-muted text-[13px] truncate">{u.username}, {u.email}</div>
              </div>
              {me.role === 'admin' && !u.provisioned_at && (
                <span title={u.provision_error ?? undefined}><Chip tone={u.provision_error ? 'bad' : 'warn'}>{u.provision_error ? 'Server account failed' : 'Setting up'}</Chip></span>
              )}
              {u.role === 'admin' && <Chip tone="accent">Admin</Chip>}
            </li>
          ))}
        </ul>
        {!!data?.invites.length && (
          <>
            <h2 className="text-[12px] text-muted font-normal mt-2 mx-0.5 mb-0">Invited</h2>
            <ul className="bg-surface border border-line rounded-2xl overflow-hidden m-0 p-0 list-none">
              {data.invites.map((i) => (
                <li key={i.id} className="flex items-center gap-2.5 px-3.5 py-2.5 border-t border-line first:border-t-0">
                  <div className="flex-1 min-w-0">
                    <div className="truncate">{i.email}</div>
                    <div className="text-muted text-[13px]">{i.username}</div>
                  </div>
                  <Chip tone="warn">{daysLeft(i.expires_at)}d left</Chip>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </>
  )
}

function InviteCard() {
  const qc = useQueryClient()
  const [email, setEmail] = useState('')
  const [username, setUsername] = useState('')
  const [touchedUsername, setTouchedUsername] = useState(false)
  const [role, setRole] = useState<'member' | 'admin'>('member')
  const [copied, setCopied] = useState(false)

  const invite = useMutation({
    mutationFn: () => unwrap(api.api.members.invites.$post({ json: { email, username, role } })),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['members'] }),
  })

  const onEmail = (v: string) => {
    setEmail(v)
    if (!touchedUsername) setUsername(v.split('@')[0]!.toLowerCase().replace(/[^a-z0-9-]/g, '').replace(/^[^a-z]+/, '').slice(0, 31))
  }
  const submit = (e: FormEvent) => {
    e.preventDefault()
    setCopied(false)
    invite.mutate()
  }

  if (invite.data) {
    return (
      <Card tone="accent">
        <p className="font-medium m-0">Invite link for {email}</p>
        <p className="text-muted text-[12px] mt-0 mb-2.5">Send it privately. Single use, valid for 7 days.</p>
        <code className="block break-all font-mono text-[12px] bg-surface-2 rounded-lg px-2.5 py-2">{invite.data.link}</code>
        <div className="flex gap-2 mt-2.5">
          <Button size="sm" variant="primary" onClick={() => navigator.clipboard.writeText(invite.data.link).then(() => setCopied(true))}>
            <IconCopy size={16} />{copied ? 'Copied' : 'Copy link'}
          </Button>
          <Button size="sm" onClick={() => { invite.reset(); setEmail(''); setUsername(''); setTouchedUsername(false) }}>Invite another</Button>
        </div>
      </Card>
    )
  }

  return (
    <Card>
      <form onSubmit={submit} className="flex flex-col gap-2.5">
        <p className="font-medium m-0">Invite a member</p>
        <Field label="Email" icon={<IconMail size={18} />} type="email" required value={email} onChange={(e) => onEmail(e.target.value)} />
        <Field label="Username" icon={<IconAt size={18} />} required pattern="[a-z][a-z0-9\-]{1,30}" hint="Also their Linux user on the server. Lowercase, can't be changed later."
          value={username} onChange={(e) => { setTouchedUsername(true); setUsername(e.target.value.toLowerCase()) }} />
        <div role="radiogroup" aria-label="Role" className="flex bg-surface-2 rounded-[10px] p-0.5 self-start">
          {(['member', 'admin'] as const).map((r) => (
            <button key={r} type="button" role="radio" aria-checked={role === r} onClick={() => setRole(r)}
              className={cx('px-3.5 h-8 rounded-lg text-[13px] capitalize', role === r ? 'bg-surface text-text shadow-sm' : 'text-muted')}>{r}</button>
          ))}
        </div>
        <ErrorText error={invite.error} />
        <Button type="submit" variant="primary" disabled={!email || !username || invite.isPending}>Create invite link</Button>
      </form>
    </Card>
  )
}
