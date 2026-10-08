// Bridge injected by the native app (apps/shell/src-tauri/src/lib.rs). Absent in a normal browser.
declare global {
  interface Window {
    devdashShell?: {
      switchSpace(): void
      openExternal(url: string): void
      /** Native apps from 0.1.3 on. */
      notify?(title: string, body: string): void
      notificationPermission?(ask: boolean): Promise<'granted' | 'denied' | 'prompt'>
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

const BG_OFF = 'devdash.background-notifications-off'
/** Android app: keep the background connection on whenever notifications are allowed, unless turned off here. */
export async function syncBackgroundNotifications() {
  const android = window.DevDashAndroid
  if (!android || android.backgroundNotifications()) return
  try { if (localStorage.getItem(BG_OFF)) return } catch { /* storage blocked: treat as on */ }
  if ((await window.devdashShell?.notificationPermission?.(false)) === 'granted') android.enableBackgroundNotifications(location.origin)
}
export function setBackgroundNotifications(on: boolean) {
  const android = window.DevDashAndroid
  if (!android) return
  try { if (on) localStorage.removeItem(BG_OFF); else localStorage.setItem(BG_OFF, '1') } catch { /* not remembered */ }
  if (on) android.enableBackgroundNotifications(location.origin)
  else android.disableBackgroundNotifications()
}

/** Opens a link outside DevDash: the system browser in the app, a new tab in a browser. */
export function openExternal(url: string) {
  if (window.devdashShell) window.devdashShell.openExternal(url)
  else window.open(url, '_blank', 'noopener,noreferrer')
}

export const APP_DOWNLOADS = 'https://github.com/abdvlrqhman/DevDash/releases/latest'
