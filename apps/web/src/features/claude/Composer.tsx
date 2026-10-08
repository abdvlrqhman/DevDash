import { useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ArrowUp, Paperclip, Square, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { ErrorAlert } from '../auth/LoginPage'
import { commandsQuery } from './data'

export type Img = { mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'; data: string }
const TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']
const MAX = 5 * 1024 * 1024

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

function readImage(file: File): Promise<Img> {
  return new Promise((resolve, reject) => {
    if (!TYPES.includes(file.type)) return reject(new Error('Use a PNG, JPEG, GIF or WebP image.'))
    if (file.size > MAX) return reject(new Error('Images can be up to 5 MB.'))
    const r = new FileReader()
    r.onload = () => resolve({ mediaType: file.type as Img['mediaType'], data: String(r.result).split(',')[1]! })
    r.onerror = () => reject(new Error('Could not read the image.'))
    r.readAsDataURL(file)
  })
}

export function Composer({ profile, working, disabledReason, onSend, onStop }: {
  profile: string
  working: boolean
  disabledReason?: string
  onSend: (text: string, images: Img[]) => Promise<unknown>
  onStop: () => void
}) {
  const [text, setText] = useState('')
  const [images, setImages] = useState<Img[]>([])
  const [error, setError] = useState<unknown>(null)
  const [sending, setSending] = useState(false)
  const [sel, setSel] = useState(0)
  const area = useRef<HTMLTextAreaElement>(null)
  const file = useRef<HTMLInputElement>(null)
  const cmds = useQuery({ ...commandsQuery(profile), enabled: text.startsWith('/') })

  const palette = useMemo(() => {
    const m = /^\/([\w:-]*)$/.exec(text)
    if (!m) return []
    const reported = (cmds.data?.commands as { name: string; description: string }[] | undefined) ?? []
    const all = [...reported, ...BUILTIN.filter((b) => !reported.some((r) => r.name === b.name))]
    return all.filter((c) => c.name.toLowerCase().includes(m[1]!.toLowerCase())).slice(0, 8)
  }, [text, cmds.data])

  const add = async (files: FileList | File[]) => {
    setError(null)
    try {
      const imgs = await Promise.all([...files].slice(0, 6 - images.length).map(readImage))
      setImages((x) => [...x, ...imgs])
    } catch (e) {
      setError(e)
    }
  }
  const submit = async () => {
    if (sending || (!text.trim() && !images.length) || disabledReason) return
    setSending(true)
    setError(null)
    try {
      await onSend(text, images)
      setText('')
      setImages([])
    } catch (e) {
      setError(e)
    } finally {
      setSending(false)
      area.current?.focus()
    }
  }
  const pick = (name: string) => {
    setText(`/${name} `)
    area.current?.focus()
  }
  const onKey = (e: KeyboardEvent) => {
    if (palette.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => (s + 1) % palette.length); return }
      if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => (s - 1 + palette.length) % palette.length); return }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) { e.preventDefault(); pick(palette[Math.min(sel, palette.length - 1)]!.name); return }
      if (e.key === 'Escape') { setText(''); return }
    }
    // Enter sends on a keyboard; on phones Enter adds a line and the button sends.
    if (e.key === 'Enter' && !e.shiftKey && !matchMedia('(pointer: coarse)').matches) {
      e.preventDefault()
      void submit()
    }
  }
  const onPaste = (e: ClipboardEvent) => {
    const files = [...e.clipboardData.files].filter((f) => f.type.startsWith('image/'))
    if (files.length) {
      e.preventDefault()
      void add(files)
    }
  }

  if (disabledReason) return <p className="py-3 text-center text-sm text-muted-foreground">{disabledReason}</p>

  return (
    <div className="relative flex flex-col gap-2">
      {palette.length > 0 && (
        <div role="listbox" aria-label="Commands" className="absolute inset-x-0 bottom-full z-10 mb-2 max-h-72 overflow-auto rounded-lg border bg-popover p-1 text-popover-foreground shadow-md">
          {palette.map((c, i) => (
            <button key={c.name} role="option" aria-selected={i === sel} onMouseDown={(e) => e.preventDefault()} onClick={() => pick(c.name)}
              className={cn('flex w-full items-baseline gap-3 rounded-sm px-2 py-1.5 text-left text-sm', i === sel && 'bg-accent text-accent-foreground')}>
              <span className="shrink-0 font-mono">/{c.name}</span>
              <span className="truncate text-muted-foreground">{c.description}</span>
            </button>
          ))}
        </div>
      )}
      <ErrorAlert error={error} />
      {images.length > 0 && (
        <div className="flex flex-wrap gap-2 pl-12">
          {images.map((img, i) => (
            <div key={i} className="relative">
              <img src={`data:${img.mediaType};base64,${img.data}`} alt="" className="size-14 rounded-md border object-cover" />
              <button aria-label="Remove image" onClick={() => setImages((x) => x.filter((_, j) => j !== i))}
                className="absolute -top-1.5 -right-1.5 flex size-5 items-center justify-center rounded-full bg-foreground text-background"><X className="size-3" /></button>
            </div>
          ))}
        </div>
      )}
      {/* Attach on the left, the message in the middle, send (and stop) on the right: one compact row. */}
      <div className="flex items-end gap-2">
        <Button size="icon" variant="ghost" className="size-10 shrink-0 rounded-full text-muted-foreground" aria-label="Attach images" onClick={() => file.current?.click()}><Paperclip /></Button>
        <input ref={file} type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden onChange={(e) => { if (e.target.files) void add(e.target.files); e.target.value = '' }} />
        <Textarea ref={area} value={text} rows={1} onKeyDown={onKey} onPaste={onPaste} aria-label="Message Claude"
          onChange={(e) => { setText(e.target.value); setSel(0) }}
          placeholder={working ? 'Add a message for Claude' : 'Message Claude'}
          className="max-h-[40vh] min-h-10 flex-1 resize-none rounded-[20px] px-4 py-2 text-base leading-6 [field-sizing:content] placeholder:truncate md:text-sm md:leading-6" />
        {/* One button: Stop while Claude works and nothing is typed, otherwise Send (queued until Claude is ready). */}
        {working && !text.trim() && !images.length
          ? <Button size="icon" variant="secondary" className="size-10 shrink-0 rounded-full" aria-label="Stop Claude" onClick={onStop}><Square className="fill-current" /></Button>
          : <Button size="icon" className="size-10 shrink-0 rounded-full" aria-label="Send" disabled={sending || (!text.trim() && !images.length)} onClick={() => void submit()}><ArrowUp /></Button>}
      </div>
    </div>
  )
}
