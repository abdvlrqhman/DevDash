import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { BellRing } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Separator } from '@/components/ui/separator'
import { Switch } from '@/components/ui/switch'
import { api, unwrap } from '@/lib/api'
import { looking, useTopic } from '@/lib/live'
import { disablePush, enablePush, needsHomeScreen, pushEnabled, pushSupported } from '@/lib/push'
import { inIosShell, inShell, setBackgroundNotifications, syncBackgroundNotifications } from '@/lib/shell'
import { ErrorAlert } from '../auth/LoginPage'

type Event = { notification: { title: string; body: string; url: string } }

/** Shows notifications as they happen: a toast while you're looking, a system notification from the native app otherwise. */
export function useNotificationEvents() {
  const navigate = useNavigate()
  useEffect(() => void syncBackgroundNotifications(), [])
  useTopic('notifications', (e) => {
    const n = (e as unknown as Event).notification
    if (looking()) {
      if (location.pathname === n.url) return // already on it
      toast(n.title, { description: n.body || undefined, action: { label: 'Open', onClick: () => void navigate({ to: n.url }) } })
    } else if (window.DevDashAndroid?.backgroundNotifications()) return // the app's background connection shows it
    else if (window.devdashShell?.notify) window.devdashShell.notify(n.title, n.body)
    // A browser that isn't being looked at gets Web Push from the server; the toast waits for whoever comes back.
    else toast(n.title, { description: n.body || undefined, duration: Infinity, closeButton: true, action: { label: 'Open', onClick: () => void navigate({ to: n.url }) } })
  })
}

type Prefs = { needs_you: boolean; finished: boolean; errors: boolean; shared: boolean }
const KINDS: { key: keyof Prefs; label: string; description: string }[] = [
  { key: 'needs_you', label: 'Claude needs you', description: 'A question, a plan to approve, or a permission to grant.' },
  { key: 'finished', label: 'Claude finished', description: 'A reply or task is done.' },
  { key: 'errors', label: 'Claude stopped with an error', description: 'Usage limits, sign-in problems, crashes.' },
  { key: 'shared', label: 'Shared with you', description: 'A teammate shares a Claude session.' },
]

export function NotificationsPanel() {
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['notifications', 'prefs'], queryFn: () => unwrap(api.api.notifications.prefs.$get()) })
  const save = useMutation({
    mutationFn: (p: Prefs) => unwrap(api.api.notifications.prefs.$put({ json: p })),
    onSuccess: (r) => qc.setQueryData(['notifications', 'prefs'], (old: typeof q.data) => old && { ...old, prefs: r.prefs }),
  })
  const test = useMutation({
    mutationFn: () => unwrap(api.api.notifications.test.$post()),
    onSuccess: () => toast.success('Test sent. It shows on every device where notifications are on.'),
  })
  const prefs = q.data?.prefs

  return (
    <FieldGroup>
      <ThisDevice publicKey={q.data?.publicKey} />
      <Separator />
      <ErrorAlert error={q.error ?? save.error} />
      {KINDS.map((k) => (
        <Field key={k.key} orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor={`n-${k.key}`}>{k.label}</FieldLabel>
            <FieldDescription>{k.description}</FieldDescription>
          </FieldContent>
          <Switch id={`n-${k.key}`} disabled={!prefs} checked={prefs?.[k.key] ?? false}
            onCheckedChange={(v) => prefs && save.mutate({ ...prefs, [k.key]: v })} />
        </Field>
      ))}
      <ErrorAlert error={test.error} />
      <div><Button variant="outline" disabled={test.isPending} onClick={() => test.mutate()}><BellRing />Send a test notification</Button></div>
    </FieldGroup>
  )
}

/** Turns notifications on for the device in hand: Web Push in browsers, system permission in the native app. */
function ThisDevice({ publicKey }: { publicKey?: string }) {
  const shell = inShell()
  const native = shell && !!window.devdashShell?.notificationPermission
  const android = !!window.DevDashAndroid
  const [on, setOn] = useState<boolean | null>(null)
  const [error, setError] = useState<Error | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (android) void window.devdashShell!.notificationPermission!(false).then((s) => setOn(s === 'granted' && window.DevDashAndroid!.backgroundNotifications()))
    else if (native) void window.devdashShell!.notificationPermission!(false).then((s) => setOn(s === 'granted'))
    else if (pushSupported()) void pushEnabled().then(setOn, () => setOn(false))
  }, [native])

  const run = async (fn: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    try { await fn() } catch (e) { setError(e as Error) } finally { setBusy(false) }
  }
  const enable = () => run(async () => {
    if (native) {
      const s = await window.devdashShell!.notificationPermission!(true)
      if (s !== 'granted') throw new Error('Notifications are off for DevDash. Turn them on in your phone’s settings, then come back.')
      setBackgroundNotifications(true)
      setOn(true)
      window.devdashShell!.notify!('DevDash', 'Notifications are on for this device.') // the real system path, not a toast
    } else {
      await enablePush(publicKey!)
      setOn(true)
    }
  })
  const disable = () => run(async () => {
    if (android) setBackgroundNotifications(false)
    else await disablePush()
    setOn(false)
  })

  let body
  if (shell && !native) body = <FieldDescription>Update the DevDash app to get notifications on this device.</FieldDescription>
  else if (!shell && needsHomeScreen()) body = <FieldDescription>On iPhone, notifications work once DevDash is on your Home Screen: tap Share, then Add to Home Screen, and open it from there.</FieldDescription>
  else if (!native && !pushSupported()) body = <FieldDescription>This browser can't show notifications. Use the DevDash app, or Chrome, Edge, Firefox or Safari.</FieldDescription>
  else body = (
    <Field orientation="horizontal">
      <FieldContent>
        <FieldLabel htmlFor="n-device">Notifications on this device</FieldLabel>
        <FieldDescription>
          {android ? 'Arrive even when the app is closed. Android keeps a quiet “DevDash is connected” notification for that.'
            : inIosShell() ? 'Arrive while the app is open. For notifications when it’s closed, open this site in Safari, tap Share, then Add to Home Screen, and turn them on there.'
            : native ? 'Arrive while the app is open or in the background.' : 'Arrive even when DevDash is closed.'} You won't get them twice: while you're using DevDash somewhere, they show inside it.
        </FieldDescription>
      </FieldContent>
      <Switch id="n-device" disabled={on === null || busy || (native && !android && on)} checked={!!on}
        onCheckedChange={(v) => void (v ? enable() : disable())} />
    </Field>
  )
  return (
    <>
      {body}
      <ErrorAlert error={error} />
    </>
  )
}
