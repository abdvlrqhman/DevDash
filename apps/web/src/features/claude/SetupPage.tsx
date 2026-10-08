import { useEffect, useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { LogIn, Plus } from 'lucide-react'
import { toast } from 'sonner'
import { StatusLight } from '@/components/app/brand'
import { PageBody, PageHeader, SettingsSection } from '@/components/app/page'
import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle } from '@/components/ui/item'
import { Skeleton } from '@/components/ui/skeleton'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { api, unwrap } from '@/lib/api'
import { ErrorAlert } from '../auth/LoginPage'
import { FALLBACK_MODELS, PERMISSION_MODES, profilesQuery, type PermissionMode } from './data'

type Profile = { name: string; loggedIn: boolean; authMethod: string | null; email: string | null; plan: string | null }
type Defaults = { profile: string; model: string | null; effort: string | null; permission_mode: string; open_in: 'chat' | 'cli' }

export function SetupPage() {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const q = useQuery(profilesQuery)
  const profiles = (q.data?.profiles as Profile[] | undefined) ?? []
  const [name, setName] = useState('')
  const create = useMutation({
    mutationFn: () => unwrap(api.api.claude.profiles.$post({ json: { name } })),
    onSuccess: () => {
      toast.success(`Profile ${name} added`)
      setName('')
      void qc.invalidateQueries({ queryKey: profilesQuery.queryKey })
    },
  })
  const login = (p: string) => navigate({ to: '/terminal', search: { open: `login-${p}` } })

  return (
    <>
      <PageHeader title="Claude setup" back="/claude" />
      <PageBody>
        <SettingsSection title="Profiles" description={<>
              A profile is its own Claude configuration: settings, skills, agents, plugins, memory and sign-in. The same Claude account can sign in to any number of profiles.
        </>}>
            <ErrorAlert error={q.error} />
            {q.isPending ? <Skeleton className="h-16" /> : (
              <ItemGroup className="rounded-lg border">
                {profiles.map((p) => (
                  <Item key={p.name} className="rounded-none border-0 border-b last:border-b-0">
                    <ItemMedia><StatusLight state={p.loggedIn ? 'live' : 'idle'} /></ItemMedia>
                    <ItemContent>
                      <ItemTitle>{p.name === 'default' ? 'Default' : p.name}</ItemTitle>
                      <ItemDescription>
                        {p.loggedIn ? [p.email, p.plan, p.authMethod === 'apiKey' ? 'API key' : null].filter(Boolean).join(', ') || 'Signed in' : 'Not signed in'}
                      </ItemDescription>
                    </ItemContent>
                    <ItemActions>
                      <Button size="sm" variant={p.loggedIn ? 'outline' : 'default'} onClick={() => login(p.name)}><LogIn />{p.loggedIn ? 'Sign in again' : 'Sign in'}</Button>
                    </ItemActions>
                  </Item>
                ))}
              </ItemGroup>
            )}
            <form onSubmit={(e: FormEvent) => { e.preventDefault(); if (name) create.mutate() }} className="flex items-end gap-2">
              <Field className="flex-1">
                <FieldLabel htmlFor="new-profile">New profile</FieldLabel>
                <Input id="new-profile" placeholder="work" value={name} maxLength={21} className="h-9"
                  onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))} />
              </Field>
              <Button type="submit" variant="outline" disabled={!name || create.isPending}><Plus />Add</Button>
            </form>
            <ErrorAlert error={create.error} />
            <p className="text-sm text-muted-foreground">
              Signing in opens a terminal running Claude's own sign-in. Open the link it prints, approve, then paste the code back. DevDash never sees your Claude credentials.
            </p>
        </SettingsSection>
        {q.data && <DefaultsCard profiles={profiles} initial={q.data.defaults} />}
      </PageBody>
    </>
  )
}

function DefaultsCard({ profiles, initial }: { profiles: Profile[]; initial: Defaults }) {
  const qc = useQueryClient()
  const [d, setD] = useState(initial)
  useEffect(() => setD(initial), [initial])
  const save = useMutation({
    mutationFn: (next: Defaults) => unwrap(api.api.claude.defaults.$put({ json: { ...next, effort: null, permission_mode: next.permission_mode as PermissionMode } })),
    onSuccess: () => {
      toast.success('Defaults saved')
      void qc.invalidateQueries({ queryKey: profilesQuery.queryKey })
    },
  })
  const set = (patch: Partial<Defaults>) => {
    const next = { ...d, ...patch }
    setD(next)
    save.mutate(next)
  }
  const Row = ({ id, label, value, options, onPick, description }: { id: string; label: string; value: string; options: { value: string; label: string }[]; onPick: (v: string) => void; description?: string }) => (
    <Field>
      <FieldLabel id={id}>{label}</FieldLabel>
      <ToggleGroup type="single" variant="outline" aria-labelledby={id} value={value} onValueChange={(v) => v !== undefined && onPick(v)} className="w-full flex-wrap">
        {options.map((o) => <ToggleGroupItem key={o.value || 'default'} value={o.value} className="flex-1">{o.label}</ToggleGroupItem>)}
      </ToggleGroup>
      {description && <FieldDescription>{description}</FieldDescription>}
    </Field>
  )
  return (
    <SettingsSection title="Defaults for new sessions" description="You can change any of these per session.">
        <FieldGroup>
          {profiles.length > 1 && <Row id="d-profile" label="Profile" value={d.profile} onPick={(v) => set({ profile: v })} options={profiles.map((p) => ({ value: p.name, label: p.name }))} />}
          <Row id="d-model" label="Model" value={d.model ?? ''} onPick={(v) => set({ model: v || null })} options={FALLBACK_MODELS.map((m) => ({ value: m.value, label: m.displayName }))} />
          <Row id="d-perm" label="Permissions" value={d.permission_mode} onPick={(v) => set({ permission_mode: v })}
            options={PERMISSION_MODES.map((p) => ({ value: p.value, label: p.label }))} description={PERMISSION_MODES.find((p) => p.value === d.permission_mode)?.hint} />
          <Row id="d-open" label="Open sessions in" value={d.open_in} onPick={(v) => set({ open_in: v as 'chat' | 'cli' })} options={[{ value: 'chat', label: 'Chat' }, { value: 'cli', label: 'CLI' }]} />
          <ErrorAlert error={save.error} />
        </FieldGroup>
    </SettingsSection>
  )
}
