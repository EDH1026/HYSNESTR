/**
 * Unit tests for computeUtil (§8 Utilization formula).
 *
 * Date fixtures (UTC day numbers since 1970-01-01):
 *   Day 0 = Thu 1970-01-01
 *   Day 1 = Fri 1970-01-02
 *   Day 2 = Sat 1970-01-03  ← weekend
 *   Day 3 = Sun 1970-01-04  ← weekend
 *   Day 4 = Mon 1970-01-05
 *   Day 5 = Tue 1970-01-06
 *   Day 6 = Wed 1970-01-07
 *   Day 7 = Thu 1970-01-08
 *   Day 8 = Fri 1970-01-09
 *   Day 9 = Sat 1970-01-10  ← weekend
 *  Day 10 = Sun 1970-01-11  ← weekend
 *
 * Period [0, 6] has 5 workdays: 0,1,4,5,6
 * Period [4, 8] has 5 workdays: 4,5,6,7,8
 */
import { describe, it, expect } from 'vitest'
import { computeUtil } from './utilization'
import type { Person, Assignment, WorkItem } from '@/types'

// ── Fixtures ──────────────────────────────────────────────────────────────────

const mkP = (overrides: Partial<Person> = {}): Person => ({
  id: 'p1', name: 'Test User', rank: 'M', role: '',
  lpn: null, hire_date: null, termination_date: null, status: 'active',
  ...overrides,
})

const mkWI = (overrides: Partial<WorkItem> = {}): WorkItem => ({
  id: 'wi1', type: 'project', name: 'Test Project',
  start: '1970-01-01', main_start: null,
  end_date: '1970-12-31', engagement_number: null,
  client: null, hashtags: [], status: 'open',
  ...overrides,
})

const mkA = (overrides: Partial<Assignment> = {}): Assignment => ({
  id: 'a1', person_id: 'p1', kind: 'work',
  work_item_id: 'wi1', weekend_dates: [],
  leave_type: null, start: '1970-01-01',
  end_date: '1970-12-31', note: null,
  ...overrides,
})

const noHoliday = () => false

// ── Tests ────────────────────────────────────────────────────────────────────

describe('computeUtil', () => {

  it('returns 0/0 when people array is empty', () => {
    expect(computeUtil(0, 6, [], [], [], noHoliday)).toEqual({ num: 0, den: 0 })
  })

  it('counts 5 workdays in [0,6] (Thu–Wed) for an available person with no assignments', () => {
    const { num, den } = computeUtil(0, 6, [mkP()], [], [], noHoliday)
    expect(den).toBe(5)
    expect(num).toBe(0)
  })

  it('excludes Partner rank entirely', () => {
    const partner = mkP({ rank: 'Partner' })
    const wi  = mkWI()
    const asn = mkA()
    const { num, den } = computeUtil(0, 6, [partner], [asn], [wi], noHoliday)
    expect(num).toBe(0)
    expect(den).toBe(0)
  })

  it('numerator equals workdays when person assigned to project all period', () => {
    const { num, den } = computeUtil(0, 6, [mkP()], [mkA()], [mkWI()], noHoliday)
    expect(num).toBe(5)
    expect(den).toBe(5)
  })

  it('proposal assignment does NOT count for numerator', () => {
    const wi  = mkWI({ type: 'proposal' })
    const asn = mkA()  // work assignment to wi1
    const { num, den } = computeUtil(0, 6, [mkP()], [asn], [wi], noHoliday)
    expect(num).toBe(0)
    expect(den).toBe(5)
  })

  it('pipeline assignment does NOT count for numerator', () => {
    const wi  = mkWI({ type: 'pipeline' })
    const asn = mkA()
    const { num, den } = computeUtil(0, 6, [mkP()], [asn], [wi], noHoliday)
    expect(num).toBe(0)
    expect(den).toBe(5)
  })

  it('hire_date constraint: clips person window to [hire_date, period_end]', () => {
    // hired on Day 4 (Mon 1970-01-05); period [0,6]
    const p   = mkP({ hire_date: '1970-01-05' })
    const asn = mkA()
    const wi  = mkWI()
    const { num, den } = computeUtil(0, 6, [p], [asn], [wi], noHoliday)
    // Workdays in [4,6]: 4(Mon),5(Tue),6(Wed) = 3
    expect(den).toBe(3)
    expect(num).toBe(3)
  })

  it('termination_date constraint: clips person window to [period_start, termination_date]', () => {
    // terminated on Day 1 (Fri 1970-01-02); period [0,6]
    const p   = mkP({ termination_date: '1970-01-02' })
    const asn = mkA()
    const wi  = mkWI()
    const { num, den } = computeUtil(0, 6, [p], [asn], [wi], noHoliday)
    // Workdays in [0,1]: 0(Thu),1(Fri) = 2
    expect(den).toBe(2)
    expect(num).toBe(2)
  })

  it('person terminated before period start → excluded (0/0)', () => {
    const p = mkP({ termination_date: '1969-12-31' })  // before day 0
    const { num, den } = computeUtil(0, 6, [p], [], [], noHoliday)
    expect(num).toBe(0)
    expect(den).toBe(0)
  })

  it('person hired after period end → excluded (0/0)', () => {
    const p = mkP({ hire_date: '1970-01-10' })  // day 9, after period end day 6
    const { num, den } = computeUtil(0, 6, [p], [], [], noHoliday)
    expect(num).toBe(0)
    expect(den).toBe(0)
  })

  it('weekends are excluded from denominator', () => {
    // Period [2,3] = Sat+Sun only
    const { num, den } = computeUtil(2, 3, [mkP()], [], [], noHoliday)
    expect(den).toBe(0)
    expect(num).toBe(0)
  })

  it('holidays are excluded from denominator and numerator', () => {
    // Period [0,6], day 4 (Mon) is a holiday
    const isHoliday = (n: number) => n === 4
    const wi  = mkWI()
    const asn = mkA()
    const { num, den } = computeUtil(0, 6, [mkP()], [asn], [wi], isHoliday)
    // Workdays minus holiday: {0,1,5,6} = 4
    expect(den).toBe(4)
    expect(num).toBe(4)
  })

  it('leave reduces denominator but NOT numerator (leave days excluded from both)', () => {
    // Period [0,6]; person has project work [0,3] and leave [4,5]
    const wi      = mkWI()
    const workAsn = mkA({ id: 'a1', kind: 'work',  work_item_id: 'wi1', start: '1970-01-01', end_date: '1970-01-04' })
    const leaveAsn = mkA({ id: 'a2', kind: 'leave', work_item_id: null,  leave_type: '지정휴가', start: '1970-01-05', end_date: '1970-01-06' })
    const { num, den } = computeUtil(0, 6, [mkP()], [workAsn, leaveAsn], [wi], noHoliday)
    // Workdays: {0,1,4,5,6}
    // Leave covers days 4,5 → excluded from den
    // Den: {0,1,6} = 3
    // Project work covers [0,3] → project workdays = {0,1} (2,3 are weekend; 4 is on leave)
    // Num: {0,1} = 2
    expect(den).toBe(3)
    expect(num).toBe(2)
  })

  it('overlapping leave + project: leave takes priority (num ≤ den)', () => {
    // Same day assigned to both project work and leave
    const wi       = mkWI()
    const workAsn  = mkA({ id: 'a1', kind: 'work',  work_item_id: 'wi1', start: '1970-01-01', end_date: '1970-01-07' })
    const leaveAsn = mkA({ id: 'a2', kind: 'leave', work_item_id: null,  leave_type: '지정휴가', start: '1970-01-05', end_date: '1970-01-07' })
    const { num, den } = computeUtil(0, 6, [mkP()], [workAsn, leaveAsn], [wi], noHoliday)
    // Days 4,5,6 on leave → excluded from den and num
    // Den: {0,1} = 2
    // Num: {0,1} = 2 (days 4,5,6 excluded because on leave)
    expect(den).toBe(2)
    expect(num).toBe(2)
    // Must hold: num ≤ den (no util > 100%)
    expect(num).toBeLessThanOrEqual(den)
  })

  it('denominator is 0 when entire period is leave (returns 0/0)', () => {
    const leaveAsn = mkA({ id: 'a1', kind: 'leave', work_item_id: null, leave_type: '휴직', start: '1970-01-01', end_date: '1970-01-07' })
    const { num, den } = computeUtil(0, 6, [mkP()], [leaveAsn], [], noHoliday)
    expect(den).toBe(0)
    expect(num).toBe(0)
  })

  it('aggregates multiple non-Partner people', () => {
    // Person 1 (M): project work [0,6] — 5 workdays
    // Person 2 (Senior): leave [0,6] — 0 available workdays
    const p1 = mkP({ id: 'p1', rank: 'M' })
    const p2 = mkP({ id: 'p2', rank: 'Senior' })
    const wi = mkWI()
    const workAsn  = mkA({ id: 'a1', person_id: 'p1', kind: 'work',  work_item_id: 'wi1', start: '1970-01-01', end_date: '1970-01-07' })
    const leaveAsn = mkA({ id: 'a2', person_id: 'p2', kind: 'leave', work_item_id: null,  leave_type: '휴직', start: '1970-01-01', end_date: '1970-01-07' })
    const { num, den } = computeUtil(0, 6, [p1, p2], [workAsn, leaveAsn], [wi], noHoliday)
    // p1: num=5, den=5;  p2: num=0, den=0
    expect(num).toBe(5)
    expect(den).toBe(5)
  })

  it('aggregates multiple people: Partner excluded, others summed', () => {
    const partner = mkP({ id: 'p0', rank: 'Partner' })
    const senior  = mkP({ id: 'p1', rank: 'Senior'  })
    const staff   = mkP({ id: 'p2', rank: 'Staff'   })
    const wi = mkWI()
    const a1 = mkA({ id: 'a1', person_id: 'p0', start: '1970-01-01', end_date: '1970-01-07' })
    const a2 = mkA({ id: 'a2', person_id: 'p1', start: '1970-01-01', end_date: '1970-01-07' })
    const a3 = mkA({ id: 'a3', person_id: 'p2', start: '1970-01-01', end_date: '1970-01-07' })
    const { num, den } = computeUtil(0, 6, [partner, senior, staff], [a1, a2, a3], [wi], noHoliday)
    // Partner excluded; Senior + Staff each: num=5, den=5 → total num=10, den=10
    expect(num).toBe(10)
    expect(den).toBe(10)
  })

  it('휴직 leave type excludes days from denominator (same as any leave)', () => {
    const leaveAsn = mkA({ id: 'a1', kind: 'leave', work_item_id: null, leave_type: '휴직', start: '1970-01-01', end_date: '1970-01-02' })
    const { num, den } = computeUtil(0, 6, [mkP()], [leaveAsn], [], noHoliday)
    // Days 0,1 on leave → den = {4,5,6} = 3
    expect(den).toBe(3)
    expect(num).toBe(0)
  })

  it('partial period overlap: assignment starting before period start is clipped', () => {
    // Period [4,6] (Mon–Wed); project assignment covers [0,10]
    const wi  = mkWI()
    const asn = mkA({ start: '1970-01-01', end_date: '1970-01-11' })
    const { num, den } = computeUtil(4, 6, [mkP()], [asn], [wi], noHoliday)
    // Workdays in [4,6]: 4,5,6 = 3
    expect(den).toBe(3)
    expect(num).toBe(3)
  })
})
