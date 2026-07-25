import { describe, it, expect } from 'vitest'
import { resolveTimesheetCode, type ResolveContext } from './resolveTimesheetCode'
import type { Person, Assignment, WorkItem } from '@/types'

// W-10 (PRD v2.114): project engagement 코드 비율 배분 — TSG-1⑥ / TSG-14②

function person(overrides: Partial<Person> = {}): Person {
  return {
    id: 'p1', name: 'Test Person', rank: 'Staff', role: 'Consultant',
    lpn: null, hire_date: null, termination_date: null, status: 'active',
    nbd_code: null,
    ...overrides,
  }
}

function workItem(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: 'wi1', type: 'project', name: 'Test Project',
    start: '2026-01-01', main_start: '2026-01-01', end_date: '2026-12-31',
    engagement_number: 'E-00000001', temp_engagement_code: null,
    engagement_code_splits: null,
    client: null, hashtags: [], status: 'open', description: null, confidential: false,
    ...overrides,
  }
}

function assignment(overrides: Partial<Assignment> = {}): Assignment {
  return {
    id: 'a1', person_id: 'p1', kind: 'work', work_item_id: 'wi1',
    weekend_dates: [], leave_type: null, start: '2026-01-01', end_date: '2026-12-31',
    note: null, daily_hours: null,
    ...overrides,
  }
}

function ctxFor(p: Person, assignments: Assignment[], workItems: WorkItem[], allAssignments = assignments): ResolveContext {
  return {
    allPeople: [p],
    assignments,
    allAssignments,
    workItems,
    isHoliday: () => false,
    ledger: {
      asOf: 0, accruals: [], usages: [], unpaid: [],
      totalAccrued: 0, totalUsed: 0, remaining: 0, byType: {},
      actualAccrued: 0, scheduledAccrued: 0, actualUsed: 0, scheduledUsed: 0,
      currentRemaining: 0, projectedRemaining: 0,
    },
    adjustments: [],
    hireDate: null,
  }
}

const DATE = '2026-03-02' // a Monday, not a holiday

describe('W-10 engagement_code_splits — non-Partner project path (TSG-1⑥)', () => {
  it('regression: no splits → single code, full day (hours undefined)', () => {
    const p = person({ rank: 'Staff' })
    const wi = workItem({ engagement_code_splits: null })
    const results = resolveTimesheetCode(p, DATE, ctxFor(p, [assignment()], [wi]))
    expect(results).toEqual([{ code: 'E-00000001' }])
  })

  it('splits 75/25 on an 8h day → 6h + 2h, exact sum', () => {
    const p = person({ rank: 'Staff' })
    const wi = workItem({ engagement_code_splits: [{ code: 'A', percent: 75 }, { code: 'B', percent: 25 }] })
    const results = resolveTimesheetCode(p, DATE, ctxFor(p, [assignment()], [wi]))
    expect(results).toEqual([
      { code: 'A', hours: 6 },
      { code: 'B', hours: 2 },
    ])
    expect(results.reduce((s, r) => s + (r.hours ?? 0), 0)).toBe(8)
  })

  it('splits 75/25 with daily_hours=5 → 3.75 + 1.25, exact sum', () => {
    const p = person({ rank: 'Staff' })
    const wi = workItem({ engagement_code_splits: [{ code: 'A', percent: 75 }, { code: 'B', percent: 25 }] })
    const results = resolveTimesheetCode(p, DATE, ctxFor(p, [assignment({ daily_hours: 5 })], [wi]))
    expect(results).toEqual([
      { code: 'A', hours: 3.75 },
      { code: 'B', hours: 1.25 },
    ])
    expect(results.reduce((s, r) => s + (r.hours ?? 0), 0)).toBe(5)
  })

  it('three-way split with a repeating decimal percent still sums exactly', () => {
    const p = person({ rank: 'Staff' })
    const wi = workItem({
      engagement_code_splits: [
        { code: 'A', percent: 33.33 },
        { code: 'B', percent: 33.33 },
        { code: 'C', percent: 33.34 },
      ],
    })
    const results = resolveTimesheetCode(p, DATE, ctxFor(p, [assignment()], [wi]))
    expect(results.reduce((s, r) => s + (r.hours ?? 0), 0)).toBe(8)
    expect(results[results.length - 1]?.code).toBe('C') // last item absorbs the rounding remainder
  })
})

describe('W-10 engagement_code_splits — Partner multi-project path (TSG-14②)', () => {
  it('regression: Partner, single project, no daily_hours, no splits → full 8h single code', () => {
    const p = person({ id: 'partner1', rank: 'Partner' })
    const wi = workItem({ engagement_code_splits: null })
    const asgn = assignment({ id: 'a1', person_id: 'partner1' })
    const results = resolveTimesheetCode(p, DATE, ctxFor(p, [asgn], [wi]))
    expect(results).toEqual([{ code: 'E-00000001' }])
  })

  it('Partner, single project, no explicit daily_hours, splits set → full 8h split', () => {
    const p = person({ id: 'partner1', rank: 'Partner' })
    const wi = workItem({ engagement_code_splits: [{ code: 'A', percent: 75 }, { code: 'B', percent: 25 }] })
    const asgn = assignment({ id: 'a1', person_id: 'partner1' })
    const results = resolveTimesheetCode(p, DATE, ctxFor(p, [asgn], [wi]))
    expect(results).toEqual([
      { code: 'A', hours: 6 },
      { code: 'B', hours: 2 },
    ])
  })

  it('Partner, daily_hours=5 on a split project → 3.75 + 1.25, plus NBD remainder for the other 3h', () => {
    const p = person({ id: 'partner1', rank: 'Partner', nbd_code: 'NBD-1' })
    const wi = workItem({ engagement_code_splits: [{ code: 'A', percent: 75 }, { code: 'B', percent: 25 }] })
    const asgn = assignment({ id: 'a1', person_id: 'partner1', daily_hours: 5 })
    const results = resolveTimesheetCode(p, DATE, ctxFor(p, [asgn], [wi]))
    expect(results).toEqual([
      { code: 'A', hours: 3.75 },
      { code: 'B', hours: 1.25 },
      { code: 'NBD-1', hours: 3, provisional: undefined },
    ])
    expect(results.reduce((s, r) => s + (r.hours ?? 0), 0)).toBe(8)
  })

  it('regression: Partner, daily_hours set, no splits → unchanged single-code-per-project + NBD remainder', () => {
    const p = person({ id: 'partner1', rank: 'Partner', nbd_code: 'NBD-1' })
    const wi = workItem({ engagement_code_splits: null })
    const asgn = assignment({ id: 'a1', person_id: 'partner1', daily_hours: 5 })
    const results = resolveTimesheetCode(p, DATE, ctxFor(p, [asgn], [wi]))
    expect(results).toEqual([
      { code: 'E-00000001', hours: 5, provisional: undefined },
      { code: 'NBD-1', hours: 3, provisional: undefined },
    ])
  })
})
