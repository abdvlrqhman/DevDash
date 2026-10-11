import type { Db } from '../../core/db.ts'

export type RoleRow = {
  id: number; project_id: number; name: string; summary: string; instructions: string; model: string | null
  chat_session_id: string | null; created_at: number; updated_at: number; archived: number
}
export type ShiftRow = {
  id: number; role_id: number; session_id: string | null; trigger: string; status: 'running' | 'done' | 'error'
  report: string | null; started_at: number; ended_at: number | null
}

// node:sqlite rows have no prototype; plain objects compare and serialize like any other.
const plain = <T>(r: unknown) => (r ? ({ ...(r as object) } as T) : undefined)
const all = <T>(rows: unknown[]) => rows.map((r) => ({ ...(r as object) }) as T)

export function teamRepo(db: Db) {
  const s = {
    project: db.prepare(`select t.project_id, t.runs_as, t.enabled_at, u.username, u.name from team_projects t join users u on u.id = t.runs_as
      where t.project_id = ?`),
    enable: db.prepare(`insert into team_projects (project_id, runs_as) values (?, ?) on conflict(project_id) do update set runs_as = excluded.runs_as`),
    disable: db.prepare(`delete from team_projects where project_id = ?`),
    brief: db.prepare(`select b.body, b.updated_at, u.name as updated_by from team_briefs b left join users u on u.id = b.updated_by where b.project_id = ?`),
    saveBrief: db.prepare(`insert into team_briefs (project_id, body, updated_by, updated_at) values (?1, ?2, ?3, unixepoch())
      on conflict(project_id) do update set body = ?2, updated_by = ?3, updated_at = unixepoch()`),
    decisions: db.prepare(`select d.id, d.body, d.created_at, u.name as user_name, r.name as role_name from team_decisions d
      left join users u on u.id = d.user_id left join team_roles r on r.id = d.role_id where d.project_id = ? order by d.id desc limit ?`),
    addDecision: db.prepare(`insert into team_decisions (project_id, body, user_id, role_id) values (?, ?, ?, ?)`),
    removeDecision: db.prepare(`delete from team_decisions where id = ? and project_id = ?`),
    roles: db.prepare(`select * from team_roles where project_id = ? and archived = 0 order by id`),
    role: db.prepare(`select * from team_roles where id = ?`),
    roleBySession: db.prepare(`select r.* from team_roles r where r.archived = 0 and (r.chat_session_id = ?1
      or exists (select 1 from team_shifts s where s.role_id = r.id and s.session_id = ?1))`),
    insertRole: db.prepare(`insert into team_roles (project_id, name, summary, instructions, model, created_by) values (?, ?, ?, ?, ?, ?) returning id`),
    updateRole: db.prepare(`update team_roles set name = ?, summary = ?, instructions = ?, model = ?, updated_at = unixepoch() where id = ?`),
    setChat: db.prepare(`update team_roles set chat_session_id = ? where id = ?`),
    archiveRole: db.prepare(`update team_roles set archived = 1, updated_at = unixepoch() where id = ?`),
    notebook: db.prepare(`select n.id, n.body, n.source, n.created_at, u.name as user_name from team_notebook n left join users u on u.id = n.user_id
      where n.role_id = ? order by n.id desc limit ?`),
    addNote: db.prepare(`insert into team_notebook (role_id, body, source, user_id) values (?, ?, ?, ?)`),
    removeNote: db.prepare(`delete from team_notebook where id = ? and role_id = ?`),
    shifts: db.prepare(`select * from team_shifts where role_id = ? order by id desc limit ?`),
    shiftBySession: db.prepare(`select * from team_shifts where session_id = ?`),
    running: db.prepare(`select * from team_shifts where role_id = ? and status = 'running' order by id desc limit 1`),
    lastShiftAt: db.prepare(`select max(started_at) as at from team_shifts where role_id = ? and status != 'running'`),
    insertShift: db.prepare(`insert into team_shifts (role_id, session_id, trigger) values (?, ?, ?) returning id`),
    endShift: db.prepare(`update team_shifts set status = ?, report = coalesce(?, report), ended_at = unixepoch() where id = ? and status = 'running'`),
    report: db.prepare(`update team_shifts set report = ? where id = ?`),
    journal: db.prepare(`select j.id, j.body, j.session_id, j.created_at, u.name as user_name from team_journal j left join users u on u.id = j.user_id
      where j.project_id = ? and j.body != '' and j.created_at >= ? order by j.id desc limit ?`),
    journalUpto: db.prepare(`select max(upto) as upto from team_journal where session_id = ?`),
    addJournal: db.prepare(`insert into team_journal (project_id, session_id, user_id, body, upto) values (?, ?, ?, ?, ?)`),
    session: db.prepare(`select id, status, title, owner_id, project_id, listed from claude_sessions where id = ?`),
  }
  return {
    project: (projectId: number) => plain<{ project_id: number; runs_as: number; enabled_at: number; username: string; name: string }>(s.project.get(projectId)),
    enable: (projectId: number, userId: number) => void s.enable.run(projectId, userId),
    disable: (projectId: number) => void s.disable.run(projectId),
    brief: (projectId: number) => plain<{ body: string; updated_at: number; updated_by: string | null }>(s.brief.get(projectId)),
    saveBrief: (projectId: number, body: string, userId: number | null) => void s.saveBrief.run(projectId, body, userId),
    decisions: (projectId: number, limit = 30) =>
      all<{ id: number; body: string; created_at: number; user_name: string | null; role_name: string | null }>(s.decisions.all(projectId, limit)),
    addDecision: (projectId: number, body: string, by: { userId?: number; roleId?: number }) =>
      void s.addDecision.run(projectId, body, by.userId ?? null, by.roleId ?? null),
    removeDecision: (projectId: number, id: number) => void s.removeDecision.run(id, projectId),
    roles: (projectId: number) => all<RoleRow>(s.roles.all(projectId)),
    role: (id: number) => plain<RoleRow>(s.role.get(id)),
    roleBySession: (sessionId: string) => plain<RoleRow>(s.roleBySession.get(sessionId)),
    insertRole: (projectId: number, r: { name: string; summary: string; instructions: string; model: string | null }, userId: number) =>
      (s.insertRole.get(projectId, r.name, r.summary, r.instructions, r.model, userId) as { id: number }).id,
    updateRole: (id: number, r: { name: string; summary: string; instructions: string; model: string | null }) =>
      void s.updateRole.run(r.name, r.summary, r.instructions, r.model, id),
    setChat: (id: number, sessionId: string) => void s.setChat.run(sessionId, id),
    archiveRole: (id: number) => void s.archiveRole.run(id),
    notebook: (roleId: number, limit = 100) =>
      all<{ id: number; body: string; source: 'role' | 'person'; created_at: number; user_name: string | null }>(s.notebook.all(roleId, limit)),
    addNote: (roleId: number, body: string, by: { userId?: number }) => void s.addNote.run(roleId, body, by.userId ? 'person' : 'role', by.userId ?? null),
    removeNote: (roleId: number, id: number) => void s.removeNote.run(id, roleId),
    shifts: (roleId: number, limit = 20) => all<ShiftRow>(s.shifts.all(roleId, limit)),
    shiftBySession: (sessionId: string) => plain<ShiftRow>(s.shiftBySession.get(sessionId)),
    running: (roleId: number) => plain<ShiftRow>(s.running.get(roleId)),
    lastShiftAt: (roleId: number) => (s.lastShiftAt.get(roleId) as { at: number | null }).at,
    insertShift: (roleId: number, sessionId: string | null, trigger: string) => (s.insertShift.get(roleId, sessionId, trigger) as { id: number }).id,
    endShift: (id: number, status: 'done' | 'error', report: string | null) => Number(s.endShift.run(status, report, id).changes) > 0,
    setReport: (id: number, report: string) => void s.report.run(report, id),
    journal: (projectId: number, since = 0, limit = 30) =>
      all<{ id: number; body: string; session_id: string | null; created_at: number; user_name: string | null }>(s.journal.all(projectId, since, limit)),
    journalUpto: (sessionId: string) => (s.journalUpto.get(sessionId) as { upto: number | null }).upto ?? 0,
    addJournal: (projectId: number, sessionId: string, userId: number, body: string, upto: number) =>
      void s.addJournal.run(projectId, sessionId, userId, body, upto),
    session: (id: string) => plain<{ id: string; status: string; title: string; owner_id: number; project_id: number | null; listed: number }>(s.session.get(id)),
  }
}

export type TeamRepo = ReturnType<typeof teamRepo>
