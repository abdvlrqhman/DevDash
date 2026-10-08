import { Hono } from 'hono'
import type { AuthEnv, authMiddleware } from '../auth/routes.ts'
import type { BrowserService } from './service.ts'

export function browserRoutes(browser: BrowserService, mw: ReturnType<typeof authMiddleware>) {
  return new Hono<AuthEnv>()
    // Caddy asks this before every /browser/ request (forward_auth): only signed-in members get through.
    .get('/check', mw.requireUser, (c) => c.body(null, 204))
    .use(mw.requireUser)
    .get('/', async (c) => c.json(await browser.status()))
    .post('/open', async (c) => c.json({ url: await browser.open(c.get('user')) }))
    .post('/heartbeat', (c) => {
      browser.heartbeat()
      return c.json({ ok: true })
    })
    .post('/stop', async (c) => {
      await browser.stop()
      return c.json({ ok: true })
    })
}
