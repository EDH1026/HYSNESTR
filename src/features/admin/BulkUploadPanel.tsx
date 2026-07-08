/**
 * BulkUploadPanel — §5.11b 일괄 업로드 (admin 전용)
 *
 * 인력·작업항목 각각 CSV 템플릿 다운로드 + 업로드 → 미리보기/검증 → 확정.
 * 작업항목 업로드는 기존 BulkUploadModal 재활용.
 */
import { useState, useRef } from 'react'
import { Upload, Download, AlertTriangle, CheckCircle2, Loader2, Users, Briefcase } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import { supabase }   from '@/lib/supabase'
import { queryKeys }  from '@/lib/queryKeys'
import BulkUploadModal from '@/features/workitems/BulkUploadModal'
import type { Rank } from '@/types'

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

interface RowError { rowNum: number; errors: string[] }

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

function normHeader(h: string): PeopleColKey | null {
  // Accept Korean aliases too
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
  const headers = lines[0].split(',').map(normHeader)
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
  // Fetch existing LPN index
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
      status:           'active',
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

  // audit_log entry
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
// Main panel
// ─────────────────────────────────────────────────────────────────────────────

type SubTab = 'people' | 'workitems'

export default function BulkUploadPanel() {
  const qc = useQueryClient()
  const [sub, setSub] = useState<SubTab>('people')
  const [showWIModal, setShowWIModal] = useState(false)

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

      {/* People upload */}
      {sub === 'people' && (
        <PeopleUpload
          onSuccess={() => void qc.invalidateQueries({ queryKey: queryKeys.people.all() })}
        />
      )}

      {/* Work items upload */}
      {sub === 'workitems' && (
        <div className="space-y-4">
          <p className="text-xs text-muted">
            기존 작업항목 업로드 기능(CSV/XLSX, 추가/전체교체)을 사용합니다.
          </p>
          <button onClick={() => setShowWIModal(true)} className="btn-primary text-xs gap-2">
            <Upload size={13} /> 작업항목 업로드 시작
          </button>
          {showWIModal && (
            <BulkUploadModal
              onClose={() => setShowWIModal(false)}
              onSuccess={() => {
                void qc.invalidateQueries({ queryKey: queryKeys.workItems.all() })
                setShowWIModal(false)
              }}
            />
          )}
        </div>
      )}
    </div>
  )
}
