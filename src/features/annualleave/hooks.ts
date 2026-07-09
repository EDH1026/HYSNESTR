/**
 * Data-access hooks for §5.13 annual leave tables.
 * RLS: editor/admin only (viewer is fully blocked at DB level).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase }   from '@/lib/supabase'
import { queryKeys }  from '@/lib/queryKeys'
import type { AnnualLeaveGrant, AnnualLeaveAdjustment } from '@/types'

// ── annual_leave_grants ───────────────────────────────────────

export function useGrantsByPerson(personId: string | null) {
  return useQuery({
    queryKey:  queryKeys.annualLeave.grants(personId ?? ''),
    enabled:   !!personId,
    queryFn: async (): Promise<AnnualLeaveGrant[]> => {
      const { data, error } = await (supabase as any)
        .from('annual_leave_grants')
        .select('*')
        .eq('person_id', personId!)
        .order('year', { ascending: true })
      if (error) throw error
      return data ?? []
    },
  })
}

export function useUpsertGrant() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (input: {
      id?:        string
      person_id:  string
      year:       number
      days:       number
      note:       string | null
      grant_type?: 'first_year_monthly' | 'annual'
    }): Promise<AnnualLeaveGrant> => {
      const { id, ...rest } = input
      let res
      if (id) {
        res = await (supabase as any)
          .from('annual_leave_grants')
          .update(rest)
          .eq('id', id)
          .select()
          .single()
      } else {
        res = await (supabase as any)
          .from('annual_leave_grants')
          .insert(rest)
          .select()
          .single()
      }
      if (res.error) throw res.error
      return res.data
    },
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: queryKeys.annualLeave.grants(vars.person_id) })
      logAudit('upsert', 'annual_leave_grants', vars.id ?? 'new')
    },
  })
}

export function useDeleteGrant() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ id, personId }: { id: string; personId: string }) => {
      const { error } = await (supabase as any)
        .from('annual_leave_grants')
        .delete()
        .eq('id', id)
      if (error) throw error
      return { id, personId }
    },
    onSuccess: ({ personId }) => {
      qc.invalidateQueries({ queryKey: queryKeys.annualLeave.grants(personId) })
    },
  })
}

// ── annual_leave_adjustments ──────────────────────────────────

export function useAdjustmentsByPerson(personId: string | null) {
  return useQuery({
    queryKey: queryKeys.annualLeave.adjustments(personId ?? ''),
    enabled:  !!personId,
    queryFn: async (): Promise<AnnualLeaveAdjustment[]> => {
      const { data, error } = await (supabase as any)
        .from('annual_leave_adjustments')
        .select('*')
        .eq('person_id', personId!)
        .order('date', { ascending: true })
      if (error) throw error
      return data ?? []
    },
  })
}

export function useCreateAdjustment() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (input: {
      person_id: string
      direction: 'accrual' | 'usage'
      days: number
      date: string
      note: string | null
    }): Promise<AnnualLeaveAdjustment> => {
      const { data, error } = await (supabase as any)
        .from('annual_leave_adjustments')
        .insert(input)
        .select()
        .single()
      if (error) throw error
      return data
    },
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: queryKeys.annualLeave.adjustments(vars.person_id) })
      logAudit('create', 'annual_leave_adjustments', _data.id)
    },
  })
}

export function useDeleteAdjustment() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ id, personId }: { id: string; personId: string }) => {
      const { error } = await (supabase as any)
        .from('annual_leave_adjustments')
        .delete()
        .eq('id', id)
      if (error) throw error
      return { id, personId }
    },
    onSuccess: ({ personId }) => {
      qc.invalidateQueries({ queryKey: queryKeys.annualLeave.adjustments(personId) })
    },
  })
}

// ── Audit helper (fire-and-forget) ───────────────────────────

function logAudit(action: string, table: string, targetId: string) {
  void (supabase as any).from('audit_log').insert({
    action, target_type: table, target_id: targetId, at: new Date().toISOString(),
  })
}
