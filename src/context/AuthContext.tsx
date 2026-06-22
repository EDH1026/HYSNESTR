import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from '@/lib/supabase'
import type { Grant, Profile } from '@/types'

// ── Context shape ─────────────────────────────────────────────

interface AuthState {
  session:      Session | null
  profile:      Profile | null
  grants:       Grant[]
  myPersonId:   string | null   // profiles.person_id — set by admin in AccountManager (PRD v2.5 §6.2)
  isLoading:    boolean
}

interface AuthContextValue extends AuthState {
  signOut: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

// ── Provider ──────────────────────────────────────────────────

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({
    session:    null,
    profile:    null,
    grants:     [],
    myPersonId: null,
    isLoading:  true,
  })

  // Prevent stale-closure updates after unmount
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  const loadProfileAndGrants = useCallback(async (userId: string) => {
    const [profileRes, grantsRes] = await Promise.all([
      supabase.from('profiles').select('*').eq('id', userId).single(),
      supabase.from('grants').select('*').eq('user_id', userId),
    ])
    const profile = (profileRes.data as Profile | null) ?? null
    return {
      profile,
      grants:     (grantsRes.data as Grant[] | null) ?? [],
      myPersonId: profile?.person_id ?? null,
    }
  }, [])

  useEffect(() => {
    // ── Initial session check ────────────────────────────────
    supabase.auth.getSession().then(async ({ data: { session } }) => {
      if (!mounted.current) return
      if (session) {
        const { profile, grants, myPersonId } = await loadProfileAndGrants(session.user.id)
        if (mounted.current) {
          setState({ session, profile, grants, myPersonId, isLoading: false })
        }
      } else {
        setState({ session: null, profile: null, grants: [], myPersonId: null, isLoading: false })
      }
    })

    // ── Real-time auth state changes ─────────────────────────
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      async (event, session) => {
        if (!mounted.current) return

        if (
          session &&
          (event === 'SIGNED_IN' ||
            event === 'TOKEN_REFRESHED' ||
            event === 'USER_UPDATED' ||
            event === 'PASSWORD_RECOVERY')
        ) {
          const { profile, grants, myPersonId } = await loadProfileAndGrants(session.user.id)
          if (mounted.current) {
            setState({ session, profile, grants, myPersonId, isLoading: false })
          }
        } else if (event === 'SIGNED_OUT') {
          if (mounted.current) {
            setState({ session: null, profile: null, grants: [], myPersonId: null, isLoading: false })
          }
        }
      },
    )

    return () => subscription.unsubscribe()
  }, [loadProfileAndGrants])

  const signOut = useCallback(async () => {
    await supabase.auth.signOut()
    // onAuthStateChange(SIGNED_OUT) clears state automatically
  }, [])

  return (
    <AuthContext.Provider value={{ ...state, signOut }}>
      {children}
    </AuthContext.Provider>
  )
}

// ── Hook ──────────────────────────────────────────────────────

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within <AuthProvider>')
  return ctx
}
