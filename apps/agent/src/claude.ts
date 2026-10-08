// Claude sessions for one member. Each session id runs in exactly one place at a time:
//   Chat mode: an Agent SDK query in this process (streaming input), events go to the server.
//   CLI mode:  the real `claude` TUI in tmux session c-<id>, status comes from the DevDash plugin's hooks.
// Switching mode stops one process and resumes the same id in the other (Claude Code has no lock of its own).
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { CLAUDE_BIN, loadSdk, type PermissionMode, type PermissionResult, type Query, type SDKUserMessage } from './sdk.ts'
import { hasSession, listSessions, tmux } from './tmux.ts'

export const PLUGIN_DIR = fileURLToPath(new URL('../../../packages/claude-plugin', import.meta.url))
export const PROFILE_RE = /^[a-z0-9][a-z0-9-]{0,20}$/
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const IDLE_CLOSE_MS = 20 * 60_000 // ponytail: fixed; make per-member if RAM allows longer
const run = promisify(execFile)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export type Launch = {
  id: string
  cwd: string
  profile: string
  model?: string | null
  effort?: string | null
  permissionMode: PermissionMode
  /** false until the first message exists, so the first start uses sessionId instead of resume */
  started: boolean
}
export type Status = 'working' | 'waiting' | 'idle' | 'stopped' | 'error'
type Pending = { requestId: string; toolName: string; input: Record<string, unknown>; suggestions?: unknown[]; resolve: (r: PermissionResult) => void }
type Chat = { launch: Launch; q: Query; inbox: Inbox; pending: Map<string, Pending>; status: Status; lastActive: number; done?: Promise<void> }

let emit: (ev: Record<string, unknown>) => void = () => {}
export const setEmitter = (fn: typeof emit) => { emit = fn }

const chats = new Map<string, Chat>()
const cliName = (id: string) => `c-${id}`
export const cliSession = cliName

/** The SDK's streaming input: messages are pushed as the member sends them. */
class Inbox implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = []
  private wake: (() => void) | undefined
  private closed = false
  push(m: SDKUserMessage) {
    this.items.push(m)
    this.wake?.()
  }
  close() {
    this.closed = true
    this.wake?.()
  }
  async *[Symbol.asyncIterator]() {
    while (true) {
      while (this.items.length) yield this.items.shift()!
      if (this.closed) return
      await new Promise<void>((r) => (this.wake = r))
      this.wake = undefined
    }
  }
}

export const profileDir = (p: string) => (p === 'default' ? join(homedir(), '.claude') : join(homedir(), '.claude-profiles', p))
const profileEnv = (p: string): Record<string, string> => (p === 'default' ? {} : { CLAUDE_CONFIG_DIR: profileDir(p) })

function validate(l: Launch) {
  if (!ID_RE.test(l.id)) throw new Error('invalid session id')
  if (!PROFILE_RE.test(l.profile)) throw new Error('invalid profile')
  if (!existsSync(l.cwd)) throw new Error(`Folder not found: ${l.cwd}`)
}

function setStatus(c: Chat | undefined, id: string, status: Status, detail?: string) {
  if (c) {
    if (c.status === status && !detail) return
    c.status = status
  }
  emit({ ev: 'claude.status', id, status, ...(detail ? { detail } : {}) })
}

// Questions and plan approvals need a person in every mode. Bypass mode skips canUseTool entirely, so these two
// tools are routed through a PreToolUse hook instead, which always runs.
const INTERACTIVE = new Set(['AskUserQuestion', 'ExitPlanMode'])
const WEEK_S = 7 * 86_400

async function startChat(l: Launch): Promise<Chat> {
  validate(l)
  await requireLogin(l.profile)
  const sdk = await loadSdk()
  const inbox = new Inbox()
  const pending = new Map<string, Pending>()
  let chat: Chat | undefined
  const ask = (toolName: string, input: Record<string, unknown>, suggestions: unknown[] | undefined, signal: AbortSignal) =>
    new Promise<PermissionResult>((resolve) => {
      const requestId = randomUUID()
      pending.set(requestId, { requestId, toolName, input, suggestions, resolve })
      setStatus(chat, l.id, 'waiting')
      emit({ ev: 'claude.permission', id: l.id, requestId, toolName, input, suggestions })
      signal.addEventListener('abort', () => {
        if (!pending.delete(requestId)) return
        emit({ ev: 'claude.permission_done', id: l.id, requestId })
        resolve({ behavior: 'deny', message: 'Cancelled' })
      })
    })
  const q = sdk.query({
    prompt: inbox,
    options: {
      cwd: l.cwd,
      env: { ...process.env, ...profileEnv(l.profile), DEVDASH_SESSION_ID: l.id },
      pathToClaudeCodeExecutable: CLAUDE_BIN,
      ...(l.started ? { resume: l.id } : { sessionId: l.id }),
      ...(l.model ? { model: l.model } : {}),
      ...(l.effort ? { effort: l.effort } : {}),
      permissionMode: l.permissionMode,
      allowDangerouslySkipPermissions: l.permissionMode === 'bypassPermissions',
      // A complete Claude Code session: same system prompt, settings, skills, agents, hooks and MCP as the CLI.
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      plugins: [{ type: 'local', path: PLUGIN_DIR }],
      includePartialMessages: true,
      canUseTool: async (toolName: string, input: Record<string, unknown>, o: { signal: AbortSignal; suggestions?: unknown[] }) =>
        INTERACTIVE.has(toolName) ? { behavior: 'allow', updatedInput: input } : ask(toolName, input, o.suggestions, o.signal),
      hooks: {
        PreToolUse: [{
          matcher: 'AskUserQuestion|ExitPlanMode',
          timeout: WEEK_S, // people answer from their phone, maybe much later
          hooks: [async (h: { tool_name: string; tool_input: Record<string, unknown> }, _id: string | undefined, o: { signal: AbortSignal }) => {
            const r = await ask(h.tool_name, h.tool_input, undefined, o.signal)
            return {
              hookSpecificOutput: r.behavior === 'allow'
                ? { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: r.updatedInput ?? h.tool_input }
                : { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: r.message },
            }
          }],
        }],
      },
      stderr: (d: string) => console.error(`[${l.id.slice(0, 8)}] ${d.trimEnd()}`),
    },
  })
  chat = { launch: { ...l, started: true }, q, inbox, pending, status: 'idle', lastActive: Date.now() }
  chats.set(l.id, chat)
  chat.done = pump(chat)
  return chat
}

const commandCache = new Map<string, unknown[]>()
const modelCache = new Map<string, unknown[]>()

async function pump(c: Chat) {
  const id = c.launch.id
  try {
    for await (const msg of c.q) {
      c.lastActive = Date.now()
      if (msg.type === 'system' && msg.subtype === 'session_state_changed') {
        const s = msg.state
        setStatus(c, id, s === 'running' ? 'working' : s === 'requires_action' ? 'waiting' : 'idle')
      } else if (msg.type === 'result' && !c.pending.size) {
        setStatus(c, id, 'idle')
      } else if (msg.type === 'system' && msg.subtype === 'init') {
        void c.q.supportedCommands().then((v) => commandCache.set(c.launch.profile, v), () => {})
        void c.q.supportedModels().then((v) => modelCache.set(c.launch.profile, v), () => {})
      }
      emit({ ev: 'claude.msg', id, msg })
    }
    setStatus(c, id, 'idle')
  } catch (err) {
    setStatus(c, id, 'error', (err as Error).message.slice(0, 500))
  } finally {
    if (chats.get(id) === c) chats.delete(id)
    for (const p of c.pending.values()) p.resolve({ behavior: 'deny', message: 'Session closed' })
    emit({ ev: 'claude.closed', id })
  }
}

async function stopChat(c: Chat) {
  c.inbox.close()
  c.q.close()
  await c.done
}

async function stopCli(id: string) {
  const name = cliName(id)
  if (!(await hasSession(name))) return
  await tmux('send-keys', '-t', `=${name}`, 'Escape').catch(() => {})
  await tmux('send-keys', '-t', `=${name}`, '/exit', 'Enter').catch(() => {})
  for (let i = 0; i < 40 && (await hasSession(name)); i++) await sleep(100)
  await tmux('kill-session', '-t', `=${name}`).catch(() => {})
}

/** Sends a user message in Chat mode, starting or resuming the SDK process if needed. */
export async function send(l: Launch, content: unknown[], uuid: string) {
  if (await hasSession(cliName(l.id))) throw new Error('This session is open in the CLI. Switch to Chat to send from here.')
  const c = chats.get(l.id) ?? (await startChat(l))
  c.inbox.push({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, session_id: l.id, uuid })
  c.lastActive = Date.now()
  setStatus(c, l.id, 'working')
}

export function answer(id: string, requestId: string, result: PermissionResult) {
  const c = chats.get(id)
  const p = c?.pending.get(requestId)
  if (!c || !p) throw new Error('This request is no longer waiting for an answer.')
  c.pending.delete(requestId)
  p.resolve(result)
  emit({ ev: 'claude.permission_done', id, requestId })
  setStatus(c, id, 'working')
}

export async function interrupt(id: string) {
  const c = chats.get(id)
  if (c) await c.q.interrupt()
  else if (await hasSession(cliName(id))) await tmux('send-keys', '-t', `=${cliName(id)}`, 'Escape')
}

/** Model, permission mode and effort all apply live to a running Chat session (and to the next start otherwise). */
export async function setOption(id: string, key: 'model' | 'permissionMode' | 'effort', value: string | null) {
  const c = chats.get(id)
  if (!c) return
  if (key === 'model') await c.q.setModel(value ?? undefined)
  else if (key === 'permissionMode') await c.q.setPermissionMode(value as PermissionMode)
  else await c.q.applyFlagSettings({ effortLevel: value })
  c.launch = { ...c.launch, [key]: value }
}

export async function stop(id: string) {
  const c = chats.get(id)
  if (c) await stopChat(c)
  await stopCli(id)
}

/** Opens CLI mode: the SDK process must be gone first, so only one process ever writes the transcript. */
export async function openCli(l: Launch, cols: number, rows: number) {
  validate(l)
  const c = chats.get(l.id)
  if (c) await stopChat(c)
  if (await hasSession(cliName(l.id))) return
  const args = [CLAUDE_BIN, ...(l.started ? ['--resume', l.id] : ['--session-id', l.id]), '--plugin-dir', PLUGIN_DIR]
  if (l.model) args.push('--model', l.model)
  if (l.effort) args.push('--effort', l.effort)
  args.push(...(l.permissionMode === 'bypassPermissions' ? ['--dangerously-skip-permissions'] : ['--permission-mode', l.permissionMode]))
  const env = Object.entries({ ...profileEnv(l.profile), DEVDASH_SESSION_ID: l.id }).flatMap(([k, v]) => ['-e', `${k}=${v}`])
  await tmux('new-session', '-d', '-s', cliName(l.id), '-c', l.cwd, '-x', String(cols), '-y', String(rows), ...env, ...args)
  emit({ ev: 'claude.status', id: l.id, status: 'idle', mode: 'cli' })
}

/** Leaves CLI mode; the next Chat message resumes the session through the SDK. */
export async function closeCli(id: string) {
  await stopCli(id)
  emit({ ev: 'claude.status', id, status: 'idle', mode: 'chat' })
}

export async function snapshot() {
  const cli = (await listSessions()).filter((s) => s.name.startsWith('c-')).map((s) => ({ id: s.name.slice(2), mode: 'cli' }))
  const chat = [...chats.values()].map((c) => ({
    id: c.launch.id, mode: 'chat', status: c.status,
    pending: [...c.pending.values()].map(({ resolve: _, ...p }) => p),
  }))
  return [...chat, ...cli]
}

export function pendingFor(id: string) {
  return [...(chats.get(id)?.pending.values() ?? [])].map(({ resolve: _, ...p }) => p)
}

// The SDK reads CLAUDE_CONFIG_DIR from the environment, so history reads for other profiles take turns.
let envLock: Promise<unknown> = Promise.resolve()
function withProfile<T>(profile: string, fn: () => Promise<T>): Promise<T> {
  const next = envLock.then(async () => {
    const saved = process.env.CLAUDE_CONFIG_DIR
    if (profile === 'default') delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = profileDir(profile)
    try {
      return await fn()
    } finally {
      if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = saved
    }
  })
  envLock = next.catch(() => {})
  return next
}

export async function history(l: Launch) {
  if (!ID_RE.test(l.id) || !PROFILE_RE.test(l.profile)) throw new Error('invalid session')
  const sdk = await loadSdk()
  return withProfile(l.profile, () => sdk.getSessionMessages(l.id, { dir: l.cwd }))
}

export const commands = (profile: string) => commandCache.get(profile) ?? []
export const models = (profile: string) => modelCache.get(profile) ?? []

async function authStatus(name: string) {
  try {
    const { stdout } = await run(CLAUDE_BIN, ['auth', 'status', '--json'], { env: { ...process.env, ...profileEnv(name) }, timeout: 20_000 })
    const s = JSON.parse(stdout) as { loggedIn?: boolean; authMethod?: string; email?: string; subscriptionType?: string }
    return { name, loggedIn: !!s.loggedIn, authMethod: s.authMethod ?? null, email: s.email ?? null, plan: s.subscriptionType ?? null }
  } catch {
    return { name, loggedIn: false, authMethod: null, email: null, plan: null }
  }
}

export async function profiles() {
  const root = join(homedir(), '.claude-profiles')
  const names = ['default', ...(existsSync(root) ? readdirSync(root).filter((n) => PROFILE_RE.test(n) && n !== 'default') : [])]
  return Promise.all(names.map(authStatus))
}

// Without a login the SDK process waits silently; say so up front instead. Checked at most every 5 minutes.
const loginChecked = new Map<string, number>()
async function requireLogin(profile: string) {
  if ((loginChecked.get(profile) ?? 0) > Date.now() - 5 * 60_000) return
  if (!(await authStatus(profile)).loggedIn) {
    throw new Error(`The ${profile === 'default' ? 'default' : `"${profile}"`} Claude profile isn't signed in. Open Claude setup and sign in first.`)
  }
  loginChecked.set(profile, Date.now())
}

export function createProfile(name: string) {
  if (!PROFILE_RE.test(name) || name === 'default') throw new Error('Profile names use lowercase letters, digits and dashes.')
  mkdirSync(profileDir(name), { recursive: true, mode: 0o700 })
}

/** Status for CLI-mode sessions, reported by packages/claude-plugin/hooks/report.mjs. */
export function hook(p: { session_id?: string; hook_event_name?: string }) {
  const id = p.session_id
  if (!id || !ID_RE.test(id) || chats.has(id)) return // Chat mode reports its own status
  const status: Status | undefined = ({
    UserPromptSubmit: 'working', PreToolUse: 'working', Notification: 'waiting', Stop: 'idle', SessionEnd: 'stopped',
  } as Record<string, Status>)[p.hook_event_name ?? '']
  if (status) emit({ ev: 'claude.status', id, status })
}

/** Login runs in a terminal tab, because Claude's own login flow is interactive. */
export function loginCommand(profile: string) {
  if (!PROFILE_RE.test(profile)) throw new Error('invalid profile')
  return { env: profileEnv(profile), args: [CLAUDE_BIN, 'auth', 'login'] }
}

export const busy = () => [...chats.values()].some((c) => c.status === 'working' || c.status === 'waiting')

setInterval(() => {
  for (const c of chats.values()) {
    if (c.status === 'idle' && !c.pending.size && Date.now() - c.lastActive > IDLE_CLOSE_MS) void stopChat(c)
  }
}, 60_000).unref()
