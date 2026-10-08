// DevDash tools for Claude Code (MCP over stdio: newline-delimited JSON-RPC 2.0). No dependencies, no tokens:
// calls go to this member's own agent socket, which relays them to the DevDash server, so they act as this member
// ("via Claude"). The project comes from the Claude session (DEVDASH_SESSION_ID) or the working folder.
import { connect } from 'node:net'
import { createInterface } from 'node:readline'

const SOCKET = process.env.DEVDASH_AGENT_SOCKET
const context = { sessionId: process.env.DEVDASH_SESSION_ID ?? null, cwd: process.cwd() }

const status = { type: 'string', enum: ['backlog', 'todo', 'in_progress', 'review', 'done'] }
const priority = { type: 'string', enum: ['none', 'low', 'medium', 'high', 'urgent'] }
const project = { type: 'string', description: "Project short name (e.g. 'shop'). Omit to use this session's project." }
const number = { type: 'integer', description: 'Task number within the project (shop#12 → 12).' }
const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false })

const TOOLS = [
  { name: 'project_info', description: "This session's DevDash project: name, repository, default branch, folder, open task count. Also lists every project.", inputSchema: obj({ project }) },
  { name: 'tasks_list', description: 'Tasks in a project (open ones, plus recently done). Filter by status or "mine" (assigned to the person you work for).', inputSchema: obj({ project, status, mine: { type: 'boolean' } }) },
  { name: 'task_get', description: 'One task with its details, comments and linked commits and sessions.', inputSchema: obj({ project, number }, ['number']) },
  { name: 'task_create', description: 'Create a task in the project.', inputSchema: obj({ project, title: { type: 'string' }, body: { type: 'string', description: 'Markdown.' }, status, priority, due: { type: 'string', description: 'YYYY-MM-DD' } }, ['title']) },
  { name: 'task_update', description: 'Change a task: status, priority, due date, title, body, or assign it to yourself (assign_to_me). Move it to in_progress when you start and review when your work is ready.', inputSchema: obj({ project, number, status, priority, due: { type: ['string', 'null'] }, title: { type: 'string' }, body: { type: 'string' }, assign_to_me: { type: 'boolean' } }, ['number']) },
  { name: 'task_comment', description: 'Comment on a task (markdown), e.g. a summary of what you did.', inputSchema: obj({ project, number, body: { type: 'string' } }, ['number', 'body']) },
  { name: 'notes_list', description: 'Team notes (decisions, setup steps, links), optionally only one project\'s.', inputSchema: obj({ project, all_projects: { type: 'boolean', description: 'Every note, not only this project\'s.' } }) },
  { name: 'note_get', description: 'Read one note.', inputSchema: obj({ id: { type: 'integer' } }, ['id']) },
  { name: 'note_upsert', description: 'Create a note (no id) or update one (with id). Notes are visible to the whole team.', inputSchema: obj({ id: { type: 'integer' }, title: { type: 'string' }, body: { type: 'string', description: 'Markdown.' }, project, pinned: { type: 'boolean' } }) },
  { name: 'services_list', description: 'Every long-running service on this server (everyone\'s), with ports and state. Start new ones with `devdash service add` in Bash.', inputSchema: obj({}) },
]

function call(method, params) {
  return new Promise((resolve, reject) => {
    if (!SOCKET) return reject(new Error('DevDash is not available in this session (no DEVDASH_AGENT_SOCKET).'))
    const sock = connect(SOCKET)
    let buf = ''
    sock.setEncoding('utf8')
    sock.on('connect', () => sock.write(JSON.stringify({ op: 'rpc', method, params }) + '\n'))
    sock.on('data', (d) => {
      buf += d
      const i = buf.indexOf('\n')
      if (i < 0) return
      sock.end()
      const m = JSON.parse(buf.slice(0, i))
      if (m.error) reject(new Error(m.error))
      else resolve(m.result)
    })
    sock.on('error', () => reject(new Error('Could not reach DevDash on this server.')))
  })
}

const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n')

async function handle(m) {
  switch (m.method) {
    case 'initialize':
      return { protocolVersion: m.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'devdash', version: '0.2.0' } }
    case 'ping':
      return {}
    case 'tools/list':
      return { tools: TOOLS }
    case 'tools/call': {
      const name = m.params?.name
      if (!TOOLS.some((t) => t.name === name)) throw Object.assign(new Error(`Unknown tool ${name}`), { code: -32602 })
      try {
        const result = await call(`mcp.${name}`, { ...context, args: m.params?.arguments ?? {} })
        return { content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }] }
      } catch (err) {
        return { content: [{ type: 'text', text: err.message }], isError: true }
      }
    }
    default:
      throw Object.assign(new Error(`Method not found: ${m.method}`), { code: -32601 })
  }
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
rl.on('line', async (line) => {
  if (!line.trim()) return
  let m
  try {
    m = JSON.parse(line)
  } catch {
    return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
  }
  if (m.id === undefined || m.id === null) return // a notification (e.g. notifications/initialized): no reply
  try {
    send({ jsonrpc: '2.0', id: m.id, result: await handle(m) })
  } catch (err) {
    send({ jsonrpc: '2.0', id: m.id, error: { code: err.code ?? -32603, message: err.message } })
  }
})
rl.on('close', () => process.exit(0))
