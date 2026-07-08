/**
 * Unit tests — §5.13 Annual Leave computation
 *
 * Coverage:
 *   1. computeSettlement — max basis (statutory > team / team > statutory / equal)
 *   2. computeSettlement — excess / shortfall / boundary (used = entitlement)
 *   3. computeSettlement — adjustments contribute correctly
 *   4. computeTimesheetFigures — ③ FIFO source distinction (프로젝트휴가 vs others)
 *   5. computeTimesheetFigures — ④ shortfall aggregation
 *   6. computeTimesheetFigures — ① 1/1 역년 경계 (prior-year adjustments excluded)
 */

import { describe, it, expect } from 'vitest'
import { computeSettlement, computeTimesheetFigures } from './annualLeave'
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

// ── 1. computeSettlement — max basis ─────────────────────────

describe('computeSettlement — 총 휴가 권리 max 로직', () => {
  const asOf = '2024-12-31'

  it('statutory > teamAccrued → entitlementBasis = statutory', () => {
    const r = computeSettlement(asOf, {
      grants: [mkGrant(2024, 20)],
      adjustments: [],
      teamActualAccrued: 15,
      totalPaidUsed: 10,
    })
    expect(r.statutory).toBe(20)
    expect(r.teamAccrued).toBe(15)
    expect(r.totalEntitlement).toBe(20)
    expect(r.entitlementBasis).toBe('statutory')
  })

  it('teamAccrued > statutory → entitlementBasis = team', () => {
    const r = computeSettlement(asOf, {
      grants: [mkGrant(2024, 10)],
      adjustments: [],
      teamActualAccrued: 18,
      totalPaidUsed: 12,
    })
    expect(r.totalEntitlement).toBe(18)
    expect(r.entitlementBasis).toBe('team')
  })

  it('statutory === teamAccrued → entitlementBasis = equal', () => {
    const r = computeSettlement(asOf, {
      grants: [mkGrant(2024, 12)],
      adjustments: [],
      teamActualAccrued: 12,
      totalPaidUsed: 8,
    })
    expect(r.totalEntitlement).toBe(12)
    expect(r.entitlementBasis).toBe('equal')
  })
})

// ── 2. computeSettlement — excess / shortfall / boundary ─────

describe('computeSettlement — 초과·미달·경계', () => {
  const asOf = '2024-12-31'

  it('초과 사용 → excess > 0, shortfall = 0', () => {
    const r = computeSettlement(asOf, {
      grants: [mkGrant(2024, 10)],
      adjustments: [],
      teamActualAccrued: 8,
      totalPaidUsed: 15,
    })
    // entitlement = max(10, 8) = 10, used = 15
    expect(r.totalEntitlement).toBe(10)
    expect(r.excess).toBe(5)
    expect(r.shortfall).toBe(0)
    expect(r.netSettlement).toBe(-5)
  })

  it('미달 사용 → shortfall > 0, excess = 0', () => {
    const r = computeSettlement(asOf, {
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

  it('권리 = 사용 → excess = 0, shortfall = 0', () => {
    const r = computeSettlement(asOf, {
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

// ── 3. computeSettlement — adjustments ───────────────────────

describe('computeSettlement — adjustments 반영', () => {
  it('accrual adjustment adds to statutory', () => {
    const r = computeSettlement('2024-12-31', {
      grants: [mkGrant(2024, 10)],
      adjustments: [mkAdj('2024-06-01', 'accrual', 3)],
      teamActualAccrued: 5,
      totalPaidUsed: 0,
    })
    expect(r.statutory).toBe(13)
  })

  it('usage adjustment subtracts from statutory', () => {
    const r = computeSettlement('2024-12-31', {
      grants: [mkGrant(2024, 10)],
      adjustments: [mkAdj('2024-06-01', 'usage', 2)],
      teamActualAccrued: 5,
      totalPaidUsed: 0,
    })
    expect(r.statutory).toBe(8)
  })

  it('adjustment after asOfDate is excluded', () => {
    const r = computeSettlement('2024-06-30', {
      grants: [mkGrant(2024, 10)],
      adjustments: [mkAdj('2024-07-01', 'accrual', 5)],
      teamActualAccrued: 0,
      totalPaidUsed: 0,
    })
    expect(r.statutory).toBe(10)  // 5-day July adjustment excluded
  })

  it('grants from future year excluded', () => {
    const r = computeSettlement('2024-12-31', {
      grants: [mkGrant(2024, 10), mkGrant(2025, 12)],
      adjustments: [],
      teamActualAccrued: 0,
      totalPaidUsed: 0,
    })
    expect(r.statutory).toBe(10)  // 2025 grant not counted
  })

  it('multi-year grants accumulate', () => {
    const r = computeSettlement('2025-06-30', {
      grants: [mkGrant(2023, 10), mkGrant(2024, 12), mkGrant(2025, 11)],
      adjustments: [],
      teamActualAccrued: 0,
      totalPaidUsed: 0,
    })
    expect(r.statutory).toBe(33)
  })
})

// ── 4. computeTimesheetFigures — ③ FIFO source distinction ───

describe('computeTimesheetFigures — ③ 차감 원천 구분', () => {
  const asOf = '2024-12-31'
  const grants = [mkGrant(2024, 15)]
  const adjustments: ReturnType<typeof mkAdj>[] = []

  it('지정휴가 deduction from 프로젝트휴가 accrual is counted', () => {
    const projAcc = mkAccrual('acc-proj', '프로젝트휴가', 5)
    const bonusAcc = mkAccrual('acc-bonus', '포상휴가', 3)
    // 지정휴가 usage: 3 days, deducted 2 from projAcc and 1 from bonusAcc
    const usage = mkUsage('지정휴가', 3, 0, [
      { accrualId: 'acc-proj', days: 2 },
      { accrualId: 'acc-bonus', days: 1 },
    ])
    const r = computeTimesheetFigures(asOf, {
      grants, adjustments,
      usages:   [usage],
      accruals: [projAcc, bonusAcc],
    })
    expect(r.designatedFromProject).toBe(2)  // only proj-sourced
  })

  it('지정휴가 with no 프로젝트휴가 source → designatedFromProject = 0', () => {
    const bonusAcc = mkAccrual('acc-bonus', '포상휴가', 5)
    const usage = mkUsage('지정휴가', 2, 0, [{ accrualId: 'acc-bonus', days: 2 }])
    const r = computeTimesheetFigures(asOf, {
      grants, adjustments,
      usages:   [usage],
      accruals: [bonusAcc],
    })
    expect(r.designatedFromProject).toBe(0)
  })

  it('프로젝트휴가 usage does NOT count toward ③ (③ is only via 지정휴가)', () => {
    const projAcc = mkAccrual('acc-proj', '프로젝트휴가', 5)
    const usage = mkUsage('프로젝트휴가', 5, 0, [{ accrualId: 'acc-proj', days: 5 }])
    const r = computeTimesheetFigures(asOf, {
      grants, adjustments,
      usages:   [usage],
      accruals: [projAcc],
    })
    expect(r.designatedFromProject).toBe(0)
    expect(r.projectLeaveUsed).toBe(5)
  })
})

// ── 5. computeTimesheetFigures — ④ shortfall ─────────────────

describe('computeTimesheetFigures — ④ 지정휴가 선사용분', () => {
  const asOf = '2024-12-31'

  it('aggregates deficit across multiple 지정휴가 usages', () => {
    const u1 = mkUsage('지정휴가', 3, 2, [])  // deficit 2
    const u2 = mkUsage('지정휴가', 2, 1, [])  // deficit 1
    const r = computeTimesheetFigures(asOf, {
      grants: [],
      adjustments: [],
      usages: [u1, u2],
      accruals: [],
    })
    expect(r.designatedShortfall).toBe(3)
  })

  it('non-지정휴가 deficit is not counted', () => {
    const u = mkUsage('포상휴가', 3, 2, [])
    const r = computeTimesheetFigures(asOf, {
      grants: [],
      adjustments: [],
      usages: [u],
      accruals: [],
    })
    expect(r.designatedShortfall).toBe(0)
  })
})

// ── 6. computeTimesheetFigures — ① 1/1 역년 경계 ────────────

describe('computeTimesheetFigures — ① 역년 경계', () => {
  it('grant for prior year is NOT counted in statutoryThisYear', () => {
    const r = computeTimesheetFigures('2025-03-01', {
      grants: [mkGrant(2024, 15), mkGrant(2025, 12)],
      adjustments: [],
      usages: [],
      accruals: [],
    })
    expect(r.statutoryThisYear).toBe(12)  // only 2025 grant
  })

  it('adjustment before 1/1 of asOf year is excluded', () => {
    const r = computeTimesheetFigures('2025-06-30', {
      grants: [mkGrant(2025, 10)],
      adjustments: [
        mkAdj('2024-12-31', 'accrual', 5),  // prior year → excluded
        mkAdj('2025-03-01', 'accrual', 2),  // same year → included
      ],
      usages: [],
      accruals: [],
    })
    expect(r.statutoryThisYear).toBe(12)  // 10 + 2
  })

  it('adjustment after asOfDate is excluded even if same year', () => {
    const r = computeTimesheetFigures('2025-06-30', {
      grants: [mkGrant(2025, 10)],
      adjustments: [
        mkAdj('2025-07-01', 'accrual', 5),  // after asOf → excluded
      ],
      usages: [],
      accruals: [],
    })
    expect(r.statutoryThisYear).toBe(10)
  })
})
