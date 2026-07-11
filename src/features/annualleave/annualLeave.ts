/**
 * §5.13 Annual Leave computation — pure functions, no side effects.
 *
 * computeAnnualLeaveSettlement — 퇴사 정산 (AL-3~AL-5, AL-6 뷰·AL-10 HTML 내보내기 공용)
 *   법정연차: computeStatutoryLeave 순수 함수로 계산 (DB 적립 행 없음)
 *   후보 (a) = statutory + weekendSubAccrued + specialLeaveAccrued
 *   후보 (b) = teamAccrued
 *   totalEntitlement = max(a, b)
 *   excess    = max(0, totalUsed − totalEntitlement)
 *   shortfall = max(0, totalEntitlement − totalUsed)
 *
 * computeTimesheetFigures — 타임시트 판단용 4개 수치 (①~④)
 */

import type { LedgerAccrualEntry, LedgerUsageEntry } from '@/features/leave/ledger'
import type { AnnualLeaveAdjustment } from '@/types'
import {
  computeStatutoryLeave,
  sumStatutoryLeave,
  sumStatutoryLeaveFY,
} from './computeStatutoryLeave'
import type { StatutoryLeaveItem } from './computeStatutoryLeave'

// Re-export so callers don't need two imports
export type { StatutoryLeaveItem }

// ── Shared helpers ────────────────────────────────────────────

function r1(n: number): number {
  return Math.round(n * 10) / 10
}

function adjContrib(a: Pick<AnnualLeaveAdjustment, 'direction' | 'days'>): number {
  return a.direction === 'accrual' ? a.days : -a.days
}

// ── Output types ──────────────────────────────────────────────

export interface AnnualLeaveSettlementResult {
  // 법정연차 (순수 함수 계산)
  fiscalItems:         StatutoryLeaveItem[]   // 회계연도 기준 항목 목록
  anniversaryItems:    StatutoryLeaveItem[]   // 입사일 기준 항목 목록
  fiscalSubtotal:      number                 // 회계연도 기준 소계 (보정 전)
  anniversarySubtotal: number                 // 입사일 기준 소계 (보정 전)
  adjustmentsTotal:    number                 // 수동 보정 합계
  adoptedBasis:        'fiscal' | 'anniversary' | 'equal' | 'none'
  statutory:           number                 // max(fiscal,anniv) + adjustments

  // 기타 누적 항목
  weekendSub:   number
  specialLeave: number

  // 후보 합계
  candidateA:   number   // statutory + weekendSub + specialLeave
  teamAccrued:  number   // 팀 정당 적립 (후보 b)
  totalEntitlement: number   // max(a, b)
  entitlementBasis: 'candidateA' | 'team' | 'equal'

  // 정산
  totalUsed:    number
  excess:       number
  shortfall:    number
  netSettlement: number
}

export interface TimesheetFigures {
  statutoryThisYear:     number   // ① 해당 FY 법정연차 누적치 (7/1 리셋, 이월 없음)
  projectLeaveUsed:      number   // ② 프로젝트휴가 기 사용분 (기준일까지 누적)
  designatedFromProject: number   // ③ 지정휴가 중 FIFO 차감 원천이 프로젝트휴가인 일수 (누적)
  designatedShortfall:   number   // ④ 지정휴가 선사용분 (FIFO shortfall 합, 누적)
}

// ── computeAnnualLeaveSettlement (AL-3~AL-5) ─────────────────

export function computeAnnualLeaveSettlement(
  asOfDate: string,
  opts: {
    hireDate?:            string
    adjustments:          Pick<AnnualLeaveAdjustment, 'date' | 'direction' | 'days'>[]
    weekendSubAccrued?:   number
    specialLeaveAccrued?: number
    teamActualAccrued:    number
    totalPaidUsed:        number
  },
): AnnualLeaveSettlementResult {
  const {
    hireDate,
    adjustments,
    weekendSubAccrued = 0,
    specialLeaveAccrued = 0,
    teamActualAccrued,
    totalPaidUsed,
  } = opts

  const adjustmentsTotal = r1(
    adjustments
      .filter(a => a.date <= asOfDate)
      .reduce((s, a) => s + adjContrib(a), 0),
  )

  let fiscalItems:         StatutoryLeaveItem[] = []
  let anniversaryItems:    StatutoryLeaveItem[] = []
  let fiscalSubtotal     = 0
  let anniversarySubtotal = 0
  let adoptedBasis: AnnualLeaveSettlementResult['adoptedBasis'] = 'none'
  let statutory          = 0

  if (hireDate) {
    fiscalItems         = computeStatutoryLeave(hireDate, 'fiscal',      asOfDate)
    anniversaryItems    = computeStatutoryLeave(hireDate, 'anniversary', asOfDate)
    fiscalSubtotal      = r1(sumStatutoryLeave(fiscalItems))
    anniversarySubtotal = r1(sumStatutoryLeave(anniversaryItems))
    adoptedBasis        = fiscalSubtotal > anniversarySubtotal
      ? 'fiscal'
      : anniversarySubtotal > fiscalSubtotal
        ? 'anniversary'
        : 'equal'
    statutory = r1(Math.max(fiscalSubtotal, anniversarySubtotal) + adjustmentsTotal)
  } else {
    statutory = adjustmentsTotal
  }

  const weekendSub   = r1(weekendSubAccrued)
  const specialLeave = r1(specialLeaveAccrued)
  const candidateA   = r1(statutory + weekendSub + specialLeave)
  const teamAccrued  = r1(teamActualAccrued)

  const totalEntitlement = r1(Math.max(candidateA, teamAccrued))
  const entitlementBasis: AnnualLeaveSettlementResult['entitlementBasis'] =
    candidateA > teamAccrued ? 'candidateA'
    : teamAccrued > candidateA ? 'team'
    : 'equal'

  const totalUsed    = r1(totalPaidUsed)
  const excess       = r1(Math.max(0, totalUsed - totalEntitlement))
  const shortfall    = r1(Math.max(0, totalEntitlement - totalUsed))
  const netSettlement = r1(shortfall - excess)

  return {
    fiscalItems, anniversaryItems,
    fiscalSubtotal, anniversarySubtotal, adjustmentsTotal,
    adoptedBasis, statutory,
    weekendSub, specialLeave, candidateA,
    teamAccrued, totalEntitlement, entitlementBasis,
    totalUsed, excess, shortfall, netSettlement,
  }
}

// ── computeTimesheetFigures ───────────────────────────────────

export function computeTimesheetFigures(
  asOfDate: string,
  opts: {
    hireDate?:   string
    adjustments: Pick<AnnualLeaveAdjustment, 'date' | 'direction' | 'days'>[]
    usages:      LedgerUsageEntry[]
    accruals:    LedgerAccrualEntry[]
  },
): TimesheetFigures {
  const { hireDate, adjustments, usages, accruals } = opts
  const asOfYear  = parseInt(asOfDate.slice(0, 4), 10)
  const asOfMonth = parseInt(asOfDate.slice(5, 7), 10)

  // FY 기준: month>=7 → FY starts this July; month<7 → FY started last July
  const fyStartYear = asOfMonth >= 7 ? asOfYear : asOfYear - 1
  const fyStart     = `${fyStartYear}-07-01`

  // ① 해당 FY 법정연차 누적치 (7/1 리셋, 이월 없음)
  //   hireDate 있으면 pure function; 없으면 FY 기간 내 adjustments만 집계
  const probationAndAnnual = hireDate ? sumStatutoryLeaveFY(hireDate, asOfDate) : 0
  const fyAdjustments = r1(
    adjustments
      .filter(a => a.date >= fyStart && a.date <= asOfDate)
      .reduce((s, a) => s + adjContrib(a), 0),
  )
  const statutoryThisYear = r1(probationAndAnnual + fyAdjustments)

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

  // ④ 지정휴가 선사용분: LV-12 running balance 기준 — 마지막 지정휴가 사용 시점의 잔액이 음수면 그 절댓값
  const jieongEntries = usagesOnOrBefore
    .filter(u => u.type === '지정휴가' && !u.isManual && u.days > 0)
    .sort((a, b) => a.end.localeCompare(b.end) || a.start.localeCompare(b.start))
  const designatedShortfall = r1(
    jieongEntries.length > 0 ? Math.max(0, -jieongEntries[jieongEntries.length - 1].deficit) : 0,
  )

  return { statutoryThisYear, projectLeaveUsed, designatedFromProject, designatedShortfall }
}
