import { useEffect, useId, useRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from 'react'

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ')

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'default' | 'danger' | 'ghost'
  size?: 'md' | 'sm'
  full?: boolean
}
export function Button({ variant = 'default', size = 'md', full, className, ...p }: ButtonProps) {
  return (
    <button
      {...p}
      className={cx(
        'inline-flex items-center justify-center gap-1.5 font-medium transition-[filter,opacity] select-none',
        'disabled:opacity-45 disabled:cursor-not-allowed enabled:active:brightness-95 enabled:hover:brightness-[.96]',
        size === 'md' ? 'h-12 px-4 text-[15px] rounded-xl' : 'h-9 px-3 text-[14px] rounded-[10px]',
        variant === 'primary' && 'bg-accent text-on-accent',
        variant === 'default' && 'bg-surface-2 text-text',
        variant === 'danger' && 'bg-danger text-white',
        variant === 'ghost' && 'bg-transparent text-text',
        full && 'w-full',
        className,
      )}
    />
  )
}

type FieldProps = InputHTMLAttributes<HTMLInputElement> & { label: string; icon?: ReactNode; hint?: string; error?: string }
/** Filled input: sits in the page like a slot, no outline until focused. */
export function Field({ label, icon, hint, error, className, ...p }: FieldProps) {
  const id = useId()
  return (
    <div className={cx('flex flex-col gap-1.5', className)}>
      <label htmlFor={id} className="text-[13px] text-muted">{label}</label>
      <div className={cx(
        'h-12 rounded-xl bg-surface-2 flex items-center gap-2.5 px-3.5 ring-inset focus-within:ring-2 focus-within:ring-accent',
        error && 'ring-2 ring-danger',
      )}>
        {icon && <span className="text-muted flex" aria-hidden>{icon}</span>}
        <input id={id} {...p} aria-invalid={!!error} aria-describedby={hint || error ? `${id}-d` : undefined}
          className="flex-1 min-w-0 bg-transparent outline-none text-text text-[15px] placeholder:text-muted" />
      </div>
      {(error || hint) && <p id={`${id}-d`} className={cx('text-[13px] m-0', error ? 'text-danger' : 'text-muted')}>{error || hint}</p>}
    </div>
  )
}

export function Card({ className, children, tone }: { className?: string; children: ReactNode; tone?: 'brass' | 'accent' }) {
  return (
    <div className={cx(
      'rounded-2xl px-4 py-3.5',
      tone === 'brass' ? 'bg-warning-soft' : tone === 'accent' ? 'bg-accent-soft' : 'bg-surface border border-line',
      className,
    )}>{children}</div>
  )
}

const CHIP = { default: 'bg-surface-2 text-text', accent: 'bg-accent-soft text-accent', ok: 'bg-success-soft text-success', warn: 'bg-warning-soft text-warning', bad: 'bg-danger-soft text-danger' }
export function Chip({ tone = 'default', children }: { tone?: keyof typeof CHIP; children: ReactNode }) {
  return <span className={cx('inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[12px] font-medium whitespace-nowrap', CHIP[tone])}>{children}</span>
}

/** Status light from the grid: running (verdigris), waiting for you (brass, blinks), idle (outline), off. */
export function Light({ state, label }: { state: 'live' | 'waiting' | 'idle' | 'error'; label?: string }) {
  return (
    <span role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true} className={cx(
      'inline-block size-2.5 rounded-[3px] shrink-0',
      state === 'live' && 'bg-accent',
      state === 'waiting' && 'bg-brass needs-you',
      state === 'idle' && 'border-2 border-muted',
      state === 'error' && 'bg-danger',
    )} />
  )
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="flex items-center justify-between gap-3 cursor-pointer min-h-11">
      <span className="text-[15px]">{label}</span>
      <input type="checkbox" role="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} className="peer sr-only" />
      <span aria-hidden className={cx(
        'relative w-11 h-[26px] rounded-full transition-colors shrink-0 peer-focus-visible:outline-2 peer-focus-visible:outline-accent peer-focus-visible:outline-offset-2',
        checked ? 'bg-accent' : 'bg-surface-2',
      )}>
        <span className={cx('absolute top-[3px] size-5 rounded-full transition-[left]', checked ? 'left-[21px] bg-on-accent' : 'left-[3px] bg-muted')} />
      </span>
    </label>
  )
}

/** One real input (autofill + paste friendly), drawn as six square cells of the grid. */
export function OtpInput({ value, onChange, label, autoFocus }: { value: string; onChange: (v: string) => void; label: string; autoFocus?: boolean }) {
  const id = useId()
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-[13px] text-muted">{label}</label>
      <div className="relative group">
        <input id={id} value={value} autoFocus={autoFocus} inputMode="numeric" autoComplete="one-time-code" maxLength={6} pattern="\d{6}"
          onChange={(e) => onChange(e.target.value.replace(/\D/g, '').slice(0, 6))}
          className="absolute inset-0 w-full h-full opacity-0 cursor-text" />
        <div aria-hidden className="grid grid-cols-6 gap-1.5 max-w-[340px]">
          {Array.from({ length: 6 }, (_, i) => (
            <span key={i} className={cx(
              'aspect-square rounded-md bg-surface-2 flex items-center justify-center font-mono text-[20px]',
              i === Math.min(value.length, 5) && 'group-focus-within:ring-2 group-focus-within:ring-inset group-focus-within:ring-accent',
            )}>{value[i] ?? ''}</span>
          ))}
        </div>
      </div>
    </div>
  )
}

/** Square-Kufic د built from grid cells, with a brass cursor block inside. Same drawing as public/icon.svg. */
export function Logo({ size = 48, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden className={cx('shrink-0', className)}>
      <rect width="64" height="64" rx="16" fill="var(--logo-bg)" />
      <g fill="#EEF4F0">
        <rect x="31" y="7.5" width="11" height="11" rx="1.6" /><rect x="44" y="7.5" width="11" height="11" rx="1.6" />
        <rect x="44" y="20.5" width="11" height="11" rx="1.6" /><rect x="44" y="33.5" width="11" height="11" rx="1.6" />
        <rect x="5" y="46.5" width="11" height="11" rx="1.6" /><rect x="18" y="46.5" width="11" height="11" rx="1.6" />
        <rect x="31" y="46.5" width="11" height="11" rx="1.6" /><rect x="44" y="46.5" width="11" height="11" rx="1.6" />
      </g>
      <rect x="18" y="20.5" width="11" height="24" rx="1.6" fill="#E3B45A" />
    </svg>
  )
}

const AV = ['bg-accent-soft text-accent', 'bg-warning-soft text-warning', 'bg-surface-2 text-text']
export function Avatar({ name, seed = 0 }: { name: string; seed?: number }) {
  const initials = name.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase()
  return <span aria-hidden className={cx('size-8 rounded-lg flex items-center justify-center text-[12px] font-semibold shrink-0', AV[seed % AV.length])}>{initials}</span>
}

export function ErrorText({ error }: { error: unknown }) {
  if (!error) return null
  return <p role="alert" className="text-[14px] text-danger bg-danger-soft rounded-xl px-3.5 py-2.5 m-0">{error instanceof Error ? error.message : String(error)}</p>
}

export { cx }

/** Native modal <dialog>: focus trap, Esc to close and the backdrop come from the browser. */
export function Dialog({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null)
  const id = useId()
  useEffect(() => {
    const d = ref.current!
    if (open && !d.open) d.showModal()
    if (!open && d.open) d.close()
  }, [open])
  return (
    <dialog ref={ref} onClose={onClose} aria-labelledby={id}
      className="m-auto w-[min(92vw,400px)] rounded-2xl bg-surface text-text p-5 backdrop:bg-black/50">
      <h2 id={id} className="font-head text-[22px] mt-0 mb-2">{title}</h2>
      {open && children}
    </dialog>
  )
}
