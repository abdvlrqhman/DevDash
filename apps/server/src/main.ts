import { serve } from '@hono/node-server'
import { join } from 'node:path'
import { createApp } from './app.ts'
import { loadConfig } from './core/config.ts'
import { openDb } from './core/db.ts'

const config = loadConfig()
const db = openDb(join(config.dataDir, 'devdash.db'))
const { app, auth } = createApp({ db, config })

const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: config.port }, (info) =>
  console.log(`devdash ${config.version} listening on 127.0.0.1:${info.port}`))

setInterval(() => auth.cleanup(), 3_600_000).unref()

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    server.close()
    db.close()
    process.exit(0)
  })
}
