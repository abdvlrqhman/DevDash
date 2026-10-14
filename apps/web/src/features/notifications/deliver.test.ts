import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deliver } from './deliver.ts'

test('a notification goes where the user can see it, without showing twice', () => {
  // Looking (foreground, actively using DevDash): a toast — but nothing if you're already on the page it points to.
  assert.equal(deliver({ looking: true, onPage: false, androidBackground: false, nativeNotify: false }), 'toast')
  assert.equal(deliver({ looking: true, onPage: true, androidBackground: false, nativeNotify: false }), 'none')
  // Looking wins over every away path, so there's never a toast and a system notification at once.
  assert.equal(deliver({ looking: true, onPage: false, androidBackground: true, nativeNotify: true }), 'toast')

  // Away, Android background service on: it posts the system notification, so the web stays quiet.
  assert.equal(deliver({ looking: false, onPage: false, androidBackground: true, nativeNotify: true }), 'none')

  // Away, Tauri shell (desktop/iOS) with the native bridge: a native OS notification while the app is open.
  assert.equal(deliver({ looking: false, onPage: false, androidBackground: false, nativeNotify: true }), 'native')

  // Away, plain browser or installed web app: a sticky toast waits for whoever comes back (Web Push covers the away case).
  assert.equal(deliver({ looking: false, onPage: false, androidBackground: false, nativeNotify: false }), 'toast-sticky')
})
