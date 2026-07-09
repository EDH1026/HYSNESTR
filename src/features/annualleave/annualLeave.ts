/**
 * §5.13 Annual Leave computation — pure functions, no side effects.
 *
 * computeAnnualLeaveSettlement — 퇴사 정산 (AL-3~AL-5, AL-6 뷰·AL-10 HTML 내보내기 공용)
 *   후보 (a) = statutory + weekendSubAccrued
 *   후보 (b) = teamAccrued
 *   totalEntitlement = max(a, b)  ← 두 후보를 더하지 않음
 *   excess    = max(0, totalUsed - totalEntitlement)
 *   shortfall = max(0, totalEntitlement - totalUsed)
 *
 * computeTimesheetFigures — 타임시트 판단용 4개 수치 (①~④)
 */

import type { LedgerAccrualEntry, LedgerUsageEntry } from '@/features/leave/ledger'
import type { AnnualLeaveGrant, AnnualLeaveAdjustment } from '@/types'

// ── Shared helpers ────────────────────────────────────────────

function r1(n: number): number {
  return Math.round(n * 10) / 10
}

/** direction='accrual' → +days, direction='usage' → -days */
function adjContrib(a: Pick<AnnualLeaveAdjustment, 'direction' | 'days'>): number {
  return a.direction === 'accrual' ? a.days : -a.days
}

// ── Output types ──────────────────────────────────────────────

export interface AnnualLeaveSettlementResult {
  statutory:            number   // 법정연차 누적 = grants(≤asOfYear 합) + adjustments(≤asOf 합)
  weekendSub:           number   // 주말/휴일대체 누적 적립 합
  statutoryPlusWeekend: number   // statutory + weekendSub = 후보 (a)
  teamAccrued:          number   // 팀 정당 적립 누적 = computeLedger.actualAccrued = 후보 (b)
  totalEntitlement:     number   // max(a, b) — 두 후보를 더하지 않음
  entitlementBasis:     'statutory+weekend' | 'team' | 'equal'
  totalUsed:            number   // 총 유급 사용 = computeLedger.actualUsed
  excess:               number   // 초과 사용분 = max(0, totalUsed − totalEntitlement)
  shortfall:            number   // 미달 보상분 = max(0, totalEntitlement − totalUsed)
  netSettlement:        number   // shortfall − excess  (+= 보상 / −= 차감)
}

export interface TimesheetFigures {
  statutoryThisYear:     number   // ① 해당 역년 법정연차 누적치 (1/1 리셋, 이월 없음)
  projectLeaveUsed:      number   // ② 프로젝트휴가 기 사용분
  designatedFromProject: number   // ③ 지정휴가 중 FIFO 차감 원천이 프로젝트휴가인 일수
  designatedShortfall:   number   // ④ 지정휴가 선사용분 (FIFO shortfall 합)
}

// ── computeAnnualLeaveSettlement (AL-3~AL-5) ─────────────────
// 공용 유틸: AL-6 퇴사 정산 뷰와 AL-10 HTML 내보내기가 이 함수를 공유한다.

export function computeAnnualLeaveSettlement(
  asOfDate: string,   // YYYY-MM-DD
  opts: {
    grants:              Pick<AnnualLeaveGrant, 'year' | 'days'>[]
    adjustments:         Pick<AnnualLeaveAdjustment, 'date' | 'direction' | 'days'>[]
    weekendSubAccrued?:  number   // 주말/휴일대체 누적 합; 생략 시 0
    teamActualAccrued:   number   // computeLedger(today=asOf).actualAccrued
    totalPaidUsed:       number   // computeLedger(today=asOf).actualUsed
  },
): AnnualLeaveSettlementResult {
  const { grants, adjustments, weekendSubAccrued = 0, teamActualAccrued, totalPaidUsed } = opts
  const asOfYear = parseInt(asOfDate.slice(0, 4), 10)

  // 법정연차 누적 = 연도별 grants 합 + 기준일까지 adjustments 합
  const statutory = r1(
    grants
      .filter(g => g.year <= asOfYear)
      .reduce((s, g) => s + g.days, 0)
    + adjustments
        .filter(a => a.date <= asOfDate)
        .reduce((s, a) => s + adjContrib(a), 0),
  )

  const weekendSub           = r1(weekendSubAccrued)
  const statutoryPlusWeekend = r1(statutory + weekendSub)    // 후보 (a)
  const teamAccrued          = r1(teamActualAccrued)         // 후보 (b)

  // AL-3: 총 휴가 권리 = max(a, b) — 두 후보를 더하지 않음
  const totalEntitlement = r1(Math.max(statutoryPlusWeekend, teamAccrued))
  const entitlementBasis: AnnualLeaveSettlementResult['entitlementBasis'] =
    statutoryPlusWeekend > teamAccrued ? 'statutory+weekend'
    : teamAccrued > statutoryPlusWeekend ? 'team'
    : 'equal'

  const totalUsed     = r1(totalPaidUsed)
  const excess        = r1(Math.max(0, totalUsed - totalEntitlement))    // AL-4
  const shortfall     = r1(Math.max(0, totalEntitlement - totalUsed))    // AL-5
  const netSettlement = r1(shortfall - excess)

  return {
    statutory, weekendSub, statutoryPlusWeekend,
    teamAccrued, totalEntitlement, entitlementBasis,
    totalUsed, excess, shortfall, netSettlement,
  }
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

  // Usages on/before asOfDate
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
