import { connect, type Socket } from 'node:net'
import { join } from 'node:path'
import { sha256 } from '../../core/crypto.ts'
import { AppError } from '../../core/http.ts'
import { requestLine } from '../../core/unix.ts'

export const TERMINAL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,30}$/
export const ADMIN_TERMINAL = 'admin'
const UNLOCK_MS = 5 * 60_000

export type TerminalInfo = { name: string; created: number; attached: number; activity: number }

/** Talks to each member's agent (deploy/systemd/devdash-agent@.socket). The agent runs as that member. */
export function terminalsService({ runDir }: { runDir: string }) {
  // ponytail: in-memory unlock window; a server restart just asks for the code again.
  const unlocked = new Map<string, number>()
  const agentPath = (username: string) => {
    if (!runDir) throw new AppError(409, 'no_host', 'Terminals need DevDash running on its Linux server.')
    return join(runDir, `agent-${username}.sock`)
  }
  const ask = async <T>(username: string, msg: object) => {
    try {
      return await requestLine<T & { error?: string }>(agentPath(username), msg)
    } catch (err) {
      if (err instanceof AppError) throw err
      throw new AppError(409, 'agent_unavailable', 'Your server account is still being set up. Try again in a minute.')
    }
  }

  return {
    async list(username: string) {
      return (await ask<{ terminals: TerminalInfo[] }>(username, { op: 'terminals.list' })).terminals
    },
    async kill(username: string, name: string) {
      if (!TERMINAL_NAME_RE.test(name)) throw new AppError(400, 'bad_name', 'Invalid terminal name.')
      await ask(username, { op: 'terminals.kill', name })
    },
    unlockAdmin: (sessionToken: string) => unlocked.set(sha256(sessionToken), Date.now() + UNLOCK_MS),
    isAdminUnlocked: (sessionToken: string) => (unlocked.get(sha256(sessionToken)) ?? 0) > Date.now(),
    /** Opens a streaming attach. The caller pipes JSON lines both ways. */
    open(username: string, attach: { name: string; cols: number; rows: number; admin: boolean }): Socket {
      const sock = connect(agentPath(username))
      sock.write(JSON.stringify({ op: 'terminal.attach', ...attach }) + '\n')
      return sock
    },
  }
}

export type TerminalsService = ReturnType<typeof terminalsService>
