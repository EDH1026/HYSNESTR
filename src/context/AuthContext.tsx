import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from '@/lib/supabase'
import type { Grant, Profile } from '@/types'

// 무활동 30분 경과 시 자동 로그아웃 (세션이 로컬스토리지에 무기한 유지되던 문제 수정).
const IDLE_TIMEOUT_MS = 30 * 60 * 1000

// 3초가 지나도 초기 로드가 안 끝나면 바로 재시도(reload)한다.
const AUTH_LOAD_TIMEOUT_MS = 3_000

// 재시도해도 계속 실패하는 경우(예: Supabase 자체 장애) 무한 새로고침 루프에 빠지지
// 않도록 자동 재시도 횟수를 제한한다. 기록에 타임스탬프를 같이 저장해 마지막 시도로부터
// AUTH_RELOAD_WINDOW_MS가 지나면 카운트를 리셋한다 — 그렇지 않으면 tab이 살아있는 동안
// 카운트가 영구히 남아 이후의 정상적인 재시도까지 곧장 에러 화면으로 막아버리게 된다.
// MAX=1: AUTH_LOAD_TIMEOUT_MS가 3초로 짧아 재시도 자체가 저렴하지만, 그렇다고 계속
// 자동으로 새로고침을 반복하면(3초→새로고침→3초→…) 화면이 계속 깜빡이며 사용자가
// 제어권을 못 가지므로, 자동 재시도는 1회만 하고 그래도 안 되면 바로 에러 화면으로
// 넘겨 사용자가 직접 판단하게 한다.
const AUTH_RELOAD_KEY        = 'eyp_auth_reload_record'
const AUTH_RELOAD_MAX        = 1
const AUTH_RELOAD_WINDOW_MS  = 60_000

// Exported so AuthGuard's manual "새로고침" button can give itself a clean
// retry budget instead of waiting out AUTH_RELOAD_WINDOW_MS.
export function clearReloadRecord() {
  sessionStorage.removeItem(AUTH_RELOAD_KEY)
}

function readReloadRecord(): { count: number; at: number } {
  try {
    const raw = sessionStorage.getItem(AUTH_RELOAD_KEY)
    if (!raw) return { count: 0, at: 0 }
    const parsed = JSON.parse(raw) as { count: number; at: number }
    if (Date.now() - parsed.at > AUTH_RELOAD_WINDOW_MS) return { count: 0, at: 0 }
    return parsed
  } catch {
    return { count: 0, at: 0 }
  }
}

function triggerReloadOrFail(
  setState: (updater: (s: AuthState) => AuthState) => void,
  message: string,
) {
  const rec = readReloadRecord()
  if (rec.count < AUTH_RELOAD_MAX) {
    sessionStorage.setItem(AUTH_RELOAD_KEY, JSON.stringify({ count: rec.count + 1, at: Date.now() }))
    window.location.reload()
    return
  }
  setState(s => ({ ...s, isLoading: false, loadError: message }))
}

// ── Cross-tab idle tracking ─────────────────────────────────────
// localStorage (not an in-memory var) so every tab sees the true last-activity
// time across the whole browser, not just its own. Two consequences this fixes:
//   1. A tab you're actively using no longer gets signed out because some OTHER
//      background tab's own (previously per-tab) idle clock expired.
//   2. A fresh page load / reopen after being closed can tell it's been idle
//      ≥ IDLE_TIMEOUT_MS and sign out immediately, instead of resetting the
//      clock to "now" just because the page happened to load this instant.
const ACTIVITY_KEY = 'eyp_last_activity'

function getLastActivity(): number {
  const v = localStorage.getItem(ACTIVITY_KEY)
  return v ? Number(v) : Date.now()
}

function markActivity() {
  localStorage.setItem(ACTIVITY_KEY, String(Date.now()))
}

// ── MFA (TOTP) assurance check ──────────────────────────────────
// MFA is mandatory (not opt-in): every account must have a verified TOTP
// factor before it can see any data. getAuthenticatorAssuranceLevel()'s
// nextLevel tells us which case applies from a single call:
//   nextLevel === 'aal1' → no verified factor exists at all → force enrollment
//     (/mfa-setup, AuthGuard) — this is the mandatory case beyond the original
//     opt-in design; without it an account that never enrolls sails through
//     with password-only access forever.
//   nextLevel === 'aal2' && currentLevel !== nextLevel → factor exists but this
//     session hasn't completed the TOTP challenge yet → /mfa-challenge.
//   currentLevel === nextLevel === 'aal2' → fully satisfied, proceed.
// This is a UX gate only; the RLS-side enforcement (server can't be tricked by
// skipping this) is a separate migration, see supabase/migrations for the
// app_can()/my_role()/is_admin()/is_assistant() AAL2 gate.
interface MfaStatus {
  mfaRequired:      boolean   // factor enrolled, but this session hasn't completed the challenge
  mfaSetupRequired: boolean   // no verified factor at all — enrollment itself is mandatory
}

async function checkMfaStatus(): Promise<MfaStatus> {
  const { data, error } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel()
  if (error || !data) return { mfaRequired: false, mfaSetupRequired: false }
  const hasFactor = data.nextLevel === 'aal2'
  return {
    mfaSetupRequired: !hasFactor,
    mfaRequired:      hasFactor && data.currentLevel !== data.nextLevel,
  }
}

// ── Context shape ─────────────────────────────────────────────

interface AuthState {
  session:      Session | null
  profile:      Profile | null
  grants:       Grant[]
  myPersonId:   string | null   // profiles.person_id — set by admin in AccountManager (PRD v2.5 §6.2)
  isLoading:        boolean
  mfaRequired:      boolean     // session at aal1 but a verified TOTP factor demands aal2
  mfaSetupRequired: boolean     // no verified TOTP factor at all — enrollment is mandatory
  loadError:        string | null   // set when initial session/profile load fails or times out
}

interface AuthContextValue extends AuthState {
  signOut: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

// ── Provider ──────────────────────────────────────────────────

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({
    session:     null,
    profile:     null,
    grants:      [],
    myPersonId:  null,
    isLoading:        true,
    mfaRequired:      false,
    mfaSetupRequired: false,
    loadError:        null,
  })

  // Prevent stale-closure updates after unmount
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  const loadProfileAndGrants = useCallback(async (userId: string) => {
    const [profileRes, grantsRes] = await Promise.all([
      supabase.from('profiles').select('*').eq('id', userId).single(),
      supabase.from('grants').select('*').eq('user_id', userId),
    ])
    const profile = (profileRes.data as Profile | null) ?? null
    return {
      profile,
      grants:     (grantsRes.data as Grant[] | null) ?? [],
      myPersonId: profile?.person_id ?? null,
    }
  }, [])

  useEffect(() => {
    // ── Initial session check ────────────────────────────────
    // If it doesn't resolve within AUTH_LOAD_TIMEOUT_MS, reload immediately
    // (capped by AUTH_RELOAD_MAX so a genuine outage falls back to a manual
    // error screen rather than looping — see triggerReloadOrFail).
    let settled = false
    const timeoutId = setTimeout(() => {
      if (settled || !mounted.current) return
      settled = true
      triggerReloadOrFail(setState, '연결이 지연되고 있습니다. 새로고침해주세요.')
    }, AUTH_LOAD_TIMEOUT_MS)

    supabase.auth.getSession()
      .then(async ({ data: { session } }) => {
        if (settled || !mounted.current) return
        if (session) {
          // LV-idle: a fresh mount (reopened tab/browser) must not reset the idle
          // clock to "now" just because the page happens to load this instant —
          // check the shared cross-tab last-activity time before trusting the
          // persisted session.
          if (Date.now() - getLastActivity() >= IDLE_TIMEOUT_MS) {
            settled = true
            sessionStorage.setItem('eyp_idle_logout', '1')
            clearReloadRecord()
            await supabase.auth.signOut()
            if (mounted.current) {
              setState({ session: null, profile: null, grants: [], myPersonId: null, isLoading: false, mfaRequired: false, mfaSetupRequired: false, loadError: null })
            }
            return
          }
          try {
            const [{ profile, grants, myPersonId }, mfa] = await Promise.all([
              loadProfileAndGrants(session.user.id),
              checkMfaStatus(),
            ])
            if (settled || !mounted.current) return
            settled = true
            clearReloadRecord()
            setState({ session, profile, grants, myPersonId, isLoading: false, mfaRequired: mfa.mfaRequired, mfaSetupRequired: mfa.mfaSetupRequired, loadError: null })
          } catch {
            settled = true
            triggerReloadOrFail(setState, '사용자 정보를 불러오지 못했습니다. 새로고침해주세요.')
          }
        } else {
          settled = true
          clearReloadRecord()
          setState({ session: null, profile: null, grants: [], myPersonId: null, isLoading: false, mfaRequired: false, mfaSetupRequired: false, loadError: null })
        }
      })
      .catch(() => {
        if (settled || !mounted.current) return
        settled = true
        triggerReloadOrFail(setState, '로그인 상태를 확인하지 못했습니다. 새로고침해주세요.')
      })
      .finally(() => clearTimeout(timeoutId))

    // ── Real-time auth state changes ─────────────────────────
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      async (event, session) => {
        if (!mounted.current) return

        if (event === 'SIGNED_IN') markActivity()   // fresh login is unambiguous activity

        if (
          session &&
          (event === 'SIGNED_IN' ||
            event === 'TOKEN_REFRESHED' ||
            event === 'USER_UPDATED' ||
            event === 'PASSWORD_RECOVERY' ||
            event === 'MFA_CHALLENGE_VERIFIED')   // completed the TOTP step — re-derive mfa status
        ) {
          try {
            const [{ profile, grants, myPersonId }, mfa] = await Promise.all([
              loadProfileAndGrants(session.user.id),
              checkMfaStatus(),
            ])
            if (mounted.current) {
              setState({ session, profile, grants, myPersonId, isLoading: false, mfaRequired: mfa.mfaRequired, mfaSetupRequired: mfa.mfaSetupRequired, loadError: null })
            }
          } catch (err) {
            if (!mounted.current) return
            // Only surface the full-page error if this is still part of the initial
            // load — a background TOKEN_REFRESHED failure mid-session shouldn't wipe
            // an active user's screen and unsaved form state; just log it instead.
            // (Checked against the fresh `s` inside the updater, not the `state`
            // this closure was created with, which would always read the mount-time
            // value since this effect only depends on `loadProfileAndGrants`.)
            console.error('세션 갱신 후 프로필/권한 재조회 실패', event, err)
            setState(s => s.isLoading
              ? { ...s, session, isLoading: false, loadError: '사용자 정보를 불러오지 못했습니다. 새로고침해주세요.' }
              : s)
          }
        } else if (event === 'SIGNED_OUT') {
          // A stale eyp_last_activity must not outlive the session it belonged to —
          // otherwise a fresh SIGNED_IN in another tab, followed by a page load in
          // this one, could read that old timestamp and sign the new session out
          // immediately via the initial-load idle check above.
          localStorage.removeItem(ACTIVITY_KEY)
          if (mounted.current) {
            setState({ session: null, profile: null, grants: [], myPersonId: null, isLoading: false, mfaRequired: false, mfaSetupRequired: false, loadError: null })
          }
        }
      },
    )

    return () => {
      clearTimeout(timeoutId)
      subscription.unsubscribe()
    }
  }, [loadProfileAndGrants])

  // ── Idle timeout: auto sign-out after IDLE_TIMEOUT_MS of no user activity ──
  // lastActivity lives in localStorage (shared across tabs — see markActivity/
  // getLastActivity above), checked on a low-frequency interval plus on tab
  // visibility regain, so a laptop left open overnight or a backgrounded/
  // minimized tab (where timers are throttled) still gets caught the moment the
  // user returns, and activity in one tab keeps every other tab's session alive.
  const hasSession = !!state.session
  useEffect(() => {
    if (!hasSession) return

    const checkIdle = () => {
      if (Date.now() - getLastActivity() >= IDLE_TIMEOUT_MS) {
        sessionStorage.setItem('eyp_idle_logout', '1')
        supabase.auth.signOut()
      }
    }

    const activityEvents = ['mousedown', 'keydown', 'scroll', 'touchstart'] as const
    activityEvents.forEach(ev => window.addEventListener(ev, markActivity, { passive: true }))
    document.addEventListener('visibilitychange', checkIdle)
    const intervalId = setInterval(checkIdle, 30_000)

    return () => {
      activityEvents.forEach(ev => window.removeEventListener(ev, markActivity))
      document.removeEventListener('visibilitychange', checkIdle)
      clearInterval(intervalId)
    }
  }, [hasSession])

  const signOut = useCallback(async () => {
    await supabase.auth.signOut()
    // onAuthStateChange(SIGNED_OUT) clears state automatically
  }, [])

  return (
    <AuthContext.Provider value={{ ...state, signOut }}>
      {children}
    </AuthContext.Provider>
  )
}

// ── Hook ──────────────────────────────────────────────────────

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within <AuthProvider>')
  return ctx
}
