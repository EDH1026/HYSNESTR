import { describe, it, expect } from 'vitest'
import { isEmployedOnDate } from './TimesheetGuidelineTab'
import { dateToNum } from '@/lib/date'
import type { Person } from '@/types'

// TSG-18 (PRD v2.115): per-date employment check must clip a genuinely new
// hire's pre-hire-date rows, without reopening the v2.64 "+8 days" bug for
// long-tenured people whose hire_date may just be a system registration date.

function person(overrides: Partial<Person> = {}): Person {
  return {
    id: 'p1', name: 'Test Person', rank: 'Staff', role: 'Consultant',
    lpn: null, hire_date: null, termination_date: null, status: 'active',
    nbd_code: null,
    ...overrides,
  }
}

const WINDOW_START = '2026-06-01'
const windowStartNum = dateToNum(WINDOW_START)

describe('TSG-18 isEmployedOnDate', () => {
  it('new hire mid-window: excluded before hire_date, included on/after', () => {
    const p = person({ status: 'active', hire_date: '2026-06-15' })
    expect(isEmployedOnDate(p, '2026-06-10', windowStartNum)).toBe(false)
    expect(isEmployedOnDate(p, '2026-06-14', windowStartNum)).toBe(false)
    expect(isEmployedOnDate(p, '2026-06-15', windowStartNum)).toBe(true)
    expect(isEmployedOnDate(p, '2026-07-01', windowStartNum)).toBe(true)
  })

  it('regression (v2.64): long-tenured active person is included for all window dates ' +
     'even if hire_date looks recent (e.g. a registration-date artifact before windowStart)', () => {
    // hire_date predates windowStart, so this person was already 'active' as of
    // windowStart — status-at-windowStart is 'active', not 'upcoming', so the
    // hire_date value (however unreliable) is never used as a per-date cutoff.
    const p = person({ status: 'active', hire_date: '2026-05-20' })
    expect(isEmployedOnDate(p, '2026-06-01', windowStartNum)).toBe(true)
    expect(isEmployedOnDate(p, '2026-06-02', windowStartNum)).toBe(true)
  })

  it('person with no hire_date recorded is always included', () => {
    const p = person({ status: 'active', hire_date: null })
    expect(isEmployedOnDate(p, '2026-06-01', windowStartNum)).toBe(true)
  })

  it('resigned mid-window (TSG-9 boundary, unchanged): included through termination_date, excluded after', () => {
    const p = person({ status: 'resigned', hire_date: '2020-01-01', termination_date: '2026-06-20' })
    expect(isEmployedOnDate(p, '2026-06-20', windowStartNum)).toBe(true)  // termination day itself counts
    expect(isEmployedOnDate(p, '2026-06-21', windowStartNum)).toBe(false)
  })

  it('active person with a future planned termination_date is included throughout', () => {
    const p = person({ status: 'active', hire_date: '2020-01-01', termination_date: '2026-12-31' })
    expect(isEmployedOnDate(p, '2026-06-15', windowStartNum)).toBe(true)
  })
})
