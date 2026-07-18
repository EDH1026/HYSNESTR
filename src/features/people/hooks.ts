/**
 * People data-access hooks.
 *
 * Visibility is enforced server-side by Postgres RLS (people_select policy).
 * The client simply queries; rows the user cannot see are never returned.
 *
 * ON DELETE CASCADE on assignments.person_id and accruals.person_id means
 * deleting a person automatically removes their assignments and accruals
 * on the DB side — we only need to invalidate those caches afterward.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { supabase } from '@/lib/supabase'
import { queryKeys } from '@/lib/queryKeys'
import { fetchAllRows } from '@/lib/fetchAll'
import { toPerson, type CreatePersonInput, type UpdatePersonInput } from '@/lib/mappers'
import type { Person } from '@/types'

// ── Queries ───────────────────────────────────────────────────

/** Returns all people the current user is allowed to see (RLS-filtered). */
export function useAllPeople() {
  return useQuery({
    queryKey: queryKeys.people.all(),
    queryFn: async (): Promise<Person[]> => {
      const rows = await fetchAllRows((from, to) =>
        supabase.from('people').select('*').order('name').range(from, to),
      )
      return rows.map(toPerson)
    },
  })
}

/** Returns a single person by id, or null if not found / no permission. */
export function usePerson(id: string | undefined) {
  return useQuery({
    queryKey: queryKeys.people.byId(id ?? ''),
    enabled: !!id,
    queryFn: async (): Promise<Person> => {
      const { data, error } = await supabase
        .from('people')
        .select('*')
        .eq('id', id!)
        .single()
      if (error) throw error
      return toPerson(data)
    },
  })
}

// ── Mutations ─────────────────────────────────────────────────

export function useCreatePerson() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (input: CreatePersonInput): Promise<Person> => {
      const { data, error } = await supabase
        .from('people')
        .insert(input as any)
        .select()
        .single()
      if (error) throw error
      return toPerson(data)
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.people.all() })
    },
  })
}

export function useUpdatePerson() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({
      id,
      ...patch
    }: UpdatePersonInput & { id: string }): Promise<Person> => {
      const { data, error } = await supabase
        .from('people')
        .update(patch as any)
        .eq('id', id)
        .select()
        .single()
      if (error) throw error
      return toPerson(data)
    },
    onSuccess: person => {
      qc.invalidateQueries({ queryKey: queryKeys.people.all() })
      qc.invalidateQueries({ queryKey: queryKeys.people.byId(person.id) })
    },
  })
}

/**
 * Deletes a person.
 * DB cascade removes their assignments and accruals automatically;
 * we invalidate those caches so the UI reflects the removal.
 */
export function useDeletePerson() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (id: string): Promise<string> => {
      const { error } = await supabase.from('people').delete().eq('id', id)
      if (error) throw error
      return id
    },
    onSuccess: id => {
      qc.invalidateQueries({ queryKey: queryKeys.people.all() })
      qc.removeQueries({ queryKey: queryKeys.people.byId(id) })
      // Cascaded: invalidate all assignment/accrual lists
      qc.invalidateQueries({ queryKey: queryKeys.assignments.all() })
      qc.invalidateQueries({ queryKey: queryKeys.accruals.all() })
    },
  })
}
