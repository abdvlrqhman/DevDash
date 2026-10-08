// `devdash service ...` for members and their Claude sessions (deploy/devdash-cli routes here).
// Talks to the member's own agent socket, which relays to the DevDash server: no tokens, the socket is the identity.
import { connect } from 'node:net'
import { userInfo } from 'node:os'
import { parseArgs } from 'node:util'

const SOCKET = process.env.DEVDASH_AGENT_SOCKET || `/run/devdash/agent-${userInfo().username}.sock`

const HELP = `Run long-lived things (web servers, APIs, workers, containers) on this server, each on its own port.
DevDash keeps them running after you close everything, and restarts them if they crash.

  devdash service add <name> --cmd '<command>' [--cwd <folder>]   register and start (folder: current one)
  devdash service ls                                              every service on the server
  devdash service start|stop|restart|rm <name>
  devdash service logs <name> [-n 200]                            recent output
  devdash service port <name>                                     just the port number

The command must listen on $PORT, bound to 127.0.0.1. Never pick a port yourself.
Docker: docker run --rm -p 127.0.0.1:$PORT:<container-port> ...   Compose: "127.0.0.1:\${PORT}:<port>"`

type Service = { name: string; owner: { username: string }; port: number; state: string; listening: boolean; command: string; cwd: string }

function call(method: string, params: object = {}): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const sock = connect(SOCKET)
    let buf = ''
    sock.setEncoding('utf8')
    sock.on('connect', () => sock.write(JSON.stringify({ op: 'rpc', method, params }) + '\n'))
    sock.on('data', (d: string) => {
      buf += d
      const i = buf.indexOf('\n')
      if (i < 0) return
      sock.end()
      const m = JSON.parse(buf.slice(0, i)) as { error?: string; result?: Record<string, unknown> }
      if (m.error) reject(new Error(m.error))
      else resolve(m.result ?? {})
    })
    sock.on('error', () => reject(new Error(`Can't reach DevDash (${SOCKET}). This works on the DevDash server, in your own account.`)))
  })
}

const state = (s: Service) => (s.state === 'running' ? (s.listening ? 'running' : 'running, not listening yet') : s.state)

async function main(argv: string[]) {
  const [group, cmd, ...rest] = argv
  if (!['service', 'services', 'svc'].includes(group ?? '') || !cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log(HELP)
    return
  }
  const { values, positionals } = parseArgs({
    args: rest, allowPositionals: true,
    options: { cmd: { type: 'string' }, cwd: { type: 'string' }, n: { type: 'string', short: 'n' } },
  })
  const name = positionals[0]
  const need = () => {
    if (!name) throw new Error(`Usage: devdash service ${cmd} <name>`)
    return name
  }

  switch (cmd) {
    case 'add': {
      if (!values.cmd) throw new Error("Usage: devdash service add <name> --cmd '<command>' [--cwd <folder>]")
      const r = await call('services.add', { name: need(), command: values.cmd, cwd: values.cwd ?? process.cwd() })
      const s = r as unknown as Service
      console.log(`${s.name} is starting on port ${s.port} (PORT=${s.port}), in ${s.cwd}.`)
      console.log(`Check it: curl -sI http://127.0.0.1:${s.port}  Logs: devdash service logs ${s.name}`)
      return
    }
    case 'ls':
    case 'list': {
      const { services } = (await call('services.list')) as { services: Service[] }
      if (!services.length) return console.log('No services yet. Add one: devdash service add <name> --cmd "<command>"')
      const rows = [['NAME', 'PORT', 'STATE', 'OWNER', 'COMMAND'], ...services.map((s) => [s.name, String(s.port), state(s), s.owner.username, s.command])]
      const w = rows[0]!.map((_, i) => Math.max(...rows.map((r) => r[i]!.length)))
      for (const r of rows) console.log(r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(w[i]!))).join('  '))
      return
    }
    case 'port': {
      const { services } = (await call('services.list')) as { services: Service[] }
      const s = services.find((x) => x.name === need())
      if (!s) throw new Error(`There is no service called ${name}.`)
      return console.log(s.port)
    }
    case 'logs':
      return console.log((await call('services.logs', { name: need(), lines: Number(values.n) || 200 })).text)
    case 'start':
    case 'stop':
    case 'restart': {
      const s = (await call(`services.${cmd}`, { name: need() })) as unknown as Service
      return console.log(cmd === 'stop' ? `${s.name} stopped. It stays stopped until you start it.` : `${s.name} is starting on port ${s.port}.`)
    }
    case 'rm':
    case 'remove':
      await call('services.remove', { name: need() })
      return console.log(`${name} stopped and removed. Port freed.`)
    default:
      throw new Error(`Unknown command: ${cmd}. Try: devdash service help`)
  }
}

main(process.argv.slice(2)).catch((err: Error) => {
  console.error(err.message)
  process.exit(1)
})
