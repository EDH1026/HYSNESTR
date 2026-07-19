import { useEffect, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { KeyRound } from 'lucide-react'
import { supabase } from '@/lib/supabase'

type Status = 'checking' | 'ready' | 'saving' | 'done' | 'invalid'

// Supabase's raw auth error text (expired/reused link, stale session, etc.) is not
// user-friendly. Map the recognizable cases to plain language; pass through anything else.
function friendlyAuthError(message: string): string {
  const m = message.toLowerCase()
  if (m.includes('session') || m.includes('expired') || m.includes('token') || m.includes('jwt')) {
    return 'This link has expired or has already been used. Please request a new invitation or reset link.'
  }
  return message
}

export default function ResetPasswordPage() {
  const navigate = useNavigate()

  const [status,   setStatus]   = useState<Status>('checking')
  const [password, setPassword] = useState('')
  const [confirm,  setConfirm]  = useState('')
  const [error,    setError]    = useState<string | null>(null)

  // ── Detect recovery session ────────────────────────────────
  // Supabase processes the #access_token from the reset-link URL and fires
  // PASSWORD_RECOVERY via onAuthStateChange. We also fall back to checking
  // whether a session already exists (handles the race where the event fired
  // before this component mounted).
  useEffect(() => {
    let cleanup: (() => void) | undefined

    const run = async () => {
      // Fast path: session already established by the Supabase client
      const { data: { session } } = await supabase.auth.getSession()
      if (session) {
        setStatus('ready')
        return
      }

      // Slow path: wait for the PASSWORD_RECOVERY event
      const { data: { subscription } } = supabase.auth.onAuthStateChange((event) => {
        if (event === 'PASSWORD_RECOVERY' || event === 'SIGNED_IN') {
          setStatus('ready')
        }
      })

      // Guard: if no recovery event arrives in 4 s, the link is invalid/expired
      const timer = window.setTimeout(() => {
        setStatus(s => s === 'checking' ? 'invalid' : s)
      }, 4000)

      cleanup = () => {
        subscription.unsubscribe()
        clearTimeout(timer)
      }
    }

    run()
    return () => cleanup?.()
  }, [])

  // ── Submit new password ────────────────────────────────────
  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)

    if (password !== confirm) {
      setError('Passwords do not match.')
      return
    }
    if (password.length < 8) {
      setError('Password must be at least 8 characters.')
      return
    }

    setStatus('saving')

    const { error: pwError } = await supabase.auth.updateUser({ password })
    if (pwError) {
      setError(friendlyAuthError(pwError.message))
      setStatus('ready')
      return
    }

    // PRD v2.97 ADM-10: clears profiles.must_set_password for invited accounts.
    // This is the only path allowed to flip that flag (RLS blocks a plain UPDATE).
    // Idempotent/harmless for accounts that weren't invited (flag already false).
    // Cast: RPC not yet in generated database.ts (see src/types/database.ts regen note in CLAUDE.md)
    const { error: rpcError } = await (supabase.rpc as any)('complete_password_setup')
    if (rpcError) {
      setError('Password was saved, but finishing setup failed. Please try again.')
      setStatus('ready')
      return
    }

    setStatus('done')

    // Sign out so the user logs in fresh with the new password
    await supabase.auth.signOut()
    navigate('/login', { replace: true })
  }

  // ── Render ─────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-surface-50 flex items-center justify-center p-4">
      <div className="card w-full max-w-sm p-8">

        {status === 'checking' && (
          <div className="flex flex-col items-center gap-4 py-4">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-brand-600 border-t-transparent" />
            <p className="text-sm text-muted">Verifying reset link…</p>
          </div>
        )}

        {status === 'invalid' && (
          <div className="text-center">
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-red-100">
              <KeyRound size={22} className="text-red-500" />
            </div>
            <h1 className="text-lg font-semibold text-gray-900">Link expired or invalid</h1>
            <p className="mt-2 text-sm text-muted">
              This password reset link has expired or already been used.
            </p>
            <a href="/forgot-password" className="btn-primary mt-6 inline-flex justify-center w-full">
              Request a new link
            </a>
          </div>
        )}

        {(status === 'ready' || status === 'saving') && (
          <>
            <div className="mb-6 text-center">
              <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-brand-600 text-white">
                <KeyRound size={22} />
              </div>
              <h1 className="text-xl font-semibold text-gray-900">Set new password</h1>
              <p className="mt-1 text-sm text-muted">
                Choose a strong password for your account.
              </p>
            </div>

            <form onSubmit={handleSubmit} className="space-y-4">
              {error && (
                <div className="rounded-md bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
                  {error}
                </div>
              )}

              <div>
                <label htmlFor="password" className="mb-1 block text-sm font-medium text-gray-700">
                  New password
                </label>
                <input
                  id="password"
                  type="password"
                  autoComplete="new-password"
                  required
                  minLength={8}
                  className="input"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                />
              </div>

              <div>
                <label htmlFor="confirm" className="mb-1 block text-sm font-medium text-gray-700">
                  Confirm password
                </label>
                <input
                  id="confirm"
                  type="password"
                  autoComplete="new-password"
                  required
                  className="input"
                  value={confirm}
                  onChange={e => setConfirm(e.target.value)}
                />
              </div>

              <button
                type="submit"
                disabled={status === 'saving'}
                className="btn-primary w-full justify-center"
              >
                {status === 'saving' ? 'Saving…' : 'Set new password'}
              </button>
            </form>
          </>
        )}

        {status === 'done' && (
          <div className="flex flex-col items-center gap-4 py-4">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-brand-600 border-t-transparent" />
            <p className="text-sm text-muted">Password updated. Redirecting…</p>
          </div>
        )}

      </div>
    </div>
  )
}
