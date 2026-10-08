import { useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, Outlet, useNavigate, useRouterState } from '@tanstack/react-router'
import {
  ArrowLeftRight, ChevronsUpDown, Download, Ellipsis, House, LogOut, Monitor, Moon, Settings, Sparkles, SquareTerminal, Sun, Users,
} from 'lucide-react'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup,
  DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarHeader, SidebarInset, SidebarMenu, SidebarMenuBadge,
  SidebarMenuButton, SidebarMenuItem, SidebarProvider, SidebarRail,
} from '@/components/ui/sidebar'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { api, meQuery, spaceQuery } from '@/lib/api'
import { APP_DOWNLOADS, inShell, openExternal } from '@/lib/shell'
import { setTheme, useTheme, type ThemePref } from '@/lib/theme'
import { cn } from '@/lib/utils'
import { sessionsQuery, useLiveSessions } from '@/features/claude/data'
import { initials, Logo } from './brand'

const NAV = [
  { to: '/', label: 'Home', icon: House, exact: true },
  { to: '/claude', label: 'Claude', icon: Sparkles },
  { to: '/terminal', label: 'Terminal', icon: SquareTerminal },
  { to: '/members', label: 'Members', icon: Users },
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

function useActive() {
  const path = useRouterState({ select: (s) => s.location.pathname })
  return (to: string, exact?: boolean) => (exact ? path === to : path === to || path.startsWith(`${to}/`))
}

/** Sessions waiting on the member: the badge on Claude in both navigations. */
function useWaitingCount() {
  useLiveSessions()
  return useQuery(sessionsQuery(false)).data?.sessions.filter((s) => s.status === 'waiting').length ?? 0
}

export function AppShell() {
  useVisualViewportHeight()
  const waiting = useWaitingCount()
  return (
    <TooltipProvider>
      <SidebarProvider className="h-[var(--app-h,100dvh)] min-h-0 overflow-hidden">
        <AppSidebar waiting={waiting} />
        <SidebarInset className="min-h-0 min-w-0">
          <div className="min-h-0 flex-1 overflow-y-auto"><Outlet /></div>
          <MobileTabs waiting={waiting} />
        </SidebarInset>
      </SidebarProvider>
      <Toaster position="top-center" />
    </TooltipProvider>
  )
}

function AppSidebar({ waiting }: { waiting: number }) {
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
      <SidebarRail />
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
  { to: '/claude', label: 'Claude', icon: Sparkles },
  { to: '/terminal', label: 'Terminal', icon: SquareTerminal },
  { to: '/more', label: 'More', icon: Ellipsis },
] as const

function MobileTabs({ waiting }: { waiting: number }) {
  const active = useActive()
  const moreActive = ['/more', '/members', '/account'].some((p) => active(p)) || active('/claude/setup')
  return (
    <nav aria-label="Sections" className="grid shrink-0 grid-cols-4 border-t bg-background pb-[env(safe-area-inset-bottom)] md:hidden">
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
