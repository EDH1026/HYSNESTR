/**
 * resolveTimesheetCode — AL-11 일자별 타임시트 코드 판정 (pure function)
 *
 * 우선순위:
 * 1. 공휴일 → "휴일"
 * 2. 무급휴가(리프레시·휴직) → "무급휴가"
 * 3. 주말/휴일대체 사용일 → LV-8 FIFO 차감 원천 engagement code
 * 4. 특별휴가 → "특별휴가"
 * 5. 프로젝트휴가·포상·지연보상·지정휴가 → A vs S 비교 (AL-7 ②③④ 재사용)
 * 6. 프로젝트 배정 → engagement_number (없으면 provisional flag)
 *    Partner + 다중 프로젝트 배정: daily_hours 기준 분할 (TSG-14, PRD v2.78)
 * 7. 제안 배정 → 배정된 Partner의 nbd_code
 * 8. 그 외 → "unassigned"
 *
 * 반환: TimesheetCodeResult[] (항상 배열)
 *   단일 코드면 길이 1, Partner 다중 분할이면 길이 ≥2
 */

import { dateToNum } from '@/lib/date'
import { computeTimesheetFigures } from './annualLeave'
import type { Ledger } from '@/features/leave/ledger'
import type { Person, Assignment, WorkItem, AnnualLeaveAdjustment } from '@/types'

// ── Output type ───────────────────────────────────────────────

export interface TimesheetCodeResult {
  code:         string
  provisional?: boolean   // "대체 코드(추후 정정)" flag
  hours?:       number    // undefined → caller treats as 8h
}

// ── Context ───────────────────────────────────────────────────

export interface ResolveContext {
  allPeople:      Person[]
  assignments:    Assignment[]        // this person's assignments only
  allAssignments: Assignment[]        // all people's assignments (proposal partner lookup)
  workItems:      WorkItem[]
  isHoliday:      (n: number) => boolean
  ledger:         Ledger
  adjustments:    AnnualLeaveAdjustment[]  // this person's AL-2d adjustments
  hireDate:       string | null
}

// ── Constants ─────────────────────────────────────────────────

const VACATION_TYPES = new Set([
  '프로젝트휴가', '포상휴가', '지연보상', '지정휴가', '종료 후 잔여 소진',
])

// ── Main function ─────────────────────────────────────────────

export function resolveTimesheetCode(
  _person: Person,
  dateStr: string,
  ctx:     ResolveContext,
): TimesheetCodeResult[] {
  const dayNum = dateToNum(dateStr)

  // Priority 1: Holiday
  if (ctx.isHoliday(dayNum)) return [{ code: '휴일' }]

  // Assignments covering this date
  const onDate = ctx.assignments.filter(a =>
    dateToNum(a.start) <= dayNum && dayNum <= dateToNum(a.end_date)
  )

  // Priority 2: Unpaid leave
  if (onDate.some(a => a.kind === 'leave' && (a.leave_type === '리프레시' || a.leave_type === '휴직'))) {
    return [{ code: '무급휴가' }]
  }

  // Priority 3: 주말/휴일대체
  const weekendSub = onDate.find(a => a.kind === 'leave' && a.leave_type === '주말/휴일대체')
  if (weekendSub) {
    const usage = ctx.ledger.usages.find(u => u.assignmentId === weekendSub.id)
    if (usage) {
      for (const d of usage.deductions) {
        if (d.sourceId) {
          const wi = ctx.workItems.find(w => w.id === d.sourceId)
          if (wi?.engagement_number) return [{ code: wi.engagement_number }]
        }
      }
    }
    return [{ code: '(주말대체 원천 미확인)', provisional: true }]
  }

  // Priority 4: 특별휴가
  if (onDate.some(a => a.kind === 'leave' && a.leave_type === '특별휴가')) {
    return [{ code: '특별휴가' }]
  }

  // Priority 5: vacation leave types — compare A (statutory) vs S (cumulative ②③④)
  const vacation = onDate.find(a => a.kind === 'leave' && a.leave_type && VACATION_TYPES.has(a.leave_type))
  if (vacation) {
    const asOfYear  = parseInt(dateStr.slice(0, 4), 10)
    const asOfMonth = parseInt(dateStr.slice(5, 7), 10)
    const fyLabel   = asOfMonth >= 7 ? asOfYear + 1 : asOfYear

    const figs = computeTimesheetFigures(dateStr, {
      hireDate:    ctx.hireDate ?? undefined,
      adjustments: ctx.adjustments,
      usages:      ctx.ledger.usages,
      accruals:    ctx.ledger.accruals,
      fyLabel,
    })

    const A = figs.statutoryThisYear
    const S = figs.projectLeaveUsed + figs.designatedFromProject + figs.designatedShortfall

    if (A >= S) return [{ code: '휴가' }]

    const code = mostRecentEngagementCode(ctx.assignments, ctx.workItems, dateStr)
    return code ? [{ code }] : [{ code: '휴가' }]
  }

  // Priority 6 & 7: work assignment
  const workAsgns = onDate.filter(a => a.kind === 'work')

  // ── Partner 통합 경로 (TSG-14 v2.80) ────────────────────────
  // 규칙:
  //   daily_hours 설정된 project → 각각 별도 코드-시간 행
  //   나머지(8h − 합계) → NBD로 보충 (proposal·미배정도 여기서 처리)
  //   project는 있되 daily_hours 없음 → 단일 경로(8h 전체)
  if (_person.rank === 'Partner') {
    const projectAsgns = workAsgns.filter(a => {
      const wi = ctx.workItems.find(w => w.id === a.work_item_id)
      return wi?.type === 'project'
    })
    const withHours = projectAsgns.filter(a => (a.daily_hours ?? 0) > 0)

    // Project(s) present but none have explicit hours → full 8 h on first project
    if (projectAsgns.length > 0 && withHours.length === 0) {
      const wi = ctx.workItems.find(w => w.id === projectAsgns[0].work_item_id)!
      if (wi.engagement_number)    return [{ code: wi.engagement_number }]
      if (wi.temp_engagement_code) return [{ code: wi.temp_engagement_code, provisional: true }]
      return [{ code: '(코드 미정)', provisional: true }]
    }

    // Split path: project rows by daily_hours + NBD remainder
    // When withHours is empty (no projects at all), remaining = 8 → all-NBD day
    const results: TimesheetCodeResult[] = []
    let totalH = 0
    for (const wa of withHours) {
      const wi = ctx.workItems.find(w => w.id === wa.work_item_id)!
      const code = wi.engagement_number ?? (wi.temp_engagement_code ?? '(코드 미정)')
      results.push({ code, hours: wa.daily_hours!, provisional: wi.engagement_number ? undefined : true })
      totalH += wa.daily_hours!
    }
    const remaining = Math.round((8 - totalH) * 10) / 10
    if (remaining > 0) {
      results.push({ code: _person.nbd_code ?? '(NBD코드 없음)', hours: remaining, provisional: _person.nbd_code ? undefined : true })
    }
    return results
  }

  // ── 비Partner 단일 배정 경로 ─────────────────────────────────
  const workAsgn = workAsgns[0]
  if (workAsgn?.work_item_id) {
    const wi = ctx.workItems.find(w => w.id === workAsgn.work_item_id)
    if (wi?.type === 'project') {
      if (wi.engagement_number)    return [{ code: wi.engagement_number }]
      if (wi.temp_engagement_code) return [{ code: wi.temp_engagement_code, provisional: true }]
      return [{ code: '(코드 미정)', provisional: true }]
    }
    if (wi?.type === 'proposal') {
      const partnerCodes = ctx.allPeople
        .filter(p => p.rank === 'Partner')
        .filter(p =>
          ctx.allAssignments.some(a =>
            a.work_item_id === wi.id && a.person_id === p.id && a.kind === 'work'
          )
        )
        .map(p => p.nbd_code)
        .filter((c): c is string => !!c)

      if (partnerCodes.length) return [{ code: partnerCodes.join(', ') }]
      return [{ code: '(NBD코드 없음)', provisional: true }]
    }
  }

  // Priority 8: unassigned
  return [{ code: 'unassigned' }]
}

// ── Internal helpers ──────────────────────────────────────────

function mostRecentEngagementCode(
  assignments: Assignment[],
  workItems:   WorkItem[],
  asOf:        string,
): string | null {
  const candidates = [...assignments]
    .filter(a => a.kind === 'work' && a.work_item_id && a.start <= asOf)
    .sort((a, b) => b.start.localeCompare(a.start) || b.end_date.localeCompare(a.end_date))

  for (const a of candidates) {
    const wi = workItems.find(w => w.id === a.work_item_id)
    if (wi?.type === 'project' && wi.engagement_number) return wi.engagement_number
  }
  return null
}
