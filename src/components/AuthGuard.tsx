import { Navigate, Outlet } from 'react-router-dom'
import { useAuth, clearReloadRecord } from '@/context/AuthContext'

export default function AuthGuard() {
  const { session, profile, isLoading, mfaRequired, loadError } = useAuth()

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-brand-600 border-t-transparent" />
      </div>
    )
  }

  // Initial session/profile load failed or timed out (flaky network etc.) — show a
  // recoverable error instead of leaving the caller on an indefinite spinner.
  if (loadError) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3 p-4 text-center">
        <p className="text-sm text-gray-600">{loadError}</p>
        <button
          onClick={() => { clearReloadRecord(); window.location.reload() }}
          className="btn-primary"
        >
          새로고침
        </button>
      </div>
    )
  }

  if (!session) return <Navigate to="/login" replace />

  // TOTP MFA: session is only at aal1 (password only) but this account has a verified
  // factor demanding aal2 — hold here until the TOTP challenge is completed. Checked
  // before the profile/must_set_password gates below on purpose: profiles_select's
  // "id = auth.uid()" self-row clause bypasses the RLS-side aal2 gate so this read
  // wouldn't itself fail at aal1, but a security gate shouldn't depend on that detail
  // to be reachable — verify identity before evaluating anything else about the account.
  if (mfaRequired) return <Navigate to="/mfa-challenge" replace />

  // PRD v2.98 ADM-10 fix: fail-closed. A missing profile row (query error, not-yet-
  // loaded edge case, or a row that genuinely doesn't exist yet) must block access,
  // not silently pass — the old `profile?.must_set_password` fell through to
  // <Outlet/> whenever profile was null.
  if (!profile || profile.must_set_password) return <Navigate to="/reset-password" replace />

  // PRD v2.99 ADM-10⑦: LoginPage stashes the just-typed password for ResetPasswordPage's
  // current_password handoff (see there). Wipe it here on every normal pass-through so it
  // never lingers in sessionStorage for accounts that didn't need it.
  sessionStorage.removeItem('eyp_login_password')

  return <Outlet />
}
