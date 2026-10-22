import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

// The member's cloud storage as an rclone remote (`drive:`) in their own rclone config (docs/design/storage.md). The
// remote holds no Google secret: its refresh token is an opaque DevDash handle that the server's loopback token endpoint
// trades for short-lived Google access tokens, so disconnecting in DevDash cuts it off. rclone itself caches the
// access token in this file, so we only rewrite the section when the handle or folder changed.
export type Storage = { remote: string; account: string; folderId: string; handle: string; tokenUrl: string }

const confPath = () => process.env.RCLONE_CONFIG || join(homedir(), '.config', 'rclone', 'rclone.conf')
const SECTION = /^\s*\[([^\]]+)\]\s*$/

/** The config as [name, lines] blocks; text before the first section (comments) is kept under ''. */
function blocks(text: string) {
  const out: [string, string[]][] = [['', []]]
  for (const line of text.split('\n')) {
    const m = SECTION.exec(line)
    if (m) out.push([m[1]!, [line]])
    else out.at(-1)![1].push(line)
  }
  return out
}
const value = (lines: string[], key: string) => lines.map((l) => /^\s*([^=#;]+?)\s*=\s*(.*)$/.exec(l)).find((m) => m?.[1] === key)?.[2]
const join2 = (bs: [string, string[]][]) => bs.flatMap(([, lines]) => lines).join('\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '')

/** Whether a section is the one DevDash manages: it points at DevDash's token endpoint. */
const ours = (lines: string[], tokenUrl: string) => value(lines, 'token_url') === tokenUrl

/**
 * The config with the remote set to `s`, or null when it's already right (same handle and folder), so the access token
 * rclone cached there is kept. Other remotes are left exactly as they were.
 */
export function withRemote(text: string, s: Storage): string | null {
  const bs = blocks(text)
  const current = bs.find(([name]) => name === s.remote)
  if (current && ours(current[1], s.tokenUrl) && value(current[1], 'root_folder_id') === s.folderId) {
    try {
      if ((JSON.parse(value(current[1], 'token') ?? '{}') as { refresh_token?: string }).refresh_token === s.handle) return null
    } catch { /* unreadable token: rewrite it */ }
  }
  // rclone only refreshes a token that has some access token; an empty one makes it drop the refresh token.
  const token = JSON.stringify({ access_token: 'devdash', token_type: 'Bearer', refresh_token: s.handle, expiry: '2000-01-01T00:00:00Z' })
  const section = [
    `[${s.remote}]`,
    'type = drive',
    'client_id = devdash', // the real client and secret stay on the DevDash server; its token endpoint ignores these
    'client_secret = devdash',
    'scope = drive.file',
    `root_folder_id = ${s.folderId}`,
    `token_url = ${s.tokenUrl}`,
    `token = ${token}`,
    '',
  ]
  const rest = bs.filter(([name]) => name !== s.remote)
  return `${join2([...rest, [s.remote, section]]).trimEnd()}\n`
}

/** The config without DevDash's remote, or null when there's nothing of ours to remove (a member's own remote stays). */
export function withoutRemote(text: string, remote: string, tokenUrl: string): string | null {
  const bs = blocks(text)
  const current = bs.find(([name]) => name === remote)
  if (!current || !ours(current[1], tokenUrl)) return null
  const left = join2(bs.filter((b) => b !== current)).trimEnd()
  return left ? `${left}\n` : ''
}

async function update(change: (text: string) => string | null) {
  const path = confPath()
  const text = await readFile(path, 'utf8').catch(() => '')
  const next = change(text)
  if (next === null) return false
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = `${path}.devdash-${process.pid}`
  await writeFile(tmp, next, { mode: 0o600 })
  await chmod(tmp, 0o600)
  await rename(tmp, path)
  return true
}

/** Every value lands in an INI file: refuse anything that could add a line or a section. */
function check(s: Storage) {
  const ok = /^[\w-]{1,40}$/.test(s.remote) && /^[\w-]{1,200}$/.test(s.folderId) && /^ddh_[\w-]{20,200}$/.test(s.handle)
    && /^http:\/\/127\.0\.0\.1:\d{2,5}\/internal\/storage\/token$/.test(s.tokenUrl) && !/[\r\n]/.test(s.account)
  if (!ok) throw new Error('invalid storage settings')
  return s
}

/** Sets up (or refreshes) the remote. Called when the member connects and before each session starts. */
export const configure = (s: Storage) => update((text) => withRemote(text, check(s)))
export const remove = (remote: string, tokenUrl: string) => update((text) => withoutRemote(text, remote, tokenUrl))

/** What Claude is told: where big outputs go, with the commands that keep the local disk free. */
export function note(s: Storage | null | undefined) {
  if (!s) {
    return 'No cloud storage is connected for this person. If the work produces big files (videos, renders, large datasets), suggest they connect their Google Drive on the Storage page in DevDash, so the files don\'t have to stay on this server.'
  }
  return `Big files go to cloud storage, not this server's disk. ${s.account}'s Google Drive is connected as the rclone remote \`${s.remote}:\` (a "DevDash" folder in their Drive; you only see files DevDash put there, not the rest of their Drive).
- Move a finished big output there (the local copy is deleted once it's uploaded): \`rclone move out.mp4 ${s.remote}:videos/ --drive-chunk-size 128M --stats 30s\`
- List, fetch back, share: \`rclone lsf ${s.remote}:videos/\`, \`rclone copy ${s.remote}:videos/out.mp4 .\`, \`rclone link ${s.remote}:videos/out.mp4\` (a link they can open or send)
- Free space: \`rclone about ${s.remote}:\` — personal Google accounts have 15 GB shared with Gmail, so check before big uploads and tell them when it's nearly full.
Tell them where you put things (the path in \`${s.remote}:\` and the link).`
}
