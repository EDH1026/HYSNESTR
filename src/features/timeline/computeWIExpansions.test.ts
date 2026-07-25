import { describe, it, expect } from 'vitest'
import { computeWIExpansions } from './TimelineView'
import type { WorkItem } from '@/types'

// E-5 (PRD v2.116): work item 범위를 벗어나는 배정 변경 계산 — 경고+확인 흐름의 판정 로직.
// 이 함수는 순수 계산만 담당한다(실제 mutation은 applyWIExpansions가 확인 후 수행).

function workItem(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: 'wi1', type: 'project', name: 'Test Project',
    start: '2026-03-01', main_start: '2026-03-01', end_date: '2026-03-31',
    engagement_number: 'E-1', temp_engagement_code: null,
    engagement_code_splits: null,
    client: null, hashtags: [], status: 'open', description: null, confidential: false,
    ...overrides,
  }
}

describe('computeWIExpansions (E-5)', () => {
  it('assignment fully within the work item range → no expansion', () => {
    const wi = workItem()
    const map = new Map([[wi.id, wi]])
    const result = computeWIExpansions(
      [{ kind: 'work', work_item_id: wi.id, newStart: '2026-03-05', newEnd: '2026-03-10' }],
      map,
    )
    expect(result).toEqual([])
  })

  it('assignment starts before the work item → patch.start only', () => {
    const wi = workItem()
    const map = new Map([[wi.id, wi]])
    const result = computeWIExpansions(
      [{ kind: 'work', work_item_id: wi.id, newStart: '2026-02-20', newEnd: '2026-03-10' }],
      map,
    )
    expect(result).toEqual([{ wiId: wi.id, wi, patch: { start: '2026-02-20' } }])
  })

  it('assignment ends after the work item → patch.end_date only', () => {
    const wi = workItem()
    const map = new Map([[wi.id, wi]])
    const result = computeWIExpansions(
      [{ kind: 'work', work_item_id: wi.id, newStart: '2026-03-05', newEnd: '2026-04-15' }],
      map,
    )
    expect(result).toEqual([{ wiId: wi.id, wi, patch: { end_date: '2026-04-15' } }])
  })

  it('assignment exceeds both edges → both patch fields', () => {
    const wi = workItem()
    const map = new Map([[wi.id, wi]])
    const result = computeWIExpansions(
      [{ kind: 'work', work_item_id: wi.id, newStart: '2026-02-15', newEnd: '2026-04-15' }],
      map,
    )
    expect(result).toEqual([{ wiId: wi.id, wi, patch: { start: '2026-02-15', end_date: '2026-04-15' } }])
  })

  it('multiple assignments against the same work item collapse to one min-start/max-end patch', () => {
    const wi = workItem()
    const map = new Map([[wi.id, wi]])
    const result = computeWIExpansions(
      [
        { kind: 'work', work_item_id: wi.id, newStart: '2026-02-20', newEnd: '2026-03-10' },
        { kind: 'work', work_item_id: wi.id, newStart: '2026-03-05', newEnd: '2026-04-20' },
      ],
      map,
    )
    expect(result).toEqual([{ wiId: wi.id, wi, patch: { start: '2026-02-20', end_date: '2026-04-20' } }])
  })

  it('leave-kind items and items with no work_item_id are ignored', () => {
    const wi = workItem()
    const map = new Map([[wi.id, wi]])
    const result = computeWIExpansions(
      [
        { kind: 'leave', work_item_id: wi.id, newStart: '2026-01-01', newEnd: '2026-05-01' },
        { kind: 'work', work_item_id: null, newStart: '2026-01-01', newEnd: '2026-05-01' },
        { kind: 'work', work_item_id: undefined, newStart: '2026-01-01', newEnd: '2026-05-01' },
      ],
      map,
    )
    expect(result).toEqual([])
  })

  it('closed work items never expand, even when the assignment is out of range', () => {
    const wi = workItem({ status: 'closed' })
    const map = new Map([[wi.id, wi]])
    const result = computeWIExpansions(
      [{ kind: 'work', work_item_id: wi.id, newStart: '2026-01-01', newEnd: '2026-05-01' }],
      map,
    )
    expect(result).toEqual([])
  })

  it('legacy project_status is honored when status is unset (closed)', () => {
    const wi = workItem({ status: null as unknown as undefined, project_status: 'closed' })
    const map = new Map([[wi.id, wi]])
    const result = computeWIExpansions(
      [{ kind: 'work', work_item_id: wi.id, newStart: '2026-01-01', newEnd: '2026-05-01' }],
      map,
    )
    expect(result).toEqual([])
  })

  it('multiple different work items produce separate expansion entries', () => {
    const wi1 = workItem({ id: 'wi1', start: '2026-03-01', end_date: '2026-03-31' })
    const wi2 = workItem({ id: 'wi2', start: '2026-05-01', end_date: '2026-05-31' })
    const map = new Map([[wi1.id, wi1], [wi2.id, wi2]])
    const result = computeWIExpansions(
      [
        { kind: 'work', work_item_id: wi1.id, newStart: '2026-02-20', newEnd: '2026-03-10' },
        { kind: 'work', work_item_id: wi2.id, newStart: '2026-05-05', newEnd: '2026-06-10' },
      ],
      map,
    )
    expect(result).toEqual([
      { wiId: wi1.id, wi: wi1, patch: { start: '2026-02-20' } },
      { wiId: wi2.id, wi: wi2, patch: { end_date: '2026-06-10' } },
    ])
  })

  it('unknown work_item_id (not in map) is silently skipped', () => {
    const map = new Map<string, WorkItem>()
    const result = computeWIExpansions(
      [{ kind: 'work', work_item_id: 'missing', newStart: '2026-01-01', newEnd: '2026-01-05' }],
      map,
    )
    expect(result).toEqual([])
  })
})
