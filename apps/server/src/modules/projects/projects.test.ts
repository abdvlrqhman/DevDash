import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../../core/db.ts'
import { createHub } from '../../core/hub.ts'
import { activityService } from '../activity/service.ts'
import type { AgentsService } from '../agents/service.ts'
import type { User } from '../auth/repo.ts'
import { searchService } from '../search/service.ts'
import { tasksService } from '../tasks/service.ts'
import { projectsService } from './service.ts'

test('projects show live Claude work: counts and owners of working or waiting sessions, private ones included', () => {
  const db = openDb(':memory:')
  const user = db.prepare("insert into users (id, email, username, name, password_hash, totp_secret, role) values (?, ?, ?, ?, 'x', 'x', 'admin')")
  user.run(1, 'a@x.io', 'ann', 'Ann Lee')
  user.run(2, 'b@x.io', 'bob', 'Bob Day')
  db.prepare("insert into projects (id, slug, name, created_by) values (1, 'app', 'App', 1), (2, 'site', 'Site', 1)").run()
  const session = db.prepare("insert into claude_sessions (id, owner_id, title, cwd, status, shared, archived, project_id, last_activity_at) values (?, ?, 't', '/x', ?, ?, ?, ?, ?)")
  session.run('s1', 1, 'working', 1, 0, 1, 100)
  session.run('s2', 2, 'waiting', 0, 0, 1, 300) // private: still counted, never listed
  session.run('s3', 2, 'working', 0, 0, 1, 200)
  session.run('s4', 1, 'idle', 0, 0, 1, 50)
  session.run('s5', 1, 'working', 0, 1, 1, 999) // archived: not live
  const hub = createHub()
  const activity = activityService({ db, hub })
  const tasks = tasksService({ db, hub, activity, search: searchService({ db }) })
  const projects = projectsService({ db, hub, agents: {} as AgentsService, activity, tasks, gitSafeDir: async () => {}, root: '/srv/devdash' })

  const [app, site] = projects.list(false, 1)
  assert.equal(app!.sessions, 2) // what Ann can open: her own two, not Bob's private ones
  assert.equal(projects.list(false, 2)[0]!.sessions, 3)
  assert.equal(projects.get('app', 2).sessions, 3)
  assert.equal(app!.live.working, 2)
  assert.equal(app!.live.waiting, 1)
  assert.deepEqual([...app!.live.people].sort(), ['Ann Lee', 'Bob Day'])
  assert.equal(app!.lastSessionAt, 999)
  assert.deepEqual(site!.live, { working: 0, waiting: 0, people: [] })
  assert.equal(site!.lastSessionAt, null)
})

test('create-from-zip inserts the project only after the agent unzips it, and leaves nothing behind on a bad zip', async () => {
  const db = openDb(':memory:')
  db.prepare("insert into users (id, email, username, name, password_hash, totp_secret, role) values (1, 'a@x.io', 'ann', 'Ann Lee', 'x', 'x', 'admin')").run()
  const hub = createHub()
  const activity = activityService({ db, hub })
  const tasks = tasksService({ db, hub, activity, search: searchService({ db }) })
  const calls: object[] = []
  const agents = {
    request: async (_u: string, msg: { op: string; dest?: string }) => {
      calls.push(msg)
      if (msg.op === 'project.fromZip' && (msg.dest ?? '').endsWith('/bad')) throw new Error('The .zip contains unsafe paths. It was not imported.')
      return { defaultBranch: 'main' }
    },
  } as unknown as AgentsService
  const projects = projectsService({ db, hub, agents, activity, tasks, gitSafeDir: async () => {}, root: '/srv/devdash' })
  const ann: User = { id: 1, name: 'Ann Lee', username: 'ann', email: '', role: 'admin' }

  const p = await projects.createFromZip(ann, { name: 'From Zip', slug: 'fromzip', uploadId: 'deadbeef' })
  assert.equal(p.slug, 'fromzip')
  assert.equal(p.repoUrl, null)
  assert.equal(p.defaultBranch, 'main')
  assert.equal(projects.list(false, 1).length, 1)
  assert.ok(calls.some((c) => (c as { op: string }).op === 'project.fromZip'))

  await assert.rejects(projects.createFromZip(ann, { name: 'Bad', slug: 'bad', uploadId: 'deadbeef' }), /unsafe/)
  assert.equal(projects.list(false, 1).length, 1, 'the failed zip left no dangling project')
})

test('connecting an existing project to a repo wires the origin remote, saves the url, and fetches', async () => {
  const db = openDb(':memory:')
  db.prepare("insert into users (id, email, username, name, password_hash, totp_secret, role) values (1, 'a@x.io', 'ann', 'Ann Lee', 'x', 'x', 'admin')").run()
  db.prepare("insert into projects (id, slug, name, repo_url, created_by) values (1, 'zipapp', 'Zip App', null, 1)").run()
  const hub = createHub()
  const activity = activityService({ db, hub })
  const tasks = tasksService({ db, hub, activity, search: searchService({ db }) })
  const calls: { op: string; url?: string }[] = []
  const agents = {
    request: async (_u: string, msg: { op: string; url?: string }) => {
      calls.push(msg)
      if (msg.op === 'git.fetch') return { fetched: true, defaultBranch: 'main' }
      if (msg.op === 'git.refs') return { refs: {} }
      return { ok: true }
    },
  } as unknown as AgentsService
  const projects = projectsService({ db, hub, agents, activity, tasks, gitSafeDir: async () => {}, root: '/srv/devdash' })
  const ann: User = { id: 1, name: 'Ann Lee', username: 'ann', email: '', role: 'admin' }

  assert.equal(projects.get('zipapp').repoUrl, null)
  const p = await projects.connectRepo(ann, 'zipapp', 'https://github.com/acme/zipapp.git')
  assert.equal(p.repoUrl, 'https://github.com/acme/zipapp.git')
  const set = calls.find((c) => c.op === 'git.remote.set')
  assert.ok(set && set.url === 'https://github.com/acme/zipapp.git', 'sets the origin remote to the given url')
  assert.ok(calls.some((c) => c.op === 'git.fetch'), 'fetches once connected')
  assert.equal(projects.bySlug('zipapp').repo_url, 'https://github.com/acme/zipapp.git')
  await assert.rejects(projects.connectRepo(ann, 'zipapp', 'not a url'), /https:\/\/ or git@/)
})

test('how new Claude sessions start out is a project setting any member changes; archiving is not', () => {
  const db = openDb(':memory:')
  const user = db.prepare("insert into users (id, email, username, name, password_hash, totp_secret, role) values (?, ?, ?, ?, 'x', 'x', 'member')")
  user.run(1, 'a@x.io', 'ann', 'Ann Lee')
  user.run(2, 'b@x.io', 'bob', 'Bob Day')
  db.prepare("insert into projects (id, slug, name, created_by) values (1, 'seevil', 'Seevil', 1)").run()
  const hub = createHub()
  const activity = activityService({ db, hub })
  const tasks = tasksService({ db, hub, activity, search: searchService({ db }) })
  const projects = projectsService({ db, hub, agents: {} as AgentsService, activity, tasks, gitSafeDir: async () => {}, root: '/srv/devdash' })
  const bob: User = { id: 2, name: 'Bob Day', username: 'bob', email: '', role: 'member' }

  assert.equal(projects.get('seevil').sessionSharing, 'private')
  assert.equal(projects.update(bob, 'seevil', { sessionSharing: 'shared_can_send' }).sessionSharing, 'shared_can_send')
  assert.equal(projects.update(bob, 'seevil', { name: 'Seevil app' }).sessionSharing, 'shared_can_send') // other changes keep it
  assert.equal(projects.bySlug('seevil').session_sharing, 'shared_can_send')
  assert.throws(() => projects.update(bob, 'seevil', { archived: true }), /Only the person who added it/)
  assert.throws(() => db.prepare("update projects set session_sharing = 'public' where id = 1").run(), /CHECK/)
})
