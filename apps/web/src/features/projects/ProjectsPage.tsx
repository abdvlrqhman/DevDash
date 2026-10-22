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

const CHUNK = 32 * 1024 * 1024 // zips upload in ≤32 MB pieces (Cloudflare caps a request at 100 MB)
const GB = 1024 ** 3
const MAX_ZIP = 20 * GB // the agent refuses more (apps/agent/src/project.ts)
const gb = (n: number) => `${(n / GB).toFixed(n < 10 * GB ? 1 : 0)} GB`
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Sends one piece, trying again after a network blip or a busy server: a 20 GB upload is hundreds of pieces. */
async function sendPiece(url: string, body: Blob) {
  for (let attempt = 1; ; attempt++) {
    let res: Response | null = null
    try {
      res = await fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/octet-stream' }, body })
    } catch (err) {
      if (attempt >= 5) throw new ApiError(`Upload interrupted: ${(err as Error).message}`, 0, 'upload')
    }
    if (res?.ok) return
    if (res && res.status < 500 && res.status !== 429) {
      const e = (await res.json().catch(() => null)) as { error?: { message?: string } } | null
      throw new ApiError(e?.error?.message ?? `Upload failed (${res.status})`, res.status, 'upload')
    }
    if (attempt >= 5) throw new ApiError(`Upload failed (${res?.status ?? 'network'}). Try again.`, res?.status ?? 0, 'upload')
    await sleep(1000 * 2 ** attempt) // 2, 4, 8, 16 s
  }
}
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
  const [unpacking, setUnpacking] = useState(false)
  const zip = mode === 'zip'
  const guess = name || (zip ? file?.name.replace(/\.zip$/i, '') : repoUrl.split('/').pop()?.replace(/\.git$/, '')) || ''
  const effectiveSlug = slugTouched ? slug : slugify(guess)

  const create = useMutation({
    mutationFn: async () => {
      if (!zip) return unwrap(api.api.projects.$post({ json: { name: name || guess, slug: effectiveSlug, repoUrl: repoUrl.trim() || undefined, instructions: instructions.trim() || undefined } }))
      if (!file) throw new ApiError('Choose a .zip file to upload.', 400, 'no_file')
      if (file.size > MAX_ZIP) throw new ApiError(`That .zip is ${gb(file.size)}; the limit is ${gb(MAX_ZIP)}.`, 400, 'too_big')
      const uploadId = hexId()
      let started = false
      try {
        setProgress(0)
        // Stream the zip to the server in order (the first piece says the whole size, so one that won't fit is refused
        // at once), then start the import (unzip + git init) and wait for it: a big one takes minutes.
        for (let offset = 0; offset === 0 || offset < file.size; offset += CHUNK) {
          const q = new URLSearchParams({ uploadId, offset: String(offset), ...(offset === 0 && { total: String(file.size) }) })
          await sendPiece(`/api/projects/zip?${q}`, file.slice(offset, offset + CHUNK))
          setProgress(file.size ? Math.min(99, ((offset + CHUNK) / file.size) * 100) : 99)
          if (file.size === 0) break
        }
        setProgress(null)
        setUnpacking(true)
        await unwrap(api.api.projects['from-zip'].$post({ json: { name: name || guess, slug: effectiveSlug, uploadId, instructions: instructions.trim() || undefined } }))
        started = true
        for (;;) {
          await sleep(2000)
          const s = await unwrap(api.api.projects.zip.status.$get({ query: { uploadId } })).catch((err: ApiError) => {
            if (err.status === 404) throw err // the server restarted mid-import
            return null // a blip: ask again
          })
          if (s?.state === 'done' && s.project) return { project: s.project }
          if (s?.state === 'failed') throw new ApiError(s.error ?? 'The import failed.', 400, 'import')
        }
      } catch (err) {
        // The server cleans up a started import itself; before that, throw the half-uploaded zip away.
        if (!started) void fetch('/api/projects/zip/abort', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ uploadId }) })
        throw err
      } finally {
        setProgress(null)
        setUnpacking(false)
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
  const label = create.isPending
    ? (zip ? (unpacking ? 'Unpacking…' : progress === null ? 'Finishing…' : `Uploading ${Math.floor(progress)}%${file && file.size > GB ? ` of ${gb(file.size)}` : ''}…`) : repoUrl ? 'Cloning…' : 'Creating…')
    : zip ? 'Create from zip' : 'Add project'
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
              <FieldDescription>Up to {gb(MAX_ZIP)}. Its contents become the project files here. DevDash unpacks it and starts a new git repository as you; a big one takes a few minutes, so keep this open.</FieldDescription>
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
