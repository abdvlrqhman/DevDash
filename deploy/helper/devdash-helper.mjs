#!/usr/bin/env node
// DevDash root helper. The only code that runs as root on behalf of the DevDash server.
// systemd starts one instance per connection on /run/devdash/helper.sock (mode 0660, group devdash):
// one JSON request line on stdin, one JSON response line on stdout.
//
// Rules: dependency-free (install.sh copies this single file to /usr/local/libexec before any npm build runs),
// fixed command allowlist, every argument validated, argv arrays only (never a shell).
// DEVDASH_HELPER_DRYRUN=1 prints the commands instead of running them (used by tests).
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync } from 'node:fs'

const DRY = process.env.DEVDASH_HELPER_DRYRUN === '1'
const planned = []

// Keep in sync with apps/server/src/modules/auth/service.ts
const USERNAME_RE = /^[a-z][a-z0-9-]{1,30}$/
const RESERVED = new Set([
  'root', 'admin', 'devdash', 'caddy', 'daemon', 'bin', 'sys', 'sync', 'games', 'man', 'lp', 'mail', 'news',
  'uucp', 'proxy', 'www-data', 'backup', 'list', 'irc', 'gnats', 'nobody', 'sshd', 'syslog', 'messagebus',
  'ubuntu', 'docker', 'lxd', 'polkitd', 'tss', 'uuidd', 'tcpdump', 'landscape', 'dnsmasq', 'pollinate', 'neko',
])
const MEMBERS_GROUP = 'devdash-users'

class Refused extends Error {}

function username(v) {
  if (typeof v !== 'string' || !USERNAME_RE.test(v) || RESERVED.has(v) || v.startsWith('systemd-') || v.startsWith('devdash')) {
    throw new Refused('invalid username')
  }
  return v
}
function text(v, max) {
  if (typeof v !== 'string' || v.length === 0 || v.length > max || /[\x00-\x1f\x7f:,]/.test(v)) throw new Refused('invalid text field')
  return v
}
function email(v) {
  if (typeof v !== 'string' || v.length > 254 || !/^[^\s@,:]+@[^\s@,:]+\.[^\s@,:]+$/.test(v)) throw new Refused('invalid email')
  return v
}

function run(cmd, args, { allowFail = false } = {}) {
  if (DRY) { planned.push([cmd, ...args].join(' ')); return '' }
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  } catch (err) {
    if (allowFail) return null
    throw new Error(`${cmd} failed: ${(err.stderr || err.message).toString().trim().slice(0, 300)}`)
  }
}

/** passwd entry or null. Never trusts DRY mode for reads: tests pass a fake via DEVDASH_HELPER_FAKE_UID. */
function lookup(name) {
  if (DRY) {
    const fake = process.env.DEVDASH_HELPER_FAKE_UID
    return fake ? { uid: Number(fake), home: `/home/${name}` } : null
  }
  const line = run('getent', ['passwd', name], { allowFail: true })
  if (!line) return null
  const f = line.split(':')
  return { uid: Number(f[2]), home: f[5] }
}

const groupsOf = (name) => (DRY ? [] : (run('id', ['-nG', name], { allowFail: true }) ?? '').split(/\s+/))

const commands = {
  /** Create or adopt the member's Linux account and enable their agent. Idempotent. */
  'user-ensure'(a) {
    const u = username(a.username)
    const name = text(a.name, 80)
    const mail = a.email === undefined ? null : email(a.email)
    const admin = a.admin === true

    let entry = lookup(u)
    let created = false
    if (entry) {
      // Adopt only regular human accounts (e.g. one created by bootstrap.sh), never system accounts.
      if (!(entry.uid >= 1000 && entry.uid < 60000)) throw new Refused('existing account is not a regular user')
    } else {
      run('useradd', ['--create-home', '--shell', '/bin/bash', '--user-group', '--comment', name, u])
      created = true
      entry = lookup(u) ?? { home: `/home/${u}` }
    }

    run('usermod', ['-aG', MEMBERS_GROUP, u])
    if (admin) run('usermod', ['-aG', 'sudo', u])
    else if (groupsOf(u).includes('sudo')) run('gpasswd', ['-d', u, 'sudo'])
    if (!DRY && existsSync(entry.home)) chmodSync(entry.home, 0o700)

    // Git identity, only if we know an email and the member hasn't set one.
    if (mail && !run('runuser', ['-u', u, '--', 'git', 'config', '--global', '--get', 'user.email'], { allowFail: true })) {
      run('runuser', ['-u', u, '--', 'git', 'config', '--global', 'user.name', name])
      run('runuser', ['-u', u, '--', 'git', 'config', '--global', 'user.email', mail])
    }

    run('systemctl', ['enable', '--now', `devdash-agent@${u}.socket`])
    return { created }
  },
}

async function main() {
  let input = ''
  for await (const chunk of process.stdin) {
    input += chunk
    if (input.includes('\n') || input.length > 16_384) break
  }
  let res
  try {
    const req = JSON.parse(input.split('\n')[0])
    const fn = Object.hasOwn(commands, req?.cmd) ? commands[req.cmd] : null
    if (!fn) throw new Refused('unknown command')
    res = { ok: true, ...fn(req.args ?? {}) }
  } catch (err) {
    res = { ok: false, error: err instanceof Refused || err instanceof SyntaxError ? `refused: ${err.message}` : err.message }
  }
  if (DRY) res.planned = planned
  process.stdout.write(JSON.stringify(res) + '\n')
}

await main()
