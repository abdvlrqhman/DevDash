// Turns Claude messages (transcript history from the SDK and live SDK events share the same shape) into display
// blocks. Tool results attach to their tool call; subagent messages nest under the Task/Agent call that spawned them.
// Pure and DOM-free so it can be tested with node:test.

type Content = { type: string; [k: string]: unknown }
export type Raw = {
  type: string
  subtype?: string
  uuid?: string
  parent_tool_use_id?: string | null
  message?: { role?: string; content?: string | Content[] }
  [k: string]: unknown
}

export type ToolBlock = {
  kind: 'tool'
  key: string
  id: string
  name: string
  input: Record<string, unknown>
  result?: { text: string; isError: boolean }
  children: Block[]
}
export type Block =
  | { kind: 'user'; key: string; uuid?: string; text: string; images: string[] }
  | { kind: 'text'; key: string; text: string }
  | { kind: 'thinking'; key: string; text: string }
  | ToolBlock
  | { kind: 'command'; key: string; name: string; output?: string }
  | { kind: 'result'; key: string; ok: boolean; seconds: number; cost?: number }
  | { kind: 'note'; key: string; text: string }
  | { kind: 'event'; key: string; text: string; ok: boolean }

export function toText(c: unknown): string {
  if (typeof c === 'string') return c
  if (!Array.isArray(c)) return ''
  return (c as Content[]).map((x) => (x.type === 'text' ? String(x.text) : x.type === 'image' ? '[image]' : '')).join('\n')
}

const unescape = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
const tag = (text: string, name: string) => new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(text)?.[1]

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
        else if (b.type === 'tool_use') {
          const t: ToolBlock = { kind: 'tool', key: k, id: String(b.id), name: String(b.name), input: (b.input as Record<string, unknown>) ?? {}, children: [] }
          tools.set(t.id, t)
          list.push(t)
        }
      })
      return
    }

    if (r.type === 'user') {
      if (Array.isArray(content)) {
        for (const res of content.filter((b) => b.type === 'tool_result')) {
          const t = tools.get(String(res.tool_use_id))
          if (t) t.result = { text: toText(res.content), isError: res.is_error === true }
        }
      }
      if (r.parent_tool_use_id) return // a subagent's prompt: the tool call already shows it
      const text = typeof content === 'string' ? content : Array.isArray(content) ? content.filter((b) => b.type === 'text').map((b) => String(b.text)).join('\n') : ''
      const images = Array.isArray(content)
        ? content.filter((b) => b.type === 'image').map((b) => {
            const src = b.source as { type?: string; media_type?: string; data?: string } | undefined
            return src?.type === 'base64' ? `data:${src.media_type};base64,${src.data}` : ''
          }).filter(Boolean)
        : []
      if (!text.trim() && !images.length) return
      if (text.startsWith('Caveat: The messages below')) return
      // Claude Code talks to the model through user-role messages too (background task results, reminders): not the person.
      const notice = tag(text, 'task-notification')
      if (notice !== undefined) {
        const status = tag(notice, 'status')?.trim() ?? ''
        top.push({ kind: 'event', key, ok: !/fail|error|killed/i.test(status), text: unescape(tag(notice, 'summary')?.trim() ?? `Background task ${status}`) })
        return
      }
      // Reminders Claude Code appends for the model aren't the person's words.
      const said = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()
      if (!said && !images.length) return
      const command = tag(text, 'command-name')
      if (command) return void top.push({ kind: 'command', key, name: command.trim() })
      const stdout = tag(text, 'local-command-stdout')
      if (stdout !== undefined) {
        const last = top.at(-1)
        if (last?.kind === 'command') last.output = stdout.trim()
        else if (stdout.trim()) top.push({ kind: 'note', key, text: stdout.trim() })
        return
      }
      top.push({ kind: 'user', key, uuid: r.uuid, text: said, images })
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
