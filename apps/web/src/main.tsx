import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createRootRouteWithContext, createRoute, createRouter, lazyRouteComponent, Outlet, redirect, RouterProvider } from '@tanstack/react-router'
import { AppShell } from './app/AppShell'
import { InvitePage } from './features/auth/InvitePage'
import { LoginPage } from './features/auth/LoginPage'
import { HomePage } from './features/home/HomePage'
import { MembersPage } from './features/members/MembersPage'
import { AccountPage } from './features/account/AccountPage'

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
})
const account = createRoute({ getParentRoute: () => app, path: '/account', component: AccountPage })

const router = createRouter({
  routeTree: root.addChildren([login, invite, app.addChildren([home, terminal, members, account])]),
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
