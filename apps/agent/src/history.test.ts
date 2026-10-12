import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pageOf, type HistoryMessage } from './claude.ts'

const prompt = (uuid: string): HistoryMessage => ({ type: 'user', uuid, parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'do it' }] } })
const reply = (uuid: string): HistoryMessage => ({ type: 'assistant', uuid, parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'ok' }] } })
const toolResult = (uuid: string): HistoryMessage => ({ type: 'user', uuid, parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 'x' }] } })

test('history pages hold whole turns: the last N prompts and what followed, then the N before them', () => {
  // 3 turns: p1 r1 | p2 r2 t2 r2b | p3 r3
  const all = [prompt('p1'), reply('r1'), prompt('p2'), reply('r2'), toolResult('t2'), reply('r2b'), prompt('p3'), reply('r3')]
  assert.deepEqual(pageOf(all, { turns: 2 }), { start: 2, end: 8 }) // p2 … r3: a tool result is not a prompt
  assert.deepEqual(pageOf(all, { turns: 2, before: 'p2' }), { start: 0, end: 2 }) // only p1 r1 left
  assert.deepEqual(pageOf(all, { turns: 10 }), { start: 0, end: 8 })
  assert.deepEqual(pageOf(all, {}), { start: 0, end: 8 }) // no turns: everything (the journal reads it all)
  assert.deepEqual(pageOf(all, { turns: 1, before: 'gone' }), { start: 6, end: 8 }) // an unknown id: the latest page
})
