import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../../core/db.ts'
import { createHub } from '../../core/hub.ts'
import { activityService } from '../activity/service.ts'
import type { AgentEvent, AgentsService } from '../agents/service.ts'
import type { User } from '../auth/repo.ts'
import { claudeService } from '../claude/service.ts'
import type { ProjectsService } from '../projects/service.ts'
import { teamService, transcriptText } from './service.ts'

function setup() {
  const db = openDb(':memory:')
  const add = db.prepare("insert into users (id, email, username, name, password_hash, totp_secret, role) values (?, ?, ?, ?, 'x', 'x', 'admin')")
  add.run(1, 'y@x.io', 'youssef', 'Youssef')
  add.run(2, 'a@x.io', 'abdo', 'Abdulrahman')
  db.prepare("insert into projects (id, slug, name, created_by) values (1, 'seevil', 'Seevil', 1)").run()
  const sent: Record<string, unknown>[] = []
  let onEvent: (username: string, ev: AgentEvent) => void = () => {}
  const replies: Record<string, unknown> = { 'claude.complete': { text: 'Fixed the login timeout. Still open: the retry button text.' } }
  const agents = {
    onEvent: (fn: typeof onEvent) => void (onEvent = fn),
    onRpc: () => {},
    request: async (_u: string, req: Record<string, unknown>) => {
      sent.push(req)
      return replies[String(req.op)] ?? { ok: true }
    },
  } as unknown as AgentsService
  const project = { id: 1, slug: 'seevil', name: 'Seevil' }
  const projects = {
    bySlug: (slug: string) => {
      if (slug !== 'seevil') throw new Error('no project')
      return project
    },
    path: () => '/srv/devdash/projects/seevil',
    forPath: () => project,
    worktree: async () => null,
  } as unknown as ProjectsService
  const hub = createHub()
  const activity = activityService({ db, hub })
  const claude = claudeService({ db, agents, hub, projects, notify: async () => {} })
  const team = teamService({ db, hub, claude, projects, activity, digestAfterMs: 60_000 })
  const user = (id: number, name: string): User => ({ id, name, username: name === 'Youssef' ? 'youssef' : 'abdo', email: '', role: 'admin' })
  return { db, sent, replies, claude, team, youssef: user(1, 'Youssef'), abdo: user(2, 'Abdulrahman'), event: (u: string, ev: AgentEvent) => onEvent(u, ev) }
}

test('a role works a shift: its own unlisted session, read-only tools, a report, and it ends with the turn', async (t) => {
  const { team, claude, sent, youssef, abdo, event } = setup()
  t.after(() => team.stop())
  assert.throws(() => team.createRole(youssef, 'seevil', { name: 'CTO', summary: '', instructions: '', model: null }), /Team is off/)
  team.enable(youssef, 'seevil')
  team.saveBrief(abdo, 'seevil', 'Seevil: an Android app in beta.')
  const cto = team.createRole(abdo, 'seevil', { name: 'CTO', summary: 'Code health and releases', instructions: '## Mission\n- Ship v1', model: 'sonnet' })

  await team.runShift(cto.id)
  const create = sent.find((r) => r.op === 'claude.send')!
  const launch = create.launch as { permissionMode: string; instructions: string; toolPolicy: { tools: string[]; allow: string[] }; model: string }
  assert.equal(launch.permissionMode, 'dontAsk')
  assert.equal(launch.model, 'sonnet')
  assert.match(launch.instructions, /You are CTO, an AI team member of the DevDash project "Seevil"/)
  assert.ok(!launch.toolPolicy.tools.includes('Edit') && !launch.toolPolicy.tools.includes('Write'))
  assert.equal(claude.list(youssef, false).length, 0) // shifts stay out of the session lists

  const role = team.role(cto.id)
  assert.equal(role.role.working, true)
  const sessionId = role.shifts[0]!.sessionId!
  assert.equal(team.roleOf('youssef', sessionId)?.r.name, 'CTO') // runs as the member who turned Team on
  assert.equal(team.roleOf('abdo', sessionId), null)
  assert.match(team.context(cto.id), /Seevil: an Android app in beta/)
  team.roleNote(cto.id, 'Crash-free rate is 97.2% (Play Console, Oct 10).')
  assert.ok(team.shiftReport(sessionId, 'Launch checklist 7 of 10.'))

  event('youssef', { ev: 'claude.msg', id: sessionId, msg: { type: 'result', subtype: 'success', result: 'Done.' } })
  const after = team.role(cto.id)
  assert.equal(after.role.working, false)
  assert.equal(after.shifts[0]!.status, 'done')
  assert.equal(after.shifts[0]!.report, 'Launch checklist 7 of 10.') // the report it wrote, not its last words
  assert.equal(after.notebook[0]!.body, 'Crash-free rate is 97.2% (Play Console, Oct 10).')
  assert.equal(after.notebook[0]!.by, null)
})

test('one shared chat per role that teammates can type in; edited instructions reach it', async (t) => {
  const { team, db, abdo, youssef } = setup()
  t.after(() => team.stop())
  team.enable(youssef, 'seevil')
  const ms = team.createRole(youssef, 'seevil', { name: 'Marketing', summary: '', instructions: 'Post less.', model: null })
  const { sessionId } = await team.chat(ms.id)
  assert.equal((await team.chat(ms.id)).sessionId, sessionId)
  const row = db.prepare('select shared, shared_can_send, listed, title, title_custom, instructions from claude_sessions where id = ?').get(sessionId) as Record<string, unknown>
  assert.deepEqual({ ...row, instructions: undefined }, { shared: 1, shared_can_send: 1, listed: 0, title: 'Marketing', title_custom: 1, instructions: undefined })
  team.updateRole(ms.id, { name: 'Marketing – Social', summary: '', instructions: 'Never post on Fridays.', model: null })
  const next = db.prepare('select title, instructions from claude_sessions where id = ?').get(sessionId) as { title: string; instructions: string }
  assert.equal(next.title, 'Marketing – Social')
  assert.match(next.instructions, /Never post on Fridays/)
  team.addNote(abdo, ms.id, 'Our audience is in Egypt and the Gulf.')
  assert.equal(team.role(ms.id).notebook[0]!.by, 'Abdulrahman')
})

test('the journal: a quiet session in a Team project gets a short summary, once per stretch of work', async (t) => {
  const { team, claude, db, sent, replies, youssef } = setup()
  t.after(() => team.stop())
  team.enable(youssef, 'seevil')
  const s = await claude.create(youssef, {
    prompt: 'Fix the login timeout', images: [], cwd: '', profile: 'default', model: null, effort: null, permissionMode: 'default', mode: 'chat', project: 'seevil',
  })
  const work = [
    { type: 'user', message: { content: 'Fix the login timeout on slow networks' } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: 'app/login.ts' } }, { type: 'text', text: 'Raised the timeout to 30 s and added a retry.' }] } },
  ]
  replies['claude.history'] = { messages: work }
  await team.digest(s.id)
  const journal = team.overview('seevil').journal.filter((j) => j.kind === 'session')
  assert.equal(journal.length, 1)
  assert.match(journal[0]!.text, /login timeout/)
  assert.equal(sent.filter((r) => r.op === 'claude.complete').at(-1)!.model, 'haiku')

  await team.digest(s.id) // nothing new since
  assert.equal(sent.filter((r) => r.op === 'claude.complete').length, 1)
  replies['claude.history'] = { messages: [...work, { type: 'user', message: { content: 'thanks' } }] }
  replies['claude.complete'] = { text: 'NONE' }
  await team.digest(s.id)
  assert.equal(team.overview('seevil').journal.filter((j) => j.kind === 'session').length, 1) // "nothing worth telling" isn't shown
  assert.equal((db.prepare('select max(upto) as n from team_journal').get() as { n: number }).n, 3)
})

test('transcript text keeps what people said and what Claude did, not system reminders or tool output', () => {
  const text = transcriptText([
    { type: 'user', message: { content: 'Ship it <system-reminder>secret</system-reminder>' } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', content: '40 passing' }] } },
    { type: 'assistant', parent_tool_use_id: 'x', message: { content: [{ type: 'text', text: 'subagent noise' }] } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'All tests pass.' }] } },
  ])
  assert.equal(text, 'Person: Ship it\nClaude used Bash: npm test\nClaude: All tests pass.')
})
