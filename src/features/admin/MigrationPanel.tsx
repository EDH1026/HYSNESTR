/**
 * MigrationPanel — one-time import of localStorage / JSON prototype data
 * Embedded in AdminPage (admin-only via AdminPage guard).
 */
import { useState, useMemo } from 'react'
import { Database, Upload, AlertTriangle, CheckCircle, Loader2, Eye } from 'lucide-react'
import { supabase } from '@/lib/supabase'

// ── Schema mapping ────────────────────────────────────────────
// Maps camelCase prototype field names to snake_case Supabase names.

const FIELD_MAP: Record<string, string> = {
  endDate:      'end_date',
  mainStart:    'main_start',
  startDate:    'start',
  workItemId:   'work_item_id',
  personId:     'person_id',
  leaveType:    'leave_type',
  weekendDates: 'weekend_dates',
  isRecurring:  'recurring',
}

function mapRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(row)) {
    out[FIELD_MAP[k] ?? k] = v
  }
  if ('hashtags' in out && out.hashtags == null)           out.hashtags = []
  if ('weekend_dates' in out && out.weekend_dates == null) out.weekend_dates = []
  return out
}

// ── Known localStorage keys ───────────────────────────────────

const LOCAL_TABLE_KEYS: Record<string, string> = {
  people:      'people',
  work_items:  'work_items',
  workItems:   'work_items',
  assignments: 'assignments',
  holidays:    'holidays',
  accruals:    'accruals',
  grants:      'grants',
}

const UPSERT_ORDER = [
  'people', 'work_items', 'holidays', 'grants', 'assignments', 'accruals',
] as const

// ── Types ─────────────────────────────────────────────────────

interface DetectedTable {
  localKey:  string
  tableName: string
  rows:      Record<string, unknown>[]
}

type MigratePhase = 'idle' | 'loading' | 'done' | 'error'

// ── Component ─────────────────────────────────────────────────

export default function MigrationPanel() {
  const [detected,    setDetected]    = useState<DetectedTable[]>([])
  const [scanned,     setScanned]     = useState(false)
  const [preview,     setPreview]     = useState<string | null>(null)
  const [phase,       setPhase]       = useState<MigratePhase>('idle')
  const [progressLog, setProgressLog] = useState<string[]>([])
  const [migrateErr,  setMigrateErr]  = useState<string | null>(null)
  const [fileError,   setFileError]   = useState<string | null>(null)

  function dedup(found: DetectedTable[]): DetectedTable[] {
    const unique = new Map<string, DetectedTable>()
    for (const f of found) {
      const ex = unique.get(f.tableName)
      if (!ex || f.rows.length > ex.rows.length) unique.set(f.tableName, f)
    }
    return [...unique.values()]
  }

  function scanLocalStorage() {
    const found: DetectedTable[] = []
    for (const [localKey, tableName] of Object.entries(LOCAL_TABLE_KEYS)) {
      const raw = localStorage.getItem(localKey)
      if (!raw) continue
      try {
        const parsed = JSON.parse(raw)
        const rows   = Array.isArray(parsed) ? parsed : [parsed]
        if (rows.length > 0)
          found.push({ localKey, tableName, rows: rows.map(r => mapRow(r)) })
      } catch { /* ignore malformed JSON */ }
    }
    setDetected(dedup(found))
    setScanned(true)
  }

  function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    setFileError(null)
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = evt => {
      try {
        const obj  = JSON.parse(evt.target?.result as string)
        const root = obj.tables ?? obj   // accept backup format or prototype format
        const found: DetectedTable[] = []
        for (const [localKey, tableName] of Object.entries(LOCAL_TABLE_KEYS)) {
          const rows = root[localKey]
          if (Array.isArray(rows) && rows.length > 0)
            found.push({ localKey, tableName, rows: rows.map((r: Record<string, unknown>) => mapRow(r)) })
        }
        setDetected(dedup(found))
        setScanned(true)
      } catch (err) {
        setFileError(err instanceof Error ? err.message : 'JSON 파싱 오류')
      }
    }
    reader.readAsText(file)
  }

  async function handleMigrate() {
    setPhase('loading')
    setProgressLog([])
    setMigrateErr(null)
    const tableMap = new Map(detected.map(d => [d.tableName, d.rows]))
    try {
      for (const table of UPSERT_ORDER) {
        const rows = tableMap.get(table)
        if (!rows || rows.length === 0) {
          setProgressLog(prev => [...prev, `${table}: 0건 (건너뜀)`])
          continue
        }
        setProgressLog(prev => [...prev, `${table}: ${rows.length}건 upsert 중…`])
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { error } = await (supabase.from(table as any) as any).upsert(rows)
        if (error) throw new Error(`${table}: ${error.message}`)
        setProgressLog(prev => [...prev, `${table}: ✓ ${rows.length}건 완료`])
      }
      setPhase('done')
    } catch (err) {
      setMigrateErr(err instanceof Error ? err.message : String(err))
      setPhase('error')
    }
  }

  const previewData = useMemo(
    () => detected.find(d => d.tableName === preview),
    [detected, preview],
  )
  const previewKeys = useMemo(
    () => previewData ? [...new Set(previewData.rows.flatMap(r => Object.keys(r)))] : [],
    [previewData],
  )
  const totalRows = detected.reduce((s, d) => s + d.rows.length, 0)

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-sm font-semibold text-gray-800 mb-1 flex items-center gap-2">
          <Database size={14} /> 초기 데이터 이관
        </h2>
        <p className="text-xs text-muted">
          localStorage 또는 JSON 파일의 프로토타입 데이터를 Supabase로 1회성 이전합니다.
          camelCase 필드명은 자동으로 snake_case로 변환됩니다.
        </p>
      </div>

      {/* Step 1 — Source */}
      <section className="card space-y-4">
        <h3 className="text-sm font-semibold text-gray-900">Step 1 — 데이터 소스 선택</h3>
        <div className="flex flex-wrap gap-3">
          <button onClick={scanLocalStorage} className="btn-secondary gap-1.5">
            <Database size={14} /> localStorage 스캔
          </button>
          <label className="btn-secondary gap-1.5 cursor-pointer">
            <Upload size={14} /> JSON 파일 업로드
            <input
              type="file"
              accept=".json,application/json"
              onChange={handleFileUpload}
              className="hidden"
            />
          </label>
        </div>
        {fileError && (
          <p className="text-xs text-red-600 flex items-center gap-1">
            <AlertTriangle size={12} /> {fileError}
          </p>
        )}
      </section>

      {/* Step 2 — Detected data */}
      {scanned && (
        <section className="card space-y-3">
          <h3 className="text-sm font-semibold text-gray-900">
            Step 2 — 감지된 데이터 ({totalRows}건)
          </h3>
          {detected.length === 0 ? (
            <p className="text-xs text-muted">마이그레이션할 데이터가 없습니다.</p>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-2">
                {detected.map(d => (
                  <div
                    key={d.tableName}
                    className="rounded-md border border-border bg-surface-50 px-3 py-2 flex items-center justify-between"
                  >
                    <div>
                      <p className="text-xs font-medium text-gray-800">{d.tableName}</p>
                      <p className="text-[10px] text-muted">
                        {d.rows.length}건 · 소스: <code>{d.localKey}</code>
                      </p>
                    </div>
                    <button
                      onClick={() => setPreview(d.tableName === preview ? null : d.tableName)}
                      className="text-muted hover:text-brand-600 transition-colors"
                      title="미리보기"
                    >
                      <Eye size={14} />
                    </button>
                  </div>
                ))}
              </div>

              {previewData && (
                <div className="overflow-x-auto rounded-md border border-border">
                  <table className="w-full text-[10px] min-w-max">
                    <thead>
                      <tr className="bg-surface-100 border-b border-border">
                        {previewKeys.map(k => (
                          <th key={k} className="px-2 py-1.5 text-left font-medium text-muted whitespace-nowrap">
                            {k}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {previewData.rows.slice(0, 5).map((row, i) => (
                        <tr key={i} className="hover:bg-surface-50">
                          {previewKeys.map(k => (
                            <td key={k} className="px-2 py-1.5 text-gray-700 whitespace-nowrap max-w-[160px] truncate">
                              {row[k] == null ? '—' : JSON.stringify(row[k]).replace(/^"|"$/g, '')}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {previewData.rows.length > 5 && (
                    <p className="px-3 py-1.5 text-[10px] text-muted bg-surface-50">
                      … 외 {previewData.rows.length - 5}건 (미리보기는 5건만 표시)
                    </p>
                  )}
                </div>
              )}
            </>
          )}
        </section>
      )}

      {/* Step 3 — Execute */}
      {scanned && detected.length > 0 && phase !== 'done' && (
        <section className="card space-y-4">
          <h3 className="text-sm font-semibold text-gray-900">Step 3 — 마이그레이션 실행</h3>
          <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
            <p className="font-semibold flex items-center gap-1">
              <AlertTriangle size={12} /> 주의
            </p>
            <p className="mt-1">
              기존 레코드는 <strong>upsert</strong>로 덮어씁니다 (같은 id 기준).
              중복 id가 없는 경우 신규 삽입됩니다. RLS가 적용되므로 편집 권한이
              없는 테이블은 오류가 납니다.
            </p>
          </div>
          <button
            onClick={handleMigrate}
            disabled={phase === 'loading'}
            className="btn-primary gap-1.5"
          >
            {phase === 'loading'
              ? <><Loader2 size={14} className="animate-spin" /> 마이그레이션 중…</>
              : <><Upload size={14} /> Supabase로 이전 시작</>}
          </button>
        </section>
      )}

      {progressLog.length > 0 && (
        <div className="rounded-md bg-gray-900 p-3 font-mono text-xs text-green-400 space-y-0.5 max-h-48 overflow-y-auto">
          {progressLog.map((msg, i) => <p key={i}>{msg}</p>)}
        </div>
      )}

      {phase === 'done' && (
        <p className="text-sm text-emerald-700 flex items-center gap-2 font-medium">
          <CheckCircle size={15} /> 마이그레이션 완료
        </p>
      )}

      {migrateErr && (
        <p className="text-sm text-red-600 flex items-center gap-2">
          <AlertTriangle size={14} /> {migrateErr}
        </p>
      )}
    </div>
  )
}
