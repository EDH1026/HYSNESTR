/**
 * AnnualLeavePanel — §5.13 연차 관리
 * - editor/admin: 전체 편집 가능
 * - assistant: 조회 전용 (편집 컨트롤 숨김, RLS로도 차단)
 *
 * 탭: 적립 관리 | 퇴사 정산 | 수치 안내
 */
import { useState, useMemo, useCallback, type FormEvent } from 'react'
import { Plus, Trash2, Loader2, AlertTriangle, Eye, Download } from 'lucide-react'
import { useAuthz } from '@/hooks/useAuthz'
import { computeLedger, buildHolidaySet } from '@/features/leave/ledger'
import type { LedgerAccrualEntry, LedgerUsageEntry } from '@/features/leave/ledger'
import { computeAnnualLeaveSettlement, computeTimesheetFigures } from './annualLeave'
import type { AnnualLeaveSettlementResult } from './annualLeave'
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
import FilterChip from '@/components/FilterChip'
import type { Person, Rank, WorkItem, AnnualLeaveGrant, AnnualLeaveAdjustment } from '@/types'

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

  // LeavePage(LV-2)와 동일한 필터 상태 — 기본값: 재직만
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
      const q = nameSearch.toLowerCase()
      out = out.filter(p => p.name.toLowerCase().includes(q))
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
      {/* 필터 영역 — LeavePage(LV-2)와 동일한 FilterChip 사용 */}
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
// Tab 1: 적립 관리
// ─────────────────────────────────────────────────────────────

function GrantsTab({ person, readOnly }: { person: Person; readOnly: boolean }) {
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
          {!readOnly && !showAddGrant && (
            <button onClick={() => { setShowAddGrant(true); setEditGrant(null); setGrantForm({ year: String(new Date().getFullYear()), days: '', note: '' }) }}
              className="btn-secondary text-xs py-0.5 gap-1"><Plus size={11} /> 연도 추가</button>
          )}
        </div>

        {!readOnly && showAddGrant && (
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
                  {!readOnly && <th className="px-2 py-2 w-16 text-center font-medium">작업</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {grants.map(g => (
                  <tr key={g.id} className="hover:bg-surface-50">
                    <td className="px-3 py-2 font-medium">{g.year}년</td>
                    <td className="px-3 py-2 text-right font-semibold text-brand-700">{g.days}일</td>
                    <td className="px-3 py-2 text-muted">{g.note ?? '—'}</td>
                    {!readOnly && (
                      <td className="px-2 py-2 text-center">
                        <button onClick={() => startEditGrant(g)} className="rounded px-1.5 py-0.5 text-[10px] text-brand-600 hover:bg-brand-50 mr-1">수정</button>
                        <button onClick={() => { if (confirm('삭제할까요?')) deleteGrant.mutate({ id: g.id, personId: person.id }) }}
                          className="rounded p-1 text-muted hover:text-red-600 hover:bg-red-50 transition-colors">
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

      {/* Adjustments section */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <div>
            <h3 className="text-sm font-semibold text-gray-800">수동 보정</h3>
            <p className="text-xs text-muted">특이사항에 따른 +/- 조정 (사유 기재 권장)</p>
          </div>
          {!readOnly && !showAddAdj && (
            <button onClick={() => setShowAddAdj(true)} className="btn-secondary text-xs py-0.5 gap-1"><Plus size={11} /> 보정 추가</button>
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
                        <button onClick={() => { if (confirm('삭제할까요?')) deleteAdj.mutate({ id: a.id, personId: person.id }) }}
                          className="rounded p-1 text-muted hover:text-red-600 hover:bg-red-50 transition-colors">
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

  return { isLoading, ledger, grants, adjustments, workItems }
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
  const byType: Record<string, { days: number; proj: string | null }> = {}
  for (const d of deductions) {
    const acc = accrualById.get(d.accrualId)
    if (!acc) continue
    if (!byType[acc.type]) {
      byType[acc.type] = {
        days: 0,
        proj: acc.sourceId ? (workItemById.get(acc.sourceId)?.name ?? null) : null,
      }
    }
    byType[acc.type].days += d.days
  }
  return Object.entries(byType)
    .map(([t, { days, proj }]) => proj ? `${t} ${days}일 (${proj})` : `${t} ${days}일`)
    .join(' / ')
}

// ─────────────────────────────────────────────────────────────
// AL-10: HTML export helpers
// ─────────────────────────────────────────────────────────────

function escHtml(v: unknown): string {
  return String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function triggerDownload(content: string, filename: string) {
  const blob = new Blob([content], { type: 'text/html;charset=utf-8' })
  const url  = URL.createObjectURL(blob)
  const a    = Object.assign(document.createElement('a'), { href: url, download: filename })
  document.body.appendChild(a); a.click(); document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

function generateSettlementHtml(
  person:       Person,
  asOfStr:      string,
  grantRows:    AnnualLeaveGrant[],
  adjRows:      AnnualLeaveAdjustment[],
  accrualRows:  LedgerAccrualEntry[],
  paidUsages:   LedgerUsageEntry[],
  result:       AnnualLeaveSettlementResult,
  workItemById: Map<string, WorkItem>,
  accrualById:  Map<string, LedgerAccrualEntry>,
): string {
  const generated = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })
  const isTeam    = result.entitlementBasis === 'team'

  const t1 = [
    ...grantRows.map(g => `<tr>
      <td><span class="pill pill-blue">법정연차</span></td>
      <td>${escHtml(g.year)}년</td>
      <td>${escHtml(g.note ?? '—')}</td>
      <td class="num pos">+${escHtml(g.days)}</td></tr>`),
    ...adjRows.map(a => `<tr>
      <td><span class="pill ${a.direction === 'accrual' ? 'pill-green' : 'pill-red'}">${a.direction === 'accrual' ? '보정+' : '보정−'}</span></td>
      <td class="mono">${escHtml(a.date)}</td>
      <td>${escHtml(a.note ?? '—')}</td>
      <td class="num ${a.direction === 'accrual' ? 'pos' : 'neg'}">${a.direction === 'accrual' ? '+' : '−'}${escHtml(Math.abs(a.days))}</td></tr>`),
  ]
  if (!t1.length) t1.push('<tr><td colspan="4" class="empty">내역 없음</td></tr>')

  const t2 = accrualRows.length
    ? accrualRows.map(a => `<tr>
      <td><span class="pill pill-purple">${escHtml(a.type)}</span></td>
      <td class="mono">${escHtml(a.date)}</td>
      <td>${a.sourceId ? escHtml(workItemById.get(a.sourceId)?.name ?? '—') : (!a.isAuto && a.note ? escHtml(a.note) : '—')}</td>
      <td class="num pos">+${escHtml(a.days)}</td></tr>`)
    : ['<tr><td colspan="4" class="empty">내역 없음</td></tr>']

  const t3 = paidUsages.length
    ? paidUsages.map(u => {
        const period  = u.start === u.end ? escHtml(u.start) : `${escHtml(u.start)}~${escHtml(u.end)}`
        const fifo    = escHtml(deductionSummary(u.deductions, accrualById, workItemById))
        const deficit = u.deficit > 0 ? ` <span class="neg">(선사용 ${escHtml(u.deficit)}일)</span>` : ''
        return `<tr>
      <td class="mono">${period}</td>
      <td><span class="pill pill-amber">${escHtml(u.type)}</span></td>
      <td>${fifo}${deficit}</td>
      <td class="num">−${escHtml(u.days)}</td></tr>`
      })
    : ['<tr><td colspan="4" class="empty">내역 없음</td></tr>']

  const netSign = result.netSettlement > 0 ? '+' : ''
  const excessRow   = result.excess    > 0 ? `<div class="summary-row err"><span>초과 사용분 (퇴사 시 차감)</span><span class="sv">−${result.excess}일</span></div>` : ''
  const shortfallRow= result.shortfall > 0 ? `<div class="summary-row ok"><span>미달 보상분 (퇴사 시 보상)</span><span class="sv">+${result.shortfall}일</span></div>` : ''
  const evenRow     = (result.excess === 0 && result.shortfall === 0) ? `<div class="summary-row muted"><span>초과/미달 없음 (권리 = 사용)</span></div>` : ''

  const css = `
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Noto Sans KR",sans-serif;
      font-size:13px;line-height:1.6;color:#111827;max-width:880px;margin:0 auto;padding:48px 40px}
    header{border-bottom:2px solid #2563eb;padding-bottom:18px;margin-bottom:32px}
    h1{font-size:22px;font-weight:700;color:#111827}
    .pi{margin-top:6px;color:#374151;font-size:14px;font-weight:500}
    .meta{margin-top:3px;color:#6b7280;font-size:12px}
    section{margin-bottom:28px}
    h2{font-size:13px;font-weight:600;color:#1e40af;margin-bottom:8px;padding-bottom:4px;border-bottom:1px solid #e5e7eb}
    table{width:100%;border-collapse:collapse;font-size:12px}
    th{background:#f9fafb;text-align:left;padding:7px 10px;font-weight:500;color:#6b7280;border:1px solid #e5e7eb;white-space:nowrap}
    td{padding:6px 10px;border:1px solid #e5e7eb;color:#374151;vertical-align:top}
    tfoot td{background:#f9fafb;font-weight:600;border-top:2px solid #d1d5db}
    td.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
    td.mono{font-family:ui-monospace,monospace;font-size:11px;white-space:nowrap}
    td.empty{text-align:center;color:#9ca3af;padding:12px}
    .pos{color:#065f46}.neg{color:#b91c1c}
    .pill{display:inline-block;padding:2px 7px;border-radius:999px;font-size:11px;font-weight:500}
    .pill-blue{background:#eef2ff;color:#4338ca}
    .pill-green{background:#ecfdf5;color:#065f46}
    .pill-red{background:#fef2f2;color:#b91c1c}
    .pill-purple{background:#f5f3ff;color:#7c3aed}
    .pill-amber{background:#fffbeb;color:#b45309}
    .sb{border:1px solid #e5e7eb;border-radius:8px;overflow:hidden}
    .summary-row{display:flex;align-items:center;justify-content:space-between;
      padding:10px 14px;border-bottom:1px solid #e5e7eb;font-size:12px;font-weight:500}
    .summary-row:last-child{border-bottom:none}
    .summary-row.total{background:#1e40af;color:white;font-size:14px;font-weight:700;padding:14px}
    .summary-row.ok{background:#ecfdf5;color:#065f46}
    .summary-row.err{background:#fef2f2;color:#b91c1c}
    .summary-row.muted{color:#9ca3af;font-weight:400}
    .sv{font-variant-numeric:tabular-nums;font-size:15px;font-weight:700}
    .sv-sm{font-variant-numeric:tabular-nums;font-size:13px;font-weight:700}
    .chosen-a{color:#1d4ed8}.chosen-b{color:#7c3aed}.unchosen{color:#9ca3af}
    .candidates{padding:10px 14px;border-bottom:1px solid #e5e7eb;background:#f9fafb;display:grid;gap:6px}
    .cand{display:flex;align-items:center;justify-content:space-between;font-size:12px}
    .badge{display:inline-block;padding:1px 6px;border-radius:4px;font-size:10px;font-weight:500;margin-left:5px}
    .badge-a{background:#dbeafe;color:#1e40af}.badge-b{background:#ede9fe;color:#6d28d9}
    .hint{font-size:11px;color:#9ca3af;margin-left:5px}
    @media print{body{padding:20px;max-width:none}@page{margin:20mm;size:A4}section{break-inside:avoid}}
  `

  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>퇴사 정산서 — ${escHtml(person.name)}</title>
<style>${css}</style>
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
  <table>
    <thead><tr><th>항목</th><th>날짜/연도</th><th>사유</th><th>일수</th></tr></thead>
    <tbody>${t1.join('')}</tbody>
    <tfoot><tr><td colspan="3">법정연차 누적 합계</td><td class="num">${result.statutory}일</td></tr></tfoot>
  </table>
</section>

<section>
  <h2>② 팀 정당 적립 내역</h2>
  <table>
    <thead><tr><th>유형</th><th>날짜</th><th>원천(프로젝트)</th><th>일수</th></tr></thead>
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
    <div class="candidates">
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

function SettlementTab({ person }: { person: Person }) {
  const [asOfStr, setAsOfStr] = useState(numToStr(today()))
  const { isLoading, ledger, grants, adjustments, workItems } = usePersonData(person.id, asOfStr)
  const asOfYear = parseInt(asOfStr.slice(0, 4), 10)

  // 후보 (a) 구성 요소 — 주말/휴일대체·특별휴가 누적 합
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

  // AL-4/AL-5: 공용 함수 단일 호출 — 정산 요약은 이 result를 그대로 바인딩
  const result = useMemo(() => {
    if (!ledger) return null
    return computeAnnualLeaveSettlement(asOfStr, {
      grants,
      adjustments,
      weekendSubAccrued,
      specialLeaveAccrued,
      teamActualAccrued: ledger.actualAccrued,
      totalPaidUsed:     ledger.actualUsed,
    })
  }, [ledger, grants, adjustments, weekendSubAccrued, specialLeaveAccrued, asOfStr])

  const workItemById = useMemo(() => new Map(workItems.map(w => [w.id, w])), [workItems])
  const accrualById  = useMemo(
    () => new Map((ledger?.accruals ?? []).map(a => [a.id, a])),
    [ledger],
  )

  // Table 1 rows — grants + adjustments up to asOfStr
  const grantRows = useMemo(() =>
    grants.filter(g => g.year <= asOfYear).sort((a, b) => a.year - b.year),
  [grants, asOfYear])
  const adjRows = useMemo(() =>
    adjustments.filter(a => a.date <= asOfStr).sort((a, b) => a.date.localeCompare(b.date)),
  [adjustments, asOfStr])

  // Table 2 rows — team accruals (all types from computeLedger)
  const accrualRows = useMemo(() =>
    [...(ledger?.accruals ?? [])].sort((a, b) => a.date.localeCompare(b.date)),
  [ledger])

  // Table 3 rows — paid usages only (exclude 무급리프레시, 휴직)
  const paidUsages = useMemo(() =>
    (ledger?.usages ?? [])
      .filter(u => !UNPAID_LEAVE.has(u.type))
      .sort((a, b) => a.start.localeCompare(b.start)),
  [ledger])

  const handleDownload = useCallback(() => {
    if (!result) return
    const safeName = person.name.replace(/\s+/g, '_')
    triggerDownload(
      generateSettlementHtml(person, asOfStr, grantRows, adjRows, accrualRows, paidUsages, result, workItemById, accrualById),
      `퇴사정산_${safeName}_${asOfStr}.html`,
    )
  }, [person, asOfStr, grantRows, adjRows, accrualRows, paidUsages, result, workItemById, accrualById])

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <label className="text-xs font-medium text-gray-700">기준일 (퇴사 예정일)</label>
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
            <div className="card p-0 overflow-hidden">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-surface-50 border-b border-border text-muted">
                    <th className="px-3 py-2 text-left font-medium">항목</th>
                    <th className="px-3 py-2 text-left font-medium">날짜/연도</th>
                    <th className="px-3 py-2 text-left font-medium">사유</th>
                    <th className="px-3 py-2 text-right font-medium">일수</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {grantRows.map(g => (
                    <tr key={`g-${g.id}`} className="hover:bg-surface-50">
                      <td className="px-3 py-2"><span className="pill bg-brand-100 text-brand-700 text-[10px]">법정연차</span></td>
                      <td className="px-3 py-2 font-medium">{g.year}년</td>
                      <td className="px-3 py-2 text-muted">{g.note ?? '—'}</td>
                      <td className="px-3 py-2 text-right font-semibold text-brand-700">+{g.days}</td>
                    </tr>
                  ))}
                  {adjRows.map(a => (
                    <tr key={`a-${a.id}`} className="hover:bg-surface-50">
                      <td className="px-3 py-2">
                        <span className={`pill text-[10px] ${a.direction === 'accrual' ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'}`}>
                          {a.direction === 'accrual' ? '보정+' : '보정−'}
                        </span>
                      </td>
                      <td className="px-3 py-2 font-mono text-[11px]">{a.date}</td>
                      <td className="px-3 py-2 text-muted">{a.note ?? '—'}</td>
                      <td className={`px-3 py-2 text-right font-semibold ${a.direction === 'accrual' ? 'text-emerald-700' : 'text-red-600'}`}>
                        {a.direction === 'accrual' ? '+' : '−'}{Math.abs(a.days)}
                      </td>
                    </tr>
                  ))}
                  {grantRows.length === 0 && adjRows.length === 0 && (
                    <tr><td colSpan={4} className="px-3 py-4 text-center text-muted">내역 없음</td></tr>
                  )}
                </tbody>
                <tfoot>
                  <tr className="bg-surface-50 border-t-2 border-border">
                    <td colSpan={3} className="px-3 py-2 text-xs font-semibold text-gray-700">법정연차 누적 합계</td>
                    <td className="px-3 py-2 text-right font-bold text-brand-700">{result.statutory}일</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </section>

          {/* ② 팀 정당 적립 내역 */}
          <section>
            <h3 className="text-xs font-semibold text-gray-700 mb-2">② 팀 정당 적립 내역</h3>
            <div className="card p-0 overflow-hidden">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-surface-50 border-b border-border text-muted">
                    <th className="px-3 py-2 text-left font-medium">유형</th>
                    <th className="px-3 py-2 text-left font-medium">날짜</th>
                    <th className="px-3 py-2 text-left font-medium">원천(프로젝트)</th>
                    <th className="px-3 py-2 text-right font-medium">일수</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {accrualRows.map(a => (
                    <tr key={a.id} className="hover:bg-surface-50">
                      <td className="px-3 py-2"><span className="pill bg-purple-100 text-purple-700 text-[10px]">{a.type}</span></td>
                      <td className="px-3 py-2 font-mono text-[11px]">{a.date}</td>
                      <td className="px-3 py-2 text-muted truncate max-w-[140px]">
                        {a.sourceId
                          ? (workItemById.get(a.sourceId)?.name ?? a.sourceId)
                          : (!a.isAuto && a.note ? a.note : '—')}
                      </td>
                      <td className="px-3 py-2 text-right font-semibold text-purple-700">+{a.days}</td>
                    </tr>
                  ))}
                  {accrualRows.length === 0 && (
                    <tr><td colSpan={4} className="px-3 py-4 text-center text-muted">내역 없음</td></tr>
                  )}
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
            <h3 className="text-xs font-semibold text-gray-700 mb-2">③ 휴가 사용 내역 <span className="text-muted font-normal">(유급 — 무급리프레시·휴직 제외)</span></h3>
            <div className="card p-0 overflow-hidden">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-surface-50 border-b border-border text-muted">
                    <th className="px-3 py-2 text-left font-medium">기간</th>
                    <th className="px-3 py-2 text-left font-medium">유형</th>
                    <th className="px-3 py-2 text-left font-medium">FIFO 차감 원천</th>
                    <th className="px-3 py-2 text-right font-medium">일수</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {paidUsages.map(u => (
                    <tr key={u.assignmentId} className="hover:bg-surface-50">
                      <td className="px-3 py-2 font-mono text-[11px] whitespace-nowrap">
                        {u.start === u.end ? u.start : `${u.start}~${u.end}`}
                      </td>
                      <td className="px-3 py-2"><span className="pill bg-amber-100 text-amber-700 text-[10px]">{u.type}</span></td>
                      <td className="px-3 py-2 text-muted text-[10px] max-w-[160px]">
                        {deductionSummary(u.deductions, accrualById, workItemById)}
                        {u.deficit > 0 && (
                          <span className="ml-1 text-red-500 whitespace-nowrap">(선사용 {u.deficit}일)</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right font-semibold text-gray-800">−{u.days}</td>
                    </tr>
                  ))}
                  {paidUsages.length === 0 && (
                    <tr><td colSpan={4} className="px-3 py-4 text-center text-muted">내역 없음</td></tr>
                  )}
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

          {/* 정산 요약 — computeAnnualLeaveSettlement 결과를 그대로 바인딩 (재계산 없음) */}
          <section>
            <h3 className="text-xs font-semibold text-gray-700 mb-2">정산 요약</h3>
            <div className="rounded-lg border border-border overflow-hidden divide-y divide-border">
              {/* 두 후보값 비교 — (a) 법정연차+주말/휴일대체 vs (b) 팀 정당 적립 합 */}
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
            label={`${asOfYear}년 법정연차·신입사원 휴가 누적`}
            value={figures.statutoryThisYear}
            hint={`${asOfYear}년 grants 합 + 보정 (1/1 리셋, 이월 없음)`}
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
      <div className="flex flex-1 overflow-hidden">
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
              {subTab === 'grants'        && <GrantsTab person={selectedPerson} readOnly={readOnly} />}
              {subTab === 'settlement'    && <SettlementTab person={selectedPerson} />}
              {subTab === 'timesheetfigs' && <TimesheetTab person={selectedPerson} />}
            </div>
          </>
        )}
        </div>
      </div>
    </div>
  )
}
