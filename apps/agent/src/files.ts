import { createReadStream } from 'node:fs'
import { lstat, mkdir, open, readdir, realpath, rename, rm, stat } from 'node:fs/promises'
import type { Socket } from 'node:net'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { send } from './tmux.ts'

// Files as this member: their home, the shared project checkouts and the team's shared folder. Linux permissions
// apply on top; paths are resolved (symlinks included) and must stay inside one of these roots.
const SRV = process.env.DEVDASH_PROJECTS_ROOT || '/srv/devdash'
export const roots = () => [
  { id: 'home', label: 'Home', path: homedir() },
  { id: 'projects', label: 'Projects', path: `${SRV}/projects` },
  { id: 'shared', label: 'Shared', path: `${SRV}/files` },
]
const inside = (p: string) => roots().some((r) => p === r.path || p.startsWith(`${r.path}/`)) || p.startsWith(`${SRV}/worktrees/`)

/** An existing path, after symlinks. */
async function existing(p: unknown) {
  if (typeof p !== 'string' || !p.startsWith('/')) throw new Error('Use a full path.')
  const real = await realpath(p).catch(() => null)
  if (!real) throw new Error('That file or folder does not exist.')
  if (!inside(real)) throw new Error('That is outside the folders DevDash can show.')
  return real
}
/** A path that may not exist yet: its folder must exist and be allowed; the name must be plain. */
async function creatable(p: unknown) {
  if (typeof p !== 'string' || !p.startsWith('/')) throw new Error('Use a full path.')
  const name = basename(p)
  if (!name || name === '.' || name === '..' || name.includes('\0')) throw new Error('Choose another name.')
  return join(await existing(dirname(resolve(p))), name)
}

export const ops = {
  roots: () => ({ roots: roots() }),

  async list(r: Record<string, unknown>) {
    const path = await existing(r.path ?? homedir())
    const names = await readdir(path)
    const entries = await Promise.all(names.map(async (name) => {
      const s = await lstat(join(path, name)).catch(() => null)
      if (!s) return null
      const link = s.isSymbolicLink()
      const t = link ? await stat(join(path, name)).catch(() => null) : s
      return { name, dir: !!t?.isDirectory(), link, size: t?.isFile() ? t.size : null, mtime: Math.floor((t ?? s).mtimeMs / 1000) }
    }))
    return {
      path,
      entries: entries.filter((e) => e !== null).sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name, undefined, { numeric: true })),
    }
  },

  async mkdir(r: Record<string, unknown>) {
    await mkdir(await creatable(r.path))
    return { ok: true }
  },

  async rename(r: Record<string, unknown>) {
    const from = await existing(r.from)
    const to = await creatable(r.to)
    if (roots().some((x) => x.path === from)) throw new Error('That folder cannot be renamed.')
    await rename(from, to)
    return { ok: true }
  },

  async remove(r: Record<string, unknown>) {
    const path = await existing(r.path)
    if (roots().some((x) => x.path === path)) throw new Error('That folder cannot be deleted.')
    await rm(path, { recursive: true })
    return { ok: true, path }
  },

  /** Creates a folder and any missing parents, inside the member's folders (a new session's own folder). */
  async mkdirp(r: Record<string, unknown>) {
    if (typeof r.path !== 'string' || !r.path.startsWith('/')) throw new Error('Use a full path.')
    const target = resolve(r.path)
    let base = target
    while (!(await lstat(base).catch(() => null))) base = dirname(base)
    if (!inside(await realpath(base))) throw new Error('That is outside the folders DevDash can show.')
    await mkdir(target, { recursive: true })
    return { path: target }
  },

  /** Whether a shared file is still there (share links stop working once their file is gone). */
  async exists(r: Record<string, unknown>) {
    if (typeof r.path !== 'string' || !r.path.startsWith('/')) throw new Error('Use a full path.')
    const real = await realpath(r.path).catch(() => null)
    return { exists: !!real && inside(real) }
  },

  /** One chunk of an upload. offset 0 starts the file over; chunks arrive in order. */
  async write(r: Record<string, unknown>) {
    const path = await creatable(r.path)
    const offset = Number(r.offset) || 0
    const data = Buffer.from(String(r.data ?? ''), 'base64')
    const fh = await open(path, offset === 0 ? 'w' : 'r+')
    try {
      await fh.write(data, 0, data.length, offset)
    } finally {
      await fh.close()
    }
    return { ok: true, size: offset + data.length }
  },
}

/**
 * Streams a file over the connection: a header line, then base64 chunks as JSON lines, then {end:true}.
 * (The protocol is JSON lines; base64 costs a third more but keeps one framing for everything.)
 */
export async function read(conn: Socket, path: unknown) {
  const real = await existing(path)
  const s = await stat(real)
  if (!s.isFile()) throw new Error('That is a folder, not a file.')
  send(conn, { ok: true, name: basename(real), size: s.size, mtime: Math.floor(s.mtimeMs / 1000) })
  const stream = createReadStream(real, { highWaterMark: 768 * 1024 })
  for await (const chunk of stream) {
    if (!send(conn, { b: (chunk as Buffer).toString('base64') })) await new Promise((r) => conn.once('drain', r))
    if (conn.destroyed) return stream.destroy()
  }
  send(conn, { end: true })
  conn.end()
}
