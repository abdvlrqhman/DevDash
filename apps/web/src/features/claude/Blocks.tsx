import { useState, type ReactNode } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  IconAlertTriangle, IconBrain, IconCheck, IconChevronRight, IconCircle, IconCircleDashed, IconFileText, IconListCheck,
  IconPencil, IconRobot, IconSearch, IconTerminal2, IconTool, IconWorld,
} from '@tabler/icons-react'
import { openExternal } from '../../lib/shell'
import { cx } from '../../ui'
import type { Block, ToolBlock } from './transcript'

export function Prose({ text }: { text: string }) {
  return (
    <div className="prose-dd">
      <Markdown remarkPlugins={[remarkGfm]} components={{
        a: ({ href, children }) => <a href={href} onClick={(e) => { e.preventDefault(); if (href) openExternal(href) }}>{children}</a>,
      }}>{text}</Markdown>
    </div>
  )
}

export function Blocks({ blocks, senders, nested }: { blocks: Block[]; senders?: Record<string, { name: string }>; nested?: boolean }) {
  return (
    <div className={cx('flex flex-col', nested ? 'gap-2' : 'gap-3.5')}>
      {blocks.map((b) => {
        switch (b.kind) {
          case 'user':
            return (
              <div key={b.key} className="self-end max-w-[85%] flex flex-col items-end gap-1">
                {b.uuid && senders?.[b.uuid] && <span className="text-[12px] text-muted">{senders[b.uuid]!.name}</span>}
                {b.images.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 justify-end">
                    {b.images.map((src, i) => <img key={i} src={src} alt="Attached image" className="max-h-40 rounded-lg" />)}
                  </div>
                )}
                {b.text.trim() && <div className="bg-accent text-on-accent rounded-2xl rounded-br-md px-3.5 py-2 whitespace-pre-wrap break-words">{b.text}</div>}
              </div>
            )
          case 'text':
            return <Prose key={b.key} text={b.text} />
          case 'thinking':
            return <Thinking key={b.key} text={b.text} />
          case 'tool':
            return <ToolCard key={b.key} tool={b} senders={senders} />
          case 'command':
            return (
              <div key={b.key} className="text-[13px]">
                <span className="font-mono bg-surface-2 rounded-md px-2 py-0.5">{b.name}</span>
                {b.output && <pre className="mt-1.5 text-muted text-[12px] whitespace-pre-wrap font-mono m-0">{b.output}</pre>}
              </div>
            )
          case 'result':
            return (
              <p key={b.key} className={cx('text-[12px] m-0 flex items-center gap-1.5', b.ok ? 'text-muted' : 'text-danger')}>
                {b.ok ? <IconCheck size={14} /> : <IconAlertTriangle size={14} />}
                {b.ok ? 'Done' : 'Stopped with an error'} in {b.seconds}s{b.cost !== undefined ? `, $${b.cost.toFixed(2)}` : ''}
              </p>
            )
          case 'note':
            return <p key={b.key} className="text-[12px] text-muted text-center m-0 py-1 border-y border-line">{b.text}</p>
        }
      })}
    </div>
  )
}

function Thinking({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="text-[13px] text-muted">
      <button onClick={() => setOpen(!open)} className="flex items-center gap-1.5" aria-expanded={open}>
        <IconBrain size={15} />Thinking<IconChevronRight size={14} className={cx('transition-transform', open && 'rotate-90')} />
      </button>
      {open && <div className="mt-1.5 pl-5 whitespace-pre-wrap">{text}</div>}
    </div>
  )
}

const str = (v: unknown) => (typeof v === 'string' ? v : v === undefined ? '' : JSON.stringify(v))
const base = (p: string) => p.split('/').pop() || p

/** One line that says what the tool did, by tool name. */
function summary(t: ToolBlock): { icon: ReactNode; label: string; detail: string } {
  const i = t.input
  switch (t.name) {
    case 'Bash': return { icon: <IconTerminal2 size={16} />, label: 'Bash', detail: str(i.command) }
    case 'Read': return { icon: <IconFileText size={16} />, label: 'Read', detail: base(str(i.file_path)) }
    case 'Edit': case 'MultiEdit': return { icon: <IconPencil size={16} />, label: 'Edit', detail: base(str(i.file_path)) }
    case 'Write': return { icon: <IconPencil size={16} />, label: 'Write', detail: base(str(i.file_path)) }
    case 'Grep': return { icon: <IconSearch size={16} />, label: 'Search', detail: str(i.pattern) }
    case 'Glob': return { icon: <IconSearch size={16} />, label: 'Find files', detail: str(i.pattern) }
    case 'WebFetch': return { icon: <IconWorld size={16} />, label: 'Fetch', detail: str(i.url) }
    case 'WebSearch': return { icon: <IconWorld size={16} />, label: 'Web search', detail: str(i.query) }
    case 'Task': case 'Agent': return { icon: <IconRobot size={16} />, label: str(i.subagent_type) || 'Subagent', detail: str(i.description) }
    case 'TodoWrite': return { icon: <IconListCheck size={16} />, label: 'To-dos', detail: '' }
    default: return { icon: <IconTool size={16} />, label: t.name.replace(/^mcp__/, '').replace(/__/g, ': '), detail: '' }
  }
}

function diffLines(t: ToolBlock) {
  const edits = t.name === 'MultiEdit' && Array.isArray(t.input.edits)
    ? (t.input.edits as { old_string?: string; new_string?: string }[])
    : [{ old_string: str(t.input.old_string), new_string: str(t.input.new_string) }]
  return edits.flatMap((e) => [
    ...(e.old_string ?? '').split('\n').filter(Boolean).map((l) => ({ sign: '-', l })),
    ...(e.new_string ?? '').split('\n').filter(Boolean).map((l) => ({ sign: '+', l })),
  ])
}

function ToolCard({ tool: t, senders }: { tool: ToolBlock; senders?: Record<string, { name: string }> }) {
  const s = summary(t)
  const running = !t.result
  const [open, setOpen] = useState(false)

  if (t.name === 'TodoWrite' && Array.isArray(t.input.todos)) return <Todos todos={t.input.todos as Todo[]} />

  const isEdit = t.name === 'Edit' || t.name === 'MultiEdit'
  const diff = isEdit ? diffLines(t) : []
  const added = diff.filter((d) => d.sign === '+').length
  const removed = diff.length - added
  const body = isEdit ? null : t.result?.text
  const expandable = isEdit || !!body || t.children.length > 0

  return (
    <div className="rounded-xl bg-surface border border-line text-[14px] overflow-hidden">
      <button className="w-full flex items-center gap-2 px-3 py-2 text-left disabled:cursor-default" disabled={!expandable}
        onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className={cx('shrink-0', t.result?.isError ? 'text-danger' : 'text-muted')}>{s.icon}</span>
        <span className="font-medium shrink-0">{s.label}</span>
        <span className="font-mono text-[12.5px] text-muted truncate flex-1">{s.detail}</span>
        {isEdit && <span className="text-[12px] shrink-0"><span className="text-success">+{added}</span> <span className="text-danger">-{removed}</span></span>}
        {t.children.length > 0 && <span className="text-[12px] text-muted shrink-0">{t.children.filter((c) => c.kind === 'tool').length} steps</span>}
        {running ? <IconCircleDashed size={15} className="text-brass animate-spin shrink-0" aria-label="Running" /> : expandable && <IconChevronRight size={15} className={cx('text-muted shrink-0 transition-transform', open && 'rotate-90')} />}
      </button>
      {open && (
        <div className="border-t border-line bg-surface-2/60 px-3 py-2">
          {isEdit && (
            <pre className="font-mono text-[12px] m-0 whitespace-pre-wrap break-all max-h-80 overflow-auto">
              {diff.map((d, i) => <div key={i} className={d.sign === '+' ? 'text-success' : 'text-danger'}>{d.sign} {d.l}</div>)}
            </pre>
          )}
          {t.children.length > 0 && <Blocks blocks={t.children} senders={senders} nested />}
          {body && <Output text={body} error={t.result?.isError} />}
        </div>
      )}
    </div>
  )
}

function Output({ text, error }: { text: string; error?: boolean }) {
  const [all, setAll] = useState(false)
  const long = text.length > 3000
  return (
    <div>
      <pre className={cx('font-mono text-[12px] m-0 whitespace-pre-wrap break-words max-h-96 overflow-auto', error && 'text-danger')}>
        {long && !all ? text.slice(0, 3000) + '\n…' : text}
      </pre>
      {long && !all && <button className="text-[12px] text-accent mt-1" onClick={() => setAll(true)}>Show all {Math.round(text.length / 1000)}k characters</button>}
    </div>
  )
}

type Todo = { content: string; status: 'pending' | 'in_progress' | 'completed'; activeForm?: string }
function Todos({ todos }: { todos: Todo[] }) {
  const done = todos.filter((t) => t.status === 'completed').length
  return (
    <div className="rounded-xl bg-surface border border-line px-3 py-2.5 text-[14px]">
      <div className="flex items-center gap-2 mb-1.5"><IconListCheck size={16} className="text-muted" /><span className="font-medium">To-dos</span><span className="text-muted text-[12px]">{done} of {todos.length}</span></div>
      <ul className="m-0 p-0 list-none flex flex-col gap-1">
        {todos.map((t, i) => (
          <li key={i} className={cx('flex items-start gap-2', t.status === 'completed' ? 'text-muted line-through' : t.status === 'in_progress' ? 'text-text font-medium' : 'text-text')}>
            {t.status === 'completed' ? <IconCheck size={16} className="text-success mt-0.5 shrink-0" />
              : t.status === 'in_progress' ? <IconCircleDashed size={16} className="text-brass mt-0.5 shrink-0" />
              : <IconCircle size={16} className="text-muted mt-0.5 shrink-0" />}
            {t.status === 'in_progress' && t.activeForm ? t.activeForm : t.content}
          </li>
        ))}
      </ul>
    </div>
  )
}
