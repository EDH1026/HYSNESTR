/**
 * computeLedger — pure leave-ledger engine (PRD §7)
 *
 * Produces a fully-computed snapshot of one person's leave account:
 *   • Auto-accruals derived from assignments (프로젝트휴가, 주말/휴일대체)
 *   • Stored manual accruals (포상휴가, 특별휴가, 지연보상, …)
 *   • FIFO deductions per paid leave usage
 *   • Unpaid leave list (리프레시, 휴직)
 *
 * No side effects; safe to call in useMemo.
 */

import { dateToNum, numToStr, numToDate, isWeekend } from '@/lib/date'
import type { WorkItem, Assignment, Accrual, AccrualType, LeaveType } from '@/types'

// ── Output types ──────────────────────────────────────────────

export interface LedgerAccrualEntry {
  id:        string        // deterministic for auto-accruals, DB uuid for stored
  type:      AccrualType
  days:      number
  date:      string        // YYYY-MM-DD  when this accrual was credited
  sourceId:  string | null // work_item_id origin
  remaining: number        // after FIFO deductions (≥ 0)
  isAuto:    boolean       // true = derived; false = stored in DB
}

export interface LedgerDeduction {
  accrualId: string
  sourceId:  string | null // which work_item backed this accrual
  days:      number
}

export interface LedgerUsageEntry {
  assignmentId: string
  start:        string
  end:          string
  type:         LeaveType
  days:         number        // working days in this leave period
  deductions:   LedgerDeduction[]
  deficit:      number        // days used beyond available balance (≥ 0)
  note?:        string | null
  isManual?:    boolean       // true = direction='usage' accrual record (not an assignment)
}

export interface LedgerUnpaidEntry {
  assignmentId: string
  start:        string
  end:          string
  type:         LeaveType    // '리프레시' | '휴직'
  days:         number       // working days in the period
}

export interface Ledger {
  asOf:         number      // reference day number (today param)
  accruals:     LedgerAccrualEntry[]
  usages:       LedgerUsageEntry[]
  unpaid:       LedgerUnpaidEntry[]
  totalAccrued: number      // all accruals (actual + scheduled)
  totalUsed:    number      // all usages
  remaining:    number      // totalAccrued − totalUsed
  byType:       Partial<Record<AccrualType, {
    accrued:          number
    used:             number
    actualAccrued:    number   // LV-5: date ≤ asOf
    scheduledAccrued: number   // LV-5: date > asOf
    actualUsed:       number   // LV-5: workdays on/before asOf
    scheduledUsed:    number   // LV-5: workdays after asOf
  }>>
  // LV-5 §7-8: 6-way as-of classification
  actualAccrued:      number   // 실제 적립 — accruals with date ≤ asOf
  scheduledAccrued:   number   // 적립 예정 — accruals with date > asOf
  actualUsed:         number   // 실제 사용 — workdays used on/before asOf
  scheduledUsed:      number   // 사용 예정 — workdays to be used after asOf
  currentRemaining:   number   // 현재 잔여 = actualAccrued − actualUsed
  projectedRemaining: number   // 잔여 예정 = (actualAccrued+scheduledAccrued) − (actualUsed+scheduledUsed)
}

// ── Leave type classification ─────────────────────────────────

const UNPAID = new Set<LeaveType>(['리프레시', '휴직'])

function isPaidLeave(type: LeaveType | null): boolean {
  return type !== null && !UNPAID.has(type)
}

// ── LV-5: FIFO source type restrictions ──────────────────────

// 지정휴가 사용 시 매칭 가능한 적립 원천 (우선순위 순)
const JIEONG_PRIORITY: AccrualType[] = ['주말/휴일대체', '프로젝트휴가', '포상휴가', '지연보상']
const JIEONG_SOURCES  = new Set<AccrualType>(JIEONG_PRIORITY)

/** Return FIFO-eligible accruals for a given usage type (LV-5). */
function fifoSourceAccruals(
  type:        LeaveType,
  allAccruals: LedgerAccrualEntry[],
): LedgerAccrualEntry[] {
  if (type === '특별휴가') {
    return allAccruals.filter(a => a.type === '특별휴가')
  }
  if (type === '지정휴가') {
    return allAccruals
      .filter(a => JIEONG_SOURCES.has(a.type))
      .sort((a, b) => {
        const pa = JIEONG_PRIORITY.indexOf(a.type)
        const pb = JIEONG_PRIORITY.indexOf(b.type)
        if (pa !== pb) return pa - pb
        return a.date.localeCompare(b.date) || a.id.localeCompare(b.id)
      })
  }
  return allAccruals
}

// ── Delay compensation table ──────────────────────────────────

/** Additional days granted when accrued project leave goes unused ≥ 15 days. */
export function delayBonus(accrued: number): number {
  if (accrued <= 1.0) return 0
  if (accrued <= 3.0) return 1
  if (accrued <= 5.0) return 2
  return 3
}

// ── Workday counter (inline, avoids importing ReadonlySet version) ────

function countWorkdays(
  startNum: number,
  endNum:   number,
  isHol:    (n: number) => boolean,
): number {
  let c = 0
  for (let n = startNum; n <= endNum; n++) {
    if (!isWeekend(n) && !isHol(n)) c++
  }
  return c
}

// ── Main function ─────────────────────────────────────────────

export function computeLedger(
  personId: string,
  opts: {
    workItems:   WorkItem[]
    assignments: Assignment[]
    accruals:    Accrual[]
    isHoliday:   (n: number) => boolean
    today:       number          // reference date (day number)
    personRank?: string          // §7-7: 'Partner' skips all auto-accruals
  },
): Ledger {
  const { workItems, assignments, accruals, isHoliday, today, personRank } = opts
  const isPartner = personRank === 'Partner'

  // ── Filter to this person ──────────────────────────────────
  const myAssignments = assignments.filter(a => a.person_id === personId)
  const myAccruals    = accruals.filter(a => a.person_id === personId)

  // Work-item lookup map
  const wiMap = new Map(workItems.map(w => [w.id, w]))

  // ── Step 1: Auto-accruals from work assignments ────────────
  // §7-7: Partner rank is excluded from all auto-accruals.

  const autoAccruals: LedgerAccrualEntry[] = []

  // §7.1: collect per-project intervals for 프로젝트휴가 (one round per project, not per assignment)
  const projIntervals = new Map<string, { wi: WorkItem; ivs: Array<{s: number; e: number}> }>()

  if (!isPartner) for (const a of myAssignments) {
    if (a.kind !== 'work' || !a.work_item_id) continue
    const wi = wiMap.get(a.work_item_id)
    if (!wi || wi.type === 'pipeline') continue   // pipeline: no accruals

    // 1a. Accumulate (assignment ∩ main phase) intervals per project
    if (wi.type === 'project' && wi.main_start) {
      const mainS = dateToNum(wi.main_start)
      const mainE = dateToNum(wi.end_date)
      const aS    = dateToNum(a.start)
      const aE    = dateToNum(a.end_date)
      const intS  = Math.max(aS, mainS)
      const intE  = Math.min(aE, mainE)
      if (intE >= intS) {
        const bucket = projIntervals.get(wi.id)
        if (bucket) bucket.ivs.push({ s: intS, e: intE })
        else projIntervals.set(wi.id, { wi, ivs: [{ s: intS, e: intE }] })
      }
    }

    // 1b. 주말/휴일대체: any non-pipeline work assignment's weekend_dates
    if (a.weekend_dates.length > 0) {
      let wkDays = 0
      for (const d of a.weekend_dates) {
        const n = dateToNum(d)
        // Weekend (Sat/Sun) → 0.5 regardless of holiday; non-weekend holiday → 1.0 (PRD §7-2)
        wkDays += isWeekend(n) ? 0.5 : 1.0
      }
      if (wkDays > 0) {
        autoAccruals.push({
          id:        `auto-wknd-${a.id}`,
          type:      '주말/휴일대체',
          days:      wkDays,
          date:      wi.end_date,
          sourceId:  wi.id,
          remaining: wkDays,
          isAuto:    true,
        })
      }
    }
  }

  // 1a. Per-project 프로젝트휴가: merge overlapping intervals, sum, round once
  for (const [wiId, { wi, ivs }] of projIntervals) {
    const sorted = [...ivs].sort((a, b) => a.s - b.s)
    const merged: Array<{s: number; e: number}> = [{ ...sorted[0] }]
    for (let i = 1; i < sorted.length; i++) {
      const last = merged[merged.length - 1]
      if (sorted[i].s <= last.e + 1) {
        if (sorted[i].e > last.e) last.e = sorted[i].e
      } else {
        merged.push({ ...sorted[i] })
      }
    }
    const totalCalDays = merged.reduce((sum, iv) => sum + (iv.e - iv.s + 1), 0)
    const days = Math.round(totalCalDays / 10)
    if (days > 0) {
      autoAccruals.push({
        id:        `auto-proj-${wiId}`,
        type:      '프로젝트휴가',
        days,
        date:      wi.end_date,
        sourceId:  wi.id,
        remaining: days,
        isAuto:    true,
      })
    }
  }

  // ── Step 3: Merge stored + auto accruals, sort by date asc ─
  // §7.3: 지연보상 is manual-only; no auto-calc here.
  // Split stored accruals by direction
  const accrualRecords = myAccruals.filter(a => a.direction !== 'usage')
  const manualUsageRecords = myAccruals.filter(a => a.direction === 'usage')

  const storedEntries: LedgerAccrualEntry[] = accrualRecords.map(a => ({
    id:        a.id,
    type:      a.type,
    days:      a.days,
    date:      a.date,
    sourceId:  a.source ?? null,
    remaining: a.days,
    isAuto:    false,
  }))

  const allAccruals: LedgerAccrualEntry[] = [...storedEntries, ...autoAccruals]
    .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id))

  // ── Step 4: FIFO deduction over paid leave usages ──────────
  // Merge assignment-based paid leave with manual deduction records, sorted by date
  type UsageEvent =
    | { kind: 'asgn';   date: string; a: (typeof myAssignments)[number] }
    | { kind: 'manual'; date: string; m: (typeof myAccruals)[number] }

  const paidLeave = myAssignments
    .filter(a => a.kind === 'leave' && isPaidLeave(a.leave_type))

  const events: UsageEvent[] = [
    ...paidLeave.map(a   => ({ kind: 'asgn'   as const, date: a.start, a })),
    ...manualUsageRecords.map(m => ({ kind: 'manual' as const, date: m.date, m })),
  ].sort((x, y) => x.date.localeCompare(y.date))

  const usages: LedgerUsageEntry[] = []

  for (const ev of events) {
    let id: string, start: string, end: string, type: LeaveType
    let days: number, note: string | null = null

    if (ev.kind === 'asgn') {
      const a = ev.a
      days  = countWorkdays(dateToNum(a.start), dateToNum(a.end_date), isHoliday)
      id    = a.id
      start = a.start
      end   = a.end_date
      type  = a.leave_type!
    } else {
      const m = ev.m
      days  = m.days
      id    = m.id
      start = m.date
      end   = m.date
      type  = m.type as LeaveType
      note  = m.note
    }

    // §5.10: negative/zero = reversal/cancellation — skip FIFO, no deduction source
    if (days <= 0) {
      usages.push({ assignmentId: id, start, end, type, days, deductions: [], deficit: 0, note, isManual: ev.kind === 'manual' })
      continue
    }

    let remaining = days
    const deductions: LedgerDeduction[] = []

    const sourceAccruals = fifoSourceAccruals(type, allAccruals)
    for (const acc of sourceAccruals) {
      if (remaining <= 0) break
      if (acc.remaining <= 0) continue
      const take = Math.min(acc.remaining, remaining)
      acc.remaining = Math.round((acc.remaining - take) * 10) / 10
      remaining    = Math.round((remaining - take) * 10) / 10
      deductions.push({ accrualId: acc.id, sourceId: acc.sourceId, days: take })
    }

    usages.push({
      assignmentId: id,
      start,
      end,
      type,
      days,
      deductions,
      deficit:   remaining,
      note,
      isManual:  ev.kind === 'manual',
    })
  }

  // ── Step 5: Unpaid leave entries ───────────────────────────
  const unpaid: LedgerUnpaidEntry[] = myAssignments
    .filter(a => a.kind === 'leave' && a.leave_type && UNPAID.has(a.leave_type))
    .map(a => ({
      assignmentId: a.id,
      start:        a.start,
      end:          a.end_date,
      type:         a.leave_type!,
      days: countWorkdays(dateToNum(a.start), dateToNum(a.end_date), isHoliday),
    }))

  // ── Step 6: Summary totals ─────────────────────────────────
  // §5.10: totalUsed = actual days consumed regardless of accrual coverage (deficit allowed)
  const totalAccrued = Math.round(allAccruals.reduce((s, e) => s + e.days, 0) * 10) / 10
  const totalUsed    = Math.round(usages.reduce((s, u) => s + u.days, 0) * 10) / 10
  const remaining    = Math.round((totalAccrued - totalUsed) * 10) / 10

  // LV-5 §7-8: 6-way as-of classification ──────────────────
  const asOfDateStr = numToStr(today)

  // Split accruals: date ≤ asOf → actual; date > asOf → scheduled
  let _actualAccrued = 0, _scheduledAccrued = 0
  for (const e of allAccruals) {
    if (e.date <= asOfDateStr) _actualAccrued    += e.days
    else                       _scheduledAccrued += e.days
  }
  const actualAccrued    = Math.round(_actualAccrued    * 10) / 10
  const scheduledAccrued = Math.round(_scheduledAccrued * 10) / 10

  // Split usages: workdays on/before asOf → actual; workdays after asOf → scheduled
  let _actualUsed = 0, _scheduledUsed = 0
  for (const u of usages) {
    if (u.isManual) {
      if (u.start <= asOfDateStr) _actualUsed    += u.days
      else                        _scheduledUsed += u.days
    } else {
      const uS = dateToNum(u.start), uE = dateToNum(u.end)
      if (uE <= today) {
        _actualUsed += u.days
      } else if (uS > today) {
        _scheduledUsed += u.days
      } else {
        const act = countWorkdays(uS, today, isHoliday)
        _actualUsed    += act
        _scheduledUsed += Math.max(0, u.days - act)
      }
    }
  }
  const actualUsed       = Math.round(_actualUsed    * 10) / 10
  const scheduledUsed    = Math.round(_scheduledUsed * 10) / 10
  const currentRemaining   = Math.round((actualAccrued - actualUsed) * 10) / 10
  const projectedRemaining = Math.round((actualAccrued + scheduledAccrued - actualUsed - scheduledUsed) * 10) / 10

  // Breakdown by accrual type (FIFO-based) with 6-way split ─
  type ByTypeEntry = {
    accrued: number; used: number
    actualAccrued: number; scheduledAccrued: number
    actualUsed: number; scheduledUsed: number
  }
  const makeEntry = (): ByTypeEntry =>
    ({ accrued: 0, used: 0, actualAccrued: 0, scheduledAccrued: 0, actualUsed: 0, scheduledUsed: 0 })
  const byType: Partial<Record<AccrualType, ByTypeEntry>> = {}

  for (const e of allAccruals) {
    const entry = (byType[e.type] ??= makeEntry())
    entry.accrued = Math.round((entry.accrued + e.days) * 10) / 10
    if (e.date <= asOfDateStr) entry.actualAccrued    = Math.round((entry.actualAccrued    + e.days) * 10) / 10
    else                       entry.scheduledAccrued = Math.round((entry.scheduledAccrued + e.days) * 10) / 10
  }

  for (const u of usages) {
    // Compute actual fraction for workdays in this usage that fall on/before asOf
    let actFrac: number
    if (u.days === 0) {
      actFrac = 0
    } else if (u.isManual) {
      actFrac = u.start <= asOfDateStr ? 1 : 0
    } else {
      const uS = dateToNum(u.start), uE = dateToNum(u.end)
      if (uE <= today)   actFrac = 1
      else if (uS > today) actFrac = 0
      else actFrac = countWorkdays(uS, today, isHoliday) / u.days
    }

    for (const d of u.deductions) {
      const acc = allAccruals.find(e => e.id === d.accrualId)
      if (acc) {
        const entry = (byType[acc.type] ??= makeEntry())
        entry.used = Math.round((entry.used + d.days) * 10) / 10
        const dAct   = Math.round(d.days * actFrac       * 10) / 10
        const dSched = Math.round(d.days * (1 - actFrac) * 10) / 10
        entry.actualUsed    = Math.round((entry.actualUsed    + dAct)   * 10) / 10
        entry.scheduledUsed = Math.round((entry.scheduledUsed + dSched) * 10) / 10
      }
    }
  }

  return {
    asOf: today, accruals: allAccruals, usages, unpaid,
    totalAccrued, totalUsed, remaining, byType,
    actualAccrued, scheduledAccrued, actualUsed, scheduledUsed,
    currentRemaining, projectedRemaining,
  }
}

// ── Helpers re-exported for tests ─────────────────────────────

/** Expand a list of Holiday records to a Set of day numbers for a given year range. */
export function buildHolidaySet(
  holidays: { date: string; recurring: boolean }[],
  fromYear: number,
  toYear:   number,
): Set<number> {
  const s = new Set<number>()
  for (const h of holidays) {
    const base = dateToNum(h.date)
    if (!h.recurring) {
      s.add(base)
    } else {
      const d = numToDate(base)
      for (let y = fromYear; y <= toYear; y++) {
        s.add(dateToNum(new Date(Date.UTC(y, d.getUTCMonth(), d.getUTCDate()))))
      }
    }
  }
  return s
}
