import { dateToNum, isWeekend } from '@/lib/date'
import type { Accrual, Assignment } from '@/types'

/** Special leave balance = accrual total − workdays already assigned (excluding one ID for edit). */
export function computeSpecialLeaveBalance(
  personId:    string,
  accruals:    Accrual[],
  assignments: Assignment[],
  holidaySet:  Set<number>,
  excludeId?:  string,
): number {
  const accrualBalance = accruals
    .filter(a => a.person_id === personId && a.type === '특별휴가')
    .reduce((s, a) => s + (a.direction === 'accrual' ? a.days : -a.days), 0)

  const usedDays = assignments
    .filter(a =>
      a.person_id  === personId  &&
      a.kind       === 'leave'   &&
      a.leave_type === '특별휴가' &&
      (!excludeId || a.id !== excludeId),
    )
    .reduce((s, a) => {
      const s0 = dateToNum(a.start), e0 = dateToNum(a.end_date)
      let d = 0
      for (let n = s0; n <= e0; n++) {
        if (!isWeekend(n) && !holidaySet.has(n)) d++
      }
      return s + d
    }, 0)

  return Math.round((accrualBalance - usedDays) * 10) / 10
}

/** True if [start, endDate] overlaps any existing assignment for personId (excluding one ID for edit). */
export function hasAssignmentOverlap(
  personId:    string,
  start:       string,
  endDate:     string,
  assignments: Assignment[],
  excludeId?:  string,
): boolean {
  const s = dateToNum(start)
  const e = dateToNum(endDate)
  return assignments.some(a =>
    a.person_id === personId &&
    (!excludeId || a.id !== excludeId) &&
    dateToNum(a.start) <= e &&
    dateToNum(a.end_date) >= s,
  )
}
