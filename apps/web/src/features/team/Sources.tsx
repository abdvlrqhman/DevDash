import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Database, FileText, Globe, Plug, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { NativeSelect } from '@/components/app/native-select'
import { ResponsiveDialog } from '@/components/app/responsive-dialog'
import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { api, unwrap } from '@/lib/api'
import { ErrorAlert } from '../auth/LoginPage'
import type { Team } from './data'

type Kind = 'postgres' | 'sqlite' | 'http' | 'page'
const KINDS: Record<Kind, { label: string; hint: string; icon: typeof Database }> = {
  postgres: { label: 'Postgres database', hint: 'Roles run read-only queries. Use a database user that can only read what roles should see.', icon: Database },
  sqlite: { label: 'SQLite file', hint: 'A database file on this server, opened read-only as the member the team runs as.', icon: FileText },
  http: { label: 'API', hint: 'Roles read anything under the base URL (analytics, YouTube, store data). The key is added for them and never shown.', icon: Plug },
  page: { label: 'Web page', hint: 'A public page to watch: a competitor, your store listing, a pricing page.', icon: Globe },
}

/** Read-only data the roles can look at: their numbers come from here. */
export function Sources({ slug, sources }: { slug: string; sources: Team['sources'] }) {
  const qc = useQueryClient()
  const [adding, setAdding] = useState(false)
  const [preview, setPreview] = useState<{ name: string; text: string } | null>(null)
  const test = useMutation({
    mutationFn: (id: number) => unwrap(api.api.team.sources[':id'].test.$post({ param: { id: String(id) } })),
    onSuccess: (r, id) => setPreview({ name: sources.find((s) => s.id === id)?.name ?? '', text: r.preview }),
    onError: (e) => toast.error(e.message),
  })
  const remove = useMutation({
    mutationFn: (id: number) => unwrap(api.api.team.sources[':id'].$delete({ param: { id: String(id) } })),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['team'] }),
  })
  return (
    <section className="flex flex-col gap-3">
      <div className="flex min-h-8 items-end justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">Data sources</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">Read-only. Roles get the data; keys stay on the server.</p>
        </div>
        <Button size="sm" variant="ghost" onClick={() => setAdding(true)}><Plus />Add</Button>
      </div>
      {sources.length > 0 ? (
        <ul className="flex flex-col divide-y rounded-xl border">
          {sources.map((s) => {
            const K = KINDS[s.kind as Kind]
            return (
              <li key={s.id} className="flex items-center gap-3 px-3.5 py-2.5 text-sm">
                <K.icon className="size-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{s.name}</div>
                  <div className="truncate text-xs text-muted-foreground">{s.description || K.label}</div>
                </div>
                <Button size="sm" variant="ghost" disabled={test.isPending} onClick={() => test.mutate(s.id)}>{test.isPending && test.variables === s.id ? <Spinner /> : 'Test'}</Button>
                <Button size="icon" variant="ghost" className="size-7" aria-label={`Remove ${s.name}`}
                  onClick={() => { if (confirm(`Remove ${s.name}? Roles stop seeing it.`)) remove.mutate(s.id) }}><Trash2 /></Button>
              </li>
            )
          })}
        </ul>
      ) : <p className="text-sm text-muted-foreground">None yet. Connect the app's database, an analytics or YouTube API, or pages to watch, so roles work from real numbers.</p>}
      <AddSource open={adding} onOpenChange={setAdding} slug={slug} />
      <ResponsiveDialog open={!!preview} onOpenChange={(v) => !v && setPreview(null)} title={`What roles see in ${preview?.name ?? ''}`} description="The start of a first look, as a role would read it.">
        <pre className="max-h-[50vh] overflow-auto rounded-lg bg-muted/40 p-3 font-mono text-xs whitespace-pre-wrap">{preview?.text}</pre>
      </ResponsiveDialog>
    </section>
  )
}

function AddSource({ open, onOpenChange, slug }: { open: boolean; onOpenChange: (v: boolean) => void; slug: string }) {
  const qc = useQueryClient()
  const [kind, setKind] = useState<Kind>('postgres')
  const [f, setF] = useState({ name: '', description: '', secret: '', path: '', baseUrl: '', secretName: '', secretIn: 'header' as 'header' | 'query', url: '' })
  const set = (patch: Partial<typeof f>) => setF((x) => ({ ...x, ...patch }))
  const add = useMutation({
    mutationFn: () => unwrap(api.api.team.projects[':slug'].sources.$post({
      param: { slug },
      json: {
        name: f.name, kind, description: f.description, secret: f.secret || null,
        config: kind === 'sqlite' ? { path: f.path } : kind === 'page' ? { url: f.url } : kind === 'http' ? { baseUrl: f.baseUrl, secretName: f.secretName || undefined, secretIn: f.secretIn } : {},
      },
    })),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['team'] })
      onOpenChange(false)
      setF({ name: '', description: '', secret: '', path: '', baseUrl: '', secretName: '', secretIn: 'header', url: '' })
    },
  })
  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange} title="Add a data source" description={KINDS[kind].hint}>
      <form className="pb-2" onSubmit={(e) => { e.preventDefault(); if (f.name.trim()) add.mutate() }}>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="src-kind">Kind</FieldLabel>
            <NativeSelect id="src-kind" value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
              {(Object.keys(KINDS) as Kind[]).map((k) => <option key={k} value={k}>{KINDS[k].label}</option>)}
            </NativeSelect>
          </Field>
          <Field>
            <FieldLabel htmlFor="src-name">Name</FieldLabel>
            <Input id="src-name" className="h-10" value={f.name} maxLength={60} onChange={(e) => set({ name: e.target.value })}
              placeholder={kind === 'http' ? 'YouTube' : kind === 'page' ? 'Competitor pricing' : 'App database'} />
          </Field>
          <Field>
            <FieldLabel htmlFor="src-desc">What's in it</FieldLabel>
            <Input id="src-desc" className="h-10" value={f.description} maxLength={500} onChange={(e) => set({ description: e.target.value })}
              placeholder={kind === 'http' ? 'Our channel: views, likes, subscribers' : 'Sign-ups, shops, orders (no personal data)'} />
            <FieldDescription>Roles read this to know when to look here.</FieldDescription>
          </Field>
          {kind === 'postgres' && (
            <Field>
              <FieldLabel htmlFor="src-secret">Connection string</FieldLabel>
              <Input id="src-secret" className="h-10 font-mono" type="password" autoComplete="off" value={f.secret} onChange={(e) => set({ secret: e.target.value })} placeholder="postgres://reader:…@host:5432/app" />
              <FieldDescription>Stored encrypted. Every query runs in a read-only transaction, 15 seconds at most.</FieldDescription>
            </Field>
          )}
          {kind === 'sqlite' && (
            <Field>
              <FieldLabel htmlFor="src-path">File on the server</FieldLabel>
              <Input id="src-path" className="h-10 font-mono" value={f.path} onChange={(e) => set({ path: e.target.value })} placeholder="/srv/devdash/projects/app/data/app.db" />
            </Field>
          )}
          {kind === 'http' && (
            <>
              <Field>
                <FieldLabel htmlFor="src-base">Base URL</FieldLabel>
                <Input id="src-base" className="h-10 font-mono" value={f.baseUrl} onChange={(e) => set({ baseUrl: e.target.value })} placeholder="https://www.googleapis.com/youtube/v3/" />
                <FieldDescription>Roles can only read under this address.</FieldDescription>
              </Field>
              <div className="grid gap-3 sm:grid-cols-[8rem_1fr]">
                <Field>
                  <FieldLabel htmlFor="src-in">Key goes in</FieldLabel>
                  <NativeSelect id="src-in" value={f.secretIn} onChange={(e) => set({ secretIn: e.target.value as 'header' | 'query' })}>
                    <option value="header">a header</option>
                    <option value="query">the URL</option>
                  </NativeSelect>
                </Field>
                <Field>
                  <FieldLabel htmlFor="src-sname">{f.secretIn === 'header' ? 'Header name' : 'Parameter name'}</FieldLabel>
                  <Input id="src-sname" className="h-10 font-mono" value={f.secretName} onChange={(e) => set({ secretName: e.target.value })} placeholder={f.secretIn === 'header' ? 'Authorization' : 'key'} />
                </Field>
              </div>
              <Field>
                <FieldLabel htmlFor="src-key">Key (optional)</FieldLabel>
                <Input id="src-key" className="h-10 font-mono" type="password" autoComplete="off" value={f.secret} onChange={(e) => set({ secret: e.target.value })}
                  placeholder={f.secretIn === 'header' ? 'Bearer …' : 'AIza…'} />
                <FieldDescription>Stored encrypted; roles never see it.</FieldDescription>
              </Field>
            </>
          )}
          {kind === 'page' && (
            <Field>
              <FieldLabel htmlFor="src-url">Page URL</FieldLabel>
              <Input id="src-url" className="h-10 font-mono" value={f.url} onChange={(e) => set({ url: e.target.value })} placeholder="https://play.google.com/store/apps/details?id=…" />
            </Field>
          )}
          <ErrorAlert error={add.error} />
          <Button type="submit" className="h-10" disabled={!f.name.trim() || add.isPending}>Add source</Button>
        </FieldGroup>
      </form>
    </ResponsiveDialog>
  )
}
