import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { userInfo } from 'node:os'
import { promisify } from 'node:util'

// Git as this member, in shared checkouts under /srv/devdash. Never prompts: missing credentials fail fast with a clear message.
const ROOT = process.env.DEVDASH_PROJECTS_ROOT || '/srv/devdash'
const PATH_RE = new RegExp(`^${ROOT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/(projects/[a-z0-9][a-z0-9-]{0,39}|worktrees/[a-z0-9][a-z0-9-]{0,39}/[a-z0-9-]{1,40})$`)
const run = promisify(execFile)
const ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GIT_SSH_COMMAND: 'ssh -o StrictHostKeyChecking=accept-new -o BatchMode=yes',
}

function checked(p: unknown) {
  if (typeof p !== 'string' || !PATH_RE.test(p)) throw new Error('not a DevDash project folder')
  return p
}

async function git(args: string[], timeout = 60_000) {
  try {
    return (await run('git', args, { env: ENV, timeout, maxBuffer: 32 * 1024 * 1024 })).stdout
  } catch (err) {
    const e = err as { stderr?: string; killed?: boolean; message: string }
    const text = (e.stderr || e.message).trim()
    if (e.killed) throw new Error('git took too long and was stopped.')
    if (/could not read Username|Authentication failed|Permission denied \(publickey\)|terminal prompts disabled|Repository not found|could not read from remote/i.test(text)) {
      throw new Error(`This repository needs your GitHub access. Run \`gh auth login\` (then \`gh auth setup-git\`) in your DevDash terminal, or add an SSH key, then try again. Git said: ${text.split('\n').pop()}`)
    }
    throw new Error(text.split('\n').filter(Boolean).slice(-2).join(' ') || 'git failed')
  }
}

async function identity(cwd: string) {
  const email = await git(['-C', cwd, 'config', 'user.email']).catch(() => '')
  if (email.trim()) return []
  const me = userInfo().username
  return ['-c', `user.name=${me}`, '-c', `user.email=${me}@users.noreply.devdash`]
}

const remoteHead = async (path: string) => {
  const ref = await git(['-C', path, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).catch(() => '')
  return ref.trim().replace(/^origin\//, '') || null
}

export const ops = {
  /** Clones into a new shared folder; the repo stays writable for the whole group. */
  async clone(r: Record<string, unknown>) {
    const path = checked(r.path)
    const url = String(r.url ?? '')
    if (!/^(https:\/\/|git@|ssh:\/\/)[^\s]+$/.test(url)) throw new Error('Use an https:// or git@ repository address.')
    if (existsSync(path)) throw new Error('That folder already exists on the server.')
    await git(['clone', '--quiet', '--config', 'core.sharedRepository=group', url, path], 15 * 60_000)
    return { defaultBranch: (await remoteHead(path)) || (await git(['-C', path, 'branch', '--show-current'])).trim() || 'main' }
  },

  /** A project that only lives here: an empty repo with one empty commit, so branches and worktrees work. */
  async init(r: Record<string, unknown>) {
    const path = checked(r.path)
    if (existsSync(path)) throw new Error('That folder already exists on the server.')
    await git(['init', '--quiet', '--initial-branch=main', '--shared=group', path])
    await git(['-C', path, ...(await identity(path)), 'commit', '--quiet', '--allow-empty', '-m', 'Start'])
    return { defaultBranch: 'main' }
  },

  async fetch(r: Record<string, unknown>) {
    const path = checked(r.path)
    const remotes = await git(['-C', path, 'remote'])
    if (!remotes.split('\n').includes('origin')) return { fetched: false }
    await git(['-C', path, 'fetch', '--quiet', '--prune', 'origin'], 5 * 60_000)
    return { fetched: true, defaultBranch: await remoteHead(path) }
  },

  async refs(r: Record<string, unknown>) {
    const path = checked(r.path)
    const out = await git(['-C', path, 'for-each-ref', '--format=%(refname)%09%(objectname)', 'refs/heads', 'refs/remotes/origin'])
    return { refs: Object.fromEntries(out.trim().split('\n').filter((l) => l && !l.startsWith('refs/remotes/origin/HEAD\t')).map((l) => l.split('\t') as [string, string])) }
  },

  /** Commits in `range` (e.g. "a..b" or a ref), newest first. */
  async log(r: Record<string, unknown>) {
    const path = checked(r.path)
    const range = String(r.range ?? '')
    if (!/^[\w./-]+(\.\.[\w./-]+)?$/.test(range)) throw new Error('invalid range')
    const max = Math.min(500, Math.max(1, Number(r.max) || 100))
    const out = await git(['-C', path, 'log', `--max-count=${max}`, '--format=%H%x1f%an%x1f%ae%x1f%ct%x1f%s%x1f%b%x1e', range, '--'])
    return {
      commits: out.split('\x1e').map((c) => c.trim()).filter(Boolean).map((c) => {
        const [sha, author, email, at, subject, body] = c.split('\x1f')
        return { sha: sha!, author: author!, email: email!, at: Number(at), subject: subject!, body: body ?? '' }
      }),
    }
  },

  /** A separate checkout on its own branch, so parallel Claude sessions don't step on each other. */
  async worktreeAdd(r: Record<string, unknown>) {
    const path = checked(r.path)
    const wt = checked(r.worktree)
    const branch = String(r.branch ?? '')
    const base = String(r.base ?? '')
    if (!/^dd\/[a-z0-9-]{1,40}$/.test(branch) || !/^[\w./-]+$/.test(base)) throw new Error('invalid branch')
    await git(['-C', path, 'worktree', 'add', '--quiet', '-b', branch, wt, base])
    return { ok: true }
  },

  /** Removes a worktree only when it has nothing uncommitted; otherwise it stays for someone to look at. */
  async worktreeRemove(r: Record<string, unknown>) {
    const path = checked(r.path)
    const wt = checked(r.worktree)
    if (!existsSync(wt)) return { removed: true }
    if ((await git(['-C', wt, 'status', '--porcelain'])).trim()) return { removed: false }
    await git(['-C', path, 'worktree', 'remove', wt])
    return { removed: true }
  },
}
