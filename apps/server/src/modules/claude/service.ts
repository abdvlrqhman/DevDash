import { randomUUID } from 'node:crypto'
import type { Db } from '../../core/db.ts'
import type { Hub } from '../../core/hub.ts'
import { AppError } from '../../core/http.ts'
import type { AgentsService } from '../agents/service.ts'
import type { NotificationKind } from '../notifications/service.ts'
import type { User } from '../auth/repo.ts'
import { claudeRepo, type Defaults, type Patch, type SessionRow, type SessionStatus } from './repo.ts'

export const PERMISSION_MODES = ['default', 'acceptEdits', 'bypassPermissions', 'plan', 'dontAsk', 'auto'] as const
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
const STATUSES = new Set<SessionStatus>(['working', 'waiting', 'idle', 'stopped', 'error'])
const PROFILE_RE = /^[a-z0-9][a-z0-9-]{0,20}$/

export type Image = { mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'; data: string }
export type PermissionAnswer =
  | { behavior: 'allow'; updatedInput?: Record<string, unknown>; updatedPermissions?: unknown[] }
  | { behavior: 'deny'; message: string; interrupt?: boolean }

const canView = (u: User, s: SessionRow) => s.owner_id === u.id || s.shared === 1
const canSend = (u: User, s: SessionRow) => s.owner_id === u.id || (s.shared === 1 && s.shared_can_send === 1)

/** What browsers get: no internal flags they don't need. */
export function toDto(s: SessionRow) {
  return {
    id: s.id, title: s.title, cwd: s.cwd, profile: s.profile, mode: s.mode, status: s.status, statusDetail: s.status_detail,
    model: s.model, effort: s.effort, permissionMode: s.permission_mode, started: !!s.started,
    shared: !!s.shared, sharedCanSend: !!s.shared_can_send, archived: !!s.archived,
    owner: { id: s.owner_id, username: s.owner_username, name: s.owner_name },
    createdAt: s.created_at, lastActivityAt: s.last_activity_at,
  }
}
export type SessionDto = ReturnType<typeof toDto>

const launch = (s: SessionRow) => ({
  id: s.id, cwd: s.cwd, profile: s.profile, model: s.model, effort: s.effort, permissionMode: s.permission_mode, started: !!s.started,
})

function content(text: string, images: Image[]) {
  return [
    ...images.map((i) => ({ type: 'image', source: { type: 'base64', media_type: i.mediaType, data: i.data } })),
    ...(text ? [{ type: 'text', text }] : []),
  ]
}

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

export function claudeService({ db, agents, hub, notify }: { db: Db; agents: AgentsService; hub: Hub; notify: Notify }) {
  const repo = claudeRepo(db)
  const alert = (s: SessionRow, kind: NotificationKind, title: string, body?: string) =>
    void notify(s.owner_id, kind, { title, body, url: `/claude/${s.id}`, tag: `session:${s.id}` }).catch((err) => console.error('notify:', err))

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

  // Agent events. An agent only speaks for its own member, so events about anyone else's session are dropped.
  agents.onEvent((username, ev) => {
    if (ev.ev === 'snapshot') return reconcile(username, ev.sessions as { id: string; mode: string; status?: SessionStatus; pending?: unknown[] }[])
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
        // Chat mode notifies from the richer permission/result events below; the CLI only reports status.
        if (st === 'error') alert(s, 'errors', `Claude stopped with an error: ${s.title}`, typeof ev.detail === 'string' ? clip(ev.detail) : undefined)
        else if (s.mode === 'cli' && st === 'waiting' && s.status !== 'waiting') alert(s, 'needs_you', `Claude needs you: ${s.title}`, 'Waiting for you in the CLI')
        else if (s.mode === 'cli' && st === 'idle' && s.status === 'working') alert(s, 'finished', `Claude finished: ${s.title}`)
        return publish(s.id)
      }
      case 'claude.msg': {
        const m = ev.msg as { type?: string; subtype?: string; result?: unknown; is_error?: boolean }
        if (m.type === 'result') {
          if (m.subtype === 'success' && !m.is_error) alert(s, 'finished', `Claude finished: ${s.title}`, typeof m.result === 'string' ? clip(m.result) : undefined)
          else alert(s, 'errors', `Claude stopped with an error: ${s.title}`)
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
    }
  })

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

  function reconcile(username: string, live: { id: string; mode: string; status?: SessionStatus }[]) {
    const byId = new Map(live.map((l) => [l.id, l]))
    for (const s of repo.ownedActive(username)) {
      const l = byId.get(s.id)
      if (!l && s.status === 'working' && s.started && Date.now() - (resumed.get(s.id) ?? 0) > 30 * 60_000) {
        void resumeInterrupted(s)
        continue
      }
      const mode = l?.mode === 'cli' ? 'cli' : 'chat'
      const status = l?.status && STATUSES.has(l.status) ? l.status : s.status === 'working' || s.status === 'waiting' ? 'idle' : s.status
      if (mode !== s.mode || status !== s.status) {
        repo.setStatus(s.id, status, s.status_detail, mode)
        publish(s.id)
      }
    }
  }

  async function sendTo(user: User, s: SessionRow, text: string, images: Image[]) {
    const uuid = randomUUID()
    repo.addSender(s.id, uuid, user.id)
    await agents.request(s.owner_username, { op: 'claude.send', launch: launch(s), content: content(text, images), uuid })
    if (!s.started) repo.patch(s.id, { started: 1 })
    repo.touch(s.id)
    publish(s.id)
    return uuid
  }

  return {
    list: (user: User, archived: boolean) => repo.visible(user.id, archived).map(toDto),

    async get(user: User, id: string) {
      const s = find(user, id)
      const pending = s.mode === 'chat'
        ? (await agents.request<{ pending: unknown[] }>(s.owner_username, { op: 'claude.pending', id }).catch(() => ({ pending: [] }))).pending
        : []
      return { session: toDto(s), pending, canSend: canSend(user, s), isOwner: s.owner_id === user.id }
    },

    async create(user: User, input: {
      prompt: string; images: Image[]; cwd: string; profile: string; model: string | null; effort: string | null
      permissionMode: string; mode: 'chat' | 'cli'; cols?: number; rows?: number
    }) {
      if (!PROFILE_RE.test(input.profile)) throw new AppError(400, 'bad_profile', 'Unknown profile.')
      const home = `/home/${user.username}`
      const cwd = input.cwd.trim() === '' || input.cwd.trim() === '~' ? home : input.cwd.trim().replace(/^~(?=\/)/, home)
      if (!cwd.startsWith('/')) throw new AppError(400, 'bad_cwd', 'Use a full folder path, like ~/projects/app.')
      const firstLine = input.prompt.trim().split('\n')[0]!.slice(0, 80)
      const id = randomUUID()
      repo.insert({
        id, owner_id: user.id, profile: input.profile, title: firstLine || 'New session', cwd, mode: input.mode,
        model: input.model, effort: input.effort, permission_mode: input.permissionMode,
      })
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

    async send(user: User, id: string, text: string, images: Image[]) {
      const s = find(user, id)
      requireSend(user, s)
      if (s.mode === 'cli') throw new AppError(409, 'cli_mode', 'This session is open in the CLI. Switch to Chat to send from here.')
      return sendTo(user, s, text, images)
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
      model?: string | null; effort?: string | null; permissionMode?: string
    }) {
      const s = find(user, id)
      const ownerOnly = p.title !== undefined || p.shared !== undefined || p.sharedCanSend !== undefined || p.archived !== undefined
      if (ownerOnly) requireOwner(user, s)
      else requireSend(user, s)
      const patch: Patch = {
        title: p.title?.trim().slice(0, 120) || undefined,
        shared: p.shared === undefined ? undefined : p.shared ? 1 : 0,
        shared_can_send: p.sharedCanSend === undefined ? undefined : p.sharedCanSend ? 1 : 0,
        archived: p.archived === undefined ? undefined : p.archived ? 1 : 0,
        model: p.model, effort: p.effort, permission_mode: p.permissionMode,
      }
      repo.patch(id, patch)
      for (const [key, value] of [['model', p.model], ['effort', p.effort], ['permissionMode', p.permissionMode]] as const) {
        if (value !== undefined && s.mode === 'chat') await agents.request(s.owner_username, { op: 'claude.set', id, key, value })
      }
      if (p.archived) await agents.request(s.owner_username, { op: 'claude.stop', id }).catch(() => {})
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
    profiles: async (user: User) => ({
      ...(await agents.request<{ profiles: unknown[] }>(user.username, { op: 'claude.profiles' })),
      defaults: repo.defaults(user.id),
    }),
    createProfile: (user: User, name: string) => agents.request(user.username, { op: 'claude.profile.create', name }),
    defaults: (user: User) => repo.defaults(user.id),
    saveDefaults: (user: User, d: Defaults) => {
      if (!PROFILE_RE.test(d.profile)) throw new AppError(400, 'bad_profile', 'Unknown profile.')
      repo.saveDefaults(user.id, d)
      return repo.defaults(user.id)
    },
  }
}

export type ClaudeService = ReturnType<typeof claudeService>
