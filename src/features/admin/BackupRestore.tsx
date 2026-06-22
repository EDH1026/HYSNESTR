/**
 * BackupRestore — admin-only JSON backup & upsert-restore
 *
 * Backup: fetches all business tables and downloads as JSON.
 * Restore: parses uploaded JSON, shows record counts, then upserts
 *   in FK-dependency order via the normal Supabase client (admin JWT,
 *   anon key). RLS is fully enforced — no service_role bypass.
 *
 * Restore is upsert-based (insert-or-update). Records not present in
 * the backup file are NOT deleted (see README for Supabase DB-level
 * backups which provide a full point-in-time restore).
 */

import { useState, useRef } from 'react'
import { Download, Upload, AlertTriangle, CheckCircle, Loader2 } from 'lucide-react'
import { supabase } from '@/lib/supabase'

// ── Types ─────────────────────────────────────────────────────

interface BackupPayload {
  version:    string
  exportedAt: string
  tables: {
    people:      unknown[]
    work_items:  unknown[]
    assignments: unknown[]
    accruals:    unknown[]
    holidays:    unknown[]
    grants:      unknown[]
  }
}

// Tables included in backup, in FK-safe upsert order
const BACKUP_TABLES = ['people', 'work_items', 'holidays', 'grants', 'assignments', 'accruals'] as const

// ── Download helper ───────────────────────────────────────────

function triggerDownload(content: string, filename: string) {
  const blob = new Blob([content], { type: 'application/json;charset=utf-8' })
  const url  = URL.createObjectURL(blob)
  const a    = Object.assign(document.createElement('a'), { href: url, download: filename })
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

// ── Backup ────────────────────────────────────────────────────

async function fetchBackup(): Promise<BackupPayload> {
  const tables: Partial<BackupPayload['tables']> = {}
  for (const t of BACKUP_TABLES) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (supabase.from(t as any) as any).select('*')
    if (error) throw new Error(`${t}: ${error.message}`)
    tables[t] = data ?? []
  }
  return {
    version:    '1',
    exportedAt: new Date().toISOString(),
    tables:     tables as BackupPayload['tables'],
  }
}

// ── Restore ───────────────────────────────────────────────────

async function applyRestore(
  payload: BackupPayload,
  onProgress: (msg: string) => void,
): Promise<void> {
  for (const t of BACKUP_TABLES) {
    const rows = payload.tables[t]
    if (!rows || rows.length === 0) {
      onProgress(`${t}: 0 rows (skipped)`)
      continue
    }
    onProgress(`${t}: upserting ${rows.length} rows…`)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (supabase.from(t as any) as any).upsert(rows)
    if (error) throw new Error(`${t}: ${error.message}`)
    onProgress(`${t}: ✓ ${rows.length} rows`)
  }
}

// ── Component ─────────────────────────────────────────────────

type Phase = 'idle' | 'loading' | 'done' | 'error'

export default function BackupRestore() {
  // Backup state
  const [backupPhase, setBackupPhase]   = useState<Phase>('idle')
  const [backupError, setBackupError]   = useState<string | null>(null)

  // Restore state
  const [parsed,         setParsed]         = useState<BackupPayload | null>(null)
  const [parseError,     setParseError]     = useState<string | null>(null)
  const [confirmText,    setConfirmText]    = useState('')
  const [restorePhase,   setRestorePhase]   = useState<Phase>('idle')
  const [progressLog,    setProgressLog]    = useState<string[]>([])
  const [restoreError,   setRestoreError]   = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // ── Backup ──────────────────────────────────────────────────

  async function handleDownloadBackup() {
    setBackupPhase('loading')
    setBackupError(null)
    try {
      const payload = await fetchBackup()
      const filename = `backup-${new Date().toISOString().slice(0, 10)}.json`
      triggerDownload(JSON.stringify(payload, null, 2), filename)
      setBackupPhase('done')
      setTimeout(() => setBackupPhase('idle'), 3000)
    } catch (e) {
      setBackupError(e instanceof Error ? e.message : String(e))
      setBackupPhase('error')
    }
  }

  // ── Restore: file parse ──────────────────────────────────────

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setParsed(null)
    setParseError(null)
    setConfirmText('')
    setRestorePhase('idle')
    setProgressLog([])
    setRestoreError(null)

    const reader = new FileReader()
    reader.onload = evt => {
      try {
        const obj = JSON.parse(evt.target?.result as string) as BackupPayload
        if (!obj.version || !obj.tables)
          throw new Error('Invalid backup format: missing version or tables')
        setParsed(obj)
      } catch (err) {
        setParseError(err instanceof Error ? err.message : 'Parse error')
      }
    }
    reader.readAsText(file)
  }

  // ── Restore: apply ───────────────────────────────────────────

  async function handleRestore() {
    if (!parsed || confirmText !== 'RESTORE') return
    setRestorePhase('loading')
    setProgressLog([])
    setRestoreError(null)
    try {
      await applyRestore(parsed, msg => setProgressLog(prev => [...prev, msg]))
      setRestorePhase('done')
    } catch (e) {
      setRestoreError(e instanceof Error ? e.message : String(e))
      setRestorePhase('error')
    }
  }

  const totalRows = parsed
    ? BACKUP_TABLES.reduce((s, t) => s + (parsed.tables[t]?.length ?? 0), 0)
    : 0

  return (
    <div className="space-y-8">
      {/* ── Backup ────────────────────────────────────── */}
      <section className="card space-y-4">
        <h2 className="text-sm font-semibold text-gray-900 flex items-center gap-2">
          <Download size={15} className="text-brand-600" /> 데이터 백업
        </h2>
        <p className="text-xs text-muted">
          모든 비즈니스 데이터(people, work_items, assignments, accruals, holidays, grants)를
          JSON 파일로 다운로드합니다.
        </p>

        <button
          onClick={handleDownloadBackup}
          disabled={backupPhase === 'loading'}
          className="btn-primary gap-1.5"
        >
          {backupPhase === 'loading'
            ? <><Loader2 size={14} className="animate-spin" /> 준비 중…</>
            : backupPhase === 'done'
            ? <><CheckCircle size={14} /> 다운로드 완료</>
            : <><Download size={14} /> JSON 다운로드</>}
        </button>

        {backupError && (
          <p className="text-xs text-red-600 flex items-center gap-1">
            <AlertTriangle size={12} /> {backupError}
          </p>
        )}
        <p className="text-xs text-muted">
          ⚠ 운영 환경 전체 복원(point-in-time)은 Supabase 대시보드의 DB 백업 기능을 사용하세요.
          (README 참고)
        </p>
      </section>

      {/* ── Restore ───────────────────────────────────── */}
      <section className="card space-y-4">
        <h2 className="text-sm font-semibold text-gray-900 flex items-center gap-2">
          <Upload size={15} className="text-orange-600" /> 데이터 복원 (Upsert)
        </h2>

        <div className="rounded-md border border-orange-200 bg-orange-50 p-3 text-xs text-orange-800 space-y-1">
          <p className="font-semibold flex items-center gap-1"><AlertTriangle size={12} /> 주의</p>
          <p>
            업로드한 백업 파일의 레코드를 현재 DB에 <strong>덮어씁니다(upsert)</strong>.
            백업에 없는 레코드는 삭제되지 않습니다.
            완전 초기화가 필요한 경우 Supabase 대시보드 백업 복원을 이용하세요.
          </p>
        </div>

        {/* File picker */}
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-700">백업 파일 선택</label>
          <input
            ref={fileInputRef}
            type="file"
            accept=".json,application/json"
            onChange={handleFileChange}
            className="block text-xs text-gray-700 file:mr-3 file:rounded file:border-0
              file:bg-surface-100 file:px-3 file:py-1.5 file:text-xs file:font-medium
              file:text-gray-700 hover:file:bg-surface-200 transition-colors"
          />
          {parseError && (
            <p className="mt-1 text-xs text-red-600 flex items-center gap-1">
              <AlertTriangle size={12} /> {parseError}
            </p>
          )}
        </div>

        {/* Summary */}
        {parsed && (
          <div className="rounded-md border border-border bg-surface-50 p-3 text-xs space-y-1">
            <p className="font-semibold text-gray-800">백업 파일 정보</p>
            <p className="text-muted">
              내보낸 날짜: {new Date(parsed.exportedAt).toLocaleString('ko-KR')}
            </p>
            <div className="grid grid-cols-3 gap-1 mt-2">
              {BACKUP_TABLES.map(t => (
                <span key={t} className="text-muted">
                  {t}: <span className="font-medium text-gray-800">{parsed.tables[t]?.length ?? 0}</span>
                </span>
              ))}
            </div>
            <p className="font-medium text-gray-800 pt-1">총 {totalRows} 레코드</p>
          </div>
        )}

        {/* Confirmation */}
        {parsed && restorePhase !== 'done' && (
          <div className="space-y-2">
            <label className="block text-xs font-medium text-gray-700">
              복원을 확인하려면 <code className="bg-surface-100 px-1 rounded">RESTORE</code> 를 입력하세요
            </label>
            <input
              className="input font-mono"
              value={confirmText}
              onChange={e => setConfirmText(e.target.value)}
              placeholder="RESTORE"
              disabled={restorePhase === 'loading'}
            />
            <button
              onClick={handleRestore}
              disabled={confirmText !== 'RESTORE' || restorePhase === 'loading'}
              className="btn-danger gap-1.5 w-full justify-center"
            >
              {restorePhase === 'loading'
                ? <><Loader2 size={14} className="animate-spin" /> 복원 중…</>
                : <><Upload size={14} /> 복원 시작</>}
            </button>
          </div>
        )}

        {/* Progress log */}
        {progressLog.length > 0 && (
          <div className="rounded-md bg-gray-900 p-3 font-mono text-xs text-green-400 space-y-0.5 max-h-40 overflow-y-auto">
            {progressLog.map((msg, i) => <p key={i}>{msg}</p>)}
          </div>
        )}

        {restorePhase === 'done' && (
          <p className="text-xs text-emerald-700 flex items-center gap-1 font-medium">
            <CheckCircle size={13} /> 복원 완료
          </p>
        )}

        {restoreError && (
          <p className="text-xs text-red-600 flex items-center gap-1">
            <AlertTriangle size={12} /> {restoreError}
          </p>
        )}
      </section>
    </div>
  )
}
