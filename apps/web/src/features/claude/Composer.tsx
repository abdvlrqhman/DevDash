import { useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react'
import { useQuery } from '@tanstack/react-query'
import { IconArrowUp, IconPaperclip, IconPlayerStopFilled, IconSlash, IconX } from '@tabler/icons-react'
import { cx, ErrorText } from '../../ui'
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

  if (disabledReason) return <p className="text-muted text-[14px] text-center m-0 py-3">{disabledReason}</p>

  return (
    <div className="relative flex flex-col gap-2">
      {palette.length > 0 && (
        <ul role="listbox" aria-label="Commands" className="absolute bottom-full mb-2 inset-x-0 m-0 p-1.5 list-none bg-surface border border-line rounded-2xl shadow-lg max-h-72 overflow-auto">
          {palette.map((c, i) => (
            <li key={c.name} role="option" aria-selected={i === sel}>
              <button onMouseDown={(e) => e.preventDefault()} onClick={() => pick(c.name)}
                className={cx('w-full flex items-baseline gap-3 px-2.5 py-2 rounded-lg text-left', i === sel && 'bg-accent-soft')}>
                <span className="font-mono text-[13px] shrink-0">/{c.name}</span>
                <span className="text-[13px] text-muted truncate">{c.description}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <ErrorText error={error} />
      {images.length > 0 && (
        <div className="flex gap-2 flex-wrap">
          {images.map((img, i) => (
            <div key={i} className="relative">
              <img src={`data:${img.mediaType};base64,${img.data}`} alt="" className="size-16 object-cover rounded-lg" />
              <button aria-label="Remove image" onClick={() => setImages((x) => x.filter((_, j) => j !== i))}
                className="absolute -top-1.5 -right-1.5 size-6 rounded-full bg-text text-bg flex items-center justify-center"><IconX size={13} /></button>
            </div>
          ))}
        </div>
      )}
      <div className="rounded-2xl bg-surface-2 px-3 pt-2.5 pb-2 focus-within:ring-2 focus-within:ring-accent">
        <textarea ref={area} value={text} rows={1} onKeyDown={onKey} onPaste={onPaste} aria-label="Message Claude"
          onChange={(e) => { setText(e.target.value); setSel(0) }}
          placeholder={working ? 'Queue a message…' : 'Message Claude…'}
          className="w-full bg-transparent outline-none resize-none text-[15px] leading-normal max-h-[40vh] [field-sizing:content] min-h-6" />
        <div className="flex items-center gap-1 mt-1">
          <button className="size-9 rounded-lg flex items-center justify-center text-muted hover:text-text" aria-label="Commands" onClick={() => { setText('/'); area.current?.focus() }}><IconSlash size={18} /></button>
          <button className="size-9 rounded-lg flex items-center justify-center text-muted hover:text-text" aria-label="Attach images" onClick={() => file.current?.click()}><IconPaperclip size={18} /></button>
          <input ref={file} type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden onChange={(e) => { if (e.target.files) void add(e.target.files); e.target.value = '' }} />
          <span className="flex-1" />
          {working && (
            <button onClick={onStop} aria-label="Stop Claude" className="size-9 rounded-lg bg-text text-bg flex items-center justify-center"><IconPlayerStopFilled size={16} /></button>
          )}
          <button onClick={() => void submit()} aria-label="Send" disabled={sending || (!text.trim() && !images.length)}
            className="size-9 rounded-lg bg-accent text-on-accent flex items-center justify-center disabled:opacity-40"><IconArrowUp size={18} /></button>
        </div>
      </div>
    </div>
  )
}
