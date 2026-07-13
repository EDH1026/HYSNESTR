/**
 * BulkUploadModal — PRD v2.12 §5.5a / 부록 C
 *
 * Admin-only CSV/XLSX bulk upload for work_items.
 * Steps: upload → preview/validate → (replace: confirm) → commit → done
 */

import { useState, useRef } from 'react'
import * as XLSX from 'xlsx'
import { Upload, Download, AlertTriangle, CheckCircle2, Loader2 } from 'lucide-react'
import Modal from '@/components/Modal'
import { supabase } from '@/lib/supabase'

// ── Column spec ───────────────────────────────────────────────

const COLUMNS = [
  'type', 'name', 'engagement_number', 'client',
  'start', 'main_start', 'end_date', 'status',
  'description', 'hashtags', 'confidential',
] as const

type ColKey = typeof COLUMNS[number]

// ── Row types ─────────────────────────────────────────────────

interface RawRow { [key: string]: string }

export interface ParsedRow {
  rowNum:   number
  type:             string
  name:             string
  engagement_number: string
  client:           string
  start:            string
  main_start:       string
  end_date:         string
  status:           string
  description:      string
  hashtags:         string
  confidential:     string
}

interface RowError {
  rowNum: number
  errors: string[]
}

// ── Validation helpers ────────────────────────────────────────

const VALID_TYPES = new Set(['project', 'proposal', 'pipeline'])
const DATE_RE     = /^\d{4}-\d{2}-\d{2}$/
const ENG_RE      = /^(?:E-\d{8}|C\d{6}[A-Z]{2}|I-\d{8})$/

function validateRows(rows: ParsedRow[]): RowError[] {
  const errs: RowError[] = []
  for (const r of rows) {
    const e: string[] = []
    if (!r.type)                          e.push('type 필수')
    else if (!VALID_TYPES.has(r.type))    e.push(`type 유효값: project | proposal | pipeline (입력: "${r.type}")`)
    if (!r.name)                          e.push('name 필수')
    if (!r.start)                         e.push('start 필수')
    else if (!DATE_RE.test(r.start))      e.push(`start 날짜 형식 불일치 (YYYY-MM-DD): "${r.start}"`)
    if (r.main_start && !DATE_RE.test(r.main_start))
                                          e.push(`main_start 날짜 형식 불일치: "${r.main_start}"`)
    if (!r.end_date)                      e.push('end_date 필수')
    else if (!DATE_RE.test(r.end_date))   e.push(`end_date 날짜 형식 불일치: "${r.end_date}"`)
    if (r.start && r.end_date && DATE_RE.test(r.start) && DATE_RE.test(r.end_date) && r.start > r.end_date)
                                          e.push('start > end_date')
    if (r.start && r.main_start && DATE_RE.test(r.start) && DATE_RE.test(r.main_start) && r.main_start < r.start)
                                          e.push('main_start < start')
    if (r.main_start && r.end_date && DATE_RE.test(r.main_start) && DATE_RE.test(r.end_date) && r.main_start > r.end_date)
                                          e.push('main_start > end_date')
    if (r.status && !['open', 'closed', ''].includes(r.status))
                                          e.push(`status 유효값: open | closed (입력: "${r.status}")`)
    if (r.engagement_number && !ENG_RE.test(r.engagement_number))
                                          e.push(`engagement_number 형식: E-00000000, C000000AA, 또는 I-00000000 (입력: "${r.engagement_number}")`)
    if (r.confidential && !['true', 'false', ''].includes(r.confidential.toLowerCase()))
                                          e.push(`confidential 유효값: true | false (입력: "${r.confidential}")`)
    if (e.length) errs.push({ rowNum: r.rowNum, errors: e })
  }
  return errs
}

// ── CSV / XLSX parsing ────────────────────────────────────────

function normalizeHeader(h: string): ColKey | null {
  const s = h.trim().toLowerCase()
  return (COLUMNS as readonly string[]).includes(s) ? s as ColKey : null
}

function rawToParsed(raw: RawRow[], startRowNum: number): ParsedRow[] {
  return raw.map((r, i) => ({
    rowNum:            startRowNum + i,
    type:              (r['type']              ?? '').trim().toLowerCase(),
    name:              (r['name']              ?? '').trim(),
    engagement_number: (r['engagement_number'] ?? '').trim(),
    client:            (r['client']            ?? '').trim(),
    start:             (r['start']             ?? '').trim(),
    main_start:        (r['main_start']         ?? '').trim(),
    end_date:          (r['end_date']           ?? '').trim(),
    status:            (r['status']             ?? '').trim().toLowerCase(),
    description:       (r['description']        ?? '').trim(),
    hashtags:          (r['hashtags']           ?? '').trim(),
    confidential:      (r['confidential']       ?? '').trim().toLowerCase(),
  }))
}

function parseFile(file: File): Promise<ParsedRow[]> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = (e) => {
      try {
        const data  = new Uint8Array(e.target!.result as ArrayBuffer)
        const wb    = XLSX.read(data, { type: 'array', cellDates: false })
        const ws    = wb.Sheets[wb.SheetNames[0]]
        const json: string[][] = XLSX.utils.sheet_to_json(ws, {
          header: 1,
          raw:    false,
          defval: '',
        })
        if (json.length < 2) { resolve([]); return }
        const headers = (json[0] as string[]).map(h => normalizeHeader(String(h)))
        const rows: RawRow[] = []
        for (let i = 1; i < json.length; i++) {
          const cells = json[i] as string[]
          const isBlank = cells.every(c => String(c).trim() === '')
          if (isBlank) continue
          const obj: RawRow = {}
          headers.forEach((h, ci) => { if (h) obj[h] = String(cells[ci] ?? '') })
          rows.push(obj)
        }
        resolve(rawToParsed(rows, 2))
      } catch (err) {
        reject(new Error('파일 파싱 실패: ' + String(err)))
      }
    }
    reader.onerror = () => reject(new Error('파일 읽기 실패'))
    reader.readAsArrayBuffer(file)
  })
}

// ── Template download ─────────────────────────────────────────

function downloadTemplate(format: 'csv' | 'xlsx') {
  const header = COLUMNS.join(',')
  const example = 'project,프로젝트명 예시,E-00000001,고객사,2026-01-01,2026-02-01,2026-06-30,open,설명,태그1;태그2,false'
  if (format === 'csv') {
    const blob = new Blob(['﻿' + header + '\n' + example + '\n'], { type: 'text/csv;charset=utf-8' })
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob)
    a.download = 'work_items_template.csv'; a.click()
  } else {
    const ws   = XLSX.utils.aoa_to_sheet([[...COLUMNS], example.split(',')])
    const wb   = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'work_items')
    XLSX.writeFile(wb, 'work_items_template.xlsx')
  }
}

// ── RPC call ─────────────────────────────────────────────────

async function commitBulkUpload(
  mode: 'append' | 'replace',
  rows: ParsedRow[],
): Promise<{ inserted: number; deleted_wi: number; deleted_as: number }> {
  const payload = rows.map(r => ({
    type:              r.type,
    name:              r.name,
    engagement_number: r.engagement_number || null,
    client:            r.client            || null,
    start:             r.start,
    main_start:        r.main_start        || null,
    end_date:          r.end_date,
    status:            r.status            || 'open',
    description:       r.description       || null,
    hashtags:          r.hashtags          || '',
    confidential:      String(r.confidential === 'true'),
  }))

  // bulk_upload_work_items is not in the generated DB types — cast to any to call it
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase as any).rpc('bulk_upload_work_items', {
    p_mode: mode,
    p_rows: payload,
  }) as { data: unknown; error: { message: string } | null }
  if (error) throw new Error(error.message)
  return data as { inserted: number; deleted_wi: number; deleted_as: number }
}

// ── Main component ────────────────────────────────────────────

type Step = 'upload' | 'preview' | 'confirm' | 'committing' | 'done'

interface Props { onClose: () => void; onSuccess: () => void }

export default function BulkUploadModal({ onClose, onSuccess }: Props) {
  const [step,       setStep]       = useState<Step>('upload')
  const [mode,       setMode]       = useState<'append' | 'replace'>('append')
  const [rows,       setRows]       = useState<ParsedRow[]>([])
  const [rowErrors,  setRowErrors]  = useState<RowError[]>([])
  const [parseErr,   setParseErr]   = useState<string | null>(null)
  const [result,     setResult]     = useState<{ inserted: number; deleted_wi: number; deleted_as: number } | null>(null)
  const [commitErr,  setCommitErr]  = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  async function handleFile(file: File) {
    setParseErr(null)
    try {
      const parsed = await parseFile(file)
      if (parsed.length === 0) { setParseErr('데이터 행이 없습니다. 헤더 포함 2행 이상이어야 합니다.'); return }
      const errs = validateRows(parsed)
      setRows(parsed); setRowErrors(errs); setStep('preview')
    } catch (e) {
      setParseErr(e instanceof Error ? e.message : '파싱 오류')
    }
  }

  async function handleCommit() {
    setStep('committing'); setCommitErr(null)
    try {
      const res = await commitBulkUpload(mode, rows)
      setResult(res); setStep('done'); onSuccess()
    } catch (e) {
      setCommitErr(e instanceof Error ? e.message : '서버 오류')
      setStep('preview')
    }
  }

  const hasErrors = rowErrors.length > 0
  const errorMap  = new Map(rowErrors.map(e => [e.rowNum, e.errors]))

  // ── Step: upload ──────────────────────────────────────────
  if (step === 'upload') return (
    <Modal title="작업항목 대량 업로드 (Admin)" onClose={onClose} size="lg">
      <div className="space-y-5">

        {/* Template download */}
        <div className="rounded-md border border-border bg-surface-50 p-4">
          <p className="text-xs font-semibold text-gray-700 mb-2">양식 템플릿 다운로드</p>
          <div className="flex gap-2">
            <button onClick={() => downloadTemplate('csv')}
              className="btn-secondary text-xs gap-1.5">
              <Download size={12} /> CSV 템플릿
            </button>
            <button onClick={() => downloadTemplate('xlsx')}
              className="btn-secondary text-xs gap-1.5">
              <Download size={12} /> XLSX 템플릿
            </button>
          </div>
          <p className="mt-2 text-[11px] text-muted">
            컬럼: {COLUMNS.join(' · ')}
          </p>
        </div>

        {/* Mode selection */}
        <div>
          <p className="text-xs font-semibold text-gray-700 mb-2">업로드 모드</p>
          <div className="flex rounded-md overflow-hidden border border-border w-fit">
            {(['append', 'replace'] as const).map(m => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={[
                  'px-4 py-2 text-xs font-medium transition-colors',
                  mode === m
                    ? m === 'replace'
                      ? 'bg-red-600 text-white'
                      : 'bg-brand-600 text-white'
                    : 'bg-white text-gray-700 hover:bg-surface-50',
                ].join(' ')}
              >
                {m === 'append' ? '추가 (Append)' : '전체 교체 (Replace)'}
              </button>
            ))}
          </div>
          {mode === 'replace' && (
            <div className="mt-2 flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
              <AlertTriangle size={13} className="flex-shrink-0 mt-0.5" />
              <span>전체 교체: 기존 work_items 전량과 연결된 모든 배정(assignments)이 삭제됩니다. 되돌릴 수 없습니다.</span>
            </div>
          )}
        </div>

        {/* File input */}
        <div>
          <p className="text-xs font-semibold text-gray-700 mb-2">파일 선택 (CSV 또는 XLSX)</p>
          <input
            ref={fileRef}
            type="file"
            accept=".csv,.xlsx,.xls"
            className="hidden"
            onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f) }}
          />
          <button
            onClick={() => fileRef.current?.click()}
            className="btn-secondary gap-2 text-xs"
          >
            <Upload size={13} /> 파일 선택…
          </button>
          {parseErr && (
            <p className="mt-2 text-xs text-red-600">{parseErr}</p>
          )}
        </div>
      </div>
    </Modal>
  )

  // ── Step: preview ─────────────────────────────────────────
  if (step === 'preview') return (
    <Modal title="업로드 미리보기" onClose={onClose} size="xl">
      <div className="space-y-4">

        {/* Summary */}
        <div className="flex items-center gap-4 text-xs">
          <span className="font-medium text-gray-700">총 {rows.length}행</span>
          <span className={`pill ${mode === 'replace' ? 'bg-red-100 text-red-700' : 'bg-brand-100 text-brand-700'}`}>
            {mode === 'append' ? '추가 모드' : '전체 교체 모드'}
          </span>
          {hasErrors
            ? <span className="flex items-center gap-1 text-red-600 font-medium"><AlertTriangle size={12} />{rowErrors.length}행 오류 — 커밋 불가</span>
            : <span className="flex items-center gap-1 text-emerald-600 font-medium"><CheckCircle2 size={12} />검증 통과</span>
          }
        </div>

        {/* Error list */}
        {hasErrors && (
          <div className="rounded-md border border-red-200 bg-red-50 p-3 space-y-1 max-h-40 overflow-y-auto">
            {rowErrors.map(e => (
              <div key={e.rowNum} className="text-xs text-red-700">
                <span className="font-semibold">행 {e.rowNum}:</span> {e.errors.join(' · ')}
              </div>
            ))}
          </div>
        )}

        {commitErr && (
          <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{commitErr}</div>
        )}

        {/* Preview table */}
        <div className="overflow-auto max-h-80 rounded-md border border-border">
          <table className="w-full text-xs min-w-max">
            <thead className="sticky top-0 bg-surface-50 border-b border-border">
              <tr>
                <th className="px-2 py-1.5 text-left text-muted w-10">#</th>
                {COLUMNS.map(c => (
                  <th key={c} className="px-2 py-1.5 text-left text-muted whitespace-nowrap">{c}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map(r => {
                const errs = errorMap.get(r.rowNum)
                return (
                  <tr key={r.rowNum} className={errs ? 'bg-red-50' : 'hover:bg-surface-50'}>
                    <td className={`px-2 py-1 font-mono ${errs ? 'text-red-600 font-bold' : 'text-muted'}`}>
                      {r.rowNum}
                    </td>
                    {COLUMNS.map(c => (
                      <td key={c} className={`px-2 py-1 truncate max-w-[140px] ${errs ? 'text-red-700' : 'text-gray-700'}`}>
                        {r[c as keyof ParsedRow] || <span className="text-muted/50">—</span>}
                      </td>
                    ))}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        {/* Actions */}
        <div className="flex gap-2 pt-1">
          <button onClick={() => { setStep('upload'); setRows([]); setRowErrors([]) }}
            className="btn-secondary text-xs">
            다시 선택
          </button>
          <button
            disabled={hasErrors}
            onClick={() => mode === 'replace' ? setStep('confirm') : handleCommit()}
            className={[
              'btn-primary text-xs flex-1',
              hasErrors ? 'opacity-40 cursor-not-allowed' : '',
            ].join(' ')}
          >
            {mode === 'replace' ? '다음 (전체 교체 확인)' : `${rows.length}행 추가 커밋`}
          </button>
        </div>
      </div>
    </Modal>
  )

  // ── Step: confirm (replace 전용 2차 확인) ─────────────────
  if (step === 'confirm') return (
    <Modal title="전체 교체 최종 확인" onClose={onClose} size="sm">
      <div className="space-y-4">
        <div className="flex items-start gap-3 rounded-md border border-red-300 bg-red-50 p-4">
          <AlertTriangle size={20} className="text-red-600 flex-shrink-0 mt-0.5" />
          <div className="text-sm text-red-800 space-y-1.5">
            <p className="font-semibold">이 작업은 되돌릴 수 없습니다.</p>
            <ul className="list-disc list-inside text-xs space-y-0.5">
              <li>기존 work_items 전량 삭제</li>
              <li>연결된 모든 assignments(배정) 삭제</li>
              <li>새 {rows.length}행으로 대체</li>
            </ul>
          </div>
        </div>
        <div className="flex gap-2">
          <button onClick={() => setStep('preview')} className="btn-secondary text-xs flex-1">취소</button>
          <button
            onClick={handleCommit}
            className="flex-1 py-2 text-xs font-semibold bg-red-600 text-white rounded-md hover:bg-red-700 transition-colors"
          >
            전체 교체 실행
          </button>
        </div>
      </div>
    </Modal>
  )

  // ── Step: committing ──────────────────────────────────────
  if (step === 'committing') return (
    <Modal title="업로드 중…" onClose={() => {}} size="sm">
      <div className="flex flex-col items-center gap-3 py-8">
        <Loader2 size={28} className="animate-spin text-brand-600" />
        <p className="text-sm text-muted">서버에 반영 중…</p>
      </div>
    </Modal>
  )

  // ── Step: done ────────────────────────────────────────────
  return (
    <Modal title="업로드 완료" onClose={onClose} size="sm">
      <div className="space-y-4">
        <div className="flex items-center gap-3 rounded-md border border-emerald-200 bg-emerald-50 p-4">
          <CheckCircle2 size={20} className="text-emerald-600 flex-shrink-0" />
          <div className="text-sm text-emerald-800">
            <p className="font-semibold">성공적으로 업로드되었습니다.</p>
            <p className="text-xs mt-0.5">
              삽입 {result?.inserted}행
              {mode === 'replace' && ` · 삭제된 work_items ${result?.deleted_wi}행 · 삭제된 배정 ${result?.deleted_as}행`}
            </p>
          </div>
        </div>
        <button onClick={onClose} className="btn-primary w-full text-xs">닫기</button>
      </div>
    </Modal>
  )
}
