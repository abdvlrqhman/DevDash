import { randomUUID } from 'node:crypto'
import type { Db } from '../../core/db.ts'
import type { Hub } from '../../core/hub.ts'
import { AppError } from '../../core/http.ts'
import type { AgentsService } from '../agents/service.ts'
import type { NotificationKind } from '../notifications/service.ts'
import type { ProjectsService } from '../projects/service.ts'
import type { User } from '../auth/repo.ts'
import { claudeRepo, type Defaults, type Patch, type SessionRow, type SessionStatus } from './repo.ts'

export const PERMISSION_MODES = ['default', 'acceptEdits', 'bypassPermissions', 'plan', 'dontAsk', 'auto'] as const
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
const STATUSES = new Set<SessionStatus>(['working', 'waiting', 'idle', 'stopped', 'error'])
const PROFILE_RE = /^[a-z0-9][a-z0-9-]{0,20}$/

export type Image = { mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'; data: string }
/** Any other file sent with a message: PDFs and text go to Claude directly, anything else is saved for Claude to open. */
export type Attachment = { name: string; mediaType: string; data: string }
export type PermissionAnswer =
  | { behavior: 'allow'; updatedInput?: Record<string, unknown>; updatedPermissions?: unknown[] }
  | { behavior: 'deny'; message: string; interrupt?: boolean }

const canView = (u: User, s: SessionRow) => s.owner_id === u.id || s.shared === 1

/**
 * What the running process reports and nothing needs to remember across restarts: the Remote Control link and
 * whether fast mode is actually serving (it can be on but unavailable, e.g. without extra usage on the plan).
 */
type Live = { remoteUrl?: string | null; remoteError?: string | null; fast?: { state: string; reason: string | null } }
const live = new Map<string, Live>()
const setLive = (id: string, v: Live) => live.set(id, { ...live.get(id), ...v })

const context = (s: SessionRow) => {
  try {
    return s.context_json ? (JSON.parse(s.context_json) as { percent: number; tokens: number; max: number }) : null
  } catch {
    return null
  }
}

/** What browsers get: no internal flags they don't need. */
export function toDto(s: SessionRow) {
  return {
    id: s.id, title: s.title, cwd: s.cwd, profile: s.profile, mode: s.mode, status: s.status, statusDetail: s.status_detail,
    model: s.model, effort: s.effort, permissionMode: s.permission_mode, started: !!s.started,
    shared: !!s.shared, sharedCanSend: !!s.shared_can_send, archived: !!s.archived,
    owner: { id: s.owner_id, username: s.owner_username, name: s.owner_name },
    createdAt: s.created_at, lastActivityAt: s.last_activity_at,
    project: s.project_slug ? { slug: s.project_slug, name: s.project_name! } : null, worktree: s.worktree,
    fastMode: !!s.fast_mode, fast: live.get(s.id)?.fast ?? null, context: context(s),
    remoteControl: !!s.remote_control, remoteUrl: live.get(s.id)?.remoteUrl ?? null, remoteError: live.get(s.id)?.remoteError ?? null,
  }
}
export type SessionDto = ReturnType<typeof toDto>

/** claude-mem for one member, as their agent reports it (apps/agent/src/memory.ts). */
export type MemoryHealth = {
  on: string[]
  state: 'off' | 'stopped' | 'ok' | 'error'
  error?: string | null
  version?: string | null
  uptime?: number | null
  memories?: number | null
  lastSaved?: number | null
  problems?: string[]
}
export const memoryHealth = (agents: AgentsService, username: string, timeoutMs = 10_000) =>
  agents.request<{ health: MemoryHealth }>(username, { op: 'claude.memory.health' }, timeoutMs).then((r) => r.health)

const launch = (s: SessionRow) => ({
  id: s.id, cwd: s.cwd, profile: s.profile, model: s.model, effort: s.effort, permissionMode: s.permission_mode, started: !!s.started,
  fast: !!s.fast_mode, remote: !!s.remote_control, title: s.title,
})

function content(text: string, images: Image[], docs: unknown[] = []) {
  return [
    ...images.map((i) => ({ type: 'image', source: { type: 'base64', media_type: i.mediaType, data: i.data } })),
    ...docs,
    ...(text ? [{ type: 'text', text }] : []),
  ]
}

// Text Claude can read straight from the message: source code, data, configs, logs.
const TEXT_TYPES = /^(text\/|application\/(json|xml|javascript|typescript|x-yaml|yaml|toml|sql|x-sh|graphql|ld\+json))/
const TEXT_EXT = /\.(txt|md|mdx|csv|tsv|json|jsonl|ya?ml|toml|ini|cfg|conf|xml|html?|css|scss|less|js|mjs|cjs|jsx|ts|tsx|py|rb|go|rs|java|kt|swift|c|h|cc|cpp|hpp|cs|php|sh|bash|zsh|ps1|sql|graphql|proto|lua|r|dart|vue|svelte|log|diff|patch|tf)$/i
const safeName = (n: string) => n.split(/[\\/]/).pop()!.replace(/[^\w.\- ()]/g, '_').replace(/^\.+/, '').slice(0, 120) || 'file'

type Notify = (userId: number, kind: NotificationKind, n: { title: string; body?: string; url?: string; tag?: string }) => Promise<void>

const clip = (t: string, n = 160) => (t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t)
function describeRequest(toolName: string, input: Record<string, unknown>) {
  if (toolName === 'AskUserQuestion') {
    const q = (input.questions as { question?: string }[] | undefined)?.[0]?.question
    return q ? `Asked: ${q}` : 'Claude has a question'
  }
  if (toolName === 'ExitPlanMode') return 'A plan is ready for your review'
  const what = typeof input.command === 'string' ? input.command : typeof input.file_path === 'string' ? input.file_path : ''
  return `Wants to use ${toolName}${what ? `: ${what}` : ''}`
}

export function claudeService({ db, agents, hub, notify, projects }: { db: Db; agents: AgentsService; hub: Hub; notify: Notify; projects: ProjectsService }) {
  const repo = claudeRepo(db)
  // A failing turn can report twice (its result, then the process exiting): one error alert per session per minute.
  const lastError = new Map<string, number>()
  const alert = (s: SessionRow, kind: NotificationKind, title: string, body?: string) => {
    if (kind === 'errors') {
      if (Date.now() - (lastError.get(s.id) ?? 0) < 60_000) return
      lastError.set(s.id, Date.now())
    }
    void notify(s.owner_id, kind, { title, body, url: `/claude/${s.id}`, tag: `session:${s.id}` }).catch((err) => console.error('notify:', err))
  }

  // Owner, anyone when the owner lets everyone send, and teammates the owner let in after they asked to join.
  const canSend = (u: User, s: SessionRow) =>
    s.owner_id === u.id || (s.shared === 1 && (s.shared_can_send === 1 || repo.isWriter(s.id, u.id)))

  function find(user: User, id: string) {
    const s = repo.byId(id)
    if (!s || !canView(user, s)) throw new AppError(404, 'not_found', 'This session does not exist or is private.')
    return s
  }
  function requireSend(user: User, s: SessionRow) {
    if (!canSend(user, s)) throw new AppError(403, 'forbidden', 'Only the owner can send messages in this session.')
  }
  function requireOwner(user: User, s: SessionRow) {
    if (s.owner_id !== user.id) throw new AppError(403, 'forbidden', 'Only the owner can change this.')
  }
  function publish(id: string) {
    const s = repo.byId(id)
    if (!s) return
    const dto = toDto(s)
    hub.publish('sessions', { type: 'session', session: dto }, (u) => canView(u, s))
    hub.publish(`session:${id}`, { type: 'session', session: dto }, (u) => canView(u, s))
  }

  hub.authorize('sessions', () => true)
  hub.authorize('session', (u, topic) => {
    const s = repo.byId(topic.slice('session:'.length))
    return !!s && canView(u, s)
  })
  hub.trackPresence('session') // who has a session open: "watching"

  // Agent events. An agent only speaks for its own member, so events about anyone else's session are dropped.
  agents.onEvent((username, ev) => {
    if (ev.ev === 'snapshot') {
      void backfillTitles(username)
      return reconcile(username, ev.sessions as { id: string; mode: string; status?: SessionStatus; remote?: string | null }[])
    }
    const s = typeof ev.id === 'string' ? repo.byId(ev.id) : undefined
    if (!s || s.owner_username !== username) return
    const viewers = (u: User) => canView(u, s)
    switch (ev.ev) {
      case 'claude.status': {
        const st = ev.status as SessionStatus
        if (!STATUSES.has(st)) return
        // CLI exited: back to Chat mode, ready to resume.
        const mode = st === 'stopped' ? 'chat' : ev.mode === 'cli' || ev.mode === 'chat' ? ev.mode : s.mode
        repo.setStatus(s.id, st === 'stopped' ? 'idle' : st, typeof ev.detail === 'string' ? ev.detail : null, mode)
        // Project pages show who is working there right now.
        if (s.project_id && (st === 'stopped' ? 'idle' : st) !== s.status) hub.publish('projects', { type: 'changed' })
        // Claude may have committed: look for "fixes #N" now rather than at the next fetch.
        if (s.project_id && s.status === 'working' && st !== 'working') projects.rescan(s.project_id)
        // Chat mode notifies from the richer permission/result events below; the CLI only reports status.
        if (st === 'error') alert(s, 'errors', `Claude stopped with an error: ${s.title}`, typeof ev.detail === 'string' ? clip(ev.detail) : undefined)
        else if (s.mode === 'cli' && st === 'waiting' && s.status !== 'waiting') alert(s, 'needs_you', `Claude needs you: ${s.title}`, 'Waiting for you in the CLI')
        else if (s.mode === 'cli' && st === 'idle' && s.status === 'working') alert(s, 'finished', `Claude finished: ${s.title}`)
        return publish(s.id)
      }
      case 'claude.context': {
        const percent = Number(ev.percent), tokens = Number(ev.tokens), max = Number(ev.max)
        if (![percent, tokens, max].every(Number.isFinite)) return
        repo.patch(s.id, { context_json: JSON.stringify({ percent, tokens, max }) })
        return publish(s.id)
      }
      case 'claude.remote':
        setLive(s.id, { remoteUrl: typeof ev.url === 'string' ? ev.url : null, remoteError: typeof ev.error === 'string' ? ev.error : null })
        return publish(s.id)
      case 'claude.msg': {
        const m = ev.msg as {
          type?: string; subtype?: string; result?: unknown; is_error?: boolean; terminal_reason?: string
          fast_mode_state?: string; fast_mode_disabled_reason?: string
        }
        if (typeof m.fast_mode_state === 'string') {
          const fast = { state: m.fast_mode_state, reason: m.fast_mode_disabled_reason ?? null }
          const was = live.get(s.id)?.fast
          if (was?.state !== fast.state || was?.reason !== fast.reason) {
            setLive(s.id, { fast })
            publish(s.id)
          }
        }
        // Pressing Stop ends the turn with an "aborted" reason: nothing to tell anyone.
        if (m.type === 'result' && !m.terminal_reason?.startsWith('aborted')) {
          if (m.subtype === 'success' && !m.is_error) alert(s, 'finished', `Claude finished: ${s.title}`, typeof m.result === 'string' ? clip(m.result) : undefined)
          else alert(s, 'errors', `Claude stopped with an error: ${s.title}`, typeof m.result === 'string' ? clip(m.result) : undefined)
        }
        return hub.publish(`session:${s.id}`, { type: 'msg', msg: ev.msg }, viewers)
      }
      case 'claude.permission':
        alert(s, 'needs_you', `Claude needs you: ${s.title}`, clip(describeRequest(String(ev.toolName), (ev.input as Record<string, unknown>) ?? {})))
        return hub.publish(`session:${s.id}`, {
          type: 'permission', request: { requestId: ev.requestId, toolName: ev.toolName, input: ev.input, suggestions: ev.suggestions },
        }, viewers)
      case 'claude.permission_done':
        return hub.publish(`session:${s.id}`, { type: 'permission_done', requestId: ev.requestId }, viewers)
      case 'claude.title': {
        const title = typeof ev.title === 'string' ? ev.title.trim().slice(0, 120) : ''
        if (!title || title === s.title) return
        // Renamed here before Claude Code had a session file: hand it the owner's title now.
        if (s.title_custom) return void agents.request(username, { op: 'claude.rename', launch: launch(s), title: s.title }).catch(() => {})
        repo.patch(s.id, { title })
        return publish(s.id)
      }
    }
  })

  /**
   * Sessions started before titles came from Claude Code (or whose last turn ended while the server was down) take
   * Claude Code's title once per server start. Titles the owner set in DevDash stay.
   */
  const titled = new Set<string>()
  async function backfillTitles(username: string) {
    if (titled.has(username)) return
    titled.add(username)
    const rows = db.prepare(`select s.* from claude_sessions s join users u on u.id = s.owner_id
      where u.username = ? and s.started = 1 and s.title_custom = 0 and s.archived = 0`).all(username) as unknown as SessionRow[]
    for (const s of rows) {
      const r = await agents.request<{ title: string | null }>(username, { op: 'claude.title', launch: launch(s) }, 10_000).catch(() => null)
      if (!r) return void titled.delete(username) // an agent still on older code, or busy: try again when it reconnects
      const t = r.title?.trim().slice(0, 120)
      if (t && t !== s.title) { repo.patch(s.id, { title: t }); publish(s.id) }
    }
  }

  /** After (re)connecting to an agent: trust what is actually running over what the database remembers. */
  // A session that was working when its process went away (server reboot, agent crash) carries on by itself:
  // nobody has to keep a device open. At most once per half hour per session, so a crash can't loop.
  const RESUME_TEXT = 'Continue where you left off. (DevDash: the server restarted while you were working.)'
  const resumed = new Map<string, number>()
  async function resumeInterrupted(s: SessionRow) {
    resumed.set(s.id, Date.now())
    try {
      const uuid = randomUUID()
      repo.addSender(s.id, uuid, s.owner_id)
      await agents.request(s.owner_username, { op: 'claude.send', launch: launch(s), content: content(RESUME_TEXT, []), uuid })
      repo.setStatus(s.id, 'working', null, 'chat')
    } catch (err) {
      repo.setStatus(s.id, 'error', `Interrupted by a server restart and could not continue: ${(err as Error).message}`.slice(0, 500), 'chat')
      alert(s, 'errors', `Claude was interrupted: ${s.title}`, 'Send a message to continue.')
    }
    publish(s.id)
  }

  /** Remote Control stays on across restarts: the Claude app should keep reaching the session. */
  async function restoreRemote(s: SessionRow) {
    try {
      const r = await agents.request<{ url: string | null }>(s.owner_username, { op: 'claude.remote', launch: launch(s), enabled: true }, 60_000)
      setLive(s.id, { remoteUrl: r.url, remoteError: null })
    } catch (err) {
      setLive(s.id, { remoteUrl: null, remoteError: (err as Error).message.slice(0, 300) })
    }
    publish(s.id)
  }

  function reconcile(username: string, running: { id: string; mode: string; status?: SessionStatus; remote?: string | null }[]) {
    const byId = new Map(running.map((l) => [l.id, l]))
    for (const s of repo.ownedActive(username)) {
      const l = byId.get(s.id)
      setLive(s.id, { remoteUrl: l?.mode === 'chat' ? (l.remote ?? null) : null })
      if (!l && s.remote_control && s.mode === 'chat' && s.started && s.status !== 'working') void restoreRemote(s)
      if (!l && s.status === 'working' && s.started && Date.now() - (resumed.get(s.id) ?? 0) > 30 * 60_000) {
        void resumeInterrupted(s)
        continue
      }
      const mode = l?.mode === 'cli' ? 'cli' : 'chat'
      const status = l?.status && STATUSES.has(l.status) ? l.status : s.status === 'working' || s.status === 'waiting' ? 'idle' : s.status
      if (mode !== s.mode || status !== s.status) {
        repo.setStatus(s.id, status, s.status_detail, mode)
        if (s.project_id && status !== s.status) hub.publish('projects', { type: 'changed' })
        publish(s.id)
      }
    }
  }

  const asked = new Map<string, number>()

  /** Remote Control in Chat applies now; in the CLI it applies the next time the CLI opens. */
  async function setRemote(s: SessionRow, on: boolean) {
    if (on && !s.started) throw new AppError(409, 'not_started', 'Send Claude a first message, then turn on Remote Control.')
    repo.patch(s.id, { remote_control: on ? 1 : 0 })
    if (s.mode !== 'chat') return
    try {
      const r = await agents.request<{ url: string | null }>(s.owner_username, { op: 'claude.remote', launch: { ...launch(s), remote: on }, enabled: on }, 60_000)
      setLive(s.id, { remoteUrl: r.url, remoteError: null })
    } catch (err) {
      repo.patch(s.id, { remote_control: s.remote_control })
      if (s.remote_control) setLive(s.id, { remoteUrl: null, remoteError: (err as Error).message.slice(0, 300) })
      throw new AppError(400, 'remote_failed', `Remote Control did not start: ${(err as Error).message}`)
    }
  }

  /**
   * PDFs and text files become document blocks Claude reads directly. Anything else (archives, spreadsheets, binaries)
   * is saved in the owner's account and its path added to the message, so Claude can open it with its tools.
   */
  async function attach(s: SessionRow, uuid: string, files: Attachment[]) {
    const docs: unknown[] = []
    const saved: string[] = []
    for (const f of files) {
      const name = safeName(f.name)
      const buf = Buffer.from(f.data, 'base64')
      if (f.mediaType === 'application/pdf') {
        docs.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: f.data }, title: name })
      } else if ((TEXT_TYPES.test(f.mediaType) || TEXT_EXT.test(name)) && !buf.includes(0) && buf.length <= 2 * 1024 * 1024) {
        docs.push({ type: 'document', source: { type: 'text', media_type: 'text/plain', data: buf.toString('utf8') }, title: name })
      } else {
        const dir = `/home/${s.owner_username}/.cache/devdash/uploads/${s.id}/${uuid.slice(0, 8)}`
        await agents.request(s.owner_username, { op: 'fs.mkdirp', path: dir })
        await agents.request(s.owner_username, { op: 'fs.write', path: `${dir}/${name}`, data: f.data, offset: 0 }, 120_000)
        saved.push(`${dir}/${name}`)
      }
    }
    const note = saved.length ? `\n\nAttached files, saved on this server:\n${saved.map((p) => `- ${p}`).join('\n')}` : ''
    return { docs, note }
  }

  async function sendTo(user: User, s: SessionRow, text: string, images: Image[], files: Attachment[] = []) {
    const uuid = randomUUID()
    repo.addSender(s.id, uuid, user.id)
    const { docs, note } = await attach(s, uuid, files)
    const message = { role: 'user', content: content(`${text}${note}`.trim(), images, docs) }
    await agents.request(s.owner_username, { op: 'claude.send', launch: launch(s), content: message.content, uuid })
    if (!s.started) repo.patch(s.id, { started: 1 })
    repo.touch(s.id)
    publish(s.id)
    // Everyone watching sees the message right away (the sender's page already shows it; the uuid dedupes).
    hub.publish(`session:${s.id}`, { type: 'msg', msg: { type: 'user', uuid, message } }, (u) => canView(u, s))
    return uuid
  }

  return {
    list: (user: User, archived: boolean) => repo.visible(user.id, archived).map(toDto),

    async get(user: User, id: string) {
      const s = find(user, id)
      const pending = s.mode === 'chat'
        ? (await agents.request<{ pending: unknown[] }>(s.owner_username, { op: 'claude.pending', id }).catch(() => ({ pending: [] }))).pending
        : []
      const isOwner = s.owner_id === user.id
      return {
        session: toDto(s), pending, canSend: canSend(user, s), isOwner,
        viewers: hub.viewers(`session:${id}`), comments: repo.commentCount(id), writers: isOwner ? repo.writers(id) : [],
      }
    },

    async create(user: User, input: {
      prompt: string; images: Image[]; cwd: string; profile: string; model: string | null; effort: string | null
      permissionMode: string; mode: 'chat' | 'cli'; cols?: number; rows?: number; project?: string; worktree?: boolean
    }) {
      if (!PROFILE_RE.test(input.profile)) throw new AppError(400, 'bad_profile', 'Unknown profile.')
      const home = `/home/${user.username}`
      // In a project: its shared checkout, or a fresh worktree on its own branch so parallel sessions don't collide.
      const wt = input.project && input.worktree ? await projects.worktree(user, input.project) : null
      const cwd = wt?.path ?? (input.project ? projects.path(projects.bySlug(input.project).slug)
        : input.cwd.trim() === '' || input.cwd.trim() === '~' ? home : input.cwd.trim().replace(/^~(?=\/)/, home))
      if (!cwd.startsWith('/')) throw new AppError(400, 'bad_cwd', 'Use a full folder path, like ~/projects/app.')
      // Outside a project the session gets its own folder (the dialog suggests ~/sessions/<name>); make it if it's new.
      if (!input.project) await agents.request(user.username, { op: 'fs.mkdirp', path: cwd })
      const project = input.project ? projects.bySlug(input.project) : projects.forPath(cwd)
      const firstLine = input.prompt.trim().split('\n')[0]!.slice(0, 80)
      const id = randomUUID()
      repo.insert({
        id, owner_id: user.id, profile: input.profile, title: firstLine || 'New session', cwd, mode: input.mode,
        model: input.model, effort: input.effort, permission_mode: input.permissionMode,
      })
      if (project) repo.setProject(id, project.id, wt?.path ?? null)
      const s = repo.byId(id)!
      try {
        if (input.mode === 'cli') {
          await agents.request(user.username, { op: 'claude.cli.open', launch: launch(s), cols: input.cols ?? 100, rows: input.rows ?? 30 })
          repo.patch(id, { started: 1 })
        } else if (input.prompt.trim() || input.images.length) {
          await sendTo(user, s, input.prompt, input.images)
        }
      } catch (err) {
        db.prepare('delete from claude_sessions where id = ?').run(id) // nothing started; don't leave an empty session behind
        throw err
      }
      publish(id)
      return toDto(repo.byId(id)!)
    },

    async send(user: User, id: string, text: string, images: Image[], files: Attachment[] = []) {
      const s = find(user, id)
      requireSend(user, s)
      if (s.mode === 'cli') throw new AppError(409, 'cli_mode', 'This session is open in the CLI. Switch to Chat to send from here.')
      return sendTo(user, s, text, images, files)
    },

    /** Files and folders in the session's folder, for @ mentions. */
    async files(user: User, id: string, q: string) {
      const s = find(user, id)
      requireSend(user, s)
      return agents.request<{ paths: string[] }>(s.owner_username, { op: 'claude.files', cwd: s.cwd, q }, 20_000)
    },

    /** Someone watching a shared session asks the owner to let them send messages too. */
    askToJoin(user: User, id: string) {
      const s = find(user, id)
      if (canSend(user, s)) throw new AppError(409, 'already', 'You can already send messages here.')
      const key = `${id}:${user.id}`
      if (Date.now() - (asked.get(key) ?? 0) < 60_000) return
      asked.set(key, Date.now())
      hub.publish(`session:${id}`, { type: 'join_request', user: { id: user.id, name: user.name } }, (u) => u.id === s.owner_id)
      void notify(s.owner_id, 'shared', {
        title: `${user.name} asks to join: ${s.title}`, body: 'Open the session to let them send messages.', url: `/claude/${id}`, tag: `join:${key}`,
      }).catch(() => {})
    },

    /** The owner lets a teammate send messages, or takes it back. */
    setWriter(user: User, id: string, userId: number, allowed: boolean) {
      const s = find(user, id)
      requireOwner(user, s)
      if (userId === s.owner_id) throw new AppError(400, 'owner', 'You can always send messages in your own session.')
      const who = db.prepare('select id from users where id = ? and disabled_at is null').get(userId)
      if (!who) throw new AppError(404, 'not_found', 'No such member.')
      repo.setWriter(id, userId, allowed)
      // Their page asks again what it may do.
      hub.publish(`session:${id}`, { type: 'access' }, (u) => u.id === userId)
      if (allowed) void notify(userId, 'shared', { title: `You can send messages in ${s.title}`, body: `${user.name} let you in.`, url: `/claude/${id}` }).catch(() => {})
      return { writers: repo.writers(id) }
    },

    comments: (user: User, id: string) => (find(user, id), { comments: repo.comments(id) }),

    /** A comment for the team, never sent to Claude. The owner hears about comments from others. */
    comment(user: User, id: string, body: string) {
      const s = find(user, id)
      const c = repo.addComment(id, user.id, body.trim())
      hub.publish(`session:${id}`, { type: 'comment', comment: c }, (u) => canView(u, s))
      if (user.id !== s.owner_id) {
        void notify(s.owner_id, 'shared', { title: `${user.name} commented on ${s.title}`, body: clip(c.body), url: `/claude/${id}`, tag: `comment:${id}` }).catch(() => {})
      }
      return c
    },

    async answer(user: User, id: string, requestId: string, result: PermissionAnswer) {
      const s = find(user, id)
      requireSend(user, s)
      await agents.request(s.owner_username, { op: 'claude.answer', id, requestId, result })
    },

    async interrupt(user: User, id: string) {
      const s = find(user, id)
      requireSend(user, s)
      await agents.request(s.owner_username, { op: 'claude.interrupt', id })
    },

    async update(user: User, id: string, p: {
      title?: string; shared?: boolean; sharedCanSend?: boolean; archived?: boolean
      model?: string | null; effort?: string | null; permissionMode?: string; fastMode?: boolean; remoteControl?: boolean
    }) {
      const s = find(user, id)
      const ownerOnly = p.title !== undefined || p.shared !== undefined || p.sharedCanSend !== undefined || p.archived !== undefined
        || p.remoteControl !== undefined
      if (ownerOnly) requireOwner(user, s)
      else requireSend(user, s)
      const patch: Patch = {
        title: p.title?.trim().slice(0, 120) || undefined,
        shared: p.shared === undefined ? undefined : p.shared ? 1 : 0,
        shared_can_send: p.sharedCanSend === undefined ? undefined : p.sharedCanSend ? 1 : 0,
        archived: p.archived === undefined ? undefined : p.archived ? 1 : 0,
        model: p.model, effort: p.effort, permission_mode: p.permissionMode,
        fast_mode: p.fastMode === undefined ? undefined : p.fastMode ? 1 : 0,
      }
      if (patch.title) {
        patch.title_custom = 1
        if (s.started) await agents.request(s.owner_username, { op: 'claude.rename', launch: launch(s), title: patch.title }).catch(() => {})
      }
      repo.patch(id, patch)
      for (const [key, value] of [['model', p.model], ['effort', p.effort], ['permissionMode', p.permissionMode], ['fast', p.fastMode]] as const) {
        if (value !== undefined && s.mode === 'chat') await agents.request(s.owner_username, { op: 'claude.set', id, key, value })
      }
      // Turning it on again while it has no link (it failed, or the process went away) tries again.
      if (p.remoteControl !== undefined && (p.remoteControl !== !!s.remote_control || (p.remoteControl && !live.get(id)?.remoteUrl))) {
        await setRemote(s, p.remoteControl)
      }
      if (p.archived) {
        await agents.request(s.owner_username, { op: 'claude.stop', id }).catch(() => {})
        // Its worktree goes too, unless it holds uncommitted work.
        if (s.worktree && s.project_slug) void projects.removeWorktree(s.owner_username, s.project_slug, s.worktree).catch(() => {})
      }
      if (p.shared && !s.shared) {
        for (const { id: uid } of db.prepare('select id from users where disabled_at is null and id != ?').all(s.owner_id) as { id: number }[]) {
          void notify(uid, 'shared', { title: `${user.name} shared a Claude session`, body: s.title, url: `/claude/${id}` }).catch(() => {})
        }
      }
      publish(id)
      return toDto(repo.byId(id)!)
    },

    /** Chat ↔ CLI on the same session id. The agent makes sure the old process is gone before the new one starts. */
    async switchMode(user: User, id: string, mode: 'chat' | 'cli', cols: number, rows: number) {
      const s = find(user, id)
      requireSend(user, s)
      if (mode === 'cli') {
        await agents.request(s.owner_username, { op: 'claude.cli.open', launch: launch(s), cols, rows })
        repo.patch(id, { started: 1 })
      } else {
        await agents.request(s.owner_username, { op: 'claude.cli.close', id })
      }
      repo.setStatus(id, 'idle', null, mode)
      publish(id)
      return toDto(repo.byId(id)!)
    },

    async history(user: User, id: string) {
      const s = find(user, id)
      if (!s.started) return { messages: [], senders: {} }
      const { messages } = await agents.request<{ messages: unknown[] }>(s.owner_username, { op: 'claude.history', launch: launch(s) }, 120_000)
      return { messages, senders: repo.senders(id) }
    },

    /** For the CLI view: owner and members allowed to send get a writable terminal; other viewers watch. */
    cliAccess(user: User, id: string) {
      const s = find(user, id)
      if (s.mode !== 'cli') throw new AppError(409, 'not_cli', 'This session is not open in the CLI.')
      return { owner: s.owner_username, readonly: !canSend(user, s) }
    },

    commands: (user: User, profile: string) =>
      agents.request<{ commands: unknown[]; models: unknown[] }>(user.username, { op: 'claude.commands', profile }),
    /** Plan limits of one of the member's own Claude profiles. */
    usage: async (user: User, profile: string) =>
      (await agents.request<{ usage: unknown }>(user.username, { op: 'claude.usage', profile }, 45_000)).usage as {
        plan: string | null
        available: boolean
        limits: Record<string, { utilization: number | null; resets_at: string | null } | { display_name: string; utilization: number | null; resets_at: string | null }[] | { is_enabled: boolean; monthly_limit: number | null; used_credits: number | null; utilization: number | null; currency?: string | null } | null> | null
      },
    profiles: async (user: User) => ({
      ...(await agents.request<{ profiles: unknown[] }>(user.username, { op: 'claude.profiles' })),
      defaults: repo.defaults(user.id),
    }),
    createProfile: (user: User, name: string) => agents.request(user.username, { op: 'claude.profile.create', name }),
    memoryHealth: (user: User) => memoryHealth(agents, user.username),
    restartMemory: async (user: User) => {
      await agents.request(user.username, { op: 'claude.memory.restart' }, 70_000)
    },
    /**
     * claude-mem on or off for one of the member's profiles. Installing it the first time can take a few minutes,
     * longer than Cloudflare holds a request: after a minute this answers `pending` and the install carries on.
     */
    setMemory: async (user: User, profile: string, enabled: boolean) => {
      if (!PROFILE_RE.test(profile)) throw new AppError(400, 'bad_profile', 'Unknown profile.')
      let late = false
      const job = agents.request(user.username, { op: 'claude.memory', profile, enabled }, 300_000)
      job.catch((err: Error) => {
        if (late) void notify(user.id, 'errors', { title: 'claude-mem could not be turned on', body: clip(err.message), url: '/claude/setup' }).catch(() => {})
      })
      const done = await Promise.race([job.then(() => true), new Promise<false>((r) => setTimeout(r, 60_000, false))])
      late = !done
      return { pending: !done }
    },
    defaults: (user: User) => repo.defaults(user.id),
    saveDefaults: (user: User, d: Defaults) => {
      if (!PROFILE_RE.test(d.profile)) throw new AppError(400, 'bad_profile', 'Unknown profile.')
      repo.saveDefaults(user.id, d)
      return repo.defaults(user.id)
    },
  }
}

export type ClaudeService = ReturnType<typeof claudeService>
