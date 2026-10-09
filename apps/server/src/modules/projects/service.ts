import { randomBytes } from 'node:crypto'
import type { Db } from '../../core/db.ts'
import type { Hub } from '../../core/hub.ts'
import { AppError } from '../../core/http.ts'
import type { ActivityService } from '../activity/service.ts'
import type { AgentsService } from '../agents/service.ts'
import type { User } from '../auth/repo.ts'
import type { TasksService } from '../tasks/service.ts'

export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,39}$/
const FETCH_EVERY_MS = 5 * 60_000

type Row = {
  id: number; slug: string; name: string; repo_url: string | null; default_branch: string; created_by: number; created_at: number
  fetched_at: number | null; fetch_error: string | null; archived: number; creator_username: string; creator_name: string
  open_tasks: number; sessions: number; working: number; waiting: number; active_people: string; last_session_at: number | null
}

// Live Claude work counts every session in the project, private ones too, but only as numbers and owners' names:
// people see that someone's Claude is in the shared checkout, never what it is doing.
const SELECT = `select p.*, u.username as creator_username, u.name as creator_name,
  (select count(*) from tasks t where t.project_id = p.id and t.status != 'done') as open_tasks,
  (select count(*) from claude_sessions s where s.project_id = p.id and s.archived = 0) as sessions,
  (select count(*) from claude_sessions s where s.project_id = p.id and s.archived = 0 and s.status = 'working') as working,
  (select count(*) from claude_sessions s where s.project_id = p.id and s.archived = 0 and s.status = 'waiting') as waiting,
  (select json_group_array(distinct o.name) from claude_sessions s join users o on o.id = s.owner_id
    where s.project_id = p.id and s.archived = 0 and s.status in ('working', 'waiting')) as active_people,
  (select max(s.last_activity_at) from claude_sessions s where s.project_id = p.id) as last_session_at
  from projects p join users u on u.id = p.created_by`

export const slugify = (s: string) => s.toLowerCase().replace(/\.git$/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'project'

/**
 * Projects are shared git checkouts in <root>/projects/<slug>. Git always runs as a member (their own credentials),
 * through their agent: cloning as the creator, fetching every few minutes as the creator, worktrees as the session owner.
 * After every fetch the branches are scanned for "fixes #N" (tasks service).
 */
export function projectsService({ db, hub, agents, activity, tasks, gitSafeDir, root }: {
  db: Db; hub: Hub; agents: AgentsService; activity: ActivityService; tasks: TasksService
  gitSafeDir: (path: string) => Promise<void>; root: string
}) {
  const q = {
    all: db.prepare(`${SELECT} where p.archived = ? order by p.name`),
    bySlug: db.prepare(`${SELECT} where p.slug = ?`),
    byId: db.prepare(`${SELECT} where p.id = ?`),
    insert: db.prepare('insert into projects (slug, name, repo_url, default_branch, created_by) values (?, ?, ?, ?, ?) returning id'),
    patch: db.prepare('update projects set name = ?, archived = ? where id = ?'),
    fetched: db.prepare('update projects set fetched_at = unixepoch(), fetch_error = ?, default_branch = coalesce(?, default_branch) where id = ?'),
    refs: db.prepare('select ref, sha from project_refs where project_id = ?'),
    putRef: db.prepare('insert into project_refs (project_id, ref, sha) values (?, ?, ?) on conflict(project_id, ref) do update set sha = excluded.sha'),
    dropRef: db.prepare('delete from project_refs where project_id = ? and ref = ?'),
    admins: db.prepare("select username from users where role = 'admin' and disabled_at is null"),
  }
  const path = (slug: string) => `${root}/projects/${slug}`
  const changed = () => hub.publish('projects', { type: 'changed' })
  const dto = (p: Row) => ({
    slug: p.slug, name: p.name, repoUrl: p.repo_url, defaultBranch: p.default_branch, path: path(p.slug), createdAt: p.created_at,
    fetchedAt: p.fetched_at, fetchError: p.fetch_error, archived: p.archived === 1, openTasks: p.open_tasks, sessions: p.sessions,
    live: { working: p.working, waiting: p.waiting, people: JSON.parse(p.active_people || '[]') as string[] }, lastSessionAt: p.last_session_at,
    creator: { username: p.creator_username, name: p.creator_name },
  })
  function find(slug: string) {
    const p = q.bySlug.get(slug) as Row | undefined
    if (!p) throw new AppError(404, 'not_found', `There is no project ${slug}.`)
    return p
  }

  /** Git as the creator; if their agent can't, as an admin (e.g. the creator left). */
  async function asMember<T>(p: Row, msg: object, timeoutMs?: number): Promise<T> {
    try {
      return await agents.request<T>(p.creator_username, msg, timeoutMs)
    } catch (err) {
      const admin = (q.admins.all() as { username: string }[]).find((a) => a.username !== p.creator_username)
      if (!admin || !(err instanceof AppError && err.code === 'agent_unavailable')) throw err
      return agents.request<T>(admin.username, msg, timeoutMs)
    }
  }

  const baseRef = (p: Row, refs: Record<string, string>) =>
    refs[`refs/remotes/origin/${p.default_branch}`] ? `refs/remotes/origin/${p.default_branch}` : `refs/heads/${p.default_branch}`

  // Reads commits that are new since the last scan, per branch. The first scan only records where branches are.
  const scanning = new Set<number>()
  async function scan(p: Row) {
    if (scanning.has(p.id)) return
    scanning.add(p.id)
    try {
      const { refs } = await asMember<{ refs: Record<string, string> }>(p, { op: 'git.refs', path: path(p.slug) })
      const known = new Map((q.refs.all(p.id) as { ref: string; sha: string }[]).map((r) => [r.ref, r.sha]))
      const baseline = known.size === 0
      const base = baseRef(p, refs)
      for (const [ref, sha] of Object.entries(refs)) {
        const old = known.get(ref)
        if (old === sha) continue
        if (!baseline) {
          const onDefault = ref === `refs/heads/${p.default_branch}` || ref === `refs/remotes/origin/${p.default_branch}`
          // A branch seen for the first time: only its commits that aren't on the default branch.
          const range = old ? `${old}..${sha}` : onDefault ? sha : `${refs[base] ?? base}..${sha}`
          const { commits } = await asMember<{ commits: { sha: string; email: string; subject: string; body: string }[] }>(
            p, { op: 'git.log', path: path(p.slug), range, max: 200 }).catch(() => ({ commits: [] }))
          tasks.fromCommits({ id: p.id, slug: p.slug }, commits, { onDefault, branch: ref.replace(/^refs\/(heads|remotes)\//, '') })
        }
        q.putRef.run(p.id, ref, sha)
      }
      for (const ref of known.keys()) if (!(ref in refs)) q.dropRef.run(p.id, ref)
    } finally {
      scanning.delete(p.id)
    }
  }

  async function fetchOne(p: Row) {
    try {
      const r = await asMember<{ fetched: boolean; defaultBranch?: string | null }>(p, { op: 'git.fetch', path: path(p.slug) }, 6 * 60_000)
      q.fetched.run(null, r.defaultBranch ?? null, p.id)
    } catch (err) {
      q.fetched.run((err as Error).message.slice(0, 500), null, p.id)
    }
    await scan(q.byId.get(p.id) as Row).catch((err) => console.error(`scan ${p.slug}:`, (err as Error).message))
    changed()
  }

  let fetching = false
  async function fetchAll() {
    if (fetching) return
    fetching = true
    try {
      for (const p of q.all.all(0) as Row[]) if (p.repo_url) await fetchOne(p)
    } finally {
      fetching = false
    }
  }
  setInterval(() => void fetchAll(), FETCH_EVERY_MS).unref()

  return {
    path,
    list: (archived = false) => (q.all.all(archived ? 1 : 0) as Row[]).map(dto),
    get: (slug: string) => dto(find(slug)),
    idOf: (slug: string) => find(slug).id,
    bySlug: (slug: string) => find(slug),
    /** The project a folder belongs to (a checkout or one of its worktrees), if any. */
    forPath(cwd: string) {
      const m = cwd.match(new RegExp(`^${root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/(?:projects|worktrees)/([a-z0-9][a-z0-9-]{0,39})(?:/|$)`))
      return m ? ((q.bySlug.get(m[1]!) as Row | undefined) ?? null) : null
    },

    async create(user: User, input: { name: string; slug?: string; repoUrl?: string }) {
      const repoUrl = input.repoUrl?.trim() || null
      const name = input.name.trim() || (repoUrl ? repoUrl.split('/').pop()!.replace(/\.git$/, '') : '')
      if (!name) throw new AppError(400, 'bad_name', 'Give the project a name.')
      const slug = input.slug?.trim() || slugify(name)
      if (!SLUG_RE.test(slug)) throw new AppError(400, 'bad_slug', 'The short name uses lowercase letters, digits and dashes (up to 40).')
      if (q.bySlug.get(slug)) throw new AppError(409, 'taken', `A project called ${slug} already exists.`)
      const r = await agents.request<{ defaultBranch: string }>(user.username,
        repoUrl ? { op: 'git.clone', path: path(slug), url: repoUrl } : { op: 'git.init', path: path(slug) }, 16 * 60_000)
      await gitSafeDir(path(slug))
      const { id } = q.insert.get(slug, name, repoUrl, r.defaultBranch || 'main', user.id) as { id: number }
      const p = q.byId.get(id) as Row
      await scan(p).catch(() => {})
      q.fetched.run(null, null, id)
      activity.record({ projectId: id, userId: user.id, kind: 'project.created', summary: `added project ${name}`, url: `/projects/${slug}` })
      changed()
      return dto(q.byId.get(id) as Row)
    },

    update(user: User, slug: string, patch: { name?: string; archived?: boolean }) {
      const p = find(slug)
      if (patch.archived !== undefined && user.role !== 'admin' && user.id !== p.created_by) {
        throw new AppError(403, 'forbidden', 'Only the person who added it or an admin can archive a project.')
      }
      q.patch.run(patch.name?.trim() || p.name, patch.archived === undefined ? p.archived : patch.archived ? 1 : 0, p.id)
      changed()
      return dto(find(slug))
    },

    async fetch(slug: string) {
      await fetchOne(find(slug))
      return dto(find(slug))
    },

    /** Rescan for new local commits (e.g. after a Claude session in the project went quiet). */
    rescan: (projectId: number) => {
      const p = q.byId.get(projectId) as Row | undefined
      if (p) void scan(p).catch((err) => console.error(`scan ${p.slug}:`, (err as Error).message))
    },

    async commits(slug: string, max = 30) {
      const p = find(slug)
      const { refs } = await asMember<{ refs: Record<string, string> }>(p, { op: 'git.refs', path: path(slug) })
      const ref = baseRef(p, refs)
      if (!refs[ref]) return []
      return (await asMember<{ commits: { sha: string; author: string; email: string; at: number; subject: string }[] }>(
        p, { op: 'git.log', path: path(slug), range: ref.replace(/^refs\/(heads|remotes)\//, ''), max })).commits
        .map(({ sha, author, at, subject }) => ({ sha, author, at, subject }))
    },

    /** A fresh checkout on its own branch for one Claude session, made as the session's owner. */
    async worktree(user: User, slug: string) {
      const p = find(slug)
      const id = randomBytes(4).toString('hex')
      const { refs } = await asMember<{ refs: Record<string, string> }>(p, { op: 'git.refs', path: path(slug) })
      const base = baseRef(p, refs).replace(/^refs\/(heads|remotes)\//, '')
      const wt = `${root}/worktrees/${slug}/${id}`
      await agents.request(user.username, { op: 'git.worktree.add', path: path(slug), worktree: wt, branch: `dd/${id}`, base })
      await gitSafeDir(wt)
      return { path: wt, branch: `dd/${id}` }
    },

    async removeWorktree(username: string, slug: string, wt: string) {
      return (await agents.request<{ removed: boolean }>(username, { op: 'git.worktree.remove', path: path(slug), worktree: wt })).removed
    },

    start: () => setTimeout(() => void fetchAll(), 20_000).unref(),
  }
}

export type ProjectsService = ReturnType<typeof projectsService>
