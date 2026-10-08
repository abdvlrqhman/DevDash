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
import { ClaudeIndex, ClaudeLayout } from './features/claude/ClaudeLayout'
import { SetupPage } from './features/claude/SetupPage'

import { ApiError, meQuery } from './lib/api'
import { inShell } from './lib/shell'
import { getTheme, setTheme } from './lib/theme'
import './styles.css'

setTheme(getTheme())

// Inside the native app: behave like an app, not a web page (no zoom, no selecting UI text; see styles.css).
if (inShell()) {
  document.documentElement.classList.add('shell')
  document.querySelector('meta[name=viewport]')?.setAttribute('content',
    'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover, interactive-widget=resizes-content')
}

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
const lazy = (load: () => Promise<Record<string, unknown>>, name: string) => lazyRouteComponent(load as never, name as never)
const projects = createRoute({ getParentRoute: () => app, path: '/projects', component: lazy(() => import('./features/projects/ProjectsPage'), 'ProjectsPage') })
const project = createRoute({ getParentRoute: () => app, path: '/projects/$slug', component: lazy(() => import('./features/projects/ProjectPage'), 'ProjectPage') })
const tasks = createRoute({ getParentRoute: () => app, path: '/tasks', component: lazy(() => import('./features/tasks/TasksPage'), 'TasksPage') })
const task = createRoute({ getParentRoute: () => app, path: '/tasks/$slug/$number', component: lazy(() => import('./features/tasks/TaskPage'), 'TaskPage') })
const notes = createRoute({ getParentRoute: () => app, path: '/notes', component: lazy(() => import('./features/notes/NotesPage'), 'NotesPage') })
const note = createRoute({
  getParentRoute: () => app,
  path: '/notes/$id',
  component: lazy(() => import('./features/notes/NotePage'), 'NotePage'),
  validateSearch: (s: Record<string, unknown>): { project?: string } => (typeof s.project === 'string' ? { project: s.project } : {}),
})
const files = createRoute({
  getParentRoute: () => app,
  path: '/files',
  component: lazy(() => import('./features/files/FilesPage'), 'FilesPage'),
  validateSearch: (s: Record<string, unknown>): { path?: string; tab?: 'links' } => ({
    ...(typeof s.path === 'string' ? { path: s.path } : {}), ...(s.tab === 'links' ? { tab: 'links' as const } : {}),
  }),
})
const services = createRoute({ getParentRoute: () => app, path: '/services', component: lazyRouteComponent(() => import('./features/services/ServicesPage'), 'ServicesPage') })
const service = createRoute({ getParentRoute: () => app, path: '/services/$name', component: lazyRouteComponent(() => import('./features/services/ServicePage'), 'ServicePage') })
// Claude is master-detail on wide screens: ClaudeLayout keeps the session list beside whatever is open.
const claude = createRoute({ getParentRoute: () => app, path: '/claude', component: ClaudeLayout })
const claudeIndex = createRoute({ getParentRoute: () => claude, path: '/', component: ClaudeIndex })
const claudeSetup = createRoute({ getParentRoute: () => claude, path: '/setup', component: SetupPage })
const claudeSession = createRoute({
  getParentRoute: () => claude,
  path: '/$id',
  component: lazyRouteComponent(() => import('./features/claude/SessionPage'), 'SessionPage'), // markdown + xterm load here
})

const router = createRouter({
  routeTree: root.addChildren([login, invite, app.addChildren([home, claude.addChildren([claudeIndex, claudeSetup, claudeSession]), terminal, files, services, service, projects, project, tasks, task, notes, note, members, account, more])]),
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
