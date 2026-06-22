/**
 * Holiday data-access hooks.
 *
 * RLS: holidays_select — all authenticated users can read (needed for
 * timeline shading and workday calculations).
 * Mutations require global edit permission (editor role or admin).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { supabase } from '@/lib/supabase'
import { queryKeys } from '@/lib/queryKeys'
import {
  toHoliday,
  type CreateHolidayInput,
  type UpdateHolidayInput,
} from '@/lib/mappers'
import type { Holiday, Settings, LeaveTypeRecord } from '@/types'

// ── Settings ──────────────────────────────────────────────────

const DEFAULT_SETTINGS: Settings = { fiscal_year_start_month: 7 }

export function useSettings() {
  return useQuery({
    queryKey: queryKeys.settings.get(),
    queryFn: async (): Promise<Settings> => {
      const { data, error } = await supabase
        .from('settings')
        .select('fiscal_year_start_month')
        .single()
      if (error) return DEFAULT_SETTINGS   // table not yet migrated: fall back
      return {
        fiscal_year_start_month: (data as any)?.fiscal_year_start_month ?? 7,
      }
    },
    staleTime: 1000 * 60 * 10,
  })
}

export function useUpdateSettings() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (patch: Partial<Settings>): Promise<Settings> => {
      const { data, error } = await (supabase as any)
        .from('settings')
        .update(patch)
        .eq('id', 1)
        .select('fiscal_year_start_month')
        .single()
      if (error) throw error
      return { fiscal_year_start_month: (data as any)?.fiscal_year_start_month ?? 7 }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.settings.get() })
    },
  })
}

// ── Queries ───────────────────────────────────────────────────

/** All holidays, sorted by date. */
export function useAllHolidays() {
  return useQuery({
    queryKey: queryKeys.holidays.all(),
    queryFn: async (): Promise<Holiday[]> => {
      const { data, error } = await supabase
        .from('holidays')
        .select('*')
        .order('date')
      if (error) throw error
      return (data ?? []).map(toHoliday)
    },
    // Holidays rarely change; keep them in cache longer.
    staleTime: 1000 * 60 * 5,
  })
}

// ── Leave types (PRD v2.4 §5.6) ──────────────────────────────

const LEAVE_TYPES_FALLBACK: LeaveTypeRecord[] = [
  { name: '리프레시',      active: true, sort_order: 1 },
  { name: '지정휴가',      active: true, sort_order: 2 },
  { name: '프로젝트휴가',  active: true, sort_order: 3 },
  { name: '주말/휴일대체', active: true, sort_order: 4 },
  { name: '포상휴가',      active: true, sort_order: 5 },
  { name: '특별휴가',      active: true, sort_order: 6 },
  { name: '지연보상',      active: true, sort_order: 7 },
  { name: '휴직',          active: true, sort_order: 8 },
]

/** Fetches leave type master rows ordered by sort_order.
 *  Falls back to static list if the table doesn't exist yet (migration pending). */
export function useLeaveTypes() {
  return useQuery({
    queryKey: queryKeys.leaveTypes.all(),
    queryFn: async (): Promise<LeaveTypeRecord[]> => {
      const { data, error } = await (supabase as any)
        .from('leave_types')
        .select('name, active, sort_order')
        .order('sort_order')
      if (error) return LEAVE_TYPES_FALLBACK
      return (data ?? []) as LeaveTypeRecord[]
    },
    staleTime: 1000 * 60 * 10,
  })
}

export function useUpdateLeaveType() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ name, active }: { name: string; active: boolean }) => {
      const { error } = await (supabase as any)
        .from('leave_types')
        .update({ active })
        .eq('name', name)
      if (error) throw error
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.leaveTypes.all() })
    },
  })
}

// ── Mutations ─────────────────────────────────────────────────

export function useCreateHoliday() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (input: CreateHolidayInput): Promise<Holiday> => {
      const { data, error } = await supabase
        .from('holidays')
        .insert(input)
        .select()
        .single()
      if (error) throw error
      return toHoliday(data)
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.holidays.all() })
    },
  })
}

export function useUpdateHoliday() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({
      id,
      ...patch
    }: UpdateHolidayInput & { id: string }): Promise<Holiday> => {
      const { data, error } = await supabase
        .from('holidays')
        .update(patch)
        .eq('id', id)
        .select()
        .single()
      if (error) throw error
      return toHoliday(data)
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.holidays.all() })
    },
  })
}

export function useDeleteHoliday() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (id: string): Promise<string> => {
      const { error } = await supabase.from('holidays').delete().eq('id', id)
      if (error) throw error
      return id
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.holidays.all() })
    },
  })
}
