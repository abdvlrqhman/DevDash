import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildTranscript, mergeRaw, type Raw } from './transcript.ts'

const msgs: Raw[] = [
  { type: 'user', uuid: 'u1', message: { role: 'user', content: 'Fix the login crash' } },
  { type: 'assistant', uuid: 'a1', message: { content: [{ type: 'thinking', thinking: 'look at auth' }, { type: 'text', text: 'Looking.' }, { type: 'tool_use', id: 't1', name: 'Task', input: { description: 'search' } }] } },
  { type: 'assistant', uuid: 'a2', parent_tool_use_id: 't1', message: { content: [{ type: 'tool_use', id: 't2', name: 'Grep', input: { pattern: 'refresh' } }] } },
  { type: 'user', uuid: 'u2', parent_tool_use_id: 't1', message: { content: [{ type: 'tool_result', tool_use_id: 't2', content: 'auth.dart:42' }] } },
  { type: 'user', uuid: 'u3', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'found it' }], is_error: false }] } },
  { type: 'user', uuid: 'u4', message: { content: '<command-name>/compact</command-name>' } },
  { type: 'user', uuid: 'u5', message: { content: '<local-command-stdout>Compacted</local-command-stdout>' } },
  { type: 'result', uuid: 'r1', subtype: 'success', duration_ms: 4200, total_cost_usd: 0.03 },
]

test('builds user, thinking, text, nested tool calls with results, commands and the result footer', () => {
  const b = buildTranscript(msgs)
  assert.deepEqual(b.map((x) => x.kind), ['user', 'thinking', 'text', 'tool', 'command', 'result'])
  const task = b[3]!
  assert.ok(task.kind === 'tool')
  assert.equal(task.result?.text, 'found it')
  assert.equal(task.children.length, 1, 'subagent step nests under the Task call')
  const grep = task.children[0]!
  assert.ok(grep.kind === 'tool' && grep.result?.text === 'auth.dart:42')
  const cmd = b[4]!
  assert.ok(cmd.kind === 'command' && cmd.name === '/compact' && cmd.output === 'Compacted')
  const res = b[5]!
  assert.ok(res.kind === 'result' && res.ok && res.seconds === 4)
})

test('merging live messages skips ones already in the transcript', () => {
  const merged = mergeRaw(msgs.slice(0, 2), [msgs[1]!, msgs[2]!])
  assert.deepEqual(merged.map((m) => m.uuid), ['u1', 'a1', 'a2'])
})

test('images in user messages become data URLs', () => {
  const b = buildTranscript([{ type: 'user', uuid: 'x', message: { content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } }, { type: 'text', text: 'this' }] } }])
  assert.ok(b[0]!.kind === 'user' && b[0]!.images[0] === 'data:image/png;base64,AAA')
})
