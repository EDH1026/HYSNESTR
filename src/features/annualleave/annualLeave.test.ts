/**
 * Unit tests — §5.13 Annual Leave computation (AL-3~AL-5)
 *
 * Coverage:
 *   1. computeAnnualLeaveSettlement — max 기반 권리 (합산 금지 명시 검증 포함)
 *   1b. computeAnnualLeaveSettlement — 후보 (a) = statutory + weekendSub + specialLeave
 *   2. computeAnnualLeaveSettlement — excess / shortfall / boundary
 *   3. computeAnnualLeaveSettlement — adjustments 반영
 *   4. computeTimesheetFigures — ③ FIFO 차감 원천 구분
 *   5. computeTimesheetFigures — ④ shortfall 집계
 *   6. computeTimesheetFigures — ① 1/1 역년 경계
 */

import { describe, it, expect } from 'vitest'
import { computeAnnualLeaveSettlement, computeTimesheetFigures } from './annualLeave'
import type { LedgerAccrualEntry, LedgerUsageEntry } from '@/features/leave/ledger'
import type { AccrualType } from '@/types'

// ── Helpers ───────────────────────────────────────────────────

function mkGrant(year: number, days: number) {
  return { year, days }
}

function mkAdj(date: string, direction: 'accrual' | 'usage', days: number) {
  return { date, direction, days }
}

function mkAccrual(id: string, type: AccrualType, days: number): LedgerAccrualEntry {
  return { id, type, days, date: '2024-01-01', sourceId: null, remaining: days, isAuto: false }
}

let _uid = 1
function mkUsage(
  type: string,
  days: number,
  deficit: number,
  deductions: { accrualId: string; days: number }[],
  start = '2024-06-01',
): LedgerUsageEntry {
  return {
    assignmentId: `u${_uid++}`,
    start,
    end: start,
    type: type as any,
    days,
    deficit,
    deductions: deductions.map(d => ({ ...d, sourceId: null })),
    isManual: false,
  }
}

// ── 1. AL-3: 총 휴가 권리 = max(법정연차, 팀 적립) — 합산 금지 ──

describe('computeAnnualLeaveSettlement — AL-3 총 휴가 권리 max 로직', () => {
  const asOf = '2024-12-31'

  it('statutory > teamAccrued → totalEntitlement = statutory (NOT sum)', () => {
    const r = computeAnnualLeaveSettlement(asOf, {
      grants: [mkGrant(2024, 20)],
      adjustments: [],
      teamActualAccrued: 15,
      totalPaidUsed: 10,
    })
    expect(r.statutory).toBe(20)
    expect(r.teamAccrued).toBe(15)
    expect(r.totalEntitlement).toBe(20)           // max(20,15)
    expect(r.totalEntitlement).not.toBe(35)       // 합산(20+15) 아님
    expect(r.entitlementBasis).toBe('candidateA')
  })

  it('teamAccrued > statutory → totalEntitlement = teamAccrued (NOT sum)', () => {
    const r = computeAnnualLeaveSettlement(asOf, {
      grants: [mkGrant(2024, 10)],
      adjustments: [],
      teamActualAccrued: 18,
      totalPaidUsed: 12,
    })
    expect(r.totalEntitlement).toBe(18)           // max(10,18)
    expect(r.totalEntitlement).not.toBe(28)       // 합산(10+18) 아님
    expect(r.entitlementBasis).toBe('team')
  })

  it('statutory === teamAccrued → entitlementBasis = equal', () => {
    const r = computeAnnualLeaveSettlement(asOf, {
      grants: [mkGrant(2024, 12)],
      adjustments: [],
      teamActualAccrued: 12,
      totalPaidUsed: 8,
    })
    expect(r.totalEntitlement).toBe(12)
    expect(r.entitlementBasis).toBe('equal')
  })

  it('합산 금지 명시 검증: statutory=15, team=20 → 권리=20, 합(35) 아님', () => {
    const r = computeAnnualLeaveSettlement(asOf, {
      grants: [mkGrant(2024, 15)],
      adjustments: [],
      teamActualAccrued: 20,
      totalPaidUsed: 0,
    })
    expect(r.totalEntitlement).toBe(20)
    expect(r.totalEntitlement).not.toBe(35)
  })
})

// ── 1b. 후보 (a) = statutory + weekendSub + specialLeave ──────

describe('computeAnnualLeaveSettlement — 후보 (a) candidateA 계산', () => {
  const asOf = '2024-12-31'

  it('weekendSub·specialLeave 없음(기본값 0) → candidateA = statutory', () => {
    const r = computeAnnualLeaveSettlement(asOf, {
      grants: [mkGrant(2024, 15)],
      adjustments: [],
      teamActualAccrued: 10,
      totalPaidUsed: 5,
    })
    expect(r.weekendSub).toBe(0)
    expect(r.specialLeave).toBe(0)
    expect(r.candidateA).toBe(15)
    expect(r.totalEntitlement).toBe(15)
    expect(r.entitlementBasis).toBe('candidateA')
  })

  it('a(statutory+weekendSub) > b(team) → 후보 a 채택', () => {
    const r = computeAnnualLeaveSettlement(asOf, {
      grants: [mkGrant(2024, 10)],
      adjustments: [],
      weekendSubAccrued: 5,
      teamActualAccrued: 12,
      totalPaidUsed: 0,
    })
    expect(r.statutory).toBe(10)
    expect(r.weekendSub).toBe(5)
    expect(r.candidateA).toBe(15)
    expect(r.totalEntitlement).toBe(15)   // max(15, 12)
    expect(r.entitlementBasis).toBe('candidateA')
  })

  it('b(team) > a(statutory+weekendSub) → 후보 b 채택', () => {
    const r = computeAnnualLeaveSettlement(asOf, {
      grants: [mkGrant(2024, 10)],
      adjustments: [],
      weekendSubAccrued: 2,
      teamActualAccrued: 15,
      totalPaidUsed: 0,
    })
    expect(r.candidateA).toBe(12)
    expect(r.totalEntitlement).toBe(15)   // max(12, 15)
    expect(r.entitlementBasis).toBe('team')
  })

  it('a === b → entitlementBasis = equal', () => {
    const r = computeAnnualLeaveSettlement(asOf, {
      grants: [mkGrant(2024, 10)],
      adjustments: [],
      weekendSubAccrued: 3,
      teamActualAccrued: 13,
      totalPaidUsed: 0,
    })
    expect(r.candidateA).toBe(13)
    expect(r.teamAccrued).toBe(13)
    expect(r.entitlementBasis).toBe('equal')
  })

  it('합산 금지: candidateA+team 을 더하지 않음', () => {
    // statutory=10, weekendSub=4, team=12 → a=14 > b=12 → 권리=14, a+b=26 아님
    const r = computeAnnualLeaveSettlement(asOf, {
      grants: [mkGrant(2024, 10)],
      adjustments: [],
      weekendSubAccrued: 4,
      teamActualAccrued: 12,
      totalPaidUsed: 0,
    })
    expect(r.totalEntitlement).toBe(14)
    expect(r.totalEntitlement).not.toBe(26)
  })

  it('specialLeaveAccrued → candidateA에 포함, team은 불변', () => {
    // statutory=10, weekendSub=2, specialLeave=3 → a=15, team=12 → 권리=15
    const r = computeAnnualLeaveSettlement(asOf, {
      grants: [mkGrant(2024, 10)],
      adjustments: [],
      weekendSubAccrued:   2,
      specialLeaveAccrued: 3,
      teamActualAccrued:   12,
      totalPaidUsed: 0,
    })
    expect(r.specialLeave).toBe(3)
    expect(r.candidateA).toBe(15)          // 10+2+3
    expect(r.teamAccrued).toBe(12)         // 팀 적립 그대로
    expect(r.totalEntitlement).toBe(15)
    expect(r.entitlementBasis).toBe('candidateA')
  })

  it('specialLeave로 인해 team보다 a가 커지는 케이스', () => {
    // statutory=10, weekendSub=0, specialLeave=5, team=14 → a=15 > b=14 → 권리=15
    const r = computeAnnualLeaveSettlement(asOf, {
      grants: [mkGrant(2024, 10)],
      adjustments: [],
      specialLeaveAccrued: 5,
      teamActualAccrued:   14,
      totalPaidUsed: 0,
    })
    expect(r.candidateA).toBe(15)
    expect(r.totalEntitlement).toBe(15)
    expect(r.entitlementBasis).toBe('candidateA')
  })

  it('특별휴가가 team에도 포함되어 있어도 candidateA 계산은 독립 (이중 합산 아님)', () => {
    // specialLeave=3은 teamActualAccrued(=14)에도 포함됨.
    // candidateA = statutory(10) + specialLeave(3) = 13 < team(14) → team 채택
    const r = computeAnnualLeaveSettlement(asOf, {
      grants: [mkGrant(2024, 10)],
      adjustments: [],
      specialLeaveAccrued: 3,
      teamActualAccrued:   14,
      totalPaidUsed: 0,
    })
    expect(r.candidateA).toBe(13)
    expect(r.teamAccrued).toBe(14)
    expect(r.totalEntitlement).toBe(14)   // team wins
    expect(r.entitlementBasis).toBe('team')
  })
})

// ── 2. AL-4/AL-5: excess / shortfall / boundary ──────────────

describe('computeAnnualLeaveSettlement — AL-4·AL-5 초과·미달·경계', () => {
  const asOf = '2024-12-31'

  it('초과 사용 → excess > 0, shortfall = 0', () => {
    const r = computeAnnualLeaveSettlement(asOf, {
      grants: [mkGrant(2024, 10)],
      adjustments: [],
      teamActualAccrued: 8,
      totalPaidUsed: 15,
    })
    // totalEntitlement = max(10, 8) = 10, used = 15 → excess = 5
    expect(r.totalEntitlement).toBe(10)
    expect(r.excess).toBe(5)
    expect(r.shortfall).toBe(0)
    expect(r.netSettlement).toBe(-5)
  })

  it('미달 사용 → shortfall > 0, excess = 0', () => {
    const r = computeAnnualLeaveSettlement(asOf, {
      grants: [mkGrant(2024, 15)],
      adjustments: [],
      teamActualAccrued: 10,
      totalPaidUsed: 7,
    })
    expect(r.totalEntitlement).toBe(15)
    expect(r.shortfall).toBe(8)
    expect(r.excess).toBe(0)
    expect(r.netSettlement).toBe(8)
  })

  it('권리 = 사용 → excess = 0, shortfall = 0, netSettlement = 0', () => {
    const r = computeAnnualLeaveSettlement(asOf, {
      grants: [mkGrant(2024, 12)],
      adjustments: [],
      teamActualAccrued: 10,
      totalPaidUsed: 12,
    })
    expect(r.totalEntitlement).toBe(12)
    expect(r.excess).toBe(0)
    expect(r.shortfall).toBe(0)
    expect(r.netSettlement).toBe(0)
  })
})

// ── 3. adjustments 반영 ───────────────────────────────────────

describe('computeAnnualLeaveSettlement — adjustments 반영', () => {
  it('accrual adjustment adds to statutory', () => {
    const r = computeAnnualLeaveSettlement('2024-12-31', {
      grants: [mkGrant(2024, 10)],
      adjustments: [mkAdj('2024-06-01', 'accrual', 3)],
      teamActualAccrued: 5,
      totalPaidUsed: 0,
    })
    expect(r.statutory).toBe(13)
  })

  it('usage adjustment subtracts from statutory', () => {
    const r = computeAnnualLeaveSettlement('2024-12-31', {
      grants: [mkGrant(2024, 10)],
      adjustments: [mkAdj('2024-06-01', 'usage', 2)],
      teamActualAccrued: 5,
      totalPaidUsed: 0,
    })
    expect(r.statutory).toBe(8)
  })

  it('adjustment after asOfDate is excluded', () => {
    const r = computeAnnualLeaveSettlement('2024-06-30', {
      grants: [mkGrant(2024, 10)],
      adjustments: [mkAdj('2024-07-01', 'accrual', 5)],
      teamActualAccrued: 0,
      totalPaidUsed: 0,
    })
    expect(r.statutory).toBe(10)
  })

  it('grants from future year excluded', () => {
    const r = computeAnnualLeaveSettlement('2024-12-31', {
      grants: [mkGrant(2024, 10), mkGrant(2025, 12)],
      adjustments: [],
      teamActualAccrued: 0,
      totalPaidUsed: 0,
    })
    expect(r.statutory).toBe(10)
  })

  it('multi-year grants accumulate', () => {
    const r = computeAnnualLeaveSettlement('2025-06-30', {
      grants: [mkGrant(2023, 10), mkGrant(2024, 12), mkGrant(2025, 11)],
      adjustments: [],
      teamActualAccrued: 0,
      totalPaidUsed: 0,
    })
    expect(r.statutory).toBe(33)
  })
})

// ── 4. computeTimesheetFigures — ③ FIFO 차감 원천 구분 ────────

describe('computeTimesheetFigures — ③ 차감 원천 구분', () => {
  const asOf = '2024-12-31'
  const grants = [mkGrant(2024, 15)]
  const adjustments: ReturnType<typeof mkAdj>[] = []

  it('지정휴가 deduction from 프로젝트휴가 accrual is counted', () => {
    const projAcc  = mkAccrual('acc-proj',  '프로젝트휴가', 5)
    const bonusAcc = mkAccrual('acc-bonus', '포상휴가',     3)
    const usage = mkUsage('지정휴가', 3, 0, [
      { accrualId: 'acc-proj',  days: 2 },
      { accrualId: 'acc-bonus', days: 1 },
    ])
    const r = computeTimesheetFigures(asOf, { grants, adjustments, usages: [usage], accruals: [projAcc, bonusAcc] })
    expect(r.designatedFromProject).toBe(2)
  })

  it('지정휴가 with no 프로젝트휴가 source → designatedFromProject = 0', () => {
    const bonusAcc = mkAccrual('acc-bonus', '포상휴가', 5)
    const usage = mkUsage('지정휴가', 2, 0, [{ accrualId: 'acc-bonus', days: 2 }])
    const r = computeTimesheetFigures(asOf, { grants, adjustments, usages: [usage], accruals: [bonusAcc] })
    expect(r.designatedFromProject).toBe(0)
  })

  it('프로젝트휴가 usage does NOT count toward ③', () => {
    const projAcc = mkAccrual('acc-proj', '프로젝트휴가', 5)
    const usage   = mkUsage('프로젝트휴가', 5, 0, [{ accrualId: 'acc-proj', days: 5 }])
    const r = computeTimesheetFigures(asOf, { grants, adjustments, usages: [usage], accruals: [projAcc] })
    expect(r.designatedFromProject).toBe(0)
    expect(r.projectLeaveUsed).toBe(5)
  })
})

// ── 5. computeTimesheetFigures — ④ 지정휴가 선사용분 ──────────

describe('computeTimesheetFigures — ④ 지정휴가 선사용분', () => {
  const asOf = '2024-12-31'

  it('aggregates deficit across multiple 지정휴가 usages', () => {
    const u1 = mkUsage('지정휴가', 3, 2, [])
    const u2 = mkUsage('지정휴가', 2, 1, [])
    const r = computeTimesheetFigures(asOf, { grants: [], adjustments: [], usages: [u1, u2], accruals: [] })
    expect(r.designatedShortfall).toBe(3)
  })

  it('non-지정휴가 deficit is not counted', () => {
    const u = mkUsage('포상휴가', 3, 2, [])
    const r = computeTimesheetFigures(asOf, { grants: [], adjustments: [], usages: [u], accruals: [] })
    expect(r.designatedShortfall).toBe(0)
  })
})

// ── 6. computeTimesheetFigures — ① 1/1 역년 경계 ────────────

describe('computeTimesheetFigures — ① 역년 경계', () => {
  it('grant for prior year is NOT counted in statutoryThisYear', () => {
    const r = computeTimesheetFigures('2025-03-01', {
      grants: [mkGrant(2024, 15), mkGrant(2025, 12)],
      adjustments: [], usages: [], accruals: [],
    })
    expect(r.statutoryThisYear).toBe(12)
  })

  it('adjustment before 1/1 of asOf year is excluded', () => {
    const r = computeTimesheetFigures('2025-06-30', {
      grants: [mkGrant(2025, 10)],
      adjustments: [
        mkAdj('2024-12-31', 'accrual', 5),  // 이전 연도 → 제외
        mkAdj('2025-03-01', 'accrual', 2),  // 같은 연도 → 포함
      ],
      usages: [], accruals: [],
    })
    expect(r.statutoryThisYear).toBe(12)  // 10 + 2
  })

  it('adjustment after asOfDate is excluded even if same year', () => {
    const r = computeTimesheetFigures('2025-06-30', {
      grants: [mkGrant(2025, 10)],
      adjustments: [mkAdj('2025-07-01', 'accrual', 5)],  // 기준일 이후 → 제외
      usages: [], accruals: [],
    })
    expect(r.statutoryThisYear).toBe(10)
  })
})
