/**
 * Factory functions that produce HistoryEntry objects for each mutation type.
 * Uses supabase and queryClient directly (not React hooks) so they can be
 * called from inside HistoryProvider undo/redo lambdas.
 */
import { supabase }    from '@/lib/supabase'
import { queryClient } from '@/lib/queryClient'
import { queryKeys }   from '@/lib/queryKeys'
import type { HistoryEntry } from '@/lib/history'
import type { Assignment, WorkItem, Person, Accrual } from '@/types'

// ── Combine ───────────────────────────────────────────────────
// Merge multiple HistoryEntry objects into one atomic Undo/Redo step.
// Undo runs entries in reverse order; Redo runs in original order.
export function combine(label: string, ...entries: HistoryEntry[]): HistoryEntry {
  return {
    label,
    undo: async () => { for (const e of [...entries].reverse()) await e.undo() },
    redo: async () => { for (const e of entries) await e.redo() },
  }
}

function inv(key: readonly unknown[]) {
  void queryClient.invalidateQueries({ queryKey: key as unknown[] })
}

// ── Assignment ────────────────────────────────────────────────

type AssignFields = {
  person_id:     string
  kind:          string
  work_item_id:  string | null
  leave_type:    string | null
  start:         string
  end_date:      string
  weekend_dates: string[]
  note:          string | null
}

function toAssignFields(a: Assignment): AssignFields {
  return {
    person_id:     a.person_id,
    kind:          a.kind,
    work_item_id:  a.work_item_id,
    leave_type:    a.leave_type,
    start:         a.start,
    end_date:      a.end_date,
    weekend_dates: a.weekend_dates,
    note:          a.note,
  }
}

export function makeAssignmentCreate(created: Assignment): HistoryEntry {
  const fields = toAssignFields(created)
  return {
    label: '배정 생성',
    undo: async () => {
      const { error } = await supabase.from('assignments').delete().eq('id', created.id)
      if (error) throw error
      inv(queryKeys.assignments.all())
    },
    redo: async () => {
      const { error } = await (supabase as any).from('assignments').insert({ id: created.id, ...fields })
      if (error) throw error
      inv(queryKeys.assignments.all())
    },
  }
}

export function makeAssignmentModalEdit(old: Assignment, newFields: AssignFields): HistoryEntry {
  const oldFields = toAssignFields(old)
  return {
    label: '배정 수정',
    undo: async () => {
      const { error } = await (supabase as any).from('assignments').update(oldFields).eq('id', old.id)
      if (error) throw error
      inv(queryKeys.assignments.all())
    },
    redo: async () => {
      const { error } = await (supabase as any).from('assignments').update(newFields).eq('id', old.id)
      if (error) throw error
      inv(queryKeys.assignments.all())
    },
  }
}

export interface DragPair {
  id:       string
  oldStart: string
  oldEnd:   string
  newStart: string
  newEnd:   string
}

export function makeAssignmentDrag(label: string, pairs: DragPair[]): HistoryEntry {
  return {
    label,
    undo: async () => {
      for (const p of pairs) {
        const { error } = await supabase.from('assignments')
          .update({ start: p.oldStart, end_date: p.oldEnd })
          .eq('id', p.id)
        if (error) throw error
      }
      inv(queryKeys.assignments.all())
    },
    redo: async () => {
      for (const p of pairs) {
        const { error } = await supabase.from('assignments')
          .update({ start: p.newStart, end_date: p.newEnd })
          .eq('id', p.id)
        if (error) throw error
      }
      inv(queryKeys.assignments.all())
    },
  }
}

export function makeAssignmentDelete(deleted: Assignment): HistoryEntry {
  const fields = toAssignFields(deleted)
  return {
    label: '배정 삭제',
    undo: async () => {
      const { error } = await (supabase as any).from('assignments').insert({ id: deleted.id, ...fields })
      if (error) throw error
      inv(queryKeys.assignments.all())
    },
    redo: async () => {
      const { error } = await supabase.from('assignments').delete().eq('id', deleted.id)
      if (error) throw error
      inv(queryKeys.assignments.all())
    },
  }
}

// ── Work Item ─────────────────────────────────────────────────

type WIFields = {
  type:              string
  name:              string
  start:             string
  main_start:        string | null
  end_date:          string
  engagement_number: string | null
  client:            string | null
  description:       string | null
  hashtags:          string[]
  confidential:      boolean
  status:            string
}

function toWIFields(w: WorkItem): WIFields {
  return {
    type:              w.type,
    name:              w.name,
    start:             w.start,
    main_start:        w.main_start ?? null,
    end_date:          w.end_date,
    engagement_number: w.engagement_number ?? null,
    client:            w.client ?? null,
    description:       w.description ?? null,
    hashtags:          w.hashtags,
    confidential:      w.confidential ?? false,
    status:            w.status ?? 'open',
  }
}

export function makeWorkItemCreate(created: WorkItem): HistoryEntry {
  const fields = toWIFields(created)
  return {
    label: `작업항목 생성 "${created.name}"`,
    undo: async () => {
      const { error } = await supabase.from('work_items').delete().eq('id', created.id)
      if (error) throw error
      inv(queryKeys.workItems.all())
      inv(queryKeys.assignments.all())
    },
    redo: async () => {
      const { error } = await (supabase as any).from('work_items').insert({ id: created.id, ...fields })
      if (error) throw error
      inv(queryKeys.workItems.all())
    },
  }
}

export function makeWorkItemUpdate(old: WorkItem, newPayload: Record<string, unknown>): HistoryEntry {
  const oldFields = toWIFields(old)
  return {
    label: `작업항목 수정 "${old.name}"`,
    undo: async () => {
      const { error } = await (supabase as any).from('work_items').update(oldFields).eq('id', old.id)
      if (error) throw error
      inv(queryKeys.workItems.all())
    },
    redo: async () => {
      const { error } = await (supabase as any).from('work_items').update(newPayload).eq('id', old.id)
      if (error) throw error
      inv(queryKeys.workItems.all())
    },
  }
}

export function makeWorkItemDelete(deleted: WorkItem): HistoryEntry {
  const fields = toWIFields(deleted)
  return {
    label: `작업항목 삭제 "${deleted.name}"`,
    undo: async () => {
      // cascaded assignment deletions are NOT restored
      const { error } = await (supabase as any).from('work_items').insert({ id: deleted.id, ...fields })
      if (error) throw error
      inv(queryKeys.workItems.all())
    },
    redo: async () => {
      const { error } = await supabase.from('work_items').delete().eq('id', deleted.id)
      if (error) throw error
      inv(queryKeys.workItems.all())
      inv(queryKeys.assignments.all())
    },
  }
}

// ── Person ────────────────────────────────────────────────────

type PersonFields = {
  name:             string
  rank:             string
  role:             string
  lpn:              string | null
  hire_date:        string | null
  termination_date: string | null
  // status is not persisted — computed at read time from hire_date/termination_date
}

function toPersonFields(p: Person): PersonFields {
  return {
    name:             p.name,
    rank:             p.rank,
    role:             p.role,
    lpn:              p.lpn,
    hire_date:        p.hire_date,
    termination_date: p.termination_date,
  }
}

export function makePersonCreate(created: Person): HistoryEntry {
  const fields = toPersonFields(created)
  return {
    label: `인력 생성 "${created.name}"`,
    undo: async () => {
      const { error } = await supabase.from('people').delete().eq('id', created.id)
      if (error) throw error
      inv(queryKeys.people.all())
    },
    redo: async () => {
      const { error } = await (supabase as any).from('people').insert({ id: created.id, ...fields })
      if (error) throw error
      inv(queryKeys.people.all())
    },
  }
}

export function makePersonUpdate(old: Person, newPayload: Record<string, unknown>): HistoryEntry {
  const oldFields = toPersonFields(old)
  return {
    label: `인력 수정 "${old.name}"`,
    undo: async () => {
      const { error } = await (supabase as any).from('people').update(oldFields).eq('id', old.id)
      if (error) throw error
      inv(queryKeys.people.all())
    },
    redo: async () => {
      const { error } = await (supabase as any).from('people').update(newPayload).eq('id', old.id)
      if (error) throw error
      inv(queryKeys.people.all())
    },
  }
}

export function makePersonDelete(deleted: Person): HistoryEntry {
  const fields = toPersonFields(deleted)
  return {
    label: `인력 삭제 "${deleted.name}"`,
    undo: async () => {
      const { error } = await (supabase as any).from('people').insert({ id: deleted.id, ...fields })
      if (error) throw error
      inv(queryKeys.people.all())
    },
    redo: async () => {
      const { error } = await supabase.from('people').delete().eq('id', deleted.id)
      if (error) throw error
      inv(queryKeys.people.all())
      inv(queryKeys.assignments.all())
      inv(queryKeys.accruals.all())
    },
  }
}

// ── Accrual ───────────────────────────────────────────────────

type AccrualFields = {
  person_id: string
  type:      string
  days:      number
  date:      string
  source:    string | null
  note:      string | null
  direction: string
}

function toAccrualFields(a: Accrual): AccrualFields {
  return {
    person_id: a.person_id,
    type:      a.type,
    days:      a.days,
    date:      a.date,
    source:    a.source,
    note:      a.note,
    direction: a.direction ?? 'accrual',
  }
}

export function makeAccrualCreate(created: Accrual): HistoryEntry {
  const fields = toAccrualFields(created)
  const label  = fields.direction === 'usage' ? '수동 차감 추가' : '수동 적립 추가'
  return {
    label,
    undo: async () => {
      const { error } = await supabase.from('accruals').delete().eq('id', created.id)
      if (error) throw error
      inv(queryKeys.accruals.all())
    },
    redo: async () => {
      const { error } = await (supabase as any).from('accruals').insert({ id: created.id, ...fields })
      if (error) throw error
      inv(queryKeys.accruals.all())
    },
  }
}

export function makeAccrualDelete(deleted: Accrual): HistoryEntry {
  const fields = toAccrualFields(deleted)
  const label  = fields.direction === 'usage' ? '수동 차감 삭제' : '수동 적립 삭제'
  return {
    label,
    undo: async () => {
      const { error } = await (supabase as any).from('accruals').insert({ id: deleted.id, ...fields })
      if (error) throw error
      inv(queryKeys.accruals.all())
    },
    redo: async () => {
      const { error } = await supabase.from('accruals').delete().eq('id', deleted.id)
      if (error) throw error
      inv(queryKeys.accruals.all())
    },
  }
}
