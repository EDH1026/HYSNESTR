/**
 * Detects a stale client bundle by comparing the build id baked into this
 * running JS (__APP_BUILD__, see vite.config.ts) against /version.json,
 * fetched fresh off the server. Used at login: an SPA route change (not a
 * full page load) after signInWithPassword() would otherwise run whatever
 * AuthGuard/MFA logic was loaded when the tab first opened, even if a
 * deploy landed since — see PRD v2.126 stale-tab follow-up.
 */
export async function isVersionStale(): Promise<boolean> {
  try {
    const res = await fetch(`/version.json?t=${Date.now()}`, { cache: 'no-store' })
    if (!res.ok) return false
    const data = await res.json()
    return typeof data?.build === 'string' && data.build !== __APP_BUILD__
  } catch {
    return false
  }
}
