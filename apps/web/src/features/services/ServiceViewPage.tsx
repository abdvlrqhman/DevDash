import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useParams } from '@tanstack/react-router'
import { ExternalLink, RotateCw } from 'lucide-react'
import { StatusLight } from '@/components/app/brand'
import { PageHeader } from '@/components/app/page'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { openExternal } from '@/lib/shell'
import { usePageTitle } from '@/lib/title'
import { ErrorAlert } from '../auth/LoginPage'
import { PinButton } from '../pins/pins'
import { servicesQuery, stateOf, useLiveServices } from './data'

/** Keyed by the URL, so moving to another service starts from a clean slate. */
export function ServiceViewPage() {
  const p = useParams({ from: '/app/services/$name/view' })
  return <ServiceView key={p.name} />
}

/**
 * A service inside DevDash, under the app's top bar: its pages framed from the services site (https://<space>:8443/
 * service/<name>/), a separate origin on purpose, so a service's pages still can't act on DevDash. Being the same site,
 * the frame gets the member's DevDash sign-in, and members-only services stay members-only (the services proxy checks).
 */
function ServiceView() {
  useLiveServices()
  const { name } = useParams({ from: '/app/services/$name/view' })
  const list = useQuery(servicesQuery)
  const [reload, setReload] = useState(0)
  const s = list.data?.services.find((x) => x.name === name)
  usePageTitle(name)

  if (list.isSuccess && !s) {
    return <><PageHeader title={name} back="/services" /><div className="p-4"><ErrorAlert error={new Error(`There is no service called ${name}.`)} /></div></>
  }
  if (!s) return <><PageHeader title={name} back="/services" /><div className="p-4"><Skeleton className="h-80" /></div></>

  const st = stateOf(s)
  return (
    <div className="flex h-full flex-col">
      <PageHeader back={`/services/${s.name}`} title={<span className="font-mono">{s.name}</span>}
        description={<span className="flex items-center gap-1.5"><StatusLight state={st.light} />{st.label}{s.public ? ' · anyone with the link' : ' · members only'}</span>}
        actions={<>
          <PinButton kind="service" id={s.name} />
          <Button size="icon-sm" variant="ghost" aria-label="Reload" title="Reload" onClick={() => setReload((n) => n + 1)}><RotateCw /></Button>
          {s.previewUrl && <Button size="sm" variant="outline" onClick={() => openExternal(s.previewUrl)}><ExternalLink /><span className="hidden sm:inline">Open in browser</span></Button>}
        </>} />
      {s.previewUrl ? (
        // sandbox: everything a web app normally does, but it can't navigate DevDash itself away.
        // DevDash's own Permissions-Policy still keeps camera, microphone and location off; "Open in browser" has them.
        <iframe key={reload} title={s.name} src={s.previewUrl} className="min-h-0 w-full flex-1 border-0 border-t bg-background"
          allow="clipboard-read; clipboard-write; fullscreen"
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads allow-modals allow-pointer-lock allow-orientation-lock allow-presentation" />
      ) : (
        <div className="p-4"><ErrorAlert error={new Error('This service has no address to show.')} /></div>
      )}
    </div>
  )
}
