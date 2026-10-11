// Team's one entry point: app.ts calls teamPlugin() and mounts its routes; nothing else in DevDash imports Team.
// DEVDASH_TEAM=0 switches it off on the whole server: no listeners, no tools, and the routes answer that it's off.
import type { Db } from '../../core/db.ts'
import type { Hub } from '../../core/hub.ts'
import type { ActivityService } from '../activity/service.ts'
import type { AgentsService } from '../agents/service.ts'
import type { authMiddleware } from '../auth/routes.ts'
import type { ClaudeService } from '../claude/service.ts'
import type { NotificationKind } from '../notifications/service.ts'
import type { ProjectsService } from '../projects/service.ts'
import type { TasksService } from '../tasks/service.ts'
import { registerTeamMcp } from './mcp.ts'
import { teamRoutes } from './routes.ts'
import { teamService } from './service.ts'

export function teamPlugin(deps: {
  db: Db; hub: Hub; agents: AgentsService; claude: ClaudeService; projects: ProjectsService; activity: ActivityService; tasks: TasksService
  notify: (userId: number, kind: NotificationKind, n: { title: string; body?: string; url?: string; tag?: string }) => Promise<void>
  masterKey: Buffer
  mw: ReturnType<typeof authMiddleware>
}) {
  const on = process.env.DEVDASH_TEAM !== '0'
  const service = on ? teamService(deps) : null
  if (service) registerTeamMcp(deps.agents, service)
  return { service, routes: teamRoutes(service, deps.mw) }
}
