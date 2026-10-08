import { join } from 'node:path'
import type { Db } from '../../core/db.ts'
import { now } from '../../core/db.ts'
import { requestLine } from '../../core/unix.ts'
import type { User } from '../auth/repo.ts'

/**
 * Keeps each member's Linux account in step with DevDash via the root helper (deploy/helper).
 * Never blocks sign-in: failures are stored on the user row and retried on the next server start.
 */
export function provisioningService({ db, runDir }: { db: Db; runDir: string }) {
  const s = {
    set: db.prepare('update users set provisioned_at = ?, provision_error = ? where id = ?'),
    pending: db.prepare('select id, email, username, name, role from users where disabled_at is null'),
  }

  async function ensure(u: User) {
    if (!runDir) return void s.set.run(now(), null, u.id) // dev machine: no host integration
    try {
      const r = await requestLine<{ ok: boolean; error?: string }>(join(runDir, 'helper.sock'), {
        cmd: 'user-ensure',
        args: {
          username: u.username,
          name: u.name.replace(/[:,\x00-\x1f\x7f]/g, ' ').trim().slice(0, 80) || u.username,
          email: u.email,
          admin: u.role === 'admin',
        },
      }, 120_000)
      if (!r.ok) throw new Error(r.error)
      s.set.run(now(), null, u.id)
    } catch (err) {
      const msg = (err as Error).message.slice(0, 300)
      s.set.run(null, msg, u.id)
      console.error(`provisioning ${u.username} failed: ${msg}`)
    }
  }

  return {
    ensure,
    /** Idempotent: re-applies every active member (role changes, missed sign-ups, a fresh host). */
    async reconcileAll() {
      for (const u of s.pending.all() as User[]) await ensure(u)
    },
  }
}

export type ProvisioningService = ReturnType<typeof provisioningService>
