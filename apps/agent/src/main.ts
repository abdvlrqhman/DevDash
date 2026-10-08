// DevDash agent: one per member, running as that member's Linux user (deploy/systemd/devdash-agent@.service).
// The server talks to it over a Unix socket that systemd creates (mode 0660, group devdash).
// Protocol: first line is a JSON request; terminal.attach then streams JSON lines both ways ({d} data, {r} resize).
import { execFile } from 'node:child_process'
import { createServer, type Socket } from 'node:net'
import { homedir } from 'node:os'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import pty from 'node-pty'

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,30}$/
const ADMIN = 'admin'
const ADMIN_IDLE_MS = 15 * 60_000
const TMUX_CONF = fileURLToPath(new URL('../../../deploy/tmux.conf', import.meta.url))
// A dedicated tmux server, so SSH users can join the same terminals: tmux -L devdash attach -t t-main
const TMUX = ['-L', 'devdash', '-f', TMUX_CONF]
const run = promisify(execFile)
const tmux = (...args: string[]) => run('tmux', [...TMUX, ...args])
const session = (name: string) => `t-${name}`
const clamp = (n: unknown, min: number, max: number) => Math.min(max, Math.max(min, Math.floor(Number(n)) || min))

async function listTerminals() {
  try {
    const { stdout } = await tmux('list-sessions', '-F', '#{session_name}\t#{session_created}\t#{session_attached}\t#{session_activity}')
    return stdout.trim().split('\n').filter((l) => l.startsWith('t-')).map((l) => {
      const [n, created, attached, activity] = l.split('\t')
      return { name: n!.slice(2), created: Number(created), attached: Number(attached), activity: Number(activity) }
    })
  } catch {
    return [] // no tmux server yet
  }
}

async function ensureSession(name: string, cols: number, rows: number) {
  try {
    await tmux('has-session', '-t', `=${session(name)}`)
  } catch {
    const args = ['new-session', '-d', '-s', session(name), '-x', String(cols), '-y', String(rows)]
    if (name === ADMIN) args.push('sudo -i') // asks for the admin's Linux password
    await tmux(...args)
  }
}

function send(conn: Socket, msg: object) {
  return conn.write(JSON.stringify(msg) + '\n')
}

async function attach(conn: Socket, lines: AsyncIterator<string>, req: { name: string; cols: number; rows: number }) {
  const cols = clamp(req.cols, 10, 500)
  const rows = clamp(req.rows, 4, 200)
  await ensureSession(req.name, cols, rows)
  const term = pty.spawn('tmux', [...TMUX, 'attach-session', '-t', `=${session(req.name)}`], {
    name: 'xterm-256color', cols, rows, cwd: homedir(), env: { ...process.env, TERM: 'xterm-256color' } as Record<string, string>,
  })

  term.onData((d) => {
    if (!send(conn, { d })) {
      term.pause()
      conn.once('drain', () => term.resume())
    }
  })
  term.onExit(() => conn.end())
  conn.on('close', () => term.kill()) // detaches this client; the tmux session keeps running

  let lastInput = Date.now()
  const idle = req.name === ADMIN
    ? setInterval(() => {
        if (Date.now() - lastInput > ADMIN_IDLE_MS) void tmux('kill-session', '-t', `=${session(ADMIN)}`).catch(() => {})
      }, 30_000)
    : undefined
  conn.on('close', () => clearInterval(idle))

  for (let r = await lines.next(); !r.done; r = await lines.next()) {
    let m: { d?: unknown; r?: unknown }
    try {
      m = JSON.parse(r.value)
    } catch {
      continue
    }
    if (typeof m.d === 'string') {
      lastInput = Date.now()
      term.write(m.d)
    } else if (Array.isArray(m.r)) {
      term.resize(clamp(m.r[0], 10, 500), clamp(m.r[1], 4, 200))
    }
  }
}

async function handle(conn: Socket) {
  conn.setEncoding('utf8')
  const lines = createInterface({ input: conn, crlfDelay: Infinity })[Symbol.asyncIterator]()
  try {
    const first = await lines.next()
    if (first.done) return
    const req = JSON.parse(first.value) as { op?: string; name?: string; cols?: number; rows?: number }
    if (req.op === 'terminals.list') {
      send(conn, { terminals: await listTerminals() })
      return void conn.end()
    }
    if (typeof req.name !== 'string' || !NAME_RE.test(req.name)) throw new Error('invalid terminal name')
    if (req.op === 'terminals.kill') {
      await tmux('kill-session', '-t', `=${session(req.name)}`).catch(() => {})
      send(conn, { ok: true })
      return void conn.end()
    }
    if (req.op === 'terminal.attach') return await attach(conn, lines, req as { name: string; cols: number; rows: number })
    throw new Error('unknown op')
  } catch (err) {
    send(conn, { error: (err as Error).message })
    conn.end()
  }
}

const server = createServer((conn) => void handle(conn))
if (process.env.LISTEN_FDS === '1') server.listen({ fd: 3 }) // socket activation
else server.listen(process.env.DEVDASH_AGENT_SOCKET ?? `${homedir()}/.devdash-agent.sock`)
server.on('listening', () => console.log(`devdash agent for ${process.env.USER} ready`))
