/**
 * §5.13 Annual Leave computation — pure functions, no side effects.
 *
 * computeSettlement  — 퇴사 정산 (max-based entitlement vs used)
 * computeTimesheetFigures — 타임시트 판단용 4개 수치
 */

import type { LedgerAccrualEntry, LedgerUsageEntry } from '@/features/leave/ledger'
import type { AnnualLeaveGrant, AnnualLeaveAdjustment } from '@/types'

// ── Shared helpers ────────────────────────────────────────────

function r1(n: number): number {
  return Math.round(n * 10) / 10
}

/** Signed contribution of an adjustment to the statutory total.
 *  direction='accrual' → +days, direction='usage' → -days */
function adjContrib(a: Pick<AnnualLeaveAdjustment, 'direction' | 'days'>): number {
  return a.direction === 'accrual' ? a.days : -a.days
}

// ── Output types ──────────────────────────────────────────────

export interface SettlementResult {
  statutory:        number                    // 법정연차 누적 (grants up to asOfYear + adjustments up to asOf)
  teamAccrued:      number                    // 팀 정당 적립 누적 (computeLedger.actualAccrued)
  totalEntitlement: number                    // max(statutory, teamAccrued)
  entitlementBasis: 'statutory' | 'team' | 'equal'
  totalUsed:        number                    // 총 유급 사용 (computeLedger.actualUsed)
  excess:           number                    // 초과 사용분 = max(0, totalUsed - totalEntitlement)
  shortfall:        number                    // 미달 보상분 = max(0, totalEntitlement - totalUsed)
  netSettlement:    number                    // shortfall - excess (+= 보상, -= 차감)
}

export interface TimesheetFigures {
  statutoryThisYear:     number   // ① 해당 역년 법정연차 누적치 (1/1 리셋)
  projectLeaveUsed:      number   // ② 프로젝트휴가 기 사용분
  designatedFromProject: number   // ③ 지정휴가 중 FIFO 차감 원천이 프로젝트휴가인 일수
  designatedShortfall:   number   // ④ 지정휴가 선사용분 (FIFO shortfall 합)
}

// ── computeSettlement ─────────────────────────────────────────

export function computeSettlement(
  asOfDate: string,   // YYYY-MM-DD
  opts: {
    grants:           Pick<AnnualLeaveGrant, 'year' | 'days'>[]
    adjustments:      Pick<AnnualLeaveAdjustment, 'date' | 'direction' | 'days'>[]
    teamActualAccrued: number   // from computeLedger(today=asOf).actualAccrued
    totalPaidUsed:    number    // from computeLedger(today=asOf).actualUsed
  },
): SettlementResult {
  const { grants, adjustments, teamActualAccrued, totalPaidUsed } = opts
  const asOfYear = parseInt(asOfDate.slice(0, 4), 10)

  const statutory = r1(
    grants
      .filter(g => g.year <= asOfYear)
      .reduce((s, g) => s + g.days, 0)
    + adjustments
        .filter(a => a.date <= asOfDate)
        .reduce((s, a) => s + adjContrib(a), 0),
  )

  const teamAccrued      = r1(teamActualAccrued)
  const totalEntitlement = r1(Math.max(statutory, teamAccrued))
  const entitlementBasis: SettlementResult['entitlementBasis'] =
    statutory > teamAccrued ? 'statutory' : teamAccrued > statutory ? 'team' : 'equal'

  const totalUsed    = r1(totalPaidUsed)
  const excess       = r1(Math.max(0, totalUsed - totalEntitlement))
  const shortfall    = r1(Math.max(0, totalEntitlement - totalUsed))
  const netSettlement = r1(shortfall - excess)

  return { statutory, teamAccrued, totalEntitlement, entitlementBasis, totalUsed, excess, shortfall, netSettlement }
}

// ── computeTimesheetFigures ───────────────────────────────────

export function computeTimesheetFigures(
  asOfDate: string,
  opts: {
    grants:      Pick<AnnualLeaveGrant, 'year' | 'days'>[]
    adjustments: Pick<AnnualLeaveAdjustment, 'date' | 'direction' | 'days'>[]
    usages:      LedgerUsageEntry[]
    accruals:    LedgerAccrualEntry[]
  },
): TimesheetFigures {
  const { grants, adjustments, usages, accruals } = opts
  const asOfYear  = parseInt(asOfDate.slice(0, 4), 10)
  const yearStart = `${asOfYear}-01-01`

  // ① 해당 역년 법정연차 누적치 (1/1 리셋, 이월 없음)
  const statutoryThisYear = r1(
    grants
      .filter(g => g.year === asOfYear)
      .reduce((s, g) => s + g.days, 0)
    + adjustments
        .filter(a => a.date >= yearStart && a.date <= asOfDate)
        .reduce((s, a) => s + adjContrib(a), 0),
  )

  // Accrual lookup by id — needed for ③
  const accrualById = new Map(accruals.map(a => [a.id, a]))

  // Usages on/before asOfDate (non-manual: use start date as proxy)
  const usagesOnOrBefore = usages.filter(u => u.start <= asOfDate)

  // ② 프로젝트휴가 기 사용분
  const projectLeaveUsed = r1(
    usagesOnOrBefore
      .filter(u => u.type === '프로젝트휴가')
      .reduce((s, u) => s + u.days, 0),
  )

  // ③ 지정휴가 사용 중 FIFO 차감 원천이 '프로젝트휴가'인 일수
  const designatedFromProject = r1(
    usagesOnOrBefore
      .filter(u => u.type === '지정휴가')
      .flatMap(u => u.deductions)
      .filter(d => accrualById.get(d.accrualId)?.type === '프로젝트휴가')
      .reduce((s, d) => s + d.days, 0),
  )

  // ④ 지정휴가 선사용분 (FIFO shortfall 합)
  const designatedShortfall = r1(
    usagesOnOrBefore
      .filter(u => u.type === '지정휴가' && !u.isManual)
      .reduce((s, u) => s + u.deficit, 0),
  )

  return { statutoryThisYear, projectLeaveUsed, designatedFromProject, designatedShortfall }
}
