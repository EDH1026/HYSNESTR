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
  type CreateAccrualInput,
  type UpdateAccrualInput,
} from '@/lib/mappers'
import type { Accrual } from '@/types'

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
    },
  })
}
