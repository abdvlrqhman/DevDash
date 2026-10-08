import { readFileSync, readlinkSync, statfsSync, statSync } from 'node:fs'
import { cpus, loadavg, uptime } from 'node:os'
import { join } from 'node:path'
import type { Db } from '../../core/db.ts'
import { requestLine } from '../../core/unix.ts'
import type { AgentsService } from '../agents/service.ts'
import type { ServicesService } from '../services/service.ts'
import type { BrowserService } from '../browser/service.ts'

const read = (path: string) => { try { return readFileSync(path, 'utf8') } catch { return null } }

/** One look at the server's health: resources, versions, backups and the parts of DevDash that run on it. */
export function statusService({ db, agents, services, browser, runDir, dataDir, version }: {
  db: Db; agents: AgentsService; services: ServicesService; browser: BrowserService; runDir: string; dataDir: string; version: string
}) {
  const members = db.prepare('select username, name from users where disabled_at is null order by name')

  function memory() {
    const info = read('/proc/meminfo')
    const kb = (k: string) => Number(info?.match(new RegExp(`^${k}:\\s+(\\d+)`, 'm'))?.[1] ?? 0) * 1024
    return info ? { total: kb('MemTotal'), available: kb('MemAvailable'), swapTotal: kb('SwapTotal'), swapFree: kb('SwapFree') } : null
  }
  function disk() {
    try {
      const s = statfsSync('/')
      return { total: s.blocks * s.bsize, free: s.bavail * s.bsize }
    } catch { return null }
  }
  function release() {
    try {
      const target = readlinkSync('/opt/devdash/current')
      return { id: target.split('/').pop() ?? target, since: Math.floor(statSync(target).mtimeMs / 1000) }
    } catch { return null }
  }
  const claudeVersion = () => {
    const pkg = read('/opt/devdash/claude/current/node_modules/@anthropic-ai/claude-code/package.json') ?? read('/opt/devdash/claude/current/package.json')
    try { return pkg ? (JSON.parse(pkg) as { version?: string }).version ?? null : null } catch { return null }
  }

  return {
    async get(admin: boolean) {
      const [agentStates, browserState] = await Promise.all([
        Promise.all((members.all() as { username: string; name: string }[]).map(async (m) => ({
          name: m.name, username: m.username,
          ok: await agents.request(m.username, { op: 'terminals.list' }, 5000).then(() => true, () => false),
        }))),
        browser.status().catch(() => ({ running: false })),
      ])
      const svc = services.list({ id: 0, role: 'admin' })
      const backup = read(join(dataDir, 'backup-status.json'))
      return {
        host: { uptime: Math.floor(uptime()), load: loadavg(), cpus: cpus().length, memory: memory(), disk: disk() },
        software: { devdash: version, release: release(), claude: claudeVersion(), node: process.versions.node },
        backup: backup ? JSON.parse(backup) as { at: number; ok: boolean; snapshot: string; bytes: number; offsite: boolean; note: string } : null,
        agents: agentStates,
        services: { total: svc.length, running: svc.filter((s) => s.state === 'running').length, crashed: svc.filter((s) => s.state === 'crashed').map((s) => s.name) },
        browser: browserState,
        canAct: admin,
      }
    },

    async backupNow() {
      const r = await requestLine<{ ok: boolean; error?: string }>(join(runDir, 'helper.sock'), { cmd: 'backup-run' }, 30_000)
      if (!r.ok) throw new Error(r.error ?? 'Could not start the backup.')
    },
  }
}

export type StatusService = ReturnType<typeof statusService>
