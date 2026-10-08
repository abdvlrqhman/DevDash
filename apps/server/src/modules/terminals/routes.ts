import { Hono } from 'hono'
import { z } from 'zod'
import { AppError, json } from '../../core/http.ts'
import type { AuthEnv, authMiddleware } from '../auth/routes.ts'
import type { AuthService } from '../auth/service.ts'
import type { TerminalsService } from './service.ts'

export function terminalsRoutes(terms: TerminalsService, auth: AuthService, mw: ReturnType<typeof authMiddleware>) {
  return new Hono<AuthEnv>()
    .use(mw.requireUser)
    .get('/', async (c) => c.json({ terminals: await terms.list(c.get('user').username) }))
    .delete('/:name', async (c) => {
      await terms.kill(c.get('user').username, c.req.param('name'))
      return c.json({ ok: true })
    })
    .post('/admin/unlock', mw.requireAdmin, json(z.object({ code: z.string().max(10) })), (c) => {
      if (!auth.verifyFreshTotp(c.get('user').id, c.req.valid('json').code.trim())) {
        throw new AppError(400, 'bad_code', 'That code is not valid. Wait for the next one and try again.')
      }
      terms.unlockAdmin(c.get('sessionToken'))
      return c.json({ ok: true })
    })
}
