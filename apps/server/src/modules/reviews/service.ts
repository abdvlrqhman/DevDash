// "Ready to review": an approved code proposal's session finishes with commits on its branch, and the founder ships it
// in one tap — a PR (CI runs the tests) for GitHub projects, a local merge otherwise. The team module owns detection
// (it has the proposal context) and calls record(); this module owns the data, the agent git/gh ops and the endpoints.
import type { Db } from '../../core/db.ts'
import type { Hub } from '../../core/hub.ts'
import { AppError } from '../../core/http.ts'
import type { AgentsService } from '../agents/service.ts'
import type { User } from '../auth/repo.ts'
import type { SessionRow } from '../claude/repo.ts'
import type { NotificationKind } from '../notifications/service.ts'
import type { ProjectsService } from '../projects/service.ts'
import { reviewsRepo, type DeliveryRow, type Stats } from './repo.ts'

type Notify = (userId: number, kind: NotificationKind, n: { title: string; body?: string; url?: string; tag?: string }) => Promise<void>

/** The worktree branch a DevDash session works on (projects/service.ts worktree(): dd/<hex>). */
const branchOf = (worktree: string) => `dd/${worktree.split('/').pop()}`
const isGithub = (repoUrl: string | null) => !!repoUrl && /github\.com/.test(repoUrl)

export function reviewsService({ db, hub, agents, projects, notify }: {
  db: Db; hub: Hub; agents: AgentsService; projects: ProjectsService; notify: Notify
}) {
  const repo = reviewsRepo(db)
  const changed = () => hub.publish('projects', { type: 'changed' })

  const dto = (d: DeliveryRow) => ({
    id: d.id, role: d.role, title: d.title, branch: d.branch, baseBranch: d.base_branch,
    commits: d.commits, files: d.files, insertions: d.insertions, deletions: d.deletions,
    status: d.status, prUrl: d.pr_url, sessionId: d.session_id, createdAt: d.created_at, updatedAt: d.updated_at,
  })

  /** The delivery, confirmed to be in `slug`'s project (member/owner routes gate who may call). */
  function find(slug: string, id: number) {
    const p = projects.bySlug(slug)
    const d = repo.byId(id)
    if (!d || d.project_id !== p.id) throw new AppError(404, 'not_found', 'That delivery no longer exists.')
    return { p, d }
  }

  return {
    /**
     * A proposal session went quiet: if its branch has commits, surface it as a delivery and tell the founder once.
     * More commits later update the stats without re-notifying, unless it had been shipped/dismissed and new work landed.
     */
    async record(s: SessionRow) {
      if (s.origin_kind !== 'proposal' || !s.worktree || s.archived || !s.project_id || !s.project_slug) return
      let p
      try {
        p = projects.bySlug(s.project_slug)
      } catch {
        return // the project was removed
      }
      const branch = branchOf(s.worktree)
      let stat: Stats
      try {
        stat = await agents.request<Stats>(s.owner_username, { op: 'git.branchStat', path: projects.path(p.slug), base: p.default_branch, branch }, 30_000)
      } catch (err) {
        return void console.error('delivery branchStat:', (err as Error).message) // agent down, worktree gone: try again next turn
      }
      if (stat.commits < 1) return // nothing committed yet — not a delivery
      const role = s.origin_role ?? 'A role'
      const title = s.title.replace(/^[^:]+:\s*/, '').trim() || s.title // sessions are titled "Role: Proposal"
      const existing = repo.bySession(s.id)
      if (!existing) {
        const id = repo.insert({ projectId: p.id, sessionId: s.id, role, title, branch, baseBranch: p.default_branch, ...stat })
        tell(s.owner_id, id, role, title, stat.commits, branch, p.slug)
        return void changed()
      }
      repo.updateStats(existing.id, stat)
      if (existing.status === 'merged' || existing.status === 'dismissed') {
        repo.setStatus(existing.id, 'ready')
        tell(s.owner_id, existing.id, role, title, stat.commits, branch, p.slug)
      }
      changed()
    },

    /** Non-dismissed deliveries (plus recently merged), and the count still waiting — for the card and its badge. */
    list(slug: string) {
      const p = projects.bySlug(slug)
      return { deliveries: repo.list(p.id).map(dto), readyCount: repo.readyCount(p.id) }
    },
    readyCount: (slug: string) => repo.readyCount(projects.bySlug(slug).id),

    /** View changes: the branch's whole diff (capped, with a truncation note), fetched as the member asking. */
    async diff(user: User, slug: string, id: number) {
      const { p, d } = find(slug, id)
      return agents.request<{ diff: string; truncated: boolean }>(user.username,
        { op: 'git.branchDiff', path: projects.path(p.slug), base: d.base_branch, branch: d.branch }, 30_000)
    },

    /** Open a PR (GitHub only): push the branch and open the PR as the member, then remember its URL. */
    async openPr(user: User, slug: string, id: number) {
      const { p, d } = find(slug, id)
      if (!isGithub(p.repo_url)) throw new AppError(409, 'not_github', 'This project has no GitHub remote. Merge the branch instead.')
      if (d.status === 'merged') throw new AppError(409, 'merged', 'This has already been merged.')
      const body = `Work by the ${d.role} role on the DevDash team (approved code proposal).\n\nBranch \`${d.branch}\` → \`${d.base_branch}\`.`
      const { url } = await agents.request<{ url: string }>(user.username,
        { op: 'gh.pr', path: projects.path(p.slug), base: d.base_branch, branch: d.branch, title: d.title, body }, 3 * 60_000)
      repo.setStatus(d.id, 'opened', url)
      changed()
      return { ...dto(repo.byId(d.id)!) }
    },

    /** Merge locally (the non-GitHub fallback): runs as the member; conflicts surface clearly and leave the checkout clean. */
    async merge(user: User, slug: string, id: number) {
      const { p, d } = find(slug, id)
      if (d.status === 'merged') throw new AppError(409, 'merged', 'This has already been merged.')
      await agents.request<{ ok: boolean }>(user.username,
        { op: 'git.mergeBranch', path: projects.path(p.slug), base: d.base_branch, branch: d.branch }, 3 * 60_000)
      repo.setStatus(d.id, 'merged')
      changed()
      return { ...dto(repo.byId(d.id)!) }
    },

    /** Not now: drop it from the card (the branch and session stay, to revisit or ship later). */
    dismiss(_user: User, slug: string, id: number) {
      const { d } = find(slug, id)
      repo.setStatus(d.id, 'dismissed')
      changed()
      return { ok: true }
    },
  }

  function tell(userId: number, id: number, role: string, title: string, commits: number, branch: string, slug: string) {
    void notify(userId, 'finished', {
      title: `${role} finished: ${title} — ready to review`,
      body: `${commits} commit${commits === 1 ? '' : 's'} on ${branch}`,
      url: `/projects/${slug}`, tag: `delivery:${id}`,
    }).catch(() => {})
  }
}

export type ReviewsService = ReturnType<typeof reviewsService>
