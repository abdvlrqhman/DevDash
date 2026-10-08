import type { IncomingMessage, Server } from 'node:http'
import { STATUS_CODES } from 'node:http'
import type { Duplex } from 'node:stream'
import { parse as parseCookies } from 'hono/utils/cookie'
import { WebSocketServer, type WebSocket } from 'ws'
import type { AuthService } from '../auth/service.ts'
import { ADMIN_TERMINAL, TERMINAL_NAME_RE, type TerminalsService } from './service.ts'

const PATH_RE = /^\/api\/terminals\/([a-z0-9][a-z0-9-]{0,30})\/ws$/
const clamp = (v: string | null, min: number, max: number, dflt: number) => {
  const n = Number(v)
  return Number.isInteger(n) ? Math.min(max, Math.max(min, n)) : dflt
}

/**
 * Browser terminal ↔ member's agent. Auth happens before the upgrade is accepted:
 * exact Origin match (cross-site WebSocket hijacking) and a valid session cookie.
 */
export function attachTerminalSockets(server: Server, deps: { auth: AuthService; terms: TerminalsService; origin: string }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 })

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const reject = (code: number) => {
      socket.end(`HTTP/1.1 ${code} ${STATUS_CODES[code]}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
    }
    const url = new URL(req.url ?? '/', 'http://localhost')
    const m = PATH_RE.exec(url.pathname)
    if (!m) return reject(404)
    if (req.headers.origin !== deps.origin) return reject(403)
    const token = parseCookies(req.headers.cookie ?? '', '__Host-devdash')['__Host-devdash']
    const session = deps.auth.sessionUser(token)
    if (!session) return reject(401)

    const name = m[1]!
    const admin = name === ADMIN_TERMINAL
    if (admin && (session.user.role !== 'admin' || !deps.terms.isAdminUnlocked(token!))) return reject(403)
    if (!TERMINAL_NAME_RE.test(name)) return reject(400)

    wss.handleUpgrade(req, socket, head, (ws) => bridge(ws, deps.terms, session.user.username, {
      name, admin,
      cols: clamp(url.searchParams.get('cols'), 10, 500, 80),
      rows: clamp(url.searchParams.get('rows'), 4, 200, 24),
    }))
  })
}

function bridge(ws: WebSocket, terms: TerminalsService, username: string, attach: { name: string; cols: number; rows: number; admin: boolean }) {
  let agent: ReturnType<TerminalsService['open']>
  try {
    agent = terms.open(username, attach)
  } catch {
    return ws.close(1011, 'agent unavailable')
  }

  let buf = ''
  agent.setEncoding('utf8')
  agent.on('data', (chunk: string) => {
    buf += chunk
    let i: number
    while ((i = buf.indexOf('\n')) >= 0) {
      ws.send(buf.slice(0, i))
      buf = buf.slice(i + 1)
    }
  })
  agent.on('error', () => ws.close(1011, 'agent unavailable'))
  agent.on('close', () => ws.close(1000))

  // Re-serialize client messages so a crafted frame can't break the line framing to the agent.
  ws.on('message', (data) => {
    let msg: unknown
    try {
      msg = JSON.parse(String(data))
    } catch {
      return
    }
    const m = msg as { d?: unknown; r?: unknown }
    if (typeof m.d === 'string') agent.write(JSON.stringify({ d: m.d }) + '\n')
    else if (Array.isArray(m.r) && m.r.length === 2 && m.r.every(Number.isInteger)) agent.write(JSON.stringify({ r: m.r }) + '\n')
  })

  // Cloudflare closes idle WebSockets after ~100 s.
  const ping = setInterval(() => ws.ping(), 30_000)
  ws.on('close', () => {
    clearInterval(ping)
    agent.destroy()
  })
}
