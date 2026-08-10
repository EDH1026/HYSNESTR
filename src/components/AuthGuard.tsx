import { Navigate, Outlet } from 'react-router-dom'
import { useAuth, clearReloadRecord } from '@/context/AuthContext'

export default function AuthGuard() {
  const { session, profile, isLoading, mfaRequired, mfaSetupRequired, loadError } = useAuth()

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

  // PRD v2.98 ADM-10 fix: fail-closed. A missing profile row (query error, not-yet-
  // loaded edge case, or a row that genuinely doesn't exist yet) must block access,
  // not silently pass — the old `profile?.must_set_password` fell through to
  // <Outlet/> whenever profile was null. Checked first: an invited account should
  // finish setting its real password before being asked to commit to a 2FA device.
  if (!profile || profile.must_set_password) return <Navigate to="/reset-password" replace />

  // TOTP MFA is mandatory, not opt-in — an account with no verified factor at all
  // must enroll before it can see anything (/mfa-setup, no skip). An account that
  // already has a factor but whose current session hasn't completed this login's
  // challenge yet goes to /mfa-challenge instead. mfaSetupRequired and mfaRequired
  // are mutually exclusive (AuthContext derives both from one aal check), so order
  // between these two doesn't matter — check setup first since it's the rarer,
  // more consequential case (first login ever, or right after an unenroll).
  if (mfaSetupRequired) return <Navigate to="/mfa-setup" replace />
  if (mfaRequired) return <Navigate to="/mfa-challenge" replace />

  // PRD v2.99 ADM-10⑦: LoginPage stashes the just-typed password for ResetPasswordPage's
  // current_password handoff (see there). Wipe it here on every normal pass-through so it
  // never lingers in sessionStorage for accounts that didn't need it.
  sessionStorage.removeItem('eyp_login_password')

  return <Outlet />
}
