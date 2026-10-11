// Team tools (optional feature: docs/REMOVING-TEAM.md). Listed only in a team role's own sessions: devdash.mjs asks
// DevDash once, when the tool server starts, whether this session is a role.
const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false })

export const TEAM_TOOLS = [
  {
    name: 'team_context',
    description: 'Everything you need at the start of a chat or shift: the project brief, decisions, the team, your notebook, and what happened since your last shift. Call it first.',
    inputSchema: obj({}),
  },
  {
    name: 'team_note',
    description: 'Save something to your notebook, your memory between shifts and chats: a fact you established, a lesson, what a person told you (say who), or something people rejected and why.',
    inputSchema: obj({ body: { type: 'string', description: 'One short, specific note.' } }, ['body']),
  },
  {
    name: 'team_decision',
    description: 'Record a decision for the whole team. Only when a person decided it or clearly agreed.',
    inputSchema: obj({ body: { type: 'string', description: 'The decision and, briefly, why.' } }, ['body']),
  },
  {
    name: 'team_propose',
    description: 'Ask the team to approve something you can\'t do yourself. kind "code": a coding job a Claude session does on its own branch (give a complete prompt). "goal": a new goal (goal.title, goal.measure, goal.due YYYY-MM-DD). "task": tasks to add (tasks[]). "other": anything people must do themselves (publishing, posting, spending, contacting someone). Put your evidence in "why".',
    inputSchema: obj({
      kind: { type: 'string', enum: ['code', 'goal', 'task', 'other'] },
      title: { type: 'string', description: 'What, in a few words.' },
      why: { type: 'string', description: 'The evidence and reasoning (numbers, links, files). Markdown.' },
      prompt: { type: 'string', description: 'For kind "code": the full instructions for the Claude session.' },
      goal: obj({ title: { type: 'string' }, measure: { type: 'string' }, due: { type: 'string', description: 'YYYY-MM-DD' } }, ['title']),
      tasks: { type: 'array', items: obj({ title: { type: 'string' }, body: { type: 'string' }, priority: { type: 'string', enum: ['none', 'low', 'medium', 'high', 'urgent'] } }, ['title']) },
      details: { type: 'string', description: 'For kind "other": what exactly people should do.' },
    }, ['kind', 'title', 'why']),
  },
  {
    name: 'team_goal_update',
    description: 'Record progress you measured on a goal (its id is the number after # in team_context), or mark it done.',
    inputSchema: obj({ id: { type: 'integer' }, progress: { type: 'integer', description: '0 to 100' }, note: { type: 'string', description: 'What the progress is based on.' }, done: { type: 'boolean' } }, ['id']),
  },
  {
    name: 'team_shift_report',
    description: 'At the end of a shift: your report for the team (what you looked at, found and did, and what you recommend). Short; people read it on their phones.',
    inputSchema: obj({ report: { type: 'string', description: 'Markdown.' } }, ['report']),
  },
]

/** True when DevDash says this session belongs to a team role. Any failure (Team off, older server) means no. */
export async function isRole(call, context) {
  try {
    return !!(await call('mcp.team_role', { ...context, args: {} }))
  } catch {
    return false
  }
}
