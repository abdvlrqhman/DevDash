import { Hono, type Context } from 'hono'
import type { Config } from './core/config.ts'
import type { Db } from './core/db.ts'
import { createHub } from './core/hub.ts'
import { AppError, clientIp, sameOrigin } from './core/http.ts'
import { agentsService } from './modules/agents/service.ts'
import { authMiddleware, authRoutes } from './modules/auth/routes.ts'
import { authService } from './modules/auth/service.ts'
import { claudeRoutes } from './modules/claude/routes.ts'
import { claudeService } from './modules/claude/service.ts'
import { membersRoutes } from './modules/members/routes.ts'
import { provisioningService } from './modules/provisioning/service.ts'
import { terminalsRoutes } from './modules/terminals/routes.ts'
import { terminalsService } from './modules/terminals/service.ts'

export function createApp({ db, config }: { db: Db; config: Config }) {
  const auth = authService({ db, masterKey: config.masterKey, spaceName: config.spaceName })
  const hub = createHub()
  const agents = agentsService({ runDir: config.runDir })
  const provisioning = provisioningService({ db, runDir: config.runDir, onReady: (username) => agents.watch(username) })
  const terms = terminalsService({ agents })
  const claude = claudeService({ db, agents, hub })
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
    .route('/api/auth', authRoutes(auth, mw, ip, (u) => void provisioning.ensure(u)))
    .route('/api/members', membersRoutes(auth, mw, ip, config.origin))
    .route('/api/terminals', terminalsRoutes(terms, auth, mw, provisioning, ip))
    .route('/api/claude', claudeRoutes(claude, mw))

  app.notFound((c) => c.json({ error: { code: 'not_found', message: 'Not found' } }, 404))
  app.onError((err, c) => {
    if (err instanceof AppError) return c.json({ error: { code: err.code, message: err.message } }, err.status)
    console.error(err)
    return c.json({ error: { code: 'internal', message: 'Something went wrong.' } }, 500)
  })

  return { app, auth, provisioning, terms, agents, claude, hub }
}

export type AppType = ReturnType<typeof createApp>['app']
