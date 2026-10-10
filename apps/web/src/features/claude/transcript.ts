// Turns Claude messages (transcript history from the SDK and live SDK events share the same shape) into display
// blocks. Tool results attach to their tool call; subagent messages nest under the Task/Agent call that spawned them.
// Pure and DOM-free so it can be tested with node:test.

type Content = { type: string; [k: string]: unknown }
type Origin = { kind?: string; subkind?: string; from?: string; name?: string; server?: string; body?: string }
export type Raw = {
  type: string
  subtype?: string
  uuid?: string
  parent_tool_use_id?: string | null
  message?: { role?: string; content?: string | Content[] }
  /** Set by Claude Code on user-role messages it writes itself (skill text, notices); history leaves it out. */
  isSynthetic?: boolean
  /** Who a user-role message came from: a person, a background task, another session, Claude Code itself. */
  origin?: Origin | null
  [k: string]: unknown
}

export type ToolBlock = {
  kind: 'tool'
  key: string
  id: string
  name: string
  input: Record<string, unknown>
  /** `images`: pictures the tool returned (Read on an image); `structured`: the tool's own output object (live only). */
  result?: { text: string; isError: boolean; images: string[]; structured?: unknown }
  children: Block[]
}
/** What Claude Code itself put in the conversation: not the person, shown as a quiet line with the raw text one tap away. */
export type EventTone = 'task' | 'skill' | 'peer' | 'schedule' | 'system'
export type Block =
  | { kind: 'user'; key: string; uuid?: string; text: string; images: string[]; files: string[] }
  | { kind: 'text'; key: string; text: string }
  | { kind: 'thinking'; key: string; text: string }
  | ToolBlock
  | { kind: 'command'; key: string; name: string; args?: string; output?: string }
  | { kind: 'result'; key: string; ok: boolean; seconds: number; cost?: number }
  | { kind: 'note'; key: string; text: string }
  | { kind: 'event'; key: string; text: string; ok: boolean; tone?: EventTone; detail?: string }

/** Text of a tool result or message: text parts, plus names for what isn't text (images, files, loaded tools). */
export function toText(c: unknown): string {
  if (typeof c === 'string') return c
  if (!Array.isArray(c)) return ''
  return (c as Content[]).map((x) =>
    x.type === 'text' ? String(x.text)
    : x.type === 'image' ? '[image]'
    : x.type === 'document' ? `[${String(x.title ?? 'file')}]`
    : x.type === 'tool_reference' ? String(x.tool_name ?? '')
    : '').filter((s) => s !== '').join('\n')
}

const imagesOf = (c: unknown) => Array.isArray(c)
  ? (c as Content[]).filter((b) => b.type === 'image').map((b) => {
      const src = b.source as { type?: string; media_type?: string; data?: string } | undefined
      return src?.type === 'base64' ? `data:${src.media_type};base64,${src.data}` : ''
    }).filter(Boolean)
  : []

const unescape = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
const tag = (text: string, name: string) => new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(text)?.[1]
const firstLine = (s: string, max = 140) => { const l = s.trim().split('\n')[0]!.trim(); return l.length > max ? `${l.slice(0, max - 1)}…` : l }
/** DevDash's own nudge after a server restart (apps/server claude service). */
const RESUMED = 'Continue where you left off. (DevDash: the server restarted while you were working.)'

/**
 * A user-role message Claude Code wrote itself, as a quiet event; null when a person wrote it. Uses the SDK's origin
 * and synthetic flags when present (live), and the shapes of the text otherwise (history drops the flags).
 */
function injected(r: Raw, text: string, key: string): Block | null {
  const o = r.origin ?? undefined
  const ev = (tone: EventTone, label: string, detail = text, ok = true): Block => ({ kind: 'event', key, tone, text: label, ok, detail: detail.trim() || undefined })
  const notice = tag(text, 'task-notification')
  if (notice !== undefined) {
    const status = tag(notice, 'status')?.trim() ?? ''
    return { kind: 'event', key, tone: 'task', ok: !/fail|error|killed/i.test(status), text: unescape(tag(notice, 'summary')?.trim() ?? `Background task ${status || 'update'}`) }
  }
  const skill = /^Base directory for this skill:\s*(\S+)/.exec(text.trim())
  if (skill) return ev('skill', `Using the ${skill[1]!.replace(/\/+$/, '').split('/').pop()} skill`)
  if (text.trim() === RESUMED) return ev('system', 'Picked up again after a server restart', '')
  if (o?.kind === 'peer') return ev('peer', `Message from ${o.name || o.from || 'another session'}`, o.body ?? text)
  if (o?.kind === 'channel') return ev('peer', `Message via ${o.server ?? 'a channel'}`)
  if (o?.kind === 'task-notification') return ev(o.subkind === 'scheduled-trigger' ? 'schedule' : 'task', o.subkind === 'scheduled-trigger' ? 'A scheduled run started' : firstLine(text) || 'Background task update')
  if (o?.kind === 'auto-continuation') return ev('system', 'Continued on its own')
  if (o && o.kind !== 'human') return ev('system', 'Claude Code added a note for Claude')
  if (r.isSynthetic === true) return ev('system', 'Claude Code added a note for Claude')
  // A message that is nothing but a machine tag (<scheduled-wakeup>, <monitor-event>…) isn't someone typing.
  const only = /^<([a-z][a-z0-9-]*)>[\s\S]*<\/\1>$/.exec(text.trim())
  if (only) return ev(/wake|schedul|cron|loop/.test(only[1]!) ? 'schedule' : 'system', `${only[1]!.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase())}`)
  return null
}

export function buildTranscript(raws: Raw[]): Block[] {
  const top: Block[] = []
  const tools = new Map<string, ToolBlock>()
  const into = (parent?: string | null) => (parent ? tools.get(parent)?.children : undefined) ?? top

  raws.forEach((r, i) => {
    const key = r.uuid ?? `i${i}`
    const content = r.message?.content

    if (r.type === 'assistant' && Array.isArray(content)) {
      content.forEach((b, j) => {
        const k = `${key}:${j}`
        const list = into(r.parent_tool_use_id)
        if (b.type === 'text' && String(b.text ?? '').trim()) list.push({ kind: 'text', key: k, text: String(b.text) })
        else if (b.type === 'thinking' && String(b.thinking ?? '').trim()) list.push({ kind: 'thinking', key: k, text: String(b.thinking) })
        else if (b.type === 'tool_use' || b.type === 'server_tool_use' || b.type === 'mcp_tool_use') {
          const name = b.type === 'mcp_tool_use' ? `mcp__${String(b.server_name ?? 'mcp')}__${String(b.name)}` : String(b.name)
          const t: ToolBlock = { kind: 'tool', key: k, id: String(b.id), name, input: (b.input as Record<string, unknown>) ?? {}, children: [] }
          tools.set(t.id, t)
          list.push(t)
        } else if (b.type.endsWith('_tool_result') && b.tool_use_id) {
          // Results of tools the API runs itself (web search, MCP connectors) come back in the assistant's own turn.
          const t = tools.get(String(b.tool_use_id))
          if (t) t.result = { text: serverResultText(b), isError: b.is_error === true, images: [] }
        }
      })
      return
    }

    if (r.type === 'user') {
      if (Array.isArray(content)) {
        for (const res of content.filter((b) => b.type === 'tool_result')) {
          const t = tools.get(String(res.tool_use_id))
          if (t) t.result = { text: toText(res.content), isError: res.is_error === true, images: imagesOf(res.content), structured: r.tool_use_result }
        }
      }
      if (r.parent_tool_use_id) return // a subagent's prompt: the tool call already shows it
      const text = typeof content === 'string' ? content : Array.isArray(content) ? content.filter((b) => b.type === 'text').map((b) => String(b.text)).join('\n') : ''
      const images = Array.isArray(content) ? imagesOf(content) : []
      // PDFs and text files sent as documents: shown by name.
      const files = Array.isArray(content) ? content.filter((b) => b.type === 'document').map((b) => String(b.title ?? 'File')) : []
      if (!text.trim() && !images.length && !files.length) return
      if (text.startsWith('Caveat: The messages below') || text.includes('<local-command-caveat>')) return
      const command = tag(text, 'command-name')
      if (command) return void top.push({ kind: 'command', key, name: command.trim(), args: tag(text, 'command-args')?.trim() || undefined })
      const stdout = tag(text, 'local-command-stdout')
      if (stdout !== undefined) {
        const last = top.at(-1)
        if (last?.kind === 'command') last.output = stdout.trim()
        else if (stdout.trim()) top.push({ kind: 'note', key, text: stdout.trim() })
        return
      }
      // Reminders Claude Code appends for the model aren't the person's words.
      const said = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()
      if (!said && !images.length && !files.length) return
      const machine = injected(r, said || text, key)
      if (machine) return void top.push(machine)
      top.push({ kind: 'user', key, uuid: r.uuid, text: said, images, files })
      return
    }

    if (r.type === 'result') {
      top.push({
        kind: 'result', key, ok: r.subtype === 'success' && r.is_error !== true,
        seconds: Math.round(Number(r.duration_ms ?? 0) / 1000), cost: typeof r.total_cost_usd === 'number' ? r.total_cost_usd : undefined,
      })
      return
    }

    if (r.type === 'system' && r.subtype === 'compact_boundary') top.push({ kind: 'note', key, text: 'Conversation compacted to free up context' })
  })
  return top
}

/** Server-run tool results (web search and the like) as text: titles and links where there are some. */
function serverResultText(b: Content): string {
  const c = b.content
  if (Array.isArray(c)) {
    const links = (c as Content[]).filter((x) => x.type === 'web_search_result').map((x) => ({ title: String(x.title ?? x.url), url: String(x.url) }))
    if (links.length) return `Links: ${JSON.stringify(links)}`
    return toText(c)
  }
  return typeof c === 'string' ? c : c ? JSON.stringify(c) : ''
}

/** Adds live messages to what is already shown, skipping any the transcript already had. */
export function mergeRaw(existing: Raw[], incoming: Raw[]): Raw[] {
  const seen = new Set(existing.map((r) => r.uuid).filter(Boolean))
  return [...existing, ...incoming.filter((r) => !r.uuid || !seen.has(r.uuid))]
}

export type Todo = { content: string; status: 'pending' | 'in_progress' | 'completed'; activeForm?: string }
export type FileChange = { path: string; added: number; removed: number; writes: number }

/** For the session side panel: the latest to-do list and every file Claude changed (subagents included). */
export function sessionFacts(blocks: Block[]) {
  let todos: Todo[] = []
  const files = new Map<string, FileChange>()
  const lines = (s: unknown) => (typeof s === 'string' && s ? s.split('\n').length : 0)
  const walk = (list: Block[]) => {
    for (const b of list) {
      if (b.kind !== 'tool') continue
      const i = b.input
      if (b.name === 'TodoWrite' && Array.isArray(i.todos)) todos = i.todos as Todo[]
      if ((b.name === 'Edit' || b.name === 'MultiEdit' || b.name === 'Write') && typeof i.file_path === 'string' && !b.result?.isError) {
        const f = files.get(i.file_path) ?? { path: i.file_path, added: 0, removed: 0, writes: 0 }
        const edits = b.name === 'MultiEdit' && Array.isArray(i.edits) ? (i.edits as Record<string, unknown>[]) : [i]
        for (const e of edits) {
          f.added += lines(b.name === 'Write' ? e.content : e.new_string)
          f.removed += lines(e.old_string)
        }
        f.writes++
        files.set(f.path, f)
      }
      walk(b.children)
    }
  }
  walk(blocks)
  return { todos, files: [...files.values()] }
}
