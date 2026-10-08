import type { Db } from '../../core/db.ts'

export type SessionStatus = 'working' | 'waiting' | 'idle' | 'stopped' | 'error'
export type SessionRow = {
  id: string
  owner_id: number
  owner_username: string
  owner_name: string
  profile: string
  title: string
  title_custom: number
  cwd: string
  mode: 'chat' | 'cli'
  status: SessionStatus
  status_detail: string | null
  model: string | null
  effort: string | null
  permission_mode: string
  started: number
  shared: number
  shared_can_send: number
  archived: number
  created_at: number
  last_activity_at: number
  project_id: number | null
  worktree: string | null
  project_slug: string | null
  project_name: string | null
}
export type Defaults = { profile: string; model: string | null; effort: string | null; permission_mode: string; open_in: 'chat' | 'cli' }

const SELECT = `select s.*, u.username as owner_username, u.name as owner_name, p.slug as project_slug, p.name as project_name
  from claude_sessions s join users u on u.id = s.owner_id left join projects p on p.id = s.project_id`

// Columns a PATCH may touch; anything else is ignored.
const PATCHABLE = ['title', 'title_custom', 'shared', 'shared_can_send', 'archived', 'model', 'effort', 'permission_mode', 'mode', 'started'] as const
export type Patch = Partial<Pick<SessionRow, (typeof PATCHABLE)[number]>>

export function claudeRepo(db: Db) {
  const s = {
    byId: db.prepare(`${SELECT} where s.id = ?`),
    visible: db.prepare(`${SELECT} where (s.owner_id = ?1 or s.shared = 1) and s.archived = ?2 order by s.last_activity_at desc limit 200`),
    ownedActive: db.prepare(`${SELECT} where u.username = ? and s.archived = 0`),
    insert: db.prepare(`insert into claude_sessions (id, owner_id, profile, title, cwd, mode, model, effort, permission_mode)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    status: db.prepare(`update claude_sessions set status = ?, status_detail = ?, mode = ?, last_activity_at = unixepoch() where id = ?`),
    touch: db.prepare(`update claude_sessions set last_activity_at = unixepoch() where id = ?`),
    setProject: db.prepare(`update claude_sessions set project_id = ?, worktree = ? where id = ?`),
    addSender: db.prepare(`insert or ignore into claude_message_senders (session_id, message_uuid, user_id) values (?, ?, ?)`),
    senders: db.prepare(`select m.message_uuid, u.id, u.name from claude_message_senders m join users u on u.id = m.user_id where m.session_id = ?`),
    defaults: db.prepare(`select profile, model, effort, permission_mode, open_in from claude_defaults where user_id = ?`),
    saveDefaults: db.prepare(`insert into claude_defaults (user_id, profile, model, effort, permission_mode, open_in) values (?1, ?2, ?3, ?4, ?5, ?6)
      on conflict(user_id) do update set profile = ?2, model = ?3, effort = ?4, permission_mode = ?5, open_in = ?6`),
  }
  return {
    byId: (id: string) => s.byId.get(id) as SessionRow | undefined,
    visible: (userId: number, archived: boolean) => s.visible.all(userId, archived ? 1 : 0) as SessionRow[],
    ownedActive: (username: string) => s.ownedActive.all(username) as SessionRow[],
    insert: (r: Pick<SessionRow, 'id' | 'owner_id' | 'profile' | 'title' | 'cwd' | 'mode' | 'model' | 'effort' | 'permission_mode'>) =>
      void s.insert.run(r.id, r.owner_id, r.profile, r.title, r.cwd, r.mode, r.model, r.effort, r.permission_mode),
    setStatus: (id: string, status: SessionStatus, detail: string | null, mode: 'chat' | 'cli') => void s.status.run(status, detail, mode, id),
    touch: (id: string) => void s.touch.run(id),
    setProject: (id: string, projectId: number | null, worktree: string | null) => void s.setProject.run(projectId, worktree, id),
    patch(id: string, p: Patch) {
      const keys = PATCHABLE.filter((k) => p[k] !== undefined)
      if (!keys.length) return
      db.prepare(`update claude_sessions set ${keys.map((k) => `${k} = ?`).join(', ')} where id = ?`)
        .run(...keys.map((k) => p[k] as string | number | null), id)
    },
    addSender: (sessionId: string, uuid: string, userId: number) => void s.addSender.run(sessionId, uuid, userId),
    senders: (sessionId: string) =>
      Object.fromEntries((s.senders.all(sessionId) as { message_uuid: string; id: number; name: string }[]).map((r) => [r.message_uuid, { id: r.id, name: r.name }])),
    defaults: (userId: number): Defaults =>
      (s.defaults.get(userId) as Defaults | undefined) ?? { profile: 'default', model: null, effort: null, permission_mode: 'bypassPermissions', open_in: 'chat' },
    saveDefaults: (userId: number, d: Defaults) => void s.saveDefaults.run(userId, d.profile, d.model, d.effort, d.permission_mode, d.open_in),
  }
}
