import { useEffect, useImperativeHandle, useRef, type Ref } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { ClipboardAddon } from '@xterm/addon-clipboard'
import '@xterm/xterm/css/xterm.css'

export type Status = 'connecting' | 'live' | 'reconnecting' | 'ended'
export type Mods = { ctrl: boolean; alt: boolean }
export type TerminalHandle = { send: (data: string) => void; focus: () => void; toggle: (mod: keyof Mods) => void }

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim()

/**
 * One xterm bound to one tmux-backed terminal on the server. Reconnects after network drops (tmux keeps the state).
 * To start again after the shell exited, the parent remounts it with a new `key`.
 */
export function TerminalView({ name, onStatus, onMods, ref }: {
  name: string
  onStatus: (s: Status) => void
  onMods?: (m: Mods) => void
  ref?: Ref<TerminalHandle>
}) {
  const host = useRef<HTMLDivElement>(null)
  const handle = useRef<TerminalHandle | null>(null)
  const cb = useRef({ onStatus, onMods })
  cb.current = { onStatus, onMods }
  useImperativeHandle(ref, () => ({
    send: (d) => handle.current?.send(d),
    focus: () => handle.current?.focus(),
    toggle: (mod) => handle.current?.toggle(mod),
  }), [])

  useEffect(() => {
    const term = new Terminal({
      fontFamily: '"JetBrains Mono Variable", ui-monospace, monospace',
      fontSize: matchMedia('(pointer: coarse)').matches ? 12 : 13,
      lineHeight: 1.15,
      cursorBlink: true,
      scrollback: 0, // tmux keeps the history
      macOptionIsMeta: true,
      theme: { background: css('--term-bg'), foreground: css('--term-fg'), cursor: css('--accent'), selectionBackground: '#8a6a5266' },
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(new WebLinksAddon((_e, uri) => window.open(uri, '_blank', 'noopener,noreferrer')))
    term.loadAddon(new ClipboardAddon()) // OSC 52: tmux copy-mode selections land in the device clipboard
    term.open(host.current!)
    try {
      term.loadAddon(new WebglAddon())
    } catch {
      // falls back to the DOM renderer
    }
    const refit = () => {
      try { fit.fit() } catch { /* not visible yet */ }
    }
    refit()
    void document.fonts.ready.then(refit)

    let ws: WebSocket | null = null
    let disposed = false
    let retry = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    const mods: Mods = { ctrl: false, alt: false }
    const emitMods = () => cb.current.onMods?.({ ...mods })

    const raw = (d: string) => {
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ d }))
    }
    // Sticky Ctrl/Alt from the phone key bar apply to the next key typed on the soft keyboard.
    const typed = (d: string) => {
      const had = mods.ctrl || mods.alt
      if (mods.ctrl && d.length === 1) {
        const c = d.toUpperCase().charCodeAt(0)
        if (c >= 64 && c <= 95) d = String.fromCharCode(c - 64)
      }
      if (mods.alt) d = '\x1b' + d
      mods.ctrl = mods.alt = false
      if (had) emitMods()
      raw(d)
    }
    handle.current = {
      send: raw,
      focus: () => term.focus(),
      toggle: (mod) => {
        mods[mod] = !mods[mod]
        emitMods()
      },
    }

    const connect = () => {
      cb.current.onStatus(retry ? 'reconnecting' : 'connecting')
      const proto = location.protocol === 'https:' ? 'wss' : 'ws'
      ws = new WebSocket(`${proto}://${location.host}/api/terminals/${name}/ws?cols=${term.cols}&rows=${term.rows}`)
      ws.onopen = () => {
        retry = 0
        term.reset() // tmux redraws the whole screen on attach
        cb.current.onStatus('live')
      }
      ws.onmessage = (e) => {
        const m = JSON.parse(e.data as string) as { d?: string; error?: string }
        if (m.d) term.write(m.d)
        else if (m.error) term.write(`\r\n\x1b[31m${m.error}\x1b[0m\r\n`)
      }
      ws.onclose = (e) => {
        if (disposed) return
        if (e.code === 1000) return cb.current.onStatus('ended') // the shell exited
        retry++
        cb.current.onStatus('reconnecting')
        timer = setTimeout(connect, Math.min(10_000, 400 * 2 ** retry))
      }
    }
    connect()

    const sub = term.onData(typed)
    const ro = new ResizeObserver(() => {
      refit()
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ r: [term.cols, term.rows] }))
    })
    ro.observe(host.current!)
    term.focus()

    return () => {
      disposed = true
      clearTimeout(timer)
      ro.disconnect()
      sub.dispose()
      ws?.close()
      term.dispose()
      handle.current = null
    }
  }, [name])

  return <div ref={host} className="h-full w-full" />
}
