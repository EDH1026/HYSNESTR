import { useEffect, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { ShieldCheck, Loader2 } from 'lucide-react'
import { supabase } from '@/lib/supabase'

type Status = 'checking' | 'ready' | 'verifying' | 'nofactor'

export default function MfaChallengePage() {
  const navigate = useNavigate()

  const [status,  setStatus]  = useState<Status>('checking')
  const [factorId, setFactorId] = useState<string | null>(null)
  const [code,    setCode]    = useState('')
  const [error,   setError]   = useState<string | null>(null)

  // ── Resolve whether this session actually needs a TOTP challenge ──────
  useEffect(() => {
    let cancelled = false

    async function run() {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { navigate('/login', { replace: true }); return }

      const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel()
      if (!aal || aal.currentLevel === aal.nextLevel) {
        // Already satisfied (or no factor enrolled) — nothing to do here.
        navigate('/', { replace: true })
        return
      }

      const { data: factors, error: listErr } = await supabase.auth.mfa.listFactors()
      const verified = factors?.totp.find(f => f.status === 'verified')
      if (cancelled) return
      if (listErr || !verified) {
        setStatus('nofactor')
        return
      }
      setFactorId(verified.id)
      setStatus('ready')
    }

    run()
    return () => { cancelled = true }
  }, [navigate])

  // ── Submit code ─────────────────────────────────────────────
  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (!factorId) return
    setError(null)
    setStatus('verifying')

    const { data: challenge, error: challengeErr } = await supabase.auth.mfa.challenge({ factorId })
    if (challengeErr || !challenge) {
      setError(challengeErr?.message ?? '인증 요청에 실패했습니다.')
      setStatus('ready')
      return
    }

    const { error: verifyErr } = await supabase.auth.mfa.verify({
      factorId,
      challengeId: challenge.id,
      code:        code.trim(),
    })
    if (verifyErr) {
      setError('코드가 올바르지 않습니다. 다시 시도해주세요.')
      setCode('')
      setStatus('ready')
      return
    }

    // AuthContext's onAuthStateChange picks up MFA_CHALLENGE_VERIFIED and refreshes state.
    navigate('/', { replace: true })
  }

  async function handleSignOut() {
    await supabase.auth.signOut()
    navigate('/login', { replace: true })
  }

  return (
    <div className="min-h-screen bg-surface-50 flex items-center justify-center p-4">
      <div className="card w-full max-w-sm p-8">

        {status === 'checking' && (
          <div className="flex flex-col items-center gap-4 py-4">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-brand-600 border-t-transparent" />
            <p className="text-sm text-muted">확인 중…</p>
          </div>
        )}

        {status === 'nofactor' && (
          <div className="text-center">
            <p className="text-sm text-gray-600">
              2단계 인증 확인 중 문제가 발생했습니다. 다시 로그인해주세요.
            </p>
            <button onClick={handleSignOut} className="btn-secondary mt-6 w-full">
              로그아웃
            </button>
          </div>
        )}

        {(status === 'ready' || status === 'verifying') && (
          <>
            <div className="mb-6 text-center">
              <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-brand-600 text-white">
                <ShieldCheck size={22} />
              </div>
              <h1 className="text-xl font-semibold text-gray-900">2단계 인증</h1>
              <p className="mt-1 text-sm text-muted">
                인증 앱에 표시된 6자리 코드를 입력해주세요.
              </p>
            </div>

            <form onSubmit={handleSubmit} className="space-y-4">
              {error && (
                <div className="rounded-md bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
                  {error}
                </div>
              )}

              <div>
                <label htmlFor="totp-code" className="mb-1 block text-sm font-medium text-gray-700">
                  인증 코드
                </label>
                <input
                  id="totp-code"
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  autoFocus
                  required
                  maxLength={6}
                  pattern="[0-9]{6}"
                  className="input text-center text-lg tracking-[0.5em]"
                  placeholder="000000"
                  value={code}
                  onChange={e => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  disabled={status === 'verifying'}
                />
              </div>

              <button
                type="submit"
                disabled={status === 'verifying' || code.length !== 6}
                className="btn-primary w-full justify-center gap-1.5"
              >
                {status === 'verifying' ? <Loader2 size={14} className="animate-spin" /> : null}
                {status === 'verifying' ? '확인 중…' : '확인'}
              </button>

              <button type="button" onClick={handleSignOut} className="text-xs text-muted hover:text-gray-600 w-full text-center">
                다른 계정으로 로그인
              </button>
            </form>
          </>
        )}

      </div>
    </div>
  )
}
