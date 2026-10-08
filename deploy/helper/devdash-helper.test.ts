import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'

const HELPER = new URL('./devdash-helper.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

function call(req: unknown, env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [HELPER], {
    input: typeof req === 'string' ? req : JSON.stringify(req) + '\n',
    env: { ...process.env, DEVDASH_HELPER_DRYRUN: '1', ...env },
    encoding: 'utf8',
  })
  return JSON.parse(r.stdout) as { ok: boolean; error?: string; created?: boolean; planned: string[] }
}

const ok = { username: 'alice', name: 'Alice Smith', email: 'alice@example.com', admin: false }

test('creates a new member with argv-only commands', () => {
  const r = call({ cmd: 'user-ensure', args: ok })
  assert.equal(r.ok, true)
  assert.equal(r.created, true)
  assert.equal(r.planned[0], 'useradd --create-home --shell /bin/bash --user-group --comment Alice Smith alice')
  assert.ok(r.planned.includes('usermod -aG devdash-users alice'))
  assert.ok(!r.planned.some((c) => c.includes('-aG sudo')), 'members get no sudo')
  assert.equal(r.planned.at(-1), 'systemctl enable --now devdash-agent@alice.socket')
})

test('admins get sudo; existing regular accounts are adopted, system accounts refused', () => {
  const adopt = call({ cmd: 'user-ensure', args: { ...ok, admin: true } }, { DEVDASH_HELPER_FAKE_UID: '1000' })
  assert.equal(adopt.ok, true)
  assert.equal(adopt.created, false)
  assert.ok(adopt.planned.includes('usermod -aG sudo alice'))
  assert.ok(!adopt.planned.some((c) => c.startsWith('useradd')))
  const sys = call({ cmd: 'user-ensure', args: ok }, { DEVDASH_HELPER_FAKE_UID: '33' })
  assert.match(sys.error!, /refused: existing account is not a regular user/)
})

test('rejects bad input and unknown commands', () => {
  for (const username of ['root', 'devdash-build', 'Alice', 'a;rm -rf /', '../x', 'systemd-x']) {
    assert.match(call({ cmd: 'user-ensure', args: { ...ok, username } }).error!, /refused: invalid username/, username)
  }
  assert.match(call({ cmd: 'user-ensure', args: { ...ok, name: 'Eve\nroot' } }).error!, /refused: invalid text/)
  assert.match(call({ cmd: 'user-ensure', args: { ...ok, name: 'a:b' } }).error!, /refused: invalid text/)
  assert.match(call({ cmd: 'user-ensure', args: { ...ok, email: 'x@y' } }).error!, /refused: invalid email/)
  assert.match(call({ cmd: 'sh', args: {} }).error!, /refused: unknown command/)
  assert.match(call({ cmd: 'constructor', args: {} }).error!, /refused: unknown command/)
  assert.match(call('not json\n').error!, /refused/)
})
