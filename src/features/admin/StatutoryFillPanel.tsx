/**
 * StatutoryFillPanel — 법정연차 자동 적립 배치 (PRD v2.28 §5.13 AL-2)
 *
 * fill-statutory-leave Edge Function 을 수동 트리거한다.
 * - anchorDate 를 지정해 소급 실행 가능 (2026-07-01 최초 적용 등)
 * - pg_cron 설정 전까지는 이 버튼으로 매년 7/1 이후 수동 실행
 */
import { useState } from 'react'
import { CalendarClock, CheckCircle2, AlertTriangle, Info } from 'lucide-react'
import { useFillStatutoryLeave, type FillStatutoryLeaveResult } from './adminHooks'

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

export default function StatutoryFillPanel() {
  const fill        = useFillStatutoryLeave()
  const [date, setDate]         = useState(today())
  const [lastResult, setResult] = useState<FillStatutoryLeaveResult | null>(null)

  async function handleFill() {
    if (!window.confirm(
      `${date} 기준으로 전 인력의 법정연차를 자동 계산합니다.\n` +
      `기존 "근로기준법 자동계산" 비고 행은 삭제 후 재생성됩니다.\n` +
      `수동 보정 행은 유지됩니다. 계속할까요?`,
    )) return
    setResult(null)
    try {
      const r = await fill.mutateAsync(date)
      setResult(r)
    } catch {
      // error via fill.error
    }
  }

  return (
    <div className="space-y-8">

      {/* ── 안내 ─────────────────────────────────────────────── */}
      <div className="rounded-md border border-blue-200 bg-blue-50 p-3 text-xs text-blue-800">
        <p className="font-semibold flex items-center gap-1.5">
          <Info size={12} /> 법정연차 자동 적립 안내
        </p>
        <ul className="mt-1.5 space-y-0.5 list-disc list-inside">
          <li>회계연도 7월 1일 기준으로 근로기준법 제60조 법정연차를 계산합니다.</li>
          <li>hire_date 가 있는 전 인력(재직·입사예정·퇴사 포함)에 대해 실행됩니다.</li>
          <li>기존 <code className="font-mono bg-blue-100 px-1 rounded">근로기준법 자동계산</code> 비고 행만 재생성되며, 수동 보정은 유지됩니다.</li>
          <li>배포 후 최초 1회: <strong>2026-07-01</strong>로 설정 후 실행하세요 (소급 적용).</li>
          <li>이후 매년 7/1: 해당일 이후 이 버튼을 클릭하거나 pg_cron 을 설정하세요.</li>
        </ul>
      </div>

      {/* ── 실행 ─────────────────────────────────────────────── */}
      <section>
        <h2 className="text-sm font-semibold text-gray-800 mb-1">법정연차 자동 계산 실행</h2>
        <p className="text-xs text-muted mb-3">
          기준일을 선택하고 실행하면 해당 날짜까지 발생한 법정연차가 자동 입력됩니다.
        </p>

        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <label className="text-xs font-medium text-gray-700">기준일</label>
            <input
              type="date"
              value={date}
              onChange={e => setDate(e.target.value)}
              className="input py-1 text-xs w-36"
            />
          </div>
          <button
            onClick={() => void handleFill()}
            disabled={fill.isPending}
            className="btn-primary gap-2"
          >
            <CalendarClock size={14} className={fill.isPending ? 'animate-pulse' : ''} />
            {fill.isPending ? '실행 중…' : '법정연차 자동 적립'}
          </button>
        </div>

        {lastResult && (
          <div className="mt-3 flex items-start gap-1.5 text-xs text-emerald-700">
            <CheckCircle2 size={13} className="flex-shrink-0 mt-0.5" />
            <span>
              완료 ({lastResult.anchorDate} 기준):
              인원 {lastResult.people}명 · 적립 행 {lastResult.inserted}건 생성됨
              {lastResult.errors && lastResult.errors.length > 0 && (
                <span className="text-amber-600 ml-1">
                  · 일부 오류 {lastResult.errors.length}건
                </span>
              )}
            </span>
          </div>
        )}

        {fill.isError && (
          <div className="mt-3 flex items-start gap-1.5 text-xs text-red-600">
            <AlertTriangle size={13} className="flex-shrink-0 mt-0.5" />
            <span>
              {fill.error instanceof Error ? fill.error.message : '실행 실패'}
            </span>
          </div>
        )}

        {lastResult?.errors && lastResult.errors.length > 0 && (
          <div className="mt-2 rounded border border-amber-200 bg-amber-50 p-2 text-[11px] text-amber-700">
            <p className="font-semibold mb-1">인원별 오류</p>
            {lastResult.errors.map((e, i) => <p key={i}>{e}</p>)}
          </div>
        )}
      </section>

      {/* ── pg_cron 안내 ─────────────────────────────────────── */}
      <section>
        <h3 className="text-xs font-semibold text-muted uppercase tracking-wide mb-2">
          pg_cron 자동 스케줄 설정 (선택)
        </h3>
        <div className="rounded border border-border bg-surface-50 p-3 text-xs text-muted space-y-1.5">
          <p>Supabase Dashboard → Database → Extensions 에서 <strong>pg_cron</strong>·<strong>pg_net</strong> 활성화 후 아래 SQL 실행:</p>
          <pre className="bg-surface-100 rounded p-2 text-[11px] font-mono overflow-x-auto whitespace-pre-wrap">{`-- 매년 7/1 00:00 UTC (09:00 KST) 자동 실행
ALTER DATABASE postgres
  SET app.supabase_url = 'https://YOUR_PROJECT.supabase.co';
ALTER DATABASE postgres
  SET app.service_role_key = 'YOUR_SERVICE_ROLE_KEY';

SELECT cron.schedule(
  'fill-statutory-leave-annual',
  '0 0 1 7 *',
  $$SELECT net.http_post(
      url     := current_setting('app.supabase_url')
                 || '/functions/v1/fill-statutory-leave',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer '
          || current_setting('app.service_role_key')
      ),
      body    := '{"anchorDate":"auto"}'::jsonb
    )$$
);`}</pre>
          <p className="text-[10px]">
            Edge Function 배포: <code className="font-mono bg-surface-100 px-1 rounded">supabase functions deploy fill-statutory-leave</code>
          </p>
        </div>
      </section>
    </div>
  )
}
