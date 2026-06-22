/**
 * Hooks for resolving the current user's linked Person record.
 *
 * Uses profiles.person_id directly (PRD v2.5 §6.2).
 * Admin sets the link in Admin > 계정 관리.
 */
import { useQuery } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { queryKeys } from '@/lib/queryKeys'
import { toPerson } from '@/lib/mappers'
import { useAuth } from '@/context/AuthContext'
import type { Person } from '@/types'

/** Returns the current user's people.id via profiles.person_id. */
export function useMyPersonId(): string | null {
  const { profile } = useAuth()
  return profile?.person_id ?? null
}

/** Returns the Person record for the current user, resolved via profiles.person_id. */
export function useMyPerson() {
  const { profile } = useAuth()
  const personId = profile?.person_id ?? null

  const personQuery = useQuery({
    queryKey: queryKeys.people.byId(personId ?? ''),
    queryFn: async (): Promise<Person> => {
      const { data, error } = await supabase
        .from('people')
        .select('*')
        .eq('id', personId!)
        .single()
      if (error) throw error
      return toPerson(data)
    },
    enabled: !!personId,
  })

  return {
    data:      personQuery.data ?? null,
    isLoading: personQuery.isLoading,
    error:     personQuery.error,
  }
}
