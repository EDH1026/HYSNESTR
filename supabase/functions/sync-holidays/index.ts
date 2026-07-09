/**
 * Edge Function: sync-holidays  (PRD v2.40 §3)
 *
 * Fetches Korean public holidays from 한국천문연구원 특일 정보 API
 * (data.go.kr / SpcdeInfoService / getRestDeInfo) for 2022 through
 * (currentYear + 1), then upserts them into the holidays table.
 * All existing rows (including manual) are overwritten by API results.
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

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15_000)

  try {
    const res = await fetch(`${KASI_BASE}/getRestDeInfo?${params}`, {
      signal: controller.signal,
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
  } finally {
    clearTimeout(timer)
  }
}

// ── Handler ───────────────────────────────────────────────────

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })
  if (req.method !== 'POST')   return json({ error: 'Method not allowed' }, 405)

  // ── 1. Auth: verify caller is an active admin ──────────────
  const authHeader = req.headers.get('Authorization')
  if (!authHeader) return json({ error: 'Unauthorized' }, 401)

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!
  const anonKey     = Deno.env.get('SUPABASE_ANON_KEY')!
  const serviceKey  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const kasiKey     = Deno.env.get('KASI_SERVICE_KEY')

  if (!kasiKey) {
    console.error('[sync-holidays] KASI_SERVICE_KEY is not set')
    return json({ error: 'KASI_SERVICE_KEY is not configured on the server' }, 500)
  }

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

  // ── 2. Fetch holidays — all months in parallel ─────────────
  // Always sync 2022 through currentYear+1 (dynamic, no request body needed)
  const now         = new Date()
  const currentYear = now.getFullYear()
  const years: number[] = []
  for (let y = 2022; y <= currentYear + 1; y++) years.push(y)
  const yearRange = `${years[0]}~${years[years.length - 1]}`

  // Build a flat list of (year, month) pairs and fetch all concurrently
  const tasks: Array<{ year: number; month: number }> = []
  for (const year of years) {
    for (let month = 1; month <= 12; month++) {
      tasks.push({ year, month })
    }
  }

  console.log(`[sync-holidays] Fetching ${tasks.length} months in parallel…`)

  const results = await Promise.allSettled(
    tasks.map(({ year, month }) => fetchMonthHolidays(kasiKey, year, month))
  )

  const apiHolidays: { name: string; date: string }[] = []
  const fetchErrors: string[] = []

  for (let i = 0; i < results.length; i++) {
    const r = results[i]
    const { year, month } = tasks[i]
    if (r.status === 'fulfilled') {
      for (const item of r.value) {
        if (item.isHoliday !== 'Y') continue
        const d    = String(item.locdate)
        const date = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`
        apiHolidays.push({ name: item.dateName, date })
      }
    } else {
      const msg = r.reason instanceof Error ? r.reason.message : String(r.reason)
      fetchErrors.push(`${year}/${String(month).padStart(2, '0')}: ${msg}`)
    }
  }

  console.log(`[sync-holidays] API done — ${apiHolidays.length} holidays, ${fetchErrors.length} month errors`)

  // If every single API call failed, abort before touching the DB
  if (fetchErrors.length === tasks.length) {
    console.error('[sync-holidays] All API calls failed:', fetchErrors)
    return json({ error: `All API calls failed: ${fetchErrors.join('; ')}` }, 502)
  }

  // ── 3. Upsert holidays (overwrite all existing rows including manual) ──
  const adminClient = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
  })

  const dateFrom = `${years[0]}-01-01`
  const dateTo   = `${years[years.length - 1]}-12-31`

  const { data: existingRows, error: fetchErr } = await adminClient
    .from('holidays')
    .select('id, name, date, source')
    .gte('date', dateFrom)
    .lte('date', dateTo)

  if (fetchErr) {
    console.error('[sync-holidays] DB select failed:', fetchErr.message)
    return json({ error: `DB read failed: ${fetchErr.message}` }, 500)
  }

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
      if (ex.name !== h.name) toUpdate.push({ id: ex.id, name: h.name })
    } else {
      toInsert.push({ name: h.name, date: h.date, recurring: false, source: 'auto' })
    }
  }

  let added = 0, updated = 0

  if (toInsert.length > 0) {
    const { error: insertErr } = await adminClient.from('holidays').insert(toInsert)
    if (insertErr) {
      console.error('[sync-holidays] Insert failed:', insertErr.message)
      return json({ error: `Insert failed: ${insertErr.message}` }, 500)
    }
    added = toInsert.length
  }

  for (const { id, name } of toUpdate) {
    await adminClient.from('holidays').update({ name }).eq('id', id)
    updated++
  }

  console.log(`[sync-holidays] Done — added ${added}, updated ${updated}`)

  // ── 4. Write sync log & audit ──────────────────────────────
  const errorText = fetchErrors.length > 0 ? fetchErrors.join('; ') : null

  await adminClient.from('holiday_sync_log').insert({
    year_range:   yearRange,
    added,
    updated,
    total:        apiHolidays.length,
    error:        errorText,
    triggered_by: user.id,
  })

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
    total:     apiHolidays.length,
    years:     yearRange,
    yearCount: years.length,
    ...(fetchErrors.length > 0 ? { errors: fetchErrors } : {}),
  })
})
