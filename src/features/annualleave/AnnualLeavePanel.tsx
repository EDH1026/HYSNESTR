/**
 * AnnualLeavePanel — §5.13 연차 관리
 * - editor/admin: 전체 편집 가능
 * - assistant: 조회 전용 (편집 컨트롤 숨김, RLS로도 차단)
 *
 * 탭: 적립 관리 | 연차 정산 | 수치 안내
 *
 * v2.33: annual_leave_grants 테이블 폐지 → computeStatutoryLeave 순수 함수로 전환
 */
import { useState, useMemo, useCallback, useEffect, useRef, Fragment, type FormEvent } from 'react'
import { Plus, Trash2, Loader2, AlertTriangle, Eye, Download, ChevronDown, ChevronRight } from 'lucide-react'
import { useAuthz } from '@/hooks/useAuthz'
import { computeLedger, buildHolidaySet } from '@/features/leave/ledger'
import type { LedgerAccrualEntry, LedgerUsageEntry } from '@/features/leave/ledger'
import { computeAnnualLeaveSettlement, computeTimesheetFigures } from './annualLeave'
import type { AnnualLeaveSettlementResult } from './annualLeave'
import {
  computeStatutoryLeave,
  sumStatutoryLeave,
  fyPeriodStr,
} from './computeStatutoryLeave'
import type { StatutoryLeaveItem } from './computeStatutoryLeave'
import {
  useAdjustmentsByPerson,
  useCreateAdjustment,
  useDeleteAdjustment,
} from './hooks'
import { useLedgerData }          from '@/features/leave/hooks'
import { useAllHolidays }         from '@/features/admin/hooks'
import { useAllPeople }           from '@/features/people/hooks'
import { dateToNum, numToStr, today } from '@/lib/date'
import { escHtml, triggerDownload, HTML_EXPORT_CSS } from '@/lib/htmlExport'
import { parseSearchQuery } from '@/lib/searchQuery'
import FilterChip from '@/components/FilterChip'
import type { Person, Rank, WorkItem, AnnualLeaveAdjustment } from '@/types'

// 유급 사용에서 제외할 무급 유형
const UNPAID_LEAVE = new Set(['리프레시', '휴직'])

const RANKS: Rank[] = ['Partner', 'SM', 'M', 'Senior', 'Staff', 'Intern']
const RANK_ORDER: Record<Rank, number> = { Partner: 0, SM: 1, M: 2, Senior: 3, Staff: 4, Intern: 5 }

// ─────────────────────────────────────────────────────────────
// Person selector
// ─────────────────────────────────────────────────────────────

function PersonSelector({
  selected,
  onSelect,
}: {
  selected: Person | null
  onSelect: (p: Person) => void
}) {
  const { data: people = [], isLoading } = useAllPeople()

  const [nameSearch,   setNameSearch]   = useState('')
  const [rankFilter,   setRankFilter]   = useState<Rank[]>([])
  const [statusFilter, setStatusFilter] = useState<string[]>(['active'])

  function toggleRank(r: Rank) {
    setRankFilter(prev => prev.includes(r) ? prev.filter(x => x !== r) : [...prev, r])
  }
  function toggleStatus(s: string) {
    setStatusFilter(prev => prev.includes(s) ? prev.filter(x => x !== s) : [...prev, s])
  }
  const hasFilter = !!(nameSearch || rankFilter.length || statusFilter.length !== 1 || !statusFilter.includes('active'))

  const filtered = useMemo(() => {
    let out = [...people]
    if (nameSearch.trim()) {
      const matches = parseSearchQuery(nameSearch)
      out = out.filter(p => matches([p.name]))
    }
    if (rankFilter.length)   out = out.filter(p => rankFilter.includes(p.rank))
    if (statusFilter.length) out = out.filter(p => statusFilter.includes(p.status ?? 'active'))
    return out.sort((a, b) => {
      const rc = (RANK_ORDER[a.rank] ?? 99) - (RANK_ORDER[b.rank] ?? 99)
      return rc !== 0 ? rc : a.name.localeCompare(b.name, 'ko')
    })
  }, [people, nameSearch, rankFilter, statusFilter])

  return (
    <div className="w-60 flex-shrink-0 border-r border-border flex flex-col h-full">
      <div className="px-3 pt-3 pb-2 border-b border-border space-y-2">
        <input
          className="input py-1 text-xs w-full"
          placeholder="이름 검색…"
          value={nameSearch}
          onChange={e => setNameSearch(e.target.value)}
        />
        <div>
          <p className="text-[10px] text-muted mb-1">직급</p>
          <div className="flex flex-wrap gap-1">
            {RANKS.map(r => (
              <FilterChip key={r} label={r} active={rankFilter.includes(r)} onClick={() => toggleRank(r)} />
            ))}
          </div>
        </div>
        <div>
          <p className="text-[10px] text-muted mb-1">상태</p>
          <div className="flex flex-wrap gap-1">
            <FilterChip label="재직"     active={statusFilter.includes('active')}   onClick={() => toggleStatus('active')} />
            <FilterChip label="입사예정" active={statusFilter.includes('upcoming')} onClick={() => toggleStatus('upcoming')} />
            <FilterChip label="퇴직"     active={statusFilter.includes('resigned')} onClick={() => toggleStatus('resigned')} />
          </div>
        </div>
        {hasFilter && (
          <button className="text-[10px] text-muted hover:text-gray-700"
            onClick={() => { setNameSearch(''); setRankFilter([]); setStatusFilter(['active']) }}>
            초기화
          </button>
        )}
        <p className="text-[10px] text-muted">
          {filtered.length} / {people.length} 명
        </p>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-8"><Loader2 size={16} className="animate-spin text-muted" /></div>
      ) : (
        <ul className="flex-1 overflow-y-auto py-1">
          {filtered.map(p => (
            <li key={p.id}>
              <button
                onClick={() => onSelect(p)}
                className={[
                  'w-full text-left px-3 py-2 text-sm transition-colors',
                  selected?.id === p.id
                    ? 'bg-brand-50 text-brand-700 font-medium'
                    : 'text-gray-700 hover:bg-surface-100',
                ].join(' ')}
              >
                <span className="block truncate">{p.name}</span>
                <span className="block text-[11px] text-muted">
                  {p.rank}
                  {p.status === 'resigned' && <span className="ml-1 text-red-500">(퇴사)</span>}
                  {p.status === 'upcoming' && <span className="ml-1 text-blue-500">(입사예정)</span>}
                </span>
              </button>
            </li>
          ))}
          {filtered.length === 0 && (
            <li className="px-3 py-4 text-xs text-muted text-center">검색 결과 없음</li>
          )}
        </ul>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// Statutory leave item badge
// ─────────────────────────────────────────────────────────────

function ItemBadge({ kind }: { kind: 'probation' | 'annual' }) {
  if (kind === 'probation') {
    return (
      <span className="inline-block rounded-full bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium text-gray-600">
        신입사원 휴가
      </span>
    )
  }
  return (
    <span className="inline-block rounded-full bg-brand-100 px-1.5 py-0.5 text-[10px] font-medium text-brand-700">
      법정연차
    </span>
  )
}

// ─────────────────────────────────────────────────────────────
// Tab 1: 적립 관리 (수동 보정 전용 — 자동계산은 읽기 전용 표시)
// ─────────────────────────────────────────────────────────────

function AdjustmentsTab({ person, readOnly }: { person: Person; readOnly: boolean }) {
  const { data: adjustments = [], isLoading } = useAdjustmentsByPerson(person.id)
  const createAdj = useCreateAdjustment()
  const deleteAdj = useDeleteAdjustment()

  const [adjForm, setAdjForm] = useState({
    direction: 'accrual' as 'accrual' | 'usage',
    days: '',
    date: numToStr(today()),
    note: '',
  })
  const [adjErr,    setAdjErr]    = useState<string | null>(null)
  const [showAddAdj, setShowAddAdj] = useState(false)

  // 법정연차 자동 계산 (읽기 전용 표시, 오늘 기준)
  const todayStr = numToStr(today())
  const statutoryItems = useMemo(() =>
    person.hire_date && person.rank !== 'Partner'
      ? computeStatutoryLeave(person.hire_date, 'fiscal', todayStr)
      : [],
  [person.hire_date, person.rank, todayStr])

  async function handleAdjSubmit(e: FormEvent) {
    e.preventDefault()
    const days = parseFloat(adjForm.days)
    if (isNaN(days) || days === 0) { setAdjErr('0이 아닌 값을 입력하세요'); return }
    if (!adjForm.date) { setAdjErr('날짜를 선택하세요'); return }
    setAdjErr(null)
    try {
      await createAdj.mutateAsync({
        person_id: person.id,
        direction: adjForm.direction,
        days,
        date:      adjForm.date,
        note:      adjForm.note || null,
      })
      setShowAddAdj(false)
      setAdjForm({ direction: 'accrual', days: '', date: numToStr(today()), note: '' })
    } catch (e) {
      setAdjErr(e instanceof Error ? e.message : '저장 실패')
    }
  }

  if (isLoading) return <div className="flex justify-center py-12"><Loader2 size={20} className="animate-spin text-muted" /></div>

  return (
    <div className="space-y-8">
      {/* 법정연차 자동 계산 (읽기 전용) */}
      {person.hire_date && (
        <section>
          <div className="mb-3">
            <h3 className="text-sm font-semibold text-gray-800">법정연차 자동 계산</h3>
            <p className="text-xs text-muted">회계연도(7월 1일) 기준 — 근로기준법 제60조, 오늘({todayStr}) 기준</p>
          </div>
          {statutoryItems.length === 0 ? (
            <p className="text-xs text-muted text-center py-4">아직 발생한 법정연차·신입사원 휴가 없음</p>
          ) : (
            <div className="card p-0 overflow-hidden">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-surface-50 border-b border-border text-muted">
                    <th className="px-3 py-2 text-left font-medium">유형</th>
                    <th className="px-3 py-2 text-left font-medium">FY / 기준일</th>
                    <th className="px-3 py-2 text-left font-medium">산출 근거</th>
                    <th className="px-3 py-2 text-right font-medium">일수</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {statutoryItems.map((item, i) => {
                    if (item.kind === 'probation') {
                      return (
                        <tr key={`p-${i}`} className="hover:bg-surface-50">
                          <td className="px-3 py-2"><ItemBadge kind="probation" /></td>
                          <td className="px-3 py-2 text-muted font-mono text-[11px]">{item.from}~{item.to}</td>
                          <td className="px-3 py-2 text-muted">매월 개근 {item.days}개월</td>
                          <td className="px-3 py-2 text-right font-semibold text-gray-700">{item.days}일</td>
                        </tr>
                      )
                    }
                    return (
                      <tr key={`a-${i}`} className="hover:bg-surface-50">
                        <td className="px-3 py-2"><ItemBadge kind="annual" /></td>
                        <td className="px-3 py-2">
                          <span className="font-medium text-brand-700">FY{item.fyLabel}</span>
                          <span className="ml-1 text-muted text-[10px]">({fyPeriodStr(item.fyLabel)})</span>
                          <div className="font-mono text-[10px] text-muted">{item.date}</div>
                        </td>
                        <td className="px-3 py-2 text-muted">{item.formula}</td>
                        <td className="px-3 py-2 text-right font-semibold text-brand-700">{item.days}일</td>
                      </tr>
                    )
                  })}
                </tbody>
                <tfoot>
                  <tr className="bg-surface-50 border-t-2 border-border">
                    <td colSpan={3} className="px-3 py-2 text-xs font-semibold text-gray-700">합계 (오늘 기준 누적)</td>
                    <td className="px-3 py-2 text-right font-bold text-brand-700">
                      {sumStatutoryLeave(statutoryItems)}일
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </section>
      )}

      {/* 수동 보정 */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <div>
            <h3 className="text-sm font-semibold text-gray-800">수동 보정</h3>
            <p className="text-xs text-muted">특이사항에 따른 +/- 조정 (사유 기재 권장)</p>
          </div>
          {!readOnly && !showAddAdj && (
            <button onClick={() => setShowAddAdj(true)} className="btn-secondary text-xs py-0.5 gap-1">
              <Plus size={11} /> 보정 추가
            </button>
          )}
        </div>

        {!readOnly && showAddAdj && (
          <form onSubmit={handleAdjSubmit} className="rounded-md border border-amber-200 bg-amber-50 p-3 space-y-3 mb-3">
            <p className="text-xs font-semibold text-amber-800">수동 보정 추가</p>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="mb-0.5 block text-xs text-gray-600">유형</label>
                <select className="input py-1 text-xs" value={adjForm.direction}
                  onChange={e => setAdjForm(f => ({ ...f, direction: e.target.value as 'accrual' | 'usage' }))}>
                  <option value="accrual">증가 (accrual)</option>
                  <option value="usage">감소 (usage)</option>
                </select>
              </div>
              <div>
                <label className="mb-0.5 block text-xs text-gray-600">일수 <span className="text-muted text-[10px]">(음수=취소)</span></label>
                <input required type="number" step="0.5" className="input py-1 text-xs"
                  placeholder="예: 1 또는 -1"
                  value={adjForm.days} onChange={e => setAdjForm(f => ({ ...f, days: e.target.value }))} />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="mb-0.5 block text-xs text-gray-600">날짜</label>
                <input required type="date" className="input py-1 text-xs"
                  value={adjForm.date} onChange={e => setAdjForm(f => ({ ...f, date: e.target.value }))} />
              </div>
              <div>
                <label className="mb-0.5 block text-xs text-gray-600">사유</label>
                <input type="text" className="input py-1 text-xs" placeholder="권장 — 필수 아님"
                  value={adjForm.note} onChange={e => setAdjForm(f => ({ ...f, note: e.target.value }))} />
              </div>
            </div>
            {adjErr && <p className="text-xs text-red-600">{adjErr}</p>}
            <div className="flex gap-2">
              <button type="submit" disabled={createAdj.isPending} className="btn-primary text-xs py-1 flex-1">
                {createAdj.isPending ? <Loader2 size={11} className="animate-spin" /> : '저장'}
              </button>
              <button type="button" onClick={() => setShowAddAdj(false)} className="btn-secondary text-xs py-1">취소</button>
            </div>
          </form>
        )}

        {adjustments.length === 0 ? (
          <p className="text-xs text-muted text-center py-4">보정 내역 없음</p>
        ) : (
          <div className="card p-0 overflow-hidden">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-surface-50 border-b border-border text-muted">
                  <th className="px-3 py-2 text-left font-medium">날짜</th>
                  <th className="px-3 py-2 text-left font-medium">유형</th>
                  <th className="px-3 py-2 text-right font-medium">일수</th>
                  <th className="px-3 py-2 text-left font-medium">사유</th>
                  {!readOnly && <th className="px-2 py-2 w-8" />}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {adjustments.map((a: AnnualLeaveAdjustment) => (
                  <tr key={a.id} className="hover:bg-surface-50">
                    <td className="px-3 py-2 font-mono">{a.date}</td>
                    <td className="px-3 py-2">
                      <span className={`pill text-[10px] ${a.direction === 'accrual' ? 'bg-brand-100 text-brand-700' : 'bg-red-100 text-red-700'}`}>
                        {a.direction === 'accrual' ? '증가' : '감소'}
                      </span>
                    </td>
                    <td className={`px-3 py-2 text-right font-medium ${a.days >= 0 ? 'text-brand-700' : 'text-red-600'}`}>
                      {a.days >= 0 ? '+' : ''}{a.days}일
                    </td>
                    <td className="px-3 py-2 text-muted">{a.note ?? '—'}</td>
                    {!readOnly && (
                      <td className="px-2 py-2">
                        <button
                          onClick={() => { if (confirm('삭제할까요?')) deleteAdj.mutate({ id: a.id, personId: person.id }) }}
                          className="rounded p-1 text-muted hover:text-red-600 hover:bg-red-50 transition-colors"
                        >
                          <Trash2 size={11} />
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// Shared hook — ledger + annual leave data for a person
// ─────────────────────────────────────────────────────────────

function usePersonData(personId: string, asOfStr: string, personRank?: string) {
  // PRD v2.100 LV-17: RPC-backed source so this ledger matches the same person's
  // ledger regardless of the viewing session's role (admin vs assistant).
  const { data: ledgerSrc, isLoading: ll } = useLedgerData([personId])
  const assignments = ledgerSrc?.assignments ?? []
  const accruals    = ledgerSrc?.accruals    ?? []
  const workItems    = ledgerSrc?.workItems   ?? []
  const { data: holidays   = [], isLoading: lh } = useAllHolidays()
  const { data: adjustments= [], isLoading: lj } = useAdjustmentsByPerson(personId)

  const isLoading = ll || lh || lj

  const holidaySet = useMemo(() => {
    const yr = new Date().getFullYear()
    return buildHolidaySet(holidays, yr - 5, yr + 5)
  }, [holidays])

  const isHoliday = useCallback((n: number) => holidaySet.has(n), [holidaySet])

  const asOf = useMemo(() => dateToNum(asOfStr), [asOfStr])

  const ledger = useMemo(() => {
    if (isLoading) return null
    return computeLedger(personId, { workItems, assignments, accruals, isHoliday, today: asOf, personRank })
  }, [personId, workItems, assignments, accruals, isHoliday, asOf, isLoading, personRank])

  return { isLoading, ledger, adjustments, workItems, isHoliday }
}

// ─────────────────────────────────────────────────────────────
// FIFO 차감 원천 요약 (Tab 2에서 사용)
// ─────────────────────────────────────────────────────────────

function deductionSummary(
  deductions: LedgerUsageEntry['deductions'],
  accrualById: Map<string, LedgerAccrualEntry>,
  workItemById: Map<string, WorkItem>,
): string {
  if (!deductions.length) return '—'
  return deductions.map(d => {
    const acc = accrualById.get(d.accrualId)
    if (!acc) return `? ${d.days}일`
    const wi  = d.sourceId ? workItemById.get(d.sourceId) : undefined
    const val = acc.note || wi?.client || wi?.name || ''
    return val ? `[${acc.type}] ${val} ${d.days}일` : `[${acc.type}] ${d.days}일`
  }).join(', ')
}

// ─────────────────────────────────────────────────────────────
// FY helpers (shared by UI and HTML export)
// ─────────────────────────────────────────────────────────────

function fyFromDate(dateStr: string): number {
  const y = parseInt(dateStr.slice(0, 4), 10)
  const m = parseInt(dateStr.slice(5, 7), 10)
  return m >= 7 ? y + 1 : y
}

function fyRangeLabel(fy: number): string {
  return `FY${String(fy).slice(-2)} (${fy - 1}.07~${fy}.06)`
}

// ─────────────────────────────────────────────────────────────
// AL-10: HTML export helpers
// ─────────────────────────────────────────────────────────────

function renderStatutoryItemsHtml(
  items: StatutoryLeaveItem[],
  adjRows: AnnualLeaveAdjustment[],
  subtotal: number,
  adjustmentsTotal: number,
): string {
  const itemRows = items.map(item => {
    if (item.kind === 'probation') {
      return `<tr>
        <td><span class="pill pill-gray">신입사원 휴가</span></td>
        <td class="mono">${escHtml(item.from)}~${escHtml(item.to)}</td>
        <td>매월 개근 ${escHtml(item.days)}개월</td>
        <td class="num pos">+${escHtml(item.days)}</td></tr>`
    }
    return `<tr>
      <td><span class="pill pill-blue">법정연차</span></td>
      <td><strong>FY${escHtml(item.fyLabel)}</strong> <span class="mono" style="font-size:11px">${escHtml(item.date)}</span></td>
      <td>${escHtml(item.formula)}</td>
      <td class="num pos">+${escHtml(item.days)}</td></tr>`
  })

  const adjHtml = adjRows.map(a => `<tr>
    <td><span class="pill ${a.direction === 'accrual' ? 'pill-green' : 'pill-red'}">${a.direction === 'accrual' ? '보정+' : '보정−'}</span></td>
    <td class="mono">${escHtml(a.date)}</td>
    <td>${escHtml(a.note ?? '—')}</td>
    <td class="num ${a.direction === 'accrual' ? 'pos' : 'neg'}">${a.direction === 'accrual' ? '+' : '−'}${escHtml(Math.abs(a.days))}</td></tr>`)

  const totalSign  = adjustmentsTotal >= 0 ? '+' : ''
  const grandTotal = Math.round((subtotal + adjustmentsTotal) * 10) / 10

  return `
    <div style="margin-bottom:8px">
      <span style="font-size:12px;font-weight:600">소계 ${grandTotal}일</span>
    </div>
    <table>
      <thead><tr><th>유형</th><th>FY / 기준일</th><th>산출 근거</th><th>일수</th></tr></thead>
      <tbody>
        ${itemRows.join('')}
        ${adjHtml.join('')}
        ${items.length === 0 && adjRows.length === 0 ? '<tr><td colspan="4" class="empty">내역 없음</td></tr>' : ''}
      </tbody>
      <tfoot>
        <tr>
          <td colspan="3">순수 법정연차 소계 / 수동 보정 ${totalSign}${adjustmentsTotal}일</td>
          <td class="num">${subtotal}일 / ${totalSign}${adjustmentsTotal}일</td>
        </tr>
      </tfoot>
    </table>`
}

function generateSettlementHtml(
  person:          Person,
  asOfStr:         string,
  adjRows:         AnnualLeaveAdjustment[],
  accrualRows:     LedgerAccrualEntry[],
  paidUsages:      LedgerUsageEntry[],
  result:          AnnualLeaveSettlementResult,
  workItemById:    Map<string, WorkItem>,
  accrualById:     Map<string, LedgerAccrualEntry>,
): string {
  const generated = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })
  const isTeam    = result.entitlementBasis === 'team'

  // Build FY-grouped t2 (팀 정당 적립 — by accrual date)
  const t2Lines: string[] = []
  if (accrualRows.length === 0) {
    t2Lines.push('<tr><td colspan="4" class="empty">내역 없음</td></tr>')
  } else {
    const t2ByFY = new Map<number, LedgerAccrualEntry[]>()
    for (const a of accrualRows) {
      const fy = fyFromDate(a.date)
      if (!t2ByFY.has(fy)) t2ByFY.set(fy, [])
      t2ByFY.get(fy)!.push(a)
    }
    for (const [fy, entries] of [...t2ByFY.entries()].sort(([a], [b]) => a - b)) {
      const sub  = entries.reduce((s, a) => s + a.days, 0)
      const fyYY = String(fy).slice(-2)
      t2Lines.push(`<tr class="fy-hdr"><td colspan="4">FY${fyYY} (${fy - 1}.07~${fy}.06)</td></tr>`)
      for (const a of entries) {
        const wi      = a.sourceId ? workItemById.get(a.sourceId) : undefined
        const srcText = escHtml(a.note || wi?.client || wi?.name || '—')
        t2Lines.push(`<tr>
          <td><span class="pill pill-purple">${escHtml(a.type)}</span></td>
          <td class="mono">${escHtml(a.date)}</td>
          <td>${srcText}</td>
          <td class="num pos">+${escHtml(a.days)}</td></tr>`)
      }
      t2Lines.push(`<tr class="fy-sub"><td colspan="3">소계</td><td class="num pos">+${sub}</td></tr>`)
    }
  }
  const t2 = t2Lines

  // Build FY-grouped t3 (사용 이력 — by usage start date)
  const t3Lines: string[] = []
  if (paidUsages.length === 0) {
    t3Lines.push('<tr><td colspan="4" class="empty">내역 없음</td></tr>')
  } else {
    const t3ByFY = new Map<number, LedgerUsageEntry[]>()
    for (const u of paidUsages) {
      const fy = fyFromDate(u.start)
      if (!t3ByFY.has(fy)) t3ByFY.set(fy, [])
      t3ByFY.get(fy)!.push(u)
    }
    for (const [fy, entries] of [...t3ByFY.entries()].sort(([a], [b]) => a - b)) {
      const sub  = entries.reduce((s, u) => s + u.days, 0)
      const fyYY = String(fy).slice(-2)
      t3Lines.push(`<tr class="fy-hdr"><td colspan="4">FY${fyYY} (${fy - 1}.07~${fy}.06)</td></tr>`)
      for (const u of entries) {
        const period  = u.start === u.end ? escHtml(u.start) : `${escHtml(u.start)}~${escHtml(u.end)}`
        const fifo    = escHtml(deductionSummary(u.deductions, accrualById, workItemById))
        t3Lines.push(`<tr>
          <td class="mono">${period}</td>
          <td><span class="pill pill-amber">${escHtml(u.type)}</span></td>
          <td>${fifo}</td>
          <td class="num">−${escHtml(u.days)}</td></tr>`)
      }
      t3Lines.push(`<tr class="fy-sub"><td colspan="3">소계</td><td class="num">−${sub}</td></tr>`)
    }
  }
  const t3 = t3Lines

  const netSign      = result.netSettlement > 0 ? '+' : ''
  const excessRow    = result.excess    > 0 ? `<div class="summary-row err"><span>초과 사용분 (퇴사 시 차감)</span><span class="sv">−${result.excess}일</span></div>` : ''
  const shortfallRow = result.shortfall > 0 ? `<div class="summary-row ok"><span>미달 보상분 (퇴사 시 보상)</span><span class="sv">+${result.shortfall}일</span></div>` : ''
  const evenRow      = (result.excess === 0 && result.shortfall === 0) ? `<div class="summary-row muted"><span>초과/미달 없음 (권리 = 사용)</span></div>` : ''

  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>퇴사 정산서 — ${escHtml(person.name)}</title>
<style>${HTML_EXPORT_CSS}</style>
</head>
<body>
<header>
  <h1>퇴사 정산서</h1>
  <p class="pi">${escHtml(person.name)} · ${escHtml(person.rank)}${person.role ? ` · ${escHtml(person.role)}` : ''}</p>
  <p class="meta">입사일: ${escHtml(person.hire_date ?? '미입력')} &nbsp;|&nbsp; 퇴사일(예정): ${escHtml(person.termination_date ?? '미입력')} &nbsp;|&nbsp; 정산 기준일: ${escHtml(asOfStr)}</p>
  <p class="meta">생성: ${escHtml(generated)}</p>
</header>

<section>
  <h2>① 법정연차 적립·보정 내역</h2>
  <div class="col-box">
    <div class="col-title" style="color:#7c3aed">입사일(주년일) 기준</div>
    ${renderStatutoryItemsHtml(result.anniversaryItems, adjRows, result.anniversarySubtotal, result.adjustmentsTotal)}
  </div>
  <p style="margin-top:8px;font-size:12px;color:#6b7280">법정연차 = <strong>${result.statutory}일</strong> (수동 보정 포함)</p>
</section>

<section>
  <h2>② 팀 정당 적립 내역</h2>
  <table>
    <thead><tr><th>유형</th><th>날짜</th><th>원천</th><th>일수</th></tr></thead>
    <tbody>${t2.join('')}</tbody>
    <tfoot><tr><td colspan="3">팀 정당 적립 합계</td><td class="num">${result.teamAccrued}일</td></tr></tfoot>
  </table>
</section>

<section>
  <h2>③ 휴가 사용 내역 <span style="font-weight:400;color:#6b7280">(유급 — 무급리프레시·휴직 제외)</span></h2>
  <table>
    <thead><tr><th>기간</th><th>유형</th><th>FIFO 차감 원천</th><th>일수</th></tr></thead>
    <tbody>${t3.join('')}</tbody>
    <tfoot><tr><td colspan="3">총 유급 사용 합계</td><td class="num">${result.totalUsed}일</td></tr></tfoot>
  </table>
</section>

<section>
  <h2>정산 요약</h2>
  <div class="sb">
    <div class="cand">
      <span class="${!isTeam ? 'chosen-a' : 'unchosen'}">
        (a) 법정연차+주말/휴일대체+특별휴가
        <span class="hint">(${result.statutory}+${result.weekendSub}+${result.specialLeave}일)</span>
        ${!isTeam ? '<span class="badge badge-a">채택</span>' : ''}
      </span>
      <span class="sv-sm ${!isTeam ? 'chosen-a' : 'unchosen'}">${result.candidateA}일</span>
    </div>
    <div class="cand">
      <span class="${isTeam ? 'chosen-b' : 'unchosen'}">
        (b) 팀 정당 적립 합
        ${isTeam ? '<span class="badge badge-b">채택</span>' : ''}
      </span>
      <span class="sv-sm ${isTeam ? 'chosen-b' : 'unchosen'}">${result.teamAccrued}일</span>
    </div>
    <div class="summary-row">
      <span>총 휴가 권리 <span class="hint">max(a, b)</span></span>
      <span class="sv">${result.totalEntitlement}일</span>
    </div>
    <div class="summary-row">
      <span>총 유급 사용 ③</span>
      <span class="sv">−${result.totalUsed}일</span>
    </div>
    ${excessRow}${shortfallRow}${evenRow}
    <div class="summary-row total">
      <span>최종 정산</span>
      <span class="sv">${netSign}${result.netSettlement}일</span>
    </div>
  </div>
</section>
</body>
</html>`
}

// ─────────────────────────────────────────────────────────────
// Tab 2: 퇴사 정산
// ─────────────────────────────────────────────────────────────

/** 법정연차 항목 목록 렌더 (FY 또는 입사일 기준) */
function StatutorySection({
  title,
  titleColor,
  items,
  adjRows,
  subtotal,
  adjustmentsTotal,
}: {
  title:            string
  titleColor:       string
  items:            StatutoryLeaveItem[]
  adjRows:          AnnualLeaveAdjustment[]
  subtotal:         number
  adjustmentsTotal: number
}) {
  const grandTotal = Math.round((subtotal + adjustmentsTotal) * 10) / 10
  return (
    <div className="rounded-lg border border-border bg-surface-50 overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
        <span className={`text-xs font-semibold ${titleColor}`}>{title}</span>
        <span className="text-xs tabular-nums font-bold text-gray-700">
          {grandTotal}일
        </span>
      </div>
      <table className="w-full text-xs">
        <tbody className="divide-y divide-border">
          {items.map((item, i) => {
            if (item.kind === 'probation') {
              return (
                <tr key={`p-${i}`} className="hover:bg-white/60">
                  <td className="px-3 py-1.5"><ItemBadge kind="probation" /></td>
                  <td className="px-3 py-1.5 font-mono text-[10px] text-muted whitespace-nowrap">{item.from}~{item.to}</td>
                  <td className="px-3 py-1.5 text-muted">매월 개근 {item.days}개월</td>
                  <td className="px-3 py-1.5 text-right font-semibold text-gray-700">+{item.days}</td>
                </tr>
              )
            }
            return (
              <tr key={`a-${i}`} className="hover:bg-white/60">
                <td className="px-3 py-1.5"><ItemBadge kind="annual" /></td>
                <td className="px-3 py-1.5">
                  <span className="font-semibold text-brand-700">FY{item.fyLabel}</span>
                  <span className="ml-1 text-[10px] text-muted">({fyPeriodStr(item.fyLabel)})</span>
                  <div className="font-mono text-[10px] text-muted">{item.date}</div>
                </td>
                <td className="px-3 py-1.5 text-muted">{item.formula}</td>
                <td className="px-3 py-1.5 text-right font-semibold text-brand-700">+{item.days}</td>
              </tr>
            )
          })}
          {adjRows.map(a => (
            <tr key={`adj-${a.id}`} className="hover:bg-white/60">
              <td className="px-3 py-1.5">
                <span className={`pill text-[10px] ${a.direction === 'accrual' ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'}`}>
                  {a.direction === 'accrual' ? '보정+' : '보정−'}
                </span>
              </td>
              <td className="px-3 py-1.5 font-mono text-[10px] text-muted">{a.date}</td>
              <td className="px-3 py-1.5 text-muted">{a.note ?? '—'}</td>
              <td className={`px-3 py-1.5 text-right font-semibold ${a.direction === 'accrual' ? 'text-emerald-700' : 'text-red-600'}`}>
                {a.direction === 'accrual' ? '+' : '−'}{Math.abs(a.days)}
              </td>
            </tr>
          ))}
          {items.length === 0 && adjRows.length === 0 && (
            <tr><td colSpan={4} className="px-3 py-3 text-center text-muted">내역 없음</td></tr>
          )}
        </tbody>
        <tfoot>
          <tr className="bg-surface-50/60 border-t-2 border-border">
            <td colSpan={3} className="px-3 py-2 text-xs font-semibold text-gray-700">
              법정연차 소계 + 수동 보정 {adjustmentsTotal >= 0 ? '+' : ''}{adjustmentsTotal}일
            </td>
            <td className="px-3 py-2 text-right font-bold text-brand-700">
              {grandTotal}일
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  )
}

function SettlementTab({ person }: { person: Person }) {
  const [asOfStr, setAsOfStr] = useState(numToStr(today()))
  const { isLoading, ledger, adjustments, workItems, isHoliday } = usePersonData(person.id, asOfStr, person.rank)

  const weekendSubAccrued = useMemo(() =>
    (ledger?.accruals ?? [])
      .filter(a => a.type === '주말/휴일대체')
      .reduce((s, a) => s + a.days, 0),
  [ledger])
  const specialLeaveAccrued = useMemo(() =>
    (ledger?.accruals ?? [])
      .filter(a => a.type === '특별휴가')
      .reduce((s, a) => s + a.days, 0),
  [ledger])

  const result = useMemo(() => {
    if (!ledger) return null
    return computeAnnualLeaveSettlement(asOfStr, {
      hireDate:           person.hire_date ?? undefined,
      adjustments,
      weekendSubAccrued,
      specialLeaveAccrued,
      teamActualAccrued:  ledger.actualAccrued,
      totalPaidUsed:      ledger.actualUsed,
      unpaidPeriods:      ledger.unpaid,
      isHoliday,
    })
  }, [ledger, adjustments, weekendSubAccrued, specialLeaveAccrued, asOfStr, person.hire_date, isHoliday])

  const workItemById = useMemo(() => new Map(workItems.map(w => [w.id, w])), [workItems])
  const accrualById  = useMemo(
    () => new Map((ledger?.accruals ?? []).map(a => [a.id, a])),
    [ledger],
  )

  const adjRows = useMemo(() =>
    adjustments.filter(a => a.date <= asOfStr).sort((a, b) => a.date.localeCompare(b.date)),
  [adjustments, asOfStr])

  const accrualRows = useMemo(() =>
    [...(ledger?.accruals ?? [])].sort((a, b) => a.date.localeCompare(b.date)),
  [ledger])

  const paidUsages = useMemo(() =>
    (ledger?.usages ?? [])
      .filter(u => !UNPAID_LEAVE.has(u.type))
      .sort((a, b) => a.start.localeCompare(b.start)),
  [ledger])

  // FY-grouped views for UI tables
  const accrualFYGroups = useMemo(() => {
    const map = new Map<number, LedgerAccrualEntry[]>()
    for (const a of accrualRows) {
      const fy = fyFromDate(a.date)
      if (!map.has(fy)) map.set(fy, [])
      map.get(fy)!.push(a)
    }
    return [...map.entries()].sort(([a], [b]) => a - b)
  }, [accrualRows])

  const usageFYGroups = useMemo(() => {
    const map = new Map<number, LedgerUsageEntry[]>()
    for (const u of paidUsages) {
      const fy = fyFromDate(u.start)
      if (!map.has(fy)) map.set(fy, [])
      map.get(fy)!.push(u)
    }
    return [...map.entries()].sort(([a], [b]) => a - b)
  }, [paidUsages])

  // FY accordion — default: last 2 FYs expanded (most relevant for settlement review)
  const [expandedAccrualFYs, setExpandedAccrualFYs] = useState(() => new Set<number>())
  const [expandedUsageFYs,   setExpandedUsageFYs]   = useState(() => new Set<number>())
  const accrualFYInitRef = useRef(false)
  const usageFYInitRef   = useRef(false)
  useEffect(() => {
    if (!accrualFYInitRef.current && accrualFYGroups.length > 0) {
      accrualFYInitRef.current = true
      setExpandedAccrualFYs(new Set(accrualFYGroups.slice(-2).map(([fy]) => fy)))
    }
  }, [accrualFYGroups])
  useEffect(() => {
    if (!usageFYInitRef.current && usageFYGroups.length > 0) {
      usageFYInitRef.current = true
      setExpandedUsageFYs(new Set(usageFYGroups.slice(-2).map(([fy]) => fy)))
    }
  }, [usageFYGroups])
  const toggleAccrualFY = useCallback((fy: number) =>
    setExpandedAccrualFYs(p => { const s = new Set(p); s.has(fy) ? s.delete(fy) : s.add(fy); return s }), [])
  const toggleUsageFY = useCallback((fy: number) =>
    setExpandedUsageFYs(p => { const s = new Set(p); s.has(fy) ? s.delete(fy) : s.add(fy); return s }), [])

  const handleDownload = useCallback(() => {
    if (!result) return
    const safeName = person.name.replace(/\s+/g, '_')
    triggerDownload(
      generateSettlementHtml(person, asOfStr, adjRows, accrualRows, paidUsages, result, workItemById, accrualById),
      `퇴사정산_${safeName}_${asOfStr}.html`,
    )
  }, [person, asOfStr, adjRows, accrualRows, paidUsages, result, workItemById, accrualById])

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <label className="text-xs font-medium text-gray-700">기준일</label>
        <input type="date" className="input py-1 text-xs w-36"
          value={asOfStr} onChange={e => setAsOfStr(e.target.value)} />
        <button
          onClick={handleDownload}
          disabled={!result}
          className="ml-auto flex items-center gap-1.5 btn-secondary text-xs py-1 disabled:opacity-40"
        >
          <Download size={13} />
          HTML로 저장
        </button>
      </div>

      {(isLoading || !result) ? (
        <div className="flex items-center justify-center py-12 text-muted text-sm">
          <Loader2 size={20} className="animate-spin mr-2" /> 계산 중…
        </div>
      ) : (
        <>
          {/* ① 법정연차 적립·보정 내역 */}
          <section>
            <h3 className="text-xs font-semibold text-gray-700 mb-2">① 법정연차 적립·보정 내역</h3>
            {!person.hire_date ? (
              <p className="text-xs text-muted py-3 text-center">입사일 미입력 — 수동 보정만 반영됨 ({result.statutory}일)</p>
            ) : (
              <StatutorySection
                title="입사일(주년일) 기준"
                titleColor="text-purple-700"
                items={result.anniversaryItems}
                adjRows={adjRows}
                subtotal={result.anniversarySubtotal}
                adjustmentsTotal={result.adjustmentsTotal}
              />
            )}
            <div className="mt-2 px-3 py-2 bg-surface-50 border border-border rounded text-xs text-gray-700">
              법정연차 누적 합계: <span className="font-bold text-brand-700">{result.statutory}일</span>
              <span className="text-muted ml-1">(수동 보정 {result.adjustmentsTotal >= 0 ? '+' : ''}{result.adjustmentsTotal}일 포함)</span>
            </div>
          </section>

          {/* ② 팀 정당 적립 내역 */}
          <section>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-xs font-semibold text-gray-700">② 팀 정당 적립 내역</h3>
              {accrualFYGroups.length > 0 && (
                <button
                  onClick={() => setExpandedAccrualFYs(
                    expandedAccrualFYs.size === accrualFYGroups.length
                      ? new Set()
                      : new Set(accrualFYGroups.map(([fy]) => fy))
                  )}
                  className="text-[11px] text-brand-600 hover:underline"
                >
                  {expandedAccrualFYs.size === accrualFYGroups.length ? '전체 접기' : '전체 펼치기'}
                </button>
              )}
            </div>
            <div className="card p-0 overflow-hidden">
              <table className="w-full text-xs">
                <colgroup>
                  <col className="w-36" />
                  <col className="w-28" />
                  <col />
                  <col className="w-14" />
                </colgroup>
                <thead>
                  <tr className="bg-surface-50 border-b border-border text-muted">
                    <th className="px-3 py-2 text-left font-medium">유형</th>
                    <th className="px-3 py-2 text-left font-medium whitespace-nowrap">날짜</th>
                    <th className="px-3 py-2 text-left font-medium">원천</th>
                    <th className="px-3 py-2 text-right font-medium whitespace-nowrap">일수</th>
                  </tr>
                </thead>
                <tbody>
                  {accrualRows.length === 0 ? (
                    <tr><td colSpan={4} className="px-3 py-4 text-center text-muted">내역 없음</td></tr>
                  ) : accrualFYGroups.map(([fy, entries]) => {
                    const sub    = entries.reduce((s, a) => s + a.days, 0)
                    const isOpen = expandedAccrualFYs.has(fy)
                    return (
                      <Fragment key={fy}>
                        <tr
                          className="bg-slate-100/70 border-y border-border/60 cursor-pointer select-none hover:bg-slate-200/60 transition-colors"
                          onClick={() => toggleAccrualFY(fy)}
                        >
                          <td colSpan={4} className="px-3 py-1.5">
                            <span className="flex items-center gap-1.5 text-[11px] font-semibold text-muted tracking-wide">
                              {isOpen
                                ? <ChevronDown size={12} className="shrink-0" />
                                : <ChevronRight size={12} className="shrink-0" />}
                              {fyRangeLabel(fy)}
                              {!isOpen && <span className="ml-auto font-semibold text-purple-700">+{sub}</span>}
                            </span>
                          </td>
                        </tr>
                        {isOpen && entries.map(a => (
                          <tr key={a.id} className="hover:bg-surface-50 border-b border-border/40">
                            <td className="px-3 py-2"><span className="pill bg-purple-100 text-purple-700 text-[10px]">{a.type}</span></td>
                            <td className="px-3 py-2 font-mono text-[11px]">{a.date}</td>
                            <td className="px-3 py-2 text-muted">
                              {a.note || (a.sourceId ? (workItemById.get(a.sourceId)?.client || workItemById.get(a.sourceId)?.name) : null) || '—'}
                            </td>
                            <td className="px-3 py-2 text-right font-semibold text-purple-700">+{a.days}</td>
                          </tr>
                        ))}
                        {isOpen && (
                          <tr className="bg-surface-50/80 border-b border-border">
                            <td colSpan={3} className="px-3 py-1.5 text-[11px] text-right text-muted">소계</td>
                            <td className="px-3 py-1.5 text-right text-[11px] font-semibold text-purple-700">+{sub}</td>
                          </tr>
                        )}
                      </Fragment>
                    )
                  })}
                </tbody>
                <tfoot>
                  <tr className="bg-surface-50 border-t-2 border-border">
                    <td colSpan={3} className="px-3 py-2 text-xs font-semibold text-gray-700">팀 정당 적립 합계</td>
                    <td className="px-3 py-2 text-right font-bold text-purple-700">{result.teamAccrued}일</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </section>

          {/* ③ 휴가 사용 내역 */}
          <section>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-xs font-semibold text-gray-700">③ 휴가 사용 내역 <span className="text-muted font-normal">(유급 — 무급리프레시·휴직 제외)</span></h3>
              {usageFYGroups.length > 0 && (
                <button
                  onClick={() => setExpandedUsageFYs(
                    expandedUsageFYs.size === usageFYGroups.length
                      ? new Set()
                      : new Set(usageFYGroups.map(([fy]) => fy))
                  )}
                  className="text-[11px] text-brand-600 hover:underline"
                >
                  {expandedUsageFYs.size === usageFYGroups.length ? '전체 접기' : '전체 펼치기'}
                </button>
              )}
            </div>
            <div className="card p-0 overflow-hidden">
              <table className="w-full text-xs">
                <colgroup>
                  <col className="w-40" />
                  <col className="w-36" />
                  <col />
                  <col className="w-14" />
                </colgroup>
                <thead>
                  <tr className="bg-surface-50 border-b border-border text-muted">
                    <th className="px-3 py-2 text-left font-medium whitespace-nowrap">기간</th>
                    <th className="px-3 py-2 text-left font-medium">유형</th>
                    <th className="px-3 py-2 text-left font-medium">FIFO 차감 원천</th>
                    <th className="px-3 py-2 text-right font-medium whitespace-nowrap">일수</th>
                  </tr>
                </thead>
                <tbody>
                  {paidUsages.length === 0 ? (
                    <tr><td colSpan={4} className="px-3 py-4 text-center text-muted">내역 없음</td></tr>
                  ) : usageFYGroups.map(([fy, entries]) => {
                    const sub    = entries.reduce((s, u) => s + u.days, 0)
                    const isOpen = expandedUsageFYs.has(fy)
                    return (
                      <Fragment key={fy}>
                        <tr
                          className="bg-slate-100/70 border-y border-border/60 cursor-pointer select-none hover:bg-slate-200/60 transition-colors"
                          onClick={() => toggleUsageFY(fy)}
                        >
                          <td colSpan={4} className="px-3 py-1.5">
                            <span className="flex items-center gap-1.5 text-[11px] font-semibold text-muted tracking-wide">
                              {isOpen
                                ? <ChevronDown size={12} className="shrink-0" />
                                : <ChevronRight size={12} className="shrink-0" />}
                              {fyRangeLabel(fy)}
                              {!isOpen && <span className="ml-auto font-semibold text-gray-700">−{sub}</span>}
                            </span>
                          </td>
                        </tr>
                        {isOpen && entries.map(u => (
                          <tr key={u.assignmentId} className="hover:bg-surface-50 border-b border-border/40">
                            <td className="px-3 py-2 font-mono text-[11px] whitespace-nowrap">
                              {u.start === u.end ? u.start : `${u.start}~${u.end}`}
                            </td>
                            <td className="px-3 py-2"><span className="pill bg-amber-100 text-amber-700 text-[10px]">{u.type}</span></td>
                            <td className="px-3 py-2 text-muted text-[10px]">
                              {deductionSummary(u.deductions, accrualById, workItemById)}
                            </td>
                            <td className="px-3 py-2 text-right font-semibold text-gray-800">−{u.days}</td>
                          </tr>
                        ))}
                        {isOpen && (
                          <tr className="bg-surface-50/80 border-b border-border">
                            <td colSpan={3} className="px-3 py-1.5 text-[11px] text-right text-muted">소계</td>
                            <td className="px-3 py-1.5 text-right text-[11px] font-semibold text-gray-800">−{sub}</td>
                          </tr>
                        )}
                      </Fragment>
                    )
                  })}
                </tbody>
                <tfoot>
                  <tr className="bg-surface-50 border-t-2 border-border">
                    <td colSpan={3} className="px-3 py-2 text-xs font-semibold text-gray-700">총 유급 사용 합계</td>
                    <td className="px-3 py-2 text-right font-bold text-gray-800">{result.totalUsed}일</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </section>

          {/* 정산 요약 */}
          <section>
            <h3 className="text-xs font-semibold text-gray-700 mb-2">정산 요약</h3>
            <div className="rounded-lg border border-border overflow-hidden divide-y divide-border">
              <div className="px-4 py-3 bg-surface-50 space-y-1.5">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className={`text-xs ${result.entitlementBasis !== 'team' ? 'font-semibold text-brand-700' : 'text-gray-500'}`}>
                      (a) 법정연차+주말/휴일대체+특별휴가
                    </span>
                    <span className="text-[10px] text-muted tabular-nums">({result.statutory}+{result.weekendSub}+{result.specialLeave}일)</span>
                    {result.entitlementBasis !== 'team' && (
                      <span className="pill bg-brand-100 text-brand-700 text-[10px]">채택</span>
                    )}
                  </div>
                  <span className={`text-sm tabular-nums ${result.entitlementBasis !== 'team' ? 'font-bold text-brand-700' : 'text-gray-400'}`}>
                    {result.candidateA}일
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <span className={`text-xs ${result.entitlementBasis === 'team' ? 'font-semibold text-purple-700' : 'text-gray-500'}`}>
                      (b) 팀 정당 적립 합
                    </span>
                    {result.entitlementBasis === 'team' && (
                      <span className="pill bg-purple-100 text-purple-700 text-[10px]">채택</span>
                    )}
                  </div>
                  <span className={`text-sm tabular-nums ${result.entitlementBasis === 'team' ? 'font-bold text-purple-700' : 'text-gray-400'}`}>
                    {result.teamAccrued}일
                  </span>
                </div>
              </div>
              <div className="px-4 py-3 flex items-center justify-between">
                <span className="text-xs font-semibold text-gray-700">총 휴가 권리 <span className="text-muted font-normal text-[10px]">max(a, b)</span></span>
                <span className="text-base font-bold text-gray-900 tabular-nums">{result.totalEntitlement}일</span>
              </div>
              <div className="px-4 py-3 flex items-center justify-between">
                <span className="text-xs text-gray-700">총 유급 사용 ③</span>
                <span className="text-sm font-semibold text-gray-800 tabular-nums">−{result.totalUsed}일</span>
              </div>
              {result.excess > 0 && (
                <div className="px-4 py-3 flex items-center justify-between bg-red-50">
                  <span className="text-xs font-medium text-red-700">초과 사용분 (퇴사 시 차감)</span>
                  <span className="text-sm font-bold text-red-700 tabular-nums">−{result.excess}일</span>
                </div>
              )}
              {result.shortfall > 0 && (
                <div className="px-4 py-3 flex items-center justify-between bg-emerald-50">
                  <span className="text-xs font-medium text-emerald-700">미달 보상분 (퇴사 시 보상)</span>
                  <span className="text-sm font-bold text-emerald-700 tabular-nums">+{result.shortfall}일</span>
                </div>
              )}
              {result.excess === 0 && result.shortfall === 0 && (
                <div className="px-4 py-3 flex items-center justify-between bg-surface-50">
                  <span className="text-xs text-muted">초과/미달 없음 (권리 = 사용)</span>
                </div>
              )}
              <div className={`px-4 py-4 flex items-center justify-between ${result.netSettlement > 0 ? 'bg-emerald-100' : result.netSettlement < 0 ? 'bg-red-100' : 'bg-surface-100'}`}>
                <span className="text-sm font-bold text-gray-900">최종 정산</span>
                <span className={`text-2xl font-bold tabular-nums ${result.netSettlement > 0 ? 'text-emerald-700' : result.netSettlement < 0 ? 'text-red-700' : 'text-muted'}`}>
                  {result.netSettlement > 0 ? '+' : ''}{result.netSettlement}<span className="text-sm font-normal ml-0.5">일</span>
                </span>
              </div>
            </div>
          </section>
        </>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// Tab 3: 수치 안내
// ─────────────────────────────────────────────────────────────

function TimesheetTab({ person }: { person: Person }) {
  const todayStr   = numToStr(today())
  const todayYear  = parseInt(todayStr.slice(0, 4), 10)
  const todayMonth = parseInt(todayStr.slice(5, 7), 10)
  const currentFY  = todayMonth >= 7 ? todayYear + 1 : todayYear

  const fyOptions: number[] = []
  for (let fy = 2022; fy <= currentFY + 1; fy++) fyOptions.push(fy)

  const [selectedFY, setSelectedFY] = useState(currentFY)

  const fyEnd   = `${selectedFY}-06-30`
  const asOfStr = todayStr <= fyEnd ? todayStr : fyEnd

  const { isLoading, ledger, adjustments } = usePersonData(person.id, asOfStr, person.rank)

  const figures = useMemo(() => {
    if (!ledger) return null
    return computeTimesheetFigures(asOfStr, {
      hireDate:    person.hire_date ?? undefined,
      adjustments,
      usages:      ledger.usages,
      accruals:    ledger.accruals,
      fyLabel:     selectedFY,
    })
  }, [ledger, adjustments, asOfStr, person.hire_date, selectedFY])

  const fyYY = String(selectedFY).slice(-2)

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        <label className="text-xs font-medium text-gray-700">회계연도</label>
        <select
          className="input py-1 text-xs w-28"
          value={selectedFY}
          onChange={e => setSelectedFY(parseInt(e.target.value, 10))}
        >
          {fyOptions.map(fy => (
            <option key={fy} value={fy}>FY{String(fy).slice(-2)}</option>
          ))}
        </select>
        <span className="text-xs text-muted">
          {selectedFY - 1}.07 ~ {selectedFY}.06
        </span>
      </div>

      <div className="rounded-md border border-border bg-surface-50 px-4 py-2 text-xs text-muted flex items-start gap-2">
        <AlertTriangle size={12} className="flex-shrink-0 mt-0.5" />
        <span>
          아래 4개 수치를 참고해 담당자가 직접 타임시트 코드를 판단·입력하세요.
          시스템은 일자별 코드를 자동 산출하지 않습니다.
        </span>
      </div>

      {(isLoading || !figures) ? (
        <div className="flex items-center justify-center py-12 text-muted text-sm">
          <Loader2 size={20} className="animate-spin mr-2" /> 계산 중…
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3">
          <FigureCard
            num="①"
            label={`FY${fyYY} 법정연차·신입사원 휴가 누적`}
            value={figures.statutoryThisYear}
            hint={`FY${fyYY}(${selectedFY - 1}.07~${selectedFY}.06) 발생분 합 + 보정 (7/1 리셋, 이월 없음)`}
          />
          <FigureCard
            num="②"
            label={`FY${fyYY} 프로젝트휴가 사용분`}
            value={figures.projectLeaveUsed}
            hint={`FY${fyYY} 기간 중 프로젝트휴가 유형 사용 영업일수`}
          />
          <FigureCard
            num="③"
            label={`FY${fyYY} 지정휴가 중 프로젝트휴가 원천`}
            value={figures.designatedFromProject}
            hint={`FY${fyYY} 지정휴가 사용 중 FIFO 차감 원천이 프로젝트휴가인 일수`}
          />
          <FigureCard
            num="④"
            label={`FY${fyYY} 지정휴가 선사용분`}
            value={figures.designatedShortfall}
            hint={`FY${fyYY} 마지막 지정휴가 사용 시점의 FIFO shortfall (적립 부족분 선사용)`}
            warn={figures.designatedShortfall > 0}
          />
        </div>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// Small UI helpers
// ─────────────────────────────────────────────────────────────

function FigureCard({ num, label, value, hint, warn }: { num: string; label: string; value: number; hint: string; warn?: boolean }) {
  return (
    <div className={`rounded-lg border p-4 ${warn && value > 0 ? 'border-amber-200 bg-amber-50' : 'border-border bg-surface-50'}`}>
      <div className="flex items-start gap-2 mb-2">
        <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-brand-100 text-brand-700 text-[10px] font-bold flex-shrink-0 mt-0.5">{num}</span>
        <p className="text-xs font-semibold text-gray-800 leading-tight">{label}</p>
      </div>
      <p className={`text-2xl font-bold tabular-nums ml-7 ${warn && value > 0 ? 'text-amber-700' : 'text-gray-900'}`}>{value}<span className="text-sm font-normal ml-0.5">일</span></p>
      <p className="text-[10px] text-muted mt-1 ml-7">{hint}</p>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// Main export
// ─────────────────────────────────────────────────────────────

type SubTab = 'adjustments' | 'settlement' | 'timesheetfigs'

const PERSON_TABS: { id: SubTab; label: string }[] = [
  { id: 'adjustments',   label: '적립 관리' },
  { id: 'settlement',    label: '연차 정산' },
  { id: 'timesheetfigs', label: '수치 안내' },
]

export default function AnnualLeavePanel() {
  const [selectedPerson, setSelectedPerson] = useState<Person | null>(null)
  const [subTab, setSubTab] = useState<SubTab>('adjustments')
  const { isAssistant } = useAuthz()
  const readOnly = isAssistant()

  return (
    <div className="flex h-full flex-col">
      {readOnly && (
        <div className="flex items-center gap-2 px-4 py-2 bg-purple-50 border-b border-purple-200 text-xs text-purple-700 flex-shrink-0">
          <Eye size={12} className="flex-shrink-0" />
          <span>조회 전용 — assistant 계정은 편집 기능을 사용할 수 없습니다.</span>
        </div>
      )}

      <div className="flex flex-col flex-1 overflow-hidden">
        {/* Sub-tab bar */}
        <div className="flex gap-0 border-b border-border px-6 pt-2 flex-shrink-0">
          {PERSON_TABS.map(t => (
            <button key={t.id} onClick={() => setSubTab(t.id)}
              className={[
                'px-4 py-2 text-sm font-medium whitespace-nowrap transition-colors',
                subTab === t.id
                  ? 'border-b-2 border-brand-600 text-brand-700'
                  : 'text-muted hover:text-gray-900',
              ].join(' ')}>
              {t.label}
            </button>
          ))}
        </div>

        <div className="flex flex-1 overflow-hidden">
          <PersonSelector
            selected={selectedPerson}
            onSelect={p => setSelectedPerson(p)}
          />
          <div className="flex-1 flex flex-col overflow-hidden">
            {!selectedPerson ? (
              <div className="flex items-center justify-center h-full text-muted text-sm">
                왼쪽에서 인력을 선택하세요.
              </div>
            ) : (
              <>
                {/* Person header */}
                <div className="border-b border-border px-6 py-3 flex items-center gap-3">
                  <div>
                    <p className="text-sm font-semibold text-gray-900">{selectedPerson.name}</p>
                    <p className="text-xs text-muted">
                      {selectedPerson.rank}
                      {selectedPerson.status === 'resigned' && <span className="ml-1 text-red-500">(퇴사)</span>}
                    </p>
                  </div>
                  {selectedPerson.status === 'resigned' ? (
                    <span className="pill bg-red-100 text-red-700 text-[10px] ml-auto">퇴사자</span>
                  ) : (
                    <span className="pill bg-emerald-100 text-emerald-700 text-[10px] ml-auto">재직 중</span>
                  )}
                </div>

                {/* Tab content */}
                <div className="flex-1 overflow-auto p-6 max-w-7xl">
                  {subTab === 'adjustments'   && <AdjustmentsTab person={selectedPerson} readOnly={readOnly} />}
                  {subTab === 'settlement'    && <SettlementTab person={selectedPerson} />}
                  {subTab === 'timesheetfigs' && <TimesheetTab person={selectedPerson} />}
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
