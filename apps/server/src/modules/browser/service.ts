import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { AppError } from '../../core/http.ts'
import { requestLine } from '../../core/unix.ts'
import type { User } from '../auth/repo.ts'

const NEKO = 'http://127.0.0.1:8090/browser'
const IDLE_MS = 30 * 60_000
const ENV_FILE = '/etc/devdash/browser.env'

/**
 * The team's shared remote browser: one Chromium (neko) in Docker, started by the root helper when someone opens it
 * and stopped after 30 minutes nobody is watching. Its logins and cookies persist in a volume between runs.
 * DevDash signs members in (neko never sees DevDash credentials) and Caddy only lets signed-in members reach it.
 */
export function browserService({ runDir }: { runDir: string }) {
  let lastSeen = 0
  async function helper<T = Record<string, unknown>>(cmd: string): Promise<T> {
    if (!runDir) throw new AppError(409, 'no_host', 'The browser needs DevDash running on its Linux server.')
    const r = await requestLine<{ ok: boolean; error?: string } & T>(join(runDir, 'helper.sock'), { cmd }, 180_000)
    if (!r.ok) throw new AppError(409, 'browser', r.error?.replace(/^refused: /, '') ?? 'The browser could not start.')
    return r
  }
  const passwords = () => Object.fromEntries(readFileSync(ENV_FILE, 'utf8').split('\n').filter(Boolean).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]))

  async function ready() {
    for (let i = 0; i < 90; i++) {
      try {
        const r = await fetch(`${NEKO}/`, { signal: AbortSignal.timeout(2000) })
        if (r.ok) return
      } catch { /* still starting */ }
      await new Promise((ok) => setTimeout(ok, 1000))
    }
    throw new AppError(409, 'browser', 'The browser is taking too long to start. Try again in a minute.')
  }

  // A browser found running with no viewer on record (e.g. after a DevDash restart) starts its idle countdown now.
  setInterval(() => {
    if (!lastSeen) {
      void helper<{ running: boolean }>('browser-status').then((r) => { if (r.running && !lastSeen) lastSeen = Date.now() }, () => {})
    } else if (Date.now() - lastSeen > IDLE_MS) {
      lastSeen = 0
      void helper('browser-stop').catch((err) => console.error('browser stop:', (err as Error).message))
    }
  }, 60_000).unref()

  return {
    status: async () => ({ running: (await helper<{ running: boolean }>('browser-status')).running }),

    /**
     * Starts it if needed and returns the address that signs this member in (neko's client reads usr/pwd from the URL,
     * then removes them). The password only reaches signed-in members: Caddy lets nobody else near /browser/.
     */
    async open(user: User) {
      await helper('browser-start')
      lastSeen = Date.now()
      await ready()
      const p = passwords()
      const password = user.role === 'admin' ? p.NEKO_MEMBER_MULTIUSER_ADMIN_PASSWORD! : p.NEKO_MEMBER_MULTIUSER_USER_PASSWORD!
      return `/browser/?${new URLSearchParams({ usr: user.name, pwd: password })}`
    },

    heartbeat: () => void (lastSeen = Date.now()),

    async stop() {
      lastSeen = 0
      await helper('browser-stop')
    },
  }
}

export type BrowserService = ReturnType<typeof browserService>
