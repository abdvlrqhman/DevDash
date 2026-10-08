import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { Hono } from 'hono'
import { openDb } from '../../core/db.ts'
import { servicePages } from './service.ts'

test('services site: members or public only, routed by path, DevDash untouched', async () => {
  // A stand-in service that reports what it received.
  const upstream = createServer((req, res) => {
    if (req.url === '/go-home') return void res.writeHead(302, { location: '/home' }).end()
    res.writeHead(200, { 'content-type': req.url === '/' ? 'text/html' : 'text/plain' })
    res.end(JSON.stringify({ url: req.url, cookie: req.headers.cookie ?? null, prefix: req.headers['x-forwarded-prefix'] }))
  })
  await new Promise<void>((r) => upstream.listen(20990, '127.0.0.1', () => r()))
  try {
    const db = openDb(':memory:')
    db.prepare("insert into users (id, email, username, name, password_hash, totp_secret, role) values (1, 'a@x.io', 'a', 'A', 'x', 'x', 'member')").run()
    db.prepare("insert into services (name, owner_id, cwd, command, port, public) values ('shop', 1, '/tmp', 'x', 20990, 0), ('demo', 1, '/tmp', 'x', 20991, 1)").run()
    const auth = { sessionUser: (t?: string) => (t === 'member-token' ? { user: { id: 1 } } : null) }
    const pages = servicePages({ db, auth: auth as never, origin: 'https://dev.example.com', port: 8443 })
    const app = new Hono().use('*', pages.middleware).get('*', (c) => c.text('devdash'))
    const get = (path: string, headers: Record<string, string> = {}) => app.request(`https://dev.example.com:8443${path}`, { headers: { 'x-devdash-services': '1', ...headers } })

    assert.equal(await (await app.request('https://dev.example.com/service/shop/')).text(), 'devdash', 'without the services mark it is DevDash')
    assert.equal(pages.urlOf('shop'), 'https://dev.example.com:8443/service/shop/')
    assert.equal((await get('/service/shop')).headers.get('location'), '/service/shop/')
    assert.equal((await get('/service/shop/')).status, 401, 'members only')
    assert.equal((await get('/service/nope/')).status, 404)

    const page = await get('/service/shop/', { cookie: '__Host-devdash=member-token; app=1' })
    assert.equal(page.status, 200)
    assert.deepEqual(await page.json(), { url: '/', cookie: 'app=1', prefix: '/service/shop' }, "DevDash's cookie never reaches the service")
    assert.match(page.headers.get('set-cookie') ?? '', /^dd_svc=shop;/)

    const asset = await get('/assets/app.js', { cookie: '__Host-devdash=member-token', referer: 'https://dev.example.com:8443/service/shop/' })
    assert.equal(((await asset.json()) as { url: string }).url, '/assets/app.js', 'absolute paths go to the page’s service')
    assert.equal((await get('/service/shop/go-home', { cookie: '__Host-devdash=member-token' })).headers.get('location'), '/service/shop/home', 'redirects stay inside')

    const pub = await get('/service/demo/') // public, but nothing listens on 20991
    assert.equal(pub.status, 502)
  } finally {
    upstream.close()
  }
})
