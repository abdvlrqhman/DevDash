import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ArrowUp, File, FileText, Folder, Paperclip, Square, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { api, unwrap } from '@/lib/api'
import { cn } from '@/lib/utils'
import { ErrorAlert } from '../auth/LoginPage'
import { bytes } from '../files/FilesPage'
import { commandsQuery } from './data'

export type Img = { mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'; data: string }
/** Any other file: PDFs and text go to Claude as documents, anything else is saved on the server for Claude to open. */
export type Doc = { name: string; mediaType: string; data: string; size: number }
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']
const MAX_IMAGE = 5 * 1024 * 1024
const MAX_FILE = 10 * 1024 * 1024
const MAX_TOTAL = 25 * 1024 * 1024
const MAX_COUNT = 6

// Commands Claude Code always has, shown before the session reports its own list.
const BUILTIN = [
  { name: 'compact', description: 'Summarize the conversation to free up context' },
  { name: 'context', description: 'Show how much context is used' },
  { name: 'cost', description: 'Tokens and cost of this session' },
  { name: 'clear', description: 'Start a fresh conversation' },
  { name: 'model', description: 'Change the model' },
  { name: 'init', description: 'Write a CLAUDE.md for this project' },
  { name: 'memory', description: 'Edit memory files' },
  { name: 'review', description: 'Review a pull request' },
]

const base64 = (file: File) => new Promise<string>((resolve, reject) => {
  const r = new FileReader()
  r.onload = () => resolve(String(r.result).split(',')[1] ?? '')
  r.onerror = () => reject(new Error(`Could not read ${file.name}.`))
  r.readAsDataURL(file)
})

/** The @mention being typed right before the caret: "@src/ma" → { start, query: "src/ma" }. */
function mentionAt(text: string, caret: number) {
  const m = /(^|\s)@([^\s@"]*)$/.exec(text.slice(0, caret))
  return m ? { start: m.index + m[1]!.length, query: m[2]! } : null
}

type Item = { key: string; label: string; hint?: string; icon?: ReactNode; apply: () => void }

export function Composer({ sessionId, profile, working, disabledReason, footer, onSend, onStop }: {
  sessionId: string
  profile: string
  working: boolean
  disabledReason?: ReactNode
  /** Small status row under the message box (context used, fast mode, Remote Control). */
  footer?: ReactNode
  onSend: (text: string, images: Img[], files: Doc[]) => Promise<unknown>
  onStop: () => void
}) {
  const [text, setText] = useState('')
  const [caret, setCaret] = useState(0)
  const [images, setImages] = useState<Img[]>([])
  const [files, setFiles] = useState<Doc[]>([])
  const [error, setError] = useState<unknown>(null)
  const [sending, setSending] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [sel, setSel] = useState(0)
  const [dismissed, setDismissed] = useState<string | null>(null)
  const area = useRef<HTMLTextAreaElement>(null)
  const picker = useRef<HTMLInputElement>(null)
  const cmds = useQuery({ ...commandsQuery(profile), enabled: text.startsWith('/') })

  const mention = useMemo(() => mentionAt(text, caret), [text, caret])
  const mentionKey = mention ? `${mention.start}:${mention.query}` : null
  const [query, setQuery] = useState<string | null>(null)
  // A short pause after typing before asking the server, so each keystroke isn't a request.
  useEffect(() => {
    const t = setTimeout(() => setQuery(mention && mentionKey !== dismissed ? mention.query : null), 120)
    return () => clearTimeout(t)
  }, [mention, mentionKey, dismissed])
  const found = useQuery({
    queryKey: ['claude', 'files', sessionId, query],
    queryFn: () => unwrap(api.api.claude.sessions[':id'].files.$get({ param: { id: sessionId }, query: { q: query ?? '' } })),
    enabled: query !== null && !disabledReason,
    staleTime: 30_000,
    placeholderData: (prev) => prev,
  })

  const insert = (value: string, start: number, end: number) => {
    const next = text.slice(0, start) + value + text.slice(end)
    setText(next)
    const at = start + value.length
    setCaret(at)
    requestAnimationFrame(() => {
      area.current?.focus()
      area.current?.setSelectionRange(at, at)
    })
  }

  const items: Item[] = useMemo(() => {
    const slash = /^\/([\w:-]*)$/.exec(text)
    if (slash) {
      const reported = (cmds.data?.commands as { name: string; description: string }[] | undefined) ?? []
      const all = [...reported, ...BUILTIN.filter((b) => !reported.some((r) => r.name === b.name))]
      return all.filter((c) => c.name.toLowerCase().includes(slash[1]!.toLowerCase())).slice(0, 8).map((c) => ({
        key: c.name, label: `/${c.name}`, hint: c.description,
        apply: () => insert(`/${c.name} `, 0, text.length),
      }))
    }
    if (!mention || mentionKey === dismissed || query === null || !found.data) return []
    return found.data.paths.slice(0, 12).map((p) => {
      const dir = p.endsWith('/')
      const name = dir ? p.slice(0, -1).split('/').pop()! : p.split('/').pop()!
      const parent = p.slice(0, p.length - name.length - (dir ? 1 : 0))
      return {
        key: p, label: name + (dir ? '/' : ''), hint: parent || undefined,
        icon: dir ? <Folder className="size-4 shrink-0 text-muted-foreground" /> : <File className="size-4 shrink-0 text-muted-foreground" />,
        apply: () => insert(`@${/\s/.test(p) ? `"${p}"` : p}${dir ? '' : ' '}`, mention.start, caret),
      }
    })
  }, [text, caret, cmds.data, found.data, mention, mentionKey, dismissed, query])

  useEffect(() => setSel(0), [items.length, mentionKey])

  const add = async (list: FileList | File[]) => {
    setError(null)
    try {
      const incoming = [...list].slice(0, Math.max(0, MAX_COUNT - images.length - files.length))
      if (incoming.length < list.length) setError(new Error(`Up to ${MAX_COUNT} files per message.`))
      let total = files.reduce((n, f) => n + f.size, 0) + images.reduce((n, i) => n + (i.data.length * 3) / 4, 0)
      for (const f of incoming) {
        total += f.size
        if (total > MAX_TOTAL) throw new Error('Attachments can add up to 25 MB per message.')
        if (IMAGE_TYPES.includes(f.type)) {
          if (f.size > MAX_IMAGE) throw new Error(`${f.name} is over 5 MB. Images can be up to 5 MB.`)
          const data = await base64(f)
          setImages((x) => [...x, { mediaType: f.type as Img['mediaType'], data }])
        } else {
          if (f.size > MAX_FILE) throw new Error(`${f.name} is over 10 MB. Files can be up to 10 MB.`)
          const data = await base64(f)
          setFiles((x) => [...x, { name: f.name, mediaType: f.type || 'application/octet-stream', data, size: f.size }])
        }
      }
    } catch (e) {
      setError(e)
    }
  }
  const empty = !text.trim() && !images.length && !files.length
  const submit = async () => {
    if (sending || empty || disabledReason) return
    setSending(true)
    setError(null)
    try {
      await onSend(text, images, files)
      setText('')
      setImages([])
      setFiles([])
    } catch (e) {
      setError(e)
    } finally {
      setSending(false)
      area.current?.focus()
    }
  }
  const onKey = (e: KeyboardEvent) => {
    if (items.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => (s + 1) % items.length); return }
      if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => (s - 1 + items.length) % items.length); return }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) { e.preventDefault(); items[Math.min(sel, items.length - 1)]!.apply(); return }
      if (e.key === 'Escape') {
        e.preventDefault()
        if (text.startsWith('/')) setText('')
        else setDismissed(mentionKey)
        return
      }
    }
    // Enter sends on a keyboard; on phones Enter adds a line and the button sends.
    if (e.key === 'Enter' && !e.shiftKey && !matchMedia('(pointer: coarse)').matches) {
      e.preventDefault()
      void submit()
    }
  }
  const onPaste = (e: ClipboardEvent) => {
    if (e.clipboardData.files.length) {
      e.preventDefault()
      void add(e.clipboardData.files)
    }
  }
  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    setDragging(false)
    if (e.dataTransfer.files.length) void add(e.dataTransfer.files)
  }

  if (disabledReason) return <div className="py-2">{disabledReason}</div>

  return (
    <div className="relative flex flex-col gap-2" onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDragging(true) } }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false) }} onDrop={onDrop}>
      {dragging && (
        <div className="pointer-events-none absolute -inset-1 z-20 flex items-center justify-center rounded-2xl border-2 border-dashed border-primary/60 bg-background/90 text-sm font-medium">
          Drop files to attach
        </div>
      )}
      {items.length > 0 && (
        <div role="listbox" aria-label={text.startsWith('/') ? 'Commands' : 'Files'} className="absolute inset-x-0 bottom-full z-10 mb-2 max-h-72 overflow-auto rounded-lg border bg-popover p-1 text-popover-foreground shadow-md">
          {items.map((c, i) => (
            <button key={c.key} role="option" aria-selected={i === sel} onMouseDown={(e) => e.preventDefault()} onClick={c.apply}
              className={cn('flex w-full items-center gap-2.5 rounded-sm px-2 py-1.5 text-left text-sm', i === sel && 'bg-accent text-accent-foreground')}>
              {c.icon}
              <span className="shrink-0 font-mono">{c.label}</span>
              {c.hint && <span className="min-w-0 truncate text-muted-foreground">{c.hint}</span>}
            </button>
          ))}
        </div>
      )}
      <ErrorAlert error={error} />
      {(images.length > 0 || files.length > 0) && (
        <div className="flex flex-wrap gap-2 pl-12">
          {images.map((img, i) => (
            <div key={`i${i}`} className="relative">
              <img src={`data:${img.mediaType};base64,${img.data}`} alt="" className="size-14 rounded-md border object-cover" />
              <Remove label="Remove image" onClick={() => setImages((x) => x.filter((_, j) => j !== i))} />
            </div>
          ))}
          {files.map((f, i) => (
            <div key={`f${i}`} className="relative flex h-14 max-w-56 items-center gap-2 rounded-md border bg-muted/40 py-2 pr-3 pl-2.5">
              <FileText className="size-5 shrink-0 text-muted-foreground" />
              <div className="min-w-0 text-xs">
                <div className="truncate font-medium" title={f.name}>{f.name}</div>
                <div className="text-muted-foreground">{bytes(f.size)}</div>
              </div>
              <Remove label={`Remove ${f.name}`} onClick={() => setFiles((x) => x.filter((_, j) => j !== i))} />
            </div>
          ))}
        </div>
      )}
      {/* Attach on the left, the message in the middle, send (and stop) on the right: one compact row. */}
      <div className="flex items-end gap-2">
        <Button size="icon" variant="ghost" className="size-10 shrink-0 rounded-full text-muted-foreground" aria-label="Attach files" title="Attach images, PDFs or any file" onClick={() => picker.current?.click()}><Paperclip /></Button>
        <input ref={picker} type="file" multiple hidden onChange={(e) => { if (e.target.files) void add(e.target.files); e.target.value = '' }} />
        <Textarea ref={area} value={text} rows={1} onKeyDown={onKey} onPaste={onPaste} aria-label="Message Claude"
          onChange={(e) => { setText(e.target.value); setCaret(e.target.selectionStart) }}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
          placeholder={working ? 'Add a message for Claude' : 'Message Claude, @ to mention a file'}
          className="max-h-[40vh] min-h-10 flex-1 resize-none rounded-[20px] px-4 py-2 text-base leading-6 [field-sizing:content] placeholder:truncate md:text-sm md:leading-6" />
        {/* One button: Stop while Claude works and nothing is typed, otherwise Send (queued until Claude is ready). */}
        {working && empty
          ? <Button size="icon" variant="secondary" className="size-10 shrink-0 rounded-full" aria-label="Stop Claude" onClick={onStop}><Square className="fill-current" /></Button>
          : <Button size="icon" className="size-10 shrink-0 rounded-full" aria-label="Send" disabled={sending || empty} onClick={() => void submit()}><ArrowUp /></Button>}
      </div>
      {footer && <div className="flex min-h-6 flex-wrap items-center gap-1 pl-12">{footer}</div>}
    </div>
  )
}

const Remove = ({ label, onClick }: { label: string; onClick: () => void }) => (
  <button aria-label={label} onClick={onClick}
    className="absolute -top-1.5 -right-1.5 flex size-5 items-center justify-center rounded-full bg-foreground text-background"><X className="size-3" /></button>
)
