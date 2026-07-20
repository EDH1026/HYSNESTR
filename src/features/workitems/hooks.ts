/**
 * Work-items data-access hooks.
 *
 * RLS rules (work_items_select, migration 0005):
 *   - project / proposal: visible to anyone with view permission
 *   - pipeline: visible only to those with edit permission
 * The hooks are type-agnostic; RLS decides what rows come back.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { supabase } from '@/lib/supabase'
import { queryKeys } from '@/lib/queryKeys'
import { fetchAllRows } from '@/lib/fetchAll'
import {
  toWorkItem,
  type CreateWorkItemInput,
  type UpdateWorkItemInput,
} from '@/lib/mappers'
import type { WorkItem, WorkItemType } from '@/types'

// ── Queries ───────────────────────────────────────────────────

// All read hooks use work_items_safe (PRD §5.6 / 부록 B.3):
// - editor/admin: gets real field values (my_role() in view returns their role)
// - viewer:       gets masked values for confidential rows
// Mutation hooks still write to work_items directly.

/** All work items via work_items_safe — confidential masking applied server-side. */
export function useAllWorkItems() {
  return useQuery({
    queryKey: queryKeys.workItems.all(),
    queryFn: async (): Promise<WorkItem[]> => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rows = await fetchAllRows<any>((from, to) =>
        (supabase as any).from('work_items_safe').select('*').order('start', { ascending: false }).range(from, to),
      )
      return rows.map(toWorkItem)
    },
  })
}

/** Work items filtered by type (via work_items_safe). */
export function useWorkItemsByType(type: WorkItemType | undefined) {
  return useQuery({
    queryKey: queryKeys.workItems.byType(type ?? ''),
    enabled: !!type,
    queryFn: async (): Promise<WorkItem[]> => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (supabase as any)
        .from('work_items_safe')
        .select('*')
        .eq('type', type!)
        .order('start', { ascending: false })
      if (error) throw error
      return (data ?? []).map(toWorkItem)
    },
  })
}

/** Single work item by id (via work_items_safe). */
export function useWorkItem(id: string | undefined) {
  return useQuery({
    queryKey: queryKeys.workItems.byId(id ?? ''),
    enabled: !!id,
    queryFn: async (): Promise<WorkItem> => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (supabase as any)
        .from('work_items_safe')
        .select('*')
        .eq('id', id!)
        .single()
      if (error) throw error
      return toWorkItem(data)
    },
  })
}

// ── Mutations ─────────────────────────────────────────────────

export function useCreateWorkItem() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (input: CreateWorkItemInput): Promise<WorkItem> => {
      // Cast to any: database.ts predates migration 0006 (project_status column).
      // Regenerate types after applying the migration.
      const { data, error } = await supabase
        .from('work_items')
        .insert({
          ...input,
          hashtags: input.hashtags ?? [],
        } as any)
        .select()
        .single()
      if (error) throw error
      return toWorkItem(data)
    },
    onSuccess: item => {
      qc.invalidateQueries({ queryKey: queryKeys.workItems.all() })
      qc.invalidateQueries({ queryKey: queryKeys.workItems.byType(item.type) })
    },
  })
}

export function useUpdateWorkItem() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({
      id,
      ...patch
    }: UpdateWorkItemInput & { id: string }): Promise<WorkItem> => {
      const { data, error } = await supabase
        .from('work_items')
        .update(patch as any)
        .eq('id', id)
        .select()
        .single()
      if (error) throw error
      return toWorkItem(data)
    },
    onSuccess: item => {
      qc.invalidateQueries({ queryKey: queryKeys.workItems.all() })
      qc.invalidateQueries({ queryKey: queryKeys.workItems.byId(item.id) })
      qc.invalidateQueries({ queryKey: queryKeys.workItems.byType(item.type) })
    },
  })
}

/**
 * Deletes a work item.
 * DB cascade removes its assignments; we invalidate assignment caches.
 */
export function useDeleteWorkItem() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (id: string): Promise<string> => {
      const { error } = await supabase.from('work_items').delete().eq('id', id)
      if (error) throw error
      return id
    },
    onSuccess: id => {
      qc.invalidateQueries({ queryKey: queryKeys.workItems.all() })
      qc.removeQueries({ queryKey: queryKeys.workItems.byId(id) })
      qc.invalidateQueries({ queryKey: queryKeys.assignments.all() })
      // PRD v2.104 T-23: deleting a work item cascade-deletes its assignments server-side
      // (ON DELETE CASCADE) — keep the LV-17 ledger RPC cache in sync, same as useDeleteAssignment.
      qc.invalidateQueries({ queryKey: ['ledgerData'] })
    },
  })
}
