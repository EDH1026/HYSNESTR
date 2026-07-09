/**
 * UTC-based day-index utilities.
 *
 * All dates in this app are treated as calendar days with no time component.
 * We represent them as an integer "day number" — the number of days elapsed
 * since the Unix epoch (1970-01-01 = day 0) computed entirely in UTC so that
 * local timezone offsets never shift a date to the previous or next calendar day.
 *
 * Canonical wire format for persistence: ISO "YYYY-MM-DD" strings.
 */

// ---------------------------------------------------------------------------
// Core conversion
// ---------------------------------------------------------------------------

/** Parse a "YYYY-MM-DD" string or a Date into a UTC day number. */
export function dateToNum(input: string | Date): number {
  if (typeof input === 'string') {
    const [y, m, d] = input.split('-').map(Number)
    return Math.floor(Date.UTC(y, m - 1, d) / 86_400_000)
  }
  return Math.floor(
    Date.UTC(input.getUTCFullYear(), input.getUTCMonth(), input.getUTCDate()) /
      86_400_000,
  )
}

/** Convert a UTC day number back to a Date object (midnight UTC). */
export function numToDate(n: number): Date {
  return new Date(n * 86_400_000)
}

/** Convert a UTC day number to a "YYYY-MM-DD" string. */
export function numToStr(n: number): string {
  const d = numToDate(n)
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** Convenience: "YYYY-MM-DD" → "YYYY-MM-DD" (round-trips through day number). */
export function parseStr(s: string): string {
  return numToStr(dateToNum(s))
}

/** Return the day number for today (local calendar day, converted to UTC day). */
export function today(): number {
  const now = new Date()
  return dateToNum(
    `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`,
  )
}

// ---------------------------------------------------------------------------
// Weekday
// ---------------------------------------------------------------------------

/**
 * ISO weekday of a day number.
 * Returns 0 (Monday) … 4 (Friday) … 5 (Saturday) … 6 (Sunday).
 *
 * Derivation: day 0 = 1970-01-01 = Thursday = ISO 3.
 * So weekday(n) = (n + 3) % 7.
 */
export function weekday(n: number): number {
  return (n + 3) % 7
}

export function isSaturday(n: number): boolean {
  return weekday(n) === 5
}

export function isSunday(n: number): boolean {
  return weekday(n) === 6
}

export function isWeekend(n: number): boolean {
  return weekday(n) >= 5
}

// ---------------------------------------------------------------------------
// Employment status (computed — never stored)
// ---------------------------------------------------------------------------

/**
 * Derive a person's employment status from their hire / termination dates
 * relative to a reference date (defaults to today).
 *
 * Priority:
 *   hire_date > today           → 'upcoming'  (not yet started)
 *   termination_date <= today   → 'resigned'  (has left)
 *   otherwise                   → 'active'
 *
 * Uses string comparison (YYYY-MM-DD lexical order == chronological order).
 */
export function getEmploymentStatus(
  hireDate:        string | null | undefined,
  terminationDate: string | null | undefined,
  refDate?:        number,   // UTC day number; defaults to today()
): 'upcoming' | 'active' | 'resigned' {
  const ref = numToStr(refDate ?? today())
  if (hireDate && hireDate > ref) return 'upcoming'
  if (terminationDate && terminationDate <= ref) return 'resigned'
  return 'active'
}

// ---------------------------------------------------------------------------
// Week boundaries (ISO weeks start on Monday)
// ---------------------------------------------------------------------------

/** Day number of the Monday that begins the week containing n. */
export function weekStart(n: number): number {
  return n - weekday(n)
}

/**
 * All Monday day-numbers whose weeks overlap with [start, end].
 * Useful for rendering week-column headers in the Gantt chart.
 */
export function weekBoundaries(start: number, end: number): number[] {
  const out: number[] = []
  let cur = weekStart(start)
  while (cur <= end) {
    out.push(cur)
    cur += 7
  }
  return out
}

// ---------------------------------------------------------------------------
// Month boundaries
// ---------------------------------------------------------------------------

/** Day number of the first day of the month that contains n. */
export function monthStart(n: number): number {
  const d = numToDate(n)
  return dateToNum(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)))
}

/** Day number of the first day of the NEXT month after n. */
export function nextMonthStart(n: number): number {
  const d = numToDate(n)
  return dateToNum(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)))
}

/** { year, month (1-based) } for a given day number. */
export function yearMonth(n: number): { year: number; month: number } {
  const d = numToDate(n)
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 }
}

/**
 * All month-start day-numbers within [start, end].
 * Used to render month column headers in the Gantt chart.
 */
export function monthBoundaries(start: number, end: number): number[] {
  const out: number[] = []
  let cur = monthStart(start)
  while (cur <= end) {
    out.push(cur)
    cur = nextMonthStart(cur)
  }
  return out
}

// ---------------------------------------------------------------------------
// Working-day arithmetic
// ---------------------------------------------------------------------------

/**
 * Count working days in [start, end] (both inclusive), excluding weekends
 * and the provided holiday set.
 *
 * @param holidays - Set of UTC day numbers that are public holidays.
 */
export function workdayCount(
  start: number,
  end: number,
  holidays: ReadonlySet<number> = new Set(),
): number {
  let count = 0
  for (let n = start; n <= end; n++) {
    if (!isWeekend(n) && !holidays.has(n)) count++
  }
  return count
}

/**
 * Returns the first workday strictly after `after`, skipping weekends and holidays.
 * Used for "next business day after project end" (§7.5, delay-comp credit date).
 */
export function nextWorkday(
  after: number,
  isHoliday: (n: number) => boolean = () => false,
): number {
  let d = after + 1
  while (isWeekend(d) || isHoliday(d)) d++
  return d
}

/**
 * Given a leave start date (inclusive), find the end date such that exactly
 * `nWorkdays` business days fall in [start, end].  Used for the leave workday
 * snap when dragging an assignment bar (§5.3 F-2.4).
 *
 * Example: start=Fri, nWorkdays=3 → Fri Mon Tue → returns Tue.
 */
export function snapLeaveEnd(
  start:     number,
  nWorkdays: number,
  isHoliday: (n: number) => boolean = () => false,
): number {
  if (nWorkdays <= 0) return start
  let d     = start
  let count = 0
  while (count < nWorkdays) {
    if (!isWeekend(d) && !isHoliday(d)) count++
    if (count < nWorkdays) d++
  }
  return d
}

/**
 * Given a leave end date (inclusive), find the start date such that exactly
 * `nWorkdays` business days fall in [start, end].
 * Mirror of snapLeaveEnd scanning backward — used when pushing a leave block
 * leftward during drag (§5.3 E-4).
 */
export function snapLeaveStart(
  end:       number,
  nWorkdays: number,
  isHoliday: (n: number) => boolean = () => false,
): number {
  if (nWorkdays <= 0) return end
  let d = end, count = 0
  while (count < nWorkdays) {
    if (!isWeekend(d) && !isHoliday(d)) count++
    if (count < nWorkdays) d--
  }
  return d
}

/**
 * Add `n` working days to `start` (forward only), skipping weekends and holidays.
 * Returns the day number of the resulting date.
 */
export function addWorkdays(
  start: number,
  n: number,
  holidays: ReadonlySet<number> = new Set(),
): number {
  let cur = start
  let remaining = n
  while (remaining > 0) {
    cur++
    if (!isWeekend(cur) && !holidays.has(cur)) remaining--
  }
  return cur
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const WEEKDAY_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

/** "Jan", "Feb", … */
export function monthLabel(n: number): string {
  return MONTH_SHORT[numToDate(n).getUTCMonth()]
}

/** "2024 Jan" */
export function monthYearLabel(n: number): string {
  const d = numToDate(n)
  return `${d.getUTCFullYear()} ${MONTH_SHORT[d.getUTCMonth()]}`
}

/** "Mon", "Tue", … */
export function weekdayLabel(n: number): string {
  return WEEKDAY_SHORT[weekday(n)]
}

/** "MM/DD" (e.g. "01/15") */
export function dayOfMonthLabel(n: number): string {
  const d = numToDate(n)
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${m}/${day}`
}

/** "2024-01-15" */
export function isoLabel(n: number): string {
  return numToStr(n)
}

// ---------------------------------------------------------------------------
// Fiscal-year helper (§8 dashboard)
// ---------------------------------------------------------------------------

/**
 * Day number of the first day of the fiscal year containing `todayNum`.
 * `startMonth` is 1-based (e.g. 7 for July, the default).
 *
 * Example: startMonth=7, today=2026-02-10 → 2025-07-01
 *          startMonth=7, today=2026-06-21 → 2025-07-01  (FY26)
 */
export function fiscalYearStart(todayNum: number, startMonth: number): number {
  const d      = numToDate(todayNum)
  const yr     = d.getUTCFullYear()
  const mo     = d.getUTCMonth() + 1   // 1-based
  const fyYear = mo >= startMonth ? yr : yr - 1
  return dateToNum(new Date(Date.UTC(fyYear, startMonth - 1, 1)))
}

/** FY label year (end year) for a given day and fiscal start month.
 * Example: startMonth=7, 2025-07-01 → 2026 (FY26) */
export function fyOf(dayNum: number, startMonth: number): number {
  const d  = numToDate(dayNum)
  const mo = d.getUTCMonth() + 1
  const yr = d.getUTCFullYear()
  return mo >= startMonth ? yr + 1 : yr
}

/**
 * Shift day number `n` by `months` calendar months (negative = backward).
 * Uses UTC arithmetic; day overflows clamp naturally via JS Date.
 * Example: addMonths(dateToNum('2026-01-31'), 1) → 2026-03-03 (Feb overflow).
 * Always combine with monthStart / nextMonthStart to get clean boundaries.
 */
export function addMonths(n: number, months: number): number {
  const d = numToDate(n)
  d.setUTCMonth(d.getUTCMonth() + months)
  return dateToNum(d)
}

/** Inclusive [startNum, endNum] for a FY label year.
 * Example: fyYear=2026, startMonth=7 → [2025-07-01, 2026-06-30] */
export function fyRange(fyYear: number, startMonth: number): [number, number] {
  const start = dateToNum(new Date(Date.UTC(fyYear - 1, startMonth - 1, 1)))
  const end   = dateToNum(new Date(Date.UTC(fyYear,     startMonth - 1, 0)))
  return [start, end]
}
