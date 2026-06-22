import { useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { ArrowLeft, MailCheck } from 'lucide-react'
import { supabase } from '@/lib/supabase'

export default function ForgotPasswordPage() {
  const [email,   setEmail]   = useState('')
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState<string | null>(null)
  const [sent,    setSent]    = useState(false)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setLoading(true)

    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      // Supabase redirects here after the user clicks the link in the email.
      // Add this URL to the "Redirect URLs" allowlist in
      // Supabase Dashboard → Authentication → URL Configuration.
      redirectTo: `${window.location.origin}/reset-password`,
    })

    setLoading(false)

    if (error) {
      setError(error.message)
    } else {
      setSent(true)
    }
  }

  return (
    <div className="min-h-screen bg-surface-50 flex items-center justify-center p-4">
      <div className="card w-full max-w-sm p-8">

        {/* Back link */}
        <Link
          to="/login"
          className="mb-6 flex items-center gap-1.5 text-sm text-muted hover:text-gray-900 transition-colors"
        >
          <ArrowLeft size={14} />
          Back to sign in
        </Link>

        {sent ? (
          /* ── Success state ─────────────────────────────────── */
          <div className="text-center">
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-green-100">
              <MailCheck size={24} className="text-green-600" />
            </div>
            <h1 className="text-lg font-semibold text-gray-900">Check your email</h1>
            <p className="mt-2 text-sm text-muted">
              If <strong>{email}</strong> has an account, you'll receive a password reset link
              shortly. Check your spam folder if you don't see it.
            </p>
            <Link to="/login" className="btn-secondary mt-6 inline-flex justify-center w-full">
              Back to sign in
            </Link>
          </div>
        ) : (
          /* ── Request form ──────────────────────────────────── */
          <>
            <div className="mb-6 text-center">
              <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-brand-600 text-white font-bold text-lg">
                W
              </div>
              <h1 className="text-xl font-semibold text-gray-900">Reset your password</h1>
              <p className="mt-1 text-sm text-muted">
                Enter your email and we'll send you a reset link.
              </p>
            </div>

            <form onSubmit={handleSubmit} className="space-y-4">
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

              <button type="submit" disabled={loading} className="btn-primary w-full justify-center">
                {loading ? 'Sending…' : 'Send reset link'}
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  )
}
