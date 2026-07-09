/**
 * §5.13 AL-2, AL-2b, AL-2d — 근로기준법 법정연차 자동 계산 (pure, no side effects)
 *
 * 근로기준법 제60조 기준:
 * - 신입사원 휴가: 첫 11개월 매월 개근 시 1일 (단일 항목, FY 분리 없음)
 * - 법정연차 (fiscal 기준): 첫 회계연도 7/1 비례연차, 이후 매년 7/1 가산 연차
 * - 법정연차 (anniversary 기준): 입사일 주년일마다 가산 연차
 *
 * FY 라벨 규칙 (§8): month >= 7 ? year + 1 : year
 *   예) 2022-07-01 → FY23, 2023-01-01 → FY23
 */

// ── 공용 날짜 헬퍼 ────────────────────────────────────────────

function r1(n: number): number {
  return Math.round(n * 10) / 10
}

function daysBetween(startStr: string, endStr: string): number {
  const [sy, sm, sd] = startStr.split('-').map(Number)
  const [ey, em, ed] = endStr.split('-').map(Number)
  return Math.round(
    (Date.UTC(ey, em - 1, ed) - Date.UTC(sy, sm - 1, sd)) / 86400000,
  )
}

function addMonths(dateStr: string, months: number): string {
  const [y, m, d] = dateStr.split('-').map(Number)
  const totalMonths = (m - 1) + months
  const ty = y + Math.floor(totalMonths / 12)
  const tm = (totalMonths % 12 + 12) % 12 + 1
  const daysInMonth = new Date(Date.UTC(ty, tm, 0)).getUTCDate()
  const day = Math.min(d, daysInMonth)
  return `${ty}-${String(tm).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

function addYears(dateStr: string, years: number): string {
  return addMonths(dateStr, years * 12)
}

function fyLabelOf(dateStr: string): number {
  const y = parseInt(dateStr.slice(0, 4), 10)
  const m = parseInt(dateStr.slice(5, 7), 10)
  return m >= 7 ? y + 1 : y
}

function yearsOfEmployment(hireDate: string, grantDate: string): number {
  const hy = parseInt(hireDate.slice(0, 4), 10)
  const hm = parseInt(hireDate.slice(5, 7), 10)
  const hd = parseInt(hireDate.slice(8, 10), 10)
  const gy = parseInt(grantDate.slice(0, 4), 10)
  const gm = parseInt(grantDate.slice(5, 7), 10)
  const gd = parseInt(grantDate.slice(8, 10), 10)
  let years = gy - hy
  if (gm < hm || (gm === hm && gd < hd)) years--
  return Math.max(0, years)
}

// ── 공개 타입 ─────────────────────────────────────────────────

/** 신입사원 휴가: hire_date 이후 첫 11개월 매월 개근 (단일 항목, FY 분리 없음) */
export interface ProbationItem {
  kind:  'probation'
  from:  string   // 첫 번째 월차 발생일 (hireDate + 1개월)
  to:    string   // 마지막 월차 발생일 (최대 hireDate + 11개월)
  days:  number   // 개월 수 = 일수
}

/** 법정연차: 첫 비례연차 또는 매년 가산 연차 */
export interface AnnualItem {
  kind:    'annual'
  date:    string   // 권리 발생일 (YYYY-MM-DD)
  fyLabel: number   // FY 라벨 (§8: month>=7 ? year+1 : year)
  days:    number
  formula: string   // 산출 근거 (예: "기본15일+가산2일=17일 (근속5년)")
}

export type StatutoryLeaveItem = ProbationItem | AnnualItem

// ── 핵심 함수 ─────────────────────────────────────────────────

/**
 * 근로기준법 법정연차 항목 목록 반환 (asOfDate 이하 발생분만)
 *
 * - anchorType = 'fiscal'      → 회계연도(7/1) 기준
 * - anchorType = 'anniversary' → 입사일 주년일 기준
 */
export function computeStatutoryLeave(
  hireDate:   string,
  anchorType: 'fiscal' | 'anniversary',
  asOfDate:   string,
): StatutoryLeaveItem[] {
  const items: StatutoryLeaveItem[] = []

  // 신입사원 휴가: 입사 후 첫 11개월
  const monthDates: string[] = []
  for (let m = 1; m <= 11; m++) {
    const date = addMonths(hireDate, m)
    if (date > asOfDate) break
    monthDates.push(date)
  }
  if (monthDates.length > 0) {
    items.push({
      kind: 'probation',
      from: monthDates[0],
      to:   monthDates[monthDates.length - 1],
      days: monthDates.length,
    })
  }

  const hireYear  = parseInt(hireDate.slice(0, 4), 10)
  const hireMonth = parseInt(hireDate.slice(5, 7), 10)

  if (anchorType === 'fiscal') {
    const firstFiscalYear = hireMonth < 7 ? hireYear : hireYear + 1

    // 첫 회계연도 비례연차
    const firstDate = `${firstFiscalYear}-07-01`
    if (firstDate <= asOfDate) {
      const daysWorked = daysBetween(hireDate, firstDate)
      const days = r1(15 * daysWorked / 365)
      items.push({
        kind:    'annual',
        date:    firstDate,
        fyLabel: fyLabelOf(firstDate),   // Jul → year+1
        days,
        formula: `비례연차: 15일×${daysWorked}일/365≈${days}일`,
      })
    }

    // 이후 매년 7/1 가산 연차
    let fiscalYear = firstFiscalYear + 1
    while (true) {
      const date = `${fiscalYear}-07-01`
      if (date > asOfDate) break
      const ye    = yearsOfEmployment(hireDate, date)
      const bonus = Math.min(10, Math.floor((ye - 1) / 2))
      const days  = 15 + bonus
      items.push({
        kind:    'annual',
        date,
        fyLabel: fyLabelOf(date),        // Jul → year+1
        days,
        formula: bonus > 0
          ? `기본15일+가산${bonus}일=${days}일 (근속${ye}년)`
          : `기본15일 (근속${ye}년)`,
      })
      fiscalYear++
    }
  } else {
    // 입사일 주년일 기준
    let n = 1
    while (true) {
      const date = addYears(hireDate, n)
      if (date > asOfDate) break
      const bonus = Math.min(10, Math.floor((n - 1) / 2))
      const days  = 15 + bonus
      items.push({
        kind:    'annual',
        date,
        fyLabel: fyLabelOf(date),
        days,
        formula: bonus > 0
          ? `${n}주년: 기본15일+가산${bonus}일=${days}일`
          : `${n}주년: 기본15일`,
      })
      n++
    }
  }

  return items
}

/** 항목 배열 합계 */
export function sumStatutoryLeave(items: StatutoryLeaveItem[]): number {
  return r1(items.reduce((s, e) => s + e.days, 0))
}

/**
 * 해당 FY 법정연차 누적치 (TimesheetTab ①용)
 *
 * - fiscal basis의 annual 항목 중 fyLabel === currentFyLabel
 * - 신입사원 월차 중 발생일 >= fyStart 인 개월 수
 */
export function sumStatutoryLeaveFY(hireDate: string, asOfDate: string): number {
  const asOfYear  = parseInt(asOfDate.slice(0, 4), 10)
  const asOfMonth = parseInt(asOfDate.slice(5, 7), 10)
  const curFyLabel = asOfMonth >= 7 ? asOfYear + 1 : asOfYear
  const fyStart    = `${curFyLabel - 1}-07-01`

  // 신입사원 월차 중 FY 이후 발생분
  let probationDays = 0
  for (let m = 1; m <= 11; m++) {
    const date = addMonths(hireDate, m)
    if (date > asOfDate) break
    if (date >= fyStart) probationDays++
  }

  // fiscal annual 항목 중 현재 FY 것
  const items = computeStatutoryLeave(hireDate, 'fiscal', asOfDate)
  const annualDays = items
    .filter((i): i is AnnualItem => i.kind === 'annual' && i.fyLabel === curFyLabel)
    .reduce((s, i) => s + i.days, 0)

  return r1(probationDays + annualDays)
}

/** FY 기간 문자열 표시용: fyLabel → "fyLabel-1.07~fyLabel.06" */
export function fyPeriodStr(fyLabel: number): string {
  return `${fyLabel - 1}.07~${fyLabel}.06`
}
