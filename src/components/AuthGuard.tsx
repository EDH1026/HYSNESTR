import { Navigate, Outlet } from 'react-router-dom'
import { useAuth } from '@/context/AuthContext'

export default function AuthGuard() {
  const { session, profile, isLoading } = useAuth()

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-brand-600 border-t-transparent" />
      </div>
    )
  }

  if (!session) return <Navigate to="/login" replace />

  // PRD v2.98 ADM-10 fix: fail-closed. A missing profile row (query error, not-yet-
  // loaded edge case, or a row that genuinely doesn't exist yet) must block access,
  // not silently pass — the old `profile?.must_set_password` fell through to
  // <Outlet/> whenever profile was null.
  if (!profile || profile.must_set_password) return <Navigate to="/reset-password" replace />

  return <Outlet />
}
