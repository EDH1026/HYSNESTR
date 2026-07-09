/**
 * Unit tests for computeLedger (PRD §7 leave engine)
 *
 * Coverage:
 *   1. Project leave (프로젝트휴가): round(calDays / 10), intersection with main phase
 *   2. Weekend sub (주말/휴일대체): Sat=0.5, Sun=0.5; weekday holiday=1.0; weekend overrides holiday (PRD §7-2 v2.13)
 *   3. FIFO deduction order and remainder tracking
 *   4. Unpaid leave (no balance effect)
 *   5. Pipeline exclusion — no accruals from pipeline assignments
 *   6. delayBonus helper boundaries (reference table — 지연보상 is now manual-only, §7.3)
 */

import { describe, it, expect } from 'vitest'
import { computeLedger, delayBonus, buildHolidaySet } from './ledger'
import { dateToNum } from '@/lib/date'
import type { WorkItem, Assignment, Accrual } from '@/types'

// ── Test helpers ──────────────────────────────────────────────

const NO_HOLIDAY = (_n: number) => false

function mkWi(overrides: Partial<WorkItem> & { id: string; type: WorkItem['type'] }): WorkItem {
  return {
    name:             overrides.id,
    start:            overrides.start            ?? '2024-01-01',
    main_start:       overrides.main_start       ?? null,
    end_date:         overrides.end_date         ?? '2024-12-31',
    engagement_number: null,
    client:           null,
    hashtags:         [],
    ...overrides,
  }
}

let _aId = 1
function mkAssignment(
  overrides: Partial<Assignment> & { person_id: string },
): Assignment {
  return {
    id:            `a${_aId++}`,
    kind:          'work',
    work_item_id:  null,
    leave_type:    null,
    weekend_dates: [],
    note:          null,
    start:         '2024-01-01',
    end_date:      '2024-01-31',
    ...overrides,
  }
}

// ── 1. delayBonus helper (reference table for manual accrual, §7.3) ──

describe('delayBonus', () => {
  it('returns 0 for ≤ 1.0 days', () => {
    expect(delayBonus(0)).toBe(0)
    expect(delayBonus(0.5)).toBe(0)
    expect(delayBonus(1.0)).toBe(0)
  })

  it('returns 1 for 1.5 – 3.0 days', () => {
    expect(delayBonus(1.5)).toBe(1)
    expect(delayBonus(2.0)).toBe(1)
    expect(delayBonus(3.0)).toBe(1)
  })

  it('returns 2 for 3.5 – 5.0 days', () => {
    expect(delayBonus(3.5)).toBe(2)
    expect(delayBonus(4.0)).toBe(2)
    expect(delayBonus(5.0)).toBe(2)
  })

  it('returns 3 for ≥ 5.5 days', () => {
    expect(delayBonus(5.5)).toBe(3)
    expect(delayBonus(10)).toBe(3)
  })
})

// ── 2. Project leave accrual ─────────────────────────────────

describe('프로젝트휴가 auto-accrual', () => {
  const wi = mkWi({
    id:         'wi1',
    type:       'project',
    start:      '2024-01-01',
    main_start: '2024-02-01',
    end_date:   '2024-03-31',
  })

  it('accrues round(calDays / 10) for full overlap with main phase', () => {
    // main phase = Feb 1 → Mar 31 = 60 days → round(60/10) = 6
    const a = mkAssignment({
      person_id:   'p1',
      work_item_id: 'wi1',
      start:       '2024-02-01',
      end_date:    '2024-03-31',
    })
    const ledger = computeLedger('p1', {
      workItems:   [wi],
      assignments: [a],
      accruals:    [],
      isHoliday:   NO_HOLIDAY,
      today:       dateToNum('2024-04-01'),
    })
    const projEntry = ledger.accruals.find(e => e.type === '프로젝트휴가')
    expect(projEntry?.days).toBe(6)
  })

  it('intersects assignment dates with main phase (partial overlap)', () => {
    // assignment Feb 15 → Mar 31 = 46 days → round(46/10) = 5
    const a = mkAssignment({
      person_id:   'p1',
      work_item_id: 'wi1',
      start:       '2024-02-15',
      end_date:    '2024-03-31',
    })
    const ledger = computeLedger('p1', {
      workItems: [wi], assignments: [a], accruals: [],
      isHoliday: NO_HOLIDAY, today: dateToNum('2024-04-01'),
    })
    const days = ledger.accruals.find(e => e.type === '프로젝트휴가')?.days
    expect(days).toBe(5)
  })

  it('rounds 0.5 to 1 (5 intersection days)', () => {
    // main phase Jan 1 → Jan 5 = 5 days → round(5/10) = round(0.5) = 1
    const wi2 = mkWi({
      id: 'wi2', type: 'project',
      start: '2024-01-01', main_start: '2024-01-01', end_date: '2024-01-05',
    })
    const a = mkAssignment({
      person_id: 'p1', work_item_id: 'wi2',
      start: '2024-01-01', end_date: '2024-01-05',
    })
    const ledger = computeLedger('p1', {
      workItems: [wi2], assignments: [a], accruals: [],
      isHoliday: NO_HOLIDAY, today: dateToNum('2024-02-01'),
    })
    expect(ledger.accruals.find(e => e.type === '프로젝트휴가')?.days).toBe(1)
  })

  it('gives 0 when assignment is entirely in pre-study (before main_start)', () => {
    // assignment in Jan (pre-study phase only)
    const a = mkAssignment({
      person_id: 'p1', work_item_id: 'wi1',
      start: '2024-01-01', end_date: '2024-01-31',
    })
    const ledger = computeLedger('p1', {
      workItems: [wi], assignments: [a], accruals: [],
      isHoliday: NO_HOLIDAY, today: dateToNum('2024-04-01'),
    })
    expect(ledger.accruals.find(e => e.type === '프로젝트휴가')).toBeUndefined()
  })

  it('gives no accrual for proposals', () => {
    const proposal = mkWi({
      id: 'wi3', type: 'proposal',
      start: '2024-01-01', end_date: '2024-03-31',
    })
    const a = mkAssignment({
      person_id: 'p1', work_item_id: 'wi3',
      start: '2024-01-01', end_date: '2024-03-31',
    })
    const ledger = computeLedger('p1', {
      workItems: [proposal], assignments: [a], accruals: [],
      isHoliday: NO_HOLIDAY, today: dateToNum('2024-04-01'),
    })
    expect(ledger.accruals.filter(e => e.type === '프로젝트휴가')).toHaveLength(0)
  })
})

// ── §7.1 Split-assignment 프로젝트휴가 (per-project sum round) ──

describe('§7.1 split-assignment 프로젝트휴가', () => {
  const wi = mkWi({
    id:         'wi-split',
    type:       'project',
    start:      '2024-01-01',
    main_start: '2024-01-01',
    end_date:   '2024-12-31',
  })

  it('4+4 split → sum=8 → round(8/10)=1, single accrual entry', () => {
    // 2024-01-01 ~ 2024-01-04 = 4 cal days, 2024-01-10 ~ 2024-01-13 = 4 cal days
    const a1 = mkAssignment({ person_id: 'p1', work_item_id: 'wi-split', start: '2024-01-01', end_date: '2024-01-04' })
    const a2 = mkAssignment({ person_id: 'p1', work_item_id: 'wi-split', start: '2024-01-10', end_date: '2024-01-13' })
    const ledger = computeLedger('p1', {
      workItems: [wi], assignments: [a1, a2], accruals: [],
      isHoliday: NO_HOLIDAY, today: dateToNum('2025-01-10'),
    })
    const projEntries = ledger.accruals.filter(e => e.type === '프로젝트휴가')
    expect(projEntries).toHaveLength(1)
    expect(projEntries[0].days).toBe(1)
  })

  it('12+9 split → sum=21 → round(21/10)=2', () => {
    // 2024-01-01 ~ 2024-01-12 = 12 cal days, 2024-02-01 ~ 2024-02-09 = 9 cal days
    const a1 = mkAssignment({ person_id: 'p1', work_item_id: 'wi-split', start: '2024-01-01', end_date: '2024-01-12' })
    const a2 = mkAssignment({ person_id: 'p1', work_item_id: 'wi-split', start: '2024-02-01', end_date: '2024-02-09' })
    const ledger = computeLedger('p1', {
      workItems: [wi], assignments: [a1, a2], accruals: [],
      isHoliday: NO_HOLIDAY, today: dateToNum('2025-01-10'),
    })
    const projEntries = ledger.accruals.filter(e => e.type === '프로젝트휴가')
    expect(projEntries).toHaveLength(1)
    expect(projEntries[0].days).toBe(2)
  })

  it('overlapping assignments — overlap counted once, not twice', () => {
    // a1: 2024-01-01 ~ 2024-01-10 (10 days), a2: 2024-01-06 ~ 2024-01-20 (15 days)
    // union = 2024-01-01 ~ 2024-01-20 = 20 days → round(2.0) = 2
    // naive sum = 25 days → round(2.5) = 3  (wrong without dedup)
    const a1 = mkAssignment({ person_id: 'p1', work_item_id: 'wi-split', start: '2024-01-01', end_date: '2024-01-10' })
    const a2 = mkAssignment({ person_id: 'p1', work_item_id: 'wi-split', start: '2024-01-06', end_date: '2024-01-20' })
    const ledger = computeLedger('p1', {
      workItems: [wi], assignments: [a1, a2], accruals: [],
      isHoliday: NO_HOLIDAY, today: dateToNum('2025-01-10'),
    })
    const projEntries = ledger.accruals.filter(e => e.type === '프로젝트휴가')
    expect(projEntries).toHaveLength(1)
    expect(projEntries[0].days).toBe(2)   // union 20 days → round(2.0)=2, not naive 3
  })
})

// ── 3. Weekend sub accrual ────────────────────────────────────

describe('주말/휴일대체 auto-accrual', () => {
  const wi = mkWi({ id: 'wi1', type: 'project', end_date: '2024-01-31' })

  it('Saturday = 0.5 days per date', () => {
    // 2024-01-06 = Saturday
    const a = mkAssignment({
      person_id: 'p1', work_item_id: 'wi1',
      weekend_dates: ['2024-01-06'],
    })
    const ledger = computeLedger('p1', {
      workItems: [wi], assignments: [a], accruals: [],
      isHoliday: NO_HOLIDAY, today: dateToNum('2024-02-01'),
    })
    expect(ledger.accruals.find(e => e.type === '주말/휴일대체')?.days).toBe(0.5)
  })

  it('Sunday = 0.5 day (treated as weekend, same as Saturday)', () => {
    // 2024-01-07 = Sunday
    const a = mkAssignment({
      person_id: 'p1', work_item_id: 'wi1',
      weekend_dates: ['2024-01-07'],
    })
    const ledger = computeLedger('p1', {
      workItems: [wi], assignments: [a], accruals: [],
      isHoliday: NO_HOLIDAY, today: dateToNum('2024-02-01'),
    })
    expect(ledger.accruals.find(e => e.type === '주말/휴일대체')?.days).toBe(0.5)
  })

  it('Saturday that is also a holiday = 0.5 day (weekend overrides holiday)', () => {
    // 2024-01-06 = Saturday, also a holiday → weekend rule takes priority → 0.5
    const isHoliday = (n: number) => n === dateToNum('2024-01-06')
    const a = mkAssignment({
      person_id: 'p1', work_item_id: 'wi1',
      weekend_dates: ['2024-01-06'],
    })
    const ledger = computeLedger('p1', {
      workItems: [wi], assignments: [a], accruals: [],
      isHoliday, today: dateToNum('2024-02-01'),
    })
    expect(ledger.accruals.find(e => e.type === '주말/휴일대체')?.days).toBe(0.5)
  })

  it('Sunday that is also a holiday = 0.5 day (weekend overrides holiday)', () => {
    // 2024-01-07 = Sunday, also a holiday → weekend rule takes priority → 0.5
    const isHoliday = (n: number) => n === dateToNum('2024-01-07')
    const a = mkAssignment({
      person_id: 'p1', work_item_id: 'wi1',
      weekend_dates: ['2024-01-07'],
    })
    const ledger = computeLedger('p1', {
      workItems: [wi], assignments: [a], accruals: [],
      isHoliday, today: dateToNum('2024-02-01'),
    })
    expect(ledger.accruals.find(e => e.type === '주말/휴일대체')?.days).toBe(0.5)
  })

  it('weekday holiday = 1.0 day', () => {
    // 2024-01-15 = Monday, treated as holiday
    const isHoliday = (n: number) => n === dateToNum('2024-01-15')
    const a = mkAssignment({
      person_id: 'p1', work_item_id: 'wi1',
      weekend_dates: ['2024-01-15'],
    })
    const ledger = computeLedger('p1', {
      workItems: [wi], assignments: [a], accruals: [],
      isHoliday, today: dateToNum('2024-02-01'),
    })
    expect(ledger.accruals.find(e => e.type === '주말/휴일대체')?.days).toBe(1.0)
  })

  it('sums multiple weekend dates correctly', () => {
    // 2 Saturdays (0.5 each) + 1 Sunday (0.5) = 1.5
    const a = mkAssignment({
      person_id: 'p1', work_item_id: 'wi1',
      weekend_dates: ['2024-01-06', '2024-01-07', '2024-01-13'],
    })
    const ledger = computeLedger('p1', {
      workItems: [wi], assignments: [a], accruals: [],
      isHoliday: NO_HOLIDAY, today: dateToNum('2024-02-01'),
    })
    expect(ledger.accruals.find(e => e.type === '주말/휴일대체')?.days).toBe(1.5)
  })
})

// ── 4. FIFO deduction ─────────────────────────────────────────

describe('FIFO deduction', () => {
  it('deducts oldest accrual first', () => {
    // Accrual A: 2 days (Jan), Accrual B: 3 days (Feb)
    // Usage: 3 days → should deduct 2 from A, 1 from B
    const accruals: Accrual[] = [
      { id: 'accA', person_id: 'p1', type: '포상휴가', days: 2, date: '2024-01-10', source: null, note: null },
      { id: 'accB', person_id: 'p1', type: '특별휴가', days: 3, date: '2024-02-01', source: null, note: null },
    ]
    const leave = mkAssignment({
      person_id: 'p1', kind: 'leave', leave_type: '지정휴가',
      // 3 workdays: Mon Jan 15, Tue Jan 16, Wed Jan 17
      start: '2024-01-15', end_date: '2024-01-17',
    })
    const ledger = computeLedger('p1', {
      workItems: [], assignments: [leave], accruals,
      isHoliday: NO_HOLIDAY, today: dateToNum('2024-03-01'),
    })
    const usage = ledger.usages[0]
    expect(usage.days).toBe(3)
    expect(usage.deficit).toBe(0)

    // Should deduct 2 from accA first, then 1 from accB
    const deductA = usage.deductions.find(d => d.accrualId === 'accA')
    const deductB = usage.deductions.find(d => d.accrualId === 'accB')
    expect(deductA?.days).toBe(2)
    expect(deductB?.days).toBe(1)

    // Remaining: A = 0, B = 2
    expect(ledger.accruals.find(e => e.id === 'accA')?.remaining).toBe(0)
    expect(ledger.accruals.find(e => e.id === 'accB')?.remaining).toBe(2)
  })

  it('records deficit when usage exceeds all accruals', () => {
    const accruals: Accrual[] = [
      { id: 'accA', person_id: 'p1', type: '포상휴가', days: 1, date: '2024-01-10', source: null, note: null },
    ]
    // 3 workdays of leave but only 1 day accrued
    const leave = mkAssignment({
      person_id: 'p1', kind: 'leave', leave_type: '지정휴가',
      start: '2024-01-15', end_date: '2024-01-17',
    })
    const ledger = computeLedger('p1', {
      workItems: [], assignments: [leave], accruals,
      isHoliday: NO_HOLIDAY, today: dateToNum('2024-03-01'),
    })
    expect(ledger.usages[0].deficit).toBe(2)
    expect(ledger.usages[0].days).toBe(3)
    expect(ledger.totalUsed).toBe(3)   // §5.10: total leave days consumed regardless of accrual coverage
  })

  it('computes totalAccrued, totalUsed, remaining correctly', () => {
    const accruals: Accrual[] = [
      { id: 'a1', person_id: 'p1', type: '포상휴가', days: 5, date: '2024-01-10', source: null, note: null },
    ]
    // 2 workdays used
    const leave = mkAssignment({
      person_id: 'p1', kind: 'leave', leave_type: '지정휴가',
      start: '2024-01-15', end_date: '2024-01-16',
    })
    const ledger = computeLedger('p1', {
      workItems: [], assignments: [leave], accruals,
      isHoliday: NO_HOLIDAY, today: dateToNum('2024-03-01'),
    })
    expect(ledger.totalAccrued).toBe(5)
    expect(ledger.totalUsed).toBe(2)
    expect(ledger.remaining).toBe(3)
  })
})

// ── 6. Unpaid leave ───────────────────────────────────────────

describe('unpaid leave', () => {
  it('리프레시 and 휴직 are added to unpaid list, not deducted from balance', () => {
    const accruals: Accrual[] = [
      { id: 'a1', person_id: 'p1', type: '포상휴가', days: 5, date: '2024-01-10', source: null, note: null },
    ]
    const refresh = mkAssignment({
      person_id: 'p1', kind: 'leave', leave_type: '리프레시',
      start: '2024-01-15', end_date: '2024-01-19',   // 5 workdays
    })
    const ledger = computeLedger('p1', {
      workItems: [], assignments: [refresh], accruals,
      isHoliday: NO_HOLIDAY, today: dateToNum('2024-03-01'),
    })
    expect(ledger.unpaid).toHaveLength(1)
    expect(ledger.usages).toHaveLength(0)
    expect(ledger.remaining).toBe(5)  // balance untouched
  })
})

// ── 7. Pipeline exclusion ─────────────────────────────────────

describe('pipeline exclusion', () => {
  const pipeline = mkWi({
    id: 'wiP', type: 'pipeline',
    start: '2024-01-01', end_date: '2024-12-31',
  })

  it('pipeline work assignment generates no 프로젝트휴가', () => {
    const a = mkAssignment({
      person_id: 'p1', work_item_id: 'wiP',
      start: '2024-01-01', end_date: '2024-12-31',
    })
    const ledger = computeLedger('p1', {
      workItems: [pipeline], assignments: [a], accruals: [],
      isHoliday: NO_HOLIDAY, today: dateToNum('2025-01-01'),
    })
    expect(ledger.accruals).toHaveLength(0)
    expect(ledger.totalAccrued).toBe(0)
  })

  it('pipeline assignment weekend_dates generate no 주말/휴일대체', () => {
    const a = mkAssignment({
      person_id: 'p1', work_item_id: 'wiP',
      start: '2024-01-01', end_date: '2024-12-31',
      weekend_dates: ['2024-01-06', '2024-01-07', '2024-01-13'],
    })
    const ledger = computeLedger('p1', {
      workItems: [pipeline], assignments: [a], accruals: [],
      isHoliday: NO_HOLIDAY, today: dateToNum('2025-01-01'),
    })
    expect(ledger.accruals.find(e => e.type === '주말/휴일대체')).toBeUndefined()
  })

})

// ── 8. Workday counting (weekends and holidays excluded) ──────

describe('workday count in usage', () => {
  it('excludes weekends from leave duration', () => {
    // Mon Jan 15 → Fri Jan 19 = 5 workdays (no holidays)
    const accruals: Accrual[] = [
      { id: 'a1', person_id: 'p1', type: '포상휴가', days: 10, date: '2024-01-10', source: null, note: null },
    ]
    const leave = mkAssignment({
      person_id: 'p1', kind: 'leave', leave_type: '포상휴가',
      start: '2024-01-15', end_date: '2024-01-21', // Mon–Sun = 5 workdays
    })
    const ledger = computeLedger('p1', {
      workItems: [], assignments: [leave], accruals,
      isHoliday: NO_HOLIDAY, today: dateToNum('2024-03-01'),
    })
    expect(ledger.usages[0].days).toBe(5)
    expect(ledger.remaining).toBe(5)
  })

  it('excludes holidays from leave workday count', () => {
    // Mon Jan 15 → Fri Jan 19 = 5 days; Jan 16 is holiday → 4 workdays
    const isHoliday = (n: number) => n === dateToNum('2024-01-16')
    const accruals: Accrual[] = [
      { id: 'a1', person_id: 'p1', type: '포상휴가', days: 10, date: '2024-01-10', source: null, note: null },
    ]
    const leave = mkAssignment({
      person_id: 'p1', kind: 'leave', leave_type: '포상휴가',
      start: '2024-01-15', end_date: '2024-01-19',
    })
    const ledger = computeLedger('p1', {
      workItems: [], assignments: [leave], accruals,
      isHoliday, today: dateToNum('2024-03-01'),
    })
    expect(ledger.usages[0].days).toBe(4)
  })
})

// ── 9. buildHolidaySet helper ────────────────────────────────

describe('buildHolidaySet', () => {
  it('adds one-off holiday as a single day', () => {
    const s = buildHolidaySet([{ date: '2024-03-01', recurring: false }], 2023, 2025)
    expect(s.has(dateToNum('2024-03-01'))).toBe(true)
    expect(s.has(dateToNum('2023-03-01'))).toBe(false)
  })

  it('expands recurring holiday to multiple years', () => {
    const s = buildHolidaySet([{ date: '2024-01-01', recurring: true }], 2023, 2025)
    expect(s.has(dateToNum('2023-01-01'))).toBe(true)
    expect(s.has(dateToNum('2024-01-01'))).toBe(true)
    expect(s.has(dateToNum('2025-01-01'))).toBe(true)
  })
})
