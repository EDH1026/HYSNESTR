import { useAuth } from '@/context/AuthContext'
import { useMobile } from './useMobile'
import type { GrantLevel, GrantScope } from '@/types'

// Level ordering for "meets or exceeds" comparison
const LEVEL_RANK: Record<GrantLevel, number> = { view: 1, edit: 2, admin: 3 }

function meetsNeed(have: GrantLevel, need: 'view' | 'edit'): boolean {
  return LEVEL_RANK[have] >= LEVEL_RANK[need]
}

/**
 * Client-side UX permission helpers.
 *
 * Final enforcement is always done by Postgres RLS (app_can function).
 * These helpers are only for showing/hiding UI controls; they mirror the
 * same logic as app_can() in supabase/migrations/20260620000002_functions.sql.
 */
export function useAuthz() {
  const { profile, grants, myPersonId } = useAuth()
  const isMobile = useMobile()

  function effectiveLevel(
    scope: GrantScope,
    resourceId?: string | null,
  ): GrantLevel | null {
    if (!profile || profile.status !== 'active') return null

    // 1. admin → full access
    if (profile.global_role === 'admin') return 'admin'

    // 2. Global role — viewer has no blanket global access (mirrors app_can §0007)
    if (profile.global_role === 'editor') return 'edit'
    // viewers fall through to grants / self-access rule in canView()

    // 3. Resource-level grants: exact match OR global grant
    const relevant = grants.filter(
      g =>
        g.scope === 'global' ||
        (g.scope === scope && g.resource_id === (resourceId ?? null)),
    )
    if (relevant.length === 0) return null

    return relevant.reduce<GrantLevel | null>((best, g) => {
      if (!best) return g.level
      return LEVEL_RANK[g.level] > LEVEL_RANK[best] ? g.level : best
    }, null)
  }

  /**
   * Returns true when the current user can view the given resource.
   * Pass no resourceId for global checks (e.g. canView('global')).
   */
  function canView(scope: GrantScope, resourceId?: string | null): boolean {
    // Self-view: own person record is always visible (PRD v2.5 §6.2).
    // myPersonId === profile.person_id after §6.2 migration; single check suffices.
    if (scope === 'person' && resourceId) {
      if (resourceId === myPersonId) return true
    }
    const level = effectiveLevel(scope, resourceId)
    return level !== null && meetsNeed(level, 'view')
  }

  /**
   * Returns true when the current user can create/update/delete the given resource.
   * Always false on mobile (§6.6 MOB-2): mobile is read-only regardless of role.
   */
  function canEdit(scope: GrantScope, resourceId?: string | null): boolean {
    if (isMobile) return false
    const level = effectiveLevel(scope, resourceId)
    return level !== null && meetsNeed(level, 'edit')
  }

  /** Shortcut for the admin check (no resource context needed). */
  function isAdmin(): boolean {
    return profile?.global_role === 'admin' && profile.status === 'active'
  }

  return { canView, canEdit, isAdmin, isMobile }
}
