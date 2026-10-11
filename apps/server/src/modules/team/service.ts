// Team: AI team members (roles) for a project. Built on DevDash, never the other way round: it starts Claude sessions
// through the Claude service, listens to their turns, and reads projects and activity. Removing it: docs/REMOVING-TEAM.md.
import type { Db } from '../../core/db.ts'
import type { Hub } from '../../core/hub.ts'
import { AppError } from '../../core/http.ts'
import type { ActivityService } from '../activity/service.ts'
import type { User } from '../auth/repo.ts'
import type { ClaudeService, TurnEnd } from '../claude/service.ts'
import type { ProjectsService } from '../projects/service.ts'
import { DIGEST_SYSTEM, GENERATE_SYSTEM, ROLE_TOOLS, generatePrompt, roleSystem, shiftPrompt } from './prompts.ts'
import { teamRepo, type RoleRow } from './repo.ts'

export const MODELS = ['opus', 'sonnet', 'haiku'] as const
const DIGEST_AFTER_MS = 5 * 60_000 // a session quiet this long gets its journal line
const STALE_SHIFT_S = 120

export type RoleInput = { name: string; summary: string; instructions: string; model: string | null }

/** A Claude transcript as plain lines for a summary: what the person said, what Claude said and did. */
export function transcriptText(messages: unknown[]) {
  const lines: string[] = []
  const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
  for (const raw of messages) {
    const m = raw as { type?: string; parent_tool_use_id?: string | null; message?: { content?: unknown } }
    if (m.parent_tool_use_id) continue
    const content = m.message?.content
    const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? (content as Record<string, unknown>[]) : []
    for (const b of blocks) {
      if (b.type === 'text') {
        const text = String(b.text ?? '').replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()
        if (text && !text.startsWith('<')) lines.push(`${m.type === 'user' ? 'Person' : 'Claude'}: ${clip(text, 600)}`)
      } else if (b.type === 'tool_use' && m.type === 'assistant') {
        const i = (b.input ?? {}) as Record<string, unknown>
        const what = [i.description, i.file_path, i.command, i.pattern, i.url].find((v) => typeof v === 'string') as string | undefined
        lines.push(`Claude used ${String(b.name)}${what ? `: ${clip(what, 120)}` : ''}`)
      }
    }
  }
  return lines.join('\n')
}

export function teamService({ db, hub, claude, projects, activity, digestAfterMs = DIGEST_AFTER_MS }: {
  db: Db; hub: Hub; claude: ClaudeService; projects: ProjectsService; activity: ActivityService; digestAfterMs?: number
}) {
  const repo = teamRepo(db)
  hub.authorize('team', () => true)
  const changed = (projectId: number) => hub.publish('team', { type: 'changed', projectId })

  const userById = (id: number) => {
    const u = db.prepare('select id, email, username, name, role from users where id = ? and disabled_at is null').get(id)
    return u ? ({ ...u } as User) : undefined
  }
  const profileOf = (u: User) => (claude.defaults(u) as { profile: string }).profile

  /** The project with Team on, and the member its roles run as. */
  function on(slug: string) {
    const p = projects.bySlug(slug)
    const t = repo.project(p.id)
    if (!t) throw new AppError(409, 'team_off', 'Team is off for this project.')
    const runsAs = userById(t.runs_as)
    if (!runsAs) throw new AppError(409, 'no_account', 'The member this team runs as has no account any more. Turn Team off and on again to run it as you.')
    return { p, runsAs }
  }
  function findRole(id: number) {
    const r = repo.role(id)
    if (!r || r.archived) throw new AppError(404, 'not_found', 'This role does not exist.')
    const p = db.prepare('select id, slug, name from projects where id = ?').get(r.project_id) as { id: number; slug: string; name: string }
    return { r, p: { ...p } }
  }
  const sessionTools = (r: RoleRow, project: string) => ({ instructions: roleSystem(r, project), toolPolicy: ROLE_TOOLS })

  /** A shift whose session stopped without telling us (a restart mid-shift) is closed rather than shown running forever. */
  function settle(roleId: number) {
    const run = repo.running(roleId)
    if (!run) return null
    const s = run.session_id ? repo.session(run.session_id) : undefined
    const busy = s && (s.status === 'working' || s.status === 'waiting')
    if (!busy && Date.now() / 1000 - run.started_at > STALE_SHIFT_S) {
      repo.endShift(run.id, s?.status === 'error' ? 'error' : 'done', run.report ? null : 'The shift ended without a report.')
      return null
    }
    return run
  }

  function roleDto(r: RoleRow) {
    const running = settle(r.id)
    const last = repo.shifts(r.id, 3).find((x) => x.status !== 'running')
    const chat = r.chat_session_id ? repo.session(r.chat_session_id) : undefined
    return {
      id: r.id, name: r.name, summary: r.summary, model: r.model,
      working: !!running || chat?.status === 'working',
      shift: running ? { id: running.id, startedAt: running.started_at, sessionId: running.session_id } : null,
      lastShift: last ? { at: last.ended_at ?? last.started_at, status: last.status, report: last.report } : null,
      chatSessionId: chat ? r.chat_session_id : null,
    }
  }

  function journal(projectId: number, since = 0, limit = 30) {
    const lines = [
      ...repo.journal(projectId, since, limit).map((j) => ({ id: `j${j.id}`, kind: 'session' as const, at: j.created_at, text: j.body, who: j.user_name, url: j.session_id ? `/claude/${j.session_id}` : null })),
      ...activity.list(projectId, limit).filter((a) => a.at >= since).map((a) => ({ id: `a${a.id}`, kind: 'activity' as const, at: a.at, text: a.summary, who: a.user, url: a.url })),
    ]
    return lines.sort((a, b) => b.at - a.at).slice(0, limit)
  }

  // ---- The project journal: a line for each stretch of work in the project's Claude sessions ----
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  function scheduleDigest(sessionId: string) {
    clearTimeout(timers.get(sessionId))
    const t = setTimeout(() => {
      timers.delete(sessionId)
      void digest(sessionId).catch((err) => console.error('team journal:', (err as Error).message))
    }, digestAfterMs)
    t.unref?.()
    timers.set(sessionId, t)
  }
  async function digest(sessionId: string) {
    const s = repo.session(sessionId)
    if (!s?.project_id || !s.listed || !repo.project(s.project_id)) return
    if (s.status === 'working' || s.status === 'waiting') return scheduleDigest(sessionId)
    const owner = userById(s.owner_id)
    if (!owner) return
    const messages = await claude.transcript(sessionId)
    const from = repo.journalUpto(sessionId)
    if (messages.length <= from) return
    const text = transcriptText(messages.slice(from))
    let body = ''
    if (text.length >= 80) {
      const out = await claude.complete(owner.username, `Session "${s.title}":\n\n${text.slice(-24_000)}`, { system: DIGEST_SYSTEM, model: 'haiku', profile: profileOf(owner) })
      body = /^NONE\b/.test(out.trim()) ? '' : out.trim().slice(0, 600)
    }
    repo.addJournal(s.project_id, sessionId, owner.id, body, messages.length)
    if (body) changed(s.project_id)
  }

  const onTurnEnd = (e: TurnEnd) => {
    const s = e.session
    const shift = repo.shiftBySession(s.id)
    if (shift?.status === 'running') {
      const fallback = e.result?.trim() || (e.ok ? 'Finished without a report.' : 'The shift stopped with an error.')
      repo.endShift(shift.id, e.ok || e.aborted ? 'done' : 'error', shift.report ? null : fallback)
    }
    const role = shift ? repo.role(shift.role_id) : repo.roleBySession(s.id)
    if (role) changed(role.project_id)
    if (s.listed && s.project_id && repo.project(s.project_id)) scheduleDigest(s.id)
  }
  const stopListening = claude.onTurnEnd(onTurnEnd)

  return {
    overview(slug: string) {
      const p = projects.bySlug(slug)
      const t = repo.project(p.id)
      const brief = repo.brief(p.id)
      return {
        project: { slug: p.slug, name: p.name },
        enabled: !!t,
        runsAs: t ? { id: t.runs_as, name: t.name } : null,
        brief: { body: brief?.body ?? '', updatedAt: brief?.updated_at ?? null, updatedBy: brief?.updated_by ?? null },
        decisions: repo.decisions(p.id).map((d) => ({ id: d.id, body: d.body, at: d.created_at, by: d.role_name ?? d.user_name })),
        roles: t ? repo.roles(p.id).map(roleDto) : [],
        journal: t ? journal(p.id) : [],
      }
    },

    /** Team on for a project; its roles run as whoever turns it on (their Linux account and Claude plan). */
    enable(user: User, slug: string) {
      const p = projects.bySlug(slug)
      repo.enable(p.id, user.id)
      changed(p.id)
    },
    disable(slug: string) {
      const p = projects.bySlug(slug)
      repo.disable(p.id)
      changed(p.id)
    },

    saveBrief(user: User, slug: string, body: string) {
      const p = projects.bySlug(slug)
      repo.saveBrief(p.id, body.trim(), user.id)
      changed(p.id)
    },
    addDecision(user: User, slug: string, body: string) {
      const p = projects.bySlug(slug)
      repo.addDecision(p.id, body.trim(), { userId: user.id })
      changed(p.id)
    },
    removeDecision(slug: string, id: number) {
      const p = projects.bySlug(slug)
      repo.removeDecision(p.id, id)
      changed(p.id)
    },

    /** Instructions for a role, drafted by Claude from its name, one line and what the team knows about the project. */
    async generate(user: User, slug: string, name: string, summary: string) {
      const p = projects.bySlug(slug)
      const prompt = generatePrompt({
        project: p.name, brief: repo.brief(p.id)?.body ?? '', name, summary,
        others: repo.roles(p.id).filter((r) => r.name !== name).map((r) => `${r.name}${r.summary ? ` (${r.summary})` : ''}`),
      })
      return { instructions: await claude.complete(user.username, prompt, { system: GENERATE_SYSTEM, model: 'sonnet', profile: profileOf(user) }) }
    },

    createRole(user: User, slug: string, input: RoleInput) {
      const { p } = on(slug)
      const id = repo.insertRole(p.id, input, user.id)
      changed(p.id)
      return roleDto(repo.role(id)!)
    },
    updateRole(id: number, input: RoleInput) {
      const { r, p } = findRole(id)
      repo.updateRole(id, input)
      const next = repo.role(id)!
      // Its chat picks up the new instructions the next time Claude starts for it.
      if (r.chat_session_id && repo.session(r.chat_session_id)) claude.configure(r.chat_session_id, { title: next.name, ...sessionTools(next, p.name) })
      changed(p.id)
      return roleDto(next)
    },
    archiveRole(id: number) {
      const { p } = findRole(id)
      repo.archiveRole(id)
      changed(p.id)
    },

    role(id: number) {
      const { r, p } = findRole(id)
      return {
        role: { ...roleDto(r), instructions: r.instructions, createdAt: r.created_at },
        project: { slug: p.slug, name: p.name },
        shifts: repo.shifts(id, 30).map((s) => ({
          id: s.id, trigger: s.trigger, status: s.status, report: s.report, startedAt: s.started_at, endedAt: s.ended_at, sessionId: s.session_id,
        })),
        notebook: repo.notebook(id).map((n) => ({ id: n.id, body: n.body, by: n.source === 'person' ? n.user_name : null, at: n.created_at })),
      }
    },

    /** A shift now: the role works on its own in a Claude session nobody is typing in, and reports. */
    async runShift(id: number, trigger = 'manual') {
      const { r, p } = findRole(id)
      const { runsAs } = on(p.slug)
      if (settle(r.id)) throw new AppError(409, 'busy', `${r.name} is already on a shift.`)
      const label = trigger === 'manual' ? 'started by hand' : trigger
      const s = await claude.create(runsAs, {
        prompt: shiftPrompt(label), images: [], cwd: '', profile: profileOf(runsAs), model: r.model, effort: null,
        permissionMode: 'dontAsk', mode: 'chat', project: p.slug,
      }, { title: `${r.name}: shift`, ...sessionTools(r, p.name), listed: false, shared: true })
      repo.insertShift(r.id, s.id, trigger)
      changed(p.id)
      return roleDto(repo.role(id)!)
    },

    /** The role's chat: one long conversation the whole team shares. Made the first time someone opens it. */
    async chat(id: number) {
      const { r, p } = findRole(id)
      if (r.chat_session_id && repo.session(r.chat_session_id)) return { sessionId: r.chat_session_id }
      const { runsAs } = on(p.slug)
      const s = await claude.create(runsAs, {
        prompt: '', images: [], cwd: '', profile: profileOf(runsAs), model: r.model, effort: null,
        permissionMode: 'dontAsk', mode: 'chat', project: p.slug,
      }, { title: r.name, ...sessionTools(r, p.name), listed: false, shared: true, sharedCanSend: true })
      repo.setChat(r.id, s.id)
      changed(p.id)
      return { sessionId: s.id }
    },

    addNote(user: User, id: number, body: string) {
      const { p } = findRole(id)
      repo.addNote(id, body.trim(), { userId: user.id })
      changed(p.id)
    },
    removeNote(id: number, noteId: number) {
      const { p } = findRole(id)
      repo.removeNote(id, noteId)
      changed(p.id)
    },

    // ---- What roles call from their sessions (the DevDash plugin's team tools) ----

    /** The role a session belongs to, if the session is one of its own and runs as `username`. */
    roleOf(username: string, sessionId: string | null) {
      if (!sessionId) return null
      const r = repo.roleBySession(sessionId)
      const s = repo.session(sessionId)
      const owner = s && userById(s.owner_id)
      if (!r || !owner || owner.username !== username) return null
      return { r, p: findRole(r.id).p }
    },

    /** Everything a role reads at the start of a chat or shift, as one Markdown page. */
    context(roleId: number) {
      const { r, p } = findRole(roleId)
      const last = repo.lastShiftAt(r.id)
      const since = last ?? Math.floor(Date.now() / 1000) - 7 * 86_400
      const day = (t: number) => new Date(t * 1000).toISOString().slice(0, 16).replace('T', ' ')
      const brief = repo.brief(p.id)?.body.trim()
      const others = repo.roles(p.id).filter((x) => x.id !== r.id)
      const notes = repo.notebook(r.id, 60)
      const decisions = repo.decisions(p.id, 20)
      const lines = journal(p.id, since, 40)
      return [
        `# ${p.name}: team context (${day(Date.now() / 1000)} UTC)`,
        `## Brief\n${brief || '(No brief yet. Ask the team for one, or suggest one in your report.)'}`,
        `## Decisions, newest first\n${decisions.length ? decisions.map((d) => `- ${d.body} (${d.role_name ?? d.user_name ?? 'someone'}, ${day(d.created_at)})`).join('\n') : '(none yet)'}`,
        `## The team\n- You: ${r.name}${r.summary ? `: ${r.summary}` : ''}\n${others.map((x) => `- ${x.name}${x.summary ? `: ${x.summary}` : ''}`).join('\n')}`.trim(),
        `## Your notebook, newest first\n${notes.length ? notes.map((n) => `- ${n.body}${n.source === 'person' ? ` (${n.user_name ?? 'a person'})` : ''} [${day(n.created_at)}]`).join('\n') : '(empty)'}`,
        `## What happened ${last ? `since your last shift (${day(last)})` : 'in the last 7 days'}\n${lines.length ? lines.map((l) => `- ${day(l.at)} ${l.who ? `${l.who}: ` : ''}${l.text}`).join('\n') : '(nothing recorded)'}`,
        'Tasks and notes: use tasks_list, task_get and notes_list.',
      ].join('\n\n')
    },
    roleNote(roleId: number, body: string) {
      const { p } = findRole(roleId)
      repo.addNote(roleId, body.trim().slice(0, 2000), {})
      changed(p.id)
    },
    roleDecision(roleId: number, body: string) {
      const { p } = findRole(roleId)
      repo.addDecision(p.id, body.trim().slice(0, 2000), { roleId })
      changed(p.id)
    },
    /** The report of the shift this session is; returns false outside a shift. */
    shiftReport(sessionId: string, report: string) {
      const shift = repo.shiftBySession(sessionId)
      if (!shift) return false
      repo.setReport(shift.id, report.trim().slice(0, 8000))
      return true
    },

    /** For tests and shutdown. */
    stop() {
      stopListening()
      for (const t of timers.values()) clearTimeout(t)
    },
    digest,
  }
}

export type TeamService = ReturnType<typeof teamService>
