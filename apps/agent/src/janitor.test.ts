import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decide, STALE_MS, type WorktreeState } from './janitor.ts'

// Decision policy only (no git, no filesystem): a stale, clean, merged worktree is removed; everything uncertain is kept.
const old = STALE_MS + 60_000
const recent = STALE_MS - 60_000
const safe: WorktreeState = { ageMs: old, dirty: false, aheadOfBase: 0, mergedIntoBase: true, locked: false, gitError: false }

test('removes an old, clean, fully-merged worktree', () => {
  assert.equal(decide(safe).remove, true)
})

test('removes an old clean worktree with zero commits ahead, even if not flagged merged', () => {
  assert.equal(decide({ ...safe, mergedIntoBase: false, aheadOfBase: 0 }).remove, true)
})

test('skips a worktree with uncommitted changes', () => {
  const d = decide({ ...safe, dirty: true })
  assert.equal(d.remove, false)
  assert.match(d.reason, /uncommitted/)
})

test('skips a worktree with unmerged commits ahead of base', () => {
  const d = decide({ ...safe, mergedIntoBase: false, aheadOfBase: 3 })
  assert.equal(d.remove, false)
  assert.match(d.reason, /unmerged/)
})

test('skips a too-recent worktree even when clean and merged', () => {
  assert.equal(decide({ ...safe, ageMs: recent }).remove, false)
})

test('skips a locked worktree', () => {
  assert.equal(decide({ ...safe, locked: true }).remove, false)
})

test('skips when git state could not be read', () => {
  assert.equal(decide({ ...safe, gitError: true }).remove, false)
})
