import { useEffect, useState, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, Outlet, useNavigate } from '@tanstack/react-router'
import { IconArrowsExchange, IconDeviceDesktop, IconHome, IconLogout, IconMoon, IconSettings, IconSparkles, IconSun, IconTerminal2, IconUsers } from '@tabler/icons-react'
import { api, meQuery, spaceQuery } from '../lib/api'
import { inShell } from '../lib/shell'
import { getTheme, setTheme, type ThemePref } from '../lib/theme'
import { Avatar, Logo, cx } from '../ui'

const NAV = [
  { to: '/', label: 'Home', icon: IconHome },
  { to: '/claude', label: 'Claude', icon: IconSparkles },
  { to: '/terminal', label: 'Terminal', icon: IconTerminal2 },
  { to: '/members', label: 'Members', icon: IconUsers },
] as const

/** Tracks the visible height, so the on-screen keyboard (iOS especially) never covers the terminal or composer. */
function useVisualViewportHeight() {
  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return
    const set = () => document.documentElement.style.setProperty('--app-h', `${vv.height}px`)
    set()
    vv.addEventListener('resize', set)
    return () => vv.removeEventListener('resize', set)
  }, [])
}

export function AppShell() {
  const space = useQuery(spaceQuery)
  useVisualViewportHeight()
  return (
    <div className="flex bg-bg h-[var(--app-h,100dvh)]">
      <aside className="hidden lg:flex w-[230px] shrink-0 flex-col gap-0.5 bg-surface border-r border-line px-3 py-4">
        <div className="flex items-center gap-2.5 px-2 pb-4">
          <Logo size={34} />
          <div className="min-w-0">
            <div className="font-head text-[18px] leading-tight truncate">{space.data?.name ?? 'DevDash'}</div>
            <div className="text-[12px] text-muted truncate">{location.host}</div>
          </div>
        </div>
        {NAV.map((n) => (
          <Link key={n.to} to={n.to} activeOptions={{ exact: n.to === '/' }}
            className="flex items-center gap-2.5 px-2.5 py-2 rounded-[10px] text-[14px] text-text [&.active]:bg-accent-soft [&.active]:text-accent">
            <n.icon size={18} />{n.label}
          </Link>
        ))}
        <div className="flex-1" />
        <AccountMenu up />
      </aside>
      <div className="flex-1 min-w-0 flex flex-col">
        <div className="flex-1 min-h-0 overflow-y-auto"><Outlet /></div>
        <nav className="lg:hidden flex justify-around items-center bg-surface border-t border-line pt-2 pb-[max(14px,env(safe-area-inset-bottom))]">
          {NAV.map((n) => (
            <Link key={n.to} to={n.to} activeOptions={{ exact: n.to === '/' }}
              className="flex flex-col items-center gap-0.5 w-16 text-[11px] text-muted [&.active]:text-accent">
              <n.icon size={22} />{n.label}
            </Link>
          ))}
        </nav>
      </div>
    </div>
  )
}

/** Page header shared by app pages: title, optional subtitle, account menu on phones. */
export function PageHeader({ title, sub, children }: { title: string; sub?: ReactNode; children?: ReactNode }) {
  return (
    <header className="flex items-center gap-2.5 px-4 lg:px-8 pt-[max(12px,env(safe-area-inset-top))] pb-2.5">
      <div className="flex-1 min-w-0">
        {sub && <div className="text-[13px] text-muted truncate">{sub}</div>}
        <h1 className="font-head text-[26px] lg:text-[30px] leading-tight m-0 truncate">{title}</h1>
      </div>
      {children}
      <div className="lg:hidden"><AccountMenu /></div>
    </header>
  )
}

const THEMES: { v: ThemePref; label: string; icon: typeof IconSun }[] = [
  { v: 'light', label: 'Light', icon: IconSun },
  { v: 'dark', label: 'Dark', icon: IconMoon },
  { v: 'system', label: 'System', icon: IconDeviceDesktop },
]

function AccountMenu({ up }: { up?: boolean }) {
  const me = useQuery(meQuery).data
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [theme, setThemeState] = useState(getTheme)
  if (!me) return null
  const signOut = async () => {
    await api.api.auth.logout.$post()
    qc.clear()
    navigate({ to: '/login' })
  }
  return (
    <details className="relative group">
      <summary className="list-none flex items-center gap-2.5 cursor-pointer rounded-[10px] p-1.5 [&::-webkit-details-marker]:hidden" aria-label="Account menu">
        <Avatar name={me.name} seed={me.id} />
        {up && <span className="text-[14px] truncate">{me.name}</span>}
      </summary>
      <div className={cx('absolute z-20 w-56 bg-surface border border-line rounded-2xl p-2 shadow-lg flex flex-col gap-1', up ? 'bottom-full mb-2 left-0' : 'top-full mt-2 right-0')}>
        <div className="px-2 py-1.5">
          <div className="font-semibold text-[14px] truncate">{me.name}</div>
          <div className="text-muted text-[12px] truncate font-mono">@{me.username}</div>
        </div>
        <div role="radiogroup" aria-label="Theme" className="flex bg-surface-2 rounded-[10px] p-0.5">
          {THEMES.map((t) => (
            <button key={t.v} role="radio" aria-checked={theme === t.v} title={t.label}
              onClick={() => { setTheme(t.v); setThemeState(t.v) }}
              className={cx('flex-1 h-8 rounded-lg flex items-center justify-center', theme === t.v ? 'bg-surface text-text shadow-sm' : 'text-muted')}>
              <t.icon size={16} /><span className="sr-only">{t.label}</span>
            </button>
          ))}
        </div>
        <Link to="/account" className="flex items-center gap-2 px-2 h-10 rounded-[10px] text-[14px] hover:bg-surface-2">
          <IconSettings size={18} />Account settings
        </Link>
        {inShell() && (
          <button onClick={() => window.devdashShell!.switchSpace()} className="flex items-center gap-2 px-2 h-10 rounded-[10px] text-[14px] hover:bg-surface-2">
            <IconArrowsExchange size={18} />Switch space
          </button>
        )}
        <button onClick={signOut} className="flex items-center gap-2 px-2 h-10 rounded-[10px] text-[14px] text-danger hover:bg-danger-soft">
          <IconLogout size={18} />Sign out
        </button>
      </div>
    </details>
  )
}
