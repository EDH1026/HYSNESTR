/**
 * AnnualLeavePanel — §5.13 연차 관리 (editor/admin 전용)
 *
 * 탭: 적립 관리 | 퇴사 정산 | 수치 안내
 */
import { useState, useMemo, useCallback, type FormEvent } from 'react'
import { Plus, Trash2, Loader2, AlertTriangle, CheckCircle2, Info } from 'lucide-react'
import { computeLedger, buildHolidaySet } from '@/features/leave/ledger'
import { computeSettlement, computeTimesheetFigures } from './annualLeave'
import {
  useGrantsByPerson,
  useUpsertGrant,
  useDeleteGrant,
  useAdjustmentsByPerson,
  useCreateAdjustment,
  useDeleteAdjustment,
} from './hooks'
import { useAssignmentsByPerson } from '@/features/timeline/hooks'
import { useAccrualsByPerson }    from '@/features/leave/hooks'
import { useAllWorkItems }        from '@/features/workitems/hooks'
import { useAllHolidays }         from '@/features/admin/hooks'
import { useAllPeople }           from '@/features/people/hooks'
import { dateToNum, numToStr, today } from '@/lib/date'
import type { Person, AnnualLeaveGrant, AnnualLeaveAdjustment } from '@/types'

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
  const [query, setQuery] = useState('')

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    // include all people (active + resigned), sorted by name
    return people
      .filter(p => !q || p.name.toLowerCase().includes(q) || (p.rank ?? '').toLowerCase().includes(q))
      .sort((a, b) => a.name.localeCompare(b.name, 'ko'))
  }, [people, query])

  return (
    <div className="w-56 flex-shrink-0 border-r border-border flex flex-col h-full">
      <div className="px-3 pt-4 pb-2 border-b border-border">
        <input
          className="input py-1 text-xs w-full"
          placeholder="이름 검색…"
          value={query}
          onChange={e => setQuery(e.target.value)}
        />
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
// Tab 1: 적립 관리
// ─────────────────────────────────────────────────────────────

function GrantsTab({ person }: { person: Person }) {
  const { data: grants = [],      isLoading: lgA } = useGrantsByPerson(person.id)
  const { data: adjustments = [], isLoading: lgB } = useAdjustmentsByPerson(person.id)
  const upsertGrant     = useUpsertGrant()
  const deleteGrant     = useDeleteGrant()
  const createAdj       = useCreateAdjustment()
  const deleteAdj       = useDeleteAdjustment()

  const [editGrant, setEditGrant] = useState<AnnualLeaveGrant | null>(null)
  const [grantForm, setGrantForm] = useState({ year: String(new Date().getFullYear()), days: '', note: '' })
  const [grantErr,  setGrantErr]  = useState<string | null>(null)
  const [showAddGrant, setShowAddGrant] = useState(false)

  const [adjForm, setAdjForm] = useState({ direction: 'accrual' as 'accrual' | 'usage', days: '', date: numToStr(today()), note: '' })
  const [adjErr,  setAdjErr]  = useState<string | null>(null)
  const [showAddAdj, setShowAddAdj] = useState(false)

  const isLoading = lgA || lgB

  async function handleGrantSubmit(e: FormEvent) {
    e.preventDefault()
    const year = parseInt(grantForm.year, 10)
    const days = parseFloat(grantForm.days)
    if (isNaN(year) || year < 2000) { setGrantErr('연도를 입력하세요 (예: 2024)'); return }
    if (isNaN(days) || days < 0) { setGrantErr('0 이상의 일수를 입력하세요'); return }
    setGrantErr(null)
    try {
      await upsertGrant.mutateAsync({ id: editGrant?.id, person_id: person.id, year, days, note: grantForm.note || null })
      setShowAddGrant(false); setEditGrant(null); setGrantForm({ year: String(new Date().getFullYear()), days: '', note: '' })
    } catch (e) { setGrantErr(e instanceof Error ? e.message : '저장 실패') }
  }

  function startEditGrant(g: AnnualLeaveGrant) {
    setEditGrant(g)
    setGrantForm({ year: String(g.year), days: String(g.days), note: g.note ?? '' })
    setShowAddGrant(true)
  }

  async function handleAdjSubmit(e: FormEvent) {
    e.preventDefault()
    const days = parseFloat(adjForm.days)
    if (isNaN(days) || days === 0) { setAdjErr('0이 아닌 값을 입력하세요'); return }
    if (!adjForm.date) { setAdjErr('날짜를 선택하세요'); return }
    setAdjErr(null)
    try {
      await createAdj.mutateAsync({ person_id: person.id, direction: adjForm.direction, days, date: adjForm.date, note: adjForm.note || null })
      setShowAddAdj(false); setAdjForm({ direction: 'accrual', days: '', date: numToStr(today()), note: '' })
    } catch (e) { setAdjErr(e instanceof Error ? e.message : '저장 실패') }
  }

  if (isLoading) return <div className="flex justify-center py-12"><Loader2 size={20} className="animate-spin text-muted" /></div>

  return (
    <div className="space-y-8">
      {/* Grants section */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <div>
            <h3 className="text-sm font-semibold text-gray-800">법정연차 적립</h3>
            <p className="text-xs text-muted">역년(1월 1일) 기준, 이월 없음</p>
          </div>
          {!showAddGrant && (
            <button onClick={() => { setShowAddGrant(true); setEditGrant(null); setGrantForm({ year: String(new Date().getFullYear()), days: '', note: '' }) }}
              className="btn-secondary text-xs py-0.5 gap-1"><Plus size={11} /> 연도 추가</button>
          )}
        </div>

        {showAddGrant && (
          <form onSubmit={handleGrantSubmit} className="rounded-md border border-brand-200 bg-brand-50 p-3 space-y-3 mb-3">
            <p className="text-xs font-semibold text-brand-800">{editGrant ? '적립 수정' : '연도별 적립 추가'}</p>
            <div className="grid grid-cols-3 gap-2">
              <div>
                <label className="mb-0.5 block text-xs text-gray-600">연도</label>
                <input required type="number" min="2000" max="2100" className="input py-1 text-xs"
                  value={grantForm.year} onChange={e => setGrantForm(f => ({ ...f, year: e.target.value }))} />
              </div>
              <div>
                <label className="mb-0.5 block text-xs text-gray-600">일수</label>
                <input required type="number" step="0.5" min="0" className="input py-1 text-xs"
                  placeholder="예: 15"
                  value={grantForm.days} onChange={e => setGrantForm(f => ({ ...f, days: e.target.value }))} />
              </div>
              <div>
                <label className="mb-0.5 block text-xs text-gray-600">비고</label>
                <input type="text" className="input py-1 text-xs" placeholder="선택"
                  value={grantForm.note} onChange={e => setGrantForm(f => ({ ...f, note: e.target.value }))} />
              </div>
            </div>
            {grantErr && <p className="text-xs text-red-600">{grantErr}</p>}
            <div className="flex gap-2">
              <button type="submit" disabled={upsertGrant.isPending} className="btn-primary text-xs py-1 flex-1">
                {upsertGrant.isPending ? <Loader2 size={11} className="animate-spin" /> : '저장'}
              </button>
              <button type="button" onClick={() => { setShowAddGrant(false); setEditGrant(null) }} className="btn-secondary text-xs py-1">취소</button>
            </div>
          </form>
        )}

        {grants.length === 0 ? (
          <p className="text-xs text-muted text-center py-4">적립 내역 없음</p>
        ) : (
          <div className="card p-0 overflow-hidden">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-surface-50 border-b border-border text-muted">
                  <th className="px-3 py-2 text-left font-medium">연도</th>
                  <th className="px-3 py-2 text-right font-medium">일수</th>
                  <th className="px-3 py-2 text-left font-medium">비고</th>
                  <th className="px-2 py-2 w-16 text-center font-medium">작업</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {grants.map(g => (
                  <tr key={g.id} className="hover:bg-surface-50">
                    <td className="px-3 py-2 font-medium">{g.year}년</td>
                    <td className="px-3 py-2 text-right font-semibold text-brand-700">{g.days}일</td>
                    <td className="px-3 py-2 text-muted">{g.note ?? '—'}</td>
                    <td className="px-2 py-2 text-center">
                      <button onClick={() => startEditGrant(g)} className="rounded px-1.5 py-0.5 text-[10px] text-brand-600 hover:bg-brand-50 mr-1">수정</button>
                      <button onClick={() => { if (confirm('삭제할까요?')) deleteGrant.mutate({ id: g.id, personId: person.id }) }}
                        className="rounded p-1 text-muted hover:text-red-600 hover:bg-red-50 transition-colors">
                        <Trash2 size={11} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Adjustments section */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <div>
            <h3 className="text-sm font-semibold text-gray-800">수동 보정</h3>
            <p className="text-xs text-muted">특이사항에 따른 +/- 조정 (사유 기재 권장)</p>
          </div>
          {!showAddAdj && (
            <button onClick={() => setShowAddAdj(true)} className="btn-secondary text-xs py-0.5 gap-1"><Plus size={11} /> 보정 추가</button>
          )}
        </div>

        {showAddAdj && (
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
                  <th className="px-2 py-2 w-8" />
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
                    <td className="px-2 py-2">
                      <button onClick={() => { if (confirm('삭제할까요?')) deleteAdj.mutate({ id: a.id, personId: person.id }) }}
                        className="rounded p-1 text-muted hover:text-red-600 hover:bg-red-50 transition-colors">
                        <Trash2 size={11} />
                      </button>
                    </td>
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

function usePersonData(personId: string, asOfStr: string) {
  const { data: assignments = [], isLoading: la } = useAssignmentsByPerson(personId)
  const { data: accruals   = [], isLoading: lb } = useAccrualsByPerson(personId)
  const { data: workItems  = [], isLoading: lw } = useAllWorkItems()
  const { data: holidays   = [], isLoading: lh } = useAllHolidays()
  const { data: grants     = [], isLoading: lg } = useGrantsByPerson(personId)
  const { data: adjustments= [], isLoading: lj } = useAdjustmentsByPerson(personId)

  const isLoading = la || lb || lw || lh || lg || lj

  const holidaySet = useMemo(() => {
    const yr = new Date().getFullYear()
    return buildHolidaySet(holidays, yr - 5, yr + 5)
  }, [holidays])

  const isHoliday = useCallback((n: number) => holidaySet.has(n), [holidaySet])

  const asOf = useMemo(() => dateToNum(asOfStr), [asOfStr])

  const ledger = useMemo(() => {
    if (isLoading) return null
    return computeLedger(personId, { workItems, assignments, accruals, isHoliday, today: asOf })
  }, [personId, workItems, assignments, accruals, isHoliday, asOf, isLoading])

  return { isLoading, ledger, grants, adjustments }
}

// ─────────────────────────────────────────────────────────────
// Tab 2: 퇴사 정산
// ─────────────────────────────────────────────────────────────

function SettlementTab({ person }: { person: Person }) {
  const [asOfStr, setAsOfStr] = useState(numToStr(today()))
  const { isLoading, ledger, grants, adjustments } = usePersonData(person.id, asOfStr)

  const result = useMemo(() => {
    if (!ledger) return null
    return computeSettlement(asOfStr, {
      grants,
      adjustments,
      teamActualAccrued: ledger.actualAccrued,
      totalPaidUsed:     ledger.actualUsed,
    })
  }, [ledger, grants, adjustments, asOfStr])

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        <label className="text-xs font-medium text-gray-700">기준일 (퇴사 예정일)</label>
        <input type="date" className="input py-1 text-xs w-36"
          value={asOfStr} onChange={e => setAsOfStr(e.target.value)} />
      </div>

      {(isLoading || !result) ? (
        <div className="flex items-center justify-center py-12 text-muted text-sm">
          <Loader2 size={20} className="animate-spin mr-2" /> 계산 중…
        </div>
      ) : (
        <>
          <div className={`rounded-md border px-4 py-2 text-xs flex items-center gap-2 ${result.entitlementBasis === 'statutory' ? 'border-brand-200 bg-brand-50 text-brand-800' : result.entitlementBasis === 'team' ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-border bg-surface-50 text-gray-700'}`}>
            <Info size={13} className="flex-shrink-0" />
            <span>
              총 휴가 권리 기준: <strong>{result.entitlementBasis === 'statutory' ? '법정연차 누적' : result.entitlementBasis === 'team' ? '팀 정당 적립' : '법정연차 = 팀 적립 (동일)'}</strong>
              {' '}({result.totalEntitlement}일)
            </span>
          </div>

          <div className="card p-0 overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-surface-50 border-b border-border text-muted">
                  <th className="px-4 py-2 text-left text-xs font-medium w-8">#</th>
                  <th className="px-4 py-2 text-left text-xs font-medium">항목</th>
                  <th className="px-4 py-2 text-right text-xs font-medium">값 (일)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border text-sm">
                <Row n="①" label="법정연차 누적" value={result.statutory} hint="grants 합 + 보정 합 (기준일 역년 이하)" />
                <Row n="②" label="팀 정당 적립 누적" value={result.teamAccrued} hint="computeLedger actualAccrued (기준일까지)" />
                <Row n="③" label="총 휴가 권리 (max)" value={result.totalEntitlement} bold hint={`max(①, ②) = ${result.entitlementBasis === 'statutory' ? '법정연차 기준' : result.entitlementBasis === 'team' ? '팀 적립 기준' : '동일'}`} />
                <Row n="④" label="법정연차 소진 일수" value={'N/A'} hint="타임시트 매핑 미구현 (AL-7)" dim />
                <Row n="⑤" label="초과 사용분 (차감)" value={result.excess} hint="max(0, 총 사용 − 총 권리)" color={result.excess > 0 ? 'red' : undefined} />
                <Row n="⑥" label="미달 보상분 (보상)" value={result.shortfall} hint="max(0, 총 권리 − 총 사용)" color={result.shortfall > 0 ? 'green' : undefined} />
                <Row n="⑦" label="최종 정산" value={result.netSettlement} bold hint="⑥ − ⑤  (+= 보상 / −= 차감)" color={result.netSettlement > 0 ? 'green' : result.netSettlement < 0 ? 'red' : undefined} />
              </tbody>
            </table>
          </div>

          <div className="text-xs text-muted">
            ※ 총 유급 사용(기준일까지) = <strong>{result.totalUsed}일</strong>
          </div>
        </>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// Tab 3: 수치 안내
// ─────────────────────────────────────────────────────────────

function TimesheetTab({ person }: { person: Person }) {
  const [asOfStr, setAsOfStr] = useState(numToStr(today()))
  const { isLoading, ledger, grants, adjustments } = usePersonData(person.id, asOfStr)

  const figures = useMemo(() => {
    if (!ledger) return null
    return computeTimesheetFigures(asOfStr, {
      grants,
      adjustments,
      usages:   ledger.usages,
      accruals: ledger.accruals,
    })
  }, [ledger, grants, adjustments, asOfStr])

  const asOfYear = parseInt(asOfStr.slice(0, 4), 10)

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        <label className="text-xs font-medium text-gray-700">기준일</label>
        <input type="date" className="input py-1 text-xs w-36"
          value={asOfStr} onChange={e => setAsOfStr(e.target.value)} />
      </div>

      <div className="rounded-md border border-border bg-surface-50 px-4 py-2 text-xs text-muted flex items-start gap-2">
        <AlertTriangle size={12} className="flex-shrink-0 mt-0.5" />
        <span>일자별 타임시트 코드 자동 매핑은 미구현(AL-7). 아래 수치를 참고해 담당자가 직접 판단·입력하세요.</span>
      </div>

      {(isLoading || !figures) ? (
        <div className="flex items-center justify-center py-12 text-muted text-sm">
          <Loader2 size={20} className="animate-spin mr-2" /> 계산 중…
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3">
          <FigureCard
            num="①"
            label={`${asOfYear}년 법정연차 누적`}
            value={figures.statutoryThisYear}
            hint="해당 역년 grants + 보정 (1/1 리셋, 이월 없음)"
          />
          <FigureCard
            num="②"
            label="프로젝트휴가 기 사용분"
            value={figures.projectLeaveUsed}
            hint="기준일까지 프로젝트휴가 유형 사용 영업일수"
          />
          <FigureCard
            num="③"
            label="지정휴가 중 프로젝트휴가 원천"
            value={figures.designatedFromProject}
            hint="지정휴가 사용 중 FIFO 차감 원천이 프로젝트휴가인 일수"
          />
          <FigureCard
            num="④"
            label="지정휴가 선사용분"
            value={figures.designatedShortfall}
            hint="지정휴가 FIFO shortfall 합 (적립 부족분 선사용)"
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

function Row({
  n, label, value, hint, bold, dim, color,
}: {
  n: string; label: string; value: number | string; hint?: string; bold?: boolean; dim?: boolean; color?: 'red' | 'green'
}) {
  const valCls = color === 'red' ? 'text-red-700 font-semibold' : color === 'green' ? 'text-emerald-700 font-semibold' : dim ? 'text-muted' : bold ? 'font-bold text-gray-900' : 'text-gray-800'
  return (
    <tr className="hover:bg-surface-50">
      <td className="px-4 py-2.5 text-muted text-xs">{n}</td>
      <td className="px-4 py-2.5">
        <span className={bold ? 'font-semibold text-gray-900' : dim ? 'text-muted' : 'text-gray-800'}>{label}</span>
        {hint && <span className="block text-[10px] text-muted/70 mt-0.5">{hint}</span>}
      </td>
      <td className={`px-4 py-2.5 text-right ${valCls}`}>
        {typeof value === 'number' ? `${value}일` : value}
      </td>
    </tr>
  )
}

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

type SubTab = 'grants' | 'settlement' | 'timesheetfigs'

const SUB_TABS: { id: SubTab; label: string }[] = [
  { id: 'grants',      label: '적립 관리' },
  { id: 'settlement',  label: '퇴사 정산' },
  { id: 'timesheetfigs', label: '수치 안내' },
]

export default function AnnualLeavePanel() {
  const [selectedPerson, setSelectedPerson] = useState<Person | null>(null)
  const [subTab, setSubTab] = useState<SubTab>('grants')

  return (
    <div className="flex h-full">
      <PersonSelector selected={selectedPerson} onSelect={p => { setSelectedPerson(p); setSubTab('grants') }} />

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

            {/* Sub-tab bar */}
            <div className="flex gap-0 border-b border-border px-6 pt-2">
              {SUB_TABS.map(t => (
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

            {/* Tab content */}
            <div className="flex-1 overflow-auto p-6 max-w-3xl">
              {subTab === 'grants'       && <GrantsTab person={selectedPerson} />}
              {subTab === 'settlement'   && <SettlementTab person={selectedPerson} />}
              {subTab === 'timesheetfigs' && <TimesheetTab person={selectedPerson} />}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
