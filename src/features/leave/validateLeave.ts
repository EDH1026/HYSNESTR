import { dateToNum, numToStr, isWeekend, workdayCount } from '@/lib/date'
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

// ── E-3b: conflict-exclusion preview (PRD v2.109) ──────────────
// These helpers are for rendering the confirmation modal only. The final
// split ranges are always recomputed authoritatively by the
// create_assignment_excluding_conflicts RPC against the latest DB state —
// nothing computed here is trusted for the actual insert.

export interface OverlapItem {
  assignment:   Assignment
  overlapStart: string  // intersection of the requested range and this assignment, clipped
  overlapEnd:   string
  businessDays: number
}

/** Existing assignments for personId that overlap [start, endDate], with the overlap
 *  intersection and its business-day count, sorted by overlap start. */
export function findOverlaps(
  personId:    string,
  start:       string,
  endDate:     string,
  assignments: Assignment[],
  holidays:    ReadonlySet<number>,
  excludeId?:  string,
): OverlapItem[] {
  const s = dateToNum(start)
  const e = dateToNum(endDate)
  return assignments
    .filter(a =>
      a.person_id === personId &&
      (!excludeId || a.id !== excludeId) &&
      dateToNum(a.start) <= e &&
      dateToNum(a.end_date) >= s,
    )
    .map(a => {
      const os = Math.max(s, dateToNum(a.start))
      const oe = Math.min(e, dateToNum(a.end_date))
      return {
        assignment:   a,
        overlapStart: numToStr(os),
        overlapEnd:   numToStr(oe),
        businessDays: workdayCount(os, oe, holidays),
      }
    })
    .sort((a, b) => a.overlapStart.localeCompare(b.overlapStart))
}

/** Preview only: requested range minus the merged overlap blocks, plus the total
 *  business days actually blocked (union-based, so double-overlapping existing
 *  assignments aren't double-counted). */
export function previewExcludingConflicts(
  start:     string,
  endDate:   string,
  overlaps:  OverlapItem[],
  holidays:  ReadonlySet<number>,
): { segments: { start: string; end: string }[]; totalBusinessDays: number } {
  const s = dateToNum(start)
  const e = dateToNum(endDate)

  const blocks = overlaps
    .map(o => [
      Math.max(s, dateToNum(o.assignment.start)),
      Math.min(e, dateToNum(o.assignment.end_date)),
    ] as [number, number])
    .sort((a, b) => a[0] - b[0])

  const merged: [number, number][] = []
  for (const b of blocks) {
    const last = merged[merged.length - 1]
    if (last && b[0] <= last[1] + 1) last[1] = Math.max(last[1], b[1])
    else merged.push([b[0], b[1]])
  }

  const segments: { start: string; end: string }[] = []
  let cur = s
  for (const [bs, be] of merged) {
    if (bs > cur) segments.push({ start: numToStr(cur), end: numToStr(bs - 1) })
    if (be + 1 > cur) cur = be + 1
  }
  if (cur <= e) segments.push({ start: numToStr(cur), end: numToStr(e) })

  const totalBusinessDays = merged.reduce((sum, [bs, be]) => sum + workdayCount(bs, be, holidays), 0)

  return { segments, totalBusinessDays }
}
