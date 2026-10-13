import { test } from 'node:test'
import { Hono, type Context, type Next } from 'hono'
import assert from 'node:assert/strict'
import { openDb } from '../../core/db.ts'
import { createHub } from '../../core/hub.ts'
import { activityService } from '../activity/service.ts'
import type { AgentEvent, AgentsService } from '../agents/service.ts'
import type { User } from '../auth/repo.ts'
import { claudeService } from '../claude/service.ts'
import type { ProjectsService } from '../projects/service.ts'
import { searchService } from '../search/service.ts'
import { tasksService } from '../tasks/service.ts'
import { roleSessions } from './index.ts'
import { dueSlots, nextRun } from './schedule.ts'
import { fetchHttp, readOnlySql } from './sources.ts'
import { teamRoutes } from './routes.ts'
import { activityTrigger, teamService, transcriptText } from './service.ts'

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
  const tasks = tasksService({ db, hub, activity, search: searchService({ db }) })
  const notified: { userId: number; title: string }[] = []
  const claude = claudeService({ db, agents, hub, projects, notify: async () => {} })
  const team = teamService({
    db, hub, claude, projects, activity, tasks, notify: async (userId, _k, n) => void notified.push({ userId, title: n.title }),
    agents, masterKey: Buffer.alloc(32, 7), digestAfterMs: 60_000, tickMs: 3_600_000,
  })
  const user = (id: number, name: string): User => ({ id, name, username: name === 'Youssef' ? 'youssef' : 'abdo', email: '', role: 'admin' })
  return {
    db, sent, replies, claude, team, tasks, notified, youssef: user(1, 'Youssef'), abdo: user(2, 'Abdulrahman'),
    event: (u: string, ev: AgentEvent) => onEvent(u, ev),
  }
}
const shiftsOf = (sent: Record<string, unknown>[]) => sent.filter((r) => r.op === 'claude.send' && String((r.content as { text?: string }[])[0]?.text ?? '').startsWith('Start your shift'))

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

test('threads: a session raises an alert with a role, the owner wakes, people hear about it, and roles can\'t argue forever', async (t) => {
  const { team, claude, sent, notified, db, youssef } = setup()
  t.after(() => team.stop())
  team.enable(youssef, 'seevil')
  const ceo = team.createRole(youssef, 'seevil', { name: 'CEO', summary: '', instructions: '', model: null })
  const ms = team.createRole(youssef, 'seevil', { name: 'Marketing – Social', summary: '', instructions: '', model: null })
  const fin = team.createRole(youssef, 'seevil', { name: 'Finance', summary: '', instructions: '', model: null })
  assert.equal(team.overview('seevil').roles.find((r) => r.id === ceo.id)!.lead, true) // the first CEO leads

  const s = await claude.create(youssef, { prompt: 'Build the stats page', images: [], cwd: '', profile: 'default', model: null, effort: null, permissionMode: 'default', mode: 'chat', project: 'seevil' })
  assert.ok(team.sessionAuthor('youssef', s.id))
  assert.throws(() => team.sessionMessage('youssef', s.id, { to: 'marketing', title: 'Last 3 videos: 1k views, 0 likes', kind: 'alert', body: 'Views but no likes.' }), /evidence/)
  const first = team.sessionMessage('youssef', s.id, {
    to: 'marketing', cc: ['finance'], title: 'Last 3 videos: 1k views, 0 likes', kind: 'alert', body: 'Our last 3 videos have views but no likes.', evidence: 'Beta walkthrough 1,204 views 0 likes; Dark mode 1,051 views 0 likes',
  })
  const th = team.thread(first.thread)
  assert.equal(th.thread.owner!.name, 'Marketing – Social')
  assert.deepEqual(th.thread.roles.map((r) => r.name).sort(), ['Finance', 'Marketing – Social'])
  assert.match(th.messages[0]!.author, /^Claude session "Build the stats page" \(Youssef\)$/)
  assert.ok(notified.some((n) => /^Alert in Seevil: Last 3 videos/.test(n.title)))
  await new Promise((r) => setTimeout(r, 10))
  assert.match(String((shiftsOf(sent).at(-1)!.content as { text: string }[])[0]!.text), new RegExp(`thread #${first.thread}`)) // owner woken about it

  // The same issue again joins the open thread.
  const again = team.sessionMessage('youssef', s.id, { to: 'marketing', title: 'last 3 videos: 1k views, 0 likes ', kind: 'fyi', body: 'Still no likes.', evidence: 'same numbers' })
  assert.equal(again.thread, first.thread)

  // Roles talking among themselves stop after 6 messages without a person, and the thread waits for people.
  for (let i = 0; i < 6; i++) team.roleMessage(i % 2 ? fin.id : ms.id, 'x', { thread: first.thread, kind: 'reply', body: `point ${i}` })
  assert.equal(team.thread(first.thread).thread.needsPeople, true)
  assert.throws(() => team.roleMessage(ms.id, 'x', { thread: first.thread, kind: 'reply', body: 'one more' }), /waits for people/)
  assert.ok(notified.some((n) => /needs a person/.test(n.title)))

  // A person answers: the thread opens up again for roles, and only the owner closes it.
  db.prepare("update team_shifts set status = 'done', ended_at = unixepoch()").run()
  team.postAsPerson(youssef, 'seevil', { thread: first.thread, kind: 'reply', body: 'Pause the promotion.' })
  team.roleMessage(ms.id, 'x', { thread: first.thread, kind: 'reply', body: 'Done.' })
  assert.throws(() => team.roleResolve(fin.id, first.thread, 'x'), /Only the owner/)
  team.roleResolve(ms.id, first.thread, 'Promotion paused; bot traffic reported.')
  assert.equal(team.thread(first.thread).thread.status, 'resolved')
  assert.match(team.roleThread(ms.id, first.thread), /Resolved: Promotion paused/)

  // Five alerts a day per sender, then requests.
  for (let i = 0; i < 4; i++) team.sessionMessage('youssef', s.id, { to: 'finance', title: `alert ${i}`, kind: 'alert', body: 'x', evidence: 'y' })
  assert.throws(() => team.sessionMessage('youssef', s.id, { to: 'finance', title: 'alert 5', kind: 'alert', body: 'x', evidence: 'y' }), /5 alerts today/)
})

test('closing threads: the owner as done, a role in it declines with a reason, people see it quietly, reopen it and list them all', async (t) => {
  const { team, notified, db, youssef } = setup()
  t.after(() => team.stop())
  team.enable(youssef, 'seevil')
  const ceo = team.createRole(youssef, 'seevil', { name: 'CEO', summary: '', instructions: '', model: null })
  const cto = team.createRole(youssef, 'seevil', { name: 'CTO', summary: '', instructions: '', model: null })
  const mkt = team.createRole(youssef, 'seevil', { name: 'Marketing', summary: '', instructions: '', model: null })
  const fin = team.createRole(youssef, 'seevil', { name: 'Finance', summary: '', instructions: '', model: null })
  const a = team.roleMessage(ceo.id, 'x', { to: 'marketing', cc: ['cto'], title: 'Post the v1 release on TikTok', kind: 'request', body: 'v1 is out.', evidence: 'tag v1.0.0' })

  assert.throws(() => team.roleResolve(fin.id, a.thread, 'Not mine.', 'declined'), /not in thread #\d+/) // not in it
  assert.throws(() => team.roleResolve(cto.id, a.thread, 'Posted.'), /Only the owner \(Marketing\) closes this thread as done/)
  assert.throws(() => team.roleResolve(cto.id, a.thread, '  ', 'not_needed'), /Say why/)
  const quiet = notified.length
  team.roleResolve(cto.id, a.thread, 'Our app isn\'t for the TikTok crowd.', 'not_needed')
  let th = team.thread(a.thread)
  assert.equal(th.thread.status, 'resolved')
  assert.equal(th.thread.closedAs, 'not_needed')
  assert.equal(th.thread.closedBy, 'CTO')
  assert.equal(th.messages.at(-1)!.body, 'Closed as not needed: Our app isn\'t for the TikTok crowd.')
  assert.equal(notified.length, quiet) // nobody's phone goes off for a decline
  assert.match(team.context(ceo.id), /closed since your last shift[^]*#\d+ Post the v1 release on TikTok: closed as not needed by CTO/)
  assert.throws(() => team.roleMessage(ceo.id, 'x', { thread: a.thread, kind: 'reply', body: 'But…' }), /is resolved/)
  assert.throws(() => team.roleResolve(mkt.id, a.thread, 'Posted.'), /already closed/)

  // A person replying reopens it and clears how it was closed; then the owner closes it as done (no `as`: done).
  db.prepare("update team_shifts set status = 'done', ended_at = unixepoch()").run()
  team.postAsPerson(youssef, 'seevil', { thread: a.thread, kind: 'reply', body: 'We are on TikTok now. Post it.' })
  th = team.thread(a.thread)
  assert.deepEqual([th.thread.status, th.thread.closedAs, th.thread.closedBy], ['open', null, null])
  team.roleResolve(mkt.id, a.thread, 'Posted.')
  assert.deepEqual([team.thread(a.thread).thread.closedAs, team.thread(a.thread).thread.resolution], ['done', 'Posted.'])

  // A duplicate points at the other thread; Reopen says who reopened it.
  const b = team.roleMessage(ceo.id, 'x', { to: 'marketing', title: 'TikTok post for v1', kind: 'request', body: 'Post it.', evidence: 'tag v1.0.0' })
  assert.throws(() => team.roleResolve(ceo.id, b.thread, 'Same.', 'duplicate', 9999), /no other thread #9999/)
  team.roleResolve(ceo.id, b.thread, 'Same request.', 'duplicate', a.thread)
  th = team.thread(b.thread)
  assert.equal(th.thread.resolution, `Duplicate of #${a.thread} (Post the v1 release on TikTok): Same request.`)
  assert.match(th.messages.at(-1)!.body, new RegExp(`^Closed as a duplicate of #${a.thread} `))
  team.reopen(youssef, b.thread)
  th = team.thread(b.thread)
  assert.deepEqual([th.thread.status, th.thread.closedAs, th.messages.at(-1)!.body], ['open', null, 'Reopened by Youssef.'])

  // Waiting for people: no role closes it.
  const c = team.roleMessage(ceo.id, 'x', { to: 'finance', title: 'Cloud bill doubled', kind: 'fyi', body: 'See the invoice.', evidence: '$80 → $160' })
  db.prepare('update team_threads set needs_people = 1 where id = ?').run(c.thread)
  assert.throws(() => team.roleResolve(fin.id, c.thread, 'Fine.'), /waits for people/)

  // The full list: waiting first, then open, then closed; filters by status, outcome, role and title.
  const ids = (r: ReturnType<typeof team.threads>) => r.threads.map((x) => x.id)
  assert.deepEqual(ids(team.threads('seevil', { status: 'all' })), [c.thread, b.thread, a.thread])
  assert.deepEqual(ids(team.threads('seevil', { status: 'open' })), [c.thread, b.thread])
  assert.deepEqual(ids(team.threads('seevil', { status: 'waiting' })), [c.thread])
  assert.deepEqual(ids(team.threads('seevil', { status: 'closed' })), [a.thread])
  assert.deepEqual(ids(team.threads('seevil', { status: 'all', outcome: 'done' })), [a.thread])
  assert.deepEqual(ids(team.threads('seevil', { status: 'all', outcome: 'declined' })), [])
  assert.deepEqual(ids(team.threads('seevil', { status: 'all', role: cto.id })), [a.thread])
  assert.deepEqual(ids(team.threads('seevil', { status: 'all', q: 'tiktok' })), [b.thread, a.thread])
  assert.deepEqual(team.threads('seevil', { status: 'all' }).counts, { open: 2, waiting: 1, closed: 1, all: 3 })
  for (let i = 0; i < 30; i++) team.roleMessage(ceo.id, 'x', { to: 'cto', title: `Check ${i}`, kind: 'fyi', body: 'x', evidence: 'y' })
  const page = team.threads('seevil', { status: 'all' })
  assert.equal(page.threads.length, 30)
  assert.equal(page.next, 30)
  const rest = team.threads('seevil', { status: 'all' }, page.next!)
  assert.equal(rest.next, null)
  assert.equal(rest.threads.at(-1)!.id, a.thread) // closed ones last

  // Over HTTP: the query string is checked and numbers come through.
  const app = new Hono().route('/', teamRoutes(team, { requireUser: async (cx: Context, next: Next) => { cx.set('user', youssef); await next() } } as never))
  const res = await app.request(`/projects/seevil/threads?status=closed&outcome=done&role=${cto.id}&q=TikTok&offset=0`)
  assert.deepEqual((await res.json() as { threads: { id: number }[] }).threads.map((x) => x.id), [a.thread])
})

test('the lead\'s shift report goes to everyone as the digest', async (t) => {
  const { team, notified, youssef, event } = setup()
  t.after(() => team.stop())
  team.enable(youssef, 'seevil')
  const ceo = team.createRole(youssef, 'seevil', { name: 'CEO', summary: '', instructions: '', model: null })
  await team.runShift(ceo.id)
  const sessionId = team.role(ceo.id).shifts[0]!.sessionId!
  team.shiftReport(sessionId, '**This week**: v1 on track; sign-ups behind.')
  event('youssef', { ev: 'claude.msg', id: sessionId, msg: { type: 'result', subtype: 'success', result: 'ok' } })
  assert.deepEqual(notified.map((n) => n.title), ['Seevil: CEO\'s digest', 'Seevil: CEO\'s digest'])
  assert.match(team.overview('seevil').digest!.report, /v1 on track/)
})

test('sources: one read-only statement, API calls stay under the base URL, keys never reach roles', async (t) => {
  const { team, replies, youssef } = setup()
  t.after(() => team.stop())
  assert.equal(readOnlySql('select count(*) from users;'), 'select count(*) from users')
  assert.throws(() => readOnlySql('delete from users'), /Only reading/)
  assert.throws(() => readOnlySql('select 1; drop table users'), /One statement/)
  assert.throws(() => readOnlySql('with x as (delete from users returning *) select * from x'), /no statements that change/)
  assert.equal(readOnlySql("select * from posts where title = 'how to delete an account'"), "select * from posts where title = 'how to delete an account'")
  await assert.rejects(fetchHttp({ baseUrl: 'https://api.example.com/v3/' }, 'k', '../../admin'), /Stay under/)
  await assert.rejects(fetchHttp({ baseUrl: 'https://api.example.com/v3/' }, 'k', 'https://evil.example/steal'), /Stay under/)

  team.enable(youssef, 'seevil')
  team.addSource(youssef, 'seevil', { name: 'YouTube', kind: 'http', description: 'Our channel stats', config: { baseUrl: 'https://www.googleapis.com/youtube/v3/', secretIn: 'query', secretName: 'key' }, secret: 'AIza-secret' })
  team.addSource(youssef, 'seevil', { name: 'App DB', kind: 'sqlite', description: 'Sign-ups', config: { path: '/srv/devdash/projects/seevil/data.db' } })
  const [app, yt] = team.overview('seevil').sources
  assert.equal(yt!.hasSecret, true)
  assert.ok(!JSON.stringify(team.overview('seevil')).includes('AIza-secret'))
  const ms = team.createRole(youssef, 'seevil', { name: 'Marketing', summary: '', instructions: '', model: null })
  assert.match(team.roleSources(ms.id), /YouTube \(API under https:\/\/www\.googleapis\.com\/youtube\/v3\/: team_fetch/)
  assert.match(team.context(ms.id), /App DB \(sqlite\): Sign-ups/)
  replies['sqlite.query'] = { fields: ['day', 'signups'], rows: [['2026-10-10', 12], ['2026-10-11', 15]], total: 2 }
  assert.equal(await team.roleRead(ms.id, 'app db', { sql: 'select day, count(*) from signups group by day' }), '["day","signups"]\n["2026-10-10",12]\n["2026-10-11",15]')
  await assert.rejects(team.roleRead(ms.id, 'App DB', { sql: 'update signups set x = 1' }), /Only reading/)
  assert.equal(app!.name, 'App DB')
})

test('each answer\'s time, tokens and cost are saved and come back after the answer in a reload; background tasks show and stop', async (t) => {
  const { team, claude, sent, replies, youssef, event } = setup()
  t.after(() => team.stop())
  const s = await claude.create(youssef, { prompt: 'Fix login', images: [], cwd: '', profile: 'default', model: null, effort: null, permissionMode: 'default', mode: 'chat', project: 'seevil' })
  // A brand-new session: its first answer's cost is the running total; the next one is the difference. The model is the
  // answer's own, not the first of every model the session used (Claude Code also uses a small one for titles).
  const answer = (n: number, total: number) => {
    event('youssef', { ev: 'claude.msg', id: s.id, msg: { type: 'assistant', uuid: `a${n}`, parent_tool_use_id: null, message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Done.' }] } } })
    event('youssef', { ev: 'claude.msg', id: s.id, msg: {
      type: 'result', uuid: `r${n}`, subtype: 'success', is_error: false, duration_ms: 252_000, total_cost_usd: total, num_turns: 9, devdash_fresh: true,
      usage: { input_tokens: 120, output_tokens: 3100, cache_read_input_tokens: 80_000, cache_creation_input_tokens: 4000 }, modelUsage: { 'claude-haiku-5-5': {}, 'claude-opus-5-5': {} },
    } })
  }
  answer(0, 0.30)
  answer(1, 0.72)
  replies['claude.history'] = { messages: [
    { type: 'user', uuid: 'p1', message: { content: 'Fix login' }, timestamp: '2026-10-12T11:11:00Z' },
    { type: 'assistant', uuid: 'a1', message: { content: [{ type: 'thinking', thinking: 'Check the timeout', signature: 'x'.repeat(2000) }, { type: 'redacted_thinking', data: 'y' }] }, timestamp: '2026-10-12T11:15:00Z' },
  ], more: true }
  const h = await claude.history(youssef, s.id)
  assert.equal(h.more, true)
  assert.deepEqual((h.messages[1] as { message: { content: unknown[] } }).message.content, [{ type: 'thinking', thinking: 'Check the timeout' }]) // no signatures
  const [, , r] = h.messages as Record<string, unknown>[]
  assert.deepEqual({ type: r!.type, uuid: r!.uuid, ms: r!.duration_ms, model: r!.turn_model }, { type: 'result', uuid: 'r1', ms: 252_000, model: 'claude-opus-5-5' })
  assert.equal(Math.round((r!.turn_cost_usd as number) * 100), 42) // 0.72 - 0.30
  assert.deepEqual(r!.usage, { input_tokens: 120, output_tokens: 3100, cache_read_input_tokens: 80_000, cache_creation_input_tokens: 4000 })
  assert.equal(sent.filter((x) => x.op === 'claude.history').at(-1)!.turns, 10) // pages of 10 prompts
  await claude.history(youssef, s.id, 'p1')
  assert.equal(sent.filter((x) => x.op === 'claude.history').at(-1)!.before, 'p1')

  event('youssef', { ev: 'claude.tasks', id: s.id, tasks: [{ id: 'b1', type: 'local_bash', description: 'npm run dev' }] })
  assert.deepEqual((await claude.get(youssef, s.id)).session.tasks, [{ id: 'b1', type: 'local_bash', description: 'npm run dev' }])
  await claude.stopTask(youssef, s.id, 'b1')
  assert.deepEqual(sent.at(-1), { op: 'claude.task.stop', id: s.id, taskId: 'b1' })
})

test('a person\'s Claude session can create and change roles when asked; a role\'s own session can\'t', async (t) => {
  const { team, claude, notified, youssef } = setup()
  t.after(() => team.stop())
  team.enable(youssef, 'seevil')
  const s = await claude.create(youssef, { prompt: 'Set up the team', images: [], cwd: '', profile: 'default', model: null, effort: null, permissionMode: 'default', mode: 'chat', project: 'seevil' })
  const out = await team.sessionCreateRole('youssef', s.id, { name: 'Finance', summary: 'Spending and revenue', instructions: '## Mission\n- Watch costs' })
  assert.match(out, /Created #\d+ Finance/)
  const fin = team.overview('seevil').roles.find((r) => r.name === 'Finance')!
  assert.deepEqual(fin.schedule, [{ days: [1, 2, 3, 4, 5], at: '09:00' }])
  assert.ok(notified.some((n) => n.title === 'Seevil: Youssef\'s Claude added a role'))
  await assert.rejects(team.sessionCreateRole('youssef', s.id, { name: 'finance' }), /already a role called/)

  team.sessionUpdateRole('youssef', s.id, { role: 'fin', paused: true, model: 'haiku', schedule: [{ days: [5], at: '17:00' }] })
  const after = team.overview('seevil').roles.find((r) => r.name === 'Finance')!
  assert.deepEqual({ paused: after.paused, model: after.model, schedule: after.schedule }, { paused: true, model: 'haiku', schedule: [{ days: [5], at: '17:00' }] })
  assert.match(team.sessionRoles('youssef', s.id), /#\d+ Finance: Spending and revenue\n {2}works: paused/)

  await team.runShift(fin.id)
  const shiftSession = team.role(fin.id).shifts[0]!.sessionId!
  assert.equal(team.sessionAuthor('youssef', shiftSession), null) // a role's session is not a person's
  assert.throws(() => team.sessionRoles('youssef', shiftSession), /not in a project with Team on/)
})

test('a person\'s Claude session connects data sources (the key can come later, from the person); a role\'s can\'t', async (t) => {
  const { team, claude, notified, youssef, replies } = setup()
  t.after(() => team.stop())
  team.enable(youssef, 'seevil')
  const s = await claude.create(youssef, { prompt: 'Connect our database', images: [], cwd: '', profile: 'default', model: null, effort: null, permissionMode: 'default', mode: 'chat', project: 'seevil' })
  assert.equal(team.sessionSources('youssef', s.id), 'No data sources yet. Add one with team_source_add.')

  // A database without its connection string: added, and the person is told where to paste it.
  const added = team.sessionAddSource('youssef', s.id, { name: 'App DB', kind: 'postgres', description: 'Sign-ups and shops', config: {} })
  assert.match(added, /Added #\d+ App DB\. .*ask Youssef to paste it on the Team tab \(Data sources → App DB → Key\)/)
  assert.ok(notified.some((n) => n.title === 'Seevil: Youssef\'s Claude added a data source'))
  assert.match(team.sessionSources('youssef', s.id), /#\d+ App DB \(postgres\): Postgres database; NO KEY YET\n {2}Sign-ups and shops/)
  assert.match(await team.sessionTestSource('youssef', s.id, 'app db'), /has no connection string yet/)

  team.sessionAddSource('youssef', s.id, { name: 'YouTube', kind: 'http', description: '', config: { baseUrl: 'https://www.googleapis.com/youtube/v3/', secretIn: 'query', secretName: 'key' }, secret: 'AIza-from-the-person' })
  assert.match(team.sessionSources('youssef', s.id), /YouTube \(http\): API under https:\/\/www\.googleapis\.com\/youtube\/v3\/, key in parameter key; key set/)
  assert.ok(!team.sessionSources('youssef', s.id).includes('AIza'), 'keys never come back')

  // Changing where it reads keeps the key; a new name can't take another source's.
  assert.equal(team.sessionUpdateSource('youssef', s.id, 'YouTube', { description: 'Our channel', config: { baseUrl: 'https://www.googleapis.com/youtube/v3/' } }), 'Updated YouTube.')
  assert.equal(team.overview('seevil').sources.find((x) => x.name === 'YouTube')!.hasSecret, true)
  assert.throws(() => team.sessionUpdateSource('youssef', s.id, 'YouTube', { name: 'app db' }), /already a source called/)
  replies['sqlite.query'] = { fields: ['name'], rows: [['users']], total: 1 }
  team.sessionAddSource('youssef', s.id, { name: 'Local', kind: 'sqlite', description: '', config: { path: '/srv/devdash/projects/seevil/app.db' } })
  assert.equal(await team.sessionTestSource('youssef', s.id, 'Local'), '["name"]\n["users"]')
  assert.equal(team.sessionRemoveSource('youssef', s.id, 'Local'), 'Removed Local. Roles no longer see it.')
  assert.throws(() => team.sessionRemoveSource('youssef', s.id, 'Local'), /no source Local/)

  // A role's own session is not a person's: it can't change the team's setup.
  const role = team.createRole(youssef, 'seevil', { name: 'CTO', summary: '', instructions: '', model: null })
  await team.runShift(role.id)
  const shiftSession = team.role(role.id).shifts[0]!.sessionId!
  assert.throws(() => team.sessionAddSource('youssef', shiftSession, { name: 'X', kind: 'page', description: '', config: { url: 'https://x.io' } }), /not in a project with Team on/)
})

test('schedules are read in the project time zone, run once per slot and day, and catch up after a short restart', () => {
  const cairoMon0900 = Date.parse('2026-10-12T06:00:00Z') // Cairo is UTC+3 on this date: Monday 09:00 there
  const slots = [{ days: [1], at: '09:00' }]
  assert.equal(dueSlots(slots, {}, 'Africa/Cairo', cairoMon0900).length, 1)
  assert.equal(dueSlots(slots, {}, 'Africa/Cairo', cairoMon0900 + 15 * 60_000).length, 1) // back within 20 minutes
  assert.equal(dueSlots(slots, {}, 'Africa/Cairo', cairoMon0900 + 40 * 60_000).length, 0)
  assert.equal(dueSlots(slots, { '1@09:00': '2026-10-12' }, 'Africa/Cairo', cairoMon0900).length, 0)
  assert.equal(dueSlots(slots, {}, 'UTC', cairoMon0900).length, 0)
  assert.equal(nextRun(slots, 'Africa/Cairo', cairoMon0900 - 60_000), cairoMon0900 / 1000)
  assert.equal(nextRun(slots, 'Africa/Cairo', cairoMon0900), cairoMon0900 / 1000 + 7 * 86_400)
  assert.equal(nextRun([{ days: [0, 1, 2, 3, 4, 5, 6], at: '07:30' }], 'Asia/Kolkata', Date.parse('2026-10-12T00:00:00Z')), Date.parse('2026-10-12T02:00:00Z') / 1000)
})

test('roles start shifts on their own: on schedule, on triggers, within their daily limit, never while paused', async (t) => {
  const { team, sent, db, youssef } = setup()
  t.after(() => team.stop())
  team.enable(youssef, 'seevil', 'UTC')
  const cto = team.createRole(youssef, 'seevil', { name: 'CTO', summary: '', instructions: '', model: null })
  team.roleSettings(cto.id, { autonomy: 'operator', autoApprove: [], schedule: [{ days: [0, 1, 2, 3, 4, 5, 6], at: '09:00' }], triggers: ['task_done'], paused: false, dailyLimit: 2, monthlyBudget: null })
  const nine = Date.parse('2026-10-12T09:00:00Z')
  const text = (i: number) => String((shiftsOf(sent)[i]!.content as { text: string }[])[0]!.text)
  const doneAll = () => db.prepare("update team_shifts set status = 'done', ended_at = unixepoch()").run()
  const taskDone = (n: number) => db.prepare(`insert into activity (project_id, user_id, kind, summary) values (1, 1, 'task.status', 'moved seevil#${n} to Done')`).run()
  team.tick(nine)
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(shiftsOf(sent).length, 1)
  assert.match(text(0), /scheduled, Mon 09:00/)
  team.tick(nine + 60_000) // same slot, same day: not again
  assert.equal(shiftsOf(sent).length, 1)

  doneAll()
  taskDone(3)
  team.tick(nine + 120_000)
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(shiftsOf(sent).length, 2)
  assert.match(text(1), /a task was done: moved seevil#3 to Done/)

  doneAll()
  db.prepare('update team_roles set last_triggered = 0').run()
  taskDone(4)
  team.tick(nine + 180_000)
  assert.equal(shiftsOf(sent).length, 2) // daily limit of 2 reached

  db.prepare('update team_shifts set started_at = started_at - 86400').run() // a new day
  team.settings('seevil', { paused: true })
  taskDone(5)
  team.tick(nine + 240_000)
  assert.equal(shiftsOf(sent).length, 2) // paused team: nothing on its own
  assert.equal(activityTrigger({ kind: 'task.created', summary: 'created x', via_claude: 1 }), null) // roles' own tasks never wake roles
})

test('proposals: an operator adds tasks itself; code waits for a person, runs as them, and the answer reaches the notebook', async (t) => {
  const { team, sent, tasks, notified, youssef, abdo } = setup()
  t.after(() => team.stop())
  team.enable(youssef, 'seevil')
  const cto = team.createRole(youssef, 'seevil', { name: 'CTO', summary: '', instructions: '', model: null })

  const own = await team.propose(cto.id, { kind: 'task', title: 'Crash fixes', why: '14 crashes', tasks: [{ title: 'Fix login crash on Android 12', priority: 'high' }] })
  assert.equal(own.status, 'done')
  assert.equal(tasks.list({ project: 'seevil', status: 'backlog' })[0]!.title, 'Fix login crash on Android 12')
  assert.equal(notified.length, 0)

  const code = await team.propose(cto.id, {
    kind: 'code', title: 'Add a retry button to login', why: 'Users on slow networks get stuck.',
    prompt: 'Add a retry button to the login screen when the request times out; test it on a throttled network.',
  })
  assert.equal(code.status, 'pending')
  assert.deepEqual(notified.map((n) => n.userId).sort(), [1, 2])
  const [x] = team.approvals('pending')
  assert.equal(x!.role.name, 'CTO')
  const done = await team.decide(abdo, x!.id, true, 'Keep it small')
  assert.equal(done.status, 'done')
  assert.match(done.outcome!, /Claude started on it/)
  const started = sent.filter((r) => r.op === 'claude.send').at(-1)!
  assert.match(String((started.content as { text: string }[])[0]!.text), /Add a retry button.*approved by Abdulrahman/s)
  assert.match(team.role(cto.id).notebook[0]!.body, /Approved by Abdulrahman: Add a retry button to login\. They said: "Keep it small"/)

  await team.propose(cto.id, { kind: 'other', title: 'Post the release on Instagram', why: 'v1.2 is out' })
  const other = team.approvals('pending')[0]!
  await team.decide(youssef, other.id, false, 'not before v1')
  assert.match(team.role(cto.id).notebook[0]!.body, /Rejected by Youssef: Post the release on Instagram\. Reason: "not before v1"/)
  await assert.rejects(team.decide(youssef, other.id, true, ''), /Already answered/)
})

test('a session started off an approved code proposal is marked and grouped on its own, not blended into the approver\'s', async (t) => {
  const { team, claude, youssef, abdo } = setup()
  t.after(() => team.stop())
  team.enable(youssef, 'seevil')
  const cto = team.createRole(youssef, 'seevil', { name: 'CTO', summary: '', instructions: '', model: null })
  const code = await team.propose(cto.id, { kind: 'code', title: 'Add a retry button to login', why: 'Users get stuck.', prompt: 'Add a retry button to the login screen.' })
  assert.equal(code.status, 'pending')
  const [x] = team.approvals('pending')
  assert.equal((await team.decide(abdo, x!.id, true, '')).status, 'done')

  // The session the approver now owns carries where it came from, titled after the role so it reads well.
  const s = claude.list(abdo, false).find((s) => s.origin?.kind === 'proposal')!
  assert.deepEqual(s.origin, { kind: 'proposal', role: 'CTO' })
  assert.equal(s.title, 'CTO: Add a retry button to login')

  // On the project's Claude page it's its own kind, not the approver's 'mine'.
  const row = claude.inProject(abdo, 'seevil', false).sessions.find((r) => r.id === s.id)!
  assert.equal(row.kind, 'proposal')
  assert.deepEqual(row.role, { name: 'CTO' })
})

test('advisors only suggest; goals are proposed, approved and updated by the role; unanswered proposals expire', async (t) => {
  const { team, tasks, youssef, db } = setup()
  t.after(() => team.stop())
  team.enable(youssef, 'seevil')
  const ceo = team.createRole(youssef, 'seevil', { name: 'CEO', summary: '', instructions: '', model: null })
  team.roleSettings(ceo.id, { autonomy: 'advisor', autoApprove: [], schedule: [], triggers: [], paused: false, dailyLimit: 6, monthlyBudget: null })
  assert.equal((await team.propose(ceo.id, { kind: 'task', title: 'Write a privacy policy', why: 'Play Store requires it' })).status, 'pending')
  assert.equal(tasks.list({ project: 'seevil' }).length, 0)

  await team.propose(ceo.id, { kind: 'goal', title: 'v1 on the Play Store', why: 'Launch', goal: { title: 'v1 on the Play Store', measure: 'Live in the store', due: '2026-11-15' } })
  const goal = team.approvals('pending').find((p) => p.kind === 'goal')!
  await team.decide(youssef, goal.id, true, '')
  const [g] = team.overview('seevil').goals
  assert.deepEqual({ title: g!.title, due: g!.due, owner: g!.owner }, { title: 'v1 on the Play Store', due: '2026-11-15', owner: 'CEO' })
  team.roleGoalUpdate(ceo.id, { id: g!.id, progress: 70, note: '7 of 10 launch checks' })
  assert.equal(team.overview('seevil').goals[0]!.progress, 70)

  db.prepare("update team_proposals set expires_at = 1 where status = 'pending'").run()
  team.tick()
  assert.equal(team.approvals('pending').length, 0)
  assert.match(team.role(ceo.id).notebook[0]!.body, /Expired without an answer/)
})

test('a project\'s Claude page shows each role\'s chat and shifts, unlisted as they are, named after the role', async (t) => {
  const { team, db, claude, youssef, abdo } = setup()
  t.after(() => team.stop())
  claude.labelSessions(roleSessions(db))
  team.enable(youssef, 'seevil')
  const cto = team.createRole(youssef, 'seevil', { name: 'CTO', summary: '', instructions: '', model: null })
  await team.runShift(cto.id)
  const { sessionId } = await team.chat(cto.id)
  const { sessions } = claude.inProject(abdo, 'seevil', false)
  assert.deepEqual(sessions.map((s) => [s.kind, s.role?.name, s.id === sessionId]).sort(), [['role', 'CTO', true], ['shift', 'CTO', false]])
})
