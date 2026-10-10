import { memo, useState } from 'react'
import {
  BookOpen, Brain, CalendarClock, Check, ChevronRight, Circle, CircleAlert, FileText, Info, ListChecks, LoaderCircle, MessagesSquare, SquareSlash,
  type LucideIcon,
} from 'lucide-react'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { cn } from '@/lib/utils'
import { Prose } from './Prose'
import { ToolSteps } from './ToolSteps'
import type { Block, EventTone, ToolBlock } from './transcript'

export { Prose }

/** Consecutive tool calls form one timeline; to-do lists stand on their own. */
type Item = Block | { kind: 'steps'; key: string; tools: ToolBlock[] }
function group(blocks: Block[]): Item[] {
  const out: Item[] = []
  for (const b of blocks) {
    if (b.kind === 'tool' && !(b.name === 'TodoWrite' && Array.isArray(b.input.todos))) {
      const last = out.at(-1)
      if (last?.kind === 'steps') last.tools.push(b)
      else out.push({ kind: 'steps', key: b.key, tools: [b] })
    } else out.push(b)
  }
  return out
}

/** `live`: the session is working, so tools without a result are still running (otherwise they were interrupted). */
export const Blocks = memo(function Blocks({ blocks, senders, nested, live = true }: { blocks: Block[]; senders?: Record<string, { name: string }>; nested?: boolean; live?: boolean }) {
  const children = (b: Block[]) => <Blocks blocks={b} senders={senders} nested live={live} />
  return (
    <div className={cn('flex flex-col', nested ? 'gap-2' : 'gap-4')}>
      {group(blocks).map((b) => {
        switch (b.kind) {
          case 'steps':
            return <ToolSteps key={b.key} tools={b.tools} live={live} renderChildren={children} />
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
            return <Todos key={b.key} todos={b.input.todos as Todo[]} />
          case 'command':
            return (
              <div key={b.key} className="flex flex-col gap-1.5 text-sm">
                <span className="flex w-fit max-w-full items-center gap-1.5 rounded-md border bg-muted/40 px-2 py-0.5 font-mono text-[12.5px]">
                  <SquareSlash className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate">{b.name}{b.args ? <span className="text-muted-foreground"> {b.args}</span> : null}</span>
                </span>
                {b.output && <pre className="font-mono text-xs whitespace-pre-wrap text-muted-foreground">{b.output}</pre>}
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
            return <Event key={b.key} text={b.text} ok={b.ok} tone={b.tone} detail={b.detail} />
          case 'note':
            return <p key={b.key} className="border-y py-1.5 text-center text-xs text-muted-foreground">{b.text}</p>
        }
      })}
    </div>
  )
})

const TONE: Record<EventTone, LucideIcon> = { task: Check, skill: BookOpen, peer: MessagesSquare, schedule: CalendarClock, system: Info }

/** Something Claude Code put in the conversation itself: a quiet line, its raw text one tap away. */
function Event({ text, ok, tone = 'task', detail }: { text: string; ok: boolean; tone?: EventTone; detail?: string }) {
  const [open, setOpen] = useState(false)
  const Icon = ok ? TONE[tone] : CircleAlert
  const line = (
    <>
      <Icon className={cn('mt-px size-3.5 shrink-0', !ok ? 'text-destructive' : tone === 'task' ? 'text-live' : 'text-muted-foreground')} />
      <span className="min-w-0 flex-1 break-words">{text}</span>
      {detail && <ChevronRight className={cn('mt-px size-3.5 shrink-0 transition-transform duration-150', open && 'rotate-90')} />}
    </>
  )
  return (
    <div className="text-xs text-muted-foreground">
      {detail
        ? <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="-mx-1.5 flex w-[calc(100%+0.75rem)] items-start gap-2 rounded-md px-1.5 py-0.5 text-left transition-colors duration-150 hover:bg-muted/60 hover:text-foreground">{line}</button>
        : <p className="flex items-start gap-2">{line}</p>}
      {open && detail && <pre className="mt-1 ml-5.5 max-h-72 overflow-auto rounded-md border bg-muted/30 px-2.5 py-2 font-mono text-[11.5px] leading-5 break-words whitespace-pre-wrap">{detail}</pre>}
    </div>
  )
}

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
