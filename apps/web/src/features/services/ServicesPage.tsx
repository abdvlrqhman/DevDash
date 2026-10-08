import { useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { Plus, Server } from 'lucide-react'
import { initials, StatusLight } from '@/components/app/brand'
import { PageBody, PageHeader, Section } from '@/components/app/page'
import { ResponsiveDialog } from '@/components/app/responsive-dialog'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle } from '@/components/ui/item'
import { Skeleton } from '@/components/ui/skeleton'
import { api, meQuery, unwrap } from '@/lib/api'
import { ErrorAlert } from '../auth/LoginPage'
import { servicesQuery, stateOf, useLiveServices, type Service } from './data'

export function ServicesPage() {
  useLiveServices()
  const list = useQuery(servicesQuery)
  const me = useQuery(meQuery).data!
  const [adding, setAdding] = useState(false)
  const services = list.data?.services ?? []
  const mine = services.filter((s) => s.owner.id === me.id)
  const others = services.filter((s) => s.owner.id !== me.id)

  return (
    <>
      <PageHeader title="Services" description="Web servers, APIs and containers that stay up"
        actions={<Button size="sm" onClick={() => setAdding(true)}><Plus />New</Button>} />
      <PageBody>
        <ErrorAlert error={list.error} />
        {list.isPending && <div className="flex flex-col gap-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-16" />)}</div>}
        {list.isSuccess && !services.length && (
          <Empty className="border">
            <EmptyHeader>
              <EmptyMedia variant="icon"><Server /></EmptyMedia>
              <EmptyTitle>No services yet</EmptyTitle>
              <EmptyDescription>
                Run a website, an API or a container here and it keeps running when you close everything. Each one gets its own port, so nothing collides.
                Claude can add them too, with <code className="font-mono text-foreground">devdash service add</code>.
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent><Button onClick={() => setAdding(true)}><Plus />New service</Button></EmptyContent>
          </Empty>
        )}
        {mine.length > 0 && <ServiceList title="Yours" services={mine} />}
        {others.length > 0 && <ServiceList title="Your team's" services={others} showOwner />}
      </PageBody>
      <NewService open={adding} onOpenChange={setAdding} />
    </>
  )
}

function ServiceList({ title, services, showOwner }: { title: string; services: Service[]; showOwner?: boolean }) {
  return (
    <Section title={title}>
      <ItemGroup className="rounded-xl border">
        {services.map((s) => {
          const st = stateOf(s)
          return (
            <Item key={s.name} asChild className="rounded-none border-0 border-b last:border-b-0">
              <Link to="/services/$name" params={{ name: s.name }}>
                <ItemMedia><StatusLight state={st.light} /></ItemMedia>
                <ItemContent className="min-w-0">
                  <ItemTitle className="font-mono">{s.name}</ItemTitle>
                  <ItemDescription className="truncate">{st.label}, port {s.port}, <span className="font-mono">{s.command}</span></ItemDescription>
                </ItemContent>
                {showOwner && (
                  <ItemActions>
                    <Avatar className="size-7" title={s.owner.name}><AvatarFallback className="text-[11px]">{initials(s.owner.name)}</AvatarFallback></Avatar>
                  </ItemActions>
                )}
              </Link>
            </Item>
          )
        })}
      </ItemGroup>
    </Section>
  )
}

function NewService({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [cwd, setCwd] = useState('~')
  const [command, setCommand] = useState('')
  const create = useMutation({
    mutationFn: () => unwrap(api.api.services.$post({ json: { name, cwd, command } })),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['services'] })
      close(false)
      void navigate({ to: '/services/$name', params: { name: r.service.name } })
    },
  })
  const close = (v: boolean) => {
    onOpenChange(v)
    if (!v) { setName(''); setCwd('~'); setCommand(''); create.reset() }
  }
  const submit = (e: FormEvent) => {
    e.preventDefault()
    create.mutate()
  }
  return (
    <ResponsiveDialog open={open} onOpenChange={close} title="New service" description="It starts right away and DevDash keeps it running, restarting it if it crashes.">
      <form onSubmit={submit}>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="svc-name">Name</FieldLabel>
            <Input id="svc-name" required autoFocus className="h-10 font-mono" placeholder="shop-api" value={name}
              onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'))} />
          </Field>
          <Field>
            <FieldLabel htmlFor="svc-cwd">Folder</FieldLabel>
            <Input id="svc-cwd" required className="h-10 font-mono" value={cwd} onChange={(e) => setCwd(e.target.value)} />
            <FieldDescription>On the server, in your account. ~ is your home folder.</FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="svc-cmd">Command</FieldLabel>
            <Input id="svc-cmd" required className="h-10 font-mono" placeholder="npm run dev -- --port $PORT --host 127.0.0.1" value={command} onChange={(e) => setCommand(e.target.value)} />
            <FieldDescription>It must listen on <code className="font-mono">$PORT</code>. DevDash picks a free one for it.</FieldDescription>
          </Field>
          <ErrorAlert error={create.error} />
          <Button type="submit" className="h-10" disabled={!name || !command || create.isPending}>Start service</Button>
        </FieldGroup>
      </form>
    </ResponsiveDialog>
  )
}
