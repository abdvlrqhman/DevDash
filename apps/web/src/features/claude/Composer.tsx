import { useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ArrowUp, Paperclip, Slash, Square, X } from 'lucide-react'
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupTextarea } from '@/components/ui/input-group'
import { Kbd } from '@/components/ui/kbd'
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
      <InputGroup className="rounded-xl bg-background">
        {images.length > 0 && (
          <InputGroupAddon align="block-start" className="flex flex-wrap gap-2">
            {images.map((img, i) => (
              <div key={i} className="relative">
                <img src={`data:${img.mediaType};base64,${img.data}`} alt="" className="size-14 rounded-md border object-cover" />
                <button aria-label="Remove image" onClick={() => setImages((x) => x.filter((_, j) => j !== i))}
                  className="absolute -top-1.5 -right-1.5 flex size-5 items-center justify-center rounded-full bg-foreground text-background"><X className="size-3" /></button>
              </div>
            ))}
          </InputGroupAddon>
        )}
        <InputGroupTextarea ref={area} value={text} rows={1} onKeyDown={onKey} onPaste={onPaste} aria-label="Message Claude"
          onChange={(e) => { setText(e.target.value); setSel(0) }}
          placeholder={working ? 'Queue a message for when Claude is ready…' : 'Message Claude…'}
          className="max-h-[40vh] min-h-11 text-base [field-sizing:content] md:text-sm" />
        <InputGroupAddon align="block-end" className="gap-1">
          <InputGroupButton size="icon-sm" variant="ghost" aria-label="Commands" onClick={() => { setText('/'); area.current?.focus() }}><Slash /></InputGroupButton>
          <InputGroupButton size="icon-sm" variant="ghost" aria-label="Attach images" onClick={() => file.current?.click()}><Paperclip /></InputGroupButton>
          <input ref={file} type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden onChange={(e) => { if (e.target.files) void add(e.target.files); e.target.value = '' }} />
          <span className="ml-1 hidden text-xs text-muted-foreground md:inline"><Kbd>Enter</Kbd> to send, <Kbd>Shift</Kbd>+<Kbd>Enter</Kbd> for a new line</span>
          <span className="flex-1" />
          {working && <InputGroupButton size="icon-sm" variant="secondary" aria-label="Stop Claude" onClick={onStop}><Square className="fill-current" /></InputGroupButton>}
          <InputGroupButton size="icon-sm" variant="default" aria-label="Send" disabled={sending || (!text.trim() && !images.length)} onClick={() => void submit()}><ArrowUp /></InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
    </div>
  )
}
