import { dateToNum, isWeekend } from '@/lib/date'
import type { Person, Assignment, WorkItem } from '@/types'

/**
 * Compute utilization = (project-work business days) / (available business days)
 * for the period [periodStart, periodEnd] (inclusive, UTC day numbers).
 *
 * Rules:
 *   - Partner rank is excluded entirely.
 *   - Each person's window is clipped to [hire_date, termination_date] (null → period boundary).
 *   - Denominator: business days in window NOT on weekend, holiday, or leave.
 *   - Numerator: business days with a work assignment to a project-type work item,
 *     NOT also on leave (leave takes priority — prevents num > den).
 */
export function computeUtil(
  periodStart: number,
  periodEnd:   number,
  people:      Person[],
  assignments: Assignment[],
  workItems:   WorkItem[],
  isHoliday:   (n: number) => boolean,
): { num: number; den: number } {
  const wiMap = new Map(workItems.map(w => [w.id, w]))
  let num = 0
  let den = 0

  for (const p of people) {
    if (p.rank === 'Partner') continue
    if (p.status === 'resigned' && !p.termination_date) continue  // resigned with no termination date → skip entirely

    // Employment window clipped to period
    const empStart = p.hire_date         ? dateToNum(p.hire_date)         : periodStart
    const empEnd   = p.termination_date  ? dateToNum(p.termination_date)  : periodEnd
    const ws = Math.max(periodStart, empStart)
    const we = Math.min(periodEnd,   empEnd)
    if (ws > we) continue

    // Assignments for this person overlapping [ws, we]
    const myA = assignments.filter(a =>
      a.person_id === p.id &&
      dateToNum(a.end_date) >= ws &&
      dateToNum(a.start)    <= we,
    )

    // Build day-sets (clipped to [ws, we]) for leave and project-work
    const leaveDays   = new Set<number>()
    const projectDays = new Set<number>()

    for (const a of myA) {
      const as = Math.max(dateToNum(a.start),    ws)
      const ae = Math.min(dateToNum(a.end_date), we)
      if (as > ae) continue

      if (a.kind === 'leave') {
        for (let d = as; d <= ae; d++) leaveDays.add(d)
      } else if (a.kind === 'work' && a.work_item_id) {
        const wi = wiMap.get(a.work_item_id)
        if (wi?.type === 'project') {
          for (let d = as; d <= ae; d++) projectDays.add(d)
        }
      }
    }

    // Accumulate per day
    for (let d = ws; d <= we; d++) {
      if (isWeekend(d) || isHoliday(d)) continue
      const onLeave = leaveDays.has(d)
      if (!onLeave)                       den++
      if (projectDays.has(d) && !onLeave) num++
    }
  }

  return { num, den }
}
