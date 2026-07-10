/**
 * Edge Function: sync-holidays  (PRD v2.40 §3 + rate-limit handling)
 *
 * Fetches Korean public holidays from 한국천문연구원 특일 정보 API
 * (data.go.kr / SpcdeInfoService / getRestDeInfo) for 2022 through
 * (currentYear + 1), then upserts them into the holidays table.
 *
 * Rate-limit strategy:
 *   - Sequential calls with 250 ms gap (avoids parallel-burst 429s)
 *   - Exponential backoff on 429: 1 s → 2 s → 4 s → 8 s (max 4 attempts)
 *   - Retry mode: if the last sync log has errors, only retry those months
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

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

// ── KASI API ──────────────────────────────────────────────────

const KASI_BASE = 'https://apis.data.go.kr/B090041/openapi/service/SpcdeInfoService'

interface KasiItem {
  locdate:   number    // YYYYMMDD as number
  dateName:  string
  isHoliday: string    // 'Y' | 'N'
}

/** Parse "YYYY/MM: <msg>" error entries written by this function. */
function parseFailedMonths(errorText: string | null): Array<{ year: number; month: number }> {
  if (!errorText) return []
  const re = /(\d{4})\/(\d{2}):/g
  const result: Array<{ year: number; month: number }> = []
  let m: RegExpExecArray | null
  while ((m = re.exec(errorText)) !== null) {
    result.push({ year: Number(m[1]), month: Number(m[2]) })
  }
  return result
}

/**
 * Fetch one month's holidays with exponential backoff on HTTP 429.
 * maxAttempts = 4 → delays 1 s, 2 s, 4 s before final attempt.
 */
async function fetchMonthHolidays(
  serviceKey: string,
  year:       number,
  month:      number,
): Promise<KasiItem[]> {
  const maxAttempts = 4
  let retryDelay    = 1_000

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const params = new URLSearchParams({
      ServiceKey: serviceKey,
      solYear:    String(year),
      solMonth:   String(month).padStart(2, '0'),
      _type:      'json',
      numOfRows:  '50',
      pageNo:     '1',
    })

    const controller = new AbortController()
    const timer      = setTimeout(() => controller.abort(), 15_000)
    let res: Response

    try {
      res = await fetch(`${KASI_BASE}/getRestDeInfo?${params}`, {
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timer)
    }

    if (res.status === 429) {
      if (attempt === maxAttempts) {
        throw new Error(`HTTP 429: rate limit exceeded after ${maxAttempts} attempts`)
      }
      console.warn(
        `[sync-holidays] 429 on ${year}/${String(month).padStart(2, '0')},` +
        ` retry ${attempt}/${maxAttempts - 1} in ${retryDelay}ms`,
      )
      await sleep(retryDelay)
      retryDelay *= 2
      continue
    }

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

  throw new Error('unreachable: retry loop exhausted')
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

  // ── 2. Admin client (needed to read last log + write to DB) ─
  const adminClient = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
  })

  // ── 3. Determine year range ────────────────────────────────
  const now         = new Date()
  const currentYear = now.getFullYear()
  const allYears: number[] = []
  for (let y = 2022; y <= currentYear + 1; y++) allYears.push(y)
  const yearRange = `${allYears[0]}~${allYears[allYears.length - 1]}`

  // ── 4. Retry mode: check last sync log for failed months ───
  const { data: lastLog } = await adminClient
    .from('holiday_sync_log')
    .select('error')
    .order('synced_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  const failedFromLastRun = parseFailedMonths(lastLog?.error ?? null)
    .filter(({ year }) => year >= 2022 && year <= currentYear + 1)

  let tasks: Array<{ year: number; month: number }>
  const isRetryMode = failedFromLastRun.length > 0

  if (isRetryMode) {
    tasks = failedFromLastRun
    console.log(`[sync-holidays] Retry mode: ${tasks.length} months from last failed sync`)
  } else {
    tasks = allYears.flatMap(year =>
      Array.from({ length: 12 }, (_, i) => ({ year, month: i + 1 })),
    )
    console.log(`[sync-holidays] Full sync: ${tasks.length} months (${yearRange})`)
  }

  // ── 5. Sequential fetch — 250 ms gap + backoff on 429 ──────
  const apiHolidays: Array<{ name: string; date: string }> = []
  const fetchErrors: string[]                               = []

  for (let i = 0; i < tasks.length; i++) {
    if (i > 0) await sleep(250)   // avoid parallel-burst rate limit
    const { year, month } = tasks[i]
    try {
      const items = await fetchMonthHolidays(kasiKey, year, month)
      for (const item of items) {
        if (item.isHoliday !== 'Y') continue
        const d = String(item.locdate)
        apiHolidays.push({
          name: item.dateName,
          date: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`,
        })
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      fetchErrors.push(`${year}/${String(month).padStart(2, '0')}: ${msg}`)
      console.error(`[sync-holidays] Failed ${year}/${month}: ${msg}`)
    }
  }

  console.log(
    `[sync-holidays] API done — ${apiHolidays.length} holidays, ${fetchErrors.length} errors`,
  )

  // Abort only if every single call failed (nothing to write)
  if (fetchErrors.length === tasks.length && tasks.length > 0) {
    console.error('[sync-holidays] All API calls failed:', fetchErrors)
    return json({ error: `All API calls failed: ${fetchErrors.join('; ')}` }, 502)
  }

  // ── 6. Upsert holidays (overwrite all existing rows) ───────
  const dateFrom = `${allYears[0]}-01-01`
  const dateTo   = `${allYears[allYears.length - 1]}-12-31`

  const { data: existingRows, error: fetchErr } = await adminClient
    .from('holidays')
    .select('id, name, date')
    .gte('date', dateFrom)
    .lte('date', dateTo)

  if (fetchErr) {
    console.error('[sync-holidays] DB select failed:', fetchErr.message)
    return json({ error: `DB read failed: ${fetchErr.message}` }, 500)
  }

  const existingMap = new Map<string, { id: string; name: string }>()
  for (const row of (existingRows ?? [])) {
    existingMap.set(row.date, { id: row.id, name: row.name })
  }

  const toInsert: Array<{ name: string; date: string; recurring: boolean; source: string }> = []
  const toUpdate: Array<{ id: string; name: string }>                                       = []

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

  // ── 7. Write sync log & audit ──────────────────────────────
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
    total:         apiHolidays.length,
    years:         yearRange,
    yearCount:     allYears.length,
    isRetryMode,
    retriedMonths: isRetryMode ? tasks.length : undefined,
    ...(fetchErrors.length > 0 ? { errors: fetchErrors } : {}),
  })
})
