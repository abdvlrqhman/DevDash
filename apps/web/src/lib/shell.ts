// Bridge injected by the native app (apps/shell/src-tauri/src/lib.rs). Absent in a normal browser.
declare global {
  interface Window {
    devdashShell?: {
      switchSpace(): void
      openExternal(url: string): void
      /** Native apps from 0.1.3 on. */
      notify?(title: string, body: string): void
      notificationPermission?(ask: boolean): Promise<'granted' | 'denied' | 'prompt'>
      /** The iPhone app with Apple push (lib/ios-push.ts): asks Apple for a device token again. */
      registerPush?(): void
    }
    /** The Android app from 0.1.4 on (apps/shell/android): notifications while the app is closed, from this server. */
    DevDashAndroid?: {
      enableBackgroundNotifications(origin: string): boolean
      disableBackgroundNotifications(): void
      backgroundNotifications(): boolean
    }
  }
}

export const inShell = () => window.devdashShell !== undefined
export const inIosShell = () => inShell() && /iPhone|iPad|iPod/.test(navigator.userAgent)

let asking: Promise<unknown> = Promise.resolve()
/**
 * The app's notification permission (asking shows the system prompt). One question at a time: each is a navigation the
 * app answers through a single callback, and a second navigation at once would cancel the first.
 */
export function notificationPermission(ask: boolean): Promise<'granted' | 'denied' | 'prompt'> {
  const bridge = window.devdashShell?.notificationPermission
  if (!bridge) return Promise.resolve('denied')
  const answer = asking.then(() => bridge(ask), () => bridge(ask))
  asking = answer.catch(() => {})
  return answer
}

const BG_OFF = 'devdash.background-notifications-off'
/** Notifications while the app is closed were turned off on this device (Android and iPhone apps). */
export function backgroundOff() {
  try { return localStorage.getItem(BG_OFF) !== null } catch { return false } // storage blocked: treat as on
}
export function setBackgroundOff(off: boolean) {
  try { if (off) localStorage.setItem(BG_OFF, '1'); else localStorage.removeItem(BG_OFF) } catch { /* not remembered */ }
}

/** Android app: keep the background connection on whenever notifications are allowed, unless turned off here. */
export async function syncBackgroundNotifications() {
  const android = window.DevDashAndroid
  if (!android || android.backgroundNotifications() || backgroundOff()) return
  if ((await notificationPermission(false)) === 'granted') android.enableBackgroundNotifications(location.origin)
}
export function setBackgroundNotifications(on: boolean) {
  const android = window.DevDashAndroid
  if (!android) return
  setBackgroundOff(!on)
  if (on) android.enableBackgroundNotifications(location.origin)
  else android.disableBackgroundNotifications()
}

/** Opens a link outside DevDash: the system browser in the app, a new tab in a browser. */
export function openExternal(url: string) {
  if (window.devdashShell) window.devdashShell.openExternal(url)
  else window.open(url, '_blank', 'noopener,noreferrer')
}

export const APP_DOWNLOADS = 'https://github.com/abdvlrqhman/DevDash/releases/latest'
