import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate, useParams } from '@tanstack/react-router'
import { Play, RotateCw, Square, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { StatusLight } from '@/components/app/brand'
import { PageHeader } from '@/components/app/page'
import { ResponsiveDialog } from '@/components/app/responsive-dialog'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { api, unwrap } from '@/lib/api'
import { ErrorAlert } from '../auth/LoginPage'
import { TerminalView, type Status } from '../terminal/TerminalView'
import { servicesQuery, stateOf, useLiveServices } from './data'

export function ServicePage() {
  useLiveServices()
  const { name } = useParams({ from: '/app/services/$name' })
  const qc = useQueryClient()
  const navigate = useNavigate()
  const list = useQuery(servicesQuery)
  const [removing, setRemoving] = useState(false)
  const [, setLogStatus] = useState<Status>('connecting')
  const s = list.data?.services.find((x) => x.name === name)

  const act = useMutation({
    mutationFn: (what: 'start' | 'stop' | 'restart') => unwrap(api.api.services[':name'][what].$post({ param: { name } })),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['services'] }),
    onError: (e) => toast.error(e.message),
  })
  const remove = useMutation({
    mutationFn: () => unwrap(api.api.services[':name'].$delete({ param: { name } })),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['services'] })
      void navigate({ to: '/services' })
    },
  })

  if (list.isSuccess && !s) {
    return <><PageHeader title={name} back="/services" /><div className="p-4"><ErrorAlert error={new Error(`There is no service called ${name}.`)} /></div></>
  }
  if (!s) return <><PageHeader title={name} back="/services" /><div className="p-4"><Skeleton className="h-40" /></div></>

  const st = stateOf(s)
  const hasOutput = s.state !== 'stopped' && s.state !== 'unknown'
  return (
    <div className="flex h-full flex-col">
      <PageHeader back="/services" title={<span className="font-mono">{s.name}</span>}
        description={<span className="flex items-center gap-1.5"><StatusLight state={st.light} />{st.label}</span>}
        actions={s.canControl && <>
          {s.desired === 'stopped'
            ? <Button size="sm" disabled={act.isPending} onClick={() => act.mutate('start')}><Play />Start</Button>
            : <>
                <Button size="sm" variant="outline" disabled={act.isPending} onClick={() => act.mutate('restart')}><RotateCw /><span className="hidden sm:inline">Restart</span></Button>
                <Button size="sm" variant="outline" disabled={act.isPending} onClick={() => act.mutate('stop')}><Square /><span className="hidden sm:inline">Stop</span></Button>
              </>}
          <Button size="icon-sm" variant="ghost" aria-label="Remove service" onClick={() => setRemoving(true)}><Trash2 /></Button>
        </>} />

      <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 border-b px-4 py-3 text-sm md:px-6">
        <dt className="text-muted-foreground">Port</dt>
        <dd className="font-mono">{s.port} <span className="font-sans text-muted-foreground">{s.listening ? 'listening on 127.0.0.1' : 'not listening'}</span></dd>
        <dt className="text-muted-foreground">Command</dt><dd className="font-mono break-all">{s.command}</dd>
        <dt className="text-muted-foreground">Folder</dt><dd className="font-mono break-all">{s.cwd}</dd>
        <dt className="text-muted-foreground">Owner</dt><dd>{s.owner.name}</dd>
        {s.error && <><dt className="text-muted-foreground">Problem</dt><dd className="text-destructive">{s.error}</dd></>}
        {s.state === 'crashed' && <><dt className="text-muted-foreground">Exit code</dt><dd className="font-mono">{s.exitCode ?? 'unknown'}</dd></>}
      </dl>

      <div className="relative m-2 min-h-0 flex-1 overflow-hidden rounded-lg bg-term-bg p-2 md:m-4">
        {hasOutput
          ? <TerminalView key={`${s.name}:${s.state === 'crashed'}`} path={`/api/services/${s.name}/logs`} onStatus={setLogStatus} />
          : <p className="flex h-full items-center justify-center px-6 text-center text-sm text-term-fg/70">Stopped. Its output shows here while it runs.</p>}
      </div>

      <ResponsiveDialog open={removing} onOpenChange={setRemoving} title={`Remove ${s.name}?`} description="It stops, and its port goes back to the pool. The folder and its files stay.">
        <div className="flex flex-col gap-3">
          <ErrorAlert error={remove.error} />
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setRemoving(false)}>Keep it</Button>
            <Button variant="destructive" disabled={remove.isPending} onClick={() => remove.mutate()}>Remove service</Button>
          </div>
        </div>
      </ResponsiveDialog>
    </div>
  )
}
