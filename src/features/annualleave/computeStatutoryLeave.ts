/**
 * §5.13 AL-2, AL-2b — 근로기준법 법정연차 자동 계산 (pure, no side effects)
 *
 * 근로기준법 제60조 기준:
 * - 첫 해: 매월 만근 시 1일 (최대 11개월 = 11일)
 * - 회계연도(calendar) 기준 — 회사 회계연도 7월 1일 기준 (PRD v2.28):
 *     다음 회계연도 7월 1일: 15 × (입사일~해당 7/1 재직일수 / 365)
 *     이후 매년 7월 1일: min(25, 15 + floor((경과횟수) / 2))
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
    // 첫 연차: 다음 회계연도 7월 1일, 비례 부여 (PRD v2.28 — 7월 1일 기준)
    // 7월 이후 입사 → 다음해 7/1; 7월 이전(1~6월) 입사 → 같은 해 7/1
    const hireMonth = parseInt(hireDate.slice(5, 7), 10)
    const firstFiscalYear = hireMonth < 7 ? hireYear : hireYear + 1
    const firstFiscalDate = `${firstFiscalYear}-07-01`

    if (firstFiscalDate <= asOfDate) {
      const daysWorked = daysBetween(hireDate, firstFiscalDate)
      const days = r1(15 * daysWorked / 365)   // 고정 365 분모 (PRD)
      events.push({ date: firstFiscalDate, days, kind: 'annual', label: `${firstFiscalYear}년 비례연차` })
    }

    // 이후 매년 7월 1일
    let fiscalYear = firstFiscalYear + 1
    let n = 1  // n=1 → elapsed=2 → 15일; n=2 → elapsed=3 → 16일 …
    while (true) {
      const date = `${fiscalYear}-07-01`
      if (date > asOfDate) break
      const elapsed = n + 1
      const days = Math.min(25, 15 + Math.floor((elapsed - 1) / 2))
      events.push({ date, days, kind: 'annual', label: `${fiscalYear}년 연차` })
      fiscalYear++
      n++
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
