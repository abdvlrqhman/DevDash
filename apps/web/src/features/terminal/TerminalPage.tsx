import { useCallback, useRef, useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useSearch } from '@tanstack/react-router'
import { IconClipboard, IconPlus, IconShieldLock, IconX } from '@tabler/icons-react'
import { PageHeader } from '../../app/AppShell'
import { api, meQuery, unwrap } from '../../lib/api'
import { Button, Dialog, ErrorText, Light, OtpInput, cx } from '../../ui'
import { TerminalView, type Mods, type Status, type TerminalHandle } from './TerminalView'

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,30}$/
const ADMIN = 'admin'

const STATUS_TEXT: Record<Status, string> = {
  connecting: 'Connecting',
  live: 'Live',
  reconnecting: 'Reconnecting',
  ended: 'Shell exited',
}

export function TerminalPage() {
  const me = useQuery(meQuery).data!
  const qc = useQueryClient()
  const list = useQuery({ queryKey: ['terminals'], queryFn: () => unwrap(api.api.terminals.$get()) })
  const { open: requested } = useSearch({ from: '/app/terminal' })
  const [opened, setOpened] = useState<string[]>(() => (requested && NAME_RE.test(requested) ? [requested] : []))
  const [active, setActive] = useState(() => (requested && NAME_RE.test(requested) ? requested : 'main'))
  const [epoch, setEpoch] = useState(0)
  const [status, setStatus] = useState<Status>('connecting')
  const [mods, setMods] = useState<Mods>({ ctrl: false, alt: false })
  const [adding, setAdding] = useState(false)
  const [closing, setClosing] = useState<string | null>(null)
  const [unlocking, setUnlocking] = useState(false)
  const term = useRef<TerminalHandle>(null)

  const serverNames = (list.data?.terminals ?? []).map((t) => t.name).filter((n) => n !== ADMIN)
  const names = [...new Set(['main', ...serverNames, ...opened])]
  const isAdmin = active === ADMIN
  const onStatus = useCallback((s: Status) => setStatus(s), [])

  const kill = useMutation({
    mutationFn: (name: string) => unwrap(api.api.terminals[':name'].$delete({ param: { name } })),
    onSuccess: (_r, name) => {
      setOpened((o) => o.filter((n) => n !== name))
      if (active === name) setActive('main')
      setEpoch((e) => e + 1)
      void qc.invalidateQueries({ queryKey: ['terminals'] })
    },
  })

  const open = (name: string) => {
    setActive(name)
    setStatus('connecting')
  }

  return (
    <div className="h-full flex flex-col">
      <PageHeader title="Terminal" sub={<span className="font-mono">{me.username}@server</span>}>
        <span className="flex items-center gap-1.5 text-[13px] text-muted" role="status">
          <Light state={status === 'live' ? 'live' : status === 'ended' ? 'idle' : 'waiting'} />
          {STATUS_TEXT[status]}
        </span>
      </PageHeader>

      {isAdmin ? (
        <div className="mx-2 lg:mx-8 mb-2 flex items-center gap-2 rounded-xl bg-danger text-white px-3 py-2">
          <IconShieldLock size={18} />
          <div className="flex-1 min-w-0 text-[13px] leading-snug">
            <div className="font-semibold">Admin shell</div>
            <div className="opacity-85">Root on the whole server. Closes after 15 minutes without typing.</div>
          </div>
          <Button size="sm" variant="ghost" className="text-white" onClick={() => open('main')}>Leave</Button>
        </div>
      ) : (
        <nav aria-label="Terminals" className="flex items-center gap-4 px-4 lg:px-8 border-b border-line overflow-x-auto">
          {names.map((n) => (
            <span key={n} className={cx('flex items-center gap-1 font-mono text-[13px] shrink-0 h-10', n === active ? 'text-text shadow-[inset_0_-2px_0_var(--accent)]' : 'text-muted')}>
              <button className="h-full" aria-current={n === active} onClick={() => open(n)}>{n}</button>
              {n === active && (
                <button className="h-full flex items-center text-muted" aria-label={`Close ${n}`} onClick={() => setClosing(n)}><IconX size={14} /></button>
              )}
            </span>
          ))}
          {adding
            ? <NewTabInput taken={names} onCancel={() => setAdding(false)} onCreate={(n) => { setOpened((o) => [...o, n]); setAdding(false); open(n) }} />
            : <button className="h-10 shrink-0 flex items-center text-muted" aria-label="New terminal" onClick={() => setAdding(true)}><IconPlus size={17} /></button>}
          <span className="flex-1" />
          {me.role === 'admin' && (
            <button className="h-10 text-danger text-[13px] font-medium flex items-center gap-1 shrink-0" onClick={() => setUnlocking(true)}>
              <IconShieldLock size={15} />Admin
            </button>
          )}
        </nav>
      )}

      {list.error && <div className="mx-2 lg:mx-8 mt-2"><ErrorText error={list.error} /></div>}
      <div className={cx('relative flex-1 min-h-0 m-2 lg:mx-8 lg:my-3 rounded-xl overflow-hidden bg-term-bg p-2.5', isAdmin && 'ring-2 ring-danger')}>
        <TerminalView key={`${active}:${epoch}`} ref={term} path={`/api/terminals/${active}/ws`} onStatus={onStatus} onMods={setMods} />
        {status === 'ended' && (
          <div className="absolute inset-0 bg-term-bg/90 flex flex-col items-center justify-center gap-3 text-term-fg text-center px-6">
            <p className="m-0">The shell in <span className="font-mono">{active}</span> exited.</p>
            <Button variant="primary" onClick={() => isAdmin ? setUnlocking(true) : setEpoch((e) => e + 1)}>Start a new shell</Button>
          </div>
        )}
      </div>

      <KeyBar term={term} mods={mods} />

      <Dialog open={closing !== null} onClose={() => setClosing(null)} title={`Close ${closing}?`}>
        <p className="text-muted mt-0">Anything still running in it stops.</p>
        <ErrorText error={kill.error} />
        <div className="flex gap-2 justify-end mt-4">
          <Button onClick={() => setClosing(null)}>Keep it</Button>
          <Button variant="danger" disabled={kill.isPending} onClick={() => kill.mutate(closing!, { onSuccess: () => setClosing(null) })}>Close terminal</Button>
        </div>
      </Dialog>

      <AdminUnlock open={unlocking} onClose={() => setUnlocking(false)} onUnlocked={() => { setUnlocking(false); setEpoch((e) => e + 1); open(ADMIN) }} />
    </div>
  )
}

function NewTabInput({ taken, onCreate, onCancel }: { taken: string[]; onCreate: (n: string) => void; onCancel: () => void }) {
  const [value, setValue] = useState(() => {
    let i = 2
    while (taken.includes(`shell-${i}`)) i++
    return `shell-${i}`
  })
  const valid = NAME_RE.test(value) && !taken.includes(value) && value !== ADMIN
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (valid) onCreate(value)
  }
  return (
    <form onSubmit={submit} className="flex items-center shrink-0">
      <input autoFocus aria-label="New terminal name" value={value} onBlur={onCancel} onKeyDown={(e) => e.key === 'Escape' && onCancel()}
        onChange={(e) => setValue(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'))}
        className={cx('h-8 w-32 rounded-md bg-surface-2 px-2.5 font-mono text-[13px] outline-none ring-2 ring-inset', valid ? 'ring-accent' : 'ring-danger')} />
    </form>
  )
}

function AdminUnlock({ open, onClose, onUnlocked }: { open: boolean; onClose: () => void; onUnlocked: () => void }) {
  const [code, setCode] = useState('')
  const unlock = useMutation({
    mutationFn: () => unwrap(api.api.terminals.admin.unlock.$post({ json: { code } })),
    onSuccess: () => { setCode(''); onUnlocked() },
    onError: () => setCode(''),
  })
  return (
    <Dialog open={open} onClose={() => { setCode(''); unlock.reset(); onClose() }} title="Confirm it's you">
      <form onSubmit={(e) => { e.preventDefault(); if (code.length === 6) unlock.mutate() }} className="flex flex-col gap-3">
        <p className="text-muted m-0">The admin shell has root on the whole server. Enter a fresh code from your authenticator; sudo will then ask for your Linux password.</p>
        <OtpInput label="Authenticator code" value={code} onChange={setCode} autoFocus />
        <ErrorText error={unlock.error} />
        <Button type="submit" variant="danger" full disabled={code.length !== 6 || unlock.isPending}>Open admin shell</Button>
      </form>
    </Dialog>
  )
}

const KEYS: { label: string; seq?: string; mod?: 'ctrl' | 'alt'; aria?: string }[] = [
  { label: 'Esc', seq: '\x1b' }, { label: 'Tab', seq: '\t' }, { label: 'Ctrl', mod: 'ctrl' }, { label: 'Alt', mod: 'alt' },
  { label: '↑', seq: '\x1b[A', aria: 'Up' }, { label: '↓', seq: '\x1b[B', aria: 'Down' }, { label: '←', seq: '\x1b[D', aria: 'Left' }, { label: '→', seq: '\x1b[C', aria: 'Right' },
  { label: '|', seq: '|' }, { label: '~', seq: '~' }, { label: '/', seq: '/' }, { label: '-', seq: '-' },
]

/** Keys a phone keyboard lacks. Only on touch screens; buttons don't steal focus, so the keyboard stays up. */
function KeyBar({ term, mods }: { term: React.RefObject<TerminalHandle | null>; mods: Mods }) {
  const keep = (e: React.PointerEvent) => e.preventDefault()
  return (
    <div className="hidden [@media(pointer:coarse)]:flex gap-1.5 px-2 pb-1.5 overflow-x-auto">
      {KEYS.map((k) => (
        <button key={k.label} onPointerDown={keep} aria-label={k.aria} aria-pressed={k.mod ? mods[k.mod] : undefined}
          onClick={() => (k.mod ? term.current?.toggle(k.mod) : term.current?.send(k.seq!))}
          className={cx('h-9 min-w-10 px-2.5 rounded-[9px] font-mono text-[13px] shrink-0 border', k.mod && mods[k.mod] ? 'bg-brass border-brass text-[#120D03]' : 'bg-surface border-line text-text')}>
          {k.label}
        </button>
      ))}
      <button onPointerDown={keep} aria-label="Paste" className="h-9 min-w-10 px-2.5 rounded-[9px] bg-surface border border-line shrink-0 flex items-center justify-center"
        onClick={() => void navigator.clipboard.readText().then((t) => term.current?.paste(t))}>
        <IconClipboard size={16} />
      </button>
    </div>
  )
}
