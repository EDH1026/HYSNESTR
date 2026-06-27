/**
 * Edge Function: sync-holidays  (PRD v2.19 §5.13 HOL-1~4)
 *
 * Fetches Korean public holidays from 한국천문연구원 특일 정보 API
 * (data.go.kr / SpcdeInfoService / getRestDeInfo) for the current year
 * and the following year, then upserts them into the holidays table.
 *
 * Key rules (HOL-4):
 *   • Only rows with source = 'auto' are touched.
 *   • Rows with source = 'manual' are never modified or deleted.
 *
 * Required Supabase secrets (set via `supabase secrets set`):
 *   SUPABASE_URL              (auto-injected in hosted env)
 *   SUPABASE_ANON_KEY         (auto-injected)
 *   SUPABASE_SERVICE_ROLE_KEY (must be set manually)
 *   KASI_SERVICE_KEY          (decoded service key from data.go.kr)
 *
 * Deploy:
 *   supabase functions deploy sync-holidays
 */

import { serve }        from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// ── CORS ──────────────────────────────────────────────────────
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

// ── KASI API ──────────────────────────────────────────────────

const KASI_BASE = 'https://apis.data.go.kr/B090041/openapi/service/SpcdeInfoService'

interface KasiItem {
  locdate:   number    // YYYYMMDD as number
  dateName:  string
  isHoliday: string    // 'Y' | 'N'
}

async function fetchMonthHolidays(
  serviceKey: string,
  year:       number,
  month:      number,
): Promise<KasiItem[]> {
  const params = new URLSearchParams({
    ServiceKey: serviceKey,
    solYear:    String(year),
    solMonth:   String(month).padStart(2, '0'),
    _type:      'json',
    numOfRows:  '50',
    pageNo:     '1',
  })

  const res = await fetch(`${KASI_BASE}/getRestDeInfo?${params}`, {
    signal: AbortSignal.timeout(10_000),
  })

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${await res.text().catch(() => '')}`)
  }

  const body = await res.json()

  // API returns null/empty string when no holidays this month
  const raw = body?.response?.body?.items?.item
  if (!raw || raw === '') return []

  // API returns a single object (not array) when there is exactly one item
  return Array.isArray(raw) ? raw : [raw]
}

// ── Handler ───────────────────────────────────────────────────

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })
  if (req.method !== 'POST')  return json({ error: 'Method not allowed' }, 405)

  // ── 1. Auth: verify caller is an active admin ──────────────
  const authHeader = req.headers.get('Authorization')
  if (!authHeader) return json({ error: 'Unauthorized' }, 401)

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!
  const anonKey     = Deno.env.get('SUPABASE_ANON_KEY')!
  const serviceKey  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const kasiKey     = Deno.env.get('KASI_SERVICE_KEY')

  if (!kasiKey) return json({ error: 'KASI_SERVICE_KEY is not configured on the server' }, 500)

  const callerClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth:   { persistSession: false },
  })
  const { data: { user }, error: userErr } = await callerClient.auth.getUser()
  if (userErr || !user) return json({ error: 'Unauthorized' }, 401)

  const { data: profile } = await callerClient
    .from('profiles')
    .select('global_role, status')
    .eq('id', user.id)
    .single()

  if (profile?.global_role !== 'admin' || profile?.status !== 'active') {
    return json({ error: 'Forbidden: admin role required' }, 403)
  }

  // ── 2. Fetch holidays from KASI API ───────────────────────
  const now         = new Date()
  const currentYear = now.getFullYear()
  const years       = [currentYear, currentYear + 1]
  const yearRange   = `${years[0]}~${years[years.length - 1]}`

  const apiHolidays: { name: string; date: string }[] = []
  const fetchErrors: string[] = []

  for (const year of years) {
    for (let month = 1; month <= 12; month++) {
      try {
        const items = await fetchMonthHolidays(kasiKey, year, month)
        for (const item of items) {
          if (item.isHoliday !== 'Y') continue
          const d    = String(item.locdate)
          const date = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`
          apiHolidays.push({ name: item.dateName, date })
        }
      } catch (e) {
        fetchErrors.push(`${year}/${String(month).padStart(2, '0')}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
  }

  // If every single API call failed, abort before touching the DB
  if (fetchErrors.length === years.length * 12) {
    return json({ error: `All API calls failed: ${fetchErrors.join('; ')}` }, 502)
  }

  // ── 3. Upsert auto holidays (HOL-4: never touch source='manual') ──
  const adminClient = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
  })

  // Load existing holidays in the affected date range
  const dateFrom = `${years[0]}-01-01`
  const dateTo   = `${years[years.length - 1]}-12-31`

  const { data: existingRows, error: fetchErr } = await adminClient
    .from('holidays')
    .select('id, name, date, source')
    .gte('date', dateFrom)
    .lte('date', dateTo)

  if (fetchErr) return json({ error: `DB read failed: ${fetchErr.message}` }, 500)

  const existingMap = new Map<string, { id: string; name: string; source: string }>()
  for (const row of (existingRows ?? [])) {
    existingMap.set(row.date, {
      id:     row.id,
      name:   row.name,
      source: (row as Record<string, unknown>).source as string ?? 'manual',
    })
  }

  const toInsert: Array<{ name: string; date: string; recurring: boolean; source: string }> = []
  const toUpdate: Array<{ id: string; name: string }> = []

  for (const h of apiHolidays) {
    const ex = existingMap.get(h.date)
    if (ex) {
      if (ex.source === 'manual') continue     // HOL-4: never overwrite manual
      if (ex.name !== h.name) toUpdate.push({ id: ex.id, name: h.name })
    } else {
      toInsert.push({ name: h.name, date: h.date, recurring: false, source: 'auto' })
    }
  }

  let added = 0, updated = 0

  if (toInsert.length > 0) {
    const { error: insertErr } = await adminClient.from('holidays').insert(toInsert)
    if (insertErr) return json({ error: `Insert failed: ${insertErr.message}` }, 500)
    added = toInsert.length
  }

  for (const { id, name } of toUpdate) {
    await adminClient.from('holidays').update({ name }).eq('id', id)
    updated++
  }

  // ── 4. Write sync log ─────────────────────────────────────
  const errorText = fetchErrors.length > 0 ? fetchErrors.join('; ') : null

  await adminClient.from('holiday_sync_log').insert({
    year_range:   yearRange,
    added,
    updated,
    total:        apiHolidays.length,
    error:        errorText,
    triggered_by: user.id,
  })

  // ── 5. Audit log ──────────────────────────────────────────
  await adminClient.from('audit_log').insert({
    user_id:     user.id,
    action:      'sync',
    target_type: 'holidays',
    target_id:   yearRange,
    at:          new Date().toISOString(),
  })

  return json({
    added,
    updated,
    total:    apiHolidays.length,
    years:    yearRange,
    ...(fetchErrors.length > 0 ? { errors: fetchErrors } : {}),
  })
})
