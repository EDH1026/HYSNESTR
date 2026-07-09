/**
 * §5.13 AL-2, AL-2b — 근로기준법 법정연차 자동 계산 (pure, no side effects)
 *
 * 근로기준법 제60조 기준:
 * - 첫 해: 매월 만근 시 1일 (최대 11개월 = 11일)
 * - 회계연도(calendar) 기준 — 회사 회계연도 7월 1일 기준 (PRD v2.28):
 *     다음 회계연도 7월 1일: 15 × (입사일~해당 7/1 재직일수 / 365)
 *     이후 매년 7월 1일: min(25, 15 + floor((만근속연수 - 1) / 2))
 * - 입사일(anniversary) 기준:
 *     N번째 주년일: min(25, 15 + floor((N - 1) / 2))
 */

export interface StatutoryLeaveEvent {
  date:  string   // YYYY-MM-DD — 권리 발생일
  days:  number
  kind:  'monthly' | 'annual'
  label: string
}

function r1(n: number): number {
  return Math.round(n * 10) / 10
}

/** 두 YYYY-MM-DD 사이 일 수 (end 미포함) */
function daysBetween(startStr: string, endStr: string): number {
  const [sy, sm, sd] = startStr.split('-').map(Number)
  const [ey, em, ed] = endStr.split('-').map(Number)
  return Math.round(
    (Date.UTC(ey, em - 1, ed) - Date.UTC(sy, sm - 1, sd)) / 86400000,
  )
}

/** YYYY-MM-DD + months 개월 (말일 클램핑) */
function addMonths(dateStr: string, months: number): string {
  const [y, m, d] = dateStr.split('-').map(Number)
  const totalMonths = (m - 1) + months
  const ty = y + Math.floor(totalMonths / 12)
  const tm = (totalMonths % 12 + 12) % 12 + 1
  const daysInMonth = new Date(Date.UTC(ty, tm, 0)).getUTCDate()
  const day = Math.min(d, daysInMonth)
  return `${ty}-${String(tm).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/** YYYY-MM-DD + years 년 (윤년 클램핑) */
function addYears(dateStr: string, years: number): string {
  return addMonths(dateStr, years * 12)
}

/**
 * 입사일~기준일 사이 만 근속연수.
 * 주년일(月·日)이 기준일보다 늦으면 아직 해당 연도 미충족.
 */
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

// ── Public API ────────────────────────────────────────────────

export function computeStatutoryLeave(
  hireDate:   string,                         // YYYY-MM-DD
  anchorType: 'calendar' | 'anniversary',
  asOfDate:   string,                         // YYYY-MM-DD (이 날짜 이하만)
): StatutoryLeaveEvent[] {
  const events: StatutoryLeaveEvent[] = []
  const hireYear = parseInt(hireDate.slice(0, 4), 10)

  // 첫 11개월 월차 (공통)
  for (let m = 1; m <= 11; m++) {
    const date = addMonths(hireDate, m)
    if (date > asOfDate) break
    events.push({ date, days: 1, kind: 'monthly', label: `${m}개월차 월차` })
  }

  if (anchorType === 'calendar') {
    const hireMonth = parseInt(hireDate.slice(5, 7), 10)
    const firstFiscalYear = hireMonth < 7 ? hireYear : hireYear + 1
    const firstFiscalDate = `${firstFiscalYear}-07-01`

    if (firstFiscalDate <= asOfDate) {
      const daysWorked = daysBetween(hireDate, firstFiscalDate)
      const days = r1(15 * daysWorked / 365)
      events.push({
        date: firstFiscalDate,
        days,
        kind: 'annual',
        label: `비례연차: 15일×${daysWorked}일/365≈${days}일`,
      })
    }

    // 이후 매년 7월 1일 — 가산: floor((만근속연수 - 1) / 2)
    let fiscalYear = firstFiscalYear + 1
    while (true) {
      const date = `${fiscalYear}-07-01`
      if (date > asOfDate) break
      const ye    = yearsOfEmployment(hireDate, date)
      const bonus = Math.min(10, Math.floor((ye - 1) / 2))
      const days  = 15 + bonus
      events.push({
        date,
        days,
        kind: 'annual',
        label: bonus > 0
          ? `기본15일+가산${bonus}일=${days}일 (근속${ye}년)`
          : `기본15일 (근속${ye}년)`,
      })
      fiscalYear++
    }
  } else {
    // 입사일 기준: N번째 주년일
    let n = 1
    while (true) {
      const date = addYears(hireDate, n)
      if (date > asOfDate) break
      const bonus = Math.min(10, Math.floor((n - 1) / 2))
      const days  = 15 + bonus
      events.push({
        date,
        days,
        kind: 'annual',
        label: bonus > 0
          ? `${n}주년: 기본15일+가산${bonus}일=${days}일`
          : `${n}주년: 기본15일`,
      })
      n++
    }
  }

  return events
}

export function sumStatutoryLeave(events: StatutoryLeaveEvent[]): number {
  return r1(events.reduce((s, e) => s + e.days, 0))
}

/** 이벤트를 역년별로 집계 (자동 입력 버튼용) */
export function groupByYear(events: StatutoryLeaveEvent[]): Map<number, number> {
  const map = new Map<number, number>()
  for (const e of events) {
    const y = parseInt(e.date.slice(0, 4), 10)
    map.set(y, r1((map.get(y) ?? 0) + e.days))
  }
  return map
}

export interface GrantTypeRow {
  year:       number
  grant_type: 'first_year_monthly' | 'annual'
  days:       number
  label:      string
  grantDate?: string  // 'annual' 타입: 적립 기준일 (YYYY-MM-DD = {year}-07-01)
}

/** 이벤트를 (역년, grant_type)별로 집계 + 산출 라벨 생성 */
export function groupByYearAndType(events: StatutoryLeaveEvent[]): GrantTypeRow[] {
  const monthlyMap = new Map<number, { days: number; first: string; last: string }>()
  const annualMap  = new Map<number, { days: number; label: string; date: string }>()

  for (const e of events) {
    const y = parseInt(e.date.slice(0, 4), 10)
    if (e.kind === 'monthly') {
      const prev = monthlyMap.get(y)
      if (prev) { prev.days = r1(prev.days + e.days); prev.last = e.date }
      else       { monthlyMap.set(y, { days: e.days, first: e.date, last: e.date }) }
    } else {
      annualMap.set(y, { days: e.days, label: e.label, date: e.date })
    }
  }

  const rows: GrantTypeRow[] = []
  for (const [year, { days, first, last }] of monthlyMap) {
    const range = first.slice(0, 7) === last.slice(0, 7)
      ? first.slice(0, 7)
      : `${first.slice(0, 7)}~${last.slice(0, 7)}`
    rows.push({
      year,
      grant_type: 'first_year_monthly',
      days,
      label: `매월개근 ${range} 합계 ${days}일`,
    })
  }
  for (const [year, { days, label, date }] of annualMap)
    rows.push({ year, grant_type: 'annual', days, label, grantDate: date })

  return rows.sort((a, b) => a.year - b.year || a.grant_type.localeCompare(b.grant_type))
}
