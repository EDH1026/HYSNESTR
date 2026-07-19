/**
 * Accrual (휴가 적립) data-access hooks.
 *
 * RLS: accruals_select — visible via person view-permission or self-view.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { supabase } from '@/lib/supabase'
import { queryKeys } from '@/lib/queryKeys'
import {
  toAccrual,
  toAssignment,
  toWorkItem,
  type CreateAccrualInput,
  type UpdateAccrualInput,
} from '@/lib/mappers'
import type { Accrual, Assignment, WorkItem } from '@/types'

// ── Queries ───────────────────────────────────────────────────

/** All accruals visible to the current user (usually filtered by person below). */
export function useAllAccruals() {
  return useQuery({
    queryKey: queryKeys.accruals.all(),
    queryFn: async (): Promise<Accrual[]> => {
      const { data, error } = await supabase
        .from('accruals')
        .select('*')
        .order('date', { ascending: false })
      if (error) throw error
      return (data ?? []).map(toAccrual)
    },
  })
}

/** Accruals for a specific person, sorted newest-first (FIFO display). */
export function useAccrualsByPerson(personId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.accruals.byPerson(personId ?? ''),
    enabled: !!personId,
    queryFn: async (): Promise<Accrual[]> => {
      const { data, error } = await supabase
        .from('accruals')
        .select('*')
        .eq('person_id', personId!)
        .order('date', { ascending: false })
      if (error) throw error
      return (data ?? []).map(toAccrual)
    },
  })
}

/**
 * PRD v2.100 LV-17: source data for computeLedger(), via get_leave_ledger_data() RPC —
 * always the same for a given target person regardless of the caller's role (bypasses
 * the assignments/work_items pipeline-visibility and accruals self-only RLS restrictions
 * that are correct for general screens but must not affect ledger math). The RPC itself
 * enforces who may ask for whom: admin/editor/assistant may pass any person_id(s) or
 * 'all', viewer may only request their own (enforced server-side, not just by this hook).
 */
export interface LedgerSourceData {
  assignments: Assignment[]
  accruals:    Accrual[]
  workItems:   WorkItem[]
}

export function useLedgerData(personIds: string[] | 'all' | undefined) {
  return useQuery({
    queryKey: queryKeys.ledgerData.forPeople(personIds ?? []),
    enabled:  personIds !== undefined && (personIds === 'all' || personIds.length > 0),
    queryFn: async (): Promise<LedgerSourceData> => {
      const p_person_ids = personIds === 'all' ? null : personIds
      // Cast: RPC not yet in generated database.ts (see CLAUDE.md regen note).
      const { data, error } = await (supabase.rpc as any)('get_leave_ledger_data', { p_person_ids })
      if (error) throw error
      return {
        assignments: (data.assignments as unknown[]).map(toAssignment as (r: unknown) => Assignment),
        accruals:    (data.accruals    as unknown[]).map(toAccrual    as (r: unknown) => Accrual),
        workItems:   (data.work_items  as unknown[]).map(toWorkItem   as (r: unknown) => WorkItem),
      }
    },
  })
}

// ── Mutations ─────────────────────────────────────────────────

export function useCreateAccrual() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (input: CreateAccrualInput): Promise<Accrual> => {
      const { data, error } = await supabase
        .from('accruals')
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .insert(input as any)
        .select()
        .single()
      if (error) throw error
      return toAccrual(data)
    },
    onSuccess: accrual => {
      qc.invalidateQueries({ queryKey: queryKeys.accruals.all() })
      qc.invalidateQueries({ queryKey: queryKeys.accruals.byPerson(accrual.person_id) })
      // PRD v2.100 LV-17: ledgerData embeds accruals — keep it in sync.
      qc.invalidateQueries({ queryKey: ['ledgerData'] })
    },
  })
}

export function useUpdateAccrual() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({
      id,
      ...patch
    }: UpdateAccrualInput & { id: string }): Promise<Accrual> => {
      const { data, error } = await supabase
        .from('accruals')
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .update(patch as any)
        .eq('id', id)
        .select()
        .single()
      if (error) throw error
      return toAccrual(data)
    },
    onSuccess: accrual => {
      qc.invalidateQueries({ queryKey: queryKeys.accruals.all() })
      qc.invalidateQueries({ queryKey: queryKeys.accruals.byPerson(accrual.person_id) })
      // PRD v2.100 LV-17: ledgerData embeds accruals — keep it in sync.
      qc.invalidateQueries({ queryKey: ['ledgerData'] })
    },
  })
}

export function useDeleteAccrual(personId?: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (id: string): Promise<string> => {
      const { error } = await supabase.from('accruals').delete().eq('id', id)
      if (error) throw error
      return id
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.accruals.all() })
      if (personId) qc.invalidateQueries({ queryKey: queryKeys.accruals.byPerson(personId) })
      // PRD v2.100 LV-17: ledgerData embeds accruals — keep it in sync.
      qc.invalidateQueries({ queryKey: ['ledgerData'] })
    },
  })
}
