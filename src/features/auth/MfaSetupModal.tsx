/**
 * MfaSetupModal — self-service TOTP (2단계 인증) enrollment for the signed-in user.
 *
 * Uses Supabase Auth's built-in MFA API directly (no custom table/RPC needed —
 * Supabase stores factors in its own auth schema). Flow:
 *   1. listFactors() → if a verified TOTP factor exists, show status + 해제.
 *   2. Otherwise, enroll({factorType:'totp'}) → render QR + secret, ask for a
 *      6-digit code, then challenge()+verify() to confirm the factor is real.
 *   3. Any stale *unverified* factor from an abandoned attempt is cleaned up
 *      before starting a fresh enrollment (Supabase won't reuse it).
 */
import { useEffect, useState } from 'react'
import { Loader2, ShieldCheck, ShieldOff } from 'lucide-react'
import Modal from '@/components/Modal'
import { supabase } from '@/lib/supabase'

type Step = 'loading' | 'enrolled' | 'start' | 'enrolling' | 'unenrolling' | 'error'

interface EnrollData {
  factorId: string
  qrCode:   string   // data: URI, ready for <img src>
  secret:   string   // manual-entry fallback
}

interface Props {
  onClose: () => void
}

export default function MfaSetupModal({ onClose }: Props) {
  const [step,          setStep]          = useState<Step>('loading')
  const [enrollData,    setEnrollData]    = useState<EnrollData | null>(null)
  const [enrolledId,    setEnrolledId]    = useState<string | null>(null)
  const [code,          setCode]          = useState('')
  const [busy,          setBusy]          = useState(false)
  const [err,           setErr]           = useState<string | null>(null)

  // ── Load current factor state ─────────────────────────────────
  async function refreshFactors() {
    setStep('loading')
    setErr(null)
    const { data, error } = await supabase.auth.mfa.listFactors()
    if (error) { setErr(error.message); setStep('error'); return }

    const verified = data.totp.find(f => f.status === 'verified')
    if (verified) { setEnrolledId(verified.id); setStep('enrolled'); return }

    // data.totp is pre-filtered to verified-only by the SDK's types — unverified
    // (abandoned) attempts only show up in data.all, keyed by factor_type. Clean
    // those up so a fresh enroll() isn't blocked by a leftover pending factor.
    const stale = data.all.filter(f => f.factor_type === 'totp' && f.status === 'unverified')
    for (const f of stale) {
      await supabase.auth.mfa.unenroll({ factorId: f.id })
    }
    setStep('start')
  }

  useEffect(() => { refreshFactors() }, [])

  // ── Start enrollment ────────────────────────────────────────
  async function handleStartEnroll() {
    setBusy(true)
    setErr(null)
    const { data, error } = await supabase.auth.mfa.enroll({ factorType: 'totp' })
    setBusy(false)
    if (error || !data.totp) { setErr(error?.message ?? '등록을 시작하지 못했습니다.'); return }
    setEnrollData({ factorId: data.id, qrCode: data.totp.qr_code, secret: data.totp.secret })
    setCode('')
    setStep('enrolling')
  }

  // ── Confirm enrollment with a TOTP code ────────────────────
  async function handleVerify() {
    if (!enrollData) return
    setBusy(true)
    setErr(null)
    const { data: challenge, error: challengeErr } = await supabase.auth.mfa.challenge({ factorId: enrollData.factorId })
    if (challengeErr || !challenge) {
      setBusy(false)
      setErr(challengeErr?.message ?? '인증 요청에 실패했습니다.')
      return
    }
    const { error: verifyErr } = await supabase.auth.mfa.verify({
      factorId:    enrollData.factorId,
      challengeId: challenge.id,
      code:        code.trim(),
    })
    setBusy(false)
    if (verifyErr) {
      setErr('코드가 올바르지 않습니다. 다시 확인해주세요.')
      setCode('')
      return
    }
    setEnrollData(null)
    setStep('enrolled')
  }

  // ── Remove the enrolled factor ─────────────────────────────
  // Requires re-proving possession of the authenticator (a fresh TOTP code) before
  // unenrolling — otherwise a hijacked aal1 session could silently strip 2FA off an
  // account without ever having had the authenticator app in hand.
  function handleStartUnenroll() {
    setCode('')
    setErr(null)
    setStep('unenrolling')
  }

  async function handleConfirmUnenroll() {
    if (!enrolledId) return
    setBusy(true)
    setErr(null)
    const { data: challenge, error: challengeErr } = await supabase.auth.mfa.challenge({ factorId: enrolledId })
    if (challengeErr || !challenge) {
      setBusy(false)
      setErr(challengeErr?.message ?? '인증 요청에 실패했습니다.')
      return
    }
    const { error: verifyErr } = await supabase.auth.mfa.verify({
      factorId:    enrolledId,
      challengeId: challenge.id,
      code:        code.trim(),
    })
    if (verifyErr) {
      setBusy(false)
      setErr('코드가 올바르지 않습니다. 다시 확인해주세요.')
      setCode('')
      return
    }
    const { error: unenrollErr } = await supabase.auth.mfa.unenroll({ factorId: enrolledId })
    if (unenrollErr) {
      setBusy(false)
      setErr(unenrollErr.message)
      return
    }
    // MFA is mandatory, not opt-in — reload so AuthContext re-derives mfaSetupRequired
    // from scratch and AuthGuard immediately routes to the mandatory /mfa-setup instead
    // of leaving this session sitting unprotected until the next natural page load.
    window.location.reload()
  }

  async function handleCancelEnrolling() {
    if (enrollData) await supabase.auth.mfa.unenroll({ factorId: enrollData.factorId })
    setEnrollData(null)
    setCode('')
    setErr(null)
    setStep('start')
  }

  return (
    <Modal title="2단계 인증 (TOTP)" onClose={onClose} size="sm">
      {step === 'loading' && (
        <div className="flex flex-col items-center gap-3 py-6">
          <Loader2 size={20} className="animate-spin text-brand-600" />
        </div>
      )}

      {step === 'error' && (
        <div className="space-y-3">
          <p className="text-sm text-red-600">{err ?? '상태를 불러오지 못했습니다.'}</p>
          <button onClick={refreshFactors} className="btn-secondary w-full text-xs">다시 시도</button>
        </div>
      )}

      {step === 'enrolled' && (
        <div className="space-y-4">
          <div className="flex items-center gap-3 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-3">
            <ShieldCheck size={20} className="text-emerald-600 flex-shrink-0" />
            <div className="text-sm text-emerald-800">
              <p className="font-semibold">2단계 인증이 등록되어 있습니다.</p>
              <p className="text-xs mt-0.5">다음 로그인부터 인증 앱의 코드를 추가로 입력하게 됩니다.</p>
            </div>
          </div>
          {err && <p className="text-xs text-red-600">{err}</p>}
          <button
            onClick={handleStartUnenroll}
            disabled={busy}
            className="btn-secondary w-full text-xs gap-1.5 text-red-600 hover:bg-red-50"
          >
            <ShieldOff size={13} />
            2단계 인증 해제
          </button>
        </div>
      )}

      {step === 'unenrolling' && (
        <div className="space-y-4">
          <p className="text-sm text-gray-600">
            해제하려면 본인임을 다시 확인해야 합니다. 인증 앱의 현재 코드를 입력해주세요.
          </p>

          <div>
            <label htmlFor="mfa-unenroll-code" className="mb-1 block text-xs font-medium text-gray-700">
              인증 앱에 표시된 6자리 코드
            </label>
            <input
              id="mfa-unenroll-code"
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
              disabled={busy}
            />
          </div>

          {err && <p className="text-xs text-red-600">{err}</p>}

          <div className="flex gap-2">
            <button
              onClick={handleConfirmUnenroll}
              disabled={busy || code.length !== 6}
              className="flex-1 py-2 text-xs font-semibold bg-red-600 text-white rounded-md hover:bg-red-700 transition-colors disabled:opacity-40"
            >
              {busy && <Loader2 size={13} className="animate-spin inline mr-1" />}
              확인 후 해제
            </button>
            <button
              onClick={() => { setStep('enrolled'); setErr(null); setCode('') }}
              disabled={busy}
              className="btn-secondary text-xs"
            >
              취소
            </button>
          </div>
        </div>
      )}

      {step === 'start' && (
        <div className="space-y-4">
          <p className="text-sm text-gray-600">
            Google Authenticator, Microsoft Authenticator, Authy 등 아무 OTP 인증 앱이나 사용할 수 있습니다.
            등록하면 다음 로그인부터 비밀번호 확인 후 6자리 코드를 추가로 입력합니다.
          </p>
          {err && <p className="text-xs text-red-600">{err}</p>}
          <button onClick={handleStartEnroll} disabled={busy} className="btn-primary w-full gap-1.5 text-xs">
            {busy && <Loader2 size={13} className="animate-spin" />}
            등록 시작
          </button>
        </div>
      )}

      {step === 'enrolling' && enrollData && (
        <div className="space-y-4">
          <div className="flex flex-col items-center gap-2">
            <img src={enrollData.qrCode} alt="TOTP QR 코드" className="h-40 w-40 rounded border border-border" />
            <p className="text-[11px] text-muted">스캔이 안 되면 아래 코드를 앱에 직접 입력하세요.</p>
            <code className="rounded bg-surface-100 px-2 py-1 text-[11px] font-mono break-all text-center">
              {enrollData.secret}
            </code>
          </div>

          <div>
            <label htmlFor="mfa-verify-code" className="mb-1 block text-xs font-medium text-gray-700">
              인증 앱에 표시된 6자리 코드
            </label>
            <input
              id="mfa-verify-code"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              pattern="[0-9]{6}"
              className="input text-center text-lg tracking-[0.5em]"
              placeholder="000000"
              value={code}
              onChange={e => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              disabled={busy}
            />
          </div>

          {err && <p className="text-xs text-red-600">{err}</p>}

          <div className="flex gap-2">
            <button
              onClick={handleVerify}
              disabled={busy || code.length !== 6}
              className="btn-primary flex-1 gap-1.5 text-xs"
            >
              {busy && <Loader2 size={13} className="animate-spin" />}
              확인 및 등록 완료
            </button>
            <button onClick={handleCancelEnrolling} disabled={busy} className="btn-secondary text-xs">
              취소
            </button>
          </div>
        </div>
      )}
    </Modal>
  )
}
