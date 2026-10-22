import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decide, STALE_MS, sweep, type WorktreeState } from './janitor.ts'

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

test("abandoned .zip uploads (this member's, untouched for a day) are swept; fresh ones and others' files stay", async () => {
  const root = mkdtempSync(join(tmpdir(), 'dd-janitor-up-'))
  const dir = join(root, 'projects', '.dd-uploads')
  mkdirSync(dir, { recursive: true })
  const old = join(dir, 'aaaa1111.zip')
  const fresh = join(dir, 'bbbb2222.zip')
  const stray = join(dir, 'notes.txt')
  for (const f of [old, fresh, stray]) writeFileSync(f, 'x')
  mkdirSync(join(dir, 'cccc3333.x'))
  writeFileSync(join(dir, 'cccc3333.x', 'f'), 'x')
  const dayAgo = (Date.now() - 25 * 3_600_000) / 1000
  for (const f of [old, stray, join(dir, 'cccc3333.x', 'f'), join(dir, 'cccc3333.x')]) utimesSync(f, dayAgo, dayAgo)
  const saved = process.env.DEVDASH_PROJECTS_ROOT
  process.env.DEVDASH_PROJECTS_ROOT = root
  try {
    await sweep()
  } finally {
    if (saved === undefined) delete process.env.DEVDASH_PROJECTS_ROOT
    else process.env.DEVDASH_PROJECTS_ROOT = saved
  }
  assert.deepEqual(readdirSync(dir).sort(), ['bbbb2222.zip', 'notes.txt'])
})
