import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { Hono } from 'hono'
import { openDb } from '../../core/db.ts'
import { previewsService } from './service.ts'

test('previews: only signed members or public services get through, bound to their own host', async () => {
  const db = openDb(':memory:')
  db.prepare("insert into users (id, email, username, name, password_hash, totp_secret, role) values (1, 'a@x.io', 'a', 'A', 'x', 'x', 'member')").run()
  db.prepare("insert into services (name, owner_id, cwd, command, port) values ('shop', 1, '/tmp', 'x', 20999), ('other', 1, '/tmp', 'x', 20998)").run()
  const p = previewsService({ db, masterKey: randomBytes(32), origin: 'https://dev.example.com', template: '{name}.example.com' })
  const app = new Hono().use('*', p.middleware).get('*', (c) => c.text('devdash'))
  const get = (host: string, path = '/', cookie?: string) => app.request(`http://x${path}`, { headers: { host, ...(cookie ? { cookie } : {}) } })

  assert.equal(await (await get('dev.example.com')).text(), 'devdash', "DevDash's own host is never a preview")
  const anon = await get('shop.example.com', '/cart')
  assert.equal(anon.status, 302)
  assert.match(anon.headers.get('location')!, /^https:\/\/dev\.example\.com\/api\/previews\/auth\?host=shop\.example\.com&next=%2Fcart$/)
  assert.equal((await get('nope.example.com')).status, 404)

  // The one-minute ticket becomes a cookie for exactly that host.
  const ticket = new URL(p.ticket(1, 'shop.example.com', '/cart')!)
  const handoff = await get('shop.example.com', `${ticket.pathname}${ticket.search}`)
  assert.equal(handoff.status, 302)
  assert.equal(handoff.headers.get('location'), '/cart')
  const cookie = handoff.headers.get('set-cookie')!.split(';')[0]!
  assert.match(cookie, /^__Host-ddpreview=/)
  assert.equal((await get('other.example.com', '/', cookie)).status, 302, 'a cookie for one service does not open another')
  assert.equal((await get('shop.example.com', '/', '__Host-ddpreview=e30.forged')).status, 302)
  assert.equal((await get('other.example.com', `${ticket.pathname}${ticket.search}`)).status, 401, 'a ticket is bound to its host')
  assert.equal(p.ticket(1, 'shop.example.com', '//evil.com')!.includes('next=%2F%2Fevil'), false, 'no open redirect')

  db.prepare("update users set disabled_at = unixepoch() where id = 1").run()
  assert.equal((await get('shop.example.com', '/', cookie)).status, 302, 'removed members lose access')
})
