import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Globe, Maximize, Power } from 'lucide-react'
import { toast } from 'sonner'
import { PageHeader } from '@/components/app/page'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { api, meQuery, unwrap } from '@/lib/api'
import { inShell } from '@/lib/shell'
import { ErrorAlert } from '../auth/LoginPage'

/**
 * The team's shared browser on the server: one Chromium that stays signed in to things (logins and tabs persist),
 * streamed here. One person controls it at a time; the others watch. It stops after 30 minutes nobody is looking.
 */
export function BrowserPage() {
  const me = useQuery(meQuery).data!
  const qc = useQueryClient()
  const status = useQuery({ queryKey: ['browser'], queryFn: () => unwrap(api.api.browser.$get()) })
  const [url, setUrl] = useState<string | null>(null)
  const open = useMutation({
    mutationFn: () => unwrap(api.api.browser.open.$post()),
    onSuccess: (r) => { setUrl(r.url); void qc.invalidateQueries({ queryKey: ['browser'] }) },
  })
  const stop = useMutation({
    mutationFn: () => unwrap(api.api.browser.stop.$post()),
    onSuccess: () => { setUrl(null); void qc.invalidateQueries({ queryKey: ['browser'] }); toast.success('Browser stopped. Logins are kept for next time.') },
    onError: (e) => toast.error(e.message),
  })

  // Tell the server someone is watching, so it doesn't stop the browser.
  useEffect(() => {
    if (!url) return
    const beat = () => { if (document.visibilityState === 'visible') void api.api.browser.heartbeat.$post() }
    const i = setInterval(beat, 60_000)
    return () => clearInterval(i)
  }, [url])
  // Already running? Join straight away.
  useEffect(() => { if (status.data?.running && !url && !open.isPending && !open.isError) open.mutate() }, [status.data?.running]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="flex h-full flex-col">
      <PageHeader title="Browser" description="One shared browser on the server, signed in to your team's tools"
        actions={url && <>
          {!inShell() && <Button size="sm" variant="outline" onClick={() => document.getElementById('dd-browser')?.requestFullscreen?.()}><Maximize /><span className="hidden sm:inline">Full screen</span></Button>}
          {me.role === 'admin' && <Button size="icon-sm" variant="ghost" aria-label="Stop the browser" disabled={stop.isPending} onClick={() => stop.mutate()}><Power /></Button>}
        </>} />
      {url ? (
        <iframe id="dd-browser" title="Shared browser" src={url} className="min-h-0 w-full flex-1 border-0 bg-black"
          allow="autoplay; clipboard-read; clipboard-write; fullscreen; microphone" />
      ) : (
        <div className="mx-auto flex w-full max-w-md flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
          <span className="flex size-12 items-center justify-center rounded-full bg-muted"><Globe className="size-5" /></span>
          <div className="flex flex-col gap-1.5">
            <h2 className="text-lg font-semibold">Team browser</h2>
            <p className="text-sm text-muted-foreground">
              A Chromium on the server that everyone shares. Sign in to a site once (an admin panel, a store console, a test account) and it stays signed in for the whole team, from any device. One person drives at a time; the others watch.
            </p>
          </div>
          <ErrorAlert error={status.error ?? open.error} />
          <Button className="h-10" disabled={open.isPending || status.isPending} onClick={() => open.mutate()}>
            {open.isPending ? <><Spinner />Starting…</> : status.data?.running ? 'Join' : 'Start the browser'}
          </Button>
          <p className="text-xs text-muted-foreground">It stops by itself after 30 minutes nobody is watching. Logins and open tabs are kept.</p>
        </div>
      )}
    </div>
  )
}
