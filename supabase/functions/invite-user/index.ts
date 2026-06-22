/**
 * Edge Function: invite-user
 *
 * Sends a Supabase Auth invitation email to a new user.
 * Only admin accounts may call this endpoint.
 *
 * The SUPABASE_SERVICE_ROLE_KEY is read from the Edge Function
 * environment (set in the Supabase Dashboard → Edge Functions → Secrets).
 * It is NEVER present in the client bundle.
 *
 * Deploy:
 *   supabase functions deploy invite-user --no-verify-jwt
 *
 * Required secrets (supabase secrets set …):
 *   SUPABASE_URL              (auto-injected in Supabase hosted env)
 *   SUPABASE_SERVICE_ROLE_KEY (must be set manually)
 *   INVITE_REDIRECT_URL       (e.g. https://your-app.com/reset-password)
 */

import { serve }        from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// ── CORS ──────────────────────────────────────────────────────
// Restrict to your app's origin in production.
const CORS = {
  'Access-Control-Allow-Origin':  Deno.env.get('APP_ORIGIN') ?? '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })
}

// ── Handler ───────────────────────────────────────────────────

serve(async (req: Request) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS })
  }

  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405)
  }

  // ── 1. Verify the caller is authenticated ──────────────────
  const authHeader = req.headers.get('Authorization')
  if (!authHeader) return json({ error: 'Unauthorized' }, 401)

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!
  const anonKey     = Deno.env.get('SUPABASE_ANON_KEY')!
  const serviceKey  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

  // Caller client: uses caller's JWT — subject to RLS
  const callerClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth:   { persistSession: false },
  })

  const { data: { user }, error: userError } = await callerClient.auth.getUser()
  if (userError || !user) return json({ error: 'Unauthorized' }, 401)

  // ── 2. Check caller is admin ───────────────────────────────
  // RLS on profiles allows the caller to read their own profile only,
  // so this query is safe and cannot be spoofed by the client.
  const { data: profile } = await callerClient
    .from('profiles')
    .select('global_role, status')
    .eq('id', user.id)
    .single()

  if (profile?.global_role !== 'admin' || profile?.status !== 'active') {
    return json({ error: 'Forbidden: admin role required' }, 403)
  }

  // ── 3. Parse and validate request body ────────────────────
  let body: { email?: string; name?: string; role?: string }
  try {
    body = await req.json()
  } catch {
    return json({ error: 'Invalid JSON body' }, 400)
  }

  const { email, name = '', role = 'viewer' } = body

  if (!email || typeof email !== 'string') {
    return json({ error: '"email" is required' }, 400)
  }

  const validRoles = ['admin', 'editor', 'viewer'] as const
  if (!validRoles.includes(role as typeof validRoles[number])) {
    return json({ error: `"role" must be one of: ${validRoles.join(', ')}` }, 400)
  }

  // ── 4. Send invite via service-role client ─────────────────
  // Service-role client bypasses RLS and can call auth admin APIs.
  const adminClient = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
  })

  const { data, error: inviteError } = await adminClient.auth.admin.inviteUserByEmail(
    email,
    {
      data:       { name },
      redirectTo: Deno.env.get('INVITE_REDIRECT_URL') ??
                  `${req.headers.get('origin') ?? ''}/reset-password`,
    },
  )

  if (inviteError) {
    // Surface Supabase errors (e.g. "User already registered") to the admin
    return json({ error: inviteError.message }, 400)
  }

  // ── 5. Set initial global_role if requested ────────────────
  // The handle_new_user trigger sets global_role='viewer' by default.
  // If admin requested a different role, update it now.
  if (role !== 'viewer' && data.user) {
    await adminClient
      .from('profiles')
      .update({ global_role: role })
      .eq('id', data.user.id)
  }

  return json({
    user: { id: data.user?.id, email: data.user?.email },
    message: `Invitation sent to ${email}`,
  })
})
