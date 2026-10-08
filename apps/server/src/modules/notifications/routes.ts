import { Hono } from 'hono'
import { z } from 'zod'
import { json } from '../../core/http.ts'
import type { AuthEnv, authMiddleware } from '../auth/routes.ts'
import type { NotificationsService } from './service.ts'

const Subscription = z.object({
  endpoint: z.url().max(1000).refine((u) => u.startsWith('https://'), 'Push endpoints must be https'),
  keys: z.object({ p256dh: z.string().max(200), auth: z.string().max(100) }),
})
const Prefs = z.object({ needs_you: z.boolean(), finished: z.boolean(), errors: z.boolean(), shared: z.boolean() })

export function notificationsRoutes(n: NotificationsService, mw: ReturnType<typeof authMiddleware>) {
  return new Hono<AuthEnv>()
    .use(mw.requireUser)
    .get('/', (c) => c.json(n.list(c.get('user').id)))
    .post('/read', (c) => {
      n.readAll(c.get('user').id)
      return c.json({ ok: true })
    })
    .get('/prefs', (c) => c.json({ prefs: n.prefs(c.get('user').id), publicKey: n.publicKey }))
    .put('/prefs', json(Prefs), (c) => c.json({ prefs: n.savePrefs(c.get('user').id, c.req.valid('json')) }))
    .post('/subscriptions', json(z.object({ subscription: Subscription, device: z.string().max(200) })), (c) => {
      const { subscription, device } = c.req.valid('json')
      n.subscribe(c.get('user').id, subscription, device)
      return c.json({ ok: true })
    })
    .post('/subscriptions/check', json(z.object({ endpoint: z.string().max(1000) })), (c) =>
      c.json({ subscribed: n.isSubscribed(c.get('user').id, c.req.valid('json').endpoint) }))
    .post('/subscriptions/remove', json(z.object({ endpoint: z.string().max(1000) })), (c) => {
      n.unsubscribe(c.get('user').id, c.req.valid('json').endpoint)
      return c.json({ ok: true })
    })
}
