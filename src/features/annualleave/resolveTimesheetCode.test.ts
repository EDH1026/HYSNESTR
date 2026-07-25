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
  it('regression: no splits → single code, full day (hours undefined)', () => {
    const p = person({ rank: 'Staff' })
    const wi = workItem({ engagement_code_splits: null })
    const results = resolveTimesheetCode(p, DATE, ctxFor(p, [assignment()], [wi]))
    expect(results).toEqual([{ code: 'E-00000001', detail: 'Test Project' }])
  })

  it('splits 75/25 on an 8h day → 6h + 2h, exact sum', () => {
    const p = person({ rank: 'Staff' })
    const wi = workItem({ engagement_code_splits: [{ code: 'A', percent: 75 }, { code: 'B', percent: 25 }] })
    const results = resolveTimesheetCode(p, DATE, ctxFor(p, [assignment()], [wi]))
    expect(results).toEqual([
      { code: 'A', hours: 6, detail: 'Test Project' },
      { code: 'B', hours: 2, detail: 'Test Project' },
    ])
    expect(results.reduce((s, r) => s + (r.hours ?? 0), 0)).toBe(8)
  })

  it('splits 75/25 with daily_hours=5 → 3.75 + 1.25, exact sum', () => {
    const p = person({ rank: 'Staff' })
    const wi = workItem({ engagement_code_splits: [{ code: 'A', percent: 75 }, { code: 'B', percent: 25 }] })
    const results = resolveTimesheetCode(p, DATE, ctxFor(p, [assignment({ daily_hours: 5 })], [wi]))
    expect(results).toEqual([
      { code: 'A', hours: 3.75, detail: 'Test Project' },
      { code: 'B', hours: 1.25, detail: 'Test Project' },
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
    expect(results).toEqual([{ code: 'E-00000001', detail: 'Test Project' }])
  })

  it('Partner, single project, no explicit daily_hours, splits set → full 8h split', () => {
    const p = person({ id: 'partner1', rank: 'Partner' })
    const wi = workItem({ engagement_code_splits: [{ code: 'A', percent: 75 }, { code: 'B', percent: 25 }] })
    const asgn = assignment({ id: 'a1', person_id: 'partner1' })
    const results = resolveTimesheetCode(p, DATE, ctxFor(p, [asgn], [wi]))
    expect(results).toEqual([
      { code: 'A', hours: 6, detail: 'Test Project' },
      { code: 'B', hours: 2, detail: 'Test Project' },
    ])
  })

  it('Partner, daily_hours=5 on a split project → 3.75 + 1.25, plus NBD remainder for the other 3h', () => {
    const p = person({ id: 'partner1', rank: 'Partner', nbd_code: 'NBD-1' })
    const wi = workItem({ engagement_code_splits: [{ code: 'A', percent: 75 }, { code: 'B', percent: 25 }] })
    const asgn = assignment({ id: 'a1', person_id: 'partner1', daily_hours: 5 })
    const results = resolveTimesheetCode(p, DATE, ctxFor(p, [asgn], [wi]))
    expect(results).toEqual([
      { code: 'A', hours: 3.75, detail: 'Test Project' },
      { code: 'B', hours: 1.25, detail: 'Test Project' },
      { code: 'NBD-1', hours: 3, provisional: undefined },
    ])
    expect(results.reduce((s, r) => s + (r.hours ?? 0), 0)).toBe(8)
  })

  it('regression: Partner, daily_hours set, no splits → unchanged single-code-per-project + NBD remainder', () => {
    const p = person({ id: 'partner1', rank: 'Partner', nbd_code: 'NBD-1' })
    const wi = workItem({ engagement_code_splits: null })
    const asgn = assignment({ id: 'a1', person_id: 'partner1', daily_hours: 5 })
    const results = resolveTimesheetCode(p, DATE, ctxFor(p, [asgn], [wi]))
    expect(results).toEqual([
      { code: 'E-00000001', hours: 5, provisional: undefined, detail: 'Test Project' },
      { code: 'NBD-1', hours: 3, provisional: undefined },
    ])
  })
})

describe('TSG-17 코드 오기 방지용 식별 정보 병기 (PRD v2.115)', () => {
  it('① project code: detail은 [client]작업항목명, client 없으면 작업항목명만', () => {
    const p = person({ rank: 'Staff' })
    const withClient = workItem({ client: '삼성전자', name: 'TV OS 경쟁사 조사' })
    const r1 = resolveTimesheetCode(p, DATE, ctxFor(p, [assignment()], [withClient]))
    expect(r1).toEqual([{ code: 'E-00000001', detail: '[삼성전자]TV OS 경쟁사 조사' }])

    const noClient = workItem({ client: null, name: 'TV OS 경쟁사 조사' })
    const r2 = resolveTimesheetCode(p, DATE, ctxFor(p, [assignment()], [noClient]))
    expect(r2).toEqual([{ code: 'E-00000001', detail: 'TV OS 경쟁사 조사' }])
  })

  it('② proposal NBD code: 복수 파트너면 코드-이름이 정확히 짝지어 병기된다', () => {
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
    expect(results).toEqual([{
      code:   'NBD00123, NBD00456',
      detail: 'NBD00123[김재승], NBD00456[박정인]',
    }])
  })

  it('③ 휴가 유형은 코드·detail 없이 단순 라벨만 반환한다', () => {
    const p = person({ rank: 'Staff' })
    const unpaid = assignment({ kind: 'leave', leave_type: '리프레시' })
    expect(resolveTimesheetCode(p, DATE, ctxFor(p, [unpaid], []))).toEqual([{ code: '무급휴가' }])

    const special = assignment({ kind: 'leave', leave_type: '특별휴가' })
    expect(resolveTimesheetCode(p, DATE, ctxFor(p, [special], []))).toEqual([{ code: '특별휴가' }])

    const weekendSub = assignment({ id: 'wsub', kind: 'leave', leave_type: '주말/휴일대체' })
    const ctx = ctxFor(p, [weekendSub], [])
    expect(resolveTimesheetCode(p, DATE, ctx)).toEqual([{ code: '유급휴가' }])
  })

  it('③ 특별휴가는 비고(note)가 있으면 유형명 뒤에 괄호로 병기, 없으면 유형명만', () => {
    const p = person({ rank: 'Staff' })
    const withNote = assignment({ kind: 'leave', leave_type: '특별휴가', note: '예비군 훈련' })
    expect(resolveTimesheetCode(p, DATE, ctxFor(p, [withNote], []))).toEqual([{ code: '특별휴가(예비군 훈련)' }])

    const noNote = assignment({ kind: 'leave', leave_type: '특별휴가', note: null })
    expect(resolveTimesheetCode(p, DATE, ctxFor(p, [noNote], []))).toEqual([{ code: '특별휴가' }])
  })

  it('① 미발급 대체 코드(temp_engagement_code)는 detail 끝에 "*대체"가 붙고, ' +
     '정식 코드가 있으면 붙지 않는다', () => {
    const p = person({ rank: 'Staff' })
    const tempOnly = workItem({
      engagement_number: null, temp_engagement_code: 'TEMP0007',
      client: '삼성전자', name: 'TV OS 경쟁사 조사',
    })
    const rTemp = resolveTimesheetCode(p, DATE, ctxFor(p, [assignment()], [tempOnly]))
    expect(rTemp).toEqual([{
      code: 'TEMP0007', detail: '[삼성전자]TV OS 경쟁사 조사 *대체', provisional: true,
    }])

    const official = workItem({
      engagement_number: 'E-00012345', temp_engagement_code: 'TEMP0007',
      client: '삼성전자', name: 'TV OS 경쟁사 조사',
    })
    const rOfficial = resolveTimesheetCode(p, DATE, ctxFor(p, [assignment()], [official]))
    expect(rOfficial).toEqual([{
      code: 'E-00012345', detail: '[삼성전자]TV OS 경쟁사 조사',
    }])
  })

  it('④ 휴일/unassigned는 병기 없이 기존처럼 표시된다', () => {
    const p = person({ rank: 'Staff' })
    const ctx = ctxFor(p, [], [])
    expect(resolveTimesheetCode(p, DATE, { ...ctx, isHoliday: () => true })).toEqual([{ code: '휴일' }])
    expect(resolveTimesheetCode(p, DATE, ctx)).toEqual([{ code: 'unassigned' }])
  })
})
