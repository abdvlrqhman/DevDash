import { connect } from 'node:net'
import type { Db } from '../../core/db.ts'
import type { Hub } from '../../core/hub.ts'
import { AppError } from '../../core/http.ts'
import type { AgentsService } from '../agents/service.ts'
import type { User } from '../auth/repo.ts'
import type { NotificationsService } from '../notifications/service.ts'

export const NAME_RE = /^[a-z][a-z0-9-]{0,30}$/
const PORTS = { from: 20000, to: 20999 }
const TICK_MS = 15_000
const MAX_RESTARTS = 5 // within RESTART_WINDOW_MS, then it is marked crashed until someone starts it again
const RESTART_WINDOW_MS = 10 * 60_000

type Row = { id: number; name: string; owner_id: number; owner_username: string; owner_name: string; cwd: string; command: string; port: number; desired: 'running' | 'stopped'; created_at: number }
export type State = 'running' | 'starting' | 'stopped' | 'crashed' | 'unknown'
type Runtime = { state: State; listening: boolean; exitCode: number | null; error: string | null; restarts: number[] }

const SELECT = `select s.*, u.username as owner_username, u.name as owner_name from services s join users u on u.id = s.owner_id`

/**
 * The services center. The registry lives here; the processes run in each owner's agent (tmux, as the owner),
 * so they survive DevDash restarts. A monitor keeps every service whose desired state is "running" up.
 */
export function servicesService({ db, agents, hub, notify }: { db: Db; agents: AgentsService; hub: Hub; notify: NotificationsService['notify'] }) {
  const q = {
    all: db.prepare(`${SELECT} order by s.name`),
    byName: db.prepare(`${SELECT} where s.name = ?`),
    ports: db.prepare('select port from services'),
    insert: db.prepare('insert into services (name, owner_id, cwd, command, port) values (?, ?, ?, ?, ?)'),
    desired: db.prepare('update services set desired = ? where id = ?'),
    edit: db.prepare('update services set command = ?, cwd = ? where id = ?'),
    remove: db.prepare('delete from services where id = ?'),
    user: db.prepare("select id, username, name, role from users where username = ? and disabled_at is null"),
  }
  const runtime = new Map<string, Runtime>()
  const rt = (name: string) => {
    let r = runtime.get(name)
    if (!r) runtime.set(name, (r = { state: 'unknown', listening: false, exitCode: null, error: null, restarts: [] }))
    return r
  }
  const changed = () => hub.publish('services', { type: 'changed' })

  const get = (name: string) => {
    const s = q.byName.get(name) as Row | undefined
    if (!s) throw new AppError(404, 'not_found', `There is no service called ${name}.`)
    return s
  }
  const canControl = (u: Pick<User, 'id' | 'role'>, s: Row) => u.id === s.owner_id || u.role === 'admin'
  const control = (u: Pick<User, 'id' | 'role'>, name: string) => {
    const s = get(name)
    if (!canControl(u, s)) throw new AppError(403, 'forbidden', `${name} belongs to ${s.owner_name}. Only they or an admin can change it.`)
    return s
  }
  const dto = (s: Row, u: Pick<User, 'id' | 'role'>) => {
    const r = rt(s.name)
    return {
      name: s.name, cwd: s.cwd, command: s.command, port: s.port, desired: s.desired, createdAt: s.created_at,
      owner: { id: s.owner_id, username: s.owner_username, name: s.owner_name },
      state: s.desired === 'stopped' && r.state !== 'running' ? 'stopped' as State : r.state,
      listening: r.listening, exitCode: r.exitCode, error: r.error, canControl: canControl(u, s),
    }
  }

  const start = (s: Row) => agents.request(s.owner_username, { op: 'service.start', name: s.name, cwd: s.cwd, command: s.command, port: s.port })
  const stop = (s: Row) => agents.request(s.owner_username, { op: 'service.stop', name: s.name }, 30_000)

  const probe = (port: number) => new Promise<boolean>((resolve) => {
    const sock = connect({ host: '127.0.0.1', port })
    const done = (ok: boolean) => { sock.destroy(); resolve(ok) }
    sock.setTimeout(500, () => done(false))
    sock.once('connect', () => done(true))
    sock.once('error', () => done(false))
  })

  // One pass of the keeper: look at every service, restart the ones that should run but don't.
  let ticking = false
  async function tick() {
    if (ticking) return
    ticking = true
    try {
      const rows = q.all.all() as Row[]
      let dirty = false
      for (const owner of new Set(rows.map((r) => r.owner_username))) {
        let live: Record<string, { dead: boolean; code: number | null }>
        try {
          live = (await agents.request<{ services: typeof live }>(owner, { op: 'service.status' }, 10_000)).services
        } catch {
          continue // agent unreachable right now; try again next tick
        }
        for (const s of rows.filter((r) => r.owner_username === owner)) {
          const r = rt(s.name)
          const before = JSON.stringify(r)
          const l = live[s.name]
          if (l && !l.dead) {
            r.state = 'running'
            r.error = null
            r.listening = await probe(s.port)
          } else if (s.desired === 'stopped') {
            Object.assign(r, { state: 'stopped', listening: false })
          } else {
            r.listening = false
            r.exitCode = l?.code ?? r.exitCode
            r.restarts = r.restarts.filter((t) => Date.now() - t < RESTART_WINDOW_MS)
            if (r.restarts.length >= MAX_RESTARTS) {
              if (r.state !== 'crashed') {
                r.state = 'crashed'
                void notify(s.owner_id, 'errors', { title: `${s.name} keeps crashing`, body: `Stopped restarting it after ${MAX_RESTARTS} tries. Check its logs.`, url: `/services/${s.name}`, tag: `service:${s.name}` })
              }
            } else {
              r.restarts.push(Date.now())
              r.state = 'starting'
              try {
                await start(s)
              } catch (err) {
                r.error = (err as Error).message
              }
            }
          }
          if (JSON.stringify(r) !== before) dirty = true
        }
      }
      if (dirty) changed()
    } finally {
      ticking = false
    }
  }
  setInterval(() => void tick(), TICK_MS).unref()
  // After an action, look again soon so the page shows "running" and "listening" without waiting a whole tick.
  const soon = () => { for (const ms of [1500, 5000]) setTimeout(() => void tick(), ms).unref() }

  function nextPort() {
    const used = new Set((q.ports.all() as { port: number }[]).map((r) => r.port))
    for (let p = PORTS.from; p <= PORTS.to; p++) if (!used.has(p)) return p
    throw new AppError(409, 'no_ports', 'All service ports are taken. Remove services you no longer need.')
  }

  const api = {
    list: (u: Pick<User, 'id' | 'role'>) => (q.all.all() as Row[]).map((s) => dto(s, u)),
    get: (u: Pick<User, 'id' | 'role'>, name: string) => dto(get(name), u),

    async create(u: Pick<User, 'id' | 'role' | 'username'>, input: { name: string; cwd: string; command: string }) {
      if (!NAME_RE.test(input.name)) throw new AppError(400, 'invalid_name', 'Use lowercase letters, digits and dashes, starting with a letter (up to 31).')
      if (q.byName.get(input.name)) throw new AppError(409, 'taken', `${input.name} already exists. Pick another name.`)
      // The owner's agent resolves ~ and checks the folder exists for them.
      const { path } = await agents.request<{ path: string }>(u.username, { op: 'fs.dir', path: input.cwd })
      q.insert.run(input.name, u.id, path, input.command, nextPort())
      const s = get(input.name)
      rt(s.name).state = 'starting'
      try {
        await start(s)
      } catch (err) {
        rt(s.name).error = (err as Error).message
      }
      changed()
      soon()
      return dto(s, u)
    },

    async edit(u: Pick<User, 'id' | 'role'>, name: string, input: { command?: string; cwd?: string }) {
      const s = control(u, name)
      const cwd = input.cwd === undefined ? s.cwd : (await agents.request<{ path: string }>(s.owner_username, { op: 'fs.dir', path: input.cwd })).path
      q.edit.run(input.command ?? s.command, cwd, s.id)
      if (s.desired === 'running') await api.restart(u, name)
      else changed()
      return dto(get(name), u)
    },

    async start(u: Pick<User, 'id' | 'role'>, name: string) {
      const s = control(u, name)
      q.desired.run('running', s.id)
      Object.assign(rt(name), { state: 'starting', restarts: [], error: null })
      await start(get(name))
      changed()
      soon()
      return dto(get(name), u)
    },

    async stop(u: Pick<User, 'id' | 'role'>, name: string) {
      const s = control(u, name)
      q.desired.run('stopped', s.id)
      await stop(s)
      Object.assign(rt(name), { state: 'stopped', listening: false })
      changed()
      return dto(get(name), u)
    },

    async restart(u: Pick<User, 'id' | 'role'>, name: string) {
      const s = control(u, name)
      await stop(s)
      return api.start(u, name)
    },

    async remove(u: Pick<User, 'id' | 'role'>, name: string) {
      const s = control(u, name)
      await stop(s)
      q.remove.run(s.id)
      runtime.delete(name)
      changed()
    },

    async logs(u: Pick<User, 'id' | 'role'>, name: string, lines: number) {
      const s = get(name)
      void u // every member may read logs
      return (await agents.request<{ text: string }>(s.owner_username, { op: 'service.logs', name, lines })).text
    },

    /** Who may open the live log view, and on whose agent it runs. */
    logsAccess: (_u: User, name: string) => get(name).owner_username,
  }

  // The same actions for the `devdash service` command, called through the member's own agent (no token needed).
  const asUser = (username: string) => {
    const u = q.user.get(username) as Pick<User, 'id' | 'username' | 'role'> | undefined
    if (!u) throw new AppError(403, 'forbidden', 'Unknown member.')
    return u
  }
  const p = (v: unknown) => (v ?? {}) as Record<string, string>
  agents.onRpc('services.list', (username) => ({ services: api.list(asUser(username)) }))
  agents.onRpc('services.add', (username, v) => api.create(asUser(username), { name: p(v).name!, cwd: p(v).cwd!, command: p(v).command! }))
  agents.onRpc('services.start', (username, v) => api.start(asUser(username), p(v).name!))
  agents.onRpc('services.stop', (username, v) => api.stop(asUser(username), p(v).name!))
  agents.onRpc('services.restart', (username, v) => api.restart(asUser(username), p(v).name!))
  agents.onRpc('services.remove', async (username, v) => (await api.remove(asUser(username), p(v).name!), {}))
  agents.onRpc('services.logs', async (username, v) => ({ text: await api.logs(asUser(username), p(v).name!, Number(p(v).lines) || 200) }))

  void tick()
  return api
}

export type ServicesService = ReturnType<typeof servicesService>
