import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

export type Config = {
  origin: string
  spaceName: string
  dataDir: string
  port: number
  masterKey: Buffer
  trustCfIp: boolean
  /** Where systemd puts the root helper and agent sockets. Empty on a dev machine (no host integration). */
  runDir: string
  /** Shared git checkouts and worktrees live under <projectsRoot>/projects and <projectsRoot>/worktrees. */
  projectsRoot: string
  /** Address pattern for service previews, e.g. "{name}-dev.example.com" (needs a wildcard DNS record). Empty: off. */
  previewHost: string
  version: string
}

function need(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`missing environment variable ${name} (see .env.example)`)
  return v
}

export function loadConfig(): Config {
  const origin = need('DEVDASH_ORIGIN').replace(/\/$/, '')
  new URL(origin) // throws on garbage
  const masterKey = Buffer.from(need('DEVDASH_MASTER_KEY'), 'base64')
  if (masterKey.length !== 32) throw new Error('DEVDASH_MASTER_KEY must be 32 bytes, base64')
  const dataDir = resolve(need('DEVDASH_DATA_DIR'))
  mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }
  return {
    origin,
    spaceName: process.env.DEVDASH_SPACE_NAME || 'DevDash',
    dataDir,
    port: Number(process.env.DEVDASH_PORT || 8787),
    masterKey,
    trustCfIp: process.env.DEVDASH_TRUST_CF_IP === '1',
    runDir: process.env.DEVDASH_RUN_DIR ?? (existsSync('/run/devdash') ? '/run/devdash' : ''),
    projectsRoot: process.env.DEVDASH_PROJECTS_ROOT || '/srv/devdash',
    previewHost: (process.env.DEVDASH_PREVIEW_HOST ?? '').trim().toLowerCase(),
    version: pkg.version,
  }
}
