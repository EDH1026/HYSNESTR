/**
 * TimesheetGuidelineTab — TSG-1~10
 * PRD v2.57: [1]초기화 진단 [2]핵심 불변식 [3]"반영" 용어 [4]TSG-8 재설계 [5]TSG-10 조회 축 전환
 *
 * 스냅샷 키: personId||date||code  (double-pipe separator)
 * hours 지원: 셀별 투입 시간 (기본 8h), 수동 수정 가능
 * 반영 = delete-then-insert (완전 교체 → 멱등성 보장)
 */
import { useState, useMemo, useCallback, useRef, useEffect, Fragment, type FormEvent } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Loader2, Play, Download, Save, AlertTriangle, RefreshCw,
  ChevronDown, ChevronRight, Pencil, X, Check, RotateCcw, Plus,
} from 'lucide-react'
import { useAllPeople }                       from '@/features/people/hooks'
import { useAllAssignments }                  from '@/features/timeline/hooks'
import { useAllAccruals }                     from '@/features/leave/hooks'
import { useAllWorkItems, useUpdateWorkItem } from '@/features/workitems/hooks'
import { useAllHolidays }                     from '@/features/admin/hooks'
import { useAllAdjustments }                  from './hooks'
import { computeLedger, buildHolidaySet }     from '@/features/leave/ledger'
import { resolveTimesheetCode }               from './resolveTimesheetCode'
import type { ResolveContext }                from './resolveTimesheetCode'
import { today, numToStr, isWeekend, weekStart } from '@/lib/date'
import { parseSearchQuery }                   from '@/lib/searchQuery'
import { supabase }                           from '@/lib/supabase'
import { escHtml, triggerDownload, HTML_EXPORT_CSS } from '@/lib/htmlExport'
import type { Person, Rank, WorkItem }        from '@/types'

// ── Design tokens ──────────────────────────────────────────────

const DAY_NAMES = ['월', '화', '수', '목', '금'] as const
const RANK_ORDER: Record<Rank, number> = { Partner: 0, SM: 1, M: 2, Senior: 3, Staff: 4, Intern: 5 }
const ZEBRA_ROW = ['bg-white', 'bg-slate-50/60'] as const
const ZEBRA_HDR = ['bg-slate-100/70', 'bg-slate-200/50'] as const
const CODE_COL_W = 160
const DAY_COL_W  = 80

// ── Types ──────────────────────────────────────────────────────

/** kind:
 *  new           — computed, not in snapshot
 *  correction    — computed, hours differ from snapshot
 *  unchanged     — computed, identical to snapshot
 *  to_remove     — in snapshot but not in computed (code was replaced)
 *  manual_edit   — user edited hours of an existing entry
 *  manual_add    — user added a new code row
 */
interface SnapshotEntry {
  hours:         number
  provisional:   boolean
  existingHours: number | null   // null = not in snapshot
  kind:          'new' | 'correction' | 'unchanged' | 'to_remove' | 'manual_edit' | 'manual_add'
}

type ChangeKind = 'new' | 'replaced' | 'removed' | 'unchanged' | 'manual'

interface CodeRowData {
  code:        string
  provisional: boolean
  isManual:    boolean
  cells:       Map<string, { hours: number; changeKind: ChangeKind }>
}

interface ColInfo  { date: string; label: string; isHoliday: boolean }
interface WeekInfo { weekStart: string; label: string; columns: ColInfo[] }

interface ManualChange {
  hours: number   // 0 = remove
  isAdd: boolean
}

interface AddCodeState {
  personId:  string
  weekStart: string
  code:      string
  hours:     Record<string, string>   // date → hours string
}

interface EditCellState {
  personId: string
  date:     string
  code:     string
  value:    string
}

// ── Snapshot key helpers ───────────────────────────────────────

function snapKey(personId: string, date: string, code: string): string {
  return `${personId}||${date}||${code}`
}

function parseSnapKey(key: string): [string, string, string] {
  const i1 = key.indexOf('||')
  const i2 = key.indexOf('||', i1 + 2)
  return [key.slice(0, i1), key.slice(i1 + 2, i2), key.slice(i2 + 2)]
}

/**
 * P-1 per-date employment check.
 * Root cause fix (v2.59): activePeople includes 'upcoming' (hire_date in future)
 * and recently-resigned people whose termination_date falls inside the window.
 * Generating rows for those days inflates expectedCount and causes diagnosis mismatches.
 */
function isEmployedOnDate(person: Person, dateStr: string): boolean {
  if (person.hire_date && person.hire_date > dateStr) return false
  if (person.termination_date && person.termination_date < dateStr) return false
  return true
}

// ── Pure helpers ───────────────────────────────────────────────

function monthDay(s: string): string {
  return `${parseInt(s.slice(5, 7), 10)}/${parseInt(s.slice(8, 10), 10)}`
}

function computeWeeks(startNum: number, endNum: number, isHoliday: (n: number) => boolean): WeekInfo[] {
  const weeks: WeekInfo[] = []
  let mon = startNum
  while (mon <= endNum) {
    const cols: ColInfo[] = []
    for (let d = 0; d < 5; d++) {
      const n = mon + d
      const s = numToStr(n)
      cols.push({ date: s, label: `${DAY_NAMES[d]} ${monthDay(s)}`, isHoliday: isHoliday(n) })
    }
    weeks.push({
      weekStart: numToStr(mon),
      label: `${monthDay(numToStr(mon))}(월) ~ ${monthDay(numToStr(mon + 4))}(금)`,
      columns: cols,
    })
    mon += 7
  }
  return weeks.reverse()
}

function sortPeople(people: Person[]): Person[] {
  return [...people].sort((a, b) => {
    const rc = (RANK_ORDER[a.rank] ?? 99) - (RANK_ORDER[b.rank] ?? 99)
    return rc !== 0 ? rc : a.name.localeCompare(b.name, 'ko')
  })
}

function workingDaysList(fromNum: number, toNum: number, isHoliday: (n: number) => boolean): string[] {
  const days: string[] = []
  for (let n = fromNum; n <= toNum; n++) {
    if (!isWeekend(n) && !isHoliday(n)) days.push(numToStr(n))
  }
  return days
}

function entryKindToChangeKind(kind: SnapshotEntry['kind']): ChangeKind {
  if (kind === 'new')        return 'new'
  if (kind === 'correction') return 'replaced'
  if (kind === 'to_remove')  return 'removed'
  if (kind === 'manual_edit' || kind === 'manual_add') return 'manual'
  return 'unchanged'
}

/** Build code-row display data for a person across given columns. */
function buildCodeRows(
  personId: string,
  cols:     ColInfo[],
  entries:  Map<string, SnapshotEntry>,
): CodeRowData[] {
  const codeMap = new Map<string, { provisional: boolean; isManual: boolean; cells: Map<string, { hours: number; changeKind: ChangeKind }> }>()

  const ensure = (code: string) => {
    if (!codeMap.has(code)) codeMap.set(code, { provisional: false, isManual: false, cells: new Map() })
    return codeMap.get(code)!
  }

  for (const col of cols) {
    if (col.isHoliday) continue
    const prefix = `${personId}||${col.date}||`
    for (const [key, entry] of entries) {
      if (!key.startsWith(prefix)) continue
      const [,, code] = parseSnapKey(key)
      const row = ensure(code)
      if (entry.provisional) row.provisional = true
      if (entry.kind === 'manual_edit' || entry.kind === 'manual_add') row.isManual = true
      row.cells.set(col.date, { hours: entry.hours, changeKind: entryKindToChangeKind(entry.kind) })
    }
  }

  if (codeMap.size === 0) return []
  return [...codeMap.entries()]
    .sort(([a], [b]) => {
      if (a === 'unassigned') return 1
      if (b === 'unassigned') return -1
      return a.localeCompare(b)
    })
    .map(([code, info]) => ({ code, ...info }))
}

function formatError(e: unknown): string {
  if (e instanceof Error) return e.message
  if (typeof e === 'object' && e !== null) {
    const obj = e as Record<string, unknown>
    const parts = [obj.message, obj.details, obj.hint]
      .filter((v): v is string => typeof v === 'string' && v.length > 0)
    if (parts.length) return parts.join(' — ')
  }
  return '알 수 없는 오류가 발생했습니다.'
}

// ── DB helpers (delete-then-insert pattern) ────────────────────

async function deleteSnapshotRange(gte: string, lte: string): Promise<void> {
  const { error } = await (supabase as any)
    .from('timesheet_guideline_snapshot')
    .delete()
    .gte('date', gte)
    .lte('date', lte)
  if (error) throw error
}

async function batchInsertSnapshot(rows: object[], batchSize = 200): Promise<void> {
  // Batch size capped at 200 (not 500) to stay within PostgREST body limits.
  // Each batch is independent; failure here is the most common cause of partial commits.
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize)
    const batchNum = Math.floor(i / batchSize) + 1
    const totalBatches = Math.ceil(rows.length / batchSize)
    const { error } = await (supabase as any)
      .from('timesheet_guideline_snapshot')
      .insert(batch)
    if (error) {
      // Include batch position so partial-commit failures are diagnosable.
      const wrapped = new Error(
        `배치 ${batchNum}/${totalBatches} (행 ${i + 1}~${i + batch.length}) 삽입 실패: ${formatError(error)}`
      )
      throw wrapped
    }
  }
}

// ── HTML export ────────────────────────────────────────────────

function generateGuidelineHtml(
  weeks:       WeekInfo[],
  people:      Person[],
  entries:     Map<string, SnapshotEntry>,
  windowStart: string,
  windowEnd:   string,
  todayStr:    string,
): string {
  const generated = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })
  const sorted    = sortPeople(people)
  const CK_STYLE: Record<ChangeKind, string> = {
    new:       'background:#eff6ff;color:#1d4ed8',
    replaced:  'background:#fffbeb;color:#b45309',
    removed:   'background:#fff1f2;color:#e11d48',
    unchanged: '',
    manual:    'background:#f5f3ff;color:#7c3aed',
  }

  const weekSections = weeks.map(week => {
    const colW = `width:${DAY_COL_W}px;text-align:center`
    const colHeaders = week.columns.map(col =>
      `<th class="${col.isHoliday ? 'holiday' : ''}" style="${colW}">${escHtml(col.label)}${col.isHoliday ? '<br><small>공휴일</small>' : ''}</th>`
    ).join('')
    const rows: string[] = []
    sorted.forEach((person, pi) => {
      const codeRows = buildCodeRows(person.id, week.columns, entries)
      if (codeRows.length === 0) return
      const bg = pi % 2 === 0 ? '' : 'background:#f8fafc'
      rows.push(`<tr class="person-hdr" style="${bg}"><td colspan="${week.columns.length + 1}"><strong>${escHtml(person.name)}</strong> <span class="rank">${escHtml(person.rank)}</span></td></tr>`)
      for (const row of codeRows) {
        const cells = week.columns.map(col => {
          if (col.isHoliday) return `<td class="holiday" style="text-align:center">—</td>`
          const c = row.cells.get(col.date)
          if (!c || c.changeKind === 'removed') {
            if (c?.changeKind === 'removed') return `<td style="text-align:center;${CK_STYLE.removed}">—</td>`
            return `<td></td>`
          }
          const style = CK_STYLE[c.changeKind] ? ` style="${CK_STYLE[c.changeKind]};text-align:center;font-family:monospace"` : ' style="text-align:center;font-family:monospace"'
          return `<td${style}>${escHtml(String(c.hours))}</td>`
        }).join('')
        const prov = row.provisional ? ' ⚠' : ''
        const man = row.isManual ? ' [관리자]' : ''
        rows.push(`<tr style="${bg}"><td class="code-lbl">${escHtml(row.code)}${prov}${man}</td>${cells}</tr>`)
      }
    })
    if (rows.length === 0) rows.push(`<tr><td colspan="${week.columns.length + 1}" class="empty">해당 항목 없음</td></tr>`)
    const tblW = `${CODE_COL_W + week.columns.length * DAY_COL_W}px`
    return `<section>
<h2>${escHtml(week.label)}</h2>
<table style="width:${tblW}">
  <thead><tr><th style="min-width:${CODE_COL_W}px">코드</th>${colHeaders}</tr></thead>
  <tbody>${rows.join('')}</tbody>
</table>
</section>`
  })

  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<title>타임시트 지침 — ${escHtml(todayStr)}</title>
<style>
${HTML_EXPORT_CSS}
.person-hdr td{font-size:12px;padding:5px 8px;border-top:2px solid #cbd5e1}
.rank{font-size:10px;color:#6b7280}
.code-lbl{font-family:monospace;font-size:11px;min-width:${CODE_COL_W}px}
.holiday{background:#f9fafb;color:#9ca3af}
</style>
</head>
<body>
<header>
  <h1>타임시트 지침</h1>
  <p class="meta">윈도우: ${escHtml(windowStart)} ~ ${escHtml(windowEnd)}</p>
  <p class="meta">생성: ${escHtml(generated)}</p>
</header>
${weekSections.join('\n')}
</body>
</html>`
}

// ── Sub-components ─────────────────────────────────────────────

function PendingProjectsPanel({ workItems, assignments, windowStart, windowEnd, onEdit }: {
  workItems: WorkItem[]
  assignments: { work_item_id: string | null; kind: string; start: string; end_date: string }[]
  windowStart: string; windowEnd: string
  onEdit: (wi: WorkItem) => void
}) {
  const pending = useMemo(() => {
    const activeIds = new Set<string>()
    for (const a of assignments) {
      if (a.kind !== 'work' || !a.work_item_id) continue
      if (a.start <= windowEnd && a.end_date >= windowStart) activeIds.add(a.work_item_id)
    }
    return workItems.filter(wi => wi.type === 'project' && !wi.engagement_number && activeIds.has(wi.id))
  }, [workItems, assignments, windowStart, windowEnd])

  if (pending.length === 0) return null
  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 space-y-2">
      <div className="flex items-center gap-1.5 text-xs font-semibold text-amber-700">
        <AlertTriangle size={13} /> 대체 코드 미확정 프로젝트 ({pending.length}건)
      </div>
      <div className="space-y-1.5">
        {pending.map(wi => (
          <div key={wi.id} className="flex items-center gap-2 text-xs bg-white/70 rounded border border-amber-100 px-3 py-1.5">
            <span className="font-medium text-gray-800 flex-1 truncate">{wi.name}</span>
            {wi.temp_engagement_code
              ? <span className="font-mono text-amber-700 bg-amber-100 px-1.5 py-0.5 rounded text-[11px]">{wi.temp_engagement_code}</span>
              : <span className="text-muted italic text-[11px]">코드 없음</span>}
            <button onClick={() => onEdit(wi)} className="flex items-center gap-1 text-brand-600 hover:text-brand-700 font-medium">
              <Pencil size={11} /> {wi.temp_engagement_code ? '수정' : '입력'}
            </button>
          </div>
        ))}
      </div>
      <p className="text-[10px] text-amber-600">정식 engagement_number 등록 후 "지침 생성"을 다시 실행하면 자동으로 정정 지시가 생성됩니다.</p>
    </div>
  )
}

function EditCodeModal({ wi, onClose, onSaved }: { wi: WorkItem; onClose: () => void; onSaved: () => void }) {
  const [value, setValue] = useState(wi.temp_engagement_code ?? '')
  const [error, setError] = useState<string | null>(null)
  const updateWorkItem = useUpdateWorkItem()
  async function save() {
    setError(null)
    try {
      await updateWorkItem.mutateAsync({ id: wi.id, temp_engagement_code: value.trim() || null })
      onSaved()
    } catch (e) { setError(formatError(e)) }
  }
  return (
    <div className="fixed inset-0 bg-black/25 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-xl p-5 w-80 space-y-4" onClick={e => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-2">
          <div>
            <h4 className="text-sm font-semibold text-gray-800">{wi.name}</h4>
            <p className="text-[11px] text-muted mt-0.5">대체 타임시트 코드 입력</p>
          </div>
          <button onClick={onClose} className="text-muted hover:text-gray-600"><X size={15} /></button>
        </div>
        <div className="space-y-1">
          <label className="text-xs font-medium text-gray-700">대체 코드</label>
          <input className="input w-full text-sm font-mono" value={value} onChange={e => setValue(e.target.value)}
            placeholder="예: KR1234-0" autoFocus
            onKeyDown={e => { if (e.key === 'Enter' && !updateWorkItem.isPending) save(); if (e.key === 'Escape') onClose() }} />
          <p className="text-[10px] text-muted">비워두면 대체 코드가 삭제됩니다.</p>
        </div>
        {error && <p className="text-xs text-red-600 flex items-center gap-1"><AlertTriangle size={11} /> {error}</p>}
        <div className="flex justify-end gap-2">
          <button className="btn-secondary text-xs py-1" onClick={onClose}>취소</button>
          <button className="btn-primary text-xs py-1 gap-1 disabled:opacity-40" disabled={updateWorkItem.isPending} onClick={save}>
            {updateWorkItem.isPending ? <><Loader2 size={12} className="animate-spin" /> 저장 중…</> : <><Check size={12} /> 저장</>}
          </button>
        </div>
      </div>
    </div>
  )
}

function ResetConfirmModal({ pastDayCount, onConfirm, onClose }: { pastDayCount: number; onConfirm: () => void; onClose: () => void }) {
  return (
    <div className="fixed inset-0 bg-black/25 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-xl p-5 w-96 space-y-4" onClick={e => e.stopPropagation()}>
        <div className="flex items-start gap-3">
          <RotateCcw size={18} className="text-amber-500 flex-shrink-0 mt-0.5" />
          <div>
            <h4 className="text-sm font-semibold text-gray-800">과거 스냅샷 초기화</h4>
            <p className="text-xs text-gray-600 mt-1.5 leading-relaxed">
              최신 주를 제외한 과거 7주(<strong>{pastDayCount}</strong>영업일)의 스냅샷을 현재 배정 데이터 기준으로 재설정합니다. 정정 지시 없이 바로 덮어씁니다.
            </p>
            <p className="text-xs font-medium text-amber-700 mt-2">계속할까요?</p>
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <button className="btn-secondary text-xs py-1" onClick={onClose}>취소</button>
          <button className="btn-danger text-xs py-1 gap-1" onClick={onConfirm}><RotateCcw size={12} /> 초기화 실행</button>
        </div>
      </div>
    </div>
  )
}

// ── Add-code inline form ───────────────────────────────────────

function AddCodeForm({ state, weekCols, onConfirm, onCancel }: {
  state:     AddCodeState
  weekCols:  ColInfo[]
  onConfirm: (s: AddCodeState) => void
  onCancel:  () => void
}) {
  const [code,  setCode]  = useState(state.code)
  const [hours, setHours] = useState<Record<string, string>>(() => {
    const h: Record<string, string> = {}
    for (const col of weekCols) { if (!col.isHoliday) h[col.date] = '8' }
    return h
  })

  function submit(e: FormEvent) {
    e.preventDefault()
    if (!code.trim()) return
    onConfirm({ ...state, code: code.trim(), hours })
  }

  return (
    <tr className="bg-purple-50 border-b border-purple-200">
      <td className={`px-2 py-1.5 sticky left-0 bg-purple-50 z-10 border-r border-purple-200`} style={{ width: CODE_COL_W }}>
        <input
          autoFocus
          className="input w-full text-xs font-mono py-0.5"
          placeholder="코드 입력…"
          value={code}
          onChange={e => setCode(e.target.value)}
          onKeyDown={e => { if (e.key === 'Escape') onCancel() }}
        />
      </td>
      {weekCols.map(col => (
        <td key={col.date} className="px-0.5 py-1.5 text-center" style={{ width: DAY_COL_W }}>
          {col.isHoliday ? (
            <span className="text-[10px] text-gray-300">—</span>
          ) : (
            <input
              type="number"
              min="0" max="24" step="0.5"
              className="w-full text-xs text-center border border-purple-300 rounded px-1 py-0.5 focus:outline-none bg-white"
              value={hours[col.date] ?? '8'}
              onChange={e => setHours(prev => ({ ...prev, [col.date]: e.target.value }))}
            />
          )}
        </td>
      ))}
      <td colSpan={1} className="px-2 py-1.5 text-right" style={{ minWidth: 80 }}>
        <div className="flex items-center gap-1 justify-end">
          <button type="button" onClick={onCancel} className="text-muted hover:text-gray-700 p-1"><X size={13} /></button>
          <button type="button" onClick={submit} className="text-purple-600 hover:text-purple-800 p-1"><Check size={13} /></button>
        </div>
      </td>
    </tr>
  )
}

// ── Main component ─────────────────────────────────────────────

export default function TimesheetGuidelineTab() {
  const { data: allPeople      = [], isLoading: lp } = useAllPeople()
  const { data: allAssignments = [], isLoading: la } = useAllAssignments()
  const { data: allAccruals    = [], isLoading: lc } = useAllAccruals()
  const { data: allWorkItems   = [], isLoading: lw } = useAllWorkItems()
  const { data: allHolidays    = [], isLoading: lh } = useAllHolidays()
  const { data: allAdjustments = [], isLoading: lj } = useAllAdjustments()
  const queryClient = useQueryClient()

  const dataLoading = lp || la || lc || lw || lh || lj

  // ── Window ────────────────────────────────────────────────────
  const todayNum       = today()
  const latestMonNum   = weekStart(todayNum)
  const windowStartNum = latestMonNum - 7 * 7
  const windowEndNum   = latestMonNum + 4

  const todayStr    = numToStr(todayNum)
  const windowStart = numToStr(windowStartNum)
  const windowEnd   = numToStr(windowEndNum)

  const holidaySet = useMemo(() => {
    const yr = new Date().getFullYear()
    return buildHolidaySet(allHolidays, yr - 1, yr + 2)
  }, [allHolidays])

  const isHoliday = useCallback((n: number) => holidaySet.has(n), [holidaySet])

  const allWorkingDays = useMemo(
    () => workingDaysList(windowStartNum, windowEndNum, isHoliday),
    [windowStartNum, windowEndNum, isHoliday],
  )
  const pastWorkingDays = useMemo(
    () => workingDaysList(windowStartNum, latestMonNum - 1, isHoliday),
    [windowStartNum, latestMonNum, isHoliday],
  )
  const weeks = useMemo(
    () => computeWeeks(windowStartNum, windowEndNum, isHoliday),
    [windowStartNum, windowEndNum, isHoliday],
  )
  const allCols = useMemo(() => weeks.flatMap(w => w.columns), [weeks])

  const activePeople = useMemo(() => allPeople.filter(p => p.status !== 'resigned'), [allPeople])

  // ── Snapshot query (TSG-2⑥) ───────────────────────────────────
  const SNAP_KEY = ['tsg_snapshot_v2', windowStart, windowEnd] as const

  const { data: snapshotRows, isLoading: isLoadingSnapshot } = useQuery({
    queryKey: SNAP_KEY,
    queryFn:  async () => {
      const { data, error } = await (supabase as any)
        .from('timesheet_guideline_snapshot')
        .select('person_id, date, code, hours')
        .gte('date', windowStart)
        .lte('date', windowEnd)
      if (error) throw error
      return (data ?? []) as { person_id: string; date: string; code: string; hours: number }[]
    },
    enabled:   !dataLoading,
    staleTime: 5 * 60 * 1000,
  })

  const snapshotVersion = useMemo(() => {
    if (!snapshotRows?.length) return null
    return new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })
  }, [snapshotRows])

  // ── State ─────────────────────────────────────────────────────
  const [isPreviewing,   setIsPreviewing]   = useState(false)
  const [isResetting,    setIsResetting]    = useState(false)
  const [isSaving,       setIsSaving]       = useState(false)
  const [genError,       setGenError]       = useState<string | null>(null)
  const [diagMessage,    setDiagMessage]    = useState<string | null>(null)
  const [savedAt,        setSavedAt]        = useState<string | null>(null)
  const [savedCount,     setSavedCount]     = useState(0)
  const [resetMsg,       setResetMsg]       = useState<string | null>(null)
  const [previewed,      setPreviewed]      = useState(false)
  const [isSnapshotMode, setIsSnapshotMode] = useState(false)
  const [showResetModal, setShowResetModal] = useState(false)
  const [nameSearch,     setNameSearch]     = useState('')
  const [editingWi,      setEditingWi]      = useState<WorkItem | null>(null)
  const [viewMode,       setViewMode]       = useState<'week-person' | 'person-week'>('week-person')

  // Snapshot entries state (keyed by personId||date||code)
  const [allEntries, setAllEntries] = useState<Map<string, SnapshotEntry>>(new Map())

  // [TSG-8] Manual changes
  const [manualChanges,  setManualChanges]  = useState<Map<string, ManualChange>>(new Map())
  const [editCellState,  setEditCellState]  = useState<EditCellState | null>(null)
  const [addCodeState,   setAddCodeState]   = useState<AddCodeState | null>(null)

  // [TSG-10] Person accordion for "사람→주" mode
  const [expandedPeople, setExpandedPeople] = useState<Set<string>>(new Set())
  const togglePerson = useCallback((id: string) => {
    setExpandedPeople(prev => { const s = new Set(prev); s.has(id) ? s.delete(id) : s.add(id); return s })
  }, [])

  const snapshotLoadedRef = useRef(false)

  // Load snapshot into allEntries on first arrival (TSG-2⑥)
  useEffect(() => {
    if (snapshotLoadedRef.current || !snapshotRows || dataLoading) return
    snapshotLoadedRef.current = true
    if (snapshotRows.length === 0) return
    const entries = new Map<string, SnapshotEntry>()
    for (const row of snapshotRows) {
      entries.set(snapKey(row.person_id, row.date, row.code), {
        hours:         row.hours ?? 8,
        provisional:   false,
        existingHours: row.hours ?? 8,
        kind:          'unchanged',
      })
    }
    setAllEntries(entries)
    setPreviewed(true)
    setIsSnapshotMode(true)
  }, [snapshotRows, dataLoading])

  // Accordion: expand first 2 weeks after preview
  const [expandedWeeks, setExpandedWeeks] = useState<Set<string>>(new Set())
  const expandInitRef = useRef(false)
  useEffect(() => {
    if (previewed && weeks.length > 0 && !expandInitRef.current) {
      expandInitRef.current = true
      setExpandedWeeks(new Set(weeks.slice(0, 2).map(w => w.weekStart)))
    }
  }, [previewed, weeks])
  const toggleWeek = useCallback((ws: string) => {
    setExpandedWeeks(prev => { const s = new Set(prev); s.has(ws) ? s.delete(ws) : s.add(ws); return s })
  }, [])

  // [TSG-8] effectiveEntries
  const effectiveEntries = useMemo((): Map<string, SnapshotEntry> => {
    if (manualChanges.size === 0) return allEntries
    const out = new Map(allEntries)
    for (const [key, change] of manualChanges) {
      if (change.hours <= 0) {
        out.delete(key)
      } else {
        const existing = allEntries.get(key)
        out.set(key, {
          hours:         change.hours,
          provisional:   false,
          existingHours: existing?.existingHours ?? (existing ? existing.hours : null),
          kind:          change.isAdd ? 'manual_add' : 'manual_edit',
        })
      }
    }
    return out
  }, [allEntries, manualChanges])

  // ── Shared: TSG-1 compute for given days ─────────────────────
  // TSG-2 핵심 불변식: 스냅샷·과거 수동 이력 참조 없음 — 라이브 데이터만 사용
  // v2.59: per-row try-catch (에러를 삼키지 않고 로그 + 화면 노출),
  //        per-date P-1 check (hire_date/termination_date 범위 이탈 날짜 제외)
  function computeCodes(days: string[]): {
    computed:   Map<string, { hours: number; provisional: boolean }>
    rowErrors:  { personName: string; personId: string; date: string; error: string }[]
    skippedPeople: { personName: string; personId: string; error: string }[]
  } {
    const byPerson = {
      asgn: new Map<string, typeof allAssignments>(),
      accr: new Map<string, typeof allAccruals>(),
      adj:  new Map<string, typeof allAdjustments>(),
    }
    for (const a of allAssignments) {
      if (!byPerson.asgn.has(a.person_id)) byPerson.asgn.set(a.person_id, [])
      byPerson.asgn.get(a.person_id)!.push(a)
    }
    for (const a of allAccruals) {
      if (!byPerson.accr.has(a.person_id)) byPerson.accr.set(a.person_id, [])
      byPerson.accr.get(a.person_id)!.push(a)
    }
    for (const a of allAdjustments) {
      if (!byPerson.adj.has(a.person_id)) byPerson.adj.set(a.person_id, [])
      byPerson.adj.get(a.person_id)!.push(a)
    }

    const computed    = new Map<string, { hours: number; provisional: boolean }>()
    const rowErrors:  { personName: string; personId: string; date: string; error: string }[] = []
    const skippedPeople: { personName: string; personId: string; error: string }[] = []

    for (const person of activePeople) {
      const pa = byPerson.asgn.get(person.id) ?? []
      const pc = byPerson.accr.get(person.id) ?? []
      const pj = byPerson.adj.get(person.id)  ?? []

      // per-person: computeLedger can throw for unusual assignment/accrual state
      let ledger: ReturnType<typeof computeLedger>
      try {
        ledger = computeLedger(person.id, { workItems: allWorkItems, assignments: pa, accruals: pc, isHoliday, today: windowEndNum })
      } catch (e) {
        const msg = formatError(e)
        console.error(`[TSG 초기화 오류] computeLedger — ${person.name} (${person.id}): ${msg}`, e)
        skippedPeople.push({ personName: person.name, personId: person.id, error: msg })
        continue  // skip all dates for this person, log and move on
      }

      const ctx: ResolveContext = { allPeople, assignments: pa, allAssignments, workItems: allWorkItems, isHoliday, ledger, adjustments: pj, hireDate: person.hire_date }

      for (const dateStr of days) {
        // P-1 per-date employment validity (v2.59 root cause fix)
        // 'upcoming' people (hire_date > dateStr) and terminated people
        // (termination_date < dateStr) must not generate snapshot rows for out-of-range dates.
        if (!isEmployedOnDate(person, dateStr)) continue

        try {
          const result = resolveTimesheetCode(person, dateStr, ctx)
          computed.set(snapKey(person.id, dateStr, result.code), { hours: 8, provisional: result.provisional ?? false })
        } catch (e) {
          const msg = formatError(e)
          console.error(`[TSG 초기화 오류] resolveTimesheetCode — ${person.name} (${person.id}) ${dateStr}: ${msg}`, e)
          rowErrors.push({ personName: person.name, personId: person.id, date: dateStr, error: msg })
          // Insert an error-code row so the (person, date) slot is NOT silently missing.
          computed.set(snapKey(person.id, dateStr, '(계산오류)'), { hours: 0, provisional: true })
        }
      }
    }

    return { computed, rowErrors, skippedPeople }
  }

  // ── [1단계] 초기화 with diagnostics ──────────────────────────
  async function handleReset() {
    setShowResetModal(false)
    setIsResetting(true)
    setGenError(null)
    setResetMsg(null)
    setDiagMessage(null)

    // v2.59: expectedCount uses per-date P-1 check (hire_date/termination_date),
    // so 'upcoming' or mid-window-terminated people are excluded from days outside
    // their employment period — matching exactly what computeCodes now generates.
    const expectedCount = activePeople.reduce((sum, p) =>
      sum + pastWorkingDays.filter(d => isEmployedOnDate(p, d)).length, 0)
    console.log(`[TSG 초기화] 시작 — 기대 행수: ${expectedCount} (P-1 per-date 적용, ${activePeople.length}명 × ~${pastWorkingDays.length}일)`)

    try {
      const { computed, rowErrors, skippedPeople } = computeCodes(pastWorkingDays)

      // Expose TSG-1 errors before DB operations so they're visible even if insert fails
      if (rowErrors.length > 0 || skippedPeople.length > 0) {
        const lines: string[] = []
        if (skippedPeople.length > 0) {
          lines.push(`computeLedger 실패 ${skippedPeople.length}명:`)
          skippedPeople.forEach(s => lines.push(`  • ${s.personName}: ${s.error}`))
        }
        if (rowErrors.length > 0) {
          lines.push(`resolveTimesheetCode 실패 ${rowErrors.length}건:`)
          rowErrors.slice(0, 10).forEach(r => lines.push(`  • ${r.personName} ${r.date}: ${r.error}`))
          if (rowErrors.length > 10) lines.push(`  … 외 ${rowErrors.length - 10}건 (콘솔 확인)`)
        }
        console.warn('[TSG 초기화 TSG-1 오류]', { rowErrors, skippedPeople })
        setDiagMessage(`[TSG-1 오류 ${rowErrors.length + skippedPeople.length}건]\n${lines.join('\n')}`)
      }

      const runAt = new Date().toISOString()
      const rows = [...computed.entries()].map(([key, comp]) => {
        const [personId, date, code] = parseSnapKey(key)
        return { person_id: personId, date, code, hours: comp.hours, detail: comp.provisional ? '(임시)' : null, run_at: runAt }
      })
      console.log(`[TSG 초기화] 계산 완료 — ${rows.length}행 생성 (기대 ${expectedCount}행)`)

      // Delete-then-insert for past window (atomic replace)
      const pastEnd = numToStr(latestMonNum - 1)
      await deleteSnapshotRange(windowStart, pastEnd)
      await batchInsertSnapshot(rows)

      // Diagnostic verification: recount rows and find missing (person, date) pairs
      const { count: actualCount, error: cntErr } = await (supabase as any)
        .from('timesheet_guideline_snapshot')
        .select('*', { count: 'exact', head: true })
        .gte('date', windowStart)
        .lte('date', pastEnd)

      if (!cntErr) {
        console.log(`[TSG 초기화 검증] 기대: ${expectedCount}행, 실제: ${actualCount}행`)
        if (actualCount !== expectedCount) {
          const { data: actualRows } = await (supabase as any)
            .from('timesheet_guideline_snapshot')
            .select('person_id, date')
            .gte('date', windowStart)
            .lte('date', pastEnd)
          const actualSet = new Set((actualRows ?? []).map((r: any) => `${r.person_id}|${r.date}`))
          const missing: { name: string; date: string }[] = []
          for (const p of activePeople) {
            for (const d of pastWorkingDays) {
              if (!isEmployedOnDate(p, d)) continue
              if (!actualSet.has(`${p.id}|${d}`)) missing.push({ name: p.name, date: d })
            }
          }
          if (missing.length > 0) {
            console.warn('[TSG 초기화 검증] 누락된 행:', missing.slice(0, 20))
            const preview = missing.slice(0, 5).map(m => `${m.name} ${m.date}`).join(', ')
            setDiagMessage(prev =>
              `${prev ? prev + '\n' : ''}[검증] 기대 ${expectedCount}행, 실제 ${actualCount}행 — 누락 ${missing.length}건: ${preview}${missing.length > 5 ? ' …' : ''}`
            )
          }
        }
      }

      // Purge rows older than current window
      const { error: delOldErr } = await (supabase as any)
        .from('timesheet_guideline_snapshot')
        .delete()
        .lt('date', windowStart)
      if (delOldErr) console.warn('[TSG 초기화] 구 항목 삭제 실패:', delOldErr)

      setResetMsg(`과거 ${rows.length}건 재설정 완료`)
      void queryClient.invalidateQueries({ queryKey: SNAP_KEY })
    } catch (e) {
      setGenError(formatError(e))
    } finally {
      setIsResetting(false)
    }
  }

  // ── [2단계] 지침 생성 (순수 계산 → 스냅샷 비교, 미반영) ───────
  async function handlePreview() {
    setIsSnapshotMode(false)
    setManualChanges(new Map())
    setEditCellState(null)
    setAddCodeState(null)
    setIsPreviewing(true)
    setGenError(null)
    setResetMsg(null)
    setDiagMessage(null)
    expandInitRef.current = false
    try {
      // TSG-1: pure computation — no snapshot access
      const { computed, rowErrors, skippedPeople } = computeCodes(allWorkingDays)

      if (rowErrors.length > 0 || skippedPeople.length > 0) {
        const lines: string[] = []
        if (skippedPeople.length > 0) lines.push(`computeLedger 실패 ${skippedPeople.length}명: ${skippedPeople.map(s => s.personName).join(', ')}`)
        if (rowErrors.length > 0) lines.push(`resolveTimesheetCode 실패 ${rowErrors.length}건 (콘솔 확인)`)
        console.warn('[TSG 지침 생성 TSG-1 오류]', { rowErrors, skippedPeople })
        setDiagMessage(lines.join('\n'))
      }

      // Fetch current snapshot for comparison
      const { data: snapRows, error: fetchErr } = await (supabase as any)
        .from('timesheet_guideline_snapshot')
        .select('person_id, date, code, hours')
        .gte('date', windowStart)
        .lte('date', windowEnd)
      if (fetchErr) throw fetchErr

      const snapMap = new Map<string, number>()  // snapKey → hours
      for (const row of snapRows ?? []) {
        snapMap.set(snapKey(row.person_id, row.date, row.code), row.hours ?? 8)
      }

      // Build allEntries by comparing computed vs snapshot
      const entries = new Map<string, SnapshotEntry>()

      // 1. All computed entries
      for (const [key, comp] of computed) {
        const existingHours = snapMap.get(key) ?? null
        const kind: SnapshotEntry['kind'] =
          existingHours === null      ? 'new' :
          existingHours !== comp.hours ? 'correction' : 'unchanged'
        entries.set(key, { hours: comp.hours, provisional: comp.provisional, existingHours, kind })
      }

      // 2. Snapshot entries not in computed → to_remove
      for (const [key, hours] of snapMap) {
        if (!computed.has(key)) {
          entries.set(key, { hours: 0, provisional: false, existingHours: hours, kind: 'to_remove' })
        }
      }

      setAllEntries(entries)
      setSavedAt(null)
      setSavedCount(0)
      setPreviewed(true)
    } catch (e) {
      setGenError(formatError(e))
    } finally {
      setIsPreviewing(false)
    }
  }

  // ── [3단계] 반영 (TSG-2③, delete-then-insert → 멱등성 보장) ──
  async function handleSave() {
    setIsSaving(true)
    setGenError(null)
    try {
      const runAt = new Date().toISOString()
      const rows: object[] = []
      for (const [key, entry] of effectiveEntries) {
        if (entry.kind === 'to_remove') continue
        if (entry.hours <= 0) continue
        const [personId, date, code] = parseSnapKey(key)
        rows.push({
          person_id: personId, date, code,
          hours:  entry.hours,
          detail: entry.kind === 'manual_edit' || entry.kind === 'manual_add'
            ? '(관리자 수정)'
            : entry.provisional ? '(임시 — 추후 정정 필요)' : null,
          run_at: runAt,
        })
      }

      // Delete entire 8-week window, then insert (complete replace → idempotent)
      await deleteSnapshotRange(windowStart, windowEnd)

      const { error: delOldErr } = await (supabase as any)
        .from('timesheet_guideline_snapshot')
        .delete()
        .lt('date', windowStart)
      if (delOldErr) throw delOldErr

      await batchInsertSnapshot(rows)

      void queryClient.invalidateQueries({ queryKey: SNAP_KEY })
      setManualChanges(new Map())
      setSavedCount(rows.length)
      setSavedAt(new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }))
    } catch (e) {
      setGenError(formatError(e))
    } finally {
      setIsSaving(false)
    }
  }

  // ── [TSG-8] Cell edit handlers ────────────────────────────────
  function startCellEdit(personId: string, date: string, code: string, currentHours: number) {
    setEditCellState({ personId, date, code, value: String(currentHours) })
  }

  function commitCellEdit() {
    if (!editCellState) return
    const h = parseFloat(editCellState.value)
    const key = snapKey(editCellState.personId, editCellState.date, editCellState.code)
    if (!isNaN(h) && h >= 0) {
      setManualChanges(prev => { const m = new Map(prev); m.set(key, { hours: h, isAdd: false }); return m })
    }
    setEditCellState(null)
  }

  function commitAddCode(state: AddCodeState) {
    setManualChanges(prev => {
      const m = new Map(prev)
      for (const [date, hStr] of Object.entries(state.hours)) {
        const h = parseFloat(hStr)
        if (!isNaN(h) && h > 0) {
          m.set(snapKey(state.personId, date, state.code), { hours: h, isAdd: true })
        }
      }
      return m
    })
    setAddCodeState(null)
  }

  // ── Derived ───────────────────────────────────────────────────
  const filteredPeople = useMemo(() => {
    let out = [...activePeople]
    if (nameSearch.trim()) {
      const matches = parseSearchQuery(nameSearch)
      out = out.filter(p => matches([p.name]))
    }
    return sortPeople(out)
  }, [activePeople, nameSearch])

  const { newCount, corrCount, manualCount } = useMemo(() => {
    let n = 0, c = 0, m = 0
    for (const entry of effectiveEntries.values()) {
      if (entry.kind === 'new') n++
      else if (entry.kind === 'correction') c++
      else if (entry.kind === 'manual_edit' || entry.kind === 'manual_add') m++
    }
    return { newCount: n, corrCount: c, manualCount: m }
  }, [effectiveEntries])

  // [TSG-9] Hours validation
  const [showAlerts, setShowAlerts] = useState(false)
  const hoursAlerts = useMemo(() => {
    if (!previewed) return []
    const alerts: { personName: string; weekLabel: string; workdays: number; totalHours: number }[] = []
    for (const week of weeks) {
      const workdays = week.columns.filter(c => !c.isHoliday).length
      if (workdays === 0) continue
      for (const person of filteredPeople) {
        let totalHours = 0
        for (const col of week.columns) {
          if (col.isHoliday) continue
          const prefix = `${person.id}||${col.date}||`
          for (const [key, entry] of effectiveEntries) {
            if (!key.startsWith(prefix)) continue
            if (entry.kind !== 'to_remove' && entry.hours > 0) totalHours += entry.hours
          }
        }
        if (totalHours < workdays * 8) {
          alerts.push({ personName: person.name, weekLabel: week.label, workdays, totalHours })
        }
      }
    }
    return alerts
  }, [previewed, weeks, filteredPeople, effectiveEntries])

  // ── Cell render helper ────────────────────────────────────────
  const anyBusy = isPreviewing || isResetting || isSaving
  const isLoading = dataLoading || isLoadingSnapshot

  function renderCell(
    person:   Person,
    col:      ColInfo,
    code:     string,
    c:        { hours: number; changeKind: ChangeKind } | undefined,
    zebraRow: string,
  ) {
    if (col.isHoliday) return <td key={col.date} className="bg-gray-50 text-center text-[10px] text-muted">—</td>
    if (!c) return <td key={col.date} className={zebraRow} />

    const bgCls =
      c.changeKind === 'new'      ? 'bg-blue-50' :
      c.changeKind === 'replaced' ? 'bg-amber-50' :
      c.changeKind === 'removed'  ? 'bg-rose-50' :
      c.changeKind === 'manual'   ? 'bg-purple-50' : zebraRow

    const textCls =
      c.changeKind === 'new'      ? 'text-blue-700 font-semibold' :
      c.changeKind === 'replaced' ? 'text-amber-700 font-semibold' :
      c.changeKind === 'removed'  ? 'text-rose-400' :
      c.changeKind === 'manual'   ? 'text-purple-700 font-semibold' : 'text-gray-700'

    const isEditing =
      editCellState?.personId === person.id &&
      editCellState?.date === col.date &&
      editCellState?.code === code

    const canEdit = !isSnapshotMode && c.changeKind !== 'removed'

    return (
      <td
        key={col.date}
        className={`text-center py-1 px-0.5 ${bgCls} ${canEdit && !isEditing ? 'cursor-pointer' : ''}`}
        title={canEdit && !isEditing ? '클릭하여 시간 수정 (TSG-8)' : undefined}
        onClick={() => {
          if (!canEdit || isEditing) return
          startCellEdit(person.id, col.date, code, c.hours)
        }}
      >
        {isEditing ? (
          <input
            type="number" min="0" max="24" step="0.5"
            value={editCellState.value}
            onChange={e => setEditCellState(s => s ? { ...s, value: e.target.value } : null)}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); commitCellEdit() } if (e.key === 'Escape') setEditCellState(null) }}
            onBlur={commitCellEdit}
            autoFocus
            className="w-full text-[10px] font-mono border border-purple-400 rounded px-0.5 py-0 focus:outline-none bg-white text-purple-900 text-center"
            onClick={e => e.stopPropagation()}
          />
        ) : (
          <span className={`tabular-nums text-xs ${textCls}`}>
            {c.changeKind === 'removed' ? '—' : c.hours > 0 ? c.hours : ''}
          </span>
        )}
      </td>
    )
  }

  // ── Render ─────────────────────────────────────────────────────

  return (
    <div className="space-y-4">

      {/* ── Header bar ────────────────────────────────────────── */}
      <div className="flex flex-wrap items-start gap-3">
        <div>
          <h3 className="text-sm font-semibold text-gray-800">타임시트 지침 생성</h3>
          <p className="text-xs text-muted mt-0.5">
            최신 주: {numToStr(latestMonNum)} ~ {windowEnd}
            <span className="ml-2">창: {windowStart} ~ {windowEnd}</span>
            <span className="ml-2">영업일 {allWorkingDays.length}일</span>
            <span className="ml-2">대상 {activePeople.length}명</span>
          </p>
          {isSnapshotMode && snapshotVersion && (
            <p className="text-[10px] text-muted mt-0.5">
              스냅샷 기준: <span className="font-medium">{snapshotVersion}</span>
              <span className="ml-1 text-muted/70">— "지침 생성"으로 최신 데이터 반영</span>
            </p>
          )}
        </div>

        <div className="ml-auto flex items-center gap-2 flex-wrap justify-end">
          <button onClick={() => setShowResetModal(true)} disabled={anyBusy || isLoading}
            title="최신 주를 제외한 과거 7주를 현재 데이터로 재설정"
            className="btn-secondary text-xs py-1 gap-1 disabled:opacity-40">
            {isResetting
              ? <><Loader2 size={13} className="animate-spin" /> 초기화 중…</>
              : <><RotateCcw size={13} /> 초기화</>}
          </button>

          <button onClick={handlePreview} disabled={anyBusy || isLoading}
            className="btn-secondary text-xs py-1 gap-1 disabled:opacity-40">
            {isPreviewing
              ? <><Loader2 size={13} className="animate-spin" /> 생성 중…</>
              : previewed
                ? <><RefreshCw size={13} /> 재생성</>
                : <><Play size={13} /> 지침 생성</>}
          </button>

          {previewed && (
            <>
              <button
                onClick={() => triggerDownload(
                  generateGuidelineHtml(weeks, filteredPeople, effectiveEntries, windowStart, windowEnd, todayStr),
                  `타임시트지침_${todayStr}.html`,
                )}
                disabled={anyBusy} className="btn-secondary text-xs py-1 gap-1 disabled:opacity-40">
                <Download size={13} /> HTML 저장
              </button>
              <button onClick={handleSave} disabled={isSaving || effectiveEntries.size === 0}
                className="btn-primary text-xs py-1 gap-1 disabled:opacity-40">
                {isSaving
                  ? <><Loader2 size={13} className="animate-spin" /> 반영 중…</>
                  : <><Save size={13} /> {effectiveEntries.size}건 반영</>}
              </button>
            </>
          )}
        </div>
      </div>

      {isLoading && (
        <div className="flex items-center gap-2 text-xs text-muted">
          <Loader2 size={14} className="animate-spin" /> {dataLoading ? '데이터 로딩 중…' : '스냅샷 로딩 중…'}
        </div>
      )}

      {genError && (
        <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 flex items-center gap-2">
          <AlertTriangle size={13} className="flex-shrink-0" /> {genError}
        </div>
      )}
      {diagMessage && (
        <div className="rounded border border-orange-200 bg-orange-50 px-3 py-2 text-xs text-orange-700 flex items-center gap-2">
          <AlertTriangle size={13} className="flex-shrink-0" /> {diagMessage}
        </div>
      )}
      {resetMsg && (
        <div className="rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-700">
          {resetMsg}
        </div>
      )}
      {savedAt && (
        <div className="rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-700">
          {savedCount}건 반영됨 — {savedAt}
        </div>
      )}

      <PendingProjectsPanel workItems={allWorkItems} assignments={allAssignments}
        windowStart={windowStart} windowEnd={windowEnd} onEdit={setEditingWi} />

      {/* [TSG-9] Hours alerts */}
      {hoursAlerts.length > 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
          <button onClick={() => setShowAlerts(v => !v)}
            className="w-full flex items-center gap-2 text-xs font-semibold text-amber-700">
            <AlertTriangle size={13} />
            <span>투입시간 미달 경고 {hoursAlerts.length}건</span>
            <span className="ml-1 font-normal text-amber-600">(TSG-9)</span>
            <span className="ml-auto">{showAlerts ? '▲' : '▼'}</span>
          </button>
          {showAlerts && (
            <div className="mt-2 space-y-1 max-h-48 overflow-y-auto">
              {hoursAlerts.map((a, i) => (
                <div key={i} className="flex items-center gap-2 text-[11px] bg-white/70 rounded px-2 py-1">
                  <span className="font-medium text-gray-800 w-20 truncate">{a.personName}</span>
                  <span className="text-muted flex-1 truncate">{a.weekLabel}</span>
                  <span className="font-mono text-amber-700">{a.totalHours}/{a.workdays * 8}h</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {!previewed && !isPreviewing && !isLoading && (
        <div className="rounded-md border border-border bg-surface-50 px-4 py-10 text-center">
          <p className="text-sm text-muted">"지침 생성" 버튼을 눌러 이번 주 타임시트 코드 지침을 산출하세요.</p>
          <p className="text-xs text-muted mt-1">8주 창({windowStart} ~ {windowEnd}) 전체를 분석하며, 반영 전까지 스냅샷을 변경하지 않습니다.</p>
        </div>
      )}

      {/* ── Matrix ─────────────────────────────────────────────── */}
      {previewed && (
        <>
          {/* Controls row: summary + search + view toggle */}
          <div className="flex items-center gap-3 flex-wrap border-b border-border pb-3">
            <div className="flex items-center gap-2 text-xs">
              {isSnapshotMode ? (
                <span className="pill bg-gray-100 text-gray-600">스냅샷 표시 중</span>
              ) : (
                <>
                  <span className="pill bg-blue-100 text-blue-700">신규 {newCount}건</span>
                  <span className={`pill text-[10px] ${corrCount > 0 ? 'bg-amber-100 text-amber-700' : 'bg-gray-100 text-gray-500'}`}>정정 {corrCount}건</span>
                  {manualCount > 0 && <span className="pill bg-purple-100 text-purple-700">관리자 수정 {manualCount}건</span>}
                  <span className="text-[10px] text-muted">미리보기 (반영 전)</span>
                </>
              )}
            </div>

            {/* [TSG-10] View toggle */}
            <div className="flex items-center gap-1 rounded-md border border-border overflow-hidden text-xs">
              <button
                onClick={() => setViewMode('week-person')}
                className={`px-2.5 py-1 transition-colors ${viewMode === 'week-person' ? 'bg-brand-50 text-brand-700 font-medium' : 'text-muted hover:bg-surface-100'}`}>
                주 → 사람
              </button>
              <button
                onClick={() => setViewMode('person-week')}
                className={`px-2.5 py-1 transition-colors ${viewMode === 'person-week' ? 'bg-brand-50 text-brand-700 font-medium' : 'text-muted hover:bg-surface-100'}`}>
                사람 → 주
              </button>
            </div>

            <input className="input py-1 text-xs w-52 ml-auto" placeholder="이름 검색…"
              value={nameSearch} onChange={e => setNameSearch(e.target.value)} />
            {nameSearch && <button onClick={() => setNameSearch('')} className="text-xs text-muted hover:text-gray-700">초기화</button>}

            {viewMode === 'week-person' && (
              <button
                onClick={() => setExpandedWeeks(expandedWeeks.size === weeks.length ? new Set() : new Set(weeks.map(w => w.weekStart)))}
                className="text-xs text-brand-600 hover:underline whitespace-nowrap">
                {expandedWeeks.size === weeks.length ? '전체 접기' : '전체 펼치기'}
              </button>
            )}
            {viewMode === 'person-week' && !isSnapshotMode && (
              <button
                onClick={() => setExpandedPeople(expandedPeople.size === filteredPeople.length ? new Set() : new Set(filteredPeople.map(p => p.id)))}
                className="text-xs text-brand-600 hover:underline whitespace-nowrap">
                {expandedPeople.size === filteredPeople.length ? '전체 접기' : '전체 펼치기'}
              </button>
            )}
          </div>

          {!isSnapshotMode && (
            <div className="flex items-center gap-3 text-[10px] text-muted flex-wrap">
              <span className="flex items-center gap-1"><span className="inline-block w-3 h-3 rounded bg-blue-100" /> 신규</span>
              <span className="flex items-center gap-1"><span className="inline-block w-3 h-3 rounded bg-amber-100" /> 정정(신규 코드)</span>
              <span className="flex items-center gap-1"><span className="inline-block w-3 h-3 rounded bg-rose-100" /> 정정(이전 코드 삭제)</span>
              <span className="flex items-center gap-1"><span className="inline-block w-3 h-3 rounded bg-purple-100" /> 관리자 수정</span>
              <span className="ml-auto text-[10px]">셀 클릭 → 시간 수정 (TSG-8)</span>
            </div>
          )}

          {/* ══ [TSG-10] 주→사람 mode ══════════════════════════════ */}
          {viewMode === 'week-person' && (
            <div className="space-y-2">
              {weeks.map(week => {
                const isOpen = expandedWeeks.has(week.weekStart)
                let wNew = 0, wCorr = 0, wManual = 0
                for (const p of activePeople) for (const col of week.columns) {
                  if (col.isHoliday) continue
                  const prefix = `${p.id}||${col.date}||`
                  for (const [key, entry] of effectiveEntries) {
                    if (!key.startsWith(prefix)) continue
                    if (entry.kind === 'new') wNew++
                    else if (entry.kind === 'correction') wCorr++
                    else if (entry.kind === 'manual_edit' || entry.kind === 'manual_add') wManual++
                  }
                }
                const isLatest = week.weekStart === numToStr(latestMonNum)
                return (
                  <div key={week.weekStart} className="rounded-lg border border-border overflow-hidden">
                    <button onClick={() => toggleWeek(week.weekStart)}
                      className="w-full flex items-center gap-2 px-4 py-2.5 bg-surface-50 hover:bg-surface-100 transition-colors text-left select-none">
                      {isOpen ? <ChevronDown size={14} className="text-muted flex-shrink-0" /> : <ChevronRight size={14} className="text-muted flex-shrink-0" />}
                      <span className="text-sm font-semibold text-gray-800">{week.label}</span>
                      {isLatest && <span className="pill bg-brand-100 text-brand-700 text-[10px]">이번 주</span>}
                      {!isSnapshotMode && wNew > 0    && <span className="pill bg-blue-100 text-blue-700 text-[10px]">신규 {wNew}</span>}
                      {!isSnapshotMode && wCorr > 0   && <span className="pill bg-amber-100 text-amber-700 text-[10px]">정정 {wCorr}</span>}
                      {!isSnapshotMode && wManual > 0  && <span className="pill bg-purple-100 text-purple-700 text-[10px]">관리자 {wManual}</span>}
                      {!isSnapshotMode && wNew === 0 && wCorr === 0 && wManual === 0 && <span className="text-xs text-muted">변경 없음</span>}
                    </button>

                    {isOpen && (
                      <div className="overflow-x-auto">
                        <table className="border-t border-border"
                          style={{ tableLayout: 'fixed', width: `${CODE_COL_W + week.columns.length * DAY_COL_W}px` }}>
                          <colgroup>
                            <col style={{ width: CODE_COL_W }} />
                            {week.columns.map(col => <col key={col.date} style={{ width: DAY_COL_W }} />)}
                          </colgroup>
                          <thead>
                            <tr className="bg-surface-50 border-b border-border">
                              <th className="px-3 py-2 text-left text-xs font-medium text-muted sticky left-0 bg-surface-50 z-10">코드</th>
                              {week.columns.map(col => (
                                <th key={col.date} className={['py-2 text-center text-xs font-medium', col.isHoliday ? 'text-gray-400 bg-gray-50' : 'text-gray-700'].join(' ')}>
                                  <div>{col.label}</div>
                                  {col.isHoliday && <div className="text-[9px] text-gray-400 font-normal">공휴일</div>}
                                </th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {filteredPeople.map((person, pi) => {
                              const codeRows = buildCodeRows(person.id, week.columns, effectiveEntries)
                              if (codeRows.length === 0) return null
                              const zebraRow = ZEBRA_ROW[pi % 2]
                              const zebraHdr = ZEBRA_HDR[pi % 2]
                              const isAddingCode = addCodeState?.personId === person.id && addCodeState.weekStart === week.weekStart

                              return (
                                <Fragment key={person.id}>
                                  <tr className={`${zebraHdr} border-t-2 border-slate-300/60`}>
                                    <td colSpan={week.columns.length + 1} className={`px-3 py-1.5 sticky left-0 ${zebraHdr}`}>
                                      <div className="flex items-center gap-2">
                                        <span className="font-semibold text-gray-700 text-xs">{person.name}</span>
                                        <span className="text-[10px] text-muted font-normal">{person.rank}</span>
                                        {!isSnapshotMode && !isAddingCode && (
                                          <button
                                            onClick={() => setAddCodeState({ personId: person.id, weekStart: week.weekStart, code: '', hours: {} })}
                                            className="ml-auto flex items-center gap-1 text-[10px] text-purple-600 hover:text-purple-800 font-medium">
                                            <Plus size={10} /> 코드 추가
                                          </button>
                                        )}
                                      </div>
                                    </td>
                                  </tr>

                                  {/* AddCode inline form */}
                                  {isAddingCode && (
                                    <AddCodeForm
                                      state={addCodeState}
                                      weekCols={week.columns}
                                      onConfirm={commitAddCode}
                                      onCancel={() => setAddCodeState(null)}
                                    />
                                  )}

                                  {codeRows.map(row => (
                                    <tr key={row.code} className={`${zebraRow} border-b border-border/20 hover:brightness-[0.97]`}>
                                      <td className={`px-3 py-1.5 font-mono text-[11px] text-gray-700 sticky left-0 ${zebraRow} z-10 border-r border-border/20`}>
                                        <span className="flex items-center gap-1">
                                          <span className="truncate">{row.code}</span>
                                          {row.provisional && <AlertTriangle size={9} className="text-amber-500 flex-shrink-0" />}
                                          {row.isManual && <span className="text-[9px] bg-purple-100 text-purple-700 rounded px-1">관리자</span>}
                                        </span>
                                      </td>
                                      {week.columns.map(col => renderCell(person, col, row.code, row.cells.get(col.date), zebraRow))}
                                    </tr>
                                  ))}
                                </Fragment>
                              )
                            })}
                            {filteredPeople.every(p => buildCodeRows(p.id, week.columns, effectiveEntries).length === 0) && (
                              <tr>
                                <td colSpan={week.columns.length + 1} className="px-3 py-4 text-center text-xs text-muted">
                                  {nameSearch ? '검색 결과 없음' : '해당 주 데이터 없음'}
                                </td>
                              </tr>
                            )}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}

          {/* ══ [TSG-10] 사람→주 mode ══════════════════════════════ */}
          {viewMode === 'person-week' && (
            <div className="space-y-2">
              {filteredPeople.map((person, pi) => {
                const codeRows = buildCodeRows(person.id, allCols, effectiveEntries)
                if (codeRows.length === 0) return null
                const isOpen = expandedPeople.has(person.id)
                const zebraRow = ZEBRA_ROW[pi % 2]

                // Count changes for this person
                let pNew = 0, pCorr = 0, pManual = 0
                for (const row of codeRows) for (const c of row.cells.values()) {
                  if (c.changeKind === 'new') pNew++
                  else if (c.changeKind === 'replaced') pCorr++
                  else if (c.changeKind === 'manual') pManual++
                }

                return (
                  <div key={person.id} className="rounded-lg border border-border overflow-hidden">
                    <button onClick={() => togglePerson(person.id)}
                      className="w-full flex items-center gap-2 px-4 py-2.5 bg-surface-50 hover:bg-surface-100 transition-colors text-left select-none">
                      {isOpen ? <ChevronDown size={14} className="text-muted flex-shrink-0" /> : <ChevronRight size={14} className="text-muted flex-shrink-0" />}
                      <span className="text-sm font-semibold text-gray-800">{person.name}</span>
                      <span className="text-xs text-muted">{person.rank}</span>
                      {!isSnapshotMode && pNew > 0    && <span className="pill bg-blue-100 text-blue-700 text-[10px]">신규 {pNew}</span>}
                      {!isSnapshotMode && pCorr > 0   && <span className="pill bg-amber-100 text-amber-700 text-[10px]">정정 {pCorr}</span>}
                      {!isSnapshotMode && pManual > 0  && <span className="pill bg-purple-100 text-purple-700 text-[10px]">관리자 {pManual}</span>}
                    </button>

                    {isOpen && (
                      <div className="overflow-x-auto border-t border-border">
                        <table style={{ tableLayout: 'fixed', width: `${CODE_COL_W + allCols.length * DAY_COL_W}px` }}>
                          <colgroup>
                            <col style={{ width: CODE_COL_W }} />
                            {allCols.map(col => <col key={col.date} style={{ width: DAY_COL_W }} />)}
                          </colgroup>
                          <thead>
                            {/* Week group header */}
                            <tr className="bg-surface-50 border-b border-border/50">
                              <th rowSpan={2} className="px-3 py-2 text-left text-xs font-medium text-muted sticky left-0 bg-surface-50 z-10 align-middle">코드</th>
                              {weeks.map(week => (
                                <th key={week.weekStart} colSpan={week.columns.length}
                                  className="py-1 text-center text-[10px] font-medium text-gray-600 border-l border-border/30">
                                  {week.label}
                                  {week.weekStart === numToStr(latestMonNum) && <span className="ml-1 text-[9px] text-brand-600">●</span>}
                                </th>
                              ))}
                            </tr>
                            {/* Day header */}
                            <tr className="bg-surface-50 border-b border-border">
                              {allCols.map(col => (
                                <th key={col.date} className={['py-1 text-center text-[10px] font-medium border-l border-border/20', col.isHoliday ? 'text-gray-400 bg-gray-50' : 'text-gray-600'].join(' ')}>
                                  {col.label}
                                  {col.isHoliday && <div className="text-[8px] text-gray-400 font-normal">공휴</div>}
                                </th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {codeRows.map(row => (
                              <tr key={row.code} className={`${zebraRow} border-b border-border/20 hover:brightness-[0.97]`}>
                                <td className={`px-3 py-1.5 font-mono text-[11px] text-gray-700 sticky left-0 ${zebraRow} z-10 border-r border-border/20`}>
                                  <span className="flex items-center gap-1">
                                    <span className="truncate">{row.code}</span>
                                    {row.provisional && <AlertTriangle size={9} className="text-amber-500 flex-shrink-0" />}
                                    {row.isManual && <span className="text-[9px] bg-purple-100 text-purple-700 rounded px-1">관리자</span>}
                                  </span>
                                </td>
                                {allCols.map(col => renderCell(person, col, row.code, row.cells.get(col.date), zebraRow))}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                )
              })}
              {filteredPeople.every(p => buildCodeRows(p.id, allCols, effectiveEntries).length === 0) && (
                <div className="px-3 py-8 text-center text-xs text-muted">
                  {nameSearch ? '검색 결과 없음' : '데이터 없음'}
                </div>
              )}
            </div>
          )}
        </>
      )}

      {/* Modals */}
      {showResetModal && (
        <ResetConfirmModal pastDayCount={pastWorkingDays.length} onConfirm={handleReset} onClose={() => setShowResetModal(false)} />
      )}
      {editingWi && (
        <EditCodeModal wi={editingWi} onClose={() => setEditingWi(null)} onSaved={() => setEditingWi(null)} />
      )}
    </div>
  )
}
