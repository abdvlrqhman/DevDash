// What a tool call did, in words: a verb, what it acted on, the outcome, and what to show inline or on tap.
// Pure (no React) so every tool's reading can be tested. Unknown and MCP tools still get a readable view.
import type { ToolBlock } from './transcript'

export type DiffLine = { sign: '+' | '-' | ' '; text: string }
export type Preview =
  | { kind: 'diff'; lines: DiffLine[] }
  | { kind: 'code'; lines: { n?: number; text: string }[]; total: number; label?: string }
  | { kind: 'output'; text: string; error?: boolean }
  | { kind: 'images'; srcs: string[] }
  | { kind: 'links'; links: { title: string; url: string }[] }
  | { kind: 'list'; items: string[] }
  | { kind: 'markdown'; text: string }
  | { kind: 'fields'; fields: [string, string][] }

export type ToolView = {
  /** Icon name, mapped to an icon by the component. */
  icon: 'read' | 'write' | 'edit' | 'run' | 'search' | 'files' | 'web' | 'agent' | 'plan' | 'ask' | 'skill' | 'tools' | 'clock' | 'watch' | 'task' | 'plug' | 'notebook' | 'code' | 'tool'
  verb: string
  /** The verb while it runs ("Reading"). */
  doing: string
  target: string
  mono?: boolean
  /** Quieter context next to the target: a folder, a domain, an MCP server. */
  where?: string
  /** The outcome in a few words: "120 lines", "+3 −1", "8 files". */
  meta?: string
  /** Shown under the row without a tap (edits, writes, images, plans, errors). */
  inline?: Preview
  /** Shown when the row is opened. */
  details: Preview[]
}

const str = (v: unknown) => (typeof v === 'string' ? v : v === undefined || v === null ? '' : JSON.stringify(v))
const base = (p: string) => p.replace(/\/+$/, '').split('/').pop() || p
const dir = (p: string) => { const parts = p.replace(/\/+$/, '').split('/').slice(0, -1).filter(Boolean); return parts.slice(-2).join('/') }
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const clean = (s: string) => s.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').replace(/\s+$/, '')
const linesOf = (s: string) => (s ? s.split('\n') : [])
const nonEmpty = (s: string) => linesOf(s).filter((l) => l.trim()).length
const first = (s: string, max = 120) => { const l = s.trim().split('\n')[0] ?? ''; return l.length > max ? `${l.slice(0, max - 1)}…` : l }
const words = (s: string) => s.replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim().replace(/^./, (c) => c.toUpperCase())
const humanSeconds = (s: number) => (s < 90 ? `${Math.round(s)}s` : s < 5400 ? `${Math.round(s / 60)} min` : `${Math.round(s / 3600)} h`)

/** Read results come numbered ("    12→text"); split into line number and text. */
export function numbered(text: string) {
  return linesOf(clean(text)).map((l) => {
    const m = /^\s*(\d+)[→\t](.*)$/.exec(l)
    return m ? { n: Number(m[1]), text: m[2]! } : { text: l }
  })
}

/** Old/new text as diff lines, with up to two unchanged lines around the change. */
export function diff(oldText: string, newText: string): DiffLine[] {
  const a = linesOf(oldText), b = linesOf(newText)
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length, endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB-- }
  const ctx = 2
  return [
    ...a.slice(Math.max(0, start - ctx), start).map((text) => ({ sign: ' ' as const, text })),
    ...a.slice(start, endA).map((text) => ({ sign: '-' as const, text })),
    ...b.slice(start, endB).map((text) => ({ sign: '+' as const, text })),
    ...a.slice(endA, endA + ctx).map((text) => ({ sign: ' ' as const, text })),
  ]
}

/** "Links: [{title,url},…]" in web search results. */
function links(text: string) {
  const m = /Links:\s*(\[[\s\S]*?\])(?:\n|$)/.exec(text)
  if (!m) return []
  try { return (JSON.parse(m[1]!) as { title?: string; url?: string }[]).filter((l) => l.url).map((l) => ({ title: l.title || l.url!, url: l.url! })) } catch { return [] }
}

/** mcp__plugin_devdash_devdash__task_get → { server: "DevDash", tool: "Task get" }; a plugin's tools carry its name. */
export function mcpName(name: string) {
  const [, server = '', ...rest] = name.split('__')
  const label = /^plugin_([^_]+)_/.exec(server)?.[1] ?? server
  const pretty = label.toLowerCase() === 'devdash' ? 'DevDash' : label.charAt(0).toUpperCase() + label.slice(1)
  return { server: pretty || 'MCP', tool: words(rest.join(' ')) }
}

const output = (t: ToolBlock): Preview[] => {
  const text = clean(t.result?.text ?? '')
  return [
    ...(t.result?.images.length ? [{ kind: 'images', srcs: t.result.images } as Preview] : []),
    ...(text && text !== '[image]' ? [{ kind: 'output', text, error: t.result?.isError } as Preview] : []),
  ]
}
const argFields = (input: Record<string, unknown>): Preview[] => {
  const fields = Object.entries(input).filter(([, v]) => v !== undefined && v !== '' && v !== null)
    .map(([k, v]) => [words(k), typeof v === 'string' ? v : JSON.stringify(v, null, 2)] as [string, string])
  return fields.length ? [{ kind: 'fields', fields }] : []
}
const pretty = (s: string) => { try { return JSON.stringify(JSON.parse(s), null, 2) } catch { return s } }

export function toolView(t: ToolBlock): ToolView {
  const i = t.input
  const text = clean(t.result?.text ?? '')
  const err = t.result?.isError === true
  const errInline: Preview | undefined = err && text ? { kind: 'output', text: linesOf(text).slice(-8).join('\n'), error: true } : undefined
  const path = str(i.file_path ?? i.notebook_path ?? i.path)

  switch (t.name) {
    case 'Read': {
      if (t.result?.images.length) return { icon: 'read', verb: 'Viewed', doing: 'Opening', target: base(path), where: dir(path), meta: 'image', inline: { kind: 'images', srcs: t.result.images }, details: [] }
      const lines = numbered(text).filter((l) => l.n !== undefined)
      const range = lines.length ? `lines ${lines[0]!.n}–${lines.at(-1)!.n}` : ''
      return {
        icon: 'read', verb: 'Read', doing: 'Reading', target: base(path), where: dir(path),
        meta: err ? 'failed' : lines.length ? (Number(i.offset) > 1 || i.limit ? range : plural(lines.length, 'line')) : undefined,
        inline: errInline,
        details: lines.length ? [{ kind: 'code', lines: lines.slice(0, 400), total: lines.length }] : output(t),
      }
    }
    case 'Write': {
      const content = str(i.content)
      const updated = /updated|overwr/i.test(text)
      const all = linesOf(content)
      return {
        icon: 'write', verb: updated ? 'Rewrote' : 'Created', doing: 'Writing', target: base(path), where: dir(path),
        meta: err ? 'failed' : plural(all.length, 'line'),
        inline: errInline ?? { kind: 'diff', lines: all.slice(0, 8).map((l) => ({ sign: '+', text: l })) },
        details: [{ kind: 'code', lines: all.slice(0, 600).map((l, n) => ({ n: n + 1, text: l })), total: all.length }],
      }
    }
    case 'Edit':
    case 'MultiEdit': {
      const edits = t.name === 'MultiEdit' && Array.isArray(i.edits) ? (i.edits as Record<string, unknown>[]) : [i]
      const lines = edits.flatMap((e, n) => [...(n ? [{ sign: ' ' as const, text: '⋯' }] : []), ...diff(str(e.old_string), str(e.new_string))])
      const add = lines.filter((l) => l.sign === '+').length, del = lines.filter((l) => l.sign === '-').length
      return {
        icon: 'edit', verb: 'Edited', doing: 'Editing', target: base(path), where: dir(path),
        meta: err ? 'failed' : `+${add} −${del}`,
        inline: errInline ?? { kind: 'diff', lines: lines.slice(0, 10) },
        details: lines.length > 10 ? [{ kind: 'diff', lines }] : [],
      }
    }
    case 'NotebookEdit':
      return { icon: 'notebook', verb: 'Edited notebook', doing: 'Editing notebook', target: base(path), where: dir(path), meta: str(i.edit_mode) || undefined, inline: errInline, details: [{ kind: 'code', lines: linesOf(str(i.new_source)).map((l) => ({ text: l })), total: nonEmpty(str(i.new_source)) }] }
    case 'Bash': {
      const command = str(i.command)
      const desc = str(i.description)
      const n = nonEmpty(text)
      return {
        icon: 'run', verb: 'Ran', doing: 'Running', target: desc || first(command), mono: !desc, where: desc ? first(command, 80) : undefined,
        meta: i.run_in_background ? 'in background' : err ? 'failed' : n ? plural(n, 'line') : 'no output',
        inline: errInline,
        details: [{ kind: 'code', lines: linesOf(command).map((l) => ({ text: l })), total: 0, label: 'Command' }, ...(text ? [{ kind: 'output', text, error: err } as Preview] : [])],
      }
    }
    case 'BashOutput': case 'TaskOutput':
      return { icon: 'task', verb: 'Checked background task', doing: 'Checking background task', target: str(i.bash_id ?? i.task_id ?? i.shell_id), mono: true, meta: text ? plural(nonEmpty(text), 'line') : undefined, details: output(t) }
    case 'KillShell': case 'KillBash': case 'TaskStop':
      return { icon: 'task', verb: 'Stopped background task', doing: 'Stopping background task', target: str(i.shell_id ?? i.task_id ?? i.bash_id), mono: true, details: output(t) }
    case 'Grep': {
      const found = /^Found (\d+)/.exec(text)
      const n = found ? Number(found[1]) : nonEmpty(text)
      const scope = [str(i.path) && base(str(i.path)), str(i.glob), str(i.type) && `*.${str(i.type)}`].filter(Boolean).join(', ')
      return {
        icon: 'search', verb: 'Searched', doing: 'Searching', target: str(i.pattern), mono: true, where: scope || undefined,
        meta: err ? 'failed' : /No (files|matches) found/i.test(text) ? 'nothing found' : plural(n, i.output_mode === 'content' ? 'match' : 'file', i.output_mode === 'content' ? 'matches' : 'files'),
        inline: errInline, details: text ? [{ kind: 'list', items: linesOf(text.replace(/^Found \d+ files?\n?/, '')).filter(Boolean).slice(0, 300) }] : [],
      }
    }
    case 'Glob': {
      const items = linesOf(text).filter((l) => l.trim() && !/^No files found/i.test(l))
      return { icon: 'files', verb: 'Found files', doing: 'Finding files', target: str(i.pattern), mono: true, where: str(i.path) ? base(str(i.path)) : undefined, meta: err ? 'failed' : items.length ? plural(items.length, 'file') : 'none', inline: errInline, details: items.length ? [{ kind: 'list', items: items.slice(0, 300) }] : [] }
    }
    case 'LS':
      return { icon: 'files', verb: 'Listed', doing: 'Listing', target: base(path), where: dir(path), details: output(t) }
    case 'WebFetch': {
      let host = '', rest = ''
      try { const u = new URL(str(i.url)); host = u.host; rest = u.pathname === '/' ? '' : u.pathname } catch { host = str(i.url) }
      return { icon: 'web', verb: 'Read the page', doing: 'Reading the page', target: host, where: rest || undefined, meta: err ? 'failed' : undefined, inline: errInline, details: [...(str(i.prompt) ? [{ kind: 'fields', fields: [['Looking for', str(i.prompt)]] } as Preview] : []), ...(text ? [{ kind: 'markdown', text } as Preview] : [])] }
    }
    case 'WebSearch': case 'web_search': {
      const found = links(text)
      return { icon: 'web', verb: 'Searched the web', doing: 'Searching the web', target: str(i.query), meta: err ? 'failed' : found.length ? plural(found.length, 'result') : undefined, inline: errInline, details: found.length ? [{ kind: 'links', links: found }] : output(t) }
    }
    case 'ExitPlanMode':
      return { icon: 'plan', verb: 'Proposed a plan', doing: 'Writing a plan', target: '', meta: text ? (/approved|User has approved/i.test(text) ? 'approved' : err ? 'not approved' : undefined) : undefined, inline: str(i.plan) ? { kind: 'markdown', text: str(i.plan) } : undefined, details: [] }
    case 'EnterPlanMode':
      return { icon: 'plan', verb: 'Started planning', doing: 'Starting to plan', target: '', details: output(t) }
    case 'AskUserQuestion': {
      const qs = Array.isArray(i.questions) ? (i.questions as { question?: string }[]) : []
      const answers = [...text.matchAll(/"([^"]+)"="([^"]*)"/g)].map((m) => [m[1]!, m[2]!] as [string, string])
      return { icon: 'ask', verb: 'Asked', doing: 'Asking', target: str(qs[0]?.question), meta: qs.length > 1 ? plural(qs.length, 'question') : undefined, inline: answers.length ? { kind: 'fields', fields: answers } : undefined, details: answers.length ? [] : output(t) }
    }
    case 'Skill':
      return { icon: 'skill', verb: 'Used the skill', doing: 'Loading the skill', target: str(i.skill ?? i.command ?? i.name), mono: true, where: str(i.args) || undefined, details: output(t) }
    case 'SlashCommand':
      return { icon: 'skill', verb: 'Ran command', doing: 'Running command', target: str(i.command), mono: true, details: output(t) }
    case 'ToolSearch': {
      const names = linesOf(text).filter((l) => /^[\w:-]+$/.test(l.trim()))
      return { icon: 'tools', verb: 'Loaded tools', doing: 'Looking up tools', target: names.length ? names.map((n) => n.replace(/^mcp__/, '').split('__').pop()).join(', ') : str(i.query), meta: names.length ? plural(names.length, 'tool') : undefined, details: [] }
    }
    case 'ScheduleWakeup':
      return { icon: 'clock', verb: 'Will check back', doing: 'Scheduling a check', target: str(i.reason), meta: Number(i.delaySeconds) ? `in ${humanSeconds(Number(i.delaySeconds))}` : undefined, details: output(t) }
    case 'Monitor':
      return { icon: 'watch', verb: 'Watching', doing: 'Starting to watch', target: str(i.description ?? i.command), mono: !i.description, details: [...argFields(i), ...output(t)] }
    case 'CronCreate': case 'CronDelete': case 'CronList':
      return { icon: 'clock', verb: t.name === 'CronCreate' ? 'Scheduled' : t.name === 'CronDelete' ? 'Unscheduled' : 'Listed schedules', doing: 'Scheduling', target: str(i.description ?? i.prompt ?? i.id), details: [...argFields(i), ...output(t)] }
    case 'TaskCreate': case 'TaskUpdate': case 'TaskList': case 'TaskGet':
      return { icon: 'task', verb: { TaskCreate: 'Added a task', TaskUpdate: 'Updated a task', TaskList: 'Listed tasks', TaskGet: 'Opened a task' }[t.name]!, doing: 'Updating tasks', target: str(i.subject ?? i.title ?? i.taskId ?? i.id), details: [...argFields(i), ...output(t)] }
    case 'EnterWorktree': case 'ExitWorktree':
      return { icon: 'files', verb: t.name === 'EnterWorktree' ? 'Switched to a worktree' : 'Left the worktree', doing: 'Switching worktree', target: str(i.name ?? i.branch ?? i.path), mono: true, details: output(t) }
    case 'LSP':
      return { icon: 'code', verb: words(str(i.operation) || 'Code lookup'), doing: 'Looking up code', target: base(str(i.filePath ?? i.file_path)), where: i.line ? `line ${str(i.line)}` : undefined, details: output(t) }
    case 'ListMcpResourcesTool': case 'ReadMcpResourceTool': case 'ListMcpResources': case 'ReadMcpResource':
      return { icon: 'plug', verb: /List/.test(t.name) ? 'Listed resources' : 'Read a resource', doing: 'Reading resources', target: str(i.uri ?? i.server), mono: true, details: output(t) }
  }

  if (t.name.startsWith('mcp__')) {
    const { server, tool } = mcpName(t.name)
    const main = Object.values(i).find((v) => typeof v === 'string' && v.trim()) as string | undefined
    return {
      icon: 'plug', verb: tool, doing: tool, target: main ? first(main, 80) : '', where: server, meta: err ? 'failed' : undefined, inline: errInline,
      details: [...argFields(i), ...(t.result?.images.length ? [{ kind: 'images', srcs: t.result.images } as Preview] : []), ...(text ? [{ kind: 'output', text: pretty(text), error: err } as Preview] : [])],
    }
  }
  return { icon: 'tool', verb: words(t.name), doing: words(t.name), target: '', meta: err ? 'failed' : undefined, inline: errInline, details: [...argFields(i), ...output(t)] }
}
