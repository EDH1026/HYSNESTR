/**
 * Edge Function: fill-statutory-leave  (PRD v2.31 §5.13 AL-2b③)
 *
 * 근로기준법 제60조 기준 법정연차를 모든 인력(hire_date 존재)에 대해
 * 회계연도(7/1) 기준으로 계산하여 annual_leave_grants 테이블에 반영한다.
 *
 * 규칙:
 *   • grant_type 'first_year_monthly' / 'annual' 으로 행 유형 구분.
 *   • 가산: floor((만근속연수 - 1) / 2). 만근속연수 = yearsOfEmployment(hireDate, grantDate).
 *   • DELETE(자동계산 note 행) → upsert ON CONFLICT DO NOTHING.
 *
 * Body: { anchorDate?: "YYYY-MM-DD" }   ← 기본값: UTC 오늘
 * Deploy: supabase functions deploy fill-statutory-leave
 */

import { serve }        from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

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

function r1(n: number): number { return Math.round(n * 10) / 10 }

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
  return `${ty}-${String(tm).padStart(2, '0')}-${String(Math.min(d, daysInMonth)).padStart(2, '0')}`
}

/** 입사일~기준일 사이 만 근속연수 */
function yearsOfEmployment(hireDate: string, grantDate: string): number {
  const hy = parseInt(hireDate.slice(0, 4), 10), hm = parseInt(hireDate.slice(5, 7), 10), hd = parseInt(hireDate.slice(8, 10), 10)
  const gy = parseInt(grantDate.slice(0, 4), 10), gm = parseInt(grantDate.slice(5, 7), 10), gd = parseInt(grantDate.slice(8, 10), 10)
  let years = gy - hy
  if (gm < hm || (gm === hm && gd < hd)) years--
  return Math.max(0, years)
}

// ── 법정연차 계산 ─────────────────────────────────────────────

interface TypedGrantRow {
  year:       number
  grant_type: 'first_year_monthly' | 'annual'
  days:       number
  detail:     string  // 산출 근거 (note 에 포함)
}

function computeTypedGrants(hireDate: string, asOfDate: string): TypedGrantRow[] {
  const hireYear  = parseInt(hireDate.slice(0, 4), 10)
  const hireMonth = parseInt(hireDate.slice(5, 7), 10)

  // 월차 (역년별 합산)
  const monthlyMap = new Map<number, { days: number; first: string; last: string }>()
  for (let m = 1; m <= 11; m++) {
    const date = addMonths(hireDate, m)
    if (date > asOfDate) break
    const yr   = parseInt(date.slice(0, 4), 10)
    const prev = monthlyMap.get(yr)
    if (prev) { prev.days = r1(prev.days + 1); prev.last = date }
    else       { monthlyMap.set(yr, { days: 1, first: date, last: date }) }
  }

  // 첫 7/1 비례연차 + 이후 매년 7/1 연차
  const firstFiscalYear = hireMonth < 7 ? hireYear : hireYear + 1
  const annualRows: TypedGrantRow[] = []

  const firstFiscalDate = `${firstFiscalYear}-07-01`
  if (firstFiscalDate <= asOfDate) {
    const daysWorked = daysBetween(hireDate, firstFiscalDate)
    const days = r1(15 * daysWorked / 365)
    annualRows.push({
      year: firstFiscalYear,
      grant_type: 'annual',
      days,
      detail: `비례연차: 15일×${daysWorked}일/365≈${days}일`,
    })
  }

  let fiscalYear = firstFiscalYear + 1
  while (true) {
    const date = `${fiscalYear}-07-01`
    if (date > asOfDate) break
    const ye    = yearsOfEmployment(hireDate, date)
    const bonus = Math.min(10, Math.floor((ye - 1) / 2))
    const days  = 15 + bonus
    annualRows.push({
      year: fiscalYear,
      grant_type: 'annual',
      days,
      detail: bonus > 0
        ? `기본15일+가산${bonus}일=${days}일 (근속${ye}년)`
        : `기본15일 (근속${ye}년)`,
    })
    fiscalYear++
  }

  const rows: TypedGrantRow[] = []
  for (const [year, { days, first, last }] of monthlyMap) {
    const range = first.slice(0, 7) === last.slice(0, 7)
      ? first.slice(0, 7)
      : `${first.slice(0, 7)}~${last.slice(0, 7)}`
    rows.push({ year, grant_type: 'first_year_monthly', days, detail: `매월개근 ${range} 합계 ${days}일` })
  }
  return rows.concat(annualRows)
}

// ── Handler ───────────────────────────────────────────────────

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })
  if (req.method !== 'POST')   return json({ error: 'Method not allowed' }, 405)

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
    .from('profiles').select('global_role, status').eq('id', user.id).single()
  if (profile?.global_role !== 'admin' || profile?.status !== 'active')
    return json({ error: 'Forbidden: admin role required' }, 403)

  let anchorDate: string
  try {
    const body = await req.json().catch(() => ({}))
    const raw  = body?.anchorDate
    anchorDate = typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw)
      ? raw : new Date().toISOString().slice(0, 10)
  } catch {
    anchorDate = new Date().toISOString().slice(0, 10)
  }

  const adminClient = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } })

  const { data: people, error: peopleErr } = await adminClient
    .from('people').select('id, hire_date').not('hire_date', 'is', null)
  if (peopleErr) return json({ error: `DB read failed: ${peopleErr.message}` }, 500)

  const NOTE_PREFIX = '근로기준법 자동계산 (회계연도)'
  let totalInserted = 0, totalPeople = 0
  const errors: string[] = []

  for (const person of (people ?? [])) {
    const hireDate = person.hire_date as string
    try {
      const rows = computeTypedGrants(hireDate, anchorDate)
      if (rows.length === 0) continue

      // 기존 자동계산 행 삭제 (수동 입력 보존)
      const { error: delErr } = await adminClient
        .from('annual_leave_grants')
        .delete().eq('person_id', person.id).like('note', '근로기준법 자동계산%')
      if (delErr) throw new Error(delErr.message)

      // 삽입 — 수동 행 (year, grant_type) 충돌 시 DO NOTHING
      const insertRows = rows.map(r => ({
        person_id:  person.id,
        year:       r.year,
        grant_type: r.grant_type,
        days:       r.days,
        note:       `${NOTE_PREFIX} | ${r.detail}`,
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

  await adminClient.from('audit_log').insert({
    user_id: user.id, action: 'sync', target_type: 'annual_leave_grants',
    target_id: anchorDate, at: new Date().toISOString(),
  })

  console.log(`[fill-statutory-leave] anchor=${anchorDate} people=${totalPeople} rows=${totalInserted} errors=${errors.length}`)
  return json({ anchorDate, people: totalPeople, inserted: totalInserted, ...(errors.length ? { errors } : {}) })
})
