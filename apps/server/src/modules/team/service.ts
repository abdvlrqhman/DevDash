// Team: AI team members (roles) for a project. Built on DevDash, never the other way round: it starts Claude sessions
// through the Claude service, listens to their turns, and reads projects, activity and tasks. Removing it:
// docs/REMOVING-TEAM.md.
import type { Db } from '../../core/db.ts'
import type { Hub } from '../../core/hub.ts'
import { AppError } from '../../core/http.ts'
import type { ActivityService } from '../activity/service.ts'
import type { User } from '../auth/repo.ts'
import type { ClaudeService, TurnEnd } from '../claude/service.ts'
import type { NotificationKind } from '../notifications/service.ts'
import type { ProjectsService } from '../projects/service.ts'
import type { Priority, TasksService } from '../tasks/service.ts'
import { DIGEST_SYSTEM, GENERATE_SYSTEM, generatePrompt, roleSystem, roleTools, shiftPrompt } from './prompts.ts'
import { teamRepo, type GoalRow, type ProposalKind, type ProposalRow, type RoleRow } from './repo.ts'
import { dueSlots, localParts, nextRun, slotKey, TRIGGERS, validSlots, validTz, type Slot, type Trigger } from './schedule.ts'

export const MODELS = ['opus', 'sonnet', 'haiku'] as const
export const KINDS = ['task', 'code', 'goal', 'other'] as const
const DIGEST_AFTER_MS = 5 * 60_000 // a session quiet this long gets its journal line
const STALE_SHIFT_S = 120
const PROPOSAL_DAYS = 7 // unanswered proposals expire, so stale plans don't run weeks later
const TRIGGER_COOLDOWN_S = 3600 // a trigger wakes a role at most once an hour
const PRIORITIES = new Set<Priority>(['none', 'low', 'medium', 'high', 'urgent'])

export type RoleInput = { name: string; summary: string; instructions: string; model: string | null }
export type RoleSettingsInput = {
  autonomy: 'advisor' | 'operator'; autoApprove: string[]; schedule: unknown[]; triggers: string[]
  paused: boolean; dailyLimit: number; monthlyBudget: number | null
}
export type ProposalInput = {
  kind: ProposalKind; title: string; why: string
  tasks?: { title: string; body?: string; priority?: string }[]
  prompt?: string
  goal?: { title: string; measure?: string; due?: string | null }
  details?: string
}
type Notify = (userId: number, kind: NotificationKind, n: { title: string; body?: string; url?: string; tag?: string }) => Promise<void>

const json = <T>(s: string | null | undefined, fallback: T): T => {
  try {
    return s ? (JSON.parse(s) as T) : fallback
  } catch {
    return fallback
  }
}
const clipText = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/** A Claude transcript as plain lines for a summary: what the person said, what Claude said and did. */
export function transcriptText(messages: unknown[]) {
  const lines: string[] = []
  for (const raw of messages) {
    const m = raw as { type?: string; parent_tool_use_id?: string | null; message?: { content?: unknown } }
    if (m.parent_tool_use_id) continue
    const content = m.message?.content
    const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? (content as Record<string, unknown>[]) : []
    for (const b of blocks) {
      if (b.type === 'text') {
        const text = String(b.text ?? '').replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()
        if (text && !text.startsWith('<')) lines.push(`${m.type === 'user' ? 'Person' : 'Claude'}: ${clipText(text, 600)}`)
      } else if (b.type === 'tool_use' && m.type === 'assistant') {
        const i = (b.input ?? {}) as Record<string, unknown>
        const what = [i.description, i.file_path, i.command, i.pattern, i.url].find((v) => typeof v === 'string') as string | undefined
        lines.push(`Claude used ${String(b.name)}${what ? `: ${clipText(what, 120)}` : ''}`)
      }
    }
  }
  return lines.join('\n')
}

/** Which trigger an activity row is, if any. Rows a role or Claude made ("via Claude") never wake roles. */
export function activityTrigger(a: { kind: string; summary: string; via_claude: number }): Trigger | null {
  if (a.via_claude) return null
  if (a.kind === 'task.created') return 'task_created'
  if ((a.kind === 'task.status' && /to Done$/.test(a.summary)) || a.kind === 'task.closed_by_commit') return 'task_done'
  return null
}

export function teamService({ db, hub, claude, projects, activity, tasks, notify, digestAfterMs = DIGEST_AFTER_MS, tickMs = 60_000 }: {
  db: Db; hub: Hub; claude: ClaudeService; projects: ProjectsService; activity: ActivityService; tasks: TasksService; notify: Notify
  digestAfterMs?: number; tickMs?: number
}) {
  const repo = teamRepo(db)
  hub.authorize('team', () => true)
  const changed = (projectId: number) => hub.publish('team', { type: 'changed', projectId })

  const userById = (id: number) => {
    const u = db.prepare('select id, email, username, name, role from users where id = ? and disabled_at is null').get(id)
    return u ? ({ ...u } as User) : undefined
  }
  const members = () => (db.prepare('select id from users where disabled_at is null').all() as { id: number }[]).map((u) => u.id)
  const profileOf = (u: User) => (claude.defaults(u) as { profile: string }).profile

  /** The project with Team on, and the member its roles run as. */
  function on(slug: string) {
    const p = projects.bySlug(slug)
    const t = repo.project(p.id)
    if (!t) throw new AppError(409, 'team_off', 'Team is off for this project.')
    const runsAs = userById(t.runs_as)
    if (!runsAs) throw new AppError(409, 'no_account', 'The member this team runs as has no account any more. Turn Team off and on again to run it as you.')
    return { p, t, runsAs }
  }
  function findRole(id: number) {
    const r = repo.role(id)
    if (!r || r.archived) throw new AppError(404, 'not_found', 'This role does not exist.')
    const p = db.prepare('select id, slug, name from projects where id = ?').get(r.project_id) as { id: number; slug: string; name: string }
    return { r, p: { ...p } }
  }
  const settingsOf = (r: RoleRow) => ({
    autonomy: r.autonomy === 'advisor' ? 'advisor' as const : 'operator' as const,
    autoApprove: json<string[]>(r.auto_approve, []).filter((k) => (KINDS as readonly string[]).includes(k)),
    schedule: validSlots(json(r.schedule, [])),
    triggers: json<string[]>(r.triggers, []).filter((t): t is Trigger => (TRIGGERS as readonly string[]).includes(t)),
    paused: !!r.paused, dailyLimit: r.daily_limit, monthlyBudget: r.monthly_budget,
  })
  const sessionTools = (r: RoleRow, project: string) => {
    const s = settingsOf(r)
    return { instructions: roleSystem({ ...r, autonomy: s.autonomy, autoApprove: s.autoApprove }, project), toolPolicy: roleTools(s.autonomy) }
  }
  const monthStart = () => {
    const d = new Date()
    return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000)
  }
  const dayStart = () => Math.floor(Date.now() / 86_400_000) * 86_400

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
    const s = settingsOf(r)
    const t = repo.project(r.project_id)
    return {
      id: r.id, name: r.name, summary: r.summary, model: r.model,
      working: !!running || chat?.status === 'working',
      shift: running ? { id: running.id, startedAt: running.started_at, sessionId: running.session_id } : null,
      lastShift: last ? { at: last.ended_at ?? last.started_at, status: last.status, report: last.report } : null,
      chatSessionId: chat ? r.chat_session_id : null,
      ...s,
      nextShiftAt: !s.paused && t && !t.paused ? nextRun(s.schedule, t.tz, Date.now()) : null,
      usage: { costMonth: repo.costSince(r.id, monthStart()), autoShiftsToday: repo.autoShiftsSince(r.id, dayStart()) },
    }
  }

  function journal(projectId: number, since = 0, limit = 30) {
    const lines = [
      ...repo.journal(projectId, since, limit).map((j) => ({ id: `j${j.id}`, kind: 'session' as const, at: j.created_at, text: j.body, who: j.user_name, url: j.session_id ? `/claude/${j.session_id}` : null })),
      ...activity.list(projectId, limit).filter((a) => a.at >= since).map((a) => ({ id: `a${a.id}`, kind: 'activity' as const, at: a.at, text: a.summary, who: a.user, url: a.url })),
    ]
    return lines.sort((a, b) => b.at - a.at).slice(0, limit)
  }

  const goalDto = (g: GoalRow) => ({
    id: g.id, title: g.title, measure: g.measure, due: g.due, status: g.status, progress: g.progress, note: g.note,
    owner: g.owner_name, updatedAt: g.updated_at,
  })
  const proposalDto = (x: ProposalRow) => ({
    id: x.id, kind: x.kind, title: x.title, why: x.why, payload: json<Record<string, unknown>>(x.payload, {}), status: x.status,
    reply: x.reply, outcome: x.outcome, decidedBy: x.decided_by_name, decidedAt: x.decided_at, createdAt: x.created_at, expiresAt: x.expires_at,
    role: { id: x.role_id, name: x.role_name }, project: { slug: x.project_slug, name: x.project_name },
  })

  // ---- Proposals: what roles want that needs a person ----

  /** Carries out an approved (or allowed) proposal as `user`; returns what happened, as Markdown. */
  async function execute(x: ProposalRow, user: User) {
    const payload = json<ProposalInput>(x.payload, { kind: x.kind, title: x.title, why: x.why })
    const actor = { user, viaClaude: true }
    if (x.kind === 'task') {
      const made = (payload.tasks?.length ? payload.tasks : [{ title: x.title, body: x.why }]).slice(0, 10).map((t) => tasks.create(actor, {
        project: x.project_slug, title: t.title.slice(0, 200), body: t.body ?? '', status: 'backlog',
        priority: PRIORITIES.has(t.priority as Priority) ? (t.priority as Priority) : 'none',
      }))
      return `Added ${made.map((t) => `[${t.key}](/tasks/${x.project_slug}/${t.number})`).join(', ')} to the backlog.`
    }
    if (x.kind === 'code') {
      const d = claude.defaults(user) as { profile: string; model: string | null; effort: string | null; permission_mode: string }
      const prompt = `${payload.prompt?.trim() || x.title}\n\n(Proposed by the ${x.role_name} role on the DevDash team, approved by ${user.name}. Work on this branch; commit when done.)`
      const s = await claude.create(user, {
        prompt, images: [], cwd: '', profile: d.profile, model: d.model, effort: d.effort, permissionMode: d.permission_mode,
        mode: 'chat', project: x.project_slug, worktree: true,
      })
      return `Claude started on it in its own branch: [${s.title}](/claude/${s.id}).`
    }
    if (x.kind === 'goal') {
      const g = payload.goal ?? { title: x.title }
      repo.insertGoal(x.project_id, { title: g.title.slice(0, 200), measure: (g.measure ?? '').slice(0, 300), due: validDue(g.due), ownerRoleId: x.role_id })
      return `Goal set: ${g.title}.`
    }
    const t = tasks.create(actor, {
      project: x.project_slug, title: x.title.slice(0, 200), status: 'todo', assignee: user.id,
      body: [x.why, payload.details].filter(Boolean).join('\n\n'),
    })
    return `It's a task for ${user.name}: [${t.key}](/tasks/${x.project_slug}/${t.number}).`
  }
  const validDue = (d: unknown) => (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null)

  async function propose(roleId: number, input: ProposalInput) {
    const { r, p } = findRole(roleId)
    const { runsAs } = on(p.slug)
    const s = settingsOf(r)
    const id = repo.insertProposal({
      projectId: p.id, roleId: r.id, kind: input.kind, title: input.title.trim().slice(0, 200), why: input.why.trim().slice(0, 4000),
      payload: input, expiresAt: Math.floor(Date.now() / 1000) + PROPOSAL_DAYS * 86_400,
    })
    // What the role may do on its own goes ahead now, run as the member the team runs as; the rest waits for a person.
    const alone = (input.kind === 'task' && s.autonomy === 'operator') || s.autoApprove.includes(input.kind)
    if (alone) {
      const outcome = await execute(repo.proposal(id)!, runsAs)
      repo.decide(id, 'done', { outcome, by: null })
      changed(p.id)
      return { status: 'done' as const, outcome }
    }
    for (const uid of members()) {
      void notify(uid, 'needs_you', { title: `${r.name} (${p.name}): ${input.title}`, body: 'Waiting for your approval', url: '/approvals', tag: `team-proposal:${id}` }).catch(() => {})
    }
    changed(p.id)
    hub.publish('team', { type: 'approvals' })
    return { status: 'pending' as const, outcome: null }
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
    if (body) {
      changed(s.project_id)
      wake(s.project_id, 'work', `new work in the project: ${clipText(body.split('\n')[0]!, 120)}`)
    }
  }

  // ---- Working on their own: schedules, triggers and limits ----

  /** Why a role can't start a shift on its own right now, or null when it can. */
  function blocked(r: RoleRow) {
    const t = repo.project(r.project_id)
    if (!t || t.paused || r.paused || r.archived) return 'paused'
    if (settle(r.id)) return 'busy'
    if (repo.autoShiftsSince(r.id, dayStart()) >= r.daily_limit) return 'daily limit'
    if (r.monthly_budget !== null && repo.costSince(r.id, monthStart()) >= r.monthly_budget) return 'monthly budget'
    return null
  }
  function auto(r: RoleRow, label: string) {
    const why = blocked(r)
    if (why) return false
    void runShift(r.id, label).catch((err) => console.error(`team: ${r.name} could not start a shift:`, (err as Error).message))
    return true
  }
  function wake(projectId: number, trigger: Trigger, label: string) {
    const now = Math.floor(Date.now() / 1000)
    for (const r of repo.roles(projectId)) {
      if (!settingsOf(r).triggers.includes(trigger) || now - r.last_triggered < TRIGGER_COOLDOWN_S) continue
      if (auto(r, label)) repo.triggered(r.id, now)
    }
  }

  /** Runs every minute: due schedules, new activity that triggers roles, proposals nobody answered. */
  function tick(now = Date.now()) {
    for (const x of repo.expire(Math.floor(now / 1000))) {
      repo.addNote(x.role_id, `Expired without an answer after ${PROPOSAL_DAYS} days: ${x.title}`, {})
    }
    for (const t of repo.projects()) {
      if (t.paused) continue
      for (const r of repo.roles(t.project_id)) {
        const s = settingsOf(r)
        const due = dueSlots(s.schedule, json<Record<string, string>>(r.schedule_state, {}), t.tz, now)
        if (!due.length || r.paused) continue
        const state = { ...json<Record<string, string>>(r.schedule_state, {}), ...Object.fromEntries(due.map((d) => [slotKey(d.slot), d.date])) }
        repo.scheduleState(r.id, state)
        const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][localParts(t.tz, now).weekday]
        auto(r, `scheduled, ${day} ${due[0]!.slot.at}`)
      }
      const rows = repo.newActivity(t.project_id, t.activity_seen)
      if (!rows.length) continue
      repo.activitySeen(t.project_id, rows.at(-1)!.id)
      for (const a of rows) {
        const trig = activityTrigger(a)
        if (trig) wake(t.project_id, trig, `${trig === 'task_done' ? 'a task was done' : 'a new task'}: ${clipText(a.summary, 120)}`)
      }
    }
  }
  const ticker = setInterval(() => {
    try {
      tick()
    } catch (err) {
      console.error('team tick:', (err as Error).message)
    }
  }, tickMs)
  ticker.unref?.()

  const onTurnEnd = (e: TurnEnd) => {
    const s = e.session
    const shift = repo.shiftBySession(s.id)
    if (shift) {
      if (e.costUsd) repo.addShiftCost(shift.id, e.costUsd)
      if (shift.status === 'running') {
        const fallback = e.result?.trim() || (e.ok ? 'Finished without a report.' : 'The shift stopped with an error.')
        repo.endShift(shift.id, e.ok || e.aborted ? 'done' : 'error', shift.report ? null : fallback)
      }
    }
    const role = shift ? repo.role(shift.role_id) : repo.roleBySession(s.id)
    if (role) changed(role.project_id)
    if (s.listed && s.project_id && repo.project(s.project_id)) scheduleDigest(s.id)
  }
  const stopListening = claude.onTurnEnd(onTurnEnd)

  /** A shift now: the role works on its own in a Claude session nobody is typing in, and reports. */
  async function runShift(id: number, trigger = 'manual') {
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
  }

  return {
    overview(slug: string) {
      const p = projects.bySlug(slug)
      const t = repo.project(p.id)
      const brief = repo.brief(p.id)
      return {
        project: { slug: p.slug, name: p.name },
        enabled: !!t,
        paused: !!t?.paused,
        tz: t?.tz ?? 'UTC',
        runsAs: t ? { id: t.runs_as, name: t.name } : null,
        brief: { body: brief?.body ?? '', updatedAt: brief?.updated_at ?? null, updatedBy: brief?.updated_by ?? null },
        decisions: repo.decisions(p.id).map((d) => ({ id: d.id, body: d.body, at: d.created_at, by: d.role_name ?? d.user_name })),
        roles: t ? repo.roles(p.id).map(roleDto) : [],
        goals: t ? repo.goals(p.id).map(goalDto) : [],
        pending: t ? repo.proposals(p.id, 'pending').length : 0,
        journal: t ? journal(p.id) : [],
      }
    },

    /** Team on for a project; its roles run as whoever turns it on (their Linux account and Claude plan). */
    enable(user: User, slug: string, tz?: string) {
      const p = projects.bySlug(slug)
      const fresh = !repo.project(p.id)
      repo.enable(p.id, user.id)
      // Triggers start from now: turning Team on doesn't replay old activity.
      if (fresh) repo.activitySeen(p.id, repo.lastActivity())
      if (tz && validTz(tz)) repo.projectSettings(p.id, { tz })
      changed(p.id)
    },
    disable(slug: string) {
      const p = projects.bySlug(slug)
      repo.disable(p.id)
      changed(p.id)
    },
    settings(slug: string, o: { paused?: boolean; tz?: string }) {
      const { p } = on(slug)
      if (o.tz !== undefined && !validTz(o.tz)) throw new AppError(400, 'bad_tz', 'Unknown time zone.')
      repo.projectSettings(p.id, o)
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

    addGoal(slug: string, g: { title: string; measure: string; due: string | null }) {
      const { p } = on(slug)
      repo.insertGoal(p.id, { title: g.title.trim(), measure: g.measure.trim(), due: validDue(g.due), ownerRoleId: null })
      changed(p.id)
    },
    updateGoal(id: number, g: { status?: GoalRow['status']; progress?: number; note?: string }) {
      const goal = repo.goal(id)
      if (!goal) throw new AppError(404, 'not_found', 'No such goal.')
      repo.updateGoal(id, g)
      changed(goal.project_id)
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

    createRole(user: User, slug: string, input: RoleInput & { schedule?: unknown[] }) {
      const { p } = on(slug)
      const id = repo.insertRole(p.id, input, user.id)
      if (input.schedule) {
        const r = repo.role(id)!
        repo.roleSettings(id, { ...settingsOf(r), schedule: validSlots(input.schedule) })
      }
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
    roleSettings(id: number, o: RoleSettingsInput) {
      const { r, p } = findRole(id)
      repo.roleSettings(id, {
        autonomy: o.autonomy === 'advisor' ? 'advisor' : 'operator',
        autoApprove: o.autoApprove.filter((k) => k === 'code' || k === 'goal'),
        schedule: validSlots(o.schedule),
        triggers: o.triggers.filter((t) => (TRIGGERS as readonly string[]).includes(t)),
        paused: o.paused, dailyLimit: Math.max(0, Math.min(48, Math.round(o.dailyLimit))),
        monthlyBudget: o.monthlyBudget === null ? null : Math.max(0, o.monthlyBudget),
      })
      const next = repo.role(id)!
      if (r.chat_session_id && repo.session(r.chat_session_id)) claude.configure(r.chat_session_id, sessionTools(next, p.name))
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
      const t = repo.project(p.id)
      return {
        role: { ...roleDto(r), instructions: r.instructions, createdAt: r.created_at },
        project: { slug: p.slug, name: p.name, tz: t?.tz ?? 'UTC', paused: !!t?.paused },
        shifts: repo.shifts(id, 30).map((s) => ({
          id: s.id, trigger: s.trigger, status: s.status, report: s.report, startedAt: s.started_at, endedAt: s.ended_at, sessionId: s.session_id, costUsd: s.cost_usd,
        })),
        notebook: repo.notebook(id).map((n) => ({ id: n.id, body: n.body, by: n.source === 'person' ? n.user_name : null, at: n.created_at })),
        proposals: repo.proposals(p.id, 'pending').filter((x) => x.role_id === id).map(proposalDto),
      }
    },

    runShift: (id: number) => runShift(id),

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

    // ---- Approvals ----
    approvals: (status: 'pending' | 'decided', slug?: string) =>
      repo.proposals(slug ? projects.bySlug(slug).id : null, status, status === 'pending' ? 200 : 40).map(proposalDto),
    pendingCount: () => repo.pendingCount(),
    /** A person answers a proposal. Either way the role finds the answer (and the reason) in its notebook. */
    async decide(user: User, id: number, approve: boolean, reply: string) {
      const x = repo.proposal(id)
      if (!x) throw new AppError(404, 'not_found', 'No such proposal.')
      if (x.status !== 'pending') throw new AppError(409, 'decided', `Already ${x.status === 'expired' ? 'expired' : 'answered'}.`)
      const note = reply.trim()
      if (approve) {
        const outcome = await execute(x, user)
        repo.decide(id, 'done', { reply: note || null, outcome, by: user.id })
        repo.addNote(x.role_id, `Approved by ${user.name}: ${x.title}${note ? `. They said: "${note}"` : ''}`, {})
      } else {
        repo.decide(id, 'rejected', { reply: note || null, by: user.id })
        repo.addNote(x.role_id, `Rejected by ${user.name}: ${x.title}. ${note ? `Reason: "${note}"` : 'No reason given.'}`, {})
      }
      changed(x.project_id)
      hub.publish('team', { type: 'approvals' })
      return proposalDto(repo.proposal(id)!)
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
      const goals = repo.goals(p.id).filter((g) => g.status === 'active')
      const waiting = repo.proposals(p.id, 'pending').filter((x) => x.role_id === r.id)
      const lines = journal(p.id, since, 40)
      const latest = (x: RoleRow) => repo.shifts(x.id, 3).find((s) => s.status !== 'running' && s.report)
      return [
        `# ${p.name}: team context (${day(Date.now() / 1000)} UTC)`,
        `## Brief\n${brief || '(No brief yet. Ask the team for one, or suggest one in your report.)'}`,
        `## Goals\n${goals.length ? goals.map((g) => `- #${g.id} ${g.title}${g.measure ? ` (measure: ${g.measure})` : ''}${g.due ? `, due ${g.due}` : ''}: ${g.progress}%${g.note ? `, ${g.note}` : ''}${g.owner_name ? ` [owner: ${g.owner_name}]` : ''}`).join('\n') : '(none yet: propose some with team_propose, kind "goal")'}`,
        `## Decisions, newest first\n${decisions.length ? decisions.map((d) => `- ${d.body} (${d.role_name ?? d.user_name ?? 'someone'}, ${day(d.created_at)})`).join('\n') : '(none yet)'}`,
        `## The team\n- You: ${r.name}${r.summary ? `: ${r.summary}` : ''}\n${others.map((x) => {
          const s = latest(x)
          return `- ${x.name}${x.summary ? `: ${x.summary}` : ''}${s ? `\n  Latest report (${day(s.ended_at ?? s.started_at)}): ${clipText(s.report!.replace(/\s+/g, ' '), 600)}` : ''}`
        }).join('\n')}`.trim(),
        `## Your proposals waiting for people\n${waiting.length ? waiting.map((x) => `- [${x.kind}] ${x.title} (since ${day(x.created_at)})`).join('\n') : '(none)'}`,
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
    propose,
    /** A role records progress it measured on a goal (it can mark it done, not drop it). */
    roleGoalUpdate(roleId: number, g: { id: number; progress?: number; note?: string; done?: boolean }) {
      const { p } = findRole(roleId)
      const goal = repo.goal(g.id)
      if (!goal || goal.project_id !== p.id) throw new AppError(404, 'not_found', `There is no goal #${g.id} in this project.`)
      repo.updateGoal(g.id, {
        progress: g.progress === undefined ? undefined : Math.max(0, Math.min(100, Math.round(g.progress))),
        note: g.note?.slice(0, 300), status: g.done ? 'done' : undefined,
      })
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
      clearInterval(ticker)
      for (const t of timers.values()) clearTimeout(t)
    },
    digest,
    tick,
  }
}

export type TeamService = ReturnType<typeof teamService>
