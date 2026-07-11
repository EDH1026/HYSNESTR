/**
 * TimesheetGuidelineTab — AL-12/13/14/15/16/17
 * 코드-행 × 날짜-열 × 시간 매트릭스. 인력별 그룹(zebra), 주차별 아코디언.
 *
 * 워크플로우 (AL-12 3단계):
 *   1. 초기화 — 과거 7주 스냅샷을 현재 데이터로 조용히 덮어씀 (확인 모달)
 *   2. 지침 생성 — 8주 전체 미리보기; 스냅샷 미변경
 *   3. 저장 — 미리보기 결과를 스냅샷에 실제 반영
 *
 * 창 정의 (AL-12 버그 수정):
 *   최신 주 = 오늘이 속한 주(월~금). 미래 날짜 포함 안 함.
 *   8주 창  = 최신 주 포함 이전 7주. windowEnd = latestFriday.
 */
import { useState, useMemo, useCallback, useRef, useEffect, Fragment } from 'react'
import {
  Loader2, Play, Download, Save, AlertTriangle, RefreshCw,
  ChevronDown, ChevronRight, Pencil, X, Check, RotateCcw,
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

const RANK_ORDER: Record<Rank, number> = {
  Partner: 0, SM: 1, M: 2, Senior: 3, Staff: 4, Intern: 5,
}

// Alternating zebra backgrounds (person index % 2)
const ZEBRA_ROW = ['bg-white', 'bg-slate-50/60'] as const
const ZEBRA_HDR = ['bg-slate-100/70', 'bg-slate-200/50'] as const

// Fixed column widths
const CODE_COL_W = 160  // px
const DAY_COL_W  = 80   // px

// ── Types ──────────────────────────────────────────────────────

interface CellData {
  computed:    string
  provisional: boolean
  existing:    string | null
  kind:        'new' | 'correction' | 'unchanged'
}

type ChangeKind = 'new' | 'replaced' | 'removed' | 'unchanged'

interface CodeRowData {
  code:        string
  provisional: boolean
  cells:       Map<string, { hasHours: boolean; changeKind: ChangeKind }>
}

interface ColInfo {
  date:      string
  label:     string
  isHoliday: boolean
}

interface WeekInfo {
  weekStart: string
  label:     string
  columns:   ColInfo[]  // always Mon–Fri
}

// ── Pure helpers ───────────────────────────────────────────────

function entryKey(personId: string, date: string) {
  return `${personId}|${date}`
}

function monthDay(s: string): string {
  return `${parseInt(s.slice(5, 7), 10)}/${parseInt(s.slice(8, 10), 10)}`
}

/** Build 8 weeks, latest first. Each week is always Mon–Fri. */
function computeWeeks(
  windowStartNum: number,   // must be a Monday
  windowEndNum:   number,   // must be a Friday
  isHoliday:      (n: number) => boolean,
): WeekInfo[] {
  const weeks: WeekInfo[] = []
  let monNum = windowStartNum

  while (monNum <= windowEndNum) {
    const columns: ColInfo[] = []
    for (let d = 0; d < 5; d++) {
      const n = monNum + d
      const s = numToStr(n)
      columns.push({
        date:      s,
        label:     `${DAY_NAMES[d]} ${monthDay(s)}`,
        isHoliday: isHoliday(n),
      })
    }
    weeks.push({
      weekStart: numToStr(monNum),
      label:     `${monthDay(numToStr(monNum))}(월) ~ ${monthDay(numToStr(monNum + 4))}(금)`,
      columns,
    })
    monNum += 7
  }
  return weeks.reverse()   // latest first
}

function sortPeople(people: Person[]): Person[] {
  return [...people].sort((a, b) => {
    const rc = (RANK_ORDER[a.rank] ?? 99) - (RANK_ORDER[b.rank] ?? 99)
    return rc !== 0 ? rc : a.name.localeCompare(b.name, 'ko')
  })
}

/** Build code-row data for one person in one week. */
function buildCodeRows(
  personId: string,
  week:     WeekInfo,
  allCells: Map<string, CellData>,
): CodeRowData[] {
  const codeMap = new Map<string, { provisional: boolean; cells: Map<string, { hasHours: boolean; changeKind: ChangeKind }> }>()

  const ensure = (code: string) => {
    if (!codeMap.has(code)) codeMap.set(code, { provisional: false, cells: new Map() })
    return codeMap.get(code)!
  }

  for (const col of week.columns) {
    if (col.isHoliday) continue
    const cell = allCells.get(entryKey(personId, col.date))
    if (!cell) continue

    const cur = ensure(cell.computed)
    if (cell.provisional) cur.provisional = true
    const ck: ChangeKind =
      cell.kind === 'new'        ? 'new' :
      cell.kind === 'correction' ? 'replaced' : 'unchanged'
    cur.cells.set(col.date, { hasHours: true, changeKind: ck })

    if (cell.kind === 'correction' && cell.existing && cell.existing !== cell.computed) {
      ensure(cell.existing).cells.set(col.date, { hasHours: false, changeKind: 'removed' })
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

/** Format Supabase/unknown errors into a human-readable string (AL-16). */
function formatError(e: unknown): string {
  if (e instanceof Error) return e.message
  if (typeof e === 'object' && e !== null) {
    const obj = e as Record<string, unknown>
    const parts = [obj.message, obj.details, obj.hint]
      .filter((v): v is string => typeof v === 'string' && v.length > 0)
    if (parts.length) return parts.join(' — ')
  }
  return '저장 중 알 수 없는 오류가 발생했습니다.'
}

/** Working days (Mon–Fri, not holiday) in a numeric range [fromNum, toNum] inclusive. */
function workingDaysList(fromNum: number, toNum: number, isHoliday: (n: number) => boolean): string[] {
  const days: string[] = []
  for (let n = fromNum; n <= toNum; n++) {
    if (!isWeekend(n) && !isHoliday(n)) days.push(numToStr(n))
  }
  return days
}

// ── HTML export ────────────────────────────────────────────────

function generateGuidelineHtml(
  weeks:       WeekInfo[],
  people:      Person[],
  allCells:    Map<string, CellData>,
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
  }

  const weekSections = weeks.map(week => {
    const colW = `width:${DAY_COL_W}px;text-align:center`
    const colHeaders = week.columns.map(col =>
      `<th class="${col.isHoliday ? 'holiday' : ''}" style="${colW}">${escHtml(col.label)}${col.isHoliday ? '<br><small>공휴일</small>' : ''}</th>`
    ).join('')

    const rows: string[] = []
    sorted.forEach((person, pi) => {
      const codeRows = buildCodeRows(person.id, week, allCells)
      if (codeRows.length === 0) return
      const bg = pi % 2 === 0 ? '' : 'background:#f8fafc'
      rows.push(`<tr class="person-hdr" style="${bg}"><td colspan="${week.columns.length + 1}"><strong>${escHtml(person.name)}</strong> <span class="rank">${escHtml(person.rank)}</span></td></tr>`)
      for (const row of codeRows) {
        const cells = week.columns.map(col => {
          if (col.isHoliday) return `<td class="holiday" style="text-align:center">—</td>`
          const c = row.cells.get(col.date)
          if (!c) return `<td></td>`
          const style = CK_STYLE[c.changeKind] ? ` style="${CK_STYLE[c.changeKind]}"` : ''
          const txt   = c.hasHours ? '8' : c.changeKind === 'removed' ? '—' : ''
          return `<td style="text-align:center;font-family:monospace"${style}>${escHtml(txt)}</td>`
        }).join('')
        const prov = row.provisional ? ' ⚠' : ''
        rows.push(`<tr style="${bg}"><td class="code-lbl">${escHtml(row.code)}${prov}</td>${cells}</tr>`)
      }
    })

    if (rows.length === 0) {
      rows.push(`<tr><td colspan="${week.columns.length + 1}" class="empty">해당 항목 없음</td></tr>`)
    }

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
.person-hdr td { font-size:12px; padding:5px 8px; border-top:2px solid #cbd5e1; }
.rank { font-size:10px; color:#6b7280; }
.code-lbl { font-family:monospace; font-size:11px; min-width:${CODE_COL_W}px; }
.holiday { background:#f9fafb; color:#9ca3af; }
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

// ── Pending projects panel (AL-17) ─────────────────────────────

interface PendingPanelProps {
  workItems:   WorkItem[]
  assignments: { work_item_id: string | null; kind: string; start: string; end_date: string }[]
  windowStart: string
  windowEnd:   string
  onEdit:      (wi: WorkItem) => void
}

function PendingProjectsPanel({ workItems, assignments, windowStart, windowEnd, onEdit }: PendingPanelProps) {
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
        <AlertTriangle size={13} />
        대체 코드 미확정 프로젝트 ({pending.length}건)
      </div>
      <div className="space-y-1.5">
        {pending.map(wi => (
          <div key={wi.id} className="flex items-center gap-2 text-xs bg-white/70 rounded border border-amber-100 px-3 py-1.5">
            <span className="font-medium text-gray-800 flex-1 truncate">{wi.name}</span>
            {wi.temp_engagement_code
              ? <span className="font-mono text-amber-700 bg-amber-100 px-1.5 py-0.5 rounded text-[11px]">{wi.temp_engagement_code}</span>
              : <span className="text-muted italic text-[11px]">코드 없음</span>}
            <button onClick={() => onEdit(wi)} className="flex items-center gap-1 text-brand-600 hover:text-brand-700 font-medium">
              <Pencil size={11} />
              {wi.temp_engagement_code ? '수정' : '입력'}
            </button>
          </div>
        ))}
      </div>
      <p className="text-[10px] text-amber-600">
        정식 engagement_number 등록 후 "지침 생성"을 다시 실행하면 자동으로 정정 지시가 생성됩니다.
      </p>
    </div>
  )
}

// ── Temp-code edit modal (AL-17) ───────────────────────────────

interface EditCodeModalProps {
  wi: WorkItem; onClose: () => void; onSaved: () => void
}

function EditCodeModal({ wi, onClose, onSaved }: EditCodeModalProps) {
  const [value, setValue] = useState(wi.temp_engagement_code ?? '')
  const [error, setError] = useState<string | null>(null)
  const updateWorkItem    = useUpdateWorkItem()

  async function handleSave() {
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
            <p className="text-[11px] text-muted mt-0.5">대체 타임시트 코드 입력 (AL-17)</p>
          </div>
          <button onClick={onClose} className="text-muted hover:text-gray-600 mt-0.5"><X size={15} /></button>
        </div>
        <div className="space-y-1">
          <label className="text-xs font-medium text-gray-700">대체 코드</label>
          <input
            className="input w-full text-sm font-mono"
            value={value}
            onChange={e => setValue(e.target.value)}
            placeholder="예: KR1234-0"
            autoFocus
            onKeyDown={e => {
              if (e.key === 'Enter' && !updateWorkItem.isPending) handleSave()
              if (e.key === 'Escape') onClose()
            }}
          />
          <p className="text-[10px] text-muted">비워두면 대체 코드가 삭제됩니다.</p>
        </div>
        {error && <p className="text-xs text-red-600 flex items-center gap-1"><AlertTriangle size={11} /> {error}</p>}
        <div className="flex justify-end gap-2">
          <button className="btn-secondary text-xs py-1" onClick={onClose}>취소</button>
          <button
            className="btn-primary text-xs py-1 gap-1 disabled:opacity-40"
            disabled={updateWorkItem.isPending}
            onClick={handleSave}
          >
            {updateWorkItem.isPending ? <><Loader2 size={12} className="animate-spin" /> 저장 중…</> : <><Check size={12} /> 저장</>}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Reset confirmation modal ───────────────────────────────────

interface ResetModalProps {
  pastDayCount: number
  onConfirm:    () => void
  onClose:      () => void
}

function ResetConfirmModal({ pastDayCount, onConfirm, onClose }: ResetModalProps) {
  return (
    <div className="fixed inset-0 bg-black/25 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-xl p-5 w-96 space-y-4" onClick={e => e.stopPropagation()}>
        <div className="flex items-start gap-3">
          <RotateCcw size={18} className="text-amber-500 flex-shrink-0 mt-0.5" />
          <div>
            <h4 className="text-sm font-semibold text-gray-800">과거 스냅샷 초기화</h4>
            <p className="text-xs text-gray-600 mt-1.5 leading-relaxed">
              최신 주를 제외한 과거 7주(<strong>{pastDayCount}</strong>영업일)의 스냅샷을
              현재 배정 데이터 기준으로 재설정합니다.
              정정 지시 없이 바로 덮어씁니다.
            </p>
            <p className="text-xs font-medium text-amber-700 mt-2">계속할까요?</p>
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <button className="btn-secondary text-xs py-1" onClick={onClose}>취소</button>
          <button className="btn-danger text-xs py-1 gap-1" onClick={onConfirm}>
            <RotateCcw size={12} /> 초기화 실행
          </button>
        </div>
      </div>
    </div>
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

  const dataLoading = lp || la || lc || lw || lh || lj

  // ── Window calculation (AL-12 bug fix) ───────────────────────
  // Latest week = Mon–Fri of the week containing today. Never includes future dates.
  // 8-week window = latest week + 7 prior weeks.
  const todayNum       = today()
  const latestMonNum   = weekStart(todayNum)      // Mon of current week
  const latestFriNum   = latestMonNum + 4          // Fri of current week (= windowEnd)
  const windowStartNum = latestMonNum - 7 * 7      // Mon 7 weeks before latest Mon
  const windowEndNum   = latestFriNum

  const todayStr    = numToStr(todayNum)
  const windowStart = numToStr(windowStartNum)
  const windowEnd   = numToStr(windowEndNum)

  const holidaySet = useMemo(() => {
    const yr = new Date().getFullYear()
    return buildHolidaySet(allHolidays, yr - 1, yr + 2)
  }, [allHolidays])

  const isHoliday = useCallback((n: number) => holidaySet.has(n), [holidaySet])

  // All working days in the 8-week window
  const allWorkingDays = useMemo(
    () => workingDaysList(windowStartNum, windowEndNum, isHoliday),
    [windowStartNum, windowEndNum, isHoliday],
  )

  // Past working days only (excludes latest week) — used by reset
  const pastWorkingDays = useMemo(
    () => workingDaysList(windowStartNum, latestMonNum - 1, isHoliday),
    [windowStartNum, latestMonNum, isHoliday],
  )

  const weeks = useMemo(
    () => computeWeeks(windowStartNum, windowEndNum, isHoliday),
    [windowStartNum, windowEndNum, isHoliday],
  )

  const activePeople = useMemo(
    () => allPeople.filter(p => p.status !== 'resigned'),
    [allPeople],
  )

  // ── State ──────────────────────────────────────────────────

  const [isPreviewing,   setIsPreviewing]   = useState(false)
  const [isResetting,    setIsResetting]    = useState(false)
  const [isSaving,       setIsSaving]       = useState(false)
  const [genError,       setGenError]       = useState<string | null>(null)
  const [allCells,       setAllCells]       = useState<Map<string, CellData>>(new Map())
  const [savedAt,        setSavedAt]        = useState<string | null>(null)
  const [savedCount,     setSavedCount]     = useState(0)
  const [resetMsg,       setResetMsg]       = useState<string | null>(null)
  const [previewed,      setPreviewed]      = useState(false)
  const [showResetModal, setShowResetModal] = useState(false)
  const [nameSearch,     setNameSearch]     = useState('')
  const [editingWi,      setEditingWi]      = useState<WorkItem | null>(null)

  // Accordion: expand first 2 weeks after generation
  const [expandedWeeks, setExpandedWeeks]   = useState<Set<string>>(new Set())
  const expandInitRef = useRef(false)

  useEffect(() => {
    if (previewed && weeks.length > 0 && !expandInitRef.current) {
      expandInitRef.current = true
      setExpandedWeeks(new Set(weeks.slice(0, 2).map(w => w.weekStart)))
    }
  }, [previewed, weeks])

  const toggleWeek = useCallback((ws: string) => {
    setExpandedWeeks(prev => {
      const s = new Set(prev)
      s.has(ws) ? s.delete(ws) : s.add(ws)
      return s
    })
  }, [])

  // ── Shared: compute AL-11 codes for a list of dates ───────────

  function computeCodes(days: string[]): Map<string, { code: string; provisional: boolean }> {
    const assignmentsByPerson = new Map<string, typeof allAssignments>()
    const accrualsByPerson    = new Map<string, typeof allAccruals>()
    const adjustmentsByPerson = new Map<string, typeof allAdjustments>()

    for (const a of allAssignments) {
      if (!assignmentsByPerson.has(a.person_id)) assignmentsByPerson.set(a.person_id, [])
      assignmentsByPerson.get(a.person_id)!.push(a)
    }
    for (const a of allAccruals) {
      if (!accrualsByPerson.has(a.person_id)) accrualsByPerson.set(a.person_id, [])
      accrualsByPerson.get(a.person_id)!.push(a)
    }
    for (const a of allAdjustments) {
      if (!adjustmentsByPerson.has(a.person_id)) adjustmentsByPerson.set(a.person_id, [])
      adjustmentsByPerson.get(a.person_id)!.push(a)
    }

    const computed = new Map<string, { code: string; provisional: boolean }>()

    for (const person of activePeople) {
      const personAssignments = assignmentsByPerson.get(person.id) ?? []
      const personAccruals    = accrualsByPerson.get(person.id) ?? []
      const personAdjustments = adjustmentsByPerson.get(person.id) ?? []

      const ledger = computeLedger(person.id, {
        workItems:   allWorkItems,
        assignments: personAssignments,
        accruals:    personAccruals,
        isHoliday,
        today:       windowEndNum,
      })

      const ctx: ResolveContext = {
        allPeople,
        assignments:    personAssignments,
        allAssignments,
        workItems:      allWorkItems,
        isHoliday,
        ledger,
        adjustments:    personAdjustments,
        hireDate:       person.hire_date,
      }

      for (const dateStr of days) {
        const result = resolveTimesheetCode(person, dateStr, ctx)
        computed.set(entryKey(person.id, dateStr), {
          code:        result.code,
          provisional: result.provisional ?? false,
        })
      }
    }

    return computed
  }

  // ── [1단계] 초기화 ─────────────────────────────────────────

  async function handleReset() {
    setShowResetModal(false)
    setIsResetting(true)
    setGenError(null)
    setResetMsg(null)
    try {
      const computed = computeCodes(pastWorkingDays)
      const runAt    = new Date().toISOString()
      const rows     = [...computed.entries()].map(([key, comp]) => {
        const [personId, date] = key.split('|')
        return { person_id: personId, date, code: comp.code, detail: comp.provisional ? '(임시)' : null, run_at: runAt }
      })

      if (rows.length > 0) {
        const { error } = await (supabase as any)
          .from('timesheet_guideline_snapshot')
          .upsert(rows, { onConflict: 'person_id,date' })
        if (error) throw error
      }

      const { error: delErr } = await (supabase as any)
        .from('timesheet_guideline_snapshot')
        .delete()
        .lt('date', windowStart)
      if (delErr) throw delErr

      setResetMsg(`과거 ${rows.length}건 재설정 완료`)
    } catch (e) {
      setGenError(formatError(e))
    } finally {
      setIsResetting(false)
    }
  }

  // ── [2단계] 지침 생성 (미리보기만; 스냅샷 미변경) ────────────

  async function handlePreview() {
    setIsPreviewing(true)
    setGenError(null)
    setResetMsg(null)
    try {
      const computed = computeCodes(allWorkingDays)

      const { data: snapRows, error: fetchErr } = await (supabase as any)
        .from('timesheet_guideline_snapshot')
        .select('person_id, date, code')
        .gte('date', windowStart)
        .lte('date', windowEnd)
      if (fetchErr) throw fetchErr

      const snapMap = new Map<string, string>()
      for (const row of snapRows ?? []) {
        snapMap.set(entryKey(row.person_id, row.date), row.code)
      }

      const cells = new Map<string, CellData>()
      for (const person of activePeople) {
        for (const dateStr of allWorkingDays) {
          const key  = entryKey(person.id, dateStr)
          const comp = computed.get(key)
          if (!comp) continue
          const existing = snapMap.get(key) ?? null
          const kind: CellData['kind'] =
            existing === null      ? 'new' :
            existing !== comp.code ? 'correction' : 'unchanged'
          cells.set(key, { computed: comp.code, provisional: comp.provisional, existing, kind })
        }
      }

      setAllCells(cells)
      setSavedAt(null)
      setSavedCount(0)
      setPreviewed(true)
      expandInitRef.current = false
    } catch (e) {
      setGenError(formatError(e))
    } finally {
      setIsPreviewing(false)
    }
  }

  // ── [3단계] 저장 (미리보기 결과를 스냅샷에 반영) ─────────────

  async function handleSave() {
    setIsSaving(true)
    setGenError(null)
    try {
      const runAt = new Date().toISOString()
      const rows: object[] = []
      for (const [key, cell] of allCells.entries()) {
        const [personId, date] = key.split('|')
        rows.push({ person_id: personId, date, code: cell.computed, detail: cell.provisional ? '(임시 — 추후 정정 필요)' : null, run_at: runAt })
      }

      if (rows.length > 0) {
        const { error: upsertErr } = await (supabase as any)
          .from('timesheet_guideline_snapshot')
          .upsert(rows, { onConflict: 'person_id,date' })
        if (upsertErr) throw upsertErr
      }

      const { error: delErr } = await (supabase as any)
        .from('timesheet_guideline_snapshot')
        .delete()
        .lt('date', windowStart)
      if (delErr) throw delErr

      setSavedCount(rows.length)
      setSavedAt(new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }))
    } catch (e) {
      setGenError(formatError(e))
    } finally {
      setIsSaving(false)
    }
  }

  // ── Derived ───────────────────────────────────────────────

  const filteredPeople = useMemo(() => {
    let out = [...activePeople]
    if (nameSearch.trim()) {
      const matches = parseSearchQuery(nameSearch)
      out = out.filter(p => matches([p.name]))
    }
    return sortPeople(out)
  }, [activePeople, nameSearch])

  const { newCount, corrCount } = useMemo(() => {
    let n = 0, c = 0
    for (const cell of allCells.values()) {
      if (cell.kind === 'new') n++
      else if (cell.kind === 'correction') c++
    }
    return { newCount: n, corrCount: c }
  }, [allCells])

  // ── Render ─────────────────────────────────────────────────

  const anyBusy = isPreviewing || isResetting || isSaving

  return (
    <div className="space-y-4">

      {/* ── Header bar ─────────────────────────────────────── */}
      <div className="flex flex-wrap items-start gap-3">
        <div>
          <h3 className="text-sm font-semibold text-gray-800">타임시트 지침 생성</h3>
          <p className="text-xs text-muted mt-0.5">
            최신 주: {numToStr(latestMonNum)} ~ {windowEnd}
            <span className="ml-2">창: {windowStart} ~ {windowEnd}</span>
            <span className="ml-2">영업일 {allWorkingDays.length}일</span>
            <span className="ml-2">대상 {activePeople.length}명</span>
          </p>
        </div>

        <div className="ml-auto flex items-center gap-2 flex-wrap justify-end">
          {/* Step 1: 초기화 */}
          <button
            onClick={() => setShowResetModal(true)}
            disabled={anyBusy || dataLoading}
            title="최신 주를 제외한 과거 7주를 현재 데이터로 재설정"
            className="btn-secondary text-xs py-1 gap-1 disabled:opacity-40"
          >
            {isResetting
              ? <><Loader2 size={13} className="animate-spin" /> 초기화 중…</>
              : <><RotateCcw size={13} /> 초기화</>}
          </button>

          {/* Step 2: 지침 생성 */}
          <button
            onClick={handlePreview}
            disabled={anyBusy || dataLoading}
            className="btn-secondary text-xs py-1 gap-1 disabled:opacity-40"
          >
            {isPreviewing
              ? <><Loader2 size={13} className="animate-spin" /> 생성 중…</>
              : previewed
                ? <><RefreshCw size={13} /> 재생성</>
                : <><Play size={13} /> 지침 생성</>}
          </button>

          {/* Step 3: 저장 + HTML (only after preview) */}
          {previewed && (
            <>
              <button
                onClick={() => triggerDownload(
                  generateGuidelineHtml(weeks, filteredPeople, allCells, windowStart, windowEnd, todayStr),
                  `타임시트지침_${todayStr}.html`,
                )}
                disabled={anyBusy}
                className="btn-secondary text-xs py-1 gap-1 disabled:opacity-40"
              >
                <Download size={13} /> HTML 저장
              </button>
              <button
                onClick={handleSave}
                disabled={isSaving || allCells.size === 0}
                className="btn-primary text-xs py-1 gap-1 disabled:opacity-40"
              >
                {isSaving
                  ? <><Loader2 size={13} className="animate-spin" /> 저장 중…</>
                  : <><Save size={13} /> {allCells.size}건 저장</>}
              </button>
            </>
          )}
        </div>
      </div>

      {dataLoading && (
        <div className="flex items-center gap-2 text-xs text-muted">
          <Loader2 size={14} className="animate-spin" /> 데이터 로딩 중…
        </div>
      )}

      {/* Error */}
      {genError && (
        <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 flex items-center gap-2">
          <AlertTriangle size={13} className="flex-shrink-0" />
          {genError}
        </div>
      )}

      {/* Reset done */}
      {resetMsg && (
        <div className="rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-700">
          {resetMsg}
        </div>
      )}

      {/* Save success (AL-16) */}
      {savedAt && (
        <div className="rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-700">
          {savedCount}건 저장됨 — {savedAt}
        </div>
      )}

      {/* AL-17: pending projects panel */}
      <PendingProjectsPanel
        workItems={allWorkItems}
        assignments={allAssignments}
        windowStart={windowStart}
        windowEnd={windowEnd}
        onEdit={setEditingWi}
      />

      {/* Empty state */}
      {!previewed && !isPreviewing && (
        <div className="rounded-md border border-border bg-surface-50 px-4 py-10 text-center">
          <p className="text-sm text-muted">"지침 생성" 버튼을 눌러 이번 주 타임시트 코드 지침을 산출하세요.</p>
          <p className="text-xs text-muted mt-1">
            8주 창({windowStart} ~ {windowEnd}) 전체를 분석하며, 저장 전까지 스냅샷을 변경하지 않습니다.
          </p>
        </div>
      )}

      {/* ── Preview matrix ──────────────────────────────────── */}
      {previewed && (
        <>
          {/* Summary + search */}
          <div className="flex items-center gap-3 flex-wrap border-b border-border pb-3">
            <div className="flex items-center gap-2 text-xs">
              <span className="pill bg-blue-100 text-blue-700">신규 {newCount}건</span>
              <span className={`pill text-[10px] ${corrCount > 0 ? 'bg-amber-100 text-amber-700' : 'bg-gray-100 text-gray-500'}`}>
                정정 {corrCount}건
              </span>
              <span className="text-[10px] text-muted">미리보기 (저장 전)</span>
            </div>
            <input
              className="input py-1 text-xs w-52 ml-auto"
              placeholder="이름 검색… (AND/OR 지원)"
              value={nameSearch}
              onChange={e => setNameSearch(e.target.value)}
            />
            {nameSearch && (
              <button onClick={() => setNameSearch('')} className="text-xs text-muted hover:text-gray-700">초기화</button>
            )}
            <button
              onClick={() =>
                setExpandedWeeks(
                  expandedWeeks.size === weeks.length
                    ? new Set()
                    : new Set(weeks.map(w => w.weekStart))
                )
              }
              className="text-xs text-brand-600 hover:underline whitespace-nowrap"
            >
              {expandedWeeks.size === weeks.length ? '전체 접기' : '전체 펼치기'}
            </button>
          </div>

          {/* Legend */}
          <div className="flex items-center gap-3 text-[10px] text-muted flex-wrap">
            <span className="flex items-center gap-1"><span className="inline-block w-3 h-3 rounded bg-blue-100" /> 신규</span>
            <span className="flex items-center gap-1"><span className="inline-block w-3 h-3 rounded bg-amber-100" /> 정정(신규 코드)</span>
            <span className="flex items-center gap-1"><span className="inline-block w-3 h-3 rounded bg-rose-100" /> 정정(이전 코드 삭제)</span>
            <span className="ml-auto text-[10px]">셀값 = 투입시간(h) / 하루 8h 기준</span>
          </div>

          {/* Weekly accordion */}
          <div className="space-y-2">
            {weeks.map(week => {
              const isOpen = expandedWeeks.has(week.weekStart)

              let wNew = 0, wCorr = 0
              for (const person of activePeople) {
                for (const col of week.columns) {
                  if (col.isHoliday) continue
                  const cell = allCells.get(entryKey(person.id, col.date))
                  if (cell?.kind === 'new') wNew++
                  else if (cell?.kind === 'correction') wCorr++
                }
              }

              const isLatestWeek = week.weekStart === numToStr(latestMonNum)

              return (
                <div key={week.weekStart} className="rounded-lg border border-border overflow-hidden">
                  <button
                    onClick={() => toggleWeek(week.weekStart)}
                    className="w-full flex items-center gap-2 px-4 py-2.5 bg-surface-50 hover:bg-surface-100 transition-colors text-left select-none"
                  >
                    {isOpen ? <ChevronDown size={14} className="text-muted flex-shrink-0" /> : <ChevronRight size={14} className="text-muted flex-shrink-0" />}
                    <span className="text-sm font-semibold text-gray-800">{week.label}</span>
                    {isLatestWeek && <span className="pill bg-brand-100 text-brand-700 text-[10px]">이번 주</span>}
                    {wNew  > 0 && <span className="pill bg-blue-100 text-blue-700 text-[10px]">신규 {wNew}</span>}
                    {wCorr > 0 && <span className="pill bg-amber-100 text-amber-700 text-[10px]">정정 {wCorr}</span>}
                    {wNew === 0 && wCorr === 0 && <span className="text-xs text-muted">변경 없음</span>}
                  </button>

                  {isOpen && (
                    <div className="overflow-x-auto">
                      {/* [3단계] table width fixed; no width:100% */}
                      <table
                        className="border-t border-border"
                        style={{
                          tableLayout: 'fixed',
                          width:       `${CODE_COL_W + week.columns.length * DAY_COL_W}px`,
                        }}
                      >
                        <colgroup>
                          <col style={{ width: CODE_COL_W }} />
                          {week.columns.map(col => (
                            <col key={col.date} style={{ width: DAY_COL_W }} />
                          ))}
                        </colgroup>
                        <thead>
                          <tr className="bg-surface-50 border-b border-border">
                            <th className="px-3 py-2 text-left text-xs font-medium text-muted sticky left-0 bg-surface-50 z-10">
                              코드
                            </th>
                            {week.columns.map(col => (
                              <th
                                key={col.date}
                                className={['py-2 text-center text-xs font-medium', col.isHoliday ? 'text-gray-400 bg-gray-50' : 'text-gray-700'].join(' ')}
                              >
                                <div>{col.label}</div>
                                {col.isHoliday && <div className="text-[9px] text-gray-400 font-normal">공휴일</div>}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {filteredPeople.map((person, personIdx) => {
                            const codeRows = buildCodeRows(person.id, week, allCells)
                            if (codeRows.length === 0) return null

                            const zebraRow = ZEBRA_ROW[personIdx % 2]
                            const zebraHdr = ZEBRA_HDR[personIdx % 2]

                            return (
                              <Fragment key={person.id}>
                                <tr className={`${zebraHdr} border-t-2 border-slate-300/60`}>
                                  <td colSpan={week.columns.length + 1} className={`px-3 py-1.5 sticky left-0 ${zebraHdr}`}>
                                    <span className="font-semibold text-gray-700 text-xs">{person.name}</span>
                                    <span className="ml-1.5 text-[10px] text-muted font-normal">{person.rank}</span>
                                  </td>
                                </tr>
                                {codeRows.map(row => (
                                  <tr key={row.code} className={`${zebraRow} border-b border-border/20 hover:brightness-[0.97]`}>
                                    <td className={`px-3 py-1.5 font-mono text-[11px] text-gray-700 sticky left-0 ${zebraRow} z-10 border-r border-border/20`}>
                                      <span className="flex items-center gap-1">
                                        <span className="truncate">{row.code}</span>
                                        {row.provisional && <AlertTriangle size={9} className="text-amber-500 flex-shrink-0" aria-label="임시 코드" />}
                                      </span>
                                    </td>
                                    {week.columns.map(col => {
                                      if (col.isHoliday) {
                                        return <td key={col.date} className="bg-gray-50 text-center text-[10px] text-muted">—</td>
                                      }

                                      const c = row.cells.get(col.date)
                                      if (!c) return <td key={col.date} className={zebraRow} />

                                      const bgCls =
                                        c.changeKind === 'new'      ? 'bg-blue-50' :
                                        c.changeKind === 'replaced' ? 'bg-amber-50' :
                                        c.changeKind === 'removed'  ? 'bg-rose-50' : zebraRow

                                      const textCls =
                                        c.changeKind === 'new'      ? 'text-blue-700 font-semibold' :
                                        c.changeKind === 'replaced' ? 'text-amber-700 font-semibold' :
                                        c.changeKind === 'removed'  ? 'text-rose-400' :
                                        'text-gray-700'

                                      return (
                                        <td key={col.date} className={`text-center py-1.5 ${bgCls}`}>
                                          <span className={`tabular-nums text-xs ${textCls}`}>
                                            {c.hasHours ? '8' : c.changeKind === 'removed' ? '—' : ''}
                                          </span>
                                        </td>
                                      )
                                    })}
                                  </tr>
                                ))}
                              </Fragment>
                            )
                          })}
                          {filteredPeople.every(p => buildCodeRows(p.id, week, allCells).length === 0) && (
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
        </>
      )}

      {/* Modals */}
      {showResetModal && (
        <ResetConfirmModal
          pastDayCount={pastWorkingDays.length}
          onConfirm={handleReset}
          onClose={() => setShowResetModal(false)}
        />
      )}
      {editingWi && (
        <EditCodeModal
          wi={editingWi}
          onClose={() => setEditingWi(null)}
          onSaved={() => setEditingWi(null)}
        />
      )}
    </div>
  )
}
