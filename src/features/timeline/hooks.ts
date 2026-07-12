/**
 * Assignment (배정) data-access hooks.
 *
 * RLS rules (assignments_select, migration 0005):
 *   - pipeline assignments: only visible to those with edit on the work_item
 *   - other assignments:    visible via person view-permission OR self-view
 *
 * The hooks are RLS-agnostic; filtering is entirely server-side.
 *
 * Optional filter parameters narrow the server query for performance,
 * but never widen the visibility beyond what RLS permits.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { supabase } from '@/lib/supabase'
import { queryKeys } from '@/lib/queryKeys'
import {
  toAssignment,
  type CreateAssignmentInput,
  type UpdateAssignmentInput,
} from '@/lib/mappers'
import type { Assignment } from '@/types'

// ── Queries ───────────────────────────────────────────────────

/** All assignments visible to the current user. */
export function useAllAssignments() {
  return useQuery({
    queryKey: queryKeys.assignments.all(),
    queryFn: async (): Promise<Assignment[]> => {
      const { data, error } = await supabase
        .from('assignments')
        .select('*')
        .order('start')
      if (error) throw error
      return (data ?? []).map(toAssignment)
    },
  })
}

/** Assignments for a specific person (RLS still filters pipeline). */
export function useAssignmentsByPerson(personId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.assignments.byPerson(personId ?? ''),
    enabled: !!personId,
    queryFn: async (): Promise<Assignment[]> => {
      const { data, error } = await supabase
        .from('assignments')
        .select('*')
        .eq('person_id', personId!)
        .order('start')
      if (error) throw error
      return (data ?? []).map(toAssignment)
    },
  })
}

/** Assignments attached to a specific work item. */
export function useAssignmentsByWorkItem(workItemId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.assignments.byWorkItem(workItemId ?? ''),
    enabled: !!workItemId,
    queryFn: async (): Promise<Assignment[]> => {
      const { data, error } = await supabase
        .from('assignments')
        .select('*')
        .eq('work_item_id', workItemId!)
        .order('start')
      if (error) throw error
      return (data ?? []).map(toAssignment)
    },
  })
}

// ── Mutations ─────────────────────────────────────────────────

export function useCreateAssignment() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (input: CreateAssignmentInput): Promise<Assignment> => {
      const { data, error } = await supabase
        .from('assignments')
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .insert({
          ...input,
          weekend_dates: input.weekend_dates ?? [],
        } as any)
        .select()
        .single()
      if (error) throw error
      return toAssignment(data)
    },
    onSuccess: asgn => {
      qc.invalidateQueries({ queryKey: queryKeys.assignments.all() })
      qc.invalidateQueries({ queryKey: queryKeys.assignments.byPerson(asgn.person_id) })
      if (asgn.work_item_id) {
        qc.invalidateQueries({
          queryKey: queryKeys.assignments.byWorkItem(asgn.work_item_id),
        })
      }
    },
  })
}

export function useUpdateAssignment() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({
      id,
      ...patch
    }: UpdateAssignmentInput & { id: string }): Promise<Assignment> => {
      const { data, error } = await supabase
        .from('assignments')
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .update(patch as any)
        .eq('id', id)
        .select()
        .single()
      if (error) throw error
      return toAssignment(data)
    },
    onSuccess: asgn => {
      qc.invalidateQueries({ queryKey: queryKeys.assignments.all() })
      qc.invalidateQueries({ queryKey: queryKeys.assignments.byPerson(asgn.person_id) })
      if (asgn.work_item_id) {
        qc.invalidateQueries({
          queryKey: queryKeys.assignments.byWorkItem(asgn.work_item_id),
        })
      }
    },
  })
}

export function useDeleteAssignment() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (id: string): Promise<string> => {
      const { error } = await supabase.from('assignments').delete().eq('id', id)
      if (error) throw error
      return id
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.assignments.all() })
      // Broad invalidation: we don't track personId/workItemId at this point
    },
  })
}
