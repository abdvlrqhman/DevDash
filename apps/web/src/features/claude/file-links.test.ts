import { test } from 'node:test'
import assert from 'node:assert/strict'
import { codeFile, fileKind, folderOf, hrefFile, normalize, splitLine } from './file-links.ts'

const at = { cwd: '/srv/devdash/projects/shop', username: 'ann' }

test('code spans that are file paths open; ordinary code stays code', () => {
  assert.deepEqual(codeFile('docs/PLAN.md', at), { path: '/srv/devdash/projects/shop/docs/PLAN.md', line: undefined })
  assert.deepEqual(codeFile('apps/web/src/main.tsx:42', at), { path: '/srv/devdash/projects/shop/apps/web/src/main.tsx', line: 42 })
  assert.deepEqual(codeFile('src/a.ts:42:7', at), { path: '/srv/devdash/projects/shop/src/a.ts', line: 42 })
  assert.deepEqual(codeFile('/srv/x/README.md', at), { path: '/srv/x/README.md', line: undefined })
  assert.deepEqual(codeFile('~/notes/todo.txt', at), { path: '/home/ann/notes/todo.txt', line: undefined })
  assert.deepEqual(codeFile('../other/package.json', at), { path: '/srv/devdash/projects/other/package.json', line: undefined })
  assert.equal(codeFile('README.md', at)?.path, '/srv/devdash/projects/shop/README.md')
  assert.equal(codeFile('Makefile', at)?.path, '/srv/devdash/projects/shop/Makefile')
  assert.equal(codeFile('.env', at)?.path, '/srv/devdash/projects/shop/.env')
  assert.equal(codeFile('.env.local', at)?.path, '/srv/devdash/projects/shop/.env.local')
  assert.equal(codeFile('logs/server.log', at)?.path, '/srv/devdash/projects/shop/logs/server.log')
  assert.equal(codeFile('src/app/[id]/page.tsx', at)?.path, '/srv/devdash/projects/shop/src/app/[id]/page.tsx')

  for (const code of ['npm test', 'origin/main', 'feat/login', 'useState', 'console.log', 'process.env','example.com', 'v1.2.3', 'docs/v1.2', 'src/**/*.ts',
    '--no-verify', '@types/node', 'https://x.io/a.md', 'a b.md', 'foo()', 'express.json()', 'and/or', '/api/files/read', 'x.y', 'src/', '']) {
    assert.equal(codeFile(code, at), null, code)
  }
  assert.equal(codeFile('docs/PLAN.md', {}), null, 'relative paths need the session folder')
})

test('links to files open; web links do not', () => {
  assert.deepEqual(hrefFile('docs/PLAN.md', at), { path: '/srv/devdash/projects/shop/docs/PLAN.md', line: undefined })
  assert.deepEqual(hrefFile('./src/a.ts#L12', at), { path: '/srv/devdash/projects/shop/src/a.ts', line: 12 })
  assert.deepEqual(hrefFile('file:///srv/x/My%20Notes.md', at), { path: '/srv/x/My Notes.md', line: undefined })
  assert.deepEqual(hrefFile('/srv/devdash/projects/shop/src', at), { path: '/srv/devdash/projects/shop/src', line: undefined })
  assert.deepEqual(hrefFile('~/a.md:3', at), { path: '/home/ann/a.md', line: 3 })
  for (const href of ['https://example.com/a.md', 'http://x', 'mailto:a@b.c', '#section', '//cdn.x/a.js', 'www.example.com', 'tel:123', '']) {
    assert.equal(hrefFile(href, at), null, href)
  }
})

test('helpers', () => {
  assert.equal(normalize('/a/./b/../c//d/'), '/a/c/d')
  assert.deepEqual(splitLine('a.ts:9'), { path: 'a.ts', line: 9 })
  assert.deepEqual(splitLine('a.ts'), { path: 'a.ts' })
  assert.equal(folderOf('/srv/x/a.md'), '/srv/x')
  assert.equal(folderOf('/a.md'), '/')
  assert.equal(fileKind('PLAN.MD').kind, 'markdown')
  assert.deepEqual(fileKind('logo.svg'), { kind: 'image', mime: 'image/svg+xml' })
  assert.equal(fileKind('report.pdf').kind, 'pdf')
  assert.equal(fileKind('Dockerfile').kind, 'text')
})
