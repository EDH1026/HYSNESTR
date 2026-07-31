import { describe, it, expect } from 'vitest'
import { resolveTimesheetCode, type ResolveContext } from './resolveTimesheetCode'
import type { Person, Assignment, WorkItem } from '@/types'

// W-10 (PRD v2.114): project engagement 코드 비율 배분 — TSG-1⑥ / TSG-14②

function person(overrides: Partial<Person> = {}): Person {
  return {
    id: 'p1', name: 'Test Person', rank: 'Staff', role: 'Consultant',
    lpn: null, hire_date: null, termination_date: null, status: 'active',
    nbd_code: null,
    ...overrides,
  }
}

function workItem(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: 'wi1', type: 'project', name: 'Test Project',
    start: '2026-01-01', main_start: '2026-01-01', end_date: '2026-12-31',
    engagement_number: 'E-00000001', temp_engagement_code: null,
    engagement_code_splits: null,
    client: null, hashtags: [], status: 'open', description: null, confidential: false,
    ...overrides,
  }
}

function assignment(overrides: Partial<Assignment> = {}): Assignment {
  return {
    id: 'a1', person_id: 'p1', kind: 'work', work_item_id: 'wi1',
    weekend_dates: [], leave_type: null, start: '2026-01-01', end_date: '2026-12-31',
    note: null, daily_hours: null,
    ...overrides,
  }
}

function ctxFor(p: Person, assignments: Assignment[], workItems: WorkItem[], allAssignments = assignments): ResolveContext {
  return {
    allPeople: [p],
    assignments,
    allAssignments,
    workItems,
    isHoliday: () => false,
    ledger: {
      asOf: 0, accruals: [], usages: [], unpaid: [],
      totalAccrued: 0, totalUsed: 0, remaining: 0, byType: {},
      actualAccrued: 0, scheduledAccrued: 0, actualUsed: 0, scheduledUsed: 0,
      currentRemaining: 0, projectedRemaining: 0,
    },
    adjustments: [],
    hireDate: null,
  }
}

const DATE = '2026-03-02' // a Monday, not a holiday

describe('W-10 engagement_code_splits — non-Partner project path (TSG-1⑥)', () => {
  it('regression: no splits → single code, full day (hours undefined), no client → no detail', () => {
    const p = person({ rank: 'Staff' })
    const wi = workItem({ engagement_code_splits: null })
    const results = resolveTimesheetCode(p, DATE, ctxFor(p, [assignment()], [wi]))
    expect(results).toEqual([{ code: 'E-00000001' }])
  })

  it('splits 75/25 on an 8h day → 6h + 2h, exact sum, client detail on every split row', () => {
    const p = person({ rank: 'Staff' })
    const wi = workItem({ client: '삼성전자', engagement_code_splits: [{ code: 'A', percent: 75 }, { code: 'B', percent: 25 }] })
    const results = resolveTimesheetCode(p, DATE, ctxFor(p, [assignment()], [wi]))
    expect(results).toEqual([
      { code: 'A', hours: 6, detail: '삼성전자' },
      { code: 'B', hours: 2, detail: '삼성전자' },
    ])
    expect(results.reduce((s, r) => s + (r.hours ?? 0), 0)).toBe(8)
  })

  it('splits 75/25 with daily_hours=5 → 3.75 + 1.25, exact sum', () => {
    const p = person({ rank: 'Staff' })
    const wi = workItem({ engagement_code_splits: [{ code: 'A', percent: 75 }, { code: 'B', percent: 25 }] })
    const results = resolveTimesheetCode(p, DATE, ctxFor(p, [assignment({ daily_hours: 5 })], [wi]))
    expect(results).toEqual([
      { code: 'A', hours: 3.75 },
      { code: 'B', hours: 1.25 },
    ])
    expect(results.reduce((s, r) => s + (r.hours ?? 0), 0)).toBe(5)
  })

  it('three-way split with a repeating decimal percent still sums exactly', () => {
    const p = person({ rank: 'Staff' })
    const wi = workItem({
      engagement_code_splits: [
        { code: 'A', percent: 33.33 },
        { code: 'B', percent: 33.33 },
        { code: 'C', percent: 33.34 },
      ],
    })
    const results = resolveTimesheetCode(p, DATE, ctxFor(p, [assignment()], [wi]))
    expect(results.reduce((s, r) => s + (r.hours ?? 0), 0)).toBe(8)
    expect(results[results.length - 1]?.code).toBe('C') // last item absorbs the rounding remainder
  })
})

describe('W-10 engagement_code_splits — Partner multi-project path (TSG-14②)', () => {
  it('regression: Partner, single project, no daily_hours, no splits → full 8h single code', () => {
    const p = person({ id: 'partner1', rank: 'Partner' })
    const wi = workItem({ engagement_code_splits: null })
    const asgn = assignment({ id: 'a1', person_id: 'partner1' })
    const results = resolveTimesheetCode(p, DATE, ctxFor(p, [asgn], [wi]))
    expect(results).toEqual([{ code: 'E-00000001' }])
  })

  it('Partner, single project, no explicit daily_hours, splits set → full 8h split', () => {
    const p = person({ id: 'partner1', rank: 'Partner' })
    const wi = workItem({ engagement_code_splits: [{ code: 'A', percent: 75 }, { code: 'B', percent: 25 }] })
    const asgn = assignment({ id: 'a1', person_id: 'partner1' })
    const results = resolveTimesheetCode(p, DATE, ctxFor(p, [asgn], [wi]))
    expect(results).toEqual([
      { code: 'A', hours: 6 },
      { code: 'B', hours: 2 },
    ])
  })

  it('Partner, daily_hours=5 on a split project → 3.75 + 1.25, plus NBD remainder for the other 3h ' +
     '(remainder detail = "{본인 이름} NBD")', () => {
    const p = person({ id: 'partner1', rank: 'Partner', nbd_code: 'NBD-1', name: '김재승' })
    const wi = workItem({ engagement_code_splits: [{ code: 'A', percent: 75 }, { code: 'B', percent: 25 }] })
    const asgn = assignment({ id: 'a1', person_id: 'partner1', daily_hours: 5 })
    const results = resolveTimesheetCode(p, DATE, ctxFor(p, [asgn], [wi]))
    expect(results).toEqual([
      { code: 'A', hours: 3.75 },
      { code: 'B', hours: 1.25 },
      { code: 'NBD-1', hours: 3, provisional: undefined, detail: '김재승 NBD' },
    ])
    expect(results.reduce((s, r) => s + (r.hours ?? 0), 0)).toBe(8)
  })

  it('regression: Partner, daily_hours set, no splits → unchanged single-code-per-project + NBD remainder ' +
     '(remainder now carries "{본인 이름} NBD" detail)', () => {
    const p = person({ id: 'partner1', rank: 'Partner', nbd_code: 'NBD-1', name: '김재승' })
    const wi = workItem({ engagement_code_splits: null })
    const asgn = assignment({ id: 'a1', person_id: 'partner1', daily_hours: 5 })
    const results = resolveTimesheetCode(p, DATE, ctxFor(p, [asgn], [wi]))
    expect(results).toEqual([
      { code: 'E-00000001', hours: 5, provisional: undefined },
      { code: 'NBD-1', hours: 3, provisional: undefined, detail: '김재승 NBD' },
    ])
  })
})

describe('TSG-17 코드/부가정보 컬럼 분리 (PRD v2.115)', () => {
  it('① project code: code는 코드값만, detail은 클라이언트명만(작업항목명 없음). client 없으면 detail 없음', () => {
    const p = person({ rank: 'Staff' })
    const withClient = workItem({ client: '삼성전자', name: 'TV OS 경쟁사 조사' })
    const r1 = resolveTimesheetCode(p, DATE, ctxFor(p, [assignment()], [withClient]))
    expect(r1).toEqual([{ code: 'E-00000001', detail: '삼성전자' }])

    const noClient = workItem({ client: null, name: 'TV OS 경쟁사 조사' })
    const r2 = resolveTimesheetCode(p, DATE, ctxFor(p, [assignment()], [noClient]))
    expect(r2).toEqual([{ code: 'E-00000001' }])
  })

  it('TSG-19 ②③: 담당 파트너 2명인 proposal — 스태프의 8h가 4h+4h로 N등분, 파트너별 별도 행(콤마 join 폐지)', () => {
    const partner1 = person({ id: 'partner1', rank: 'Partner', nbd_code: 'NBD00123', name: '김재승' })
    const partner2 = person({ id: 'partner2', rank: 'Partner', nbd_code: 'NBD00456', name: '박정인' })
    const staff = person({ id: 'staff1', rank: 'Staff' })
    const proposal = workItem({ id: 'wiProp', type: 'proposal', name: 'Proposal X' })
    const asgnStaff  = assignment({ id: 'a1', person_id: 'staff1', work_item_id: 'wiProp' })
    const asgnP1     = assignment({ id: 'a2', person_id: 'partner1', work_item_id: 'wiProp' })
    const asgnP2     = assignment({ id: 'a3', person_id: 'partner2', work_item_id: 'wiProp' })
    const ctx: ResolveContext = {
      allPeople: [partner1, partner2, staff],
      assignments: [asgnStaff],
      allAssignments: [asgnStaff, asgnP1, asgnP2],
      workItems: [proposal],
      isHoliday: () => false,
      ledger: {
        asOf: 0, accruals: [], usages: [], unpaid: [],
        totalAccrued: 0, totalUsed: 0, remaining: 0, byType: {},
        actualAccrued: 0, scheduledAccrued: 0, actualUsed: 0, scheduledUsed: 0,
        currentRemaining: 0, projectedRemaining: 0,
      },
      adjustments: [],
      hireDate: null,
    }
    const results = resolveTimesheetCode(staff, DATE, ctx)
    expect(results).toEqual([
      { code: 'NBD00123', detail: '김재승 NBD', hours: 4 },
      { code: 'NBD00456', detail: '박정인 NBD', hours: 4 },
    ])
    expect(results.reduce((s, r) => s + (r.hours ?? 0), 0)).toBe(8)
    // 코드 값이 detail 안에 다시 등장하지 않아야 한다 (과거 버그: "I-00000000 파트너명" 식 중복)
    expect(results[0].detail).not.toContain('NBD00123')
    expect(results[1].detail).not.toContain('NBD00456')
    // 어느 한 행에도 다른 파트너와 콤마로 묶인 값이 없어야 한다
    for (const r of results) {
      expect(r.code).not.toContain(',')
      expect(r.detail).not.toContain(',')
    }
  })

  it('TSG-19: 담당 파트너 3명·나누어떨어지지 않는 7h → 세 행의 합이 정확히 7h(반올림 오차 없음)', () => {
    const partner1 = person({ id: 'partnerA', rank: 'Partner', nbd_code: 'NBD-A', name: 'A' })
    const partner2 = person({ id: 'partnerB', rank: 'Partner', nbd_code: 'NBD-B', name: 'B' })
    const partner3 = person({ id: 'partnerC', rank: 'Partner', nbd_code: 'NBD-C', name: 'C' })
    const staff = person({ id: 'staff1', rank: 'Staff' })
    const proposal = workItem({ id: 'wiProp', type: 'proposal' })
    const asgnStaff = assignment({ id: 'a1', person_id: 'staff1', work_item_id: 'wiProp', daily_hours: 7 })
    const asgnP1 = assignment({ id: 'a2', person_id: 'partnerA', work_item_id: 'wiProp' })
    const asgnP2 = assignment({ id: 'a3', person_id: 'partnerB', work_item_id: 'wiProp' })
    const asgnP3 = assignment({ id: 'a4', person_id: 'partnerC', work_item_id: 'wiProp' })
    const ctx: ResolveContext = {
      allPeople: [partner1, partner2, partner3, staff],
      assignments: [asgnStaff],
      allAssignments: [asgnStaff, asgnP1, asgnP2, asgnP3],
      workItems: [proposal],
      isHoliday: () => false,
      ledger: {
        asOf: 0, accruals: [], usages: [], unpaid: [],
        totalAccrued: 0, totalUsed: 0, remaining: 0, byType: {},
        actualAccrued: 0, scheduledAccrued: 0, actualUsed: 0, scheduledUsed: 0,
        currentRemaining: 0, projectedRemaining: 0,
      },
      adjustments: [],
      hireDate: null,
    }
    const results = resolveTimesheetCode(staff, DATE, ctx)
    expect(results).toHaveLength(3)
    expect(results.reduce((s, r) => s + (r.hours ?? 0), 0)).toBe(7)
    // 마지막(id 오름차순 partnerC)이 나머지를 흡수
    expect(results[2]).toEqual({ code: 'NBD-C', detail: 'C NBD', hours: 7 - 2 * (Math.round((7 / 3) * 100) / 100) })
  })

  it('TSG-19: 파트너/배정 배열 순서를 뒤섞어도 항상 id 오름차순으로 동일하게 분할된다(일관된 순서)', () => {
    const partner1 = person({ id: 'partner1', rank: 'Partner', nbd_code: 'NBD00123', name: '김재승' })
    const partner2 = person({ id: 'partner2', rank: 'Partner', nbd_code: 'NBD00456', name: '박정인' })
    const staff = person({ id: 'staff1', rank: 'Staff' })
    const proposal = workItem({ id: 'wiProp', type: 'proposal' })
    const asgnStaff = assignment({ id: 'a1', person_id: 'staff1', work_item_id: 'wiProp' })
    const asgnP1 = assignment({ id: 'a2', person_id: 'partner1', work_item_id: 'wiProp' })
    const asgnP2 = assignment({ id: 'a3', person_id: 'partner2', work_item_id: 'wiProp' })
    const ctx: ResolveContext = {
      // 입력 순서를 일부러 원래와 반대로 뒤섞는다 — id 정렬이 없으면 결과 순서/흡수 대상이 흔들려야 정상.
      allPeople: [staff, partner2, partner1],
      assignments: [asgnStaff],
      allAssignments: [asgnP2, asgnP1, asgnStaff],
      workItems: [proposal],
      isHoliday: () => false,
      ledger: {
        asOf: 0, accruals: [], usages: [], unpaid: [],
        totalAccrued: 0, totalUsed: 0, remaining: 0, byType: {},
        actualAccrued: 0, scheduledAccrued: 0, actualUsed: 0, scheduledUsed: 0,
        currentRemaining: 0, projectedRemaining: 0,
      },
      adjustments: [],
      hireDate: null,
    }
    const results = resolveTimesheetCode(staff, DATE, ctx)
    expect(results).toEqual([
      { code: 'NBD00123', detail: '김재승 NBD', hours: 4 },
      { code: 'NBD00456', detail: '박정인 NBD', hours: 4 },
    ])
  })

  it('regression: 담당 파트너가 1명뿐이면 분할 없이 그 한 명의 코드 전체로 기록된다', () => {
    const partner1 = person({ id: 'partner1', rank: 'Partner', nbd_code: 'NBD00123', name: '김재승' })
    const staff = person({ id: 'staff1', rank: 'Staff' })
    const proposal = workItem({ id: 'wiProp', type: 'proposal' })
    const asgnStaff = assignment({ id: 'a1', person_id: 'staff1', work_item_id: 'wiProp' })
    const asgnP1 = assignment({ id: 'a2', person_id: 'partner1', work_item_id: 'wiProp' })
    const ctx: ResolveContext = {
      allPeople: [partner1, staff],
      assignments: [asgnStaff],
      allAssignments: [asgnStaff, asgnP1],
      workItems: [proposal],
      isHoliday: () => false,
      ledger: {
        asOf: 0, accruals: [], usages: [], unpaid: [],
        totalAccrued: 0, totalUsed: 0, remaining: 0, byType: {},
        actualAccrued: 0, scheduledAccrued: 0, actualUsed: 0, scheduledUsed: 0,
        currentRemaining: 0, projectedRemaining: 0,
      },
      adjustments: [],
      hireDate: null,
    }
    const results = resolveTimesheetCode(staff, DATE, ctx)
    expect(results).toEqual([{ code: 'NBD00123', detail: '김재승 NBD', hours: 8 }])
  })

  it('TSG-19 ①: 담당 파트너 본인의 proposal 배정일은 분할되지 않고 본인 NBD 코드 전체로 기록된다', () => {
    const partner1 = person({ id: 'partner1', rank: 'Partner', nbd_code: 'NBD00123', name: '김재승' })
    const partner2 = person({ id: 'partner2', rank: 'Partner', nbd_code: 'NBD00456', name: '박정인' })
    const proposal = workItem({ id: 'wiProp', type: 'proposal' })
    // partner1 본인이 그 proposal에 배정된 날 — partner2도 담당 파트너로 함께 있지만 분할 대상 아님
    const asgnP1 = assignment({ id: 'a1', person_id: 'partner1', work_item_id: 'wiProp' })
    const asgnP2 = assignment({ id: 'a2', person_id: 'partner2', work_item_id: 'wiProp' })
    const ctx: ResolveContext = {
      allPeople: [partner1, partner2],
      assignments: [asgnP1],
      allAssignments: [asgnP1, asgnP2],
      workItems: [proposal],
      isHoliday: () => false,
      ledger: {
        asOf: 0, accruals: [], usages: [], unpaid: [],
        totalAccrued: 0, totalUsed: 0, remaining: 0, byType: {},
        actualAccrued: 0, scheduledAccrued: 0, actualUsed: 0, scheduledUsed: 0,
        currentRemaining: 0, projectedRemaining: 0,
      },
      adjustments: [],
      hireDate: null,
    }
    const results = resolveTimesheetCode(partner1, DATE, ctx)
    expect(results).toEqual([{ code: 'NBD00123', hours: 8, provisional: undefined, detail: '김재승 NBD' }])
  })

  it('② Partner 자동 NBD 잔여 시간(TSG-14②)도 "{본인 이름} NBD"로 부가정보 병기된다', () => {
    const p = person({ id: 'partner1', rank: 'Partner', nbd_code: 'NBD-99', name: '박정인' })
    const wi = workItem({ engagement_number: 'E-00000002' })
    const asgn = assignment({ id: 'a1', person_id: 'partner1', daily_hours: 6 })
    const results = resolveTimesheetCode(p, DATE, ctxFor(p, [asgn], [wi]))
    const nbdRow = results.find(r => r.code === 'NBD-99')
    expect(nbdRow).toEqual({ code: 'NBD-99', hours: 2, provisional: undefined, detail: '박정인 NBD' })
  })

  it('② nbd_code가 없는 Partner의 잔여 시간은 "(NBD코드 없음)"이고 detail도 없다', () => {
    const p = person({ id: 'partner1', rank: 'Partner', nbd_code: null, name: '박정인' })
    const wi = workItem({ engagement_number: 'E-00000002' })
    const asgn = assignment({ id: 'a1', person_id: 'partner1', daily_hours: 6 })
    const results = resolveTimesheetCode(p, DATE, ctxFor(p, [asgn], [wi]))
    const nbdRow = results.find(r => r.code === '(NBD코드 없음)')
    expect(nbdRow).toEqual({ code: '(NBD코드 없음)', hours: 2, provisional: true })
  })

  it('③ 무급휴가/유급휴가는 code만, detail 없음', () => {
    const p = person({ rank: 'Staff' })
    const unpaid = assignment({ kind: 'leave', leave_type: '리프레시' })
    expect(resolveTimesheetCode(p, DATE, ctxFor(p, [unpaid], []))).toEqual([{ code: '무급휴가' }])

    const weekendSub = assignment({ id: 'wsub', kind: 'leave', leave_type: '주말/휴일대체' })
    expect(resolveTimesheetCode(p, DATE, ctxFor(p, [weekendSub], []))).toEqual([{ code: '유급휴가' }])
  })

  it('③ 특별휴가는 code가 항상 "특별휴가"이고, 비고(note)는 별도 detail 컬럼에만 담긴다', () => {
    const p = person({ rank: 'Staff' })
    const withNote = assignment({ kind: 'leave', leave_type: '특별휴가', note: '예비군 훈련' })
    expect(resolveTimesheetCode(p, DATE, ctxFor(p, [withNote], []))).toEqual([{ code: '특별휴가', detail: '예비군 훈련' }])

    const noNote = assignment({ kind: 'leave', leave_type: '특별휴가', note: null })
    expect(resolveTimesheetCode(p, DATE, ctxFor(p, [noNote], []))).toEqual([{ code: '특별휴가' }])
  })

  it('① 미발급 대체 코드(temp_engagement_code)는 detail 끝에 "*대체"가 붙고, ' +
     '정식 코드가 있으면 붙지 않는다(둘 다 detail은 클라이언트명 기준)', () => {
    const p = person({ rank: 'Staff' })
    const tempOnly = workItem({
      engagement_number: null, temp_engagement_code: 'TEMP0007',
      client: '삼성전자', name: 'TV OS 경쟁사 조사',
    })
    const rTemp = resolveTimesheetCode(p, DATE, ctxFor(p, [assignment()], [tempOnly]))
    expect(rTemp).toEqual([{ code: 'TEMP0007', detail: '삼성전자 *대체', provisional: true }])

    const tempNoClient = workItem({
      engagement_number: null, temp_engagement_code: 'TEMP0007', client: null,
    })
    const rTempNoClient = resolveTimesheetCode(p, DATE, ctxFor(p, [assignment()], [tempNoClient]))
    expect(rTempNoClient).toEqual([{ code: 'TEMP0007', detail: '*대체', provisional: true }])

    const official = workItem({
      engagement_number: 'E-00012345', temp_engagement_code: 'TEMP0007', client: '삼성전자',
    })
    const rOfficial = resolveTimesheetCode(p, DATE, ctxFor(p, [assignment()], [official]))
    expect(rOfficial).toEqual([{ code: 'E-00012345', detail: '삼성전자' }])
  })

  it('④ 휴일/unassigned는 부가정보 없이 기존처럼 표시된다', () => {
    const p = person({ rank: 'Staff' })
    const ctx = ctxFor(p, [], [])
    expect(resolveTimesheetCode(p, DATE, { ...ctx, isHoliday: () => true })).toEqual([{ code: '휴일' }])
    expect(resolveTimesheetCode(p, DATE, ctx)).toEqual([{ code: 'unassigned' }])
  })
})
