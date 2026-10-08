import { createHmac, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { connect } from 'node:net'
import type { Duplex } from 'node:stream'
import type { Context, MiddlewareHandler } from 'hono'
import { getCookie, setCookie } from 'hono/cookie'
import { parse as parseCookies } from 'hono/utils/cookie'
import type { Db } from '../../core/db.ts'

const COOKIE = '__Host-ddpreview'
const HOP = ['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer', 'host']

/**
 * Preview URLs: each service opens at its own address (DEVDASH_PREVIEW_HOST, e.g. "{name}-dev.example.com"), proxied
 * to its port on 127.0.0.1. Members get in through a one-time handoff from the DevDash origin (their DevDash cookie
 * can't cross hosts); a service marked public opens for anyone with the link (testers). WebSockets (live reload) too.
 */
export function previewsService({ db, masterKey, origin, template }: { db: Db; masterKey: Buffer; origin: string; template: string }) {
  const pattern = template && /^\{name\}[a-z0-9.-]*\.[a-z]{2,}$/.test(template)
    ? new RegExp(`^${template.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace('\\{name\\}', '([a-z][a-z0-9-]{0,30})')}$`)
    : null
  const q = {
    service: db.prepare('select port, public from services where name = ?'),
    member: db.prepare('select 1 from users where id = ? and disabled_at is null'),
  }
  const mac = (s: string) => createHmac('sha256', masterKey).update(`preview:${s}`).digest('base64url')
  const sign = (payload: object) => {
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
    return `${body}.${mac(body)}`
  }
  function verify<T extends { exp: number }>(token: string | undefined): T | null {
    const [body, sig] = (token ?? '').split('.')
    if (!body || !sig) return null
    const want = Buffer.from(mac(body))
    const got = Buffer.from(sig)
    if (want.length !== got.length || !timingSafeEqual(want, got)) return null
    try {
      const p = JSON.parse(Buffer.from(body, 'base64url').toString()) as T
      return p.exp > Date.now() / 1000 ? p : null
    } catch { return null }
  }
  const hostOf = (raw: string | undefined) => (raw ?? '').toLowerCase().replace(/:\d+$/, '')
  const own = new URL(origin).hostname // DevDash's own address is never a preview, whatever the pattern
  const nameOf = (host: string) => (pattern && host !== own ? pattern.exec(host)?.[1] ?? null : null)
  /** Allowed in: a public service, or a member's cookie for exactly this host. */
  function allowed(name: string, host: string, cookie: string | undefined) {
    const s = q.service.get(name) as { port: number; public: number } | undefined
    if (!s) return { s: null, ok: false }
    if (s.public) return { s, ok: true }
    const p = verify<{ u: number; h: string; exp: number }>(cookie)
    return { s, ok: !!p && p.h === host && !!q.member.get(p.u) }
  }
  const loginUrl = (host: string, next: string) => `${origin}/api/previews/auth?${new URLSearchParams({ host, next })}`

  return {
    enabled: !!pattern,
    urlOf: (name: string) => (pattern ? `https://${template.replace('{name}', name)}/` : null),

    /** On the DevDash origin: a signed-in member asks for a preview; they get a one-minute ticket for that host. */
    ticket(userId: number, host: string, next: string) {
      const name = nameOf(hostOf(host))
      if (!name || !q.service.get(name)) return null
      const path = next.startsWith('/') && !next.startsWith('//') ? next : '/'
      return `https://${hostOf(host)}/__devdash/auth?${new URLSearchParams({ t: sign({ u: userId, h: hostOf(host), exp: Math.floor(Date.now() / 1000) + 60 }), next: path })}`
    },

    /** Runs first for every request: answers preview hosts, passes everything else on. */
    middleware: (async (c: Context, next) => {
      const host = hostOf(c.req.header('x-forwarded-host') ?? c.req.header('host'))
      const name = nameOf(host)
      if (!name) return next()
      const url = new URL(c.req.url)
      if (url.pathname === '/__devdash/auth') {
        const p = verify<{ u: number; h: string; exp: number }>(url.searchParams.get('t') ?? '')
        if (!p || p.h !== host) return c.text('This sign-in link expired. Open the preview from DevDash again.', 401)
        setCookie(c, 'ddpreview', sign({ u: p.u, h: host, exp: Math.floor(Date.now() / 1000) + 7 * 86400 }), { prefix: 'host', path: '/', secure: true, httpOnly: true, sameSite: 'Lax', maxAge: 7 * 86400 })
        const to = url.searchParams.get('next') ?? '/'
        return c.redirect(to.startsWith('/') && !to.startsWith('//') ? to : '/')
      }
      const { s, ok } = allowed(name, host, getCookie(c, 'ddpreview', 'host'))
      if (!s) return c.text(`There is no service called ${name}.`, 404)
      if (!ok) return c.redirect(loginUrl(host, url.pathname + url.search))

      const headers = new Headers()
      c.req.raw.headers.forEach((v, k) => { if (!HOP.includes(k)) headers.set(k, v) })
      const kept = (c.req.header('cookie') ?? '').split(/;\s*/).filter((x) => x && !x.startsWith(`${COOKIE}=`)).join('; ')
      if (kept) headers.set('cookie', kept); else headers.delete('cookie')
      headers.set('x-forwarded-host', host)
      headers.set('x-forwarded-proto', 'https')
      try {
        const res = await fetch(`http://127.0.0.1:${s.port}${url.pathname}${url.search}`, {
          method: c.req.method, headers, redirect: 'manual',
          body: ['GET', 'HEAD'].includes(c.req.method) ? undefined : c.req.raw.body, duplex: 'half',
        } as RequestInit)
        const out = new Headers(res.headers)
        out.delete('content-encoding') // fetch already decompressed the body
        out.delete('content-length')
        return new Response(res.body, { status: res.status, headers: out })
      } catch {
        return c.text(`${name} isn't answering on its port. Is it running? Check its logs in DevDash.`, 502)
      }
    }) as MiddlewareHandler,

    /** WebSocket upgrades on preview hosts (e.g. a dev server's live reload): checked, then piped to the service. */
    upgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
      const host = hostOf((req.headers['x-forwarded-host'] as string | undefined) ?? req.headers.host)
      const name = nameOf(host)
      if (!name) return false
      const { s, ok } = allowed(name, host, parseCookies(req.headers.cookie ?? '', COOKIE)[COOKIE])
      if (!s || !ok) {
        socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
        return true
      }
      socket.on('error', () => upstream.destroy())
      const upstream = connect(s.port, '127.0.0.1', () => {
        const lines = [`${req.method} ${req.url} HTTP/1.1`, `Host: 127.0.0.1:${s.port}`]
        for (let i = 0; i < req.rawHeaders.length; i += 2) if (req.rawHeaders[i]!.toLowerCase() !== 'host') lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`)
        upstream.write(`${lines.join('\r\n')}\r\n\r\n`)
        if (head.length) upstream.write(head)
        upstream.pipe(socket)
        socket.pipe(upstream)
      })
      upstream.on('error', () => socket.destroy())
      return true
    },
  }
}

export type PreviewsService = ReturnType<typeof previewsService>
