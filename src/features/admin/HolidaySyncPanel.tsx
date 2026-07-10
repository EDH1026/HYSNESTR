/**
 * HolidaySyncPanel — admin 공휴일 자동 동기화 탭 (PRD v2.40 §3)
 *
 * - "동기화" 버튼 → sync-holidays Edge Function 호출 (2022 ~ 현재연도+1)
 * - 동기화 이력 표시 (holiday_sync_log 테이블)
 * - 공휴일 목록 (source 구분 표시 + 수동 추가/편집)
 */

import { useState }     from 'react'
import { RefreshCw, Plus, CheckCircle2, AlertTriangle, Info } from 'lucide-react'
import {
  useSyncHolidays, useHolidaySyncLog,
  type SyncHolidaysResult, type HolidaySyncLogRow,
} from './hooks'
import { useAllHolidays } from './hooks'
import HolidayModal       from './HolidayModal'
import type { Holiday }   from '@/types'

export default function HolidaySyncPanel() {
  const sync    = useSyncHolidays()
  const { data: syncLog = [], isLoading: logLoading } = useHolidaySyncLog()
  const { data: holidays = [], isLoading: holLoading } = useAllHolidays()

  const [lastResult, setLastResult] = useState<SyncHolidaysResult | null>(null)
  // undefined = modal closed; null = create mode; Holiday = edit mode
  const [editing, setEditing] = useState<Holiday | null | undefined>(undefined)

  async function handleSync() {
    setLastResult(null)
    try {
      const r = await sync.mutateAsync()
      setLastResult(r)
    } catch {
      // error surfaced via sync.error
    }
  }

  const lastSync = syncLog[0] as HolidaySyncLogRow | undefined

  return (
    <div className="space-y-8">

      {/* ── 사전 준비 안내 ──────────────────────────────────── */}
      <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
        <p className="font-semibold flex items-center gap-1.5">
          <Info size={12} /> 최초 1회 사전 설정 필요
        </p>
        <ol className="mt-1.5 space-y-0.5 list-decimal list-inside">
          <li>
            <a
              href="https://www.data.go.kr"
              target="_blank"
              rel="noopener noreferrer"
              className="underline"
            >
              data.go.kr
            </a>
            에서 "한국천문연구원 특일 정보" 활용신청 → 서비스키 발급
          </li>
          <li>
            Supabase 대시보드 → Edge Functions → Secrets →{' '}
            <code className="font-mono bg-amber-100 px-1 rounded">KASI_SERVICE_KEY</code> 등록
            (디코딩된 키 사용)
          </li>
          <li>
            Edge Function 배포:{' '}
            <code className="font-mono bg-amber-100 px-1 rounded">
              supabase functions deploy sync-holidays
            </code>
          </li>
        </ol>
      </div>

      {/* ── 동기화 실행 ─────────────────────────────────────── */}
      <section>
        <h2 className="text-sm font-semibold text-gray-800 mb-1">공휴일 자동 동기화</h2>
        <p className="text-xs text-muted mb-3">
          2022년부터 (현재연도+1)까지 모든 공휴일을 API에서 가져와 holidays 테이블에 반영합니다.
          음력 공휴일·대체공휴일·선거일·임시공휴일이 포함됩니다.
        </p>

        {lastSync && !sync.isPending && !lastResult && (
          <p className="text-xs text-muted mb-2">
            마지막 동기화:{' '}
            {new Date(lastSync.synced_at).toLocaleString('ko-KR')}{' '}
            — 추가 {lastSync.added}건 · 수정 {lastSync.updated}건
          </p>
        )}

        <div className="flex flex-wrap items-center gap-3">
          <button
            onClick={() => void handleSync()}
            disabled={sync.isPending}
            className="btn-primary gap-2"
          >
            <RefreshCw size={14} className={sync.isPending ? 'animate-spin' : ''} />
            {sync.isPending ? '동기화 중…' : '동기화'}
          </button>

          {lastResult && (
            <span className="flex items-center gap-1.5 text-xs text-emerald-700">
              <CheckCircle2 size={13} />
              {lastResult.isRetryMode
                ? `재시도 완료 (${lastResult.retriedMonths}개월)`
                : `${lastResult.yearCount ?? lastResult.years}개 연도`
              },{' '}
              {lastResult.added + lastResult.updated}건 동기화됨
              {' '}(추가 {lastResult.added} · 수정 {lastResult.updated} · API 총 {lastResult.total}건)
              {lastResult.errors && lastResult.errors.length > 0 && (
                <span className="text-amber-600 ml-1">
                  · 일부 월 오류 {lastResult.errors.length}건
                </span>
              )}
            </span>
          )}

          {sync.isError && (
            <span className="flex items-center gap-1.5 text-xs text-red-600">
              <AlertTriangle size={13} />
              {sync.error instanceof Error ? sync.error.message : '동기화 실패'}
            </span>
          )}
        </div>

        {/* Partial errors + retry hint */}
        {lastResult?.errors && lastResult.errors.length > 0 && (
          <div className="mt-2 rounded border border-amber-200 bg-amber-50 p-2 text-[11px] text-amber-700">
            <p className="font-semibold mb-1">
              월별 API 오류 (다른 월은 정상 처리됨) —
              동기화를 다시 누르면 아래 {lastResult.errors.length}개월만 재시도합니다
            </p>
            {lastResult.errors.map((e, i) => <p key={i}>{e}</p>)}
          </div>
        )}
      </section>

      {/* ── 동기화 이력 ─────────────────────────────────────── */}
      {!logLoading && syncLog.length > 0 && (
        <section>
          <h3 className="text-xs font-semibold text-muted uppercase tracking-wide mb-2">
            동기화 이력 (최근 10건)
          </h3>
          <div className="card p-0 overflow-hidden overflow-x-auto">
            <table className="w-full text-xs min-w-[560px]">
              <thead>
                <tr className="bg-surface-50 border-b border-border text-muted">
                  <th className="px-3 py-2 text-left font-medium">시각</th>
                  <th className="px-3 py-2 text-left font-medium">범위</th>
                  <th className="px-3 py-2 text-right font-medium">추가</th>
                  <th className="px-3 py-2 text-right font-medium">수정</th>
                  <th className="px-3 py-2 text-right font-medium">총계</th>
                  <th className="px-3 py-2 text-left font-medium">오류</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {(syncLog as HolidaySyncLogRow[]).map(row => (
                  <tr key={row.id} className={row.error ? 'bg-red-50' : 'hover:bg-surface-50'}>
                    <td className="px-3 py-2 font-mono">
                      {new Date(row.synced_at).toLocaleString('ko-KR')}
                    </td>
                    <td className="px-3 py-2">{row.year_range}</td>
                    <td className="px-3 py-2 text-right">{row.added}</td>
                    <td className="px-3 py-2 text-right">{row.updated}</td>
                    <td className="px-3 py-2 text-right">{row.total}</td>
                    <td className="px-3 py-2 text-red-600 max-w-[200px] truncate" title={row.error ?? ''}>
                      {row.error ?? '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* ── 공휴일 목록 ─────────────────────────────────────── */}
      <section>
        <div className="flex items-center justify-between mb-2">
          <div>
            <h3 className="text-xs font-semibold text-muted uppercase tracking-wide">
              공휴일 목록
            </h3>
            <p className="text-[11px] text-muted mt-0.5">
              행 클릭 시 수정 · 자동 행은 다음 동기화 시 이름이 갱신될 수 있습니다
            </p>
          </div>
          <button
            onClick={() => setEditing(null)}
            className="btn-secondary text-xs py-0.5 gap-1"
          >
            <Plus size={11} /> 수동 추가
          </button>
        </div>

        {holLoading ? (
          <p className="text-xs text-muted py-4 text-center">로딩 중…</p>
        ) : (
          <div className="card p-0 overflow-hidden overflow-x-auto">
            <table className="w-full text-xs min-w-[400px]">
              <thead>
                <tr className="bg-surface-50 border-b border-border text-muted">
                  <th className="px-3 py-2 text-left font-medium">날짜</th>
                  <th className="px-3 py-2 text-left font-medium">명칭</th>
                  <th className="px-3 py-2 text-center font-medium">반복</th>
                  <th className="px-3 py-2 text-center font-medium">구분</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {holidays.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="px-3 py-6 text-center text-muted">
                      공휴일 없음
                    </td>
                  </tr>
                ) : (
                  holidays.map(h => (
                    <tr
                      key={h.id}
                      className="hover:bg-surface-50 cursor-pointer transition-colors"
                      onClick={() => setEditing(h)}
                    >
                      <td className="px-3 py-2 font-mono">{h.date}</td>
                      <td className="px-3 py-2 font-medium text-gray-800">{h.name}</td>
                      <td className="px-3 py-2 text-center text-muted">
                        {h.recurring ? '매년' : '—'}
                      </td>
                      <td className="px-3 py-2 text-center">
                        {h.source === 'auto'
                          ? <span className="pill bg-blue-100 text-blue-700 text-[10px]">자동</span>
                          : <span className="pill bg-emerald-100 text-emerald-700 text-[10px]">수동</span>
                        }
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* HolidayModal — create (editing === null) or edit (editing is a Holiday) */}
      {editing !== undefined && (
        <HolidayModal
          holiday={editing ?? undefined}
          readOnly={false}
          onClose={() => setEditing(undefined)}
        />
      )}
    </div>
  )
}
