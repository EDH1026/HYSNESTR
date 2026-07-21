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

import { useState, useMemo, useCallback, Fragment, type FormEvent } from 'react'
import { Loader2, Plus, CalendarCheck, Trash2, ChevronDown, ChevronRight, Download } from 'lucide-react'
import Modal from '@/components/Modal'
import { computeLedger, buildHolidaySet, findEmptyWorkdayRanges } from './ledger'
import type { Ledger, LedgerAccrualEntry, LedgerUsageEntry } from './ledger'
import { escHtml, triggerDownload, HTML_EXPORT_CSS } from '@/lib/htmlExport'
import { useCreateAccrual, useDeleteAccrual, useLedgerData } from './hooks'
import { useAllHolidays } from '@/features/admin/hooks'
import { useCreateAssignment } from '@/features/timeline/hooks'
import { useAuthz } from '@/hooks/useAuthz'
import { useHistory } from '@/lib/history'
import { makeAccrualCreate, makeAccrualDelete } from '@/lib/historyOps'
import { dateToNum, numToStr, today, nextWorkday } from '@/lib/date'
import type { Person, AccrualType, WorkItem } from '@/types'

const MANUAL_TYPES: AccrualType[] = ['포상휴가', '특별휴가', '지연보상', '프로젝트휴가', '주말/휴일대체']

// ── FY / source helpers ───────────────────────────────────────

function fyFromDate(dateStr: string): number {
  const y = parseInt(dateStr.slice(0, 4), 10)
  const m = parseInt(dateStr.slice(5, 7), 10)
  return m >= 7 ? y + 1 : y
}

function fyRangeLabel(fy: number): string {
  return `FY${String(fy).slice(-2)} (${fy - 1}.07~${fy}.06)`
}

function accrualSrcVal(note: string | null | undefined, wi: WorkItem | undefined): string {
  return note || wi?.client || wi?.name || '—'
}

function fmtDeducSrc(type: string, note: string | null | undefined, wi: WorkItem | undefined, days: number): string {
  const val = note || wi?.client || wi?.name || ''
  return val ? `[${type}] ${val} ${days}일` : `[${type}] ${days}일`
}

function generateLeaveLedgerHtml(
  person:  Person,
  refDate: string,
  ledger:  Ledger,
  wiMap:   Map<string, WorkItem>,
): string {
  const generated  = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })
  const accrualById = new Map(ledger.accruals.map(a => [a.id, a]))

  // ── FY-grouped accrual rows ─────────────────────────────────
  const accrualLines: string[] = []
  if (ledger.accruals.length === 0) {
    accrualLines.push('<tr><td colspan="4" class="empty">내역 없음</td></tr>')
  } else {
    const byFY = new Map<number, LedgerAccrualEntry[]>()
    for (const e of ledger.accruals) {
      const fy = fyFromDate(e.date)
      if (!byFY.has(fy)) byFY.set(fy, [])
      byFY.get(fy)!.push(e)
    }
    for (const [fy, entries] of [...byFY.entries()].sort(([a], [b]) => a - b)) {
      const sub  = entries.reduce((s, e) => s + e.days, 0)
      const fyYY = String(fy).slice(-2)
      accrualLines.push(`<tr class="fy-hdr"><td colspan="4">FY${fyYY} (${fy - 1}.07~${fy}.06)</td></tr>`)
      for (const e of entries) {
        const wi  = e.sourceId ? wiMap.get(e.sourceId) : undefined
        const src = escHtml(accrualSrcVal(e.note, wi))
        accrualLines.push(`<tr>
          <td class="mono">${escHtml(e.date)}</td>
          <td><span class="pill pill-blue">${escHtml(e.type)}</span></td>
          <td>${src}</td>
          <td class="num pos">+${escHtml(e.days)}</td></tr>`)
      }
      accrualLines.push(`<tr class="fy-sub"><td colspan="3">소계</td><td class="num pos">+${sub}</td></tr>`)
    }
  }
  const totalAccrued = ledger.accruals.reduce((s, e) => s + e.days, 0)

  // ── FY-grouped usage rows ───────────────────────────────────
  const usageLines: string[] = []
  if (ledger.usages.length === 0) {
    usageLines.push('<tr><td colspan="4" class="empty">내역 없음</td></tr>')
  } else {
    const byFY = new Map<number, LedgerUsageEntry[]>()
    for (const u of ledger.usages) {
      const fy = fyFromDate(u.start)
      if (!byFY.has(fy)) byFY.set(fy, [])
      byFY.get(fy)!.push(u)
    }
    for (const [fy, entries] of [...byFY.entries()].sort(([a], [b]) => a - b)) {
      const sub  = entries.reduce((s, u) => s + u.days, 0)
      const fyYY = String(fy).slice(-2)
      usageLines.push(`<tr class="fy-hdr"><td colspan="4">FY${fyYY} (${fy - 1}.07~${fy}.06)</td></tr>`)
      for (const u of entries) {
        const period = u.start === u.end ? escHtml(u.start) : `${escHtml(u.start)}~${escHtml(u.end)}`
        const deducParts = u.deductions.map(d => {
          const acc = accrualById.get(d.accrualId)
          if (!acc) return ''
          const wi  = d.sourceId ? wiMap.get(d.sourceId) : undefined
          return escHtml(fmtDeducSrc(acc.type, acc.note, wi, d.days))
        }).filter(Boolean)
        const deducText = deducParts.length ? deducParts.join(', ') : '—'
        const typeTag   = u.isManual
          ? `<span class="pill pill-red">${escHtml(u.type)}</span> <span class="pill pill-red" style="font-size:10px">수동차감</span>`
          : `<span class="pill pill-violet">${escHtml(u.type)}</span>`
        usageLines.push(`<tr>
          <td class="mono">${period}</td>
          <td>${typeTag}</td>
          <td class="num">${escHtml(u.days)}일</td>
          <td>${deducText}</td></tr>`)
      }
      usageLines.push(`<tr class="fy-sub"><td colspan="3">소계</td><td class="num">${sub}일</td></tr>`)
    }
  }

  // ── Unpaid section ──────────────────────────────────────────
  const unpaidLines = ledger.unpaid.map(u =>
    `<tr>
      <td class="mono">${u.start === u.end ? escHtml(u.start) : `${escHtml(u.start)}~${escHtml(u.end)}`}</td>
      <td><span class="pill pill-gray">${escHtml(u.type)}</span></td>
      <td class="num">${escHtml(u.days)}일</td></tr>`)

  const unpaidSection = ledger.unpaid.length > 0 ? `
<section>
  <h2>무급 이력 (리프레시·휴직)</h2>
  <table>
    <thead><tr><th>기간</th><th>유형</th><th>영업일</th></tr></thead>
    <tbody>${unpaidLines.join('')}</tbody>
  </table>
</section>` : ''

  // ── Combined history ─────────────────────────────────────────
  const combinedRaw: { kind: string; date: string; period: string; type: string; source: string; change: number; balance: number }[] = []
  for (const e of ledger.accruals) {
    const wi  = e.sourceId ? wiMap.get(e.sourceId) : undefined
    combinedRaw.push({ kind: 'accrual', date: e.date, period: e.date, type: e.type, source: accrualSrcVal(e.note, wi), change: e.days, balance: 0 })
  }
  for (const u of ledger.usages) {
    const period     = u.start === u.end ? u.start : `${u.start}~${u.end}`
    const deducParts = u.deductions.map(d => {
      const acc = accrualById.get(d.accrualId)
      if (!acc) return ''
      const wi  = d.sourceId ? wiMap.get(d.sourceId) : undefined
      return fmtDeducSrc(acc.type, acc.note, wi, d.days)
    }).filter(Boolean)
    combinedRaw.push({ kind: 'usage', date: u.start, period, type: u.type, source: deducParts.join(', ') || '—', change: -u.days, balance: 0 })
  }
  for (const u of ledger.unpaid) {
    const period = u.start === u.end ? u.start : `${u.start}~${u.end}`
    combinedRaw.push({ kind: 'unpaid', date: u.start, period, type: u.type, source: '—', change: 0, balance: 0 })
  }
  combinedRaw.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1
    if (a.kind === 'accrual' && b.kind !== 'accrual') return -1
    if (a.kind !== 'accrual' && b.kind === 'accrual') return 1
    return 0
  })
  let runBal = 0
  for (const e of combinedRaw) { runBal += e.change; e.balance = runBal }
  const combinedByFY = new Map<number, typeof combinedRaw>()
  for (const e of combinedRaw) {
    const fy = fyFromDate(e.date)
    if (!combinedByFY.has(fy)) combinedByFY.set(fy, [])
    combinedByFY.get(fy)!.push(e)
  }
  const combinedLines: string[] = []
  for (const [fy, entries] of [...combinedByFY.entries()].sort(([a], [b]) => a - b)) {
    const fyYY = String(fy).slice(-2)
    combinedLines.push(`<tr class="fy-hdr"><td colspan="6">FY${fyYY} (${fy - 1}.07~${fy}.06)</td></tr>`)
    for (const e of entries) {
      const kindPill = e.kind === 'accrual'
        ? `<span class="pill pill-blue">적립</span>`
        : e.kind === 'usage'
          ? `<span class="pill pill-violet">사용</span>`
          : `<span class="pill pill-gray">무급</span>`
      const changeStr = e.change > 0 ? `+${e.change}` : e.change < 0 ? `${e.change}` : '—'
      const changeCls = e.change > 0 ? 'pos' : e.change < 0 ? 'neg' : ''
      const balCls    = e.balance < 0 ? 'neg' : e.balance > 0 ? 'pos' : ''
      combinedLines.push(`<tr>
        <td class="mono">${escHtml(e.period)}</td>
        <td>${kindPill}</td>
        <td><span class="pill pill-gray">${escHtml(e.type)}</span></td>
        <td>${escHtml(e.source)}</td>
        <td class="num ${changeCls}">${changeStr}</td>
        <td class="num ${balCls}">${e.balance}</td></tr>`)
    }
    const finalBal = entries[entries.length - 1].balance
    const fBalCls  = finalBal < 0 ? 'neg' : finalBal > 0 ? 'pos' : ''
    combinedLines.push(`<tr class="fy-sub"><td colspan="5">FY${fyYY} 말 잔액</td><td class="num ${fBalCls}">${finalBal}</td></tr>`)
  }
  const combinedSection = combinedRaw.length > 0 ? `
<section>
  <h2>통합 이력</h2>
  <table>
    <thead><tr><th>날짜/기간</th><th>구분</th><th>유형</th><th>원천</th><th>일수(±)</th><th>잔액</th></tr></thead>
    <tbody>${combinedLines.join('')}</tbody>
  </table>
</section>` : ''

  const rem     = ledger.remaining
  const remSign = rem >= 0 ? '' : ''
  const remCls  = rem < 0 ? 'neg' : 'pos'

  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Leave Ledger — ${escHtml(person.name)}</title>
<style>${HTML_EXPORT_CSS}</style>
</head>
<body>
<header>
  <h1>Leave Ledger</h1>
  <p class="pi">${escHtml(person.name)} · ${escHtml(person.rank)}${person.role ? ` · ${escHtml(person.role)}` : ''}</p>
  <p class="meta">조회 기준일: ${escHtml(refDate)} &nbsp;|&nbsp; 생성: ${escHtml(generated)}</p>
</header>

<section>
  <h2>적립 이력</h2>
  <table>
    <thead><tr><th>날짜</th><th>유형</th><th>원천</th><th>일수</th></tr></thead>
    <tbody>${accrualLines.join('')}</tbody>
    <tfoot><tr><td colspan="3">전체 합계</td><td class="num pos">+${totalAccrued}</td></tr></tfoot>
  </table>
</section>

<section>
  <h2>사용 이력 (유급)</h2>
  <table>
    <thead><tr><th>기간</th><th>유형</th><th>일수</th><th>원천</th></tr></thead>
    <tbody>${usageLines.join('')}</tbody>
    <tfoot><tr><td colspan="3">전체 합계</td><td class="num">${ledger.totalUsed}일</td></tr></tfoot>
  </table>
</section>
${unpaidSection}${combinedSection}
<section>
  <h2>총계</h2>
  <div class="sb">
    <div class="summary-row"><span>총 적립</span><span class="sv pos">+${totalAccrued}일</span></div>
    <div class="summary-row"><span>총 사용 (유급)</span><span class="sv">−${ledger.totalUsed}일</span></div>
    <div class="summary-row total"><span>잔여</span><span class="sv ${remCls}">${remSign}${rem}일</span></div>
  </div>
</section>
</body>
</html>`
}

// ── Shared accrual/usage form ─────────────────────────────────

interface AccrualFormProps {
  personId:             string
  direction:            'accrual' | 'usage'
  onDone:               () => void
  specialLeaveBalance?: number   // LV-6: balance for 특별휴가 usage validation
}
function AccrualForm({ personId, direction, onDone, specialLeaveBalance }: AccrualFormProps) {
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
    // LV-6: 특별휴가는 적립 잔여 한도 내에서만 입력 가능 (선사용 불가)
    if (isUsage && form.type === '특별휴가' && days > 0 && specialLeaveBalance !== undefined) {
      if (days > specialLeaveBalance) {
        setErr(`특별휴가 잔여가 부족합니다 (잔여: ${specialLeaveBalance}일, 요청: ${days}일)`)
        return
      }
    }
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
      {!isUsage && form.type === '지연보상' && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          <p className="font-semibold mb-1">지연보상 권장 기준 (안내만, 강제 아님)</p>
          <p>해당 프로젝트 프로젝트휴가 적립분 기준:</p>
          <ul className="mt-0.5 space-y-0.5 list-disc list-inside text-[11px]">
            <li>1일 이하 → +0일</li>
            <li>1.5~3일 → +1일</li>
            <li>3.5~5일 → +2일</li>
            <li>5.5일 이상 → +3일</li>
          </ul>
        </div>
      )}
      <div>
        <label className="mb-0.5 block text-xs text-gray-600">
          {isUsage ? '차감일' : '적립일'}
        </label>
        <input required type="date" className="input py-1 text-xs"
          value={form.date} onChange={e => setForm(f => ({ ...f, date: e.target.value }))} />
      </div>
      <div>
        <label className="mb-0.5 block text-xs text-gray-600">
          비고{!isUsage && <span className="ml-0.5 text-red-500">*</span>}
        </label>
        <input required={!isUsage} type="text" className="input py-1 text-xs"
          placeholder={isUsage ? '선택' : '필수 (적립 원천 표시)'}
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

  // PRD v2.100 LV-17: single RPC-backed source so this ledger matches the same
  // person's ledger regardless of the viewing session's role (was: separate
  // per-role-filtered assignments/accruals/work_items reads).
  const { data: ledgerSrc, isLoading: loadingLedgerSrc } = useLedgerData([person.id])
  const assignments = ledgerSrc?.assignments ?? []
  const accruals    = ledgerSrc?.accruals    ?? []
  const workItems    = ledgerSrc?.workItems   ?? []
  const { data: holidays   = [], isLoading: loadingH } = useAllHolidays()

  const isLoading = loadingLedgerSrc || loadingH

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
    return computeLedger(person.id, { workItems, assignments, accruals, isHoliday, today: asOf, personRank: person.rank })
  }, [person.id, workItems, assignments, accruals, isHoliday, asOf, isLoading])

  const createAssignment = useCreateAssignment()

  async function handleAssignRemaining() {
    if (person.rank === 'Partner') return  // §7-7: no auto-assign for Partners
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

      // §7.4 LV-1 (PRD v2.11): search starts from the first workday after the person's
      // latest existing assignment end — not from the reference date. PRD v2.109 LV-19:
      // but if nothing reaches/covers today, today itself may still be genuinely empty,
      // so start the scan AT asOf (inclusive) instead of unconditionally +1'ing past it.
      const maxEnd = assignments.reduce((m, a) => Math.max(m, dateToNum(a.end_date)), 0)
      const searchFrom = maxEnd >= asOf ? nextWorkday(maxEnd, isHoliday) : asOf

      // §7.4 LV-1 v2.88: 항상 프로젝트휴가 유형 하나로 배정 생성
      // 차감 원천 FIFO(주말대체→프로젝트→포상→지연보상)는 computeLedger에서 독립적으로 계산
      const ranges = findEmptyWorkdayRanges(searchFrom, totalDays, occupied, isHoliday)
      if (ranges.length === 0) return

      for (const { start: s, end: e } of ranges) {
        await createAssignment.mutateAsync({
          person_id:    person.id,
          kind:         'leave',
          work_item_id: null,
          leave_type:   '프로젝트휴가',
          start:        numToStr(s),
          end_date:     numToStr(e),
          weekend_dates: [],
          note:         '잔여 적립 소진 (자동 생성)',
        })
      }
    } finally {
      setIsCreatingLeave(false)
    }
  }

  const wiMap       = useMemo(() => new Map(workItems.map(w => [w.id, w])), [workItems])
  const accrualByIdUI = useMemo(() =>
    new Map((ledger?.accruals ?? []).map(a => [a.id, a])),
  [ledger])

  // LV-6: 특별휴가 현재 잔여 (수동 차감 입력 시 검증용)
  const specialLeaveBalance = useMemo(() =>
    ledger?.accruals
      .filter(a => a.type === '특별휴가')
      .reduce((s, a) => s + a.remaining, 0) ?? 0,
  [ledger])

  // FY-grouped accruals (by date) and usages (by start date)
  const accrualGroups = useMemo(() => {
    if (!ledger) return [] as [number, LedgerAccrualEntry[]][]
    const map = new Map<number, LedgerAccrualEntry[]>()
    for (const e of ledger.accruals) {
      const fy = fyFromDate(e.date)
      if (!map.has(fy)) map.set(fy, [])
      map.get(fy)!.push(e)
    }
    return [...map.entries()].sort(([a], [b]) => a - b)
  }, [ledger])

  const usageGroups = useMemo(() => {
    if (!ledger) return [] as [number, LedgerUsageEntry[]][]
    const map = new Map<number, LedgerUsageEntry[]>()
    for (const u of ledger.usages) {
      const fy = fyFromDate(u.start)
      if (!map.has(fy)) map.set(fy, [])
      map.get(fy)!.push(u)
    }
    return [...map.entries()].sort(([a], [b]) => a - b)
  }, [ledger])

  // FY accordion open/close state
  const [expandedAccrualFYs,  setExpandedAccrualFYs]  = useState(() => new Set<number>())
  const [expandedUsageFYs,    setExpandedUsageFYs]    = useState(() => new Set<number>())
  const [expandedCombinedFYs, setExpandedCombinedFYs] = useState(() => new Set<number>())
  const toggleAccrualFY  = useCallback((fy: number) =>
    setExpandedAccrualFYs(p => { const s = new Set(p); s.has(fy) ? s.delete(fy) : s.add(fy); return s }), [])
  const toggleUsageFY    = useCallback((fy: number) =>
    setExpandedUsageFYs(p => { const s = new Set(p); s.has(fy) ? s.delete(fy) : s.add(fy); return s }), [])
  const toggleCombinedFY = useCallback((fy: number) =>
    setExpandedCombinedFYs(p => { const s = new Set(p); s.has(fy) ? s.delete(fy) : s.add(fy); return s }), [])

  // Combined history (accruals + usages + unpaid, sorted by date; accruals first on same date)
  const combinedHistory = useMemo(() => {
    if (!ledger) return [] as { kind: 'accrual' | 'usage' | 'unpaid'; date: string; period: string; type: string; source: string; change: number; balance: number }[]
    const accrualById = new Map(ledger.accruals.map(a => [a.id, a]))
    type CH = { kind: 'accrual' | 'usage' | 'unpaid'; date: string; period: string; type: string; source: string; change: number; balance: number }
    const rows: CH[] = []
    for (const e of ledger.accruals) {
      const wi  = e.sourceId ? wiMap.get(e.sourceId) : undefined
      rows.push({ kind: 'accrual', date: e.date, period: e.date, type: e.type, source: accrualSrcVal(e.note, wi), change: e.days, balance: 0 })
    }
    for (const u of ledger.usages) {
      const period     = u.start === u.end ? u.start : `${u.start} ~ ${u.end}`
      const deducParts = u.deductions.map(d => {
        const acc = accrualById.get(d.accrualId)
        if (!acc) return ''
        const wi  = d.sourceId ? wiMap.get(d.sourceId) : undefined
        return fmtDeducSrc(acc.type, acc.note, wi, d.days)
      }).filter(Boolean)
      rows.push({ kind: 'usage', date: u.start, period, type: u.type, source: deducParts.join(', ') || '—', change: -u.days, balance: 0 })
    }
    for (const u of ledger.unpaid) {
      const period = u.start === u.end ? u.start : `${u.start} ~ ${u.end}`
      rows.push({ kind: 'unpaid', date: u.start, period, type: u.type, source: '—', change: 0, balance: 0 })
    }
    rows.sort((a, b) => {
      if (a.date !== b.date) return a.date < b.date ? -1 : 1
      if (a.kind === 'accrual' && b.kind !== 'accrual') return -1
      if (a.kind !== 'accrual' && b.kind === 'accrual') return 1
      return 0
    })
    let bal = 0
    for (const r of rows) { bal += r.change; r.balance = bal }
    return rows
  }, [ledger, wiMap])

  const combinedFYGroups = useMemo(() => {
    const map = new Map<number, typeof combinedHistory>()
    for (const e of combinedHistory) {
      const fy = fyFromDate(e.date)
      if (!map.has(fy)) map.set(fy, [])
      map.get(fy)!.push(e)
    }
    return [...map.entries()].sort(([a], [b]) => a - b)
  }, [combinedHistory])

  const handleDownload = useCallback(() => {
    if (!ledger) return
    const safeName = person.name.replace(/\s+/g, '_')
    triggerDownload(
      generateLeaveLedgerHtml(person, asOfStr, ledger, wiMap),
      `LeaveLedger_${safeName}_${asOfStr}.html`,
    )
  }, [ledger, person, asOfStr, wiMap])

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
      {/* Reference date selector + download */}
      <div className="flex items-center gap-3">
        <label className="text-xs font-medium text-gray-700">기준일</label>
        <input
          type="date"
          className="input py-1 text-xs w-36"
          value={asOfStr}
          onChange={e => setAsOfStr(e.target.value)}
        />
        <button
          onClick={handleDownload}
          disabled={!ledger}
          className="ml-auto flex items-center gap-1.5 btn-secondary text-xs py-1 disabled:opacity-40"
        >
          <Download size={13} />
          HTML로 저장
        </button>
      </div>

      {isLoading || !ledger ? (
        <div className="flex items-center justify-center py-12 text-muted text-sm">
          <Loader2 size={20} className="animate-spin mr-2" /> 계산 중…
        </div>
      ) : (
        <>
          {/* ── LV-5 §7-8: 6-way summary ─────────────────── */}
          <div className="space-y-1.5">
            <div className="flex items-center gap-1.5 mb-0.5">
              <span className="text-[10px] font-semibold text-muted uppercase tracking-wide">실제 (기준일까지 확정)</span>
            </div>
            <div className="grid grid-cols-3 gap-2">
              <SummaryCard label="실제 적립" value={ledger.actualAccrued}    color="brand" />
              <SummaryCard label="실제 사용" value={ledger.actualUsed}       color="gray" />
              <SummaryCard label="현재 잔여" value={ledger.currentRemaining} color={ledger.currentRemaining < 0 ? 'red' : 'green'} />
            </div>
            <div className="flex items-center gap-1.5 mt-1 mb-0.5">
              <span className="text-[10px] font-semibold text-muted uppercase tracking-wide">예정 (기준일 이후 추가분)</span>
            </div>
            <div className="grid grid-cols-3 gap-2">
              <SummaryCard label="+ 적립 예정" value={ledger.scheduledAccrued}  color="brand" dim />
              <SummaryCard label="+ 사용 예정" value={ledger.scheduledUsed}     color="gray"  dim />
              <SummaryCard label="잔여 예정"   value={ledger.projectedRemaining} color={ledger.projectedRemaining < 0 ? 'red' : 'green'} dim />
            </div>
          </div>

          {/* ── Breakdown by type (6-way) ─────────────────── */}
          {Object.keys(ledger.byType).length > 0 && (
            <section>
              <h3 className="mb-2 text-xs font-semibold text-muted uppercase tracking-wide">유형별 현황</h3>
              <div className="card p-0 overflow-hidden overflow-x-auto">
                <table className="w-full text-xs min-w-[480px]">
                  <thead>
                    <tr className="bg-surface-50 border-b border-border text-muted">
                      <th className="px-3 py-2 text-left font-medium" rowSpan={2}>유형</th>
                      <th className="px-3 py-1.5 text-center font-medium border-l border-border" colSpan={2}>적립</th>
                      <th className="px-3 py-1.5 text-center font-medium border-l border-border" colSpan={2}>사용</th>
                    </tr>
                    <tr className="bg-surface-50 border-b border-border text-muted">
                      <th className="px-3 py-1.5 text-right font-medium border-l border-border">실제</th>
                      <th className="px-3 py-1.5 text-right font-medium text-muted/60">예정</th>
                      <th className="px-3 py-1.5 text-right font-medium border-l border-border">실제</th>
                      <th className="px-3 py-1.5 text-right font-medium text-muted/60">예정</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {(Object.entries(ledger.byType) as [AccrualType, NonNullable<typeof ledger.byType[AccrualType]>][]).map(([type, v]) => (
                      <tr key={type} className="hover:bg-surface-50">
                        <td className="px-3 py-2 font-medium text-gray-700">{type}</td>
                        <td className="px-3 py-2 text-right border-l border-border">{v.actualAccrued}</td>
                        <td className="px-3 py-2 text-right text-muted">{v.scheduledAccrued}</td>
                        <td className="px-3 py-2 text-right border-l border-border">{v.actualUsed}</td>
                        <td className="px-3 py-2 text-right text-muted">{v.scheduledUsed}</td>
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
              <div className="flex items-center gap-2">
                {accrualGroups.length > 0 && (
                  <button
                    onClick={() => setExpandedAccrualFYs(
                      expandedAccrualFYs.size === accrualGroups.length
                        ? new Set()
                        : new Set(accrualGroups.map(([fy]) => fy))
                    )}
                    className="text-[11px] text-brand-600 hover:underline"
                  >
                    {expandedAccrualFYs.size === accrualGroups.length ? '전체 접기' : '전체 펼치기'}
                  </button>
                )}
                {canEditThis && !showAddAccrual && !showAddUsage && (
                  <button onClick={() => setShowAddAccrual(true)} className="btn-secondary text-xs py-0.5 gap-1">
                    <Plus size={11} /> 수동 적립
                  </button>
                )}
              </div>
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
                  <colgroup>
                    <col className="w-28" />
                    <col className="w-36" />
                    <col />
                    <col className="w-14" />
                    {canEditThis && <col className="w-7" />}
                  </colgroup>
                  <thead>
                    <tr className="bg-surface-50 border-b border-border text-muted">
                      <th className="px-3 py-2 text-left font-medium whitespace-nowrap">날짜</th>
                      <th className="px-3 py-2 text-left font-medium">유형</th>
                      <th className="px-3 py-2 text-left font-medium">원천</th>
                      <th className="px-3 py-2 text-right font-medium whitespace-nowrap">일수</th>
                      {canEditThis && <th className="px-2 py-2 w-7" />}
                    </tr>
                  </thead>
                  <tbody>
                    {accrualGroups.map(([fy, entries]) => {
                      const sub     = entries.reduce((s, e) => s + e.days, 0)
                      const colSpan = canEditThis ? 5 : 4
                      const isOpen  = expandedAccrualFYs.has(fy)
                      return (
                        <Fragment key={fy}>
                          <tr
                            className="bg-slate-100/70 border-y border-border/60 cursor-pointer select-none hover:bg-slate-200/60 transition-colors"
                            onClick={() => toggleAccrualFY(fy)}
                          >
                            <td colSpan={colSpan} className="px-3 py-1.5">
                              <span className="flex items-center gap-1.5 text-[11px] font-semibold text-muted tracking-wide">
                                {isOpen
                                  ? <ChevronDown size={12} className="shrink-0" />
                                  : <ChevronRight size={12} className="shrink-0" />}
                                {fyRangeLabel(fy)}
                                {!isOpen && <span className="ml-auto font-semibold text-brand-700">+{sub}</span>}
                              </span>
                            </td>
                          </tr>
                          {isOpen && entries.map(e => (
                            <tr key={e.id} className="hover:bg-surface-50 border-b border-border/40">
                              <td className="px-3 py-2 font-mono">{e.date}</td>
                              <td className="px-3 py-2">
                                <span className="pill bg-brand-100 text-brand-700">{e.type}</span>
                              </td>
                              <td className="px-3 py-2 text-muted">
                                {accrualSrcVal(e.note, e.sourceId ? wiMap.get(e.sourceId) : undefined)}
                              </td>
                              <td className="px-3 py-2 text-right font-medium">+{e.days}</td>
                              {canEditThis && (
                                <td className="px-2 py-2">
                                  {!e.isAuto && (
                                    <button
                                      onClick={ev => { ev.stopPropagation(); void handleDeleteAccrual(e.id, '이 적립을 삭제할까요?') }}
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
                          {isOpen && (
                            <tr className="bg-surface-50/80 border-b border-border">
                              <td colSpan={3} className="px-3 py-1.5 text-[11px] text-right text-muted">소계</td>
                              <td className="px-3 py-1.5 text-right text-[11px] font-semibold text-brand-700">+{sub}</td>
                              {canEditThis && <td />}
                            </tr>
                          )}
                        </Fragment>
                      )
                    })}
                  </tbody>
                  <tfoot>
                    <tr className="bg-surface-50 border-t-2 border-border">
                      <td colSpan={3} className="px-3 py-2 text-xs font-semibold text-gray-700">전체 합계</td>
                      <td className="px-3 py-2 text-right font-bold text-brand-700">
                        +{ledger.accruals.reduce((s, e) => s + e.days, 0)}
                      </td>
                      {canEditThis && <td />}
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </section>

          {/* ── Usage history ─────────────────────────────── */}
          <section>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-xs font-semibold text-muted uppercase tracking-wide">사용 이력 (유급)</h3>
              <div className="flex items-center gap-2">
                {usageGroups.length > 0 && (
                  <button
                    onClick={() => setExpandedUsageFYs(
                      expandedUsageFYs.size === usageGroups.length
                        ? new Set()
                        : new Set(usageGroups.map(([fy]) => fy))
                    )}
                    className="text-[11px] text-brand-600 hover:underline"
                  >
                    {expandedUsageFYs.size === usageGroups.length ? '전체 접기' : '전체 펼치기'}
                  </button>
                )}
                {canEditThis && !showAddUsage && !showAddAccrual && (
                  <button onClick={() => setShowAddUsage(true)} className="btn-secondary text-xs py-0.5 gap-1 text-red-600 border-red-200 hover:bg-red-50">
                    <Plus size={11} /> 수동 차감
                  </button>
                )}
              </div>
            </div>

            {showAddUsage && (
              <AccrualForm
                personId={person.id}
                direction="usage"
                specialLeaveBalance={specialLeaveBalance}
                onDone={() => setShowAddUsage(false)}
              />
            )}

            {ledger.usages.length === 0 ? (
              <p className="text-xs text-muted text-center py-4">사용 내역 없음</p>
            ) : (
              <div className="card p-0 overflow-hidden">
                <table className="w-full text-xs">
                  <colgroup>
                    <col className="w-44" />
                    <col className="w-36" />
                    <col className="w-14" />
                    <col />
                    {canEditThis && <col className="w-7" />}
                  </colgroup>
                  <thead>
                    <tr className="bg-surface-50 border-b border-border text-muted">
                      <th className="px-3 py-2 text-left font-medium whitespace-nowrap">기간</th>
                      <th className="px-3 py-2 text-left font-medium">유형</th>
                      <th className="px-3 py-2 text-right font-medium whitespace-nowrap">일수</th>
                      <th className="px-3 py-2 text-left font-medium">원천</th>
                      {canEditThis && <th className="px-2 py-2 w-7" />}
                    </tr>
                  </thead>
                  <tbody>
                    {usageGroups.map(([fy, entries]) => {
                      const sub     = entries.reduce((s, u) => s + u.days, 0)
                      const colSpan = canEditThis ? 5 : 4
                      const isOpen  = expandedUsageFYs.has(fy)
                      return (
                        <Fragment key={fy}>
                          <tr
                            className="bg-slate-100/70 border-y border-border/60 cursor-pointer select-none hover:bg-slate-200/60 transition-colors"
                            onClick={() => toggleUsageFY(fy)}
                          >
                            <td colSpan={colSpan} className="px-3 py-1.5">
                              <span className="flex items-center gap-1.5 text-[11px] font-semibold text-muted tracking-wide">
                                {isOpen
                                  ? <ChevronDown size={12} className="shrink-0" />
                                  : <ChevronRight size={12} className="shrink-0" />}
                                {fyRangeLabel(fy)}
                                {!isOpen && <span className="ml-auto font-semibold text-gray-700">{sub}일</span>}
                              </span>
                            </td>
                          </tr>
                          {isOpen && entries.map(u => (
                            <tr key={u.assignmentId} className="border-b border-border/40 hover:bg-surface-50">
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
                                {u.deductions.length === 0
                                  ? '—'
                                  : <span className="flex flex-wrap gap-x-1 gap-y-0.5">
                                      {u.deductions.map((d, i) => {
                                        const acc = accrualByIdUI.get(d.accrualId)
                                        const wi  = d.sourceId ? wiMap.get(d.sourceId) : undefined
                                        return <span key={i}>{acc ? fmtDeducSrc(acc.type, acc.note, wi, d.days) : `? ${d.days}일`}</span>
                                      })}
                                    </span>
                                }
                              </td>
                              {canEditThis && (
                                <td className="px-2 py-2">
                                  {u.isManual && (
                                    <button
                                      onClick={ev => { ev.stopPropagation(); void handleDeleteAccrual(u.assignmentId, '이 수동 차감을 삭제할까요?') }}
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
                          {isOpen && (
                            <tr className="bg-surface-50/80 border-b border-border">
                              <td colSpan={2} className="px-3 py-1.5 text-[11px] text-right text-muted">소계</td>
                              <td className="px-3 py-1.5 text-right text-[11px] font-semibold">{sub}일</td>
                              <td colSpan={canEditThis ? 2 : 1} />
                            </tr>
                          )}
                        </Fragment>
                      )
                    })}
                  </tbody>
                  <tfoot>
                    <tr className="bg-surface-50 border-t-2 border-border">
                      <td colSpan={2} className="px-3 py-2 text-xs font-semibold text-gray-700">전체 합계</td>
                      <td className="px-3 py-2 text-right font-bold text-gray-800">{ledger.totalUsed}일</td>
                      <td colSpan={canEditThis ? 2 : 1} />
                    </tr>
                  </tfoot>
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

          {/* ── Combined history ─────────────────────────── */}
          {combinedFYGroups.length > 0 && (
            <section>
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-xs font-semibold text-muted uppercase tracking-wide">통합 이력</h3>
                {combinedFYGroups.length > 0 && (
                  <button
                    onClick={() => setExpandedCombinedFYs(
                      expandedCombinedFYs.size === combinedFYGroups.length
                        ? new Set()
                        : new Set(combinedFYGroups.map(([fy]) => fy))
                    )}
                    className="text-[11px] text-brand-600 hover:underline"
                  >
                    {expandedCombinedFYs.size === combinedFYGroups.length ? '전체 접기' : '전체 펼치기'}
                  </button>
                )}
              </div>
              <div className="card p-0 overflow-hidden">
                <table className="w-full text-xs">
                  <colgroup>
                    <col className="w-44" />
                    <col className="w-16" />
                    <col className="w-36" />
                    <col />
                    <col className="w-14" />
                    <col className="w-14" />
                  </colgroup>
                  <thead>
                    <tr className="bg-surface-50 border-b border-border text-muted">
                      <th className="px-3 py-2 text-left font-medium whitespace-nowrap">날짜/기간</th>
                      <th className="px-3 py-2 text-left font-medium">구분</th>
                      <th className="px-3 py-2 text-left font-medium">유형</th>
                      <th className="px-3 py-2 text-left font-medium">원천</th>
                      <th className="px-3 py-2 text-right font-medium whitespace-nowrap">일수(±)</th>
                      <th className="px-3 py-2 text-right font-medium whitespace-nowrap">잔액</th>
                    </tr>
                  </thead>
                  <tbody>
                    {combinedFYGroups.map(([fy, entries]) => {
                      const isOpen  = expandedCombinedFYs.has(fy)
                      const finalBal = entries[entries.length - 1].balance
                      return (
                        <Fragment key={fy}>
                          <tr
                            className="bg-slate-100/70 border-y border-border/60 cursor-pointer select-none hover:bg-slate-200/60 transition-colors"
                            onClick={() => toggleCombinedFY(fy)}
                          >
                            <td colSpan={6} className="px-3 py-1.5">
                              <span className="flex items-center gap-1.5 text-[11px] font-semibold text-muted tracking-wide">
                                {isOpen
                                  ? <ChevronDown size={12} className="shrink-0" />
                                  : <ChevronRight size={12} className="shrink-0" />}
                                {fyRangeLabel(fy)}
                                {!isOpen && (
                                  <span className={`ml-auto font-semibold tabular-nums ${finalBal < 0 ? 'text-red-600' : 'text-emerald-600'}`}>
                                    잔액 {finalBal}일
                                  </span>
                                )}
                              </span>
                            </td>
                          </tr>
                          {isOpen && entries.map((e, idx) => (
                            <tr key={idx} className="border-b border-border/40 hover:bg-surface-50">
                              <td className="px-3 py-2 font-mono">{e.period}</td>
                              <td className="px-3 py-2">
                                {e.kind === 'accrual'
                                  ? <span className="pill bg-brand-100 text-brand-700">적립</span>
                                  : e.kind === 'usage'
                                    ? <span className="pill bg-violet-100 text-violet-700">사용</span>
                                    : <span className="pill bg-gray-100 text-gray-600">무급</span>}
                              </td>
                              <td className="px-3 py-2">
                                <span className={`pill ${e.kind === 'accrual' ? 'bg-brand-50 text-brand-600' : e.kind === 'usage' ? 'bg-violet-50 text-violet-600' : 'bg-gray-50 text-gray-500'}`}>
                                  {e.type}
                                </span>
                              </td>
                              <td className="px-3 py-2 text-muted text-[11px]">{e.source}</td>
                              <td className="px-3 py-2 text-right font-medium tabular-nums">
                                {e.change > 0
                                  ? <span className="text-emerald-600">+{e.change}</span>
                                  : e.change < 0
                                    ? <span className="text-red-600">{e.change}</span>
                                    : <span className="text-muted">—</span>}
                              </td>
                              <td className="px-3 py-2 text-right font-medium tabular-nums">
                                <span className={e.balance < 0 ? 'text-red-600' : e.balance > 0 ? 'text-emerald-700' : 'text-muted'}>
                                  {e.balance}
                                </span>
                              </td>
                            </tr>
                          ))}
                          {isOpen && (
                            <tr className="bg-surface-50/80 border-b border-border">
                              <td colSpan={5} className="px-3 py-1.5 text-[11px] text-right text-muted">FY{String(fy).slice(-2)} 말 잔액</td>
                              <td className={`px-3 py-1.5 text-right text-[11px] font-semibold tabular-nums ${finalBal < 0 ? 'text-red-600' : 'text-emerald-700'}`}>
                                {finalBal}일
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {/* ── Assign remaining action ───────────────────── */}
          {canEditThis && ledger.remaining > 0 && person.rank !== 'Partner' && (
            <div className="rounded-md border border-brand-200 bg-brand-50 p-3 flex items-center justify-between">
              <div>
                <p className="text-xs font-semibold text-brand-800">잔여 휴가 소진 배정</p>
                <p className="text-xs text-brand-700 mt-0.5">
                  기준일 이후 빈 영업일 {Math.floor(ledger.remaining)}일 — 프로젝트휴가로 일괄 배정 생성
                  (차감 원천은 FIFO 규칙으로 자동 계산)
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
      <div className="flex-1 overflow-auto p-6 space-y-4 max-w-7xl">
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
const CARD_STYLES: Record<CardColor, { bg: string; dimBg: string; text: string; dimText: string; num: string; dimNum: string }> = {
  brand: { bg: 'bg-brand-50',    dimBg: 'bg-white border border-brand-200',   text: 'text-brand-700',   dimText: 'text-brand-400',   num: 'text-brand-800',  dimNum: 'text-brand-500'   },
  gray:  { bg: 'bg-surface-100', dimBg: 'bg-white border border-border',      text: 'text-muted',       dimText: 'text-muted',        num: 'text-gray-800',   dimNum: 'text-gray-400'    },
  green: { bg: 'bg-emerald-50',  dimBg: 'bg-white border border-emerald-200', text: 'text-emerald-700', dimText: 'text-emerald-400', num: 'text-emerald-900', dimNum: 'text-emerald-500' },
  red:   { bg: 'bg-red-50',      dimBg: 'bg-white border border-red-200',     text: 'text-red-600',     dimText: 'text-red-300',     num: 'text-red-700',     dimNum: 'text-red-400'     },
}

function SummaryCard({ label, value, color, dim }: { label: string; value: number; color: CardColor; dim?: boolean }) {
  const s = CARD_STYLES[color]
  const bg   = dim ? s.dimBg   : s.bg
  const text = dim ? s.dimText : s.text
  const num  = dim ? s.dimNum  : s.num
  return (
    <div className={`rounded-lg p-3 ${bg}`}>
      <p className={`text-xs font-medium ${text}`}>{label}</p>
      {dim
        ? <p className={`text-xl font-semibold tabular-nums mt-1 ${num}`}>{value}</p>
        : <p className={`text-2xl font-bold tabular-nums mt-1 ${num}`}>{value}</p>
      }
      <p className={`text-xs ${text}`}>일</p>
    </div>
  )
}
