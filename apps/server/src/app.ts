import { Hono, type Context } from 'hono'
import type { Config } from './core/config.ts'
import type { Db } from './core/db.ts'
import { AppError, clientIp, sameOrigin } from './core/http.ts'
import { authMiddleware, authRoutes } from './modules/auth/routes.ts'
import { authService } from './modules/auth/service.ts'
import { membersRoutes } from './modules/members/routes.ts'

export function createApp({ db, config }: { db: Db; config: Config }) {
  const auth = authService({ db, masterKey: config.masterKey, spaceName: config.spaceName })
  const mw = authMiddleware(auth)
  const ip = (c: Context) => clientIp(c, config.trustCfIp)

  const app = new Hono()
    // Public: lets the native shell check that a domain is a DevDash space before loading it.
    .get('/.well-known/devdash.json', (c) => {
      c.header('access-control-allow-origin', '*')
      c.header('cache-control', 'no-store')
      return c.json({ app: 'devdash', name: config.spaceName, version: config.version, api: 1 })
    })
    .use('/api/*', sameOrigin(config.origin))
    .route('/api/auth', authRoutes(auth, mw, ip))
    .route('/api/members', membersRoutes(auth, mw, ip, config.origin))

  app.notFound((c) => c.json({ error: { code: 'not_found', message: 'Not found' } }, 404))
  app.onError((err, c) => {
    if (err instanceof AppError) return c.json({ error: { code: err.code, message: err.message } }, err.status)
    console.error(err)
    return c.json({ error: { code: 'internal', message: 'Something went wrong.' } }, 500)
  })

  return { app, auth }
}

export type AppType = ReturnType<typeof createApp>['app']
