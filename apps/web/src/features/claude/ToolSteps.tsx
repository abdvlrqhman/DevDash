import { memo, useState, type ReactNode } from 'react'
import {
  Bot, BookOpen, Brain, CalendarClock, ChevronRight, CircleAlert, ClipboardList, Code, Eye, FilePen, FilePlus, FileText, FolderSearch, Globe, ListChecks,
  LoaderCircle, MessageCircleQuestion, NotebookPen, Plug, Search, SquareTerminal, Wrench, type LucideIcon,
} from 'lucide-react'
import { openExternal } from '@/lib/shell'
import { cn } from '@/lib/utils'
import { Prose } from './Prose'
import { toolView, type Preview, type ToolView } from './tool-view'
import type { Block, ToolBlock } from './transcript'

const ICONS: Record<ToolView['icon'], LucideIcon> = {
  read: FileText, write: FilePlus, edit: FilePen, run: SquareTerminal, search: Search, files: FolderSearch, web: Globe, agent: Bot,
  plan: ClipboardList, ask: MessageCircleQuestion, skill: BookOpen, tools: Wrench, clock: CalendarClock, watch: Eye, task: ListChecks,
  plug: Plug, notebook: NotebookPen, code: Code, tool: Wrench,
}

/**
 * A run of tool calls as one timeline: each step says what it did and how it went; edits, writes, images and errors
 * show without a tap, the rest opens on tap. Long runs fold their middle so the conversation stays readable.
 */
export type StepBlock = ToolBlock | Extract<Block, { kind: 'thinking' }>
export function ToolSteps({ steps, live, renderChildren }: { steps: StepBlock[]; live: boolean; renderChildren: (b: Block[]) => ReactNode }) {
  const [all, setAll] = useState(false)
  const fold = !all && steps.length > 7
  const shown = fold ? [...steps.slice(0, 2), null, ...steps.slice(-3)] : steps
  return (
    <ol className="relative flex flex-col gap-0.5 before:absolute before:top-3 before:bottom-3 before:left-[11px] before:w-px before:bg-border">
      {shown.map((t) => t
        ? t.kind === 'thinking' ? <Thought key={t.key} text={t.text} /> : <Step key={t.key} tool={t} live={live} renderChildren={renderChildren} />
        : (
          <li key="fold" className="relative pl-8">
            <button className="rounded-md px-1.5 py-1 text-xs text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground" onClick={() => setAll(true)}>
              {steps.length - 5} more steps
            </button>
          </li>
        ))}
    </ol>
  )
}

const Step = memo(function Step({ tool: t, live, renderChildren }: { tool: ToolBlock; live: boolean; renderChildren: (b: Block[]) => ReactNode }) {
  const agent = t.name === 'Task' || t.name === 'Agent'
  const v: ToolView = agent ? agentView(t) : toolView(t)
  const running = !t.result && live
  const stopped = !t.result && !live
  const failed = t.result?.isError === true
  const hasChildren = t.children.length > 0
  const expandable = v.details.length > 0 || hasChildren
  const [open, setOpen] = useState(agent && running)
  const Icon = ICONS[v.icon]

  return (
    <li className="relative">
      <button type="button" disabled={!expandable} onClick={() => setOpen((o) => !o)} aria-expanded={expandable ? open : undefined}
        className={cn('group flex w-full min-w-0 items-center gap-2.5 rounded-md py-1 pr-1.5 text-left text-sm transition-colors duration-150',
          expandable && 'hover:bg-muted/60', !expandable && 'cursor-default')}>
        <span className={cn('relative z-10 flex size-6 shrink-0 items-center justify-center rounded-full border bg-background',
          failed ? 'border-destructive/50 text-destructive' : 'text-muted-foreground')}>
          {running ? <LoaderCircle className="size-3.5 animate-spin" /> : failed ? <CircleAlert className="size-3.5" /> : <Icon className="size-3.5" />}
        </span>
        <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
          <span className="shrink-0 font-medium">{running ? `${v.doing}…` : v.verb}</span>
          {v.target && <span className={cn('min-w-0 truncate', v.mono ? 'font-mono text-[12.5px] text-foreground/85' : 'text-foreground/85')} title={v.target}>{v.target}</span>}
          {v.where && <span className={cn('hidden min-w-0 shrink-[4] truncate text-xs text-muted-foreground sm:inline', v.mono || v.icon === 'run' ? 'font-mono' : '')} title={v.where}>{v.where}</span>}
        </span>
        {v.meta && <Meta text={v.meta} failed={failed} />}
        {stopped && <span className="shrink-0 text-xs text-muted-foreground" title="The turn ended before this finished">stopped</span>}
        {expandable && <ChevronRight className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform duration-150', open && 'rotate-90')} />}
      </button>
      {v.inline && <div className="mt-0.5 mb-1.5 pl-8"><PreviewView p={v.inline} /></div>}
      {open && (
        <div className="mt-1 mb-2 flex flex-col gap-2 pl-8">
          {hasChildren && <div className="rounded-lg border bg-card/50 p-2">{renderChildren(t.children)}</div>}
          {v.details.map((p, i) => <PreviewView key={i} p={p} />)}
        </div>
      )}
    </li>
  )
})

/** Claude's thinking between steps: a quiet row, the thought itself on tap. */
function Thought({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  return (
    <li className="relative">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open}
        className="flex w-full items-center gap-2.5 rounded-md py-1 pr-1.5 text-left text-sm text-muted-foreground transition-colors duration-150 hover:bg-muted/60 hover:text-foreground">
        <span className="relative z-10 flex size-6 shrink-0 items-center justify-center rounded-full border bg-background"><Brain className="size-3.5" /></span>
        <span className="flex-1">Thought</span>
        <ChevronRight className={cn('size-3.5 shrink-0 transition-transform duration-150', open && 'rotate-90')} />
      </button>
      {open && <p className="mt-1 mb-2 border-l-2 pl-3 ml-8 text-sm whitespace-pre-wrap text-muted-foreground">{text}</p>}
    </li>
  )
}

function agentView(t: ToolBlock): ToolView {
  const steps = t.children.filter((c) => c.kind === 'tool').length
  const kind = typeof t.input.subagent_type === 'string' ? t.input.subagent_type : 'Agent'
  return {
    icon: 'agent', verb: kind.replace(/[-_]/g, ' ').replace(/^./, (c) => c.toUpperCase()), doing: `${kind} working`,
    target: typeof t.input.description === 'string' ? t.input.description : '',
    meta: steps ? `${steps} ${steps === 1 ? 'step' : 'steps'}` : undefined,
    details: t.result?.text ? [{ kind: 'markdown', text: t.result.text }] : [],
  }
}

function Meta({ text, failed }: { text: string; failed: boolean }) {
  const counts = /^\+(\d+) −(\d+)$/.exec(text)
  if (counts) return <span className="shrink-0 font-mono text-xs tabular-nums"><span className="text-live">+{counts[1]}</span> <span className="text-destructive">−{counts[2]}</span></span>
  return <span className={cn('shrink-0 text-xs tabular-nums', failed ? 'text-destructive' : 'text-muted-foreground')}>{text}</span>
}

function PreviewView({ p }: { p: Preview }) {
  switch (p.kind) {
    case 'diff':
      return (
        <div className="overflow-hidden rounded-md border font-mono text-[12px] leading-5">
          {p.lines.map((l, i) => (
            <div key={i} className={cn('flex min-w-0', l.sign === '+' && 'bg-live/10', l.sign === '-' && 'bg-destructive/10')}>
              <span className={cn('w-5 shrink-0 text-center select-none', l.sign === '+' ? 'text-live' : l.sign === '-' ? 'text-destructive' : 'text-muted-foreground/50')}>{l.sign === ' ' ? '' : l.sign === '-' ? '−' : '+'}</span>
              <span className={cn('min-w-0 flex-1 pr-2 [overflow-wrap:anywhere] whitespace-pre-wrap', l.sign === ' ' && 'text-muted-foreground')}>{l.text || ' '}</span>
            </div>
          ))}
        </div>
      )
    case 'code':
      return (
        <div className="overflow-hidden rounded-md border bg-muted/30">
          {p.label && <div className="border-b px-2.5 py-1 text-[11px] text-muted-foreground">{p.label}</div>}
          <div className="max-h-96 overflow-auto font-mono text-[12px] leading-5">
            {p.lines.map((l, i) => (
              <div key={i} className="flex min-w-0">
                {l.n !== undefined && <span className="w-10 shrink-0 pr-2 text-right text-muted-foreground/60 tabular-nums select-none">{l.n}</span>}
                <span className={cn('min-w-0 flex-1 pr-2 [overflow-wrap:anywhere] whitespace-pre-wrap', l.n === undefined && 'pl-2.5')}>{l.text || ' '}</span>
              </div>
            ))}
            {p.total > p.lines.length && <div className="px-2.5 py-1 text-muted-foreground">… {p.total - p.lines.length} more lines</div>}
          </div>
        </div>
      )
    case 'output':
      return <Output text={p.text} error={p.error} />
    case 'images':
      return <div className="flex flex-wrap gap-2">{p.srcs.map((src, i) => <Zoomable key={i} src={src} />)}</div>
    case 'links':
      return (
        <ul className="flex flex-col gap-1">
          {p.links.map((l, i) => (
            <li key={i} className="min-w-0">
              <a href={l.url} onClick={(e) => { e.preventDefault(); openExternal(l.url) }} className="flex min-w-0 items-baseline gap-2 rounded-md px-1.5 py-0.5 text-sm hover:bg-muted">
                <span className="min-w-0 truncate">{l.title}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{hostOf(l.url)}</span>
              </a>
            </li>
          ))}
        </ul>
      )
    case 'list':
      return (
        <ul className="max-h-72 overflow-auto rounded-md border bg-muted/30 py-1 font-mono text-[12px] leading-5">
          {p.items.map((it, i) => <li key={i} className="truncate px-2.5" title={it}>{it}</li>)}
        </ul>
      )
    case 'markdown':
      return <div className="rounded-md border bg-card px-3 py-2"><Prose text={p.text} /></div>
    case 'fields':
      return (
        <dl className="grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-3 gap-y-1 rounded-md border bg-muted/30 px-2.5 py-2 text-xs">
          {p.fields.map(([k, v], i) => (
            <div key={i} className="contents">
              <dt className="text-muted-foreground">{k}</dt>
              <dd className="min-w-0 font-mono break-words whitespace-pre-wrap">{v}</dd>
            </div>
          ))}
        </dl>
      )
  }
}

const hostOf = (u: string) => { try { return new URL(u).host } catch { return '' } }

function Zoomable({ src }: { src: string }) {
  const [big, setBig] = useState(false)
  return (
    <button type="button" onClick={() => setBig((b) => !b)} className="overflow-hidden rounded-md border" aria-label={big ? 'Smaller' : 'Larger'}>
      <img src={src} alt="What the tool returned" className={cn('block object-contain transition-[max-height] duration-200', big ? 'max-h-[70vh]' : 'max-h-44')} />
    </button>
  )
}

function Output({ text, error }: { text: string; error?: boolean }) {
  const [all, setAll] = useState(false)
  const long = text.length > 4000
  return (
    <div className={cn('overflow-hidden rounded-md border', error ? 'border-destructive/40 bg-destructive/5' : 'bg-muted/30')}>
      <pre className={cn('max-h-96 overflow-auto px-2.5 py-2 font-mono text-[12px] leading-5 break-words whitespace-pre-wrap', error && 'text-destructive')}>
        {long && !all ? `${text.slice(0, 4000)}\n…` : text}
      </pre>
      {long && !all && <button className="w-full border-t px-2.5 py-1 text-left text-xs text-muted-foreground hover:text-foreground" onClick={() => setAll(true)}>Show all {Math.round(text.length / 1000)}k characters</button>}
    </div>
  )
}
