/**
 * BulkUploadPanel — §5.11b 일괄 업로드 (admin 전용)
 *
 * 인력·작업항목 각각 CSV 템플릿 다운로드 + 업로드 → 미리보기/검증 → 확정.
 * 인력: LPN 매칭으로 upsert
 * 작업항목: Engagement No. 매칭으로 upsert (B-5, B-6)
 */
import { useState, useRef } from 'react'
import { Upload, Download, AlertTriangle, CheckCircle2, Loader2, Users, Briefcase } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import { supabase }   from '@/lib/supabase'
import { queryKeys }  from '@/lib/queryKeys'
import type { Rank } from '@/types'

// ─────────────────────────────────────────────────────────────────────────────
// Shared
// ─────────────────────────────────────────────────────────────────────────────

interface RowError { rowNum: number; errors: string[] }

// ─────────────────────────────────────────────────────────────────────────────
// People CSV spec
// ─────────────────────────────────────────────────────────────────────────────

const PEOPLE_COLS = ['lpn', 'name', 'rank', 'role', 'hire_date', 'termination_date'] as const
type PeopleColKey = typeof PEOPLE_COLS[number]

const VALID_RANKS = new Set<string>(['Partner', 'SM', 'M', 'Senior', 'Staff', 'Intern'])
const DATE_RE     = /^\d{4}-\d{2}-\d{2}$/
const LPN_RE      = /^\d{5}$/

interface PersonRow {
  rowNum:           number
  lpn:              string
  name:             string
  rank:             string
  role:             string
  hire_date:        string
  termination_date: string
}

function validatePeopleRows(rows: PersonRow[]): RowError[] {
  const errs: RowError[] = []
  const seenLpns = new Set<string>()
  for (const r of rows) {
    const e: string[] = []
    if (!r.name)                           e.push('이름(name) 필수')
    if (!r.rank)                           e.push('직급(rank) 필수')
    else if (!VALID_RANKS.has(r.rank))     e.push(`직급 유효값: ${[...VALID_RANKS].join('|')} (입력: "${r.rank}")`)
    if (r.lpn && !LPN_RE.test(r.lpn))     e.push(`LPN 형식: 5자리 숫자 (입력: "${r.lpn}")`)
    if (r.lpn && seenLpns.has(r.lpn))     e.push(`LPN 중복: "${r.lpn}"`)
    if (r.lpn) seenLpns.add(r.lpn)
    if (r.hire_date && !DATE_RE.test(r.hire_date))
                                           e.push(`입사일 날짜 형식 (YYYY-MM-DD): "${r.hire_date}"`)
    if (r.termination_date && !DATE_RE.test(r.termination_date))
                                           e.push(`퇴사일 날짜 형식 (YYYY-MM-DD): "${r.termination_date}"`)
    if (r.hire_date && r.termination_date
        && DATE_RE.test(r.hire_date) && DATE_RE.test(r.termination_date)
        && r.termination_date < r.hire_date)
                                           e.push('퇴사일 < 입사일')
    if (e.length) errs.push({ rowNum: r.rowNum, errors: e })
  }
  return errs
}

function normPeopleHeader(h: string): PeopleColKey | null {
  const map: Record<string, PeopleColKey> = {
    lpn: 'lpn', '인력번호': 'lpn',
    name: 'name', '이름': 'name',
    rank: 'rank', '직급': 'rank',
    role: 'role', '역할': 'role',
    hire_date: 'hire_date', '입사일': 'hire_date',
    termination_date: 'termination_date', '퇴사일': 'termination_date',
  }
  return map[h.trim()] ?? null
}

function parsePeopleCSV(text: string): PersonRow[] {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
  if (lines.length < 2) return []
  const headers = lines[0].split(',').map(normPeopleHeader)
  const rows: PersonRow[] = []
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(',')
    if (cells.every(c => c.trim() === '')) continue
    const obj: Partial<Record<PeopleColKey, string>> = {}
    headers.forEach((h, ci) => { if (h) obj[h] = (cells[ci] ?? '').trim() })
    rows.push({
      rowNum:           i + 1,
      lpn:              obj.lpn              ?? '',
      name:             obj.name             ?? '',
      rank:             obj.rank             ?? '',
      role:             obj.role             ?? '',
      hire_date:        obj.hire_date        ?? '',
      termination_date: obj.termination_date ?? '',
    })
  }
  return rows
}

function downloadPeopleTemplate() {
  const header  = PEOPLE_COLS.join(',')
  const example = '12345,홍길동,Senior,전략팀,2024-03-01,'
  const blob = new Blob(['﻿' + header + '\n' + example + '\n'], { type: 'text/csv;charset=utf-8' })
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob)
  a.download = 'people_template.csv'; a.click()
}

// ─────────────────────────────────────────────────────────────────────────────
// People commit
// ─────────────────────────────────────────────────────────────────────────────

interface CommitResult { inserted: number; updated: number; failed: number; errors: string[] }

async function commitPeople(rows: PersonRow[], upsertOnLPN: boolean): Promise<CommitResult> {
  const { data: existing, error: fetchErr } = await (supabase
    .from('people').select('id, lpn') as any as Promise<{ data: { id: string; lpn: string | null }[] | null; error: { message: string } | null }>)
  if (fetchErr) throw new Error(fetchErr.message)
  const lpnMap = new Map<string, string>()
  for (const p of existing ?? []) {
    if (p.lpn) lpnMap.set(p.lpn, p.id)
  }

  let inserted = 0; let updated = 0; const errors: string[] = []

  for (const r of rows) {
    const payload: Record<string, unknown> = {
      name:             r.name,
      rank:             r.rank as Rank,
      role:             r.role  || '',
      lpn:              r.lpn   || null,
      hire_date:        r.hire_date        || null,
      termination_date: r.termination_date || null,
      // status is not written — computed at read time from hire_date/termination_date
    }
    const existingId = r.lpn ? lpnMap.get(r.lpn) : undefined
    if (existingId && upsertOnLPN) {
      const { error } = await supabase.from('people').update(payload as any).eq('id', existingId)
      if (error) errors.push(`행 ${r.rowNum} 갱신 실패: ${error.message}`)
      else updated++
    } else {
      const { error } = await supabase.from('people').insert(payload as any)
      if (error) errors.push(`행 ${r.rowNum} 삽입 실패: ${error.message}`)
      else inserted++
    }
  }

  const { error: auditErr } = await supabase.from('audit_log').insert({
    action:      'bulk_upload',
    target_type: 'people',
    target_id:   'bulk',
    at:          new Date().toISOString(),
  } as any)
  if (auditErr) console.warn('audit_log 기록 실패:', auditErr.message)

  return { inserted, updated, failed: errors.length, errors }
}

// ─────────────────────────────────────────────────────────────────────────────
// People upload step UI
// ─────────────────────────────────────────────────────────────────────────────

type PeopleStep = 'upload' | 'preview' | 'committing' | 'done'

function PeopleUpload({ onSuccess }: { onSuccess: () => void }) {
  const fileRef = useRef<HTMLInputElement>(null)
  const [step,        setStep]        = useState<PeopleStep>('upload')
  const [rows,        setRows]        = useState<PersonRow[]>([])
  const [rowErrors,   setRowErrors]   = useState<RowError[]>([])
  const [parseErr,    setParseErr]    = useState<string | null>(null)
  const [commitErr,   setCommitErr]   = useState<string | null>(null)
  const [result,      setResult]      = useState<CommitResult | null>(null)
  const [upsert,      setUpsert]      = useState(true)

  async function handleFile(file: File) {
    setParseErr(null)
    try {
      const text = await file.text()
      const parsed = parsePeopleCSV(text)
      if (parsed.length === 0) { setParseErr('데이터 행이 없습니다.'); return }
      const errs = validatePeopleRows(parsed)
      setRows(parsed); setRowErrors(errs); setStep('preview')
    } catch (e) {
      setParseErr(e instanceof Error ? e.message : '파싱 오류')
    }
  }

  async function handleCommit() {
    setStep('committing'); setCommitErr(null)
    try {
      const res = await commitPeople(rows.filter(r => !errorMap.get(r.rowNum)), upsert)
      setResult(res); setStep('done'); onSuccess()
    } catch (e) {
      setCommitErr(e instanceof Error ? e.message : '서버 오류')
      setStep('preview')
    }
  }

  const hasErrors = rowErrors.length > 0
  const errorMap  = new Map(rowErrors.map(e => [e.rowNum, e.errors]))
  const validRows = rows.filter(r => !errorMap.get(r.rowNum))

  if (step === 'upload') return (
    <div className="space-y-5">
      <div className="rounded-md border border-border bg-surface-50 p-4">
        <p className="text-xs font-semibold text-gray-700 mb-2">인력 CSV 템플릿 다운로드</p>
        <button onClick={downloadPeopleTemplate} className="btn-secondary text-xs gap-1.5">
          <Download size={12} /> CSV 템플릿
        </button>
        <p className="mt-2 text-[11px] text-muted">컬럼: {PEOPLE_COLS.join(' · ')}</p>
      </div>

      <div>
        <p className="text-xs font-semibold text-gray-700 mb-2">LPN 일치 인력 처리</p>
        <label className="flex items-center gap-2 text-sm cursor-pointer">
          <input type="checkbox" checked={upsert} onChange={e => setUpsert(e.target.checked)}
            className="rounded" />
          <span>기존 LPN 일치 인력 갱신 (미체크 시 중복 무시)</span>
        </label>
      </div>

      <div>
        <p className="text-xs font-semibold text-gray-700 mb-2">CSV 파일 선택</p>
        <input ref={fileRef} type="file" accept=".csv" className="hidden"
          onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f) }} />
        <button onClick={() => fileRef.current?.click()} className="btn-secondary gap-2 text-xs">
          <Upload size={13} /> 파일 선택…
        </button>
        {parseErr && <p className="mt-2 text-xs text-red-600">{parseErr}</p>}
      </div>
    </div>
  )

  if (step === 'preview') return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-4 text-xs">
        <span className="font-medium text-gray-700">총 {rows.length}행</span>
        {hasErrors
          ? <span className="flex items-center gap-1 text-amber-600"><AlertTriangle size={12} />{rowErrors.length}행 오류 — 오류 행 제외 후 반영 가능</span>
          : <span className="flex items-center gap-1 text-emerald-600"><CheckCircle2 size={12} />검증 통과</span>
        }
        <span className="text-muted">반영 대상: {validRows.length}행</span>
      </div>

      {hasErrors && (
        <div className="rounded-md border border-amber-200 bg-amber-50 p-3 space-y-1 max-h-32 overflow-y-auto">
          {rowErrors.map(e => (
            <div key={e.rowNum} className="text-xs text-amber-800">
              <span className="font-semibold">행 {e.rowNum}:</span> {e.errors.join(' · ')}
            </div>
          ))}
        </div>
      )}

      {commitErr && (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{commitErr}</div>
      )}

      <div className="overflow-auto max-h-72 rounded-md border border-border">
        <table className="w-full text-xs min-w-max">
          <thead className="sticky top-0 bg-surface-50 border-b border-border">
            <tr>
              <th className="px-2 py-1.5 text-left text-muted w-10">#</th>
              {PEOPLE_COLS.map(c => (
                <th key={c} className="px-2 py-1.5 text-left text-muted whitespace-nowrap">{c}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map(r => {
              const errs = errorMap.get(r.rowNum)
              return (
                <tr key={r.rowNum} className={errs ? 'bg-amber-50' : 'hover:bg-surface-50'}>
                  <td className={`px-2 py-1 font-mono ${errs ? 'text-amber-600 font-bold' : 'text-muted'}`}>
                    {r.rowNum}
                  </td>
                  {PEOPLE_COLS.map(c => (
                    <td key={c} className={`px-2 py-1 max-w-[140px] truncate ${errs ? 'text-amber-800' : 'text-gray-700'}`}>
                      {r[c] || <span className="text-muted/50">—</span>}
                    </td>
                  ))}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <div className="flex gap-2 pt-1">
        <button onClick={() => { setStep('upload'); setRows([]); setRowErrors([]) }}
          className="btn-secondary text-xs">다시 선택</button>
        <button
          disabled={validRows.length === 0}
          onClick={handleCommit}
          className={['btn-primary text-xs flex-1', validRows.length === 0 ? 'opacity-40 cursor-not-allowed' : ''].join(' ')}
        >
          {validRows.length}행 반영 {hasErrors && `(${rowErrors.length}행 오류 제외)`}
        </button>
      </div>
    </div>
  )

  if (step === 'committing') return (
    <div className="flex flex-col items-center gap-3 py-10">
      <Loader2 size={28} className="animate-spin text-brand-600" />
      <p className="text-sm text-muted">서버에 반영 중…</p>
    </div>
  )

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 rounded-md border border-emerald-200 bg-emerald-50 p-4">
        <CheckCircle2 size={20} className="text-emerald-600 flex-shrink-0" />
        <div className="text-sm text-emerald-800">
          <p className="font-semibold">업로드 완료</p>
          <p className="text-xs mt-0.5">
            신규 {result?.inserted}명 · 갱신 {result?.updated}명
            {(result?.failed ?? 0) > 0 && ` · 실패 ${result!.failed}건`}
          </p>
        </div>
      </div>
      {(result?.errors ?? []).length > 0 && (
        <div className="rounded-md border border-red-200 bg-red-50 p-3 max-h-32 overflow-y-auto space-y-0.5">
          {result!.errors.map((e, i) => <p key={i} className="text-xs text-red-700">{e}</p>)}
        </div>
      )}
      <button onClick={() => { setStep('upload'); setRows([]); setRowErrors([]); setResult(null) }}
        className="btn-secondary text-xs">다시 업로드</button>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Work Items CSV spec (B-5, B-6)
// ─────────────────────────────────────────────────────────────────────────────

const WI_COLS = [
  'type', 'name', 'engagement_number', 'client',
  'start', 'main_start', 'end_date', 'status',
  'description', 'hashtags', 'confidential',
] as const
type WIColKey = typeof WI_COLS[number]

const VALID_WI_TYPES = new Set(['project', 'proposal', 'pipeline'])
const WI_DATE_RE     = /^\d{4}-\d{2}-\d{2}$/
const ENG_RE         = /^E-\d{8}$/

interface WIRow {
  rowNum:            number
  type:              string
  name:              string
  engagement_number: string
  client:            string
  start:             string
  main_start:        string
  end_date:          string
  status:            string
  description:       string
  hashtags:          string
  confidential:      string
  matchStatus:       'new' | 'update'
  existingId?:       string
}

function validateWIRows(rows: WIRow[]): RowError[] {
  const errs: RowError[] = []
  const seenEngs = new Set<string>()
  for (const r of rows) {
    const e: string[] = []
    if (!r.type)                          e.push('type 필수')
    else if (!VALID_WI_TYPES.has(r.type)) e.push(`type 유효값: project|proposal|pipeline (입력: "${r.type}")`)
    if (!r.name)                          e.push('name 필수')
    if (!r.start)                         e.push('start 필수')
    else if (!WI_DATE_RE.test(r.start))   e.push(`start 날짜 형식 (YYYY-MM-DD): "${r.start}"`)
    if (r.main_start && !WI_DATE_RE.test(r.main_start))
                                          e.push(`main_start 날짜 형식: "${r.main_start}"`)
    if (!r.end_date)                      e.push('end_date 필수')
    else if (!WI_DATE_RE.test(r.end_date)) e.push(`end_date 날짜 형식: "${r.end_date}"`)
    if (r.start && r.end_date && WI_DATE_RE.test(r.start) && WI_DATE_RE.test(r.end_date) && r.start > r.end_date)
                                          e.push('start > end_date')
    if (r.start && r.main_start && WI_DATE_RE.test(r.start) && WI_DATE_RE.test(r.main_start) && r.main_start < r.start)
                                          e.push('main_start < start')
    if (r.main_start && r.end_date && WI_DATE_RE.test(r.main_start) && WI_DATE_RE.test(r.end_date) && r.main_start > r.end_date)
                                          e.push('main_start > end_date')
    if (r.status && !['open', 'closed', ''].includes(r.status))
                                          e.push(`status 유효값: open|closed (입력: "${r.status}")`)
    if (r.engagement_number && !ENG_RE.test(r.engagement_number))
                                          e.push(`engagement_number 형식: E-00000000 (입력: "${r.engagement_number}")`)
    if (r.confidential && !['true', 'false', ''].includes(r.confidential))
                                          e.push(`confidential 유효값: true|false`)
    // CSV 내 Engagement No. 중복 검사
    if (r.engagement_number) {
      if (seenEngs.has(r.engagement_number)) e.push(`CSV 내 Engagement No. 중복: "${r.engagement_number}"`)
      seenEngs.add(r.engagement_number)
    }
    if (e.length) errs.push({ rowNum: r.rowNum, errors: e })
  }
  return errs
}

function normWIHeader(h: string): WIColKey | null {
  const map: Record<string, WIColKey> = {
    type: 'type', '유형': 'type',
    name: 'name', '이름': 'name', '프로젝트명': 'name',
    engagement_number: 'engagement_number', 'engagement no': 'engagement_number',
    '인게이지먼트번호': 'engagement_number',
    client: 'client', '고객사': 'client',
    start: 'start', '시작일': 'start',
    main_start: 'main_start', '본사업시작일': 'main_start',
    end_date: 'end_date', '종료일': 'end_date',
    status: 'status', '상태': 'status',
    description: 'description', '설명': 'description',
    hashtags: 'hashtags', '해시태그': 'hashtags',
    confidential: 'confidential', '기밀': 'confidential',
  }
  return map[h.trim().toLowerCase()] ?? null
}

// Splits a single CSV line respecting double-quote enclosure.
function splitCSVLine(line: string): string[] {
  const result: string[] = []
  let current = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (c === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++ }
      else { inQuotes = !inQuotes }
    } else if (c === ',' && !inQuotes) {
      result.push(current.trim()); current = ''
    } else {
      current += c
    }
  }
  result.push(current.trim())
  return result
}

function parseWICSV(text: string): Omit<WIRow, 'matchStatus' | 'existingId'>[] {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
  if (lines.length < 2) return []
  const headers = splitCSVLine(lines[0]).map(normWIHeader)
  const rows: Omit<WIRow, 'matchStatus' | 'existingId'>[] = []
  for (let i = 1; i < lines.length; i++) {
    const cells = splitCSVLine(lines[i])
    if (cells.every(c => c === '')) continue
    const obj: Partial<Record<WIColKey, string>> = {}
    headers.forEach((h, ci) => { if (h) obj[h] = (cells[ci] ?? '').trim() })
    rows.push({
      rowNum:            i + 1,
      type:              (obj.type              ?? '').toLowerCase(),
      name:              obj.name               ?? '',
      engagement_number: obj.engagement_number  ?? '',
      client:            obj.client             ?? '',
      start:             obj.start              ?? '',
      main_start:        obj.main_start         ?? '',
      end_date:          obj.end_date           ?? '',
      status:            (obj.status            ?? '').toLowerCase(),
      description:       obj.description        ?? '',
      hashtags:          obj.hashtags           ?? '',
      confidential:      (obj.confidential      ?? '').toLowerCase(),
    })
  }
  return rows
}

function downloadWITemplate() {
  const header  = WI_COLS.join(',')
  const example = 'project,프로젝트명 예시,E-00000001,고객사,2026-01-01,2026-02-01,2026-06-30,open,설명,태그1;태그2,false'
  const blob = new Blob(['﻿' + header + '\n' + example + '\n'], { type: 'text/csv;charset=utf-8' })
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob)
  a.download = 'work_items_template.csv'; a.click()
}

// ─────────────────────────────────────────────────────────────────────────────
// Work Items commit
// ─────────────────────────────────────────────────────────────────────────────

async function commitWorkItems(rows: WIRow[]): Promise<CommitResult> {
  let inserted = 0; let updated = 0
  const errors: string[] = []
  const auditRows: Record<string, unknown>[] = []
  const now = new Date().toISOString()

  for (const r of rows) {
    const payload: Record<string, unknown> = {
      type:              r.type,
      name:              r.name,
      engagement_number: r.engagement_number || null,
      client:            r.client            || null,
      start:             r.start,
      main_start:        r.main_start        || null,
      end_date:          r.end_date,
      status:            r.status            || 'open',
      description:       r.description       || null,
      hashtags:          r.hashtags
        ? r.hashtags.split(';').map((t: string) => t.trim()).filter(Boolean)
        : [],
      confidential:      r.confidential === 'true',
    }

    if (r.existingId) {
      // UPDATE — preserves all assignments tied to this work item
      const { error } = await (supabase.from('work_items') as any).update(payload).eq('id', r.existingId)
      if (error) { errors.push(`행 ${r.rowNum} 갱신 실패: ${error.message}`); continue }
      auditRows.push({ action: 'bulk_update', target_type: 'work_items', target_id: r.existingId, at: now })
      updated++
    } else {
      const { data: created, error } = await (supabase.from('work_items') as any).insert(payload).select('id').single()
      if (error) { errors.push(`행 ${r.rowNum} 삽입 실패: ${error.message}`); continue }
      auditRows.push({ action: 'bulk_create', target_type: 'work_items', target_id: (created as any)?.id ?? 'unknown', at: now })
      inserted++
    }
  }

  if (auditRows.length > 0) {
    const { error: auditErr } = await (supabase.from('audit_log') as any).insert(auditRows)
    if (auditErr) console.warn('audit_log 기록 실패:', auditErr.message)
  }

  return { inserted, updated, failed: errors.length, errors }
}

// ─────────────────────────────────────────────────────────────────────────────
// Work Items upload step UI
// ─────────────────────────────────────────────────────────────────────────────

type WIStep = 'upload' | 'preview' | 'committing' | 'done'

function WorkItemsUpload({ onSuccess }: { onSuccess: () => void }) {
  const fileRef = useRef<HTMLInputElement>(null)
  const [step,      setStep]      = useState<WIStep>('upload')
  const [rows,      setRows]      = useState<WIRow[]>([])
  const [rowErrors, setRowErrors] = useState<RowError[]>([])
  const [parseErr,  setParseErr]  = useState<string | null>(null)
  const [commitErr, setCommitErr] = useState<string | null>(null)
  const [result,    setResult]    = useState<CommitResult | null>(null)

  async function handleFile(file: File) {
    setParseErr(null)
    try {
      const text = await file.text()
      const parsed = parseWICSV(text)
      if (parsed.length === 0) { setParseErr('데이터 행이 없습니다.'); return }

      // Fetch existing engagement_numbers from DB to determine 신규/갱신
      const engNos = [...new Set(parsed.map(r => r.engagement_number).filter(Boolean))]
      const engMap = new Map<string, string>() // engagement_number → work_item id
      if (engNos.length > 0) {
        const { data: existing } = await (supabase
          .from('work_items')
          .select('id, engagement_number')
          .in('engagement_number', engNos) as any) as { data: { id: string; engagement_number: string }[] | null }
        for (const wi of existing ?? []) {
          if (wi.engagement_number) engMap.set(wi.engagement_number, wi.id)
        }
      }

      const annotated: WIRow[] = parsed.map(r => ({
        ...r,
        existingId:  r.engagement_number ? engMap.get(r.engagement_number) : undefined,
        matchStatus: (r.engagement_number && engMap.has(r.engagement_number)) ? 'update' as const : 'new' as const,
      }))

      const errs = validateWIRows(annotated)
      setRows(annotated); setRowErrors(errs); setStep('preview')
    } catch (e) {
      setParseErr(e instanceof Error ? e.message : '파싱 오류')
    }
  }

  async function handleCommit() {
    setStep('committing'); setCommitErr(null)
    const errorRowNums = new Set(rowErrors.map(e => e.rowNum))
    try {
      const res = await commitWorkItems(rows.filter(r => !errorRowNums.has(r.rowNum)))
      setResult(res); setStep('done'); onSuccess()
    } catch (e) {
      setCommitErr(e instanceof Error ? e.message : '서버 오류')
      setStep('preview')
    }
  }

  const hasErrors = rowErrors.length > 0
  const errorMap  = new Map(rowErrors.map(e => [e.rowNum, e.errors]))
  const validRows = rows.filter(r => !errorMap.get(r.rowNum))
  const newCount  = validRows.filter(r => r.matchStatus === 'new').length
  const upCount   = validRows.filter(r => r.matchStatus === 'update').length

  if (step === 'upload') return (
    <div className="space-y-5">
      <div className="rounded-md border border-border bg-surface-50 p-4">
        <p className="text-xs font-semibold text-gray-700 mb-2">작업항목 CSV 템플릿 다운로드</p>
        <button onClick={downloadWITemplate} className="btn-secondary text-xs gap-1.5">
          <Download size={12} /> CSV 템플릿
        </button>
        <p className="mt-2 text-[11px] text-muted">컬럼: {WI_COLS.join(' · ')}</p>
        <p className="mt-1 text-[11px] text-muted">
          Engagement No.(<code>E-00000000</code>) 일치 항목은 기존 작업항목을 갱신(배정 유지)하고, 미일치는 신규 등록합니다.
        </p>
      </div>

      <div>
        <p className="text-xs font-semibold text-gray-700 mb-2">CSV 파일 선택</p>
        <input ref={fileRef} type="file" accept=".csv" className="hidden"
          onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f) }} />
        <button onClick={() => fileRef.current?.click()} className="btn-secondary gap-2 text-xs">
          <Upload size={13} /> 파일 선택…
        </button>
        {parseErr && <p className="mt-2 text-xs text-red-600">{parseErr}</p>}
      </div>
    </div>
  )

  if (step === 'preview') return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 text-xs">
        <span className="font-medium text-gray-700">총 {rows.length}행</span>
        {hasErrors
          ? <span className="flex items-center gap-1 text-amber-600"><AlertTriangle size={12} />{rowErrors.length}행 오류 — 오류 행 제외 후 반영 가능</span>
          : <span className="flex items-center gap-1 text-emerald-600"><CheckCircle2 size={12} />검증 통과</span>
        }
        <span className="pill bg-brand-100 text-brand-700">신규 {newCount}건</span>
        <span className="pill bg-emerald-100 text-emerald-700">갱신 {upCount}건</span>
      </div>

      {hasErrors && (
        <div className="rounded-md border border-amber-200 bg-amber-50 p-3 space-y-1 max-h-32 overflow-y-auto">
          {rowErrors.map(e => (
            <div key={e.rowNum} className="text-xs text-amber-800">
              <span className="font-semibold">행 {e.rowNum}:</span> {e.errors.join(' · ')}
            </div>
          ))}
        </div>
      )}

      {commitErr && (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{commitErr}</div>
      )}

      <div className="overflow-auto max-h-72 rounded-md border border-border">
        <table className="w-full text-xs min-w-max">
          <thead className="sticky top-0 bg-surface-50 border-b border-border">
            <tr>
              <th className="px-2 py-1.5 text-left text-muted w-10">#</th>
              <th className="px-2 py-1.5 text-left text-muted whitespace-nowrap">상태</th>
              {WI_COLS.map(c => (
                <th key={c} className="px-2 py-1.5 text-left text-muted whitespace-nowrap">{c}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map(r => {
              const errs = errorMap.get(r.rowNum)
              return (
                <tr key={r.rowNum} className={errs ? 'bg-amber-50' : 'hover:bg-surface-50'}>
                  <td className={`px-2 py-1 font-mono ${errs ? 'text-amber-600 font-bold' : 'text-muted'}`}>
                    {r.rowNum}
                  </td>
                  <td className="px-2 py-1">
                    {errs ? null : r.matchStatus === 'update'
                      ? <span className="pill bg-emerald-100 text-emerald-700 text-[10px]">갱신</span>
                      : <span className="pill bg-brand-100 text-brand-700 text-[10px]">신규</span>
                    }
                  </td>
                  {WI_COLS.map(c => (
                    <td key={c} className={`px-2 py-1 max-w-[140px] truncate ${errs ? 'text-amber-800' : 'text-gray-700'}`}>
                      {r[c as WIColKey] || <span className="text-muted/50">—</span>}
                    </td>
                  ))}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <div className="flex gap-2 pt-1">
        <button onClick={() => { setStep('upload'); setRows([]); setRowErrors([]) }}
          className="btn-secondary text-xs">다시 선택</button>
        <button
          disabled={validRows.length === 0}
          onClick={handleCommit}
          className={['btn-primary text-xs flex-1', validRows.length === 0 ? 'opacity-40 cursor-not-allowed' : ''].join(' ')}
        >
          {validRows.length}행 반영
          {hasErrors && ` (${rowErrors.length}행 오류 제외)`}
          {newCount > 0 && ` · 신규 ${newCount}`}
          {upCount  > 0 && ` · 갱신 ${upCount}`}
        </button>
      </div>
    </div>
  )

  if (step === 'committing') return (
    <div className="flex flex-col items-center gap-3 py-10">
      <Loader2 size={28} className="animate-spin text-brand-600" />
      <p className="text-sm text-muted">서버에 반영 중…</p>
    </div>
  )

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 rounded-md border border-emerald-200 bg-emerald-50 p-4">
        <CheckCircle2 size={20} className="text-emerald-600 flex-shrink-0" />
        <div className="text-sm text-emerald-800">
          <p className="font-semibold">업로드 완료</p>
          <p className="text-xs mt-0.5">
            신규 {result?.inserted}건 · 갱신 {result?.updated}건
            {(result?.failed ?? 0) > 0 && ` · 실패 ${result!.failed}건`}
          </p>
        </div>
      </div>
      {(result?.errors ?? []).length > 0 && (
        <div className="rounded-md border border-red-200 bg-red-50 p-3 max-h-32 overflow-y-auto space-y-0.5">
          {result!.errors.map((e, i) => <p key={i} className="text-xs text-red-700">{e}</p>)}
        </div>
      )}
      <button onClick={() => { setStep('upload'); setRows([]); setRowErrors([]); setResult(null) }}
        className="btn-secondary text-xs">다시 업로드</button>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Main panel
// ─────────────────────────────────────────────────────────────────────────────

type SubTab = 'people' | 'workitems'

export default function BulkUploadPanel() {
  const qc = useQueryClient()
  const [sub, setSub] = useState<SubTab>('people')

  const subTabs: { id: SubTab; label: string; icon: React.ReactNode }[] = [
    { id: 'people',    label: '인력',    icon: <Users    size={13} /> },
    { id: 'workitems', label: '작업항목', icon: <Briefcase size={13} /> },
  ]

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-sm font-semibold text-gray-800 mb-1">일괄 업로드</h2>
        <p className="text-xs text-muted">CSV 파일로 인력 또는 작업항목을 대량 등록·갱신합니다. Admin 전용.</p>
      </div>

      {/* Sub-tab */}
      <div className="flex gap-1 border-b border-border">
        {subTabs.map(t => (
          <button key={t.id} onClick={() => setSub(t.id)}
            className={[
              'flex items-center gap-1.5 px-4 py-2 text-sm font-medium transition-colors',
              sub === t.id
                ? 'border-b-2 border-brand-600 text-brand-700'
                : 'text-muted hover:text-gray-900',
            ].join(' ')}
          >
            {t.icon}{t.label}
          </button>
        ))}
      </div>

      {sub === 'people' && (
        <PeopleUpload
          onSuccess={() => void qc.invalidateQueries({ queryKey: queryKeys.people.all() })}
        />
      )}

      {sub === 'workitems' && (
        <WorkItemsUpload
          onSuccess={() => void qc.invalidateQueries({ queryKey: queryKeys.workItems.all() })}
        />
      )}
    </div>
  )
}
