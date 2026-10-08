import { useEffect, useRef } from 'react'

type Handler = (event: Record<string, unknown>) => void

/**
 * One WebSocket per tab to /api/live. Components subscribe to topics ("sessions", "session:<id>");
 * the socket reconnects on its own and re-subscribes everything, so callers never deal with drops.
 */
class Live {
  private ws: WebSocket | null = null
  private topics = new Map<string, Set<Handler>>()
  private retry = 0
  private onReconnect = new Set<() => void>()

  private connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(`${proto}://${location.host}/api/live`)
    this.ws = ws
    ws.onopen = () => {
      const reconnected = this.retry > 0
      this.retry = 0
      for (const t of this.topics.keys()) ws.send(JSON.stringify({ sub: t }))
      if (reconnected) for (const fn of this.onReconnect) fn() // refetch whatever may have changed while offline
    }
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data as string) as { topic: string }
      for (const h of this.topics.get(m.topic) ?? []) h(m)
    }
    ws.onclose = () => {
      this.ws = null
      if (!this.topics.size) return
      this.retry++
      setTimeout(() => this.ensure(), Math.min(10_000, 500 * 2 ** this.retry))
    }
  }

  private ensure() {
    if (!this.ws) this.connect()
  }

  subscribe(topic: string, h: Handler) {
    let set = this.topics.get(topic)
    if (!set) {
      set = new Set()
      this.topics.set(topic, set)
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ sub: topic }))
    }
    set.add(h)
    this.ensure()
    return () => {
      set.delete(h)
      if (set.size) return
      this.topics.delete(topic)
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ unsub: topic }))
    }
  }

  whenReconnected(fn: () => void) {
    this.onReconnect.add(fn)
    return () => void this.onReconnect.delete(fn)
  }
}

export const live = new Live()

/** Subscribes while mounted. The handler can change between renders without resubscribing. */
export function useTopic(topic: string | null, handler: Handler, onReconnect?: () => void) {
  const h = useRef(handler)
  h.current = handler
  const r = useRef(onReconnect)
  r.current = onReconnect
  useEffect(() => {
    if (!topic) return
    const off = live.subscribe(topic, (e) => h.current(e))
    const offR = live.whenReconnected(() => r.current?.())
    return () => {
      off()
      offR()
    }
  }, [topic])
}
