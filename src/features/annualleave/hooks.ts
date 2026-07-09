/**
 * Data-access hooks for §5.13 annual leave tables.
 * RLS: editor/admin only (viewer is fully blocked at DB level).
 *
 * annual_leave_grants 테이블은 v2.33에서 폐지됨.
 * 수동 보정(annual_leave_adjustments)만 유지.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase }   from '@/lib/supabase'
import { queryKeys }  from '@/lib/queryKeys'
import type { AnnualLeaveAdjustment } from '@/types'

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
