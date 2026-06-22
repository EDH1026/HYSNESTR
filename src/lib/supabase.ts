import { createClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'

// Only the anon (public) key is used here.
// The service-role key bypasses RLS and must NEVER appear in client code.
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    'Missing Supabase environment variables. ' +
      'Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in .env.local.',
  )
}

export const supabase = createClient<Database>(supabaseUrl, supabaseAnonKey)
