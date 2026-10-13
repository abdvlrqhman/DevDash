import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { lstat, readdir, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

// Worktree janitor: runs AS the member (one agent per member) and prunes Claude Code's own leftover subagent worktrees
// so they stop filling the shared disk. Claude Code puts subagents in <repo>/.claude/worktrees/agent-<id>; when one does
// `npm ci` that folder grows ~400 MB, and abandoned ones persist. We only ever remove something that is PROVABLY safe —
// stale, with no uncommitted edits, and nothing unmerged to lose. When in any doubt we skip and log. We never touch the
// main checkout, DevDash's own session worktrees (/srv/devdash/worktrees/*), or anything not matching agent-* here.

const run = promisify(execFile)
const ROOT = () => process.env.DEVDASH_PROJECTS_ROOT || '/srv/devdash'

// Thresholds (tuned for safety; a sweep is cheap and rare, so err on the side of leaving things alone).
export const STALE_MS = 24 * 60 * 60_000 // "abandoned": nothing in the worktree changed for 24h (agents finish in minutes)
const FIRST_SWEEP_MS = 2 * 60_000 // first sweep ~2 min after the agent starts (off the critical path)
const SWEEP_INTERVAL_MS = 6 * 60 * 60_000 // then every ~6h
const WALK_BUDGET = 5000 // cap entries walked when dating a tree, so a huge worktree can't make the sweep expensive

const AGENT_RE = /^agent-[\w-]+$/ // the ONLY folder names we ever touch under a repo's .claude/worktrees
const ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0' }

type Registered = { path: string; branch: string | null; locked: boolean }
export type WorktreeState = {
  ageMs: number // time since last activity (newest mtime in the tree)
  dirty: boolean // `git status --porcelain` non-empty
  aheadOfBase: number // commits on this branch not in base (0 = nothing would be lost)
  mergedIntoBase: boolean // this branch's HEAD is an ancestor of base
  locked: boolean // the worktree is locked (someone wants it kept)
  gitError: boolean // its git state could not be read safely
}
export type Decision = { remove: boolean; reason: string }
type Base = { ref: string; name: string }
type Result = { removed: number; skipped: number }

/**
 * The whole safety policy, with NO I/O so it is unit-testable. Only returns remove when the worktree is stale AND clean
 * AND provably loses nothing. Any uncertainty (locked, unreadable, recent, dirty, unmerged) → keep.
 */
export function decide(w: WorktreeState, staleMs = STALE_MS): Decision {
  if (w.gitError) return { remove: false, reason: 'git state unreadable' }
  if (w.locked) return { remove: false, reason: 'worktree is locked' }
  if (w.ageMs < staleMs) return { remove: false, reason: 'still recent' }
  if (w.dirty) return { remove: false, reason: 'uncommitted changes' }
  if (w.mergedIntoBase || w.aheadOfBase === 0) return { remove: true, reason: 'stale, clean, nothing unmerged' }
  return { remove: false, reason: `${w.aheadOfBase} unmerged commit(s) ahead of base` }
}

/** git in a repo, never prompting; returns the exit code instead of throwing so callers can treat failure as "unsure". */
async function git(cwd: string, args: string[], timeout = 30_000) {
  try {
    const { stdout } = await run('git', ['-C', cwd, ...args], { env: ENV, timeout, maxBuffer: 16 * 1024 * 1024 })
    return { ok: true, out: stdout, code: 0 }
  } catch (err) {
    const e = err as { code?: number | string; stdout?: string }
    return { ok: false, out: e.stdout ?? '', code: typeof e.code === 'number' ? e.code : null }
  }
}

const canon = (p: string) => realpath(p).catch(() => p)

/** Newest mtime (ms) anywhere in the tree, else the dir's own. Does NOT follow symlinks (so a symlinked node_modules is
 *  never walked) and is bounded by WALK_BUDGET. On total failure returns now, so an unreadable tree reads as "recent". */
async function newestMtimeMs(dir: string): Promise<number> {
  let newest = 0
  let budget = WALK_BUDGET
  const stack = [dir]
  while (stack.length && budget > 0) {
    const d = stack.pop()!
    let entries
    try { entries = await readdir(d, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      if (--budget <= 0) break
      const p = join(d, e.name)
      const s = await lstat(p).catch(() => null) // lstat: a symlink's own mtime, not its target's
      if (!s) continue
      if (s.mtimeMs > newest) newest = s.mtimeMs
      if (e.isDirectory()) stack.push(p) // Dirent.isDirectory() is false for symlinks, so we never descend one
    }
  }
  const self = await lstat(dir).catch(() => null)
  if (self && self.mtimeMs > newest) newest = self.mtimeMs
  return newest || Date.now()
}

/** The registered worktrees of a repo, keyed by their real path; null if git state can't be read (→ touch nothing). */
async function registered(repo: string): Promise<Map<string, Registered> | null> {
  const r = await git(repo, ['worktree', 'list', '--porcelain'])
  if (!r.ok) return null
  const byReal = new Map<string, Registered>()
  let cur: Registered | null = null
  for (const line of r.out.split('\n')) {
    if (line.startsWith('worktree ')) cur = { path: line.slice(9), branch: null, locked: false }
    else if (!cur) continue
    else if (line.startsWith('branch ')) cur.branch = line.slice(7).replace(/^refs\/heads\//, '')
    else if (line === 'locked' || line.startsWith('locked ')) cur.locked = true
    else if (line === '') { if (cur) byReal.set(await canon(cur.path), cur); cur = null }
  }
  if (cur) byReal.set(await canon(cur.path), cur)
  return byReal
}

/** The base to compare branches against, mirroring projects/service.ts: origin/<default> else <default>, else main/master. */
async function baseRef(repo: string): Promise<Base> {
  let name = ''
  const head = await git(repo, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
  if (head.ok) name = head.out.trim().replace(/^origin\//, '')
  for (const c of ['main', 'master']) {
    if (name) break
    if ((await git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${c}`])).ok) name = c
  }
  if (!name) {
    const cur = await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])
    name = cur.ok ? cur.out.trim() : 'main'
  }
  const origin = await git(repo, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${name}`])
  return { ref: origin.ok ? `refs/remotes/origin/${name}` : name, name }
}

/** Reads a registered worktree's safety state. Skips the git work for recent/locked ones (they're kept regardless). */
async function inspect(repo: string, path: string, reg: Registered, base: Base, ageMs: number): Promise<WorktreeState> {
  const s: WorktreeState = { ageMs, dirty: false, aheadOfBase: 0, mergedIntoBase: false, locked: reg.locked, gitError: false }
  if (reg.locked || ageMs < STALE_MS) return s
  const status = await git(path, ['status', '--porcelain'])
  if (!status.ok) return { ...s, gitError: true }
  s.dirty = status.out.trim().length > 0
  const head = await git(path, ['rev-parse', 'HEAD'])
  if (!head.ok) return { ...s, gitError: true }
  const sha = head.out.trim()
  const ahead = await git(repo, ['rev-list', '--count', `${base.ref}..${sha}`])
  if (!ahead.ok) return { ...s, gitError: true }
  s.aheadOfBase = Number(ahead.out.trim()) || 0
  const merged = await git(repo, ['merge-base', '--is-ancestor', sha, base.ref]) // exit 0 = merged, 1 = not, other = error
  if (merged.code !== 0 && merged.code !== 1) return { ...s, gitError: true }
  s.mergedIntoBase = merged.code === 0
  return s
}

/** Removes a proven-safe worktree: force-remove, prune admin state, delete its now-merged branch (never a base branch). */
async function removeWorktree(repo: string, path: string, reg: Registered, base: Base): Promise<void> {
  const res = await git(repo, ['worktree', 'remove', '--force', path])
  if (!res.ok) throw new Error('git worktree remove failed')
  await git(repo, ['worktree', 'prune'])
  const b = reg.branch
  if (b && b !== base.name && b !== 'main' && b !== 'master') await git(repo, ['branch', '-D', b])
}

/** An agent-* dir that is NOT a registered worktree. Only rm leftover files with no git state of their own; else keep. */
async function handleOrphan(path: string, ageMs: number, out: Result): Promise<void> {
  if (ageMs < STALE_MS) return // recent → leave it alone (silent)
  if (existsSync(join(path, '.git'))) { // a repo/worktree of its own may hold unpushed work — be conservative
    out.skipped++
    console.log(`janitor: kept ${path} — not a registered worktree but has git state`)
    return
  }
  await rm(path, { recursive: true, force: true })
  out.removed++
  console.log(`janitor: removed orphan ${path} (leftover files, no git state)`)
}

/** One full sweep across the member's project checkouts. Never throws; returns how many it removed vs. kept. */
export async function sweep(now = Date.now()): Promise<Result> {
  const out: Result = { removed: 0, skipped: 0 }
  let repos: string[]
  try {
    repos = (await readdir(join(ROOT(), 'projects'), { withFileTypes: true }))
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => join(ROOT(), 'projects', e.name))
  } catch { return out } // no projects root, or no access
  for (const repo of repos) {
    const wtDir = join(repo, '.claude', 'worktrees')
    let names: string[]
    try {
      names = (await readdir(wtDir, { withFileTypes: true })).filter((e) => e.isDirectory() && AGENT_RE.test(e.name)).map((e) => e.name)
    } catch { continue } // no worktrees here, or no access
    if (!names.length || !existsSync(join(repo, '.git'))) continue
    const reg = await registered(repo)
    if (!reg) { out.skipped += names.length; continue } // can't read git state → touch nothing in this repo
    const base = await baseRef(repo)
    for (const name of names) {
      const path = join(wtDir, name)
      try {
        const ageMs = now - (await newestMtimeMs(path))
        const r = reg.get(await canon(path))
        if (!r) { await handleOrphan(path, ageMs, out); continue }
        const d = decide(await inspect(repo, path, r, base, ageMs))
        if (d.remove) {
          await removeWorktree(repo, path, r, base)
          out.removed++
          console.log(`janitor: removed ${path} (${d.reason})`)
        } else if (ageMs >= STALE_MS) { // stale but unsafe — say why; recent ones stay silent
          out.skipped++
          console.log(`janitor: kept ${path} — ${d.reason}`)
        }
      } catch (err) {
        out.skipped++
        console.log(`janitor: kept ${path} — ${(err as Error).message}`)
      }
    }
  }
  if (out.removed || out.skipped) console.log(`janitor: removed ${out.removed}, kept ${out.skipped} stale/uncertain worktree(s)`)
  return out
}

/** Schedules the sweep off the agent's critical path: once ~2 min after start, then every ~6h. Never blocks or throws. */
export function startJanitor(): void {
  const once = () => void sweep().catch((err) => console.log(`janitor: sweep failed — ${(err as Error).message}`))
  setTimeout(() => { once(); setInterval(once, SWEEP_INTERVAL_MS).unref() }, FIRST_SWEEP_MS).unref()
}
