import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, Outlet, useNavigate, useRouterState } from '@tanstack/react-router'
import {
  ArrowLeftRight, ChevronsUpDown, Download, Ellipsis, FolderGit2, House, ListTodo, LogOut, Monitor, Moon, Search, Server, Settings, Sparkles, SquareTerminal, StickyNote, Sun, Users,
} from 'lucide-react'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup,
  DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarHeader, SidebarInset, SidebarMenu, SidebarMenuBadge,
  SidebarMenuButton, SidebarMenuItem, SidebarProvider, SidebarRail, useSidebar,
} from '@/components/ui/sidebar'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { api, meQuery, spaceQuery } from '@/lib/api'
import { APP_DOWNLOADS, inShell, openExternal } from '@/lib/shell'
import { setTheme, useTheme, type ThemePref } from '@/lib/theme'
import { cn } from '@/lib/utils'
import { sessionsQuery, useLiveSessions } from '@/features/claude/data'
import { useNotificationEvents } from '@/features/notifications/Notifications'
import { initials, Logo } from './brand'
import { useDragWidth, useStoredWidth } from './resize-handle'
import { SearchDialog, showSearch } from './search'

const NAV = [
  { to: '/', label: 'Home', icon: House, exact: true },
  { to: '/projects', label: 'Projects', icon: FolderGit2 },
  { to: '/tasks', label: 'Tasks', icon: ListTodo },
  { to: '/claude', label: 'Claude', icon: Sparkles },
  { to: '/notes', label: 'Notes', icon: StickyNote },
  { to: '/terminal', label: 'Terminal', icon: SquareTerminal },
  { to: '/services', label: 'Services', icon: Server },
  { to: '/members', label: 'Members', icon: Users },
] as const

/**
 * Pins the app to the visible area. When the on-screen keyboard opens, iOS shrinks the visual viewport and scrolls the
 * page to keep the input in view, which slides everything off screen. Following the visual viewport (height and offset)
 * keeps the header, conversation and composer still, like a native chat. While typing, the tab bar steps aside.
 */
function usePinToVisualViewport() {
  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return
    const root = document.documentElement
    const set = () => {
      root.style.setProperty('--app-h', `${vv.height}px`)
      root.style.setProperty('--app-top', `${vv.offsetTop}px`)
      root.classList.toggle('keyboard-open', vv.height < window.innerHeight * 0.8)
    }
    set()
    vv.addEventListener('resize', set)
    vv.addEventListener('scroll', set)
    return () => {
      vv.removeEventListener('resize', set)
      vv.removeEventListener('scroll', set)
    }
  }, [])
}

function useActive() {
  const path = useRouterState({ select: (s) => s.location.pathname })
  return (to: string, exact?: boolean) => (exact ? path === to : path === to || path.startsWith(`${to}/`))
}

/** Sessions waiting on the member: the badge on Claude in both navigations. */
function useWaitingCount() {
  useLiveSessions()
  return useQuery(sessionsQuery(false)).data?.sessions.filter((s) => s.status === 'waiting').length ?? 0
}

const OPEN_KEY = 'devdash.sidebar-open'
const storedOpen = () => {
  try { return localStorage.getItem(OPEN_KEY) !== 'false' } catch { return true }
}

export function AppShell() {
  usePinToVisualViewport()
  useNotificationEvents()
  const waiting = useWaitingCount()
  const pane = useStoredWidth('sidebar', 256, 200, 400)
  const [open, setOpen] = useState(storedOpen)
  const onOpenChange = (v: boolean) => {
    setOpen(v)
    try { localStorage.setItem(OPEN_KEY, String(v)) } catch { /* not remembered */ }
  }
  return (
    <TooltipProvider>
      <SidebarProvider open={open} onOpenChange={onOpenChange} style={{ '--sidebar-width': `${pane.width}px` } as React.CSSProperties}
        className="fixed inset-x-0 top-0 h-[var(--app-h,100dvh)] min-h-0 translate-y-[var(--app-top,0px)] overflow-hidden">
        <AppSidebar waiting={waiting} pane={pane} />
        <SidebarInset className="min-h-0 min-w-0">
          <div className="min-h-0 flex-1 overflow-y-auto"><Outlet /></div>
          <MobileTabs waiting={waiting} />
        </SidebarInset>
      </SidebarProvider>
      <Toaster position="top-center" />
      <SearchDialog />
    </TooltipProvider>
  )
}

/** The sidebar's edge: drag to resize (remembered on this device), click to collapse to icons. */
function AppRail({ pane }: { pane: ReturnType<typeof useStoredWidth> }) {
  const { state, setOpen, toggleSidebar } = useSidebar()
  const drag = useDragWidth(pane.width, (w) => (state === 'collapsed' ? w - pane.width > 24 && setOpen(true) : pane.setWidth(w)))
  return (
    <SidebarRail {...drag.handlers} title="Drag to resize, click to collapse" aria-label="Resize or collapse the sidebar"
      className="group-data-[state=expanded]:cursor-col-resize! touch-none"
      onClick={() => !drag.moved() && toggleSidebar()} />
  )
}

function AppSidebar({ waiting, pane }: { waiting: number; pane: ReturnType<typeof useStoredWidth> }) {
  const space = useQuery(spaceQuery).data
  const active = useActive()
  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild>
              <Link to="/">
                <Logo size={32} className="size-8!" />
                <div className="grid flex-1 text-left leading-tight">
                  <span className="truncate text-sm font-semibold">{space?.name ?? 'DevDash'}</span>
                  <span className="truncate text-xs text-muted-foreground">{location.host}</span>
                </div>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton tooltip="Search" onClick={showSearch} className="text-muted-foreground">
                <Search /><span>Search</span><kbd className="ml-auto rounded border px-1 font-mono text-[10px]">⌘K</kbd>
              </SidebarMenuButton>
            </SidebarMenuItem>
            {NAV.map((n) => (
              <SidebarMenuItem key={n.to}>
                <SidebarMenuButton asChild isActive={active(n.to, 'exact' in n)} tooltip={n.label}>
                  <Link to={n.to}><n.icon /><span>{n.label}</span></Link>
                </SidebarMenuButton>
                {n.to === '/claude' && waiting > 0 && (
                  <SidebarMenuBadge className="bg-attention-soft text-attention-foreground">{waiting}</SidebarMenuBadge>
                )}
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <UserMenu />
      </SidebarFooter>
      <AppRail pane={pane} />
    </Sidebar>
  )
}

const THEMES: { value: ThemePref; label: string; icon: typeof Sun }[] = [
  { value: 'system', label: 'Match device', icon: Monitor },
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
]

export function useSignOut() {
  const qc = useQueryClient()
  const navigate = useNavigate()
  return async () => {
    await api.api.auth.logout.$post()
    qc.clear()
    navigate({ to: '/login' })
  }
}

function UserMenu() {
  const me = useQuery(meQuery).data
  const theme = useTheme()
  const signOut = useSignOut()
  if (!me) return null
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton size="lg" className="data-[state=open]:bg-sidebar-accent">
              <Avatar className="size-8 rounded-lg"><AvatarFallback className="rounded-lg">{initials(me.name)}</AvatarFallback></Avatar>
              <div className="grid flex-1 text-left leading-tight">
                <span className="truncate text-sm font-medium">{me.name}</span>
                <span className="truncate text-xs text-muted-foreground">{me.username}</span>
              </div>
              <ChevronsUpDown className="ml-auto size-4" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="right" align="end" className="min-w-56">
            <DropdownMenuLabel className="font-normal">
              <div className="text-sm font-medium">{me.name}</div>
              <div className="text-xs text-muted-foreground">{me.email}</div>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem asChild><Link to="/account"><Settings />Account</Link></DropdownMenuItem>
              <DropdownMenuItem asChild><Link to="/claude/setup"><Sparkles />Claude setup</Link></DropdownMenuItem>
              <DropdownMenuSub>
                <DropdownMenuSubTrigger><Monitor />Theme</DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  <DropdownMenuRadioGroup value={theme} onValueChange={(v) => setTheme(v as ThemePref)}>
                    {THEMES.map((t) => <DropdownMenuRadioItem key={t.value} value={t.value}>{t.label}</DropdownMenuRadioItem>)}
                  </DropdownMenuRadioGroup>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
              {inShell()
                ? <DropdownMenuItem onSelect={() => window.devdashShell!.switchSpace()}><ArrowLeftRight />Switch space</DropdownMenuItem>
                : <DropdownMenuItem onSelect={() => openExternal(APP_DOWNLOADS)}><Download />Get the app</DropdownMenuItem>}
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={() => void signOut()}><LogOut />Sign out</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}

const TABS = [
  { to: '/', label: 'Home', icon: House, exact: true },
  { to: '/projects', label: 'Projects', icon: FolderGit2 },
  { to: '/claude', label: 'Claude', icon: Sparkles },
  { to: '/tasks', label: 'Tasks', icon: ListTodo },
  { to: '/more', label: 'More', icon: Ellipsis },
] as const

function MobileTabs({ waiting }: { waiting: number }) {
  const active = useActive()
  const moreActive = ['/more', '/members', '/account', '/notes', '/terminal', '/services'].some((p) => active(p)) || active('/claude/setup')
  return (
    <nav aria-label="Sections" className="grid shrink-0 grid-cols-5 border-t bg-background pb-[env(safe-area-inset-bottom)] md:hidden [.keyboard-open_&]:hidden">
      {TABS.map((t) => {
        const on = t.to === '/more' ? moreActive : t.to === '/claude' ? active(t.to) && !active('/claude/setup') : active(t.to, 'exact' in t)
        return (
          <Link key={t.to} to={t.to} aria-current={on ? 'page' : undefined}
            className={cn('relative flex h-14 flex-col items-center justify-center gap-0.5 text-[11px] font-medium', on ? 'text-foreground' : 'text-muted-foreground')}>
            <t.icon className="size-5" strokeWidth={on ? 2.25 : 1.75} />
            {t.label}
            {t.to === '/claude' && waiting > 0 && (
              <span className="absolute top-1.5 left-1/2 ml-2 min-w-4 rounded-full bg-attention px-1 text-center text-[10px] leading-4 text-black">{waiting}</span>
            )}
          </Link>
        )
      })}
    </nav>
  )
}
