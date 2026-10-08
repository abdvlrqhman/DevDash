import { useSyncExternalStore } from 'react'

/**
 * The unlocked vault lives only in this tab's memory: the member's private key and the vault keys. Locking (by hand,
 * after 10 idle minutes, or 5 minutes in the background) drops them; nothing is written to storage.
 */
type Keys = Map<number, { key: CryptoKey; version: number }>
type State = { unlocked: false } | { unlocked: true; privateKey: CryptoKey; pkcs8: Uint8Array<ArrayBuffer>; keys: Keys }

const IDLE_MS = 10 * 60_000
const HIDDEN_MS = 5 * 60_000
let state: State = { unlocked: false }
const listeners = new Set<() => void>()
const emit = () => { for (const l of listeners) l() }
let idle: ReturnType<typeof setTimeout> | undefined
let hiddenAt = 0

function touch() {
  if (!state.unlocked) return
  clearTimeout(idle)
  idle = setTimeout(() => vault.lock(), IDLE_MS)
}
for (const ev of ['pointerdown', 'keydown']) window.addEventListener(ev, touch, { passive: true, capture: true })
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') hiddenAt = Date.now()
  else if (hiddenAt && Date.now() - hiddenAt > HIDDEN_MS) vault.lock()
})

export const vault = {
  get: () => state,
  subscribe(l: () => void) {
    listeners.add(l)
    return () => void listeners.delete(l)
  },
  unlock(privateKey: CryptoKey, pkcs8: Uint8Array<ArrayBuffer>) {
    state = { unlocked: true, privateKey, pkcs8, keys: new Map() }
    touch()
    emit()
  },
  setKey(vaultId: number, key: CryptoKey, version: number) {
    if (!state.unlocked) return
    state = { ...state, keys: new Map(state.keys).set(vaultId, { key, version }) }
    emit()
  },
  lock() {
    if (state.unlocked) state.pkcs8.fill(0)
    state = { unlocked: false }
    clearTimeout(idle)
    emit()
  },
}

export const useVault = () => useSyncExternalStore(vault.subscribe, vault.get)

/** Copies a secret and clears the clipboard 30 seconds later (best effort: browsers only allow it while focused). */
export async function copySecret(value: string) {
  await navigator.clipboard.writeText(value)
  setTimeout(() => { if (document.hasFocus()) void navigator.clipboard.writeText('').catch(() => {}) }, 30_000)
}
