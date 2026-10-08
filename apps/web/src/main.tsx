import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createRootRouteWithContext, createRoute, createRouter, lazyRouteComponent, Outlet, redirect, RouterProvider } from '@tanstack/react-router'
import { AppShell } from './components/app/shell'
import { InvitePage } from './features/auth/InvitePage'
import { LoginPage } from './features/auth/LoginPage'
import { HomePage } from './features/home/HomePage'
import { MembersPage } from './features/members/MembersPage'
import { MorePage } from './features/more/MorePage'
import { AccountPage } from './features/account/AccountPage'
import { SessionsPage } from './features/claude/SessionsPage'
import { SetupPage } from './features/claude/SetupPage'

import { ApiError, meQuery } from './lib/api'
import { getTheme, setTheme } from './lib/theme'
import './styles.css'

setTheme(getTheme())

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: (n, err) => !(err instanceof ApiError && err.status < 500) && n < 2 },
  },
})

const root = createRootRouteWithContext<{ queryClient: QueryClient }>()({ component: Outlet })

const login = createRoute({
  getParentRoute: () => root,
  path: '/login',
  component: LoginPage,
  beforeLoad: async ({ context }) => {
    if (await context.queryClient.ensureQueryData(meQuery)) throw redirect({ to: '/' })
  },
})

const invite = createRoute({ getParentRoute: () => root, path: '/invite/$token', component: InvitePage })

const app = createRoute({
  getParentRoute: () => root,
  id: 'app',
  component: AppShell,
  beforeLoad: async ({ context }) => {
    if (!(await context.queryClient.ensureQueryData(meQuery))) throw redirect({ to: '/login' })
  },
})

const home = createRoute({ getParentRoute: () => app, path: '/', component: HomePage })
const members = createRoute({ getParentRoute: () => app, path: '/members', component: MembersPage })
const terminal = createRoute({
  getParentRoute: () => app,
  path: '/terminal',
  component: lazyRouteComponent(() => import('./features/terminal/TerminalPage'), 'TerminalPage'), // xterm only loads here
  validateSearch: (s: Record<string, unknown>): { open?: string } => (typeof s.open === 'string' ? { open: s.open } : {}),
})
const account = createRoute({ getParentRoute: () => app, path: '/account', component: AccountPage })
const more = createRoute({ getParentRoute: () => app, path: '/more', component: MorePage })
const claudeList = createRoute({ getParentRoute: () => app, path: '/claude', component: SessionsPage })
const claudeSetup = createRoute({ getParentRoute: () => app, path: '/claude/setup', component: SetupPage })
const claudeSession = createRoute({
  getParentRoute: () => app,
  path: '/claude/$id',
  component: lazyRouteComponent(() => import('./features/claude/SessionPage'), 'SessionPage'), // markdown + xterm load here
})

const router = createRouter({
  routeTree: root.addChildren([login, invite, app.addChildren([home, claudeList, claudeSetup, claudeSession, terminal, members, account, more])]),
  context: { queryClient },
  defaultPreload: 'intent',
})

declare module '@tanstack/react-router' {
  interface Register { router: typeof router }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
)
