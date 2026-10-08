import { Hono } from 'hono'
import { z } from 'zod'
import { json, query } from '../../core/http.ts'
import type { ActivityService } from '../activity/service.ts'
import type { AuthEnv, authMiddleware } from '../auth/routes.ts'
import type { ProjectsService } from './service.ts'

const Create = z.object({ name: z.string().max(80).default(''), slug: z.string().max(40).optional(), repoUrl: z.string().max(500).optional() })
const Patch = z.object({ name: z.string().min(1).max(80).optional(), archived: z.boolean().optional() })

export function projectsRoutes(projects: ProjectsService, activity: ActivityService, mw: ReturnType<typeof authMiddleware>) {
  return new Hono<AuthEnv>()
    .use(mw.requireUser)
    .get('/', query(z.object({ archived: z.enum(['0', '1']).default('0') })), (c) => c.json({ projects: projects.list(c.req.valid('query').archived === '1') }))
    .post('/', json(Create), async (c) => c.json({ project: await projects.create(c.get('user'), c.req.valid('json')) }))
    .get('/:slug', (c) => c.json({ project: projects.get(c.req.param('slug')) }))
    .patch('/:slug', json(Patch), (c) => c.json({ project: projects.update(c.get('user'), c.req.param('slug'), c.req.valid('json')) }))
    .post('/:slug/fetch', async (c) => c.json({ project: await projects.fetch(c.req.param('slug')) }))
    .get('/:slug/commits', async (c) => c.json({ commits: await projects.commits(c.req.param('slug')) }))
    .get('/:slug/activity', (c) => c.json({ activity: activity.list(projects.idOf(c.req.param('slug'))) }))
}
