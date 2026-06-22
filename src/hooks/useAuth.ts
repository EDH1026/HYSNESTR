// Thin re-export so existing imports of '@/hooks/useAuth' continue to work.
// All auth state now lives in AuthContext.
export { useAuth } from '@/context/AuthContext'
