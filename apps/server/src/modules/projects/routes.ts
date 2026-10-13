import { Hono } from 'hono'
import { z } from 'zod'
import { AppError, json, query } from '../../core/http.ts'
import type { ActivityService } from '../activity/service.ts'
import type { AuthEnv, authMiddleware } from '../auth/routes.ts'
import { SESSION_SHARING, type ProjectsService } from './service.ts'

const CHUNK = 8 * 1024 * 1024 // Cloudflare caps a request at 100 MB, so a big zip arrives in pieces.
const UploadId = z.string().regex(/^[a-f0-9]{8,64}$/)
const Create = z.object({ name: z.string().max(80).default(''), slug: z.string().max(40).optional(), repoUrl: z.string().max(500).optional() })
const FromZip = z.object({ name: z.string().max(80).default(''), slug: z.string().max(40).optional(), uploadId: UploadId })
const Patch = z.object({ name: z.string().min(1).max(80).optional(), archived: z.boolean().optional(), sessionSharing: z.enum(SESSION_SHARING).optional() })

export function projectsRoutes(projects: ProjectsService, activity: ActivityService, mw: ReturnType<typeof authMiddleware>) {
  return new Hono<AuthEnv>()
    .use(mw.requireUser)
    .get('/', query(z.object({ archived: z.enum(['0', '1']).default('0') })), (c) => c.json({ projects: projects.list(c.req.valid('query').archived === '1', c.get('user').id) }))
    .post('/', json(Create), async (c) => c.json({ project: await projects.create(c.get('user'), c.req.valid('json')) }))
    // Create from an uploaded .zip: stream the zip here in ≤8 MB pieces, then finalize (unzip + git init + insert).
    .post('/zip', query(z.object({ uploadId: UploadId, offset: z.coerce.number().int().min(0) })), async (c) => {
      const data = Buffer.from(await c.req.arrayBuffer())
      if (data.length > CHUNK) throw new AppError(400, 'too_big', 'Upload pieces must be 8 MB or smaller.')
      const { uploadId, offset } = c.req.valid('query')
      return c.json(await projects.uploadZip(c.get('user'), uploadId, offset, data))
    })
    .post('/zip/abort', json(z.object({ uploadId: UploadId })), async (c) => c.json(await projects.abortZip(c.get('user'), c.req.valid('json').uploadId)))
    .post('/from-zip', json(FromZip), async (c) => c.json({ project: await projects.createFromZip(c.get('user'), c.req.valid('json')) }))
    .get('/:slug', (c) => c.json({ project: projects.get(c.req.param('slug'), c.get('user').id) }))
    .patch('/:slug', json(Patch), (c) => c.json({ project: projects.update(c.get('user'), c.req.param('slug'), c.req.valid('json')) }))
    .post('/:slug/fetch', async (c) => c.json({ project: await projects.fetch(c.req.param('slug'), c.get('user').id) }))
    .get('/:slug/commits', async (c) => c.json({ commits: await projects.commits(c.req.param('slug')) }))
    .get('/:slug/activity', (c) => c.json({ activity: activity.list(projects.idOf(c.req.param('slug'))) }))
}
