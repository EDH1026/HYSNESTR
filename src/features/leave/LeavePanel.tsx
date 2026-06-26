/**
 * LeavePanel — per-person leave ledger panel
 *
 * Shows: reference date selector, accrued/used/remaining summary, per-type breakdown,
 * accrual history with remaining, usage history with deduction sources, unpaid list.
 *
 * Actions (edit-gated):
 *   • Manual accrual add (포상/특별/프로젝트휴가/주말대체)
 *   • "Assign remaining" — creates a 지정휴가 leave assignment covering the remaining workdays
 */

import { useState, useMemo, useCallback, type FormEvent } from 'react'
import { Loader2, Plus, CalendarCheck, Trash2 } from 'lucide-react'
import Modal from '@/components/Modal'
import { computeLedger, buildHolidaySet } from './ledger'
import { useAccrualsByPerson, useCreateAccrual, useDeleteAccrual } from './hooks'
import { useAssignmentsByPerson } from '@/features/timeline/hooks'
import { useAllWorkItems } from '@/features/workitems/hooks'
import { useAllHolidays } from '@/features/admin/hooks'
import { useCreateAssignment } from '@/features/timeline/hooks'
import { useAuthz } from '@/hooks/useAuthz'
import { useHistory } from '@/lib/history'
import { makeAccrualCreate, makeAccrualDelete } from '@/lib/historyOps'
import { dateToNum, numToStr, today, isWeekend, nextWorkday } from '@/lib/date'
import type { Person, AccrualType, LeaveType } from '@/types'

const MANUAL_TYPES: AccrualType[] = ['포상휴가', '특별휴가', '프로젝트휴가', '주말/휴일대체']

// ── Shared accrual/usage form ─────────────────────────────────

interface AccrualFormProps {
  personId:  string
  direction: 'accrual' | 'usage'
  onDone:    () => void
}
function AccrualForm({ personId, direction, onDone }: AccrualFormProps) {
  const createAccrual = useCreateAccrual()
  const { push } = useHistory()
  const [form, setForm] = useState({
    type: '포상휴가' as AccrualType,
    days: '',
    date: numToStr(today()),
    note: '',
  })
  const [err, setErr] = useState<string | null>(null)

  const isUsage = direction === 'usage'

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    const days = parseFloat(form.days)
    if (isNaN(days) || days === 0) { setErr('0이 아닌 값을 입력하세요 (음수=회수/취소 가능)'); return }
    setErr(null)
    try {
      const created = await createAccrual.mutateAsync({
        person_id: personId,
        type:      form.type,
        days,
        date:      form.date,
        source:    null,
        note:      form.note || null,
        direction,
      })
      push(makeAccrualCreate(created))
      onDone()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed')
    }
  }

  const borderCls = isUsage ? 'border-red-200 bg-red-50' : 'border-brand-200 bg-brand-50'
  const titleCls  = isUsage ? 'text-red-800' : 'text-brand-800'

  return (
    <form onSubmit={handleSubmit} className={`space-y-3 rounded-md border ${borderCls} p-3`}>
      <p className={`text-xs font-semibold ${titleCls}`}>
        {isUsage ? '수동 차감 추가' : '수동 적립 추가'}
      </p>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="mb-0.5 block text-xs text-gray-600">유형</label>
          <select className="input py-1 text-xs" value={form.type}
            onChange={e => setForm(f => ({ ...f, type: e.target.value as AccrualType }))}>
            {MANUAL_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
        <div>
          <label className="mb-0.5 block text-xs text-gray-600">
            일수
            <span className="ml-1 text-muted text-[10px]">{isUsage ? '음수=취소' : '음수=회수'}</span>
          </label>
          <input required type="number" step="0.5" className="input py-1 text-xs"
            placeholder={isUsage ? '양수=차감 / 음수=취소' : '양수=적립 / 음수=회수'}
            value={form.days} onChange={e => setForm(f => ({ ...f, days: e.target.value }))} />
        </div>
      </div>
      <div>
        <label className="mb-0.5 block text-xs text-gray-600">
          {isUsage ? '차감일' : '적립일'}
        </label>
        <input required type="date" className="input py-1 text-xs"
          value={form.date} onChange={e => setForm(f => ({ ...f, date: e.target.value }))} />
      </div>
      <div>
        <label className="mb-0.5 block text-xs text-gray-600">비고</label>
        <input type="text" className="input py-1 text-xs" placeholder="선택"
          value={form.note} onChange={e => setForm(f => ({ ...f, note: e.target.value }))} />
      </div>
      {err && <p className="text-xs text-red-600">{err}</p>}
      <div className="flex gap-2">
        <button type="submit" disabled={createAccrual.isPending}
          className={`text-xs py-1 flex-1 ${isUsage ? 'btn-danger' : 'btn-primary'}`}>
          {createAccrual.isPending ? <Loader2 size={12} className="animate-spin" /> : '저장'}
        </button>
        <button type="button" onClick={onDone} className="btn-secondary text-xs py-1">취소</button>
      </div>
    </form>
  )
}

// ── Main Panel ────────────────────────────────────────────────

interface Props {
  person:   Person
  onClose?: () => void  // omit when inline=true
  inline?:  boolean     // render content in page body, no Modal wrapper
}

export default function LeavePanel({ person, onClose, inline }: Props) {
  const { canView, canEdit } = useAuthz()
  const { push } = useHistory()
  const canViewThis = canView('person', person.id)
  const canEditThis = canEdit('person', person.id) || canEdit('global')

  const [asOfStr, setAsOfStr]       = useState(numToStr(today()))
  const [showAddAccrual, setShowAddAccrual] = useState(false)
  const [showAddUsage,   setShowAddUsage]   = useState(false)
  const [isCreatingLeave, setIsCreatingLeave] = useState(false)
  const deleteAccrual = useDeleteAccrual(person.id)

  const { data: assignments = [], isLoading: loadingA } = useAssignmentsByPerson(person.id)
  const { data: accruals   = [], isLoading: loadingB } = useAccrualsByPerson(person.id)
  const { data: workItems  = [], isLoading: loadingW } = useAllWorkItems()
  const { data: holidays   = [], isLoading: loadingH } = useAllHolidays()

  const isLoading = loadingA || loadingB || loadingW || loadingH

  async function handleDeleteAccrual(id: string, prompt: string) {
    const target = accruals.find(a => a.id === id)
    if (!confirm(prompt)) return
    try {
      await deleteAccrual.mutateAsync(id)
      if (target) push(makeAccrualDelete(target))
    } catch {
      // deleteAccrual mutation will surface errors via isPending/isError if needed
    }
  }

  const holidaySet = useMemo(() => {
    const yr = new Date().getFullYear()
    return buildHolidaySet(holidays, yr - 3, yr + 3)
  }, [holidays])

  const isHoliday = useCallback((n: number) => holidaySet.has(n), [holidaySet])

  const asOf = useMemo(() => dateToNum(asOfStr), [asOfStr])

  const ledger = useMemo(() => {
    if (isLoading) return null
    return computeLedger(person.id, { workItems, assignments, accruals, isHoliday, today: asOf })
  }, [person.id, workItems, assignments, accruals, isHoliday, asOf, isLoading])

  const createAssignment = useCreateAssignment()

  async function handleAssignRemaining() {
    if (!ledger || ledger.remaining <= 0) return
    const totalDays = Math.floor(ledger.remaining)
    if (totalDays <= 0) return
    setIsCreatingLeave(true)
    try {
      // Build set of days occupied by ANY existing assignment (work or leave) — §5.10 L-3
      const occupied = new Set<number>()
      for (const a of assignments) {
        const s = dateToNum(a.start)
        const e = dateToNum(a.end_date)
        for (let d = s; d <= e; d++) occupied.add(d)
      }

      // §7.4 LV-1 (PRD v2.11): search starts from the first workday after the
      // person's latest existing assignment end — not from the reference date.
      const maxEnd = assignments.reduce((m, a) => Math.max(m, dateToNum(a.end_date)), 0)
      const searchFrom = nextWorkday(Math.max(maxEnd, asOf), isHoliday)
      const availDays: number[] = []
      let search = searchFrom
      while (availDays.length < totalDays && search < searchFrom + 730) {
        if (!isWeekend(search) && !isHoliday(search) && !occupied.has(search))
          availDays.push(search)
        search++
      }
      if (availDays.length === 0) return

      // §7.4: allocate days by priority type — ① 주말/휴일대체 → ② 프로젝트휴가 → ③ 포상휴가
      const PRIORITY: AccrualType[] = ['주말/휴일대체', '프로젝트휴가', '포상휴가']
      const allocation: { type: LeaveType; days: number }[] = []
      let daysLeft = availDays.length
      for (const t of PRIORITY) {
        const v = ledger.byType[t]
        if (!v) continue
        const typeRem = Math.floor(Math.max(0, v.accrued - v.used))
        const allocate = Math.min(typeRem, daysLeft)
        if (allocate > 0) { allocation.push({ type: t as LeaveType, days: allocate }); daysLeft -= allocate }
      }
      if (daysLeft > 0) allocation.push({ type: '지정휴가', days: daysLeft })

      // Group a sorted list of day-numbers into contiguous date ranges
      // (treats weekends/holidays in the middle as non-breaks)
      function toRanges(days: number[]): [number, number][] {
        if (days.length === 0) return []
        const out: [number, number][] = []
        let start = days[0], prev = days[0]
        for (let i = 1; i < days.length; i++) {
          const curr = days[i]
          let gapHasWorkday = false
          for (let d = prev + 1; d < curr; d++) {
            if (!isWeekend(d) && !isHoliday(d)) { gapHasWorkday = true; break }
          }
          if (gapHasWorkday) { out.push([start, prev]); start = curr }
          prev = curr
        }
        out.push([start, prev])
        return out
      }

      // Create one assignment per contiguous block per type
      let dayIdx = 0
      for (const block of allocation) {
        if (dayIdx >= availDays.length) break
        const blockDays = availDays.slice(dayIdx, dayIdx + block.days)
        dayIdx += block.days
        for (const [s, e] of toRanges(blockDays)) {
          await createAssignment.mutateAsync({
            person_id:    person.id,
            kind:         'leave',
            work_item_id: null,
            leave_type:   block.type,
            start:        numToStr(s),
            end_date:     numToStr(e),
            weekend_dates: [],
            note:         '잔여 적립 소진 (자동 생성)',
          })
        }
      }
    } finally {
      setIsCreatingLeave(false)
    }
  }

  const wiMap = useMemo(() => new Map(workItems.map(w => [w.id, w])), [workItems])

  if (!canViewThis) {
    if (inline) return <p className="p-8 text-sm text-muted">열람 권한이 없습니다.</p>
    return (
      <Modal title={`${person.name} — Leave`} onClose={onClose!} size="sm">
        <p className="text-sm text-muted">열람 권한이 없습니다.</p>
      </Modal>
    )
  }

  const body = (
    <>
      {/* Reference date selector */}
      <div className="flex items-center gap-3">
        <label className="text-xs font-medium text-gray-700">기준일</label>
        <input
          type="date"
          className="input py-1 text-xs w-36"
          value={asOfStr}
          onChange={e => setAsOfStr(e.target.value)}
        />
      </div>

      {isLoading || !ledger ? (
        <div className="flex items-center justify-center py-12 text-muted text-sm">
          <Loader2 size={20} className="animate-spin mr-2" /> 계산 중…
        </div>
      ) : (
        <>
          {/* ── Summary cards ─────────────────────────────── */}
          <div className="grid grid-cols-3 gap-3">
            <SummaryCard label="총 적립" value={ledger.totalAccrued} color="brand" />
            <SummaryCard label="사용"    value={ledger.totalUsed}    color="gray" />
            <SummaryCard label="잔여"    value={ledger.remaining}    color={ledger.remaining < 0 ? 'red' : 'green'} />
          </div>

          {/* ── Breakdown by type ─────────────────────────── */}
          {Object.keys(ledger.byType).length > 0 && (
            <section>
              <h3 className="mb-2 text-xs font-semibold text-muted uppercase tracking-wide">유형별 현황</h3>
              <div className="card p-0 overflow-hidden">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="bg-surface-50 border-b border-border text-muted">
                      <th className="px-3 py-2 text-left font-medium">유형</th>
                      <th className="px-3 py-2 text-right font-medium">적립</th>
                      <th className="px-3 py-2 text-right font-medium">사용</th>
                      <th className="px-3 py-2 text-right font-medium">잔여</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {(Object.entries(ledger.byType) as [AccrualType, { accrued: number; used: number }][]).map(([type, v]) => (
                      <tr key={type} className="hover:bg-surface-50">
                        <td className="px-3 py-2 font-medium text-gray-700">{type}</td>
                        <td className="px-3 py-2 text-right">{v.accrued}</td>
                        <td className="px-3 py-2 text-right">{v.used}</td>
                        <td className="px-3 py-2 text-right font-medium">{Math.round((v.accrued - v.used) * 10) / 10}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {/* ── Accrual history ───────────────────────────── */}
          <section>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-xs font-semibold text-muted uppercase tracking-wide">적립 이력</h3>
              {canEditThis && !showAddAccrual && !showAddUsage && (
                <button onClick={() => setShowAddAccrual(true)} className="btn-secondary text-xs py-0.5 gap-1">
                  <Plus size={11} /> 수동 적립
                </button>
              )}
            </div>

            {showAddAccrual && (
              <AccrualForm
                personId={person.id}
                direction="accrual"
                onDone={() => setShowAddAccrual(false)}
              />
            )}

            {ledger.accruals.length === 0 ? (
              <p className="text-xs text-muted text-center py-4">적립 내역 없음</p>
            ) : (
              <div className="card p-0 overflow-hidden">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="bg-surface-50 border-b border-border text-muted">
                      <th className="px-3 py-2 text-left font-medium">날짜</th>
                      <th className="px-3 py-2 text-left font-medium">유형</th>
                      <th className="px-3 py-2 text-left font-medium">원천</th>
                      <th className="px-3 py-2 text-right font-medium">적립</th>
                      <th className="px-3 py-2 text-right font-medium">잔여</th>
                      <th className="px-3 py-2 text-center font-medium">구분</th>
                      {canEditThis && <th className="px-2 py-2 w-7" />}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {ledger.accruals.map(e => (
                      <tr key={e.id} className="hover:bg-surface-50">
                        <td className="px-3 py-2 font-mono">{e.date}</td>
                        <td className="px-3 py-2">
                          <span className="pill bg-brand-100 text-brand-700">{e.type}</span>
                        </td>
                        <td className="px-3 py-2 text-muted">
                          {e.sourceId ? (wiMap.get(e.sourceId)?.name ?? e.sourceId) : '—'}
                        </td>
                        <td className="px-3 py-2 text-right font-medium">+{e.days}</td>
                        <td className="px-3 py-2 text-right">
                          <span className={e.remaining === 0 ? 'text-muted line-through' : 'font-medium'}>{e.remaining}</span>
                        </td>
                        <td className="px-3 py-2 text-center">
                          {e.isAuto
                            ? <span className="pill bg-surface-100 text-muted text-[10px]">자동</span>
                            : <span className="pill bg-emerald-100 text-emerald-700 text-[10px]">수동</span>}
                        </td>
                        {canEditThis && (
                          <td className="px-2 py-2">
                            {!e.isAuto && (
                              <button
                                onClick={() => void handleDeleteAccrual(e.id, '이 적립을 삭제할까요?')}
                                className="rounded p-1 text-muted hover:text-red-600 hover:bg-red-50 transition-colors"
                                title="삭제"
                              >
                                <Trash2 size={11} />
                              </button>
                            )}
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* ── Usage history ─────────────────────────────── */}
          <section>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-xs font-semibold text-muted uppercase tracking-wide">사용 이력 (유급)</h3>
              {canEditThis && !showAddUsage && !showAddAccrual && (
                <button onClick={() => setShowAddUsage(true)} className="btn-secondary text-xs py-0.5 gap-1 text-red-600 border-red-200 hover:bg-red-50">
                  <Plus size={11} /> 수동 차감
                </button>
              )}
            </div>

            {showAddUsage && (
              <AccrualForm
                personId={person.id}
                direction="usage"
                onDone={() => setShowAddUsage(false)}
              />
            )}

            {ledger.usages.length === 0 ? (
              <p className="text-xs text-muted text-center py-4">사용 내역 없음</p>
            ) : (
              <div className="card p-0 overflow-hidden">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="bg-surface-50 border-b border-border text-muted">
                      <th className="px-3 py-2 text-left font-medium">기간</th>
                      <th className="px-3 py-2 text-left font-medium">유형</th>
                      <th className="px-3 py-2 text-right font-medium">사용일</th>
                      <th className="px-3 py-2 text-left font-medium">차감 원천</th>
                      <th className="px-3 py-2 text-right font-medium">부족분</th>
                      {canEditThis && <th className="px-2 py-2 w-7" />}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {ledger.usages.map(u => (
                      <tr key={u.assignmentId} className={u.deficit > 0 ? 'bg-red-50' : 'hover:bg-surface-50'}>
                        <td className="px-3 py-2 font-mono">
                          {u.isManual
                            ? <span className="flex items-center gap-1.5">
                                {u.start}
                                <span className="pill bg-red-100 text-red-700 text-[10px]">수동차감</span>
                              </span>
                            : u.start !== u.end ? `${u.start} ~ ${u.end}` : u.start
                          }
                          {u.note && <span className="block text-muted mt-0.5 text-[10px]">{u.note}</span>}
                        </td>
                        <td className="px-3 py-2">
                          <span className="pill bg-violet-100 text-violet-700">{u.type}</span>
                        </td>
                        <td className="px-3 py-2 text-right font-medium">{u.days}일</td>
                        <td className="px-3 py-2 text-muted text-[11px]">
                          {u.deductions.length === 0 ? '—' :
                            u.deductions.map((d, i) => {
                              const srcName = d.sourceId ? (wiMap.get(d.sourceId)?.name ?? d.sourceId) : '범용'
                              return <span key={i}>{srcName} {d.days}일{i < u.deductions.length - 1 ? ', ' : ''}</span>
                            })
                          }
                        </td>
                        <td className="px-3 py-2 text-right">
                          {u.deficit > 0
                            ? <span className="text-red-600 font-medium">−{u.deficit}일</span>
                            : <span className="text-muted">—</span>}
                        </td>
                        {canEditThis && (
                          <td className="px-2 py-2">
                            {u.isManual && (
                              <button
                                onClick={() => void handleDeleteAccrual(u.assignmentId, '이 수동 차감을 삭제할까요?')}
                                className="rounded p-1 text-muted hover:text-red-600 hover:bg-red-50 transition-colors"
                                title="삭제"
                              >
                                <Trash2 size={11} />
                              </button>
                            )}
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* ── Unpaid leave ──────────────────────────────── */}
          {ledger.unpaid.length > 0 && (
            <section>
              <h3 className="mb-2 text-xs font-semibold text-muted uppercase tracking-wide">무급 휴가</h3>
              <div className="card p-0 overflow-hidden">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="bg-surface-50 border-b border-border text-muted">
                      <th className="px-3 py-2 text-left font-medium">기간</th>
                      <th className="px-3 py-2 text-left font-medium">유형</th>
                      <th className="px-3 py-2 text-right font-medium">영업일</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {ledger.unpaid.map(u => (
                      <tr key={u.assignmentId} className="hover:bg-surface-50">
                        <td className="px-3 py-2 font-mono">{u.start} ~ {u.end}</td>
                        <td className="px-3 py-2">
                          <span className="pill bg-gray-100 text-gray-600">{u.type}</span>
                        </td>
                        <td className="px-3 py-2 text-right">{u.days}일</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {/* ── Assign remaining action ───────────────────── */}
          {canEditThis && ledger.remaining > 0 && (
            <div className="rounded-md border border-brand-200 bg-brand-50 p-3 flex items-center justify-between">
              <div>
                <p className="text-xs font-semibold text-brand-800">잔여 휴가 소진 배정</p>
                <p className="text-xs text-brand-700 mt-0.5">
                  기준일 이후 빈 영업일 {Math.floor(ledger.remaining)}일 —
                  ① 주말대체 → ② 프로젝트휴가 → ③ 포상휴가 순으로 유형별 배정 생성
                </p>
              </div>
              <button
                onClick={handleAssignRemaining}
                disabled={isCreatingLeave || Math.floor(ledger.remaining) === 0}
                className="btn-primary gap-1.5 text-xs flex-shrink-0 ml-4"
              >
                {isCreatingLeave
                  ? <Loader2 size={12} className="animate-spin" />
                  : <CalendarCheck size={13} />}
                배정 생성
              </button>
            </div>
          )}
        </>
      )}
    </>
  )

  if (inline) {
    return (
      <div className="flex-1 overflow-auto p-6 space-y-4 max-w-3xl">
        {body}
      </div>
    )
  }

  return (
    <Modal title={`${person.name} — Leave Ledger`} onClose={onClose!} size="lg">
      {body}
    </Modal>
  )
}

// ── Summary card ──────────────────────────────────────────────

type CardColor = 'brand' | 'gray' | 'green' | 'red'
const CARD_STYLES: Record<CardColor, { bg: string; text: string; num: string }> = {
  brand: { bg: 'bg-brand-50',   text: 'text-brand-700',   num: 'text-brand-800'  },
  gray:  { bg: 'bg-surface-100',text: 'text-muted',        num: 'text-gray-800'   },
  green: { bg: 'bg-emerald-50', text: 'text-emerald-700', num: 'text-emerald-900' },
  red:   { bg: 'bg-red-50',     text: 'text-red-600',     num: 'text-red-700'    },
}

function SummaryCard({ label, value, color }: { label: string; value: number; color: CardColor }) {
  const s = CARD_STYLES[color]
  return (
    <div className={`rounded-lg p-3 ${s.bg}`}>
      <p className={`text-xs font-medium ${s.text}`}>{label}</p>
      <p className={`text-2xl font-bold tabular-nums mt-1 ${s.num}`}>{value}</p>
      <p className={`text-xs ${s.text}`}>일</p>
    </div>
  )
}
