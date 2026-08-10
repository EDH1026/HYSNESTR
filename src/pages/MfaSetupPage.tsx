/**
 * MfaSetupPage — mandatory TOTP enrollment (/mfa-setup).
 *
 * MFA is required for every account, not opt-in: AuthGuard routes any session
 * with no verified TOTP factor here, with no skip/cancel — data access is
 * blocked (server-side, see the app_can()/my_role()/is_admin()/is_assistant()
 * mfa_satisfied() gate) until enrollment is completed. Enrollment auto-starts
 * on mount; the only escape is signing out (e.g. wrong account).
 */
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ShieldCheck, Loader2 } from 'lucide-react'
import { supabase } from '@/lib/supabase'

type Status = 'checking' | 'starting' | 'enrolling' | 'verifying' | 'error'

export default function MfaSetupPage() {
  const navigate = useNavigate()

  const [status,   setStatus]   = useState<Status>('checking')
  const [factorId, setFactorId] = useState<string | null>(null)
  const [qrCode,   setQrCode]   = useState<string | null>(null)
  const [secret,   setSecret]   = useState<string | null>(null)
  const [code,     setCode]     = useState('')
  const [err,      setErr]      = useState<string | null>(null)

  const startedRef = useRef(false)

  useEffect(() => {
    // React 18 StrictMode double-invokes effects in dev — without this guard,
    // two concurrent enroll() calls would race and orphan one factor before
    // the stale-cleanup on the next mount ever runs.
    if (startedRef.current) return
    startedRef.current = true

    let cancelled = false

    async function run() {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { navigate('/login', { replace: true }); return }

      const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel()
      if (aal && aal.nextLevel === 'aal2') {
        // Already has a verified factor (e.g. reached this page via a stale link) —
        // let AuthGuard route to /mfa-challenge or straight into the app instead.
        navigate('/', { replace: true })
        return
      }

      // Clean up any abandoned unverified attempt so enroll() below isn't blocked.
      const { data: factors } = await supabase.auth.mfa.listFactors()
      const stale = factors?.all.filter(f => f.factor_type === 'totp' && f.status === 'unverified') ?? []
      for (const f of stale) await supabase.auth.mfa.unenroll({ factorId: f.id })
      if (cancelled) return

      setStatus('starting')
      const { data: enrolled, error: enrollErr } = await supabase.auth.mfa.enroll({ factorType: 'totp' })
      if (cancelled) return
      if (enrollErr || !enrolled.totp) {
        setErr(enrollErr?.message ?? '등록을 시작하지 못했습니다.')
        setStatus('error')
        return
      }
      setFactorId(enrolled.id)
      setQrCode(enrolled.totp.qr_code)
      setSecret(enrolled.totp.secret)
      setStatus('enrolling')
    }

    run()
    return () => { cancelled = true }
  }, [navigate])

  async function handleSubmit() {
    if (!factorId) return
    setErr(null)
    setStatus('verifying')

    const { data: challenge, error: challengeErr } = await supabase.auth.mfa.challenge({ factorId })
    if (challengeErr || !challenge) {
      setErr(challengeErr?.message ?? '인증 요청에 실패했습니다.')
      setStatus('enrolling')
      return
    }
    const { error: verifyErr } = await supabase.auth.mfa.verify({
      factorId,
      challengeId: challenge.id,
      code:        code.trim(),
    })
    if (verifyErr) {
      setErr('코드가 올바르지 않습니다. 다시 시도해주세요.')
      setCode('')
      setStatus('enrolling')
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

        {(status === 'checking' || status === 'starting') && (
          <div className="flex flex-col items-center gap-4 py-4">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-brand-600 border-t-transparent" />
            <p className="text-sm text-muted">2단계 인증 등록을 준비하고 있습니다…</p>
          </div>
        )}

        {status === 'error' && (
          <div className="text-center">
            <p className="text-sm text-red-600">{err}</p>
            <button onClick={handleSignOut} className="btn-secondary mt-6 w-full">로그아웃</button>
          </div>
        )}

        {(status === 'enrolling' || status === 'verifying') && qrCode && secret && (
          <>
            <div className="mb-6 text-center">
              <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-brand-600 text-white">
                <ShieldCheck size={22} />
              </div>
              <h1 className="text-xl font-semibold text-gray-900">2단계 인증 등록</h1>
              <p className="mt-1 text-sm text-muted">
                이 계정은 2단계 인증(TOTP) 등록이 필요합니다.<br />
                Google Authenticator 등 인증 앱으로 아래 QR코드를 스캔해주세요.
              </p>
            </div>

            <div className="flex flex-col items-center gap-2 mb-4">
              <img src={qrCode} alt="TOTP QR 코드" className="h-40 w-40 rounded border border-border" />
              <p className="text-[11px] text-muted">스캔이 안 되면 아래 코드를 앱에 직접 입력하세요.</p>
              <code className="rounded bg-surface-100 px-2 py-1 text-[11px] font-mono break-all text-center">
                {secret}
              </code>
            </div>

            <div className="space-y-4">
              {err && (
                <div className="rounded-md bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
                  {err}
                </div>
              )}

              <div>
                <label htmlFor="mfa-setup-code" className="mb-1 block text-sm font-medium text-gray-700">
                  인증 앱에 표시된 6자리 코드
                </label>
                <input
                  id="mfa-setup-code"
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  autoFocus
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
                onClick={handleSubmit}
                disabled={status === 'verifying' || code.length !== 6}
                className="btn-primary w-full justify-center gap-1.5"
              >
                {status === 'verifying' ? <Loader2 size={14} className="animate-spin" /> : null}
                {status === 'verifying' ? '확인 중…' : '확인 및 등록 완료'}
              </button>

              <button type="button" onClick={handleSignOut} className="text-xs text-muted hover:text-gray-600 w-full text-center">
                다른 계정으로 로그인
              </button>
            </div>
          </>
        )}

      </div>
    </div>
  )
}
