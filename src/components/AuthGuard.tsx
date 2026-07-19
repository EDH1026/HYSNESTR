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

  // PRD v2.97 ADM-10: invited accounts must set a password before reaching any
  // protected screen. Applied once at the router root so no route can skip it.
  if (profile?.must_set_password) return <Navigate to="/reset-password" replace />

  return <Outlet />
}
