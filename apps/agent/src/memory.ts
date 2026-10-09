// claude-mem (github.com/thedotmack/claude-mem) for one Claude profile. Off by default: a profile then has Claude
// Code's own memory (CLAUDE.md and auto memory) only. Switching it on installs the plugin into that profile like any
// other plugin; its worker and database belong to the Linux user (~/.claude-mem), shared by all their profiles.
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { PROFILE_RE, profileDir, profileEnv } from './claude.ts'
import { CLAUDE_BIN } from './sdk.ts'

const run = promisify(execFile)
const PLUGIN = 'claude-mem@thedotmack'
const MARKETPLACE = 'thedotmack'
const MARKETPLACE_SOURCE = 'thedotmack/claude-mem'
const BUN_PATHS = ['/usr/local/bin/bun', join(homedir(), '.bun', 'bin', 'bun')]

function readJson(path: string): Record<string, any> {
  try {
    const v = JSON.parse(readFileSync(path, 'utf8'))
    return v && typeof v === 'object' ? v : {}
  } catch {
    return {}
  }
}

export function enabled(profile: string) {
  return readJson(join(profileDir(profile), 'settings.json')).enabledPlugins?.[PLUGIN] === true
}

/**
 * Settings DevDash needs on a shared server, written only where the member hasn't set their own:
 * - a worker port of its own (claude-mem's default, 37700 + uid % 100, collides for uids 100 apart),
 * - no Chroma: it would start a Python vector server on port 8000 for every member; SQLite search remains,
 * - for a non-default profile, the observer signs in with that profile's login.
 */
export function configure(profile: string) {
  const dir = join(homedir(), '.claude-mem')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const file = join(dir, 'settings.json')
  const s = readJson(file)
  const defaults: Record<string, string> = {
    CLAUDE_MEM_WORKER_PORT: String(37000 + userInfo().uid),
    CLAUDE_MEM_CHROMA_ENABLED: 'false',
    ...(profile === 'default' ? {} : { CLAUDE_MEM_CLAUDE_CONFIG_DIR: profileDir(profile) }),
  }
  let changed = false
  for (const [k, v] of Object.entries(defaults)) {
    if (!s[k]) { s[k] = v; changed = true }
  }
  if (changed) writeFileSync(file, `${JSON.stringify(s, null, 2)}\n`, { mode: 0o600 })
}

const jobs = new Map<string, Promise<void>>()
/** One change per profile at a time: a double tap must not run two installs. */
export function set(profile: string, on: boolean) {
  if (!PROFILE_RE.test(profile)) throw new Error('invalid profile')
  const next = (jobs.get(profile) ?? Promise.resolve()).catch(() => {}).then(() => apply(profile, on))
  jobs.set(profile, next)
  void next.finally(() => { if (jobs.get(profile) === next) jobs.delete(profile) }).catch(() => {})
  return next
}

async function apply(profile: string, on: boolean) {
  const env = { ...process.env, ...profileEnv(profile) }
  const claude = async (...args: string[]) => {
    try {
      await run(CLAUDE_BIN, ['plugin', ...args], { env, timeout: 180_000 })
    } catch (err) {
      const e = err as { stderr?: string; message: string }
      const why = (e.stderr || e.message).trim().split('\n').filter(Boolean).pop() ?? 'unknown error'
      throw new Error(`claude plugin ${args[0]} failed: ${why.slice(0, 300)}`)
    }
  }
  if (!on) {
    if (enabled(profile)) await claude('disable', PLUGIN, '--scope', 'user')
    return
  }
  if (!BUN_PATHS.some((p) => existsSync(p))) {
    throw new Error('claude-mem needs Bun, which this server does not have yet. Ask an admin to redeploy DevDash (it installs Bun).')
  }
  configure(profile)
  const config = profileDir(profile)
  const installed = readJson(join(config, 'plugins', 'installed_plugins.json')).plugins?.[PLUGIN]?.[0] as { installPath?: string } | undefined
  if (installed) return void (await claude('enable', PLUGIN, '--scope', 'user'))
  if (!readJson(join(config, 'plugins', 'known_marketplaces.json'))[MARKETPLACE]) await claude('marketplace', 'add', MARKETPLACE_SOURCE)
  await claude('install', PLUGIN, '--scope', 'user')
  // claude-mem fetches its own dependencies in a Setup hook; do it now so the first session doesn't wait or fail.
  const root = readJson(join(config, 'plugins', 'installed_plugins.json')).plugins?.[PLUGIN]?.[0]?.installPath as string | undefined
  if (root && existsSync(join(root, 'scripts', 'version-check.js'))) {
    await run(process.execPath, [join(root, 'scripts', 'version-check.js')], { env: { ...env, CLAUDE_PLUGIN_ROOT: root }, timeout: 180_000 }).catch(() => {})
  }
}
