/**
 * Admin-only data-access hooks.
 *
 * All hooks assume the caller is an admin — server RLS enforces this.
 * Client-side callers should gate rendering with isAdmin() before mounting
 * components that use these hooks.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { queryKeys } from '@/lib/queryKeys'
import type { Grant, Profile, AuditLog, GrantScope, GrantLevel, GlobalRole } from '@/types'

// ── Profiles ──────────────────────────────────────────────────

export function useAllProfiles() {
  return useQuery({
    queryKey: queryKeys.profiles.all(),
    queryFn: async (): Promise<Profile[]> => {
      const { data, error } = await supabase
        .from('profiles')
        .select('*')
        .order('name')
      if (error) throw error
      return (data ?? []) as Profile[]
    },
  })
}

export function useUpdateProfile() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({
      id,
      ...patch
    }: {
      id: string
      global_role?: GlobalRole
      status?: 'active' | 'inactive'
      lpn?: string | null
      person_id?: string | null
    }) => {
      const { error } = await supabase.from('profiles').update(patch as any).eq('id', id)
      if (error) throw error
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.profiles.all() }),
  })
}

// ── Grants ────────────────────────────────────────────────────

export function useAllGrants() {
  return useQuery({
    queryKey: queryKeys.grants.all(),
    queryFn: async (): Promise<Grant[]> => {
      const { data, error } = await supabase.from('grants').select('*')
      if (error) throw error
      return (data ?? []) as Grant[]
    },
  })
}

export interface CreateGrantInput {
  user_id:     string
  scope:       GrantScope
  resource_id: string | null
  level:       GrantLevel
}

export function useCreateGrant() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (input: CreateGrantInput) => {
      const { error } = await supabase.from('grants').insert(input)
      if (error) throw error
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.grants.all() }),
  })
}

export function useDeleteGrant() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from('grants').delete().eq('id', id)
      if (error) throw error
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.grants.all() }),
  })
}

// ── Audit log ─────────────────────────────────────────────────

export interface AuditLogEntry extends AuditLog {
  user_name: string | null
}

export function useAuditLog(limit = 100) {
  return useQuery({
    queryKey: [...queryKeys.auditLog.list(), limit],
    queryFn: async (): Promise<AuditLogEntry[]> => {
      const { data, error } = await supabase
        .from('audit_log')
        .select('*, profiles(name)')
        .order('at', { ascending: false })
        .limit(limit)
      if (error) throw new Error(error.message)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (data ?? []).map((row: any) => ({
        id:          row.id,
        user_id:     row.user_id,
        action:      row.action,
        target_type: row.target_type,
        target_id:   row.target_id,
        at:          row.at,
        user_name:   row.profiles?.name ?? null,
      }))
    },
  })
}
