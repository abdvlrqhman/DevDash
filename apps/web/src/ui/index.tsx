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
        'inline-flex items-center justify-center gap-1.5 rounded-xl border font-medium transition-[filter,opacity] select-none',
        'disabled:opacity-50 disabled:cursor-not-allowed enabled:active:brightness-95 enabled:hover:brightness-[.97]',
        size === 'md' ? 'h-11 px-4 text-[14px]' : 'h-9 px-3 text-[13px] rounded-[10px]',
        variant === 'primary' && 'bg-accent border-accent text-on-accent',
        variant === 'default' && 'bg-surface border-line text-text',
        variant === 'danger' && 'bg-danger border-danger text-white',
        variant === 'ghost' && 'bg-transparent border-transparent text-text',
        full && 'w-full',
        className,
      )}
    />
  )
}

type FieldProps = InputHTMLAttributes<HTMLInputElement> & { label: string; icon?: ReactNode; hint?: string; error?: string }
export function Field({ label, icon, hint, error, className, ...p }: FieldProps) {
  const id = useId()
  return (
    <div className={cx('flex flex-col gap-1', className)}>
      <label htmlFor={id} className="text-[12px] text-muted px-0.5">{label}</label>
      <div className={cx('h-11 rounded-xl border bg-surface flex items-center gap-2 px-3 focus-within:border-accent', error ? 'border-danger' : 'border-line')}>
        {icon && <span className="text-muted text-[18px] flex" aria-hidden>{icon}</span>}
        <input id={id} {...p} aria-invalid={!!error} aria-describedby={hint || error ? `${id}-d` : undefined}
          className="flex-1 min-w-0 bg-transparent outline-none text-text placeholder:text-muted" />
      </div>
      {(error || hint) && <p id={`${id}-d`} className={cx('text-[12px] px-0.5', error ? 'text-danger' : 'text-muted')}>{error || hint}</p>}
    </div>
  )
}

export function Card({ className, children, accent }: { className?: string; children: ReactNode; accent?: boolean }) {
  return <div className={cx('bg-surface border rounded-2xl px-3.5 py-3', accent ? 'border-accent' : 'border-line', className)}>{children}</div>
}

const CHIP = { default: 'bg-surface-2 text-text', accent: 'bg-accent-soft text-accent', ok: 'bg-success-soft text-success', warn: 'bg-warning-soft text-warning', bad: 'bg-danger-soft text-danger' }
export function Chip({ tone = 'default', children }: { tone?: keyof typeof CHIP; children: ReactNode }) {
  return <span className={cx('inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[12px] font-medium whitespace-nowrap', CHIP[tone])}>{children}</span>
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="flex items-center justify-between gap-3 cursor-pointer min-h-11">
      <span className="text-[14px]">{label}</span>
      <input type="checkbox" role="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} className="peer sr-only" />
      <span aria-hidden className={cx(
        'relative w-[42px] h-6 rounded-full border transition-colors peer-focus-visible:outline-2 peer-focus-visible:outline-accent peer-focus-visible:outline-offset-2',
        checked ? 'bg-accent border-accent' : 'bg-surface-2 border-line',
      )}>
        <span className={cx('absolute top-[3px] size-4 rounded-full transition-[left]', checked ? 'left-[21px] bg-on-accent' : 'left-[3px] bg-muted')} />
      </span>
    </label>
  )
}

/** One real input (autofill + paste friendly), drawn as six boxes like the mockup. */
export function OtpInput({ value, onChange, label, autoFocus }: { value: string; onChange: (v: string) => void; label: string; autoFocus?: boolean }) {
  const id = useId()
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-[12px] text-muted px-0.5">{label}</label>
      <div className="relative group">
        <input id={id} value={value} autoFocus={autoFocus} inputMode="numeric" autoComplete="one-time-code" maxLength={6} pattern="\d{6}"
          onChange={(e) => onChange(e.target.value.replace(/\D/g, '').slice(0, 6))}
          className="absolute inset-0 w-full h-full opacity-0 cursor-text" />
        <div aria-hidden className="flex gap-2">
          {Array.from({ length: 6 }, (_, i) => (
            <span key={i} className={cx(
              'flex-1 h-[50px] rounded-xl border bg-surface flex items-center justify-center font-mono text-[20px]',
              i === Math.min(value.length, 5) ? 'border-line group-focus-within:border-accent' : 'border-line',
            )}>{value[i] ?? ''}</span>
          ))}
        </div>
      </div>
    </div>
  )
}

export function Logo({ size = 56 }: { size?: number }) {
  return (
    <div aria-hidden style={{ width: size, height: size, fontSize: size * 0.6, borderRadius: size * 0.32 }}
      className="bg-accent text-on-accent flex items-center justify-center font-logo font-bold pb-[0.1em] shrink-0">د</div>
  )
}

const AV = ['bg-accent-soft text-accent', 'bg-success-soft text-success', 'bg-warning-soft text-warning']
export function Avatar({ name, seed = 0 }: { name: string; seed?: number }) {
  const initials = name.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase()
  return <span aria-hidden className={cx('size-8 rounded-full flex items-center justify-center text-[12px] font-semibold shrink-0', AV[seed % AV.length])}>{initials}</span>
}

export function ErrorText({ error }: { error: unknown }) {
  if (!error) return null
  return <p role="alert" className="text-[13px] text-danger bg-danger-soft rounded-xl px-3 py-2">{error instanceof Error ? error.message : String(error)}</p>
}

export { cx }

/** Native modal <dialog>: focus trap, Esc to close and the backdrop come from the browser. */
export function Dialog({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const d = ref.current!
    if (open && !d.open) d.showModal()
    if (!open && d.open) d.close()
  }, [open])
  return (
    <dialog ref={ref} onClose={onClose} aria-labelledby={`${title}-h`}
      className="m-auto w-[min(92vw,400px)] rounded-3xl border border-line bg-surface text-text p-5 backdrop:bg-black/45">
      <h2 id={`${title}-h`} className="font-head font-medium text-[22px] mt-0 mb-2">{title}</h2>
      {open && children}
    </dialog>
  )
}
