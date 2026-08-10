import { useState, type FormEvent } from 'react'
import logo from '@/assets/logo.png'
import { Link, useNavigate } from 'react-router-dom'
import { supabase } from '@/lib/supabase'
import { isVersionStale } from '@/lib/version'

export default function LoginPage() {
  const navigate  = useNavigate()
  const [email,    setEmail]    = useState('')
  const [password, setPassword] = useState('')
  const [error,    setError]    = useState<string | null>(null)
  const [loading,  setLoading]  = useState(false)
  // AuthContext's idle timer sets this flag right before signing out (§ idle timeout).
  const [idleLogout] = useState(() => {
    const flagged = sessionStorage.getItem('eyp_idle_logout') === '1'
    if (flagged) sessionStorage.removeItem('eyp_idle_logout')
    return flagged
  })

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setLoading(true)
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    setLoading(false)
    if (error) {
      setError(error.message)
    } else {
      // PRD v2.99 ADM-10⑦: if this account still has must_set_password=true, AuthGuard
      // will redirect to /reset-password. Supabase requires `current_password` on that
      // updateUser call (GOTRUE_SECURITY_UPDATE_PASSWORD_REQUIRE_CURRENT_PASSWORD), so the
      // just-verified password is handed off via sessionStorage (read once, then cleared —
      // see ResetPasswordPage). No-op for accounts that don't need it.
      sessionStorage.setItem('eyp_login_password', password)
      // A tab left open since before the last deploy is still running the old
      // bundle — an SPA navigate('/') here would run that old AuthGuard, which
      // may predate mandatory-MFA (or any other) enforcement. Full reload
      // instead: the session Supabase just persisted survives the reload, and
      // the fresh bundle re-evaluates it from scratch.
      if (await isVersionStale()) {
        window.location.reload()
        return
      }
      navigate('/')
    }
  }

  return (
    <div className="min-h-screen bg-surface-50 flex items-center justify-center p-4">
      <div className="card w-full max-w-sm p-8">
        <div className="mb-8 text-center">
          <img src={logo} alt="" className="mx-auto mb-4 h-12 w-12 object-contain" />
          <h1 className="text-xl font-semibold text-gray-900">Strategy Team Dashboard</h1>
          <p className="mt-1 text-sm text-muted">Sign in with your company account</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {idleLogout && !error && (
            <div className="rounded-md bg-amber-50 border border-amber-200 px-4 py-3 text-sm text-amber-700">
              30분간 활동이 없어 자동으로 로그아웃되었습니다. 다시 로그인해주세요.
            </div>
          )}
          {error && (
            <div className="rounded-md bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
              {error}
            </div>
          )}

          <div>
            <label htmlFor="email" className="mb-1 block text-sm font-medium text-gray-700">
              Email
            </label>
            <input
              id="email"
              type="email"
              autoComplete="email"
              required
              className="input"
              value={email}
              onChange={e => setEmail(e.target.value)}
            />
          </div>

          <div>
            <div className="mb-1 flex items-center justify-between">
              <label htmlFor="password" className="text-sm font-medium text-gray-700">
                Password
              </label>
              <Link
                to="/forgot-password"
                className="text-xs text-brand-600 hover:text-brand-700 hover:underline"
              >
                Forgot password?
              </Link>
            </div>
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              required
              className="input"
              value={password}
              onChange={e => setPassword(e.target.value)}
            />
          </div>

          <button type="submit" disabled={loading} className="btn-primary w-full justify-center">
            {loading ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  )
}
