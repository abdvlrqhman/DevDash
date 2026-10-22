import { useEffect, useRef, useState, type FormEvent } from 'react'
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { FileKey } from 'lucide-react'
import { toast } from 'sonner'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { api, unwrap } from '@/lib/api'
import { ErrorAlert } from '../auth/LoginPage'

const configQuery = queryOptions({ queryKey: ['notifications', 'apns'], queryFn: () => unwrap(api.api.notifications.apns.config.$get()) })
const link = 'text-foreground underline underline-offset-4'

/**
 * Admins add the space's Apple push key once, so the iPhone app gets notifications while it's closed
 * (docs/design/ios-push.md). The .p8 file goes to the server once, sealed there, and never comes back.
 */
export function ApnsSetup() {
  const qc = useQueryClient()
  const c = useQuery(configQuery).data
  const [teamId, setTeamId] = useState('')
  const [keyId, setKeyId] = useState('')
  const [bundleId, setBundleId] = useState('')
  const [key, setKey] = useState('')
  const [keyFile, setKeyFile] = useState<string | null>(null)
  const [error, setError] = useState<Error | null>(null)
  const [removing, setRemoving] = useState(false)
  const file = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (!c) return
    setTeamId(c.teamId ?? '')
    setKeyId(c.keyId ?? '')
    setBundleId(c.bundleId)
  }, [c?.teamId, c?.keyId, c?.bundleId])

  const done = () => void qc.invalidateQueries({ queryKey: ['notifications'] })
  const save = useMutation({
    mutationFn: () => unwrap(api.api.notifications.apns.config.$put({ json: { teamId, keyId, bundleId, ...(key.trim() && { key }) } })),
    onSuccess: () => {
      toast.success('Apple push key saved')
      setKey('')
      setKeyFile(null)
      setError(null)
      done()
    },
    onError: (e) => setError(e),
  })
  const remove = useMutation({
    mutationFn: () => unwrap(api.api.notifications.apns.config.$delete()),
    onSuccess: () => {
      toast.success('The iPhone app no longer gets notifications while it’s closed')
      setRemoving(false)
      done()
    },
    onError: (e) => toast.error(e.message),
  })
  if (!c) return null

  /** The AuthKey_<Key ID>.p8 file Apple gives you once; its name carries the Key ID. */
  const pick = async (f: File | undefined) => {
    if (!f) return
    setKey(await f.text())
    setKeyFile(f.name)
    const m = /AuthKey_([A-Z0-9]{10})\.p8$/i.exec(f.name)
    if (m) setKeyId(m[1]!.toUpperCase())
  }
  const submit = (e: FormEvent) => {
    e.preventDefault()
    save.mutate()
  }
  const devices = c.devices.sandbox + c.devices.production
  const changesKey = c.configured && (keyId.trim().toUpperCase() !== c.keyId || teamId.trim().toUpperCase() !== c.teamId)

  return (
    <div className="flex flex-col gap-4">
      {c.configured && (
        <p className="text-sm text-muted-foreground">
          On.{' '}
          {devices === 0
            ? 'No iPhone has registered yet: open the signed DevDash app, then Account → Notifications on this device.'
            : `${devices} iPhone app ${devices === 1 ? 'install is' : 'installs are'} registered.`}
        </p>
      )}
      {c.lastError && (
        <Alert variant="destructive">
          <AlertTitle>Apple refused a notification{c.lastErrorAt ? ` (${new Date(c.lastErrorAt * 1000).toLocaleString()})` : ''}</AlertTitle>
          <AlertDescription>{c.lastError}</AlertDescription>
        </Alert>
      )}
      <ol className="flex list-decimal flex-col gap-2 pl-5 text-sm text-muted-foreground">
        <li>
          This needs the paid <a className={link} href="https://developer.apple.com/programs/" target="_blank" rel="noreferrer">Apple Developer Program</a>.
          Apple gives push notifications only to apps signed with it, so copies installed with AltStore or SideStore (free Apple IDs) still only get them while open.
        </li>
        <li>
          In <a className={link} href="https://developer.apple.com/account/resources/identifiers/list" target="_blank" rel="noreferrer">Identifiers</a>, register the App ID <b className="text-foreground">{bundleId || c.bundleId}</b> with <b className="text-foreground">Push Notifications</b> on, and sign the app with it (the GitHub secrets in docs/design/ios-push.md).
        </li>
        <li>
          In <a className={link} href="https://developer.apple.com/account/resources/authkeys/list" target="_blank" rel="noreferrer">Keys</a>, add a key with <b className="text-foreground">Apple Push Notifications service (APNs)</b>: configure it as Team Scoped, for Sandbox &amp; Production (or Production: ad hoc and TestFlight builds use it). Download the .p8 file; Apple offers it only once.
        </li>
        <li>Your Team ID is under <a className={link} href="https://developer.apple.com/account#MembershipDetailsCard" target="_blank" rel="noreferrer">Membership details</a>.</li>
      </ol>
      <form onSubmit={submit}>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="apns-key">Key (.p8 file)</FieldLabel>
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" variant="outline" className="h-10" onClick={() => file.current?.click()}><FileKey />Choose the .p8 file</Button>
              <span className="text-sm text-muted-foreground">{keyFile ?? (c.configured ? 'Saved. Choose a new file to replace it.' : 'Or paste it below.')}</span>
            </div>
            <input ref={file} type="file" accept=".p8" hidden onChange={(e) => void pick(e.target.files?.[0])} />
            {!keyFile && (
              <Input id="apns-key" type="password" className="h-10 font-mono text-xs" placeholder="-----BEGIN PRIVATE KEY-----…" value={key} onChange={(e) => setKey(e.target.value)} autoComplete="off" />
            )}
            <FieldDescription>Encrypted on the server and never shown again.</FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="apns-key-id">Key ID</FieldLabel>
            <Input id="apns-key-id" className="h-10 font-mono text-xs" placeholder="ABC123DEFG" value={keyId} onChange={(e) => setKeyId(e.target.value)} autoComplete="off" />
          </Field>
          <Field>
            <FieldLabel htmlFor="apns-team">Team ID</FieldLabel>
            <Input id="apns-team" className="h-10 font-mono text-xs" placeholder="DEF123GHIJ" value={teamId} onChange={(e) => setTeamId(e.target.value)} autoComplete="off" />
          </Field>
          <Field>
            <FieldLabel htmlFor="apns-bundle">Bundle ID</FieldLabel>
            <Input id="apns-bundle" className="h-10 font-mono text-xs" value={bundleId} onChange={(e) => setBundleId(e.target.value)} autoComplete="off" />
            <FieldDescription>The DevDash app's bundle ID, as signed. Change it only if you build the app under your own.</FieldDescription>
          </Field>
          {changesKey && !key.trim() && <p className="text-sm text-attention-foreground">A different Key ID or Team ID needs its .p8 file too.</p>}
          <ErrorAlert error={error} />
          <div className="flex flex-wrap gap-2">
            <Button type="submit" className="h-10" disabled={save.isPending || !teamId.trim() || !keyId.trim() || !bundleId.trim() || (!c.configured && !key.trim())}>
              {save.isPending ? 'Saving…' : 'Save'}
            </Button>
            {c.configured && (removing ? (
              <>
                <Button type="button" variant="destructive" className="h-10" disabled={remove.isPending} onClick={() => remove.mutate()}>Yes, remove the key</Button>
                <Button type="button" variant="ghost" className="h-10" onClick={() => setRemoving(false)}>Cancel</Button>
              </>
            ) : (
              <Button type="button" variant="ghost" className="h-10" onClick={() => setRemoving(true)}>Remove</Button>
            ))}
          </div>
        </FieldGroup>
      </form>
    </div>
  )
}
