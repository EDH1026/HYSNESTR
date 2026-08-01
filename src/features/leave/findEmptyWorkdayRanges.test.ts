/**
 * Unit tests for findEmptyWorkdayRanges's employment-window gate (LV-21, PRD v2.120).
 *
 * Bug: '휴가 배정 시뮬레이션'(computeVirtualLeaveBlocks) and Leave Ledger's
 * '잔여 소진 배정'(LeavePanel.handleAssignRemaining) share this scan function, but it
 * had no concept of hire_date/termination_date at all — an upcoming hire (no
 * employment relationship yet) got phantom leave blocks filled in before they'd
 * even joined. Fix: an optional `isEmployed` predicate, built from the already
 * shared/tested `isEmployedOnDate` (TSG-18).
 */

import { describe, it, expect } from 'vitest'
import { findEmptyWorkdayRanges } from './ledger'
import { dateToNum, numToStr, isEmployedOnDate } from '@/lib/date'

const NO_HOLIDAY = (_n: number) => false
const EMPTY = new Set<number>()

function person(overrides: { hire_date?: string | null; termination_date?: string | null; status?: string } = {}) {
  return {
    hire_date:        overrides.hire_date        ?? null,
    termination_date: overrides.termination_date ?? null,
    status:           overrides.status            ?? 'active',
  }
}

describe('findEmptyWorkdayRanges — regression, no isEmployed param (pre-LV-21 behavior)', () => {
  it('fills workdays forward from fromDay, skipping weekends, when isEmployed is omitted', () => {
    // 2026-08-03 is a Monday
    const from = dateToNum('2026-08-03')
    const ranges = findEmptyWorkdayRanges(from, 3, EMPTY, NO_HOLIDAY)
    expect(ranges).toEqual([{ start: from, end: from + 2 }])
  })
})

describe('LV-21: findEmptyWorkdayRanges honors isEmployed (hire_date/termination_date gate)', () => {
  it('an upcoming hire (hire_date in the future) gets no blocks before hire_date — scan starts exactly at hire_date', () => {
    const from = dateToNum('2026-08-03')   // Monday, well before hire_date
    const hireDate = '2026-08-10'          // the following Monday
    const p = person({ hire_date: hireDate })
    const ranges = findEmptyWorkdayRanges(
      from, 3, EMPTY, NO_HOLIDAY, 730,
      n => isEmployedOnDate(p, numToStr(n), from),
    )
    // every collected day must be >= hire_date
    for (const r of ranges) {
      expect(dateToNum(hireDate) <= r.start).toBe(true)
    }
    expect(ranges).toEqual([{ start: dateToNum(hireDate), end: dateToNum(hireDate) + 2 }])
  })

  it('hire_date == today: fills starting today, same as an already-active person (no off-by-one)', () => {
    const today = dateToNum('2026-08-03')   // Monday
    const p = person({ hire_date: '2026-08-03' })
    const ranges = findEmptyWorkdayRanges(
      today, 2, EMPTY, NO_HOLIDAY, 730,
      n => isEmployedOnDate(p, numToStr(n), today),
    )
    expect(ranges).toEqual([{ start: today, end: today + 1 }])
  })

  it('regression: an already-active person (hire_date in the past) is unaffected by the gate', () => {
    const today = dateToNum('2026-08-03')
    const p = person({ hire_date: '2020-01-01' })
    const withGate = findEmptyWorkdayRanges(
      today, 3, EMPTY, NO_HOLIDAY, 730,
      n => isEmployedOnDate(p, numToStr(n), today),
    )
    const withoutGate = findEmptyWorkdayRanges(today, 3, EMPTY, NO_HOLIDAY)
    expect(withGate).toEqual(withoutGate)
  })

  it("regression: a long-tenured active person is unaffected even if hire_date isn't strictly in the past " +
     "(TSG-18's v2.64 concern) — hire_date is only trusted when the person was still 'upcoming' as of the scan's reference date", () => {
    const today = dateToNum('2026-08-03')
    // hire_date == today: getEmploymentStatus(hire_date, ..., today) is 'active', not 'upcoming',
    // so the hire_date check must not apply — same case as the previous test, kept separate to
    // document the reasoning explicitly.
    const p = person({ hire_date: '2026-08-03' })
    const ranges = findEmptyWorkdayRanges(
      today, 2, EMPTY, NO_HOLIDAY, 730,
      n => isEmployedOnDate(p, numToStr(n), today),
    )
    expect(ranges).toEqual([{ start: today, end: today + 1 }])
  })

  it('TSG-9 termination boundary: termination_date itself is still fillable, the day after is not', () => {
    const from = dateToNum('2026-08-03')      // Monday
    const termDate = '2026-08-04'             // Tuesday — last employed day
    const p = person({ hire_date: '2020-01-01', termination_date: termDate, status: 'resigned' })
    const ranges = findEmptyWorkdayRanges(
      from, 5, EMPTY, NO_HOLIDAY, 730,
      n => isEmployedOnDate(p, numToStr(n), from),
    )
    // only 2026-08-03 and 2026-08-04 (Mon/Tue) may be collected; 08-05 (Wed, day after
    // termination) must be excluded even though count=5 was requested.
    expect(ranges).toEqual([{ start: from, end: dateToNum(termDate) }])
  })
})
