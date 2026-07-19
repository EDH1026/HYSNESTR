import { BrowserRouter, Routes, Route, Navigate, Outlet } from 'react-router-dom'
import { QueryClientProvider } from '@tanstack/react-query'

import { queryClient }    from '@/lib/queryClient'
import { HistoryProvider } from '@/lib/history'
import { AuthProvider }   from '@/context/AuthContext'
import { useAuth }        from '@/context/AuthContext'
import AuthGuard          from '@/components/AuthGuard'
import AppLayout          from '@/components/AppLayout'

import LoginPage          from '@/pages/LoginPage'
import ForgotPasswordPage from '@/pages/ForgotPasswordPage'
import ResetPasswordPage  from '@/pages/ResetPasswordPage'
import DashboardPage      from '@/pages/DashboardPage'
import HashtagPage        from '@/pages/HashtagPage'
import TimelinePage       from '@/pages/TimelinePage'
import PeoplePage         from '@/pages/PeoplePage'
import WorkItemsPage      from '@/pages/WorkItemsPage'
import LeavePage          from '@/pages/LeavePage'
import HolidaysPage       from '@/pages/HolidaysPage'
import CVPage             from '@/pages/CVPage'
import AdminPage          from '@/pages/AdminPage'
import DataTestPage       from '@/pages/DataTestPage'
import AnnualLeavePage          from '@/pages/AnnualLeavePage'
import TimesheetGuidelinePage   from '@/pages/TimesheetGuidelinePage'
/** All authenticated users → /dashboard. */
function HomeRedirect() {
  return <Navigate to="/dashboard" replace />
}

/**
 * Guard for editor/admin-only routes (People, WorkItems, Holidays, etc.).
 * Viewer → /dashboard.
 */
function EditorGuard() {
  const { profile } = useAuth()
  if (profile?.global_role === 'viewer') return <Navigate to="/dashboard" replace />
  return <Outlet />
}

/**
 * Guard for admin-only routes.
 * Non-admin → /dashboard.
 */
function AdminGuard() {
  const { profile } = useAuth()
  if (profile?.global_role !== 'admin') return <Navigate to="/dashboard" replace />
  return <Outlet />
}

/**
 * Guard for admin/assistant-only routes (연차 관리, 타임시트 지침 — PRD v2.100).
 * admin edits, assistant is view-only (enforced inside the page). editor/viewer → /dashboard.
 */
function AdminOrAssistantGuard() {
  const { profile } = useAuth()
  const role = profile?.global_role
  if (role !== 'admin' && role !== 'assistant') return <Navigate to="/dashboard" replace />
  return <Outlet />
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <HistoryProvider>
      <BrowserRouter>
        <AuthProvider>
          <Routes>
            {/* ── Public ──────────────────────────────────── */}
            <Route path="/login"           element={<LoginPage />} />
            <Route path="/forgot-password" element={<ForgotPasswordPage />} />
            <Route path="/reset-password"  element={<ResetPasswordPage />} />

            {/* ── Protected — requires Supabase session ───── */}
            <Route element={<AuthGuard />}>
              <Route element={<AppLayout />}>
                <Route index element={<HomeRedirect />} />

                {/* Legacy /me → dashboard redirect */}
                <Route path="me" element={<Navigate to="/dashboard" replace />} />

                {/* ── Viewer-accessible routes (§6.3) ──────── */}
                <Route path="dashboard"  element={<DashboardPage />} />
                <Route path="timeline"   element={<TimelinePage />} />
                <Route path="hashtags"   element={<HashtagPage />} />
                <Route path="cv"         element={<CVPage />} />
                <Route path="leave"      element={<LeavePage />} />

                {/* ── Editor / admin only ───────────────────── */}
                <Route element={<EditorGuard />}>
                  <Route path="work-items"    element={<WorkItemsPage />} />
                  <Route path="holidays"      element={<HolidaysPage />} />
                  <Route path="data-test"             element={<DataTestPage />} />
                </Route>

                {/* ── Admin / assistant only (assistant view-only, PRD v2.100) ── */}
                <Route element={<AdminOrAssistantGuard />}>
                  <Route path="annual-leave"          element={<AnnualLeavePage />} />
                  <Route path="timesheet-guideline"   element={<TimesheetGuidelinePage />} />
                </Route>

                {/* ── Admin only ────────────────────────────── */}
                <Route element={<AdminGuard />}>
                  <Route path="people" element={<PeoplePage />} />
                  <Route path="admin"  element={<AdminPage />} />
                </Route>
              </Route>
            </Route>

            {/* ── Fallback ─────────────────────────────────── */}
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </AuthProvider>
      </BrowserRouter>
      </HistoryProvider>
    </QueryClientProvider>
  )
}
