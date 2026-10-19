import { useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { FileArchive, FolderGit2, GitBranch, Plus, TriangleAlert } from 'lucide-react'
import { StatusLight } from '@/components/app/brand'
import { PageBody, PageHeader } from '@/components/app/page'
import { ResponsiveDialog } from '@/components/app/responsive-dialog'
import { Button } from '@/components/ui/button'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle } from '@/components/ui/item'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { Textarea } from '@/components/ui/textarea'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { ApiError, api, unwrap } from '@/lib/api'
import { ErrorAlert } from '../auth/LoginPage'
import { relativeTime } from '../claude/data'
import { Progress } from '../files/Progress'
import { projectsQuery, useLiveWork } from '../work/data'
import { GitHubConnection } from '../work/GitHub'

type Live = { working: number; waiting: number; people: string[] }
const firstNames = (people: string[]) => people.map((n) => n.split(' ')[0]).join(', ')

/** Whose Claude is working in a project right now, or when Claude last was. Nothing about what it is doing. */
export function LiveWork({ live, lastSessionAt }: { live: Live; lastSessionAt: number | null }) {
  if (live.working + live.waiting > 0) {
    const parts = [live.working && `${live.working} working`, live.waiting && `${live.waiting} waiting for an answer`].filter(Boolean).join(', ')
    return (
      <span className="flex min-w-0 items-center gap-1.5">
        <StatusLight state={live.working ? 'live' : 'waiting'} />
        <span className="truncate">{firstNames(live.people)}: {parts}</span>
      </span>
    )
  }
  return lastSessionAt ? <span className="text-muted-foreground">Claude last active {relativeTime(lastSessionAt)}</span> : null
}

export const repoLabel = (url: string | null) => (url ? url.replace(/^(https:\/\/|git@)/, '').replace(/^github\.com[:/]/, '').replace(/\.git$/, '') : 'Only on this server')

export function ProjectsPage() {
  useLiveWork()
  const list = useQuery(projectsQuery)
  const [adding, setAdding] = useState(false)
  const projects = list.data?.projects ?? []
  return (
    <>
      <PageHeader title="Projects" actions={<Button size="sm" onClick={() => setAdding(true)}><Plus />New</Button>} />
      <PageBody>
        <ErrorAlert error={list.error} />
        {list.isPending && <div className="flex flex-col gap-2">{[0, 1].map((i) => <Skeleton key={i} className="h-16" />)}</div>}
        {list.isSuccess && !projects.length && (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon"><FolderGit2 /></EmptyMedia>
              <EmptyTitle>No projects yet</EmptyTitle>
              <EmptyDescription>Add a repository and everyone gets the same checkout on the server, with tasks, notes and Claude sessions around it.</EmptyDescription>
            </EmptyHeader>
            <EmptyContent><Button onClick={() => setAdding(true)}><Plus />Add a project</Button></EmptyContent>
          </Empty>
        )}
        {projects.length > 0 && (
          <ItemGroup className="rounded-xl border">
            {projects.map((p) => (
              <Item key={p.slug} asChild className="rounded-none border-0 border-b last:border-b-0">
                <Link to="/projects/$slug" params={{ slug: p.slug }}>
                  <ItemMedia variant="icon"><FolderGit2 /></ItemMedia>
                  <ItemContent className="min-w-0">
                    <ItemTitle>{p.name}</ItemTitle>
                    <ItemDescription className="flex items-center gap-1.5 truncate">
                      {p.fetchError && <span className="flex shrink-0 items-center gap-1 font-sans text-destructive" title={p.fetchError}><TriangleAlert className="size-3.5" />Can't fetch</span>}
                      <span className="truncate font-mono">{repoLabel(p.repoUrl)}</span>
                      <span className="flex shrink-0 items-center gap-1"><GitBranch className="size-3.5" />{p.defaultBranch}</span>
                    </ItemDescription>
                    {(p.live.working + p.live.waiting > 0 || p.lastSessionAt) && (
                      <ItemDescription className="text-xs"><LiveWork live={p.live} lastSessionAt={p.lastSessionAt} /></ItemDescription>
                    )}
                    <ItemDescription className="text-xs tabular-nums sm:hidden">{counts(p)}</ItemDescription>
                  </ItemContent>
                  <ItemActions className="hidden text-xs text-muted-foreground tabular-nums sm:flex">{counts(p)}</ItemActions>
                </Link>
              </Item>
            ))}
          </ItemGroup>
        )}
      </PageBody>
      <NewProject open={adding} onClose={() => setAdding(false)} />
    </>
  )
}

const counts = (p: { openTasks: number; sessions: number }) =>
  `${p.openTasks} open ${p.openTasks === 1 ? 'task' : 'tasks'}, ${p.sessions} ${p.sessions === 1 ? 'session' : 'sessions'}`

const slugify = (s: string) => s.toLowerCase().replace(/\.git$/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)

const CHUNK = 8 * 1024 * 1024 // zips upload in ≤8 MB pieces (Cloudflare caps a request at 100 MB)
const hexId = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('')

function NewProject({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [mode, setMode] = useState<'repo' | 'zip'>('repo')
  const [repoUrl, setRepoUrl] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [slugTouched, setSlugTouched] = useState(false)
  const [instructions, setInstructions] = useState('')
  const [progress, setProgress] = useState<number | null>(null) // 0–100 while a zip is uploading
  const zip = mode === 'zip'
  const guess = name || (zip ? file?.name.replace(/\.zip$/i, '') : repoUrl.split('/').pop()?.replace(/\.git$/, '')) || ''
  const effectiveSlug = slugTouched ? slug : slugify(guess)

  const create = useMutation({
    mutationFn: async () => {
      if (!zip) return unwrap(api.api.projects.$post({ json: { name: name || guess, slug: effectiveSlug, repoUrl: repoUrl.trim() || undefined, instructions: instructions.trim() || undefined } }))
      if (!file) throw new ApiError('Choose a .zip file to upload.', 400, 'no_file')
      const uploadId = hexId()
      try {
        setProgress(0)
        // Stream the zip to the server in order, then finalize (unzip + git init) in one atomic step.
        for (let offset = 0; offset === 0 || offset < file.size; offset += CHUNK) {
          const res = await fetch(`/api/projects/zip?${new URLSearchParams({ uploadId, offset: String(offset) })}`, {
            method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/octet-stream' }, body: file.slice(offset, offset + CHUNK),
          })
          if (!res.ok) {
            const e = (await res.json().catch(() => null)) as { error?: { message?: string } } | null
            throw new ApiError(e?.error?.message ?? `Upload failed (${res.status})`, res.status, 'upload')
          }
          setProgress(file.size ? Math.min(99, ((offset + CHUNK) / file.size) * 100) : 99)
          if (file.size === 0) break
        }
        return await unwrap(api.api.projects['from-zip'].$post({ json: { name: name || guess, slug: effectiveSlug, uploadId, instructions: instructions.trim() || undefined } }))
      } catch (err) {
        void fetch('/api/projects/zip/abort', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ uploadId }) })
        throw err
      } finally {
        setProgress(null)
      }
    },
    onSuccess: ({ project }) => {
      void qc.invalidateQueries({ queryKey: ['projects'] })
      close(false)
      void navigate({ to: '/projects/$slug', params: { slug: project.slug } })
    },
  })
  const close = (v: boolean) => {
    if (v || create.isPending) return
    onClose()
    setMode('repo'); setRepoUrl(''); setFile(null); setName(''); setSlug(''); setSlugTouched(false); setInstructions(''); create.reset()
  }
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (effectiveSlug && (!zip || file) && !create.isPending) create.mutate()
  }
  const label = create.isPending ? (zip ? (progress === null ? 'Finishing…' : 'Uploading…') : repoUrl ? 'Cloning…' : 'Creating…') : zip ? 'Create from zip' : 'Add project'
  return (
    <ResponsiveDialog open={open} onOpenChange={close} title="Add a project" description="One shared checkout on the server that the whole team and their Claude sessions work in.">
      <form onSubmit={submit}>
        <FieldGroup>
          <ToggleGroup type="single" variant="outline" value={mode} className="w-full" onValueChange={(v) => v && setMode(v as 'repo' | 'zip')}>
            <ToggleGroupItem value="repo" className="h-9 flex-1"><FolderGit2 />From GitHub repo</ToggleGroupItem>
            <ToggleGroupItem value="zip" className="h-9 flex-1"><FileArchive />Upload a .zip</ToggleGroupItem>
          </ToggleGroup>
          {zip ? (
            <Field>
              <FieldLabel htmlFor="np-zip">Zip file</FieldLabel>
              <Input id="np-zip" type="file" accept=".zip,application/zip" className="h-10 py-2" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
              <FieldDescription>Its contents become the project files here. DevDash unpacks it and starts a new git repository as you.</FieldDescription>
            </Field>
          ) : (
            <>
              <Field>
                <FieldLabel htmlFor="np-repo">Repository</FieldLabel>
                <Input id="np-repo" className="h-10 font-mono" placeholder="https://github.com/you/app.git" value={repoUrl} onChange={(e) => setRepoUrl(e.target.value)}
                  spellCheck={false} autoCapitalize="none" autoFocus />
                <FieldDescription>Leave empty to start a new repository here. DevDash clones as you, with your GitHub account.</FieldDescription>
              </Field>
              {/github\.com/.test(repoUrl) && <GitHubConnection compact />}
            </>
          )}
          <Field>
            <FieldLabel htmlFor="np-name">Name</FieldLabel>
            <Input id="np-name" className="h-10" placeholder={guess || 'Shop app'} value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field>
            <FieldLabel htmlFor="np-slug">Short name</FieldLabel>
            <Input id="np-slug" className="h-10 font-mono" value={effectiveSlug} onChange={(e) => { setSlugTouched(true); setSlug(slugify(e.target.value)) }} />
            <FieldDescription>The folder name and the prefix of its tasks, like <span className="font-mono">{effectiveSlug || 'app'}#12</span>.</FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="np-instructions">Instructions <span className="font-normal text-muted-foreground">(optional)</span></FieldLabel>
            <Textarea id="np-instructions" rows={4} className="min-h-24 text-sm" placeholder={'e.g. You are a gold analyst. Follow these rules…\nAnswer in this format…'} value={instructions} onChange={(e) => setInstructions(e.target.value)} />
            <FieldDescription>Rules every Claude session in this project follows — set once, like a Claude Project's instructions. You can change them later on the project page.</FieldDescription>
          </Field>
          {progress !== null && <Progress value={progress} />}
          <ErrorAlert error={create.error} />
          <Button type="submit" className="h-10" disabled={!effectiveSlug || (zip && !file) || create.isPending}>
            {create.isPending && <Spinner />}{label}
          </Button>
        </FieldGroup>
      </form>
    </ResponsiveDialog>
  )
}
