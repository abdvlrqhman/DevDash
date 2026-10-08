import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../../core/db.ts'
import { sharesService } from './shares.ts'

const body = (text: string) => new Response(text).body!
const read = async (s: ReadableStream<Uint8Array>) => new Response(s).text()

test('share links: snapshot, password, download limit, revoke', async () => {
  const db = openDb(':memory:')
  db.prepare("insert into users (id, email, username, name, password_hash, totp_secret, role) values (1, 'a@x.io', 'a', 'Ann', 'x', 'x', 'member')").run()
  const shares = sharesService({ db, dataDir: mkdtempSync(join(tmpdir(), 'dd-')), masterKey: randomBytes(32), origin: 'https://dev.example.com' })
  const me = { id: 1, role: 'member' as const }

  const s = await shares.create(me, { name: 'app.apk', source: '/home/a/app.apk', body: body('hello apk'), password: 'pw', expires: '1d', maxDownloads: 1 })
  assert.equal(s.size, 9)
  const token = s.url.split('/s/')[1]!
  const r = shares.lookup(token)!
  assert.ok(r)
  assert.equal(await shares.checkPassword(r, 'nope'), false)
  assert.equal(await shares.checkPassword(r, 'pw'), true)
  assert.equal(await read(shares.open(r)), 'hello apk')
  assert.equal(shares.lookup(token), null, 'one download allowed')
  assert.equal(shares.lookup('not-a-token'), null)

  const t = await shares.create(me, { name: 'x.txt', source: 'x', body: body('x'), expires: 'never' })
  await shares.revoke(me, t.id)
  assert.equal(shares.lookup(t.url.split('/s/')[1]!), null)
  assert.deepEqual(shares.list(me).map((x) => x.name), ['app.apk'])
})
