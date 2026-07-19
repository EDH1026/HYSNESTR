/**
 * BulkStatusPanel — PRD v2.89 일괄 상태 전환 (Admin 전용)
 *
 * 종료일(end_date) 범위 기준으로 작업항목·휴가 배정을 일괄 Closed/Open 전환.
 * 서버 RPC: bulk_status_preview (미리보기) → bulk_status_transition (실행).
 * audit_log는 서버에서 기록 (클라이언트 직접 INSERT 불가).
 */
import { useState } from 'react'
import { Info, Lock, Unlock, Eye, AlertTriangle, CheckCircle2 } from 'lucide-react'
import { today, addMonths, numToStr } from '@/lib/date'
import {
  useBulkStatusPreview,
  useBulkStatusTransition,
  type BulkStatusPreviewResult,
  type BulkStatusTransitionResult,
} from './adminHooks'

// ADM-9① v2.94: default range prefill — 2008-01-01 (fixed anchor) ~ 오늘−2개월 (render-time calc)
const DEFAULT_FROM = '2008-01-01'
function defaultToDate(): string {
  return numToStr(addMonths(today(), -2))
}

interface ConfirmModalProps {
  preview:   BulkStatusPreviewResult
  params:    { from: string; to: string }
  executing: boolean
  onConfirm: () => void
  onCancel:  () => void
}

function ConfirmModal({ preview, params, executing, onConfirm, onCancel }: ConfirmModalProps) {
  const dirLabel = preview.direction === 'close' ? 'Closed로 잠금' : 'Open으로 해제'
  const total    = preview.work_items + preview.leave_assignments
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="bg-white rounded-xl shadow-2xl border border-border w-full max-w-md mx-4 overflow-hidden">
        <div className="px-5 py-4 border-b border-border flex items-center gap-2">
          {preview.direction === 'close'
            ? <Lock size={15} className="text-amber-600" />
            : <Unlock size={15} className="text-emerald-600" />}
          <h2 className="text-sm font-semibold text-gray-900">일괄 상태 전환 확인</h2>
        </div>

        <div className="px-5 py-4 space-y-3">
          <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
            <p className="font-semibold">다음 항목을 <span className="font-bold">{dirLabel}</span> 처리합니다.</p>
            <p className="mt-1">이 작업은 되돌릴 수 없습니다 (개별 Open 전환 필요).</p>
          </div>

          <table className="w-full text-sm border border-border rounded-md overflow-hidden">
            <thead>
              <tr className="bg-surface-50 text-xs text-muted border-b border-border">
                <th className="px-3 py-2 text-left font-medium">항목</th>
                <th className="px-3 py-2 text-right font-medium">대상 건수</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              <tr>
                <td className="px-3 py-2 text-gray-700">종료일 범위</td>
                <td className="px-3 py-2 text-right text-gray-700 font-mono text-xs">
                  {params.from} ~ {params.to}
                </td>
              </tr>
              {preview.work_items > 0 && (
                <tr>
                  <td className="px-3 py-2 text-gray-700">작업항목 (work_items)</td>
                  <td className="px-3 py-2 text-right font-semibold text-gray-900">
                    {preview.work_items.toLocaleString()}건
                  </td>
                </tr>
              )}
              {preview.leave_assignments > 0 && (
                <tr>
                  <td className="px-3 py-2 text-gray-700">휴가 배정 (assignments)</td>
                  <td className="px-3 py-2 text-right font-semibold text-gray-900">
                    {preview.leave_assignments.toLocaleString()}건
                  </td>
                </tr>
              )}
              <tr className="bg-surface-50">
                <td className="px-3 py-2 font-semibold text-gray-800">합계</td>
                <td className="px-3 py-2 text-right font-bold text-gray-900">
                  {total.toLocaleString()}건
                </td>
              </tr>
            </tbody>
          </table>

          {total === 0 && (
            <p className="text-xs text-muted text-center py-1">전환할 항목이 없습니다.</p>
          )}
        </div>

        <div className="px-5 py-3 border-t border-border flex justify-end gap-2">
          <button
            onClick={onCancel}
            disabled={executing}
            className="btn-secondary text-sm"
          >
            취소
          </button>
          <button
            onClick={onConfirm}
            disabled={executing || total === 0}
            className={preview.direction === 'close' ? 'btn-danger text-sm' : 'btn-primary text-sm'}
          >
            {executing ? '실행 중…' : `${dirLabel} (${total}건)`}
          </button>
        </div>
      </div>
    </div>
  )
}

export default function BulkStatusPanel() {
  const [fromDate,    setFromDate]    = useState(DEFAULT_FROM)
  const [toDate,      setToDate]      = useState(defaultToDate)
  const [includeWI,   setIncludeWI]   = useState(true)
  const [includeLA,   setIncludeLA]   = useState(true)
  const [direction,   setDirection]   = useState<'close' | 'open'>('close')
  const [preview,     setPreview]     = useState<BulkStatusPreviewResult | null>(null)
  const [result,      setResult]      = useState<BulkStatusTransitionResult | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)

  const previewMut  = useBulkStatusPreview()
  const executeMut  = useBulkStatusTransition()

  const targets = [
    ...(includeWI ? ['work_items'         as const] : []),
    ...(includeLA ? ['leave_assignments'  as const] : []),
  ]

  const formError = !fromDate ? '시작일을 입력하세요.'
    : !toDate                 ? '종료일을 입력하세요.'
    : fromDate > toDate       ? '시작일이 종료일보다 늦습니다.'
    : targets.length === 0    ? '대상 유형을 하나 이상 선택하세요.'
    : null

  async function handlePreview() {
    if (formError) return
    setResult(null)
    setPreview(null)
    try {
      const res = await previewMut.mutateAsync({ from: fromDate, to: toDate, targets, direction })
      setPreview(res)
      setConfirmOpen(true)
    } catch {
      // error via previewMut.error
    }
  }

  async function handleExecute() {
    if (!preview) return
    try {
      const res = await executeMut.mutateAsync({ from: fromDate, to: toDate, targets, direction })
      setResult(res)
      setConfirmOpen(false)
      setPreview(null)
    } catch {
      // error via executeMut.error
      setConfirmOpen(false)
    }
  }

  const dirLabel = direction === 'close' ? 'Closed로 잠금' : 'Open으로 해제'

  return (
    <div className="space-y-6">

      {/* ── 안내 ─────────────────────────────────────────────── */}
      <div className="rounded-md border border-blue-200 bg-blue-50 p-3 text-xs text-blue-800">
        <p className="font-semibold flex items-center gap-1.5">
          <Info size={12} /> 일괄 상태 전환 안내
        </p>
        <ul className="mt-1.5 space-y-0.5 list-disc list-inside">
          <li>종료일(end_date)이 지정 범위 내인 항목을 일괄 Closed/Open 전환합니다.</li>
          <li>Closed 항목은 편집·삭제가 차단됩니다 (이동·리사이즈·모달 저장 포함).</li>
          <li>계산(FIFO, 잔여 휴가, 타임라인 표시)은 상태와 무관하게 정상 동작합니다.</li>
          <li>실행 전 미리보기로 건수를 확인하고 확인 버튼을 눌러야 적용됩니다.</li>
          <li>결과는 감사 로그(audit_log)에 자동 기록됩니다.</li>
        </ul>
      </div>

      {/* ── 폼 ───────────────────────────────────────────────── */}
      <div className="card space-y-5">
        <h2 className="text-sm font-semibold text-gray-800">전환 조건 설정</h2>

        {/* 날짜 범위 */}
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1.5">종료일 범위 (end_date 기준)</label>
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="date"
              value={fromDate}
              onChange={e => setFromDate(e.target.value)}
              className="input py-1 text-xs w-36"
              placeholder="YYYY-MM-DD"
            />
            <span className="text-xs text-muted">~</span>
            <input
              type="date"
              value={toDate}
              onChange={e => setToDate(e.target.value)}
              className="input py-1 text-xs w-36"
            />
          </div>
        </div>

        {/* 대상 유형 */}
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1.5">대상 유형</label>
          <div className="flex flex-wrap gap-4">
            <label className="flex items-center gap-2 cursor-pointer text-sm text-gray-700">
              <input
                type="checkbox"
                checked={includeWI}
                onChange={e => setIncludeWI(e.target.checked)}
                className="accent-brand-600"
              />
              작업항목 (work_items.status)
            </label>
            <label className="flex items-center gap-2 cursor-pointer text-sm text-gray-700">
              <input
                type="checkbox"
                checked={includeLA}
                onChange={e => setIncludeLA(e.target.checked)}
                className="accent-brand-600"
              />
              휴가 배정 (assignments kind='leave')
            </label>
          </div>
        </div>

        {/* 전환 방향 */}
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1.5">전환 방향</label>
          <div className="flex flex-wrap gap-4">
            <label className="flex items-center gap-2 cursor-pointer text-sm text-gray-700">
              <input
                type="radio"
                name="direction"
                checked={direction === 'close'}
                onChange={() => setDirection('close')}
                className="accent-brand-600"
              />
              <Lock size={13} className="text-amber-600" />
              Closed로 잠금 (현재 open → closed)
            </label>
            <label className="flex items-center gap-2 cursor-pointer text-sm text-gray-700">
              <input
                type="radio"
                name="direction"
                checked={direction === 'open'}
                onChange={() => setDirection('open')}
                className="accent-brand-600"
              />
              <Unlock size={13} className="text-emerald-600" />
              Open으로 해제 (현재 closed → open)
            </label>
          </div>
        </div>

        {/* 유효성 오류 */}
        {formError && (
          <p className="text-xs text-amber-700 flex items-center gap-1">
            <AlertTriangle size={11} /> {formError}
          </p>
        )}

        {/* 미리보기 버튼 */}
        <div>
          <button
            onClick={() => void handlePreview()}
            disabled={!!formError || previewMut.isPending}
            className="btn-primary gap-2"
          >
            <Eye size={14} className={previewMut.isPending ? 'animate-pulse' : ''} />
            {previewMut.isPending ? '집계 중…' : `미리보기 — ${dirLabel}`}
          </button>
        </div>

        {previewMut.isError && (
          <p className="text-xs text-red-600">미리보기 실패: {String(previewMut.error)}</p>
        )}
        {executeMut.isError && (
          <p className="text-xs text-red-600">실행 실패: {String(executeMut.error)}</p>
        )}
      </div>

      {/* ── 결과 요약 ─────────────────────────────────────────── */}
      {result && (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800">
          <p className="font-semibold flex items-center gap-1.5 mb-2">
            <CheckCircle2 size={14} />
            {result.direction === 'close' ? 'Closed 잠금' : 'Open 해제'} 완료
          </p>
          <ul className="space-y-0.5 text-xs">
            {result.work_items > 0 && (
              <li>· 작업항목: <strong>{result.work_items.toLocaleString()}건</strong> 전환</li>
            )}
            {result.leave_assignments > 0 && (
              <li>· 휴가 배정: <strong>{result.leave_assignments.toLocaleString()}건</strong> 전환</li>
            )}
            {result.work_items + result.leave_assignments === 0 && (
              <li>· 전환된 항목 없음 (이미 대상 상태이거나 범위 내 항목 없음)</li>
            )}
            <li className="text-emerald-600 mt-1">감사 로그에 기록되었습니다.</li>
          </ul>
        </div>
      )}

      {/* ── 확인 모달 ─────────────────────────────────────────── */}
      {confirmOpen && preview && (
        <ConfirmModal
          preview={preview}
          params={{ from: fromDate, to: toDate }}
          executing={executeMut.isPending}
          onConfirm={() => void handleExecute()}
          onCancel={() => setConfirmOpen(false)}
        />
      )}
    </div>
  )
}
