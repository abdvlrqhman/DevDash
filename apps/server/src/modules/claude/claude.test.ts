import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../../core/db.ts'
import { createHub } from '../../core/hub.ts'
import type { AgentsService } from '../agents/service.ts'
import type { User } from '../auth/repo.ts'
import type { ProjectsService } from '../projects/service.ts'
import { claudeService } from './service.ts'

function setup() {
  const db = openDb(':memory:')
  const add = db.prepare("insert into users (id, email, username, name, password_hash, totp_secret, role) values (?, ?, ?, ?, 'x', 'x', 'member')")
  add.run(1, 'a@x.io', 'ann', 'Ann')
  add.run(2, 'b@x.io', 'bob', 'Bob')
  add.run(3, 'c@x.io', 'cat', 'Cat')
  db.prepare("insert into claude_sessions (id, owner_id, title, cwd, shared, started) values ('s1', 1, 'Fix login', '/home/ann', 1, 1)").run()
  const notified: { userId: number; title: string }[] = []
  const sent: Record<string, unknown>[] = []
  const agents = {
    onEvent: () => {},
    request: async (_u: string, req: Record<string, unknown>) => {
      sent.push(req)
      return { ok: true }
    },
  } as unknown as AgentsService
  const claude = claudeService({
    db, agents, hub: createHub(), projects: {} as ProjectsService,
    notify: async (userId, _kind, n) => void notified.push({ userId, title: n.title }),
  })
  const user = (id: number, name: string): User => ({ id, name, username: name.toLowerCase(), email: '', role: 'member' })
  return { claude, notified, sent, ann: user(1, 'Ann'), bob: user(2, 'Bob'), cat: user(3, 'Cat') }
}

test('watching a shared session: ask to join, the owner lets one person in, only they can send', async () => {
  const { claude, notified, ann, bob, cat } = setup()
  assert.equal((await claude.get(bob, 's1')).canSend, false)
  claude.askToJoin(bob, 's1')
  claude.askToJoin(bob, 's1') // a second tap within a minute doesn't notify again
  assert.deepEqual(notified.map((n) => n.userId), [1])

  assert.throws(() => claude.setWriter(bob, 's1', 2, true), /Only the owner/)
  assert.deepEqual(claude.setWriter(ann, 's1', 2, true).writers, [{ id: 2, name: 'Bob' }])
  assert.equal((await claude.get(bob, 's1')).canSend, true)
  assert.equal((await claude.get(cat, 's1')).canSend, false)
  assert.throws(() => claude.askToJoin(bob, 's1'), /already/)

  claude.setWriter(ann, 's1', 2, false)
  assert.equal((await claude.get(bob, 's1')).canSend, false)
})

test('comments: anyone who can see the session; the owner hears about others', async () => {
  const { claude, notified, ann, bob } = setup()
  claude.comment(bob, 's1', '  Try the staging DB first  ')
  claude.comment(ann, 's1', 'On it')
  const { comments } = claude.comments(bob, 's1')
  assert.deepEqual(comments.map((c) => [c.user.name, c.body]), [['Bob', 'Try the staging DB first'], ['Ann', 'On it']])
  assert.deepEqual(notified, [{ userId: 1, title: 'Bob commented on Fix login' }])
  assert.equal((await claude.get(ann, 's1')).comments, 2)
})

test('attachments: PDFs and text become documents, other files are saved in the owner account', async () => {
  const { claude, sent, ann } = setup()
  const b64 = (s: string) => Buffer.from(s).toString('base64')
  await claude.send(ann, 's1', 'Look at these', [], [
    { name: 'spec.pdf', mediaType: 'application/pdf', data: b64('%PDF-1.4') },
    { name: 'notes.md', mediaType: '', data: b64('# Notes') },
    { name: '../../etc/data.zip', mediaType: 'application/zip', data: b64('PK\0\0') },
  ])
  const write = sent.find((r) => r.op === 'fs.write')!
  assert.match(String(write.path), /^\/home\/ann\/\.cache\/devdash\/uploads\/s1\/[0-9a-f]{8}\/data\.zip$/)
  const msg = sent.find((r) => r.op === 'claude.send')!
  const content = msg.content as { type: string; title?: string; text?: string; source?: { type: string } }[]
  assert.deepEqual(content.map((c) => [c.type, c.title ?? null, c.source?.type ?? null]), [
    ['document', 'spec.pdf', 'base64'], ['document', 'notes.md', 'text'], ['text', null, null],
  ])
  assert.match(content[2]!.text!, /^Look at these\n\nAttached files, saved on this server:\n- \/home\/ann\/.+\/data\.zip$/)
})

test('fast mode and Remote Control: fast is for anyone who can send, Remote Control only for the owner', async () => {
  const { claude, sent, ann, bob } = setup()
  claude.setWriter(ann, 's1', 2, true)
  const s = await claude.update(bob, 's1', { fastMode: true })
  assert.equal(s.fastMode, true)
  assert.deepEqual(sent.filter((r) => r.op === 'claude.set').map((r) => [r.key, r.value]), [['fast', true]])
  await assert.rejects(claude.update(bob, 's1', { remoteControl: true }), /Only the owner/)
})
