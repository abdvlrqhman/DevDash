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
  }
}

export const inShell = () => window.devdashShell !== undefined

/** Opens a link outside DevDash: the system browser in the app, a new tab in a browser. */
export function openExternal(url: string) {
  if (window.devdashShell) window.devdashShell.openExternal(url)
  else window.open(url, '_blank', 'noopener,noreferrer')
}

export const APP_DOWNLOADS = 'https://github.com/abdvlrqhman/DevDash/releases/latest'
