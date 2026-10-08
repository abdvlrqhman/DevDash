import type { WebSocket } from 'ws'
import type { User } from '../modules/auth/repo.ts'

type Conn = { ws: WebSocket; user: User; topics: Set<string>; focus: string | null }

/**
 * Live updates for browsers: one WebSocket per tab (/api/live), subscribed to topics like "sessions" or
 * "session:<id>". Whoever publishes decides who may see an event (`allow`), so the hub stays dumb.
 */
export function createHub() {
  const conns = new Set<Conn>()
  const authorizers = new Map<string, (user: User, topic: string) => boolean>()

  return {
    /** Registers who may subscribe to topics starting with `prefix`. */
    authorize(prefix: string, fn: (user: User, topic: string) => boolean) {
      authorizers.set(prefix, fn)
    },
    attach(ws: WebSocket, user: User) {
      const c: Conn = { ws, user, topics: new Set(), focus: null }
      conns.add(c)
      ws.on('close', () => conns.delete(c))
      ws.on('message', (data) => {
        let m: { sub?: unknown; unsub?: unknown; focus?: unknown }
        try {
          m = JSON.parse(String(data))
        } catch {
          return
        }
        if (typeof m.unsub === 'string') c.topics.delete(m.unsub)
        // What this tab shows right now (visible only), e.g. "session:<id>"; notifications about it skip push.
        if ('focus' in m) c.focus = typeof m.focus === 'string' && m.focus.length < 100 ? m.focus : null
        if (typeof m.sub === 'string' && m.sub.length < 100) {
          const prefix = m.sub.split(':')[0]!
          if (authorizers.get(prefix)?.(user, m.sub)) c.topics.add(m.sub)
          else ws.send(JSON.stringify({ topic: m.sub, type: 'denied' }))
        }
      })
    },
    isFocused(userId: number, key: string) {
      for (const c of conns) if (c.user.id === userId && c.focus === key) return true
      return false
    },
    publish(topic: string, payload: object, allow: (u: User) => boolean = () => true) {
      const data = JSON.stringify({ topic, ...payload })
      for (const c of conns) if (c.topics.has(topic) && allow(c.user)) c.ws.send(data)
    },
  }
}

export type Hub = ReturnType<typeof createHub>
