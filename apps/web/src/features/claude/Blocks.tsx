import { memo, useState, type ReactNode } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  Bot, Brain, Check, ChevronRight, Circle, CircleAlert, FilePen, FileText, Globe, ListChecks, LoaderCircle, Search, SquareTerminal, Wrench,
} from 'lucide-react'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { openExternal } from '@/lib/shell'
import { cn } from '@/lib/utils'
import type { Block, ToolBlock } from './transcript'

export const Prose = memo(function Prose({ text }: { text: string }) {
  return (
    <div className="prose-dd text-[15px] md:text-sm">
      <Markdown remarkPlugins={[remarkGfm]} components={{
        a: ({ href, children }) => <a href={href} onClick={(e) => { e.preventDefault(); if (href) openExternal(href) }}>{children}</a>,
      }}>{text}</Markdown>
    </div>
  )
})

/** `live`: the session is working, so tools without a result are still running (otherwise they were interrupted). */
export const Blocks = memo(function Blocks({ blocks, senders, nested, live = true }: { blocks: Block[]; senders?: Record<string, { name: string }>; nested?: boolean; live?: boolean }) {
  return (
    <div className={cn('flex flex-col', nested ? 'gap-2' : 'gap-4')}>
      {blocks.map((b) => {
        switch (b.kind) {
          case 'user':
            return (
              <div key={b.key} className="flex max-w-[85%] flex-col items-end gap-1 self-end">
                {b.uuid && senders?.[b.uuid] && <span className="text-xs text-muted-foreground">{senders[b.uuid]!.name}</span>}
                {b.images.length > 0 && (
                  <div className="flex flex-wrap justify-end gap-1.5">
                    {b.images.map((src, i) => <img key={i} src={src} alt="Attached image" className="max-h-40 rounded-lg border" />)}
                  </div>
                )}
                {b.files.length > 0 && (
                  <div className="flex flex-wrap justify-end gap-1.5">
                    {b.files.map((name, i) => (
                      <span key={i} className="flex max-w-60 items-center gap-1.5 rounded-lg border bg-muted/40 px-2.5 py-1.5 text-xs">
                        <FileText className="size-3.5 shrink-0 text-muted-foreground" /><span className="truncate">{name}</span>
                      </span>
                    ))}
                  </div>
                )}
                {b.text.trim() && <div className="rounded-2xl rounded-br-md bg-primary px-3.5 py-2 text-[15px] break-words whitespace-pre-wrap text-primary-foreground md:text-sm">{b.text}</div>}
              </div>
            )
          case 'text':
            return <Prose key={b.key} text={b.text} />
          case 'thinking':
            return <Thinking key={b.key} text={b.text} />
          case 'tool':
            return <ToolCard key={b.key} tool={b} senders={senders} live={live} />
          case 'command':
            return (
              <div key={b.key} className="text-sm">
                <span className="rounded-md bg-muted px-2 py-0.5 font-mono">{b.name}</span>
                {b.output && <pre className="mt-1.5 font-mono text-xs whitespace-pre-wrap text-muted-foreground">{b.output}</pre>}
              </div>
            )
          case 'result':
            return (
              <p key={b.key} className={cn('flex items-center gap-1.5 text-xs', b.ok ? 'text-muted-foreground' : 'text-destructive')}>
                {b.ok ? <Check className="size-3.5" /> : <CircleAlert className="size-3.5" />}
                {b.ok ? 'Done' : 'Stopped with an error'} in {b.seconds}s{b.cost !== undefined ? `, $${b.cost.toFixed(2)}` : ''}
              </p>
            )
          case 'event':
            return (
              <p key={b.key} className="flex items-start gap-2 text-xs text-muted-foreground">
                {b.ok ? <Check className="mt-px size-3.5 shrink-0 text-live" /> : <CircleAlert className="mt-px size-3.5 shrink-0 text-destructive" />}
                <span className="min-w-0 break-words">{b.text}</span>
              </p>
            )
          case 'note':
            return <p key={b.key} className="border-y py-1.5 text-center text-xs text-muted-foreground">{b.text}</p>
        }
      })}
    </div>
  )
})

function Thinking({ text }: { text: string }) {
  return (
    <Collapsible className="text-sm text-muted-foreground">
      <CollapsibleTrigger className="group flex items-center gap-1.5 hover:text-foreground">
        <Brain className="size-4" />Thinking<ChevronRight className="size-3.5 transition-transform group-data-[state=open]:rotate-90" />
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-1.5 border-l-2 pl-3 whitespace-pre-wrap">{text}</CollapsibleContent>
    </Collapsible>
  )
}

const str = (v: unknown) => (typeof v === 'string' ? v : v === undefined ? '' : JSON.stringify(v))
const base = (p: string) => p.split('/').pop() || p

/** One line that says what the tool did, by tool name. */
function summary(t: ToolBlock): { icon: ReactNode; label: string; detail: string } {
  const i = t.input
  const ic = 'size-4'
  switch (t.name) {
    case 'Bash': return { icon: <SquareTerminal className={ic} />, label: 'Bash', detail: str(i.command) }
    case 'Read': return { icon: <FileText className={ic} />, label: 'Read', detail: base(str(i.file_path)) }
    case 'Edit': case 'MultiEdit': return { icon: <FilePen className={ic} />, label: 'Edit', detail: base(str(i.file_path)) }
    case 'Write': return { icon: <FilePen className={ic} />, label: 'Write', detail: base(str(i.file_path)) }
    case 'Grep': return { icon: <Search className={ic} />, label: 'Search', detail: str(i.pattern) }
    case 'Glob': return { icon: <Search className={ic} />, label: 'Find files', detail: str(i.pattern) }
    case 'WebFetch': return { icon: <Globe className={ic} />, label: 'Fetch', detail: str(i.url) }
    case 'WebSearch': return { icon: <Globe className={ic} />, label: 'Web search', detail: str(i.query) }
    case 'Task': case 'Agent': return { icon: <Bot className={ic} />, label: str(i.subagent_type) || 'Subagent', detail: str(i.description) }
    default: return { icon: <Wrench className={ic} />, label: t.name.replace(/^mcp__/, '').replace(/__/g, ': '), detail: '' }
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

function ToolCard({ tool: t, senders, live }: { tool: ToolBlock; senders?: Record<string, { name: string }>; live: boolean }) {
  if (t.name === 'TodoWrite' && Array.isArray(t.input.todos)) return <Todos todos={t.input.todos as Todo[]} />
  const s = summary(t)
  const running = !t.result && live
  const interrupted = !t.result && !live
  const isEdit = t.name === 'Edit' || t.name === 'MultiEdit'
  const diff = isEdit ? diffLines(t) : []
  const added = diff.filter((d) => d.sign === '+').length
  const body = isEdit ? null : t.result?.text
  const expandable = isEdit || !!body || t.children.length > 0

  return (
    <Collapsible className="overflow-hidden rounded-lg border bg-card text-sm">
      <CollapsibleTrigger disabled={!expandable} className="group flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-muted/50 disabled:cursor-default disabled:hover:bg-transparent">
        <span className={cn('shrink-0', t.result?.isError ? 'text-destructive' : 'text-muted-foreground')}>{s.icon}</span>
        <span className="shrink-0 font-medium">{s.label}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">{s.detail}</span>
        {isEdit && <span className="shrink-0 font-mono text-xs"><span className="text-live">+{added}</span> <span className="text-destructive">-{diff.length - added}</span></span>}
        {t.children.length > 0 && <span className="shrink-0 text-xs text-muted-foreground">{t.children.filter((c) => c.kind === 'tool').length} steps</span>}
        {interrupted && <span className="shrink-0 text-xs text-muted-foreground" title="It stopped before finishing (the turn was interrupted)">No result</span>}
        {running
          ? <LoaderCircle className="size-4 shrink-0 animate-spin text-muted-foreground" aria-label="Running" />
          : expandable && <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" />}
      </CollapsibleTrigger>
      <CollapsibleContent className="border-t bg-muted/40 px-3 py-2">
        {isEdit && (
          <pre className="max-h-80 overflow-auto font-mono text-xs break-all whitespace-pre-wrap">
            {diff.map((d, i) => <div key={i} className={d.sign === '+' ? 'text-live' : 'text-destructive'}>{d.sign} {d.l}</div>)}
          </pre>
        )}
        {t.children.length > 0 && <Blocks blocks={t.children} senders={senders} nested live={live} />}
        {body && <Output text={body} error={t.result?.isError} />}
      </CollapsibleContent>
    </Collapsible>
  )
}

function Output({ text, error }: { text: string; error?: boolean }) {
  const [all, setAll] = useState(false)
  const long = text.length > 3000
  return (
    <div>
      <pre className={cn('max-h-96 overflow-auto font-mono text-xs break-words whitespace-pre-wrap', error && 'text-destructive')}>
        {long && !all ? text.slice(0, 3000) + '\n…' : text}
      </pre>
      {long && !all && <button className="mt-1 text-xs underline underline-offset-2" onClick={() => setAll(true)}>Show all {Math.round(text.length / 1000)}k characters</button>}
    </div>
  )
}

type Todo = { content: string; status: 'pending' | 'in_progress' | 'completed'; activeForm?: string }
function Todos({ todos }: { todos: Todo[] }) {
  const done = todos.filter((t) => t.status === 'completed').length
  return (
    <div className="rounded-lg border bg-card px-3 py-2.5 text-sm">
      <div className="mb-2 flex items-center gap-2">
        <ListChecks className="size-4 text-muted-foreground" /><span className="font-medium">To-dos</span>
        <span className="text-xs text-muted-foreground">{done} of {todos.length}</span>
      </div>
      <ul className="flex flex-col gap-1.5">
        {todos.map((t, i) => (
          <li key={i} className={cn('flex items-start gap-2', t.status === 'completed' && 'text-muted-foreground line-through', t.status === 'in_progress' && 'font-medium')}>
            {t.status === 'completed' ? <Check className="mt-0.5 size-4 shrink-0 text-live" />
              : t.status === 'in_progress' ? <LoaderCircle className="mt-0.5 size-4 shrink-0 animate-spin text-attention-foreground" />
              : <Circle className="mt-0.5 size-4 shrink-0 text-muted-foreground" />}
            {t.status === 'in_progress' && t.activeForm ? t.activeForm : t.content}
          </li>
        ))}
      </ul>
    </div>
  )
}
