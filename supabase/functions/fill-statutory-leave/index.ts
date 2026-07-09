/**
 * Edge Function: fill-statutory-leave  (PRD v2.29 §5.13 AL-9)
 *
 * 근로기준법 제60조 기준 법정연차를 모든 인력(hire_date 존재)에 대해
 * 회계연도(7/1) 기준으로 계산하여 annual_leave_grants 테이블에 반영한다.
 *
 * 규칙 (v2.29 변경 사항):
 *   • grant_type 으로 행 유형을 구분한다:
 *       'first_year_monthly' — 입사 후 11개월 월차(역년별 합산)
 *       'annual'             — 첫 7/1 비례연차 + 이후 매년 7/1 연차
 *   • UNIQUE 키가 (person_id, year, grant_type) 으로 변경되었으므로
 *     INSERT ... ON CONFLICT (person_id, year, grant_type) DO NOTHING 사용.
 *   • 재실행 시: 자동계산 note 행만 삭제 후 재삽입 — 수동 입력 행은 건드리지 않음.
 *     수동 행과 (year, grant_type) 충돌 시 에러 없이 건너뜀.
 *
 * Body (JSON, optional):
 *   { anchorDate?: "YYYY-MM-DD" }   ← 기본값: 오늘 (서버 UTC)
 *
 * Deploy:
 *   supabase functions deploy fill-statutory-leave
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

// ── 날짜 유틸 ────────────────────────────────────────────────

function r1(n: number): number {
  return Math.round(n * 10) / 10
}

function daysBetween(startStr: string, endStr: string): number {
  const [sy, sm, sd] = startStr.split('-').map(Number)
  const [ey, em, ed] = endStr.split('-').map(Number)
  return Math.round(
    (Date.UTC(ey, em - 1, ed) - Date.UTC(sy, sm - 1, sd)) / 86400000,
  )
}

function addMonths(dateStr: string, months: number): string {
  const [y, m, d] = dateStr.split('-').map(Number)
  const totalMonths = (m - 1) + months
  const ty = y + Math.floor(totalMonths / 12)
  const tm = (totalMonths % 12 + 12) % 12 + 1
  const daysInMonth = new Date(Date.UTC(ty, tm, 0)).getUTCDate()
  const day = Math.min(d, daysInMonth)
  return `${ty}-${String(tm).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

// ── 법정연차 계산 (grant_type 분리) ─────────────────────────

interface TypedGrantRow {
  year:       number
  grant_type: 'first_year_monthly' | 'annual'
  days:       number
}

function computeTypedGrants(hireDate: string, asOfDate: string): TypedGrantRow[] {
  const monthly = new Map<number, number>()  // calendar year → days
  const annual  = new Map<number, number>()  // calendar year → days

  const hireYear  = parseInt(hireDate.slice(0, 4), 10)
  const hireMonth = parseInt(hireDate.slice(5, 7), 10)

  // 첫 11개월 월차 (역년별 합산)
  for (let m = 1; m <= 11; m++) {
    const date = addMonths(hireDate, m)
    if (date > asOfDate) break
    const yr = parseInt(date.slice(0, 4), 10)
    monthly.set(yr, r1((monthly.get(yr) ?? 0) + 1))
  }

  // 첫 7/1 비례연차
  const firstFiscalYear = hireMonth < 7 ? hireYear : hireYear + 1
  const firstFiscalDate = `${firstFiscalYear}-07-01`
  if (firstFiscalDate <= asOfDate) {
    const daysWorked = daysBetween(hireDate, firstFiscalDate)
    const days = r1(15 * daysWorked / 365)
    annual.set(firstFiscalYear, r1((annual.get(firstFiscalYear) ?? 0) + days))
  }

  // 이후 매년 7/1 연차
  let fiscalYear = firstFiscalYear + 1
  let n = 1
  while (true) {
    const date = `${fiscalYear}-07-01`
    if (date > asOfDate) break
    const elapsed = n + 1
    annual.set(fiscalYear, Math.min(25, 15 + Math.floor((elapsed - 1) / 2)))
    fiscalYear++
    n++
  }

  const rows: TypedGrantRow[] = []
  for (const [year, days] of monthly)
    rows.push({ year, grant_type: 'first_year_monthly', days })
  for (const [year, days] of annual)
    rows.push({ year, grant_type: 'annual', days: r1(days) })
  return rows
}

// ── Handler ───────────────────────────────────────────────────

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })
  if (req.method !== 'POST')   return json({ error: 'Method not allowed' }, 405)

  // ── Auth: admin only ──────────────────────────────────────
  const authHeader = req.headers.get('Authorization')
  if (!authHeader) return json({ error: 'Unauthorized' }, 401)

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!
  const anonKey     = Deno.env.get('SUPABASE_ANON_KEY')!
  const serviceKey  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

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

  // ── Parse body ───────────────────────────────────────────
  let anchorDate: string
  try {
    const body = await req.json().catch(() => ({}))
    const raw  = body?.anchorDate
    anchorDate = typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw)
      ? raw
      : new Date().toISOString().slice(0, 10)
  } catch {
    anchorDate = new Date().toISOString().slice(0, 10)
  }

  // ── Fetch all people with hire_date ───────────────────────
  const adminClient = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
  })

  const { data: people, error: peopleErr } = await adminClient
    .from('people')
    .select('id, hire_date')
    .not('hire_date', 'is', null)

  if (peopleErr) {
    console.error('[fill-statutory-leave] people fetch failed:', peopleErr.message)
    return json({ error: `DB read failed: ${peopleErr.message}` }, 500)
  }

  const NOTE = '근로기준법 자동계산 (회계연도)'
  let totalInserted = 0
  let totalPeople   = 0
  const errors: string[] = []

  for (const person of (people ?? [])) {
    const hireDate = person.hire_date as string
    try {
      const rows = computeTypedGrants(hireDate, anchorDate)
      if (rows.length === 0) continue

      // 1. 기존 자동계산 행 삭제 (수동 입력 행은 보존)
      const { error: delErr } = await adminClient
        .from('annual_leave_grants')
        .delete()
        .eq('person_id', person.id)
        .like('note', '근로기준법 자동계산%')
      if (delErr) throw new Error(delErr.message)

      // 2. 새 행 삽입 — 수동 행과 (year, grant_type) 충돌 시 DO NOTHING
      const insertRows = rows.map(r => ({
        person_id:  person.id,
        year:       r.year,
        grant_type: r.grant_type,
        days:       r.days,
        note:       NOTE,
      }))
      const { error: insErr } = await adminClient
        .from('annual_leave_grants')
        .upsert(insertRows, { onConflict: 'person_id,year,grant_type', ignoreDuplicates: true })
      if (insErr) throw new Error(insErr.message)

      totalInserted += insertRows.length
      totalPeople++
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      console.error(`[fill-statutory-leave] person ${person.id}:`, msg)
      errors.push(`${person.id}: ${msg}`)
    }
  }

  // ── Audit log ────────────────────────────────────────────
  await adminClient.from('audit_log').insert({
    user_id:     user.id,
    action:      'sync',
    target_type: 'annual_leave_grants',
    target_id:   anchorDate,
    at:          new Date().toISOString(),
  })

  console.log(
    `[fill-statutory-leave] anchor=${anchorDate}` +
    ` people=${totalPeople} rows=${totalInserted} errors=${errors.length}`,
  )

  return json({
    anchorDate,
    people:   totalPeople,
    inserted: totalInserted,
    ...(errors.length > 0 ? { errors } : {}),
  })
})
