import { useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { FolderGit2, GitBranch, Plus, TriangleAlert } from 'lucide-react'
import { PageBody, PageHeader } from '@/components/app/page'
import { ResponsiveDialog } from '@/components/app/responsive-dialog'
import { Button } from '@/components/ui/button'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle } from '@/components/ui/item'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { api, unwrap } from '@/lib/api'
import { ErrorAlert } from '../auth/LoginPage'
import { projectsQuery, useLiveWork } from '../work/data'
import { GitHubConnection } from '../work/GitHub'

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
                    <ItemDescription className="text-xs tabular-nums sm:hidden">{p.openTasks} open {p.openTasks === 1 ? 'task' : 'tasks'}</ItemDescription>
                  </ItemContent>
                  <ItemActions className="hidden text-xs text-muted-foreground tabular-nums sm:flex">
                    {p.openTasks} open {p.openTasks === 1 ? 'task' : 'tasks'}
                  </ItemActions>
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

const slugify = (s: string) => s.toLowerCase().replace(/\.git$/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)

function NewProject({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [repoUrl, setRepoUrl] = useState('')
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [slugTouched, setSlugTouched] = useState(false)
  const guess = name || repoUrl.split('/').pop()?.replace(/\.git$/, '') || ''
  const effectiveSlug = slugTouched ? slug : slugify(guess)
  const create = useMutation({
    mutationFn: () => unwrap(api.api.projects.$post({ json: { name: name || guess, slug: effectiveSlug, repoUrl: repoUrl.trim() || undefined } })),
    onSuccess: ({ project }) => {
      void qc.invalidateQueries({ queryKey: ['projects'] })
      close(false)
      void navigate({ to: '/projects/$slug', params: { slug: project.slug } })
    },
  })
  const close = (v: boolean) => {
    if (v) return
    onClose()
    setRepoUrl(''); setName(''); setSlug(''); setSlugTouched(false); create.reset()
  }
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (effectiveSlug && !create.isPending) create.mutate()
  }
  return (
    <ResponsiveDialog open={open} onOpenChange={close} title="Add a project" description="One shared checkout on the server that the whole team and their Claude sessions work in.">
      <form onSubmit={submit}>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="np-repo">Repository</FieldLabel>
            <Input id="np-repo" className="h-10 font-mono" placeholder="https://github.com/you/app.git" value={repoUrl} onChange={(e) => setRepoUrl(e.target.value)}
              spellCheck={false} autoCapitalize="none" autoFocus />
            <FieldDescription>Leave empty to start a new repository here. DevDash clones as you, with your GitHub account.</FieldDescription>
          </Field>
          {/github\.com/.test(repoUrl) && <GitHubConnection compact />}
          <Field>
            <FieldLabel htmlFor="np-name">Name</FieldLabel>
            <Input id="np-name" className="h-10" placeholder={guess || 'Shop app'} value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field>
            <FieldLabel htmlFor="np-slug">Short name</FieldLabel>
            <Input id="np-slug" className="h-10 font-mono" value={effectiveSlug} onChange={(e) => { setSlugTouched(true); setSlug(slugify(e.target.value)) }} />
            <FieldDescription>The folder name and the prefix of its tasks, like <span className="font-mono">{effectiveSlug || 'app'}#12</span>.</FieldDescription>
          </Field>
          <ErrorAlert error={create.error} />
          <Button type="submit" className="h-10" disabled={!effectiveSlug || create.isPending}>
            {create.isPending && <Spinner />}{create.isPending ? (repoUrl ? 'Cloning…' : 'Creating…') : 'Add project'}
          </Button>
        </FieldGroup>
      </form>
    </ResponsiveDialog>
  )
}
