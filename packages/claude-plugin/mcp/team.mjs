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

// Any Claude session in a project with Team on can raise something with a role; roles also use it to talk to each other.
const MESSAGE_TOOL = {
  name: 'team_message',
  description: 'Tell a team role (an AI team member of this project, e.g. "Marketing", "CTO") about something it should know or act on: money, users, metrics, a broken release. Opens a thread (to + title) or adds to one (thread). Give the numbers and links as evidence. kind: "fyi", "question", "request", or "alert" (only when something is wrong and can\'t wait: it wakes the role and people\'s phones). Not for code details.',
  inputSchema: obj({
    to: { type: 'string', description: 'The role that should own it, by name. Omit to give it to the team lead.' },
    title: { type: 'string', description: 'For a new thread: the issue in a few words.' },
    thread: { type: 'integer', description: 'To add to an existing thread instead.' },
    kind: { type: 'string', enum: ['fyi', 'question', 'request', 'alert', 'reply'] },
    body: { type: 'string', description: 'The message. Markdown.' },
    evidence: { type: 'string', description: 'Numbers, files, links that show it. Required for a new thread.' },
    cc: { type: 'array', items: { type: 'string' }, description: 'Other roles to include, by name.' },
  }, ['body']),
}

const ROLE_ONLY = [
  {
    name: 'team_thread',
    description: 'Read a thread (all messages, evidence and proposals in it) before answering.',
    inputSchema: obj({ id: { type: 'integer' } }, ['id']),
  },
  {
    name: 'team_resolve',
    description: 'Close a thread. The owner closes it as "done" once it is settled, with one line on the outcome. Any role in the thread may decline it instead of arguing there: "declined" (not ours to do, or another role already has it), "duplicate" (give duplicate_of), "not_needed" (it doesn\'t fit this project) or "elsewhere" (already handled somewhere else), always with one line of why. People see it and can reopen it.',
    inputSchema: obj({
      id: { type: 'integer' },
      as: { type: 'string', enum: ['done', 'declined', 'duplicate', 'not_needed', 'elsewhere'], description: 'How it ends. Default "done" (owner only).' },
      resolution: { type: 'string', description: 'One line: the outcome, or why you decline it (required to decline).' },
      duplicate_of: { type: 'integer', description: 'For "duplicate": the thread id it duplicates.' },
    }, ['id']),
  },
  {
    name: 'team_sources',
    description: 'The project\'s data sources you can read: databases, APIs and pages people connected for the team.',
    inputSchema: obj({}),
  },
  {
    name: 'team_query',
    description: 'Run one read-only SQL query (SELECT/WITH) on a database source. Aggregate and LIMIT: results are cut at 200 rows.',
    inputSchema: obj({ source: { type: 'string' }, sql: { type: 'string' } }, ['source', 'sql']),
  },
  {
    name: 'team_fetch',
    description: 'Read an API source (path under its base URL, e.g. "channels?part=statistics&id=…") or a page source (no path). The key is added for you.',
    inputSchema: obj({ source: { type: 'string' }, path: { type: 'string' } }, ['source']),
  },
]

// A person's own sessions can set up the team (roles, data sources) when the person asks; roles can't.
const slot = obj({ days: { type: 'array', items: { type: 'integer', minimum: 0, maximum: 6 }, description: '0 = Sunday … 6 = Saturday' }, at: { type: 'string', description: 'HH:MM in the project\'s time zone' } }, ['days', 'at'])
const MANAGE = [
  {
    name: 'team_roles',
    description: 'The project\'s AI team members (roles): what each does, when it works, its model and autonomy.',
    inputSchema: obj({}),
  },
  {
    name: 'team_role_create',
    description: 'Add an AI team member (role) to this project, only when the person asks for it. Without instructions, DevDash drafts them from the name, summary and project brief (Generate). It runs on the plan of whoever turned Team on.',
    inputSchema: obj({
      name: { type: 'string', description: 'e.g. "Marketing – Social", "CTO"' },
      summary: { type: 'string', description: 'What it should do, in one line.' },
      instructions: { type: 'string', description: 'Markdown: mission, what it watches, delivers, measures, may do alone, must ask first, works with. Omit to generate.' },
      model: { type: 'string', enum: ['opus', 'sonnet', 'haiku'] },
      schedule: { type: 'array', items: slot, description: 'When it works on its own. Default: weekdays 09:00.' },
    }, ['name']),
  },
  {
    name: 'team_role_update',
    description: 'Change a role when the person asks: its name, summary, instructions, model, schedule, triggers, autonomy, lead, or pause it.',
    inputSchema: obj({
      role: { type: ['string', 'integer'], description: 'Its name or #id (see team_roles).' },
      name: { type: 'string' }, summary: { type: 'string' }, instructions: { type: 'string' },
      model: { type: ['string', 'null'], enum: ['opus', 'sonnet', 'haiku', null] },
      schedule: { type: 'array', items: slot },
      triggers: { type: 'array', items: { type: 'string', enum: ['work', 'task_done', 'task_created'] } },
      autonomy: { type: 'string', enum: ['advisor', 'operator'] },
      paused: { type: 'boolean' }, lead: { type: 'boolean' },
    }, ['role']),
  },
  {
    name: 'team_source_list',
    description: 'The project\'s data sources for the roles (databases, APIs, pages): where each reads from and whether its key is set. Keys are never shown.',
    inputSchema: obj({}),
  },
  {
    name: 'team_source_add',
    description: 'Connect a read-only data source for the roles, when the person asks. kind "postgres": a database (key = connection string, ideally a read-only user). "sqlite": a database file on this server (path). "http": an API (base_url; roles read only under it; key_in + key_name say where the key goes). "page": a public page to watch (url).',
    inputSchema: obj({
      name: { type: 'string', description: 'Short, e.g. "App database", "YouTube".' },
      kind: { type: 'string', enum: ['postgres', 'sqlite', 'http', 'page'] },
      description: { type: 'string', description: 'What is in it, so roles know when to look (e.g. "sign-ups, shops, orders; no personal data").' },
      path: { type: 'string', description: 'sqlite: full path of the file on the server.' },
      base_url: { type: 'string', description: 'http: e.g. https://www.googleapis.com/youtube/v3/' },
      key_in: { type: 'string', enum: ['header', 'query'] },
      key_name: { type: 'string', description: 'http: the header (e.g. Authorization) or URL parameter (e.g. key) the key goes in.' },
      url: { type: 'string', description: 'page: the URL.' },
      key: { type: 'string', description: 'The connection string or API key, only one the person gave you for this or pointed you to. Otherwise leave it out: they paste it on the Team tab, so it never passes through the chat.' },
    }, ['name', 'kind']),
  },
  {
    name: 'team_source_update',
    description: 'Change a data source when the person asks: its name, description, where it reads from, or its key (same fields as team_source_add).',
    inputSchema: obj({
      source: { type: ['string', 'integer'], description: 'Its name or #id (see team_source_list).' },
      name: { type: 'string' }, description: { type: 'string' }, path: { type: 'string' }, base_url: { type: 'string' },
      key_in: { type: 'string', enum: ['header', 'query'] }, key_name: { type: 'string' }, url: { type: 'string' }, key: { type: 'string' },
    }, ['source']),
  },
  {
    name: 'team_source_test',
    description: 'A first look at a data source, as a role would get it, to check it works.',
    inputSchema: obj({ source: { type: ['string', 'integer'] } }, ['source']),
  },
  {
    name: 'team_source_remove',
    description: 'Remove a data source, only when the person asks. Roles stop seeing it.',
    inputSchema: obj({ source: { type: ['string', 'integer'] } }, ['source']),
  },
]

/** The team tools this session gets: all role tools in a role's own sessions; team_message and managing roles in a
 *  person's sessions of a project with Team on; none otherwise (or when DevDash can't tell: Team off, an older server). */
export async function teamTools(call, context) {
  try {
    const who = await call('mcp.team_role', { ...context, args: {} })
    if (who?.role) return [...TEAM_TOOLS, MESSAGE_TOOL, ...ROLE_ONLY]
    if (who?.session) return [MESSAGE_TOOL, ...MANAGE]
  } catch {
    // no team here
  }
  return []
}
