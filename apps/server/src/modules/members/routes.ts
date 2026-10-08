import { Hono, type Context } from 'hono'
import { z } from 'zod'
import { json } from '../../core/http.ts'
import type { AuthEnv, authMiddleware } from '../auth/routes.ts'
import type { AuthService } from '../auth/service.ts'

const InviteInput = z.object({
  email: z.email().max(254),
  username: z.string().min(2).max(31),
  role: z.enum(['admin', 'member']),
})

export function membersRoutes(auth: AuthService, mw: ReturnType<typeof authMiddleware>, ip: (c: Context) => string, origin: string) {
  return new Hono<AuthEnv>()
    .use(mw.requireUser)
    .get('/', (c) => c.json(auth.members()))
    .post('/invites', mw.requireAdmin, json(InviteInput), (c) => {
      const { token } = auth.createInvite(c.req.valid('json'), c.get('user').id, ip(c))
      return c.json({ link: `${origin}/invite/${token}` })
    })
}
