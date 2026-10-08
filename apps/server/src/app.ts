import { Hono, type Context } from 'hono'
import type { Config } from './core/config.ts'
import type { Db } from './core/db.ts'
import { createHub } from './core/hub.ts'
import { AppError, clientIp, sameOrigin } from './core/http.ts'
import { agentsService } from './modules/agents/service.ts'
import { authMiddleware, authRoutes } from './modules/auth/routes.ts'
import { authService } from './modules/auth/service.ts'
import { claudeRoutes } from './modules/claude/routes.ts'
import { claudeService } from './modules/claude/service.ts'
import { activityService } from './modules/activity/service.ts'
import { registerMcp } from './modules/mcp/rpc.ts'
import { filesRoutes, publicShareRoutes } from './modules/files/routes.ts'
import { sharesService } from './modules/files/shares.ts'
import { buildsRoutes } from './modules/builds/routes.ts'
import { vaultRoutes } from './modules/vault/routes.ts'
import { browserRoutes, watchRoutes } from './modules/browser/routes.ts'
import { browserService } from './modules/browser/service.ts'
import { statusRoutes } from './modules/status/routes.ts'
import { previewsService } from './modules/previews/service.ts'
import { statusService } from './modules/status/service.ts'
import { vaultService } from './modules/vault/service.ts'
import { buildsService } from './modules/builds/service.ts'
import { notesRoutes } from './modules/notes/routes.ts'
import { notesService } from './modules/notes/service.ts'
import { projectsRoutes } from './modules/projects/routes.ts'
import { projectsService } from './modules/projects/service.ts'
import { searchRoutes } from './modules/search/routes.ts'
import { searchService } from './modules/search/service.ts'
import { tasksRoutes, type GiveToClaude } from './modules/tasks/routes.ts'
import { tasksService } from './modules/tasks/service.ts'
import { servicesRoutes } from './modules/services/routes.ts'
import { servicesService } from './modules/services/service.ts'
import { membersRoutes } from './modules/members/routes.ts'
import { notificationsRoutes } from './modules/notifications/routes.ts'
import { notificationsService } from './modules/notifications/service.ts'
import { provisioningService } from './modules/provisioning/service.ts'
import { terminalsRoutes } from './modules/terminals/routes.ts'
import { terminalsService } from './modules/terminals/service.ts'

export function createApp({ db, config }: { db: Db; config: Config }) {
  const auth = authService({ db, masterKey: config.masterKey, spaceName: config.spaceName })
  const hub = createHub()
  const agents = agentsService({ runDir: config.runDir })
  const provisioning = provisioningService({ db, runDir: config.runDir, onReady: (username) => agents.watch(username) })
  const terms = terminalsService({ agents })
  const notifications = notificationsService({ db, hub, dataDir: config.dataDir, origin: config.origin })
  hub.authorize('notifications', () => true)
  const shares = sharesService({ db, dataDir: config.dataDir, masterKey: config.masterKey, origin: config.origin })
  const activity = activityService({ db, hub })
  const search = searchService({ db })
  const tasks = tasksService({ db, hub, activity, search })
  const notes = notesService({ db, hub, activity, search })
  const projects = projectsService({ db, hub, agents, activity, tasks, root: config.projectsRoot, gitSafeDir: (p) => provisioning.gitSafeDir(p) })
  for (const topic of ['projects', 'tasks', 'notes', 'activity']) hub.authorize(topic, () => true)
  const claude = claudeService({ db, agents, hub, notify: notifications.notify, projects })

  // "Give to Claude": a Chat session in the task's project (its own worktree by default), linked to the task.
  const giveToClaude: GiveToClaude = async (user, slug, number, o) => {
    const t = tasks.get(slug, number)
    const d = claude.defaults(user) as { profile: string; model: string | null; effort: string | null; permission_mode: string } | undefined
    const prompt = [
      `Work on task ${t.key}: ${t.title}`,
      t.body.trim(),
      o.note.trim(),
      `When it's done, commit with "fixes #${t.number}" in the message: DevDash moves the task to Review on a branch and to Done on the default branch. Comment a short summary on the task with the DevDash tools.`,
    ].filter(Boolean).join('\n\n')
    const s = await claude.create(user, {
      prompt, images: [], cwd: '', profile: o.profile ?? d?.profile ?? 'default', model: d?.model ?? null, effort: d?.effort ?? null,
      permissionMode: d?.permission_mode ?? 'bypassPermissions', mode: 'chat', project: slug, worktree: o.worktree,
    })
    tasks.linkSession(slug, number, s.id, s.title)
    if (t.status !== 'in_progress') tasks.update({ user }, slug, number, { status: 'in_progress', assignee: t.assignee?.id ?? user.id })
    return { sessionId: s.id }
  }
  const previews = previewsService({ db, masterKey: config.masterKey, origin: config.origin, template: config.previewHost })
  const services = servicesService({ db, agents, hub, notify: notifications.notify, previewUrl: previews.urlOf })
  hub.authorize('services', () => true)
  const mw = authMiddleware(auth)
  const ip = (c: Context) => clientIp(c, config.trustCfIp)

  const builds = buildsService({ db, agents, projects, shares })
  const vault = vaultService({ db })
  const browser = browserService({ db, runDir: config.runDir, dataDir: config.dataDir, masterKey: config.masterKey, origin: config.origin })
  const status = statusService({ db, agents, services, browser, runDir: config.runDir, dataDir: config.dataDir, version: config.version })
  const app = new Hono()
    // Service previews live on their own hosts: answered before anything else, never mixed with DevDash's routes.
    .use('*', previews.middleware)
    // A member opening a preview: a one-minute ticket that the preview host turns into its own cookie.
    .get('/api/previews/auth', (c) => {
      const user = mw.signedIn(c)
      if (!user) return c.redirect('/')
      const to = previews.ticket(user.id, c.req.query('host') ?? '', c.req.query('next') ?? '/')
      return to ? c.redirect(to) : c.text('No such preview.', 404)
    })
    // Public: lets the native shell check that a domain is a DevDash space before loading it.
    .get('/.well-known/devdash.json', (c) => {
      c.header('access-control-allow-origin', '*')
      c.header('cache-control', 'no-store')
      return c.json({ app: 'devdash', name: config.spaceName, version: config.version, api: 1 })
    })
    // Public share links (the only public pages): a small download page, no app, no listing.
    .route('/s', publicShareRoutes(shares, ip))
    .route('/watch', watchRoutes(browser, ip))
    .use('/api/*', sameOrigin(config.origin))
    .route('/api/auth', authRoutes(auth, mw, ip, (u) => void provisioning.ensure(u)))
    .route('/api/members', membersRoutes(auth, mw, ip, config.origin, (id) => vault.memberRemoved(id)))
    .route('/api/terminals', terminalsRoutes(terms, auth, mw, provisioning, ip))
    .route('/api/claude', claudeRoutes(claude, mw))
    .route('/api/notifications', notificationsRoutes(notifications, mw))
    .route('/api/services', servicesRoutes(services, mw))
    .route('/api/projects', projectsRoutes(projects, activity, mw))
    .route('/api/tasks', tasksRoutes(tasks, giveToClaude, mw))
    .route('/api/notes', notesRoutes(notes, mw))
    .route('/api/files', filesRoutes(agents, shares, mw))
    .route('/api/builds', buildsRoutes(builds, mw))
    .route('/api/vault', vaultRoutes(vault, mw))
    .route('/api/browser', browserRoutes(browser, mw))
    .route('/api/status', statusRoutes(status, mw))
    .route('/api', searchRoutes({ db, search, notes, projects, claude, services, activity }, mw))

  app.notFound((c) => c.json({ error: { code: 'not_found', message: 'Not found' } }, 404))
  app.onError((err, c) => {
    if (err instanceof AppError) return c.json({ error: { code: err.code, message: err.message } }, err.status)
    console.error(err)
    return c.json({ error: { code: 'internal', message: 'Something went wrong.' } }, 500)
  })

  registerMcp({ db, agents, projects, tasks, notes, services })
  projects.start()
  return { app, auth, provisioning, terms, agents, claude, services, projects, tasks, notes, hub, previews }
}

export type AppType = ReturnType<typeof createApp>['app']
