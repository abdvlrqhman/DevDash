import { Hono } from 'hono'
import { z } from 'zod'
import { AppError, json } from '../../core/http.ts'
import type { AuthEnv, authMiddleware } from '../auth/routes.ts'
import { MODELS, type TeamService } from './service.ts'

const RoleInput = z.object({
  name: z.string().trim().min(1).max(60),
  summary: z.string().trim().max(300).default(''),
  instructions: z.string().max(20_000).default(''),
  model: z.enum(MODELS).nullable().default(null),
})
const Body = (max: number) => z.object({ body: z.string().trim().min(1).max(max) })
const id = (v: string) => {
  const n = Number(v)
  if (!Number.isInteger(n) || n < 1) throw new AppError(404, 'not_found', 'Not found.')
  return n
}

/** `team` is null when Team is switched off on this server (DEVDASH_TEAM=0): every route answers that it's off. */
export function teamRoutes(team: TeamService | null, mw: ReturnType<typeof authMiddleware>) {
  const t = () => {
    if (!team) throw new AppError(404, 'team_off', 'Team is switched off on this server.')
    return team
  }
  return new Hono<AuthEnv>()
    .use(mw.requireUser)
    .get('/projects/:slug', (c) => c.json(t().overview(c.req.param('slug'))))
    .put('/projects/:slug', json(z.object({ enabled: z.boolean() })), (c) => {
      if (c.req.valid('json').enabled) t().enable(c.get('user'), c.req.param('slug'))
      else t().disable(c.req.param('slug'))
      return c.json({ ok: true })
    })
    .put('/projects/:slug/brief', json(z.object({ body: z.string().max(20_000) })), (c) => {
      t().saveBrief(c.get('user'), c.req.param('slug'), c.req.valid('json').body)
      return c.json({ ok: true })
    })
    .post('/projects/:slug/decisions', json(Body(2000)), (c) => {
      t().addDecision(c.get('user'), c.req.param('slug'), c.req.valid('json').body)
      return c.json({ ok: true })
    })
    .delete('/projects/:slug/decisions/:id', (c) => {
      t().removeDecision(c.req.param('slug'), id(c.req.param('id')))
      return c.json({ ok: true })
    })
    .post('/projects/:slug/generate', json(z.object({ name: z.string().trim().min(1).max(60), summary: z.string().max(300).default('') })), async (c) => {
      const { name, summary } = c.req.valid('json')
      return c.json(await t().generate(c.get('user'), c.req.param('slug'), name, summary))
    })
    .post('/projects/:slug/roles', json(RoleInput), (c) => c.json({ role: t().createRole(c.get('user'), c.req.param('slug'), c.req.valid('json')) }))
    .get('/roles/:id', (c) => c.json(t().role(id(c.req.param('id')))))
    .put('/roles/:id', json(RoleInput), (c) => c.json({ role: t().updateRole(id(c.req.param('id')), c.req.valid('json')) }))
    .delete('/roles/:id', (c) => {
      t().archiveRole(id(c.req.param('id')))
      return c.json({ ok: true })
    })
    .post('/roles/:id/shift', async (c) => c.json({ role: await t().runShift(id(c.req.param('id'))) }))
    .post('/roles/:id/chat', async (c) => c.json(await t().chat(id(c.req.param('id')))))
    .post('/roles/:id/notebook', json(Body(2000)), (c) => {
      t().addNote(c.get('user'), id(c.req.param('id')), c.req.valid('json').body)
      return c.json({ ok: true })
    })
    .delete('/roles/:id/notebook/:note', (c) => {
      t().removeNote(id(c.req.param('id')), id(c.req.param('note')))
      return c.json({ ok: true })
    })
}
