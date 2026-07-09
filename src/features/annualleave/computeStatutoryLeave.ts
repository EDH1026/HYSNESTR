/**
 * §5.13 AL-2, AL-2b — 근로기준법 법정연차 자동 계산 (pure, no side effects)
 *
 * 근로기준법 제60조 기준:
 * - 첫 해: 매월 만근 시 1일 (최대 11개월 = 11일)
 * - 회계연도(calendar) 기준:
 *     입사 다음해 1월 1일: 15 × (입사일~해당년도말 일수 / 입사연도 총일수)
 *     이후 매년 1월 1일: min(25, 15 + floor((해당년 - 입사년 - 1) / 2))
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

function daysInCalYear(y: number): number {
  return y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0) ? 366 : 365
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
    // 첫 연차: 다음해 1월 1일, 비례 부여
    const firstAnnualDate = `${hireYear + 1}-01-01`
    if (firstAnnualDate <= asOfDate) {
      // 입사일 ~ 입사년도 말일 (inclusive) 일 수
      const daysWorked = daysBetween(hireDate, `${hireYear + 1}-01-01`)
      const days = r1(15 * daysWorked / daysInCalYear(hireYear))
      events.push({ date: firstAnnualDate, days, kind: 'annual', label: `${hireYear + 1}년 비례연차` })
    }

    // 이후 매년 1월 1일
    let year = hireYear + 2
    while (true) {
      const date = `${year}-01-01`
      if (date > asOfDate) break
      // year - hireYear = 경과 연도 수 (첫 비례연차 이후 1부터 시작)
      const elapsed = year - hireYear  // hireYear+2 → elapsed=2, hireYear+3 → elapsed=3, …
      const days = Math.min(25, 15 + Math.floor((elapsed - 1) / 2))
      events.push({ date, days, kind: 'annual', label: `${year}년 연차` })
      year++
    }
  } else {
    // 입사일 기준: N번째 주년일
    let n = 1
    while (true) {
      const date = addYears(hireDate, n)
      if (date > asOfDate) break
      const days = Math.min(25, 15 + Math.floor((n - 1) / 2))
      events.push({ date, days, kind: 'annual', label: `${n}주년 연차` })
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
