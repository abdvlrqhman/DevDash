import { AppError } from '../../core/http.ts'
import type { AgentsService } from '../agents/service.ts'
import type { TeamService } from './service.ts'

type Ctx = { sessionId?: string | null; args?: Record<string, unknown> }

/**
 * The team tools in the DevDash Claude plugin (packages/claude-plugin/mcp/team.mjs). They work only in a role's own
 * sessions (its chat and its shifts), run as the member the team runs as.
 */
export function registerTeamMcp(agents: AgentsService, team: TeamService) {
  const role = (username: string, params: unknown) => {
    const c = (params ?? {}) as Ctx
    const found = team.roleOf(username, c.sessionId ?? null)
    if (!found) throw new AppError(403, 'not_a_role', 'These tools work only in a team role\'s own sessions.')
    return { ...found, args: c.args ?? {} }
  }
  const text = (v: unknown, what: string) => {
    if (typeof v !== 'string' || !v.trim()) throw new AppError(400, 'bad_args', `Give the ${what}.`)
    return v
  }

  // Asked when the plugin's tool server starts: role sessions get the team tools, others don't see them.
  agents.onRpc('mcp.team_role', (username, params) => {
    const found = team.roleOf(username, ((params ?? {}) as Ctx).sessionId ?? null)
    return found ? { role: found.r.name, project: found.p.slug } : null
  })
  agents.onRpc('mcp.team_context', (username, params) => team.context(role(username, params).r.id))
  agents.onRpc('mcp.team_note', (username, params) => {
    const c = role(username, params)
    team.roleNote(c.r.id, text(c.args.body, 'note'))
    return 'Saved to your notebook.'
  })
  agents.onRpc('mcp.team_decision', (username, params) => {
    const c = role(username, params)
    team.roleDecision(c.r.id, text(c.args.body, 'decision'))
    return 'Decision recorded for the whole team.'
  })
  agents.onRpc('mcp.team_shift_report', (username, params) => {
    const c = role(username, params)
    const sessionId = ((params ?? {}) as Ctx).sessionId!
    return team.shiftReport(sessionId, text(c.args.report, 'report'))
      ? 'Report saved. Your shift ends when you stop.'
      : 'This is a chat, not a shift: nothing to report. Answer the person directly.'
  })
}
