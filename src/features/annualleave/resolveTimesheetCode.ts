/**
 * resolveTimesheetCode — AL-11 일자별 타임시트 코드 판정 (pure function)
 *
 * 우선순위:
 * 1. 공휴일 → "휴일"
 * 2. 무급휴가(리프레시·휴직) → "무급휴가"
 * 3. 주말/휴일대체 사용일 → "유급휴가" (TSG-17③, v2.115 — 원천 코드는 더 이상 표시하지 않는다.
 *    LV-8 FIFO 차감 원천 자체는 ledger.ts/computeLedger에서 그대로 계산·보존되며 이 표시
 *    단순화와 무관하다)
 * 4. 특별휴가 → "특별휴가"
 * 5. 프로젝트휴가·포상·지연보상·지정휴가 → A vs S 비교 (AL-7 ②③④ 재사용)
 *    A≥S → "유급휴가" (TSG-17③). A<S → 가장 최근 engagement code(①과 동일하게 detail 병기)
 * 6. 프로젝트 배정 → engagement_number (없으면 provisional flag)
 *    Partner + 다중 프로젝트 배정: daily_hours 기준 분할 (TSG-14, PRD v2.78)
 *    engagement_code_splits 설정 시: 그 project 시간을 코드별 비율로 재분할 (W-10, PRD v2.114)
 *    코드 오기 방지용 [클라이언트]작업항목명을 detail로 병기 (TSG-17①, v2.115)
 * 7. 제안 배정 → 배정된 Partner의 nbd_code, [담당 파트너명]을 detail로 병기 (TSG-17②, v2.115)
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
  detail?:      string    // TSG-17: 코드 오기 방지용 식별 정보 — [클라이언트]작업항목명 또는 [담당 파트너명]
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

  // Priority 3: 주말/휴일대체 — TSG-17③: 원천 code 대신 "유급휴가"로 표시.
  // LV-8 FIFO 차감 원천(ctx.ledger.usages[].deductions)은 computeLedger가 별도로 계산·보존하며,
  // 여기서는 그 값을 더 이상 표시용으로 조회하지 않는다.
  if (onDate.some(a => a.kind === 'leave' && a.leave_type === '주말/휴일대체')) {
    return [{ code: '유급휴가' }]
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

    // TSG-17③: 잔여 범위 내 사용(A≥S)은 "유급휴가"로 단순 표기.
    if (A >= S) return [{ code: '유급휴가' }]

    // A<S: 휴가가 아니라 "가장 최근 engagement code"로 대체 — TSG-17①과 동일하게 detail 병기.
    const recentWi = mostRecentEngagementWorkItem(ctx.assignments, ctx.workItems, dateStr)
    return recentWi
      ? [{ code: recentWi.engagement_number!, detail: projectDetail(recentWi) }]
      : [{ code: '유급휴가' }]
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
    // null = 미설정 → single-project fallback / 0 or positive = 명시적 분할 설정
    const withHours = projectAsgns.filter(a => a.daily_hours != null)

    // Project(s) present but none have explicit hours → full 8 h on first project
    if (projectAsgns.length > 0 && withHours.length === 0) {
      const wi = ctx.workItems.find(w => w.id === projectAsgns[0].work_item_id)!
      if (wi.engagement_code_splits?.length) {
        return splitByCodeRatio(8, wi.engagement_code_splits).map(r => ({ ...r, detail: projectDetail(wi) }))
      }
      if (wi.engagement_number)    return [{ code: wi.engagement_number, detail: projectDetail(wi) }]
      if (wi.temp_engagement_code) return [{ code: wi.temp_engagement_code, detail: projectDetail(wi), provisional: true }]
      return [{ code: '(코드 미정)', provisional: true }]
    }

    // Split path: project rows by daily_hours + NBD remainder
    // When withHours is empty (no projects at all), remaining = 8 → all-NBD day
    const results: TimesheetCodeResult[] = []
    let totalH = 0
    for (const wa of withHours) {
      if ((wa.daily_hours ?? 0) <= 0) continue  // daily_hours=0 → 해당 프로젝트 0h, NBD에 귀속
      const wi = ctx.workItems.find(w => w.id === wa.work_item_id)!
      // W-10: 이 project에 코드 비율 배분이 설정돼 있으면 daily_hours를 다시 비율대로 세분화 (TSG-14②)
      if (wi.engagement_code_splits?.length) {
        results.push(...splitByCodeRatio(wa.daily_hours!, wi.engagement_code_splits).map(r => ({ ...r, detail: projectDetail(wi) })))
      } else {
        const code = wi.engagement_number ?? (wi.temp_engagement_code ?? '(코드 미정)')
        const detail = (wi.engagement_number || wi.temp_engagement_code) ? projectDetail(wi) : undefined
        results.push({ code, hours: wa.daily_hours!, provisional: wi.engagement_number ? undefined : true, detail })
      }
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
      // W-10: 코드 비율 배분이 설정된 project는 그날 기록 시간(기본 8h, daily_hours 설정 시 그 값)을
      // 비율대로 나눠 코드별 별도 행으로 반환한다 (TSG-1⑥).
      if (wi.engagement_code_splits?.length) {
        return splitByCodeRatio(workAsgn.daily_hours ?? 8, wi.engagement_code_splits).map(r => ({ ...r, detail: projectDetail(wi) }))
      }
      if (wi.engagement_number)    return [{ code: wi.engagement_number, detail: projectDetail(wi) }]
      if (wi.temp_engagement_code) return [{ code: wi.temp_engagement_code, detail: projectDetail(wi), provisional: true }]
      return [{ code: '(코드 미정)', provisional: true }]
    }
    if (wi?.type === 'proposal') {
      // TSG-17②: 담당 파트너별 코드-이름 쌍을 각각 나란히 병기한다 — 코드만 먼저 나열하고
      // 이름들을 뒤에 뭉뚱그려 붙이지 않는다. code 필드 자체는(스냅샷 dedup 키로도 쓰이므로)
      // 기존과 동일한 콤마 join 값을 유지하고, 파트너 이름 병기는 detail에만 담는다.
      const partners = ctx.allPeople
        .filter(p => p.rank === 'Partner')
        .filter(p =>
          ctx.allAssignments.some(a =>
            a.work_item_id === wi.id && a.person_id === p.id && a.kind === 'work'
          )
        )
        .filter((p): p is typeof p & { nbd_code: string } => !!p.nbd_code)

      if (partners.length) {
        return [{
          code:   partners.map(p => p.nbd_code).join(', '),
          detail: partners.map(p => `${p.nbd_code}[${p.name}]`).join(', '),
        }]
      }
      return [{ code: '(NBD코드 없음)', provisional: true }]
    }
  }

  // Priority 8: unassigned
  return [{ code: 'unassigned' }]
}

// ── Internal helpers ──────────────────────────────────────────

/** TSG-17①: project 코드 오기 방지용 식별 정보 — "[클라이언트]작업항목명". client가 없으면 제목만. */
function projectDetail(wi: WorkItem): string {
  return wi.client ? `[${wi.client}]${wi.name}` : wi.name
}

/**
 * W-10: totalHours를 engagement_code_splits의 percent 비율대로 나눈다.
 * 마지막 항목은 (총합 − 이전 항목들의 합)으로 계산해, 반올림 오차 없이
 * 합계가 totalHours와 정확히 일치하도록 보정한다.
 */
function splitByCodeRatio(
  totalHours: number,
  splits:     NonNullable<WorkItem['engagement_code_splits']>,
): TimesheetCodeResult[] {
  const results: TimesheetCodeResult[] = []
  let allocated = 0
  splits.forEach((s, i) => {
    const isLast = i === splits.length - 1
    const hours = isLast
      ? Math.round((totalHours - allocated) * 100) / 100
      : Math.round((totalHours * s.percent / 100) * 100) / 100
    results.push({ code: s.code, hours })
    allocated += hours
  })
  return results
}

function mostRecentEngagementWorkItem(
  assignments: Assignment[],
  workItems:   WorkItem[],
  asOf:        string,
): WorkItem | null {
  const candidates = [...assignments]
    .filter(a => a.kind === 'work' && a.work_item_id && a.start <= asOf)
    .sort((a, b) => b.start.localeCompare(a.start) || b.end_date.localeCompare(a.end_date))

  for (const a of candidates) {
    const wi = workItems.find(w => w.id === a.work_item_id)
    if (wi?.type === 'project' && wi.engagement_number) return wi
  }
  return null
}
