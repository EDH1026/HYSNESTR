/**
 * Mapper utilities
 *
 * 1. snake_case ↔ camelCase key converters (generic, for external adapters /
 *    backup-restore / display labels)
 * 2. Per-entity normalizers — Supabase may return null for NOT NULL DEFAULT '{}'
 *    array columns; these ensure the app always receives proper empty arrays.
 * 3. Mutation input types — Omit auto-generated DB fields (id, created_at, …)
 *    so callers only pass the fields they own.
 */

import type { Person, WorkItem, Assignment, Accrual, Holiday, Rank, PersonStatus } from '@/types'
import type { Database } from '@/types/database'

// ── 1. Key-case converters ────────────────────────────────────

export function snakeToCamel(s: string): string {
  return s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())
}

export function camelToSnake(s: string): string {
  return s.replace(/[A-Z]/g, c => `_${c.toLowerCase()}`)
}

/** Recursively converts all object keys from snake_case to camelCase. */
export function keysToCamel<T>(val: T): T {
  if (Array.isArray(val))
    return val.map(keysToCamel) as unknown as T
  if (val !== null && typeof val === 'object')
    return Object.fromEntries(
      Object.entries(val as Record<string, unknown>).map(([k, v]) => [
        snakeToCamel(k),
        keysToCamel(v),
      ]),
    ) as T
  return val
}

/** Recursively converts all object keys from camelCase to snake_case. */
export function keysToSnake<T>(val: T): T {
  if (Array.isArray(val))
    return val.map(keysToSnake) as unknown as T
  if (val !== null && typeof val === 'object')
    return Object.fromEntries(
      Object.entries(val as Record<string, unknown>).map(([k, v]) => [
        camelToSnake(k),
        keysToSnake(v),
      ]),
    ) as T
  return val
}

// ── 2. Per-entity row normalizers ─────────────────────────────
// Raw DB types (Row from Database)
type RawWorkItem   = Database['public']['Tables']['work_items']['Row']
type RawAssignment = Database['public']['Tables']['assignments']['Row']

export function toPerson(row: Database['public']['Tables']['people']['Row']): Person {
  // database.ts is regenerated after migrations; cast extended columns until then.
  const r = row as typeof row & {
    lpn?: string | null
    hire_date?: string | null
    termination_date?: string | null
    status?: string | null
  }
  return {
    id:               r.id,
    name:             r.name,
    rank:             r.rank as Person['rank'],
    role:             r.role ?? '',
    lpn:              r.lpn ?? null,
    hire_date:        r.hire_date ?? null,
    termination_date: r.termination_date ?? null,
    status:           (r.status ?? 'active') as Person['status'],
  }
}

export function toWorkItem(row: RawWorkItem): WorkItem {
  const r = row as typeof row & {
    status?:         string | null
    project_status?: string | null
    description?:    string | null
    confidential?:   boolean | null
  }
  return {
    id:                r.id,
    type:              r.type as WorkItem['type'],
    name:              r.name,
    start:             r.start,
    main_start:        r.main_start,
    end_date:          r.end_date,
    engagement_number: r.engagement_number,
    client:            r.client,
    hashtags:          r.hashtags ?? [],
    status:            (r.status ?? 'open') as WorkItem['status'],
    project_status:    (r.project_status ?? null) as WorkItem['project_status'],
    description:       r.description ?? null,
    confidential:      r.confidential ?? false,
  }
}

export function toAssignment(row: RawAssignment): Assignment {
  return {
    id:            row.id,
    person_id:     row.person_id,
    kind:          row.kind as Assignment['kind'],
    work_item_id:  row.work_item_id,
    weekend_dates: row.weekend_dates ?? [],
    leave_type:    row.leave_type as Assignment['leave_type'],
    start:         row.start,
    end_date:      row.end_date,
    note:          row.note,
  }
}

export function toAccrual(
  row: Database['public']['Tables']['accruals']['Row'],
): Accrual {
  const r = row as typeof row & { direction?: 'accrual' | 'usage' | null }
  return {
    id:        row.id,
    person_id: row.person_id,
    type:      row.type as Accrual['type'],
    days:      row.days,
    date:      row.date,
    source:    row.source,
    note:      row.note,
    direction: r.direction ?? 'accrual',
  }
}

export function toHoliday(
  row: Database['public']['Tables']['holidays']['Row'],
): Holiday {
  const r = row as typeof row & { source?: 'auto' | 'manual' | null }
  return {
    id:        row.id,
    name:      row.name,
    date:      row.date,
    recurring: row.recurring,
    source:    r.source ?? 'manual',
  }
}

// ── 3. Mutation input types ───────────────────────────────────
// Fields the caller must/can supply; id + timestamps are DB-generated.

export type CreatePersonInput = {
  name:              string
  rank:              Rank
  role:              string
  lpn?:              string | null
  hire_date?:        string | null
  termination_date?: string | null
  status?:           PersonStatus
}
export type UpdatePersonInput = Partial<CreatePersonInput>

export type CreateWorkItemInput = Omit<WorkItem, 'id'>
export type UpdateWorkItemInput = Partial<Omit<WorkItem, 'id'>>

export type CreateAssignmentInput = Omit<Assignment, 'id'>
export type UpdateAssignmentInput = Partial<Omit<Assignment, 'id'>>

export type CreateAccrualInput = Omit<Accrual, 'id'>
export type UpdateAccrualInput = Partial<Omit<Accrual, 'id'>>

export type CreateHolidayInput = Omit<Holiday, 'id' | 'source'>
export type UpdateHolidayInput = Partial<Omit<Holiday, 'id' | 'source'>>
