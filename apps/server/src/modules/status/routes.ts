import { Hono } from 'hono'
import type { AuthEnv, authMiddleware } from '../auth/routes.ts'
import type { StatusService } from './service.ts'

export function statusRoutes(status: StatusService, mw: ReturnType<typeof authMiddleware>) {
  return new Hono<AuthEnv>()
    .use(mw.requireUser)
    .get('/', async (c) => c.json(await status.get(c.get('user').role === 'admin')))
    .post('/claude-update', mw.requireAdmin, async (c) => {
      await status.updateClaude()
      return c.json({ ok: true })
    })
    .post('/backup', mw.requireAdmin, async (c) => {
      await status.backupNow()
      return c.json({ ok: true })
    })
}
