/**
 * TimesheetGuidelineTab — AL-12/13/14/15/16/17
 * 코드-행 × 날짜-열 × 시간 매트릭스. 인력별 그룹(zebra), 주차별 아코디언.
 * 미확정 프로젝트 요약 패널 + 대체 코드(temp_engagement_code) 인라인 편집.
 */
import { useState, useMemo, useCallback, useRef, useEffect, Fragment } from 'react'
import {
  Loader2, Play, Download, Save, AlertTriangle, RefreshCw,
  ChevronDown, ChevronRight, Pencil, X, Check,
} from 'lucide-react'
import { useAllPeople }                    from '@/features/people/hooks'
import { useAllAssignments }               from '@/features/timeline/hooks'
import { useAllAccruals }                  from '@/features/leave/hooks'
import { useAllWorkItems, useUpdateWorkItem } from '@/features/workitems/hooks'
import { useAllHolidays }                  from '@/features/admin/hooks'
import { useAllAdjustments }               from './hooks'
import { computeLedger, buildHolidaySet }  from '@/features/leave/ledger'
import { resolveTimesheetCode }            from './resolveTimesheetCode'
import type { ResolveContext }             from './resolveTimesheetCode'
import { today, numToStr, isWeekend, weekStart } from '@/lib/date'
import { parseSearchQuery }                from '@/lib/searchQuery'
import { supabase }                        from '@/lib/supabase'
import { escHtml, triggerDownload, HTML_EXPORT_CSS } from '@/lib/htmlExport'
import type { Person, Rank, WorkItem }     from '@/types'

// ── Constants ─────────────────────────────────────────────────

const WINDOW_PAST  = 14
const WINDOW_AHEAD = 42
const DAY_NAMES    = ['월', '화', '수', '목', '금'] as const

const RANK_ORDER: Record<Rank, number> = {
  Partner: 0, SM: 1, M: 2, Senior: 3, Staff: 4, Intern: 5,
}

// Alternating zebra backgrounds for person groups (index % 2)
const ZEBRA_BG  = ['bg-white', 'bg-slate-50/60'] as const
const ZEBRA_HDR = ['bg-slate-100/70', 'bg-slate-200/50'] as const

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
  inWindow:  boolean
}

interface WeekInfo {
  weekStart: string
  label:     string
  columns:   ColInfo[]
}

// ── Pure helpers ───────────────────────────────────────────────

function entryKey(personId: string, date: string) {
  return `${personId}|${date}`
}

function monthDay(s: string): string {
  return `${parseInt(s.slice(5, 7), 10)}/${parseInt(s.slice(8, 10), 10)}`
}

function computeWeeks(
  windowStartNum: number,
  windowEndNum:   number,
  isHoliday:      (n: number) => boolean,
): WeekInfo[] {
  const weeks: WeekInfo[] = []
  let monNum    = weekStart(windowStartNum)
  const lastMon = weekStart(windowEndNum)

  while (monNum <= lastMon) {
    const columns: ColInfo[] = []
    for (let d = 0; d < 5; d++) {
      const n = monNum + d
      const s = numToStr(n)
      columns.push({
        date:      s,
        label:     `${DAY_NAMES[d]} ${monthDay(s)}`,
        isHoliday: isHoliday(n),
        inWindow:  n >= windowStartNum && n <= windowEndNum,
      })
    }
    weeks.push({
      weekStart: numToStr(monNum),
      label:     `${monthDay(numToStr(monNum))}(월) ~ ${monthDay(numToStr(monNum + 4))}(금)`,
      columns,
    })
    monNum += 7
  }
  return weeks.reverse()
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
    if (!col.inWindow || col.isHoliday) continue
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
    const colHeaders = week.columns.map(col =>
      `<th class="${!col.inWindow ? 'out-win' : col.isHoliday ? 'holiday' : ''}" style="width:80px;text-align:center">${escHtml(col.label)}${col.isHoliday && col.inWindow ? '<br><small>공휴일</small>' : ''}</th>`
    ).join('')

    const rows: string[] = []

    sorted.forEach((person, pi) => {
      const codeRows = buildCodeRows(person.id, week, allCells)
      if (codeRows.length === 0) return
      const bg = pi % 2 === 0 ? '' : 'background:#f8fafc'

      rows.push(`<tr class="person-hdr" style="${bg}"><td colspan="${week.columns.length + 1}"><strong>${escHtml(person.name)}</strong> <span class="rank">${escHtml(person.rank)}</span></td></tr>`)

      for (const row of codeRows) {
        const cells = week.columns.map(col => {
          if (!col.inWindow) return `<td class="out-win"></td>`
          if (col.isHoliday)  return `<td class="holiday" style="text-align:center">—</td>`
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

    return `<section>
<h2>${escHtml(week.label)}</h2>
<table>
  <thead><tr><th style="min-width:130px">코드</th>${colHeaders}</tr></thead>
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
.code-lbl { font-family:monospace; font-size:11px; min-width:130px; }
.holiday { background:#f9fafb; color:#9ca3af; }
.out-win { background:#fafafa; }
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

function PendingProjectsPanel({
  workItems, assignments, windowStart, windowEnd, onEdit,
}: PendingPanelProps) {
  const pending = useMemo(() => {
    const activeIds = new Set<string>()
    for (const a of assignments) {
      if (a.kind !== 'work' || !a.work_item_id) continue
      if (a.start <= windowEnd && a.end_date >= windowStart) activeIds.add(a.work_item_id)
    }
    return workItems.filter(
      wi => wi.type === 'project' && !wi.engagement_number && activeIds.has(wi.id)
    )
  }, [workItems, assignments, windowStart, windowEnd])

  if (pending.length === 0) return null

  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 space-y-2">
      <div className="flex items-center gap-1.5 text-xs font-semibold text-amber-700">
        <AlertTriangle size={13} />
        대체 코드 미확정 프로젝트 ({pending.length}건) — 현재 8주 창 안에 배정된 프로젝트
      </div>
      <div className="space-y-1.5">
        {pending.map(wi => (
          <div key={wi.id} className="flex items-center gap-2 text-xs bg-white/70 rounded border border-amber-100 px-3 py-1.5">
            <span className="font-medium text-gray-800 flex-1 truncate">{wi.name}</span>
            {wi.temp_engagement_code
              ? <span className="font-mono text-amber-700 bg-amber-100 px-1.5 py-0.5 rounded text-[11px]">{wi.temp_engagement_code}</span>
              : <span className="text-muted italic text-[11px]">코드 없음</span>}
            <button
              onClick={() => onEdit(wi)}
              className="flex items-center gap-1 text-brand-600 hover:text-brand-700 font-medium"
            >
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
  wi:          WorkItem
  onClose:     () => void
  onSaved:     () => void
}

function EditCodeModal({ wi, onClose, onSaved }: EditCodeModalProps) {
  const [value, setValue]       = useState(wi.temp_engagement_code ?? '')
  const [error, setError]       = useState<string | null>(null)
  const updateWorkItem          = useUpdateWorkItem()

  async function handleSave() {
    setError(null)
    try {
      await updateWorkItem.mutateAsync({ id: wi.id, temp_engagement_code: value.trim() || null })
      onSaved()
    } catch (e) {
      setError(formatError(e))
    }
  }

  return (
    <div
      className="fixed inset-0 bg-black/25 flex items-center justify-center z-50"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-xl shadow-xl p-5 w-80 space-y-4"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-2">
          <div>
            <h4 className="text-sm font-semibold text-gray-800">{wi.name}</h4>
            <p className="text-[11px] text-muted mt-0.5">대체 타임시트 코드 입력 (AL-17)</p>
          </div>
          <button onClick={onClose} className="text-muted hover:text-gray-600 mt-0.5">
            <X size={15} />
          </button>
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
          <p className="text-[10px] text-muted">
            비워두면 대체 코드가 삭제되고 "(코드 미정)"으로 표시됩니다.
          </p>
        </div>

        {error && (
          <p className="text-xs text-red-600 flex items-center gap-1">
            <AlertTriangle size={11} /> {error}
          </p>
        )}

        <div className="flex justify-end gap-2">
          <button className="btn-secondary text-xs py-1" onClick={onClose}>취소</button>
          <button
            className="btn-primary text-xs py-1 gap-1 disabled:opacity-40"
            disabled={updateWorkItem.isPending}
            onClick={handleSave}
          >
            {updateWorkItem.isPending
              ? <><Loader2 size={12} className="animate-spin" /> 저장 중…</>
              : <><Check size={12} /> 저장</>}
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

  const todayNum    = today()
  const todayStr    = numToStr(todayNum)
  const windowStart = numToStr(todayNum - WINDOW_PAST)
  const windowEnd   = numToStr(todayNum + WINDOW_AHEAD)

  const holidaySet = useMemo(() => {
    const yr = new Date().getFullYear()
    return buildHolidaySet(allHolidays, yr - 1, yr + 2)
  }, [allHolidays])

  const isHoliday = useCallback((n: number) => holidaySet.has(n), [holidaySet])

  const workingDays = useMemo((): string[] => {
    const days: string[] = []
    for (let n = todayNum - WINDOW_PAST; n <= todayNum + WINDOW_AHEAD; n++) {
      if (!isWeekend(n) && !isHoliday(n)) days.push(numToStr(n))
    }
    return days
  }, [todayNum, isHoliday])

  const weeks = useMemo(
    () => computeWeeks(todayNum - WINDOW_PAST, todayNum + WINDOW_AHEAD, isHoliday),
    [todayNum, isHoliday],
  )

  const activePeople = useMemo(
    () => allPeople.filter(p => p.status !== 'resigned'),
    [allPeople],
  )

  // ── Core state ─────────────────────────────────────────────

  const [isGenerating, setIsGenerating] = useState(false)
  const [isSaving,     setIsSaving]     = useState(false)
  const [genError,     setGenError]     = useState<string | null>(null)
  const [allCells,     setAllCells]     = useState<Map<string, CellData>>(new Map())
  const [savedAt,      setSavedAt]      = useState<string | null>(null)
  const [savedCount,   setSavedCount]   = useState(0)
  const [generated,    setGenerated]    = useState(false)
  const [nameSearch,   setNameSearch]   = useState('')

  // AL-17: temp-code editor
  const [editingWi, setEditingWi] = useState<WorkItem | null>(null)

  // Accordion
  const [expandedWeeks, setExpandedWeeks] = useState<Set<string>>(new Set())
  const expandInitRef = useRef(false)

  useEffect(() => {
    if (generated && weeks.length > 0 && !expandInitRef.current) {
      expandInitRef.current = true
      setExpandedWeeks(new Set(weeks.slice(0, 2).map(w => w.weekStart)))
    }
  }, [generated, weeks])

  const toggleWeek = useCallback((ws: string) => {
    setExpandedWeeks(prev => {
      const s = new Set(prev)
      s.has(ws) ? s.delete(ws) : s.add(ws)
      return s
    })
  }, [])

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

  // ── Generate ──────────────────────────────────────────────

  async function handleGenerate() {
    setIsGenerating(true)
    setGenError(null)
    try {
      const windowEndNum = todayNum + WINDOW_AHEAD

      const assignmentsByPerson  = new Map<string, typeof allAssignments>()
      const accrualsByPerson     = new Map<string, typeof allAccruals>()
      const adjustmentsByPerson  = new Map<string, typeof allAdjustments>()

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

        for (const dateStr of workingDays) {
          const result = resolveTimesheetCode(person, dateStr, ctx)
          computed.set(entryKey(person.id, dateStr), {
            code:        result.code,
            provisional: result.provisional ?? false,
          })
        }
      }

      // Fetch existing snapshots
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
        for (const dateStr of workingDays) {
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
      setGenerated(true)
      expandInitRef.current = false
    } catch (e) {
      setGenError(formatError(e))
    } finally {
      setIsGenerating(false)
    }
  }

  // ── Save (AL-16) ──────────────────────────────────────────

  async function handleSave() {
    setIsSaving(true)
    setGenError(null)
    try {
      const runAt = new Date().toISOString()
      const rows: object[] = []

      for (const [key, cell] of allCells.entries()) {
        const [personId, date] = key.split('|')
        const detail = cell.provisional ? '(임시 — 추후 정정 필요)' : null
        rows.push({ person_id: personId, date, code: cell.computed, detail, run_at: runAt })
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

  // ── Render ─────────────────────────────────────────────────

  return (
    <div className="space-y-4">
      {/* Header bar */}
      <div className="flex flex-wrap items-start gap-3">
        <div>
          <h3 className="text-sm font-semibold text-gray-800">타임시트 지침 생성</h3>
          <p className="text-xs text-muted mt-0.5">
            윈도우: {windowStart} ~ {windowEnd}
            <span className="ml-2">영업일 {workingDays.length}일</span>
            <span className="ml-2">대상 인원 {activePeople.length}명</span>
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2 flex-wrap justify-end">
          {generated && (
            <>
              <button
                onClick={() => triggerDownload(
                  generateGuidelineHtml(weeks, filteredPeople, allCells, windowStart, windowEnd, todayStr),
                  `타임시트지침_${todayStr}.html`,
                )}
                className="btn-secondary text-xs py-1 gap-1"
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
          <button
            onClick={handleGenerate}
            disabled={isGenerating || dataLoading}
            className="btn-secondary text-xs py-1 gap-1 disabled:opacity-40"
          >
            {isGenerating
              ? <><Loader2 size={13} className="animate-spin" /> 생성 중…</>
              : generated
                ? <><RefreshCw size={13} /> 재생성</>
                : <><Play size={13} /> 지침 생성</>}
          </button>
        </div>
      </div>

      {dataLoading && (
        <div className="flex items-center gap-2 text-xs text-muted">
          <Loader2 size={14} className="animate-spin" /> 데이터 로딩 중…
        </div>
      )}

      {/* AL-16: human-readable error */}
      {genError && (
        <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 flex items-center gap-2">
          <AlertTriangle size={13} className="flex-shrink-0" />
          {genError}
        </div>
      )}

      {/* AL-16: save success */}
      {savedAt && (
        <div className="rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-700">
          {savedCount}건 저장됨 — {savedAt}
        </div>
      )}

      {/* AL-17: pending projects summary — always shown (not just after generation) */}
      <PendingProjectsPanel
        workItems={allWorkItems}
        assignments={allAssignments}
        windowStart={windowStart}
        windowEnd={windowEnd}
        onEdit={setEditingWi}
      />

      {!generated && !isGenerating && (
        <div className="rounded-md border border-border bg-surface-50 px-4 py-10 text-center">
          <p className="text-sm text-muted">"지침 생성" 버튼을 눌러 타임시트 코드 지침을 산출하세요.</p>
          <p className="text-xs text-muted mt-1">8주 윈도우 내 전 인원의 코드를 주차별로 분석합니다.</p>
        </div>
      )}

      {generated && (
        <>
          {/* Summary + search */}
          <div className="flex items-center gap-3 flex-wrap border-b border-border pb-3">
            <div className="flex items-center gap-2 text-xs">
              <span className="pill bg-blue-100 text-blue-700">신규 {newCount}건</span>
              <span className={`pill text-[10px] ${corrCount > 0 ? 'bg-amber-100 text-amber-700' : 'bg-gray-100 text-gray-500'}`}>
                정정 {corrCount}건
              </span>
            </div>
            <input
              className="input py-1 text-xs w-52 ml-auto"
              placeholder="이름 검색… (AND/OR 지원)"
              value={nameSearch}
              onChange={e => setNameSearch(e.target.value)}
            />
            {nameSearch && (
              <button onClick={() => setNameSearch('')} className="text-xs text-muted hover:text-gray-700">
                초기화
              </button>
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

          {/* Weekly accordion sections */}
          <div className="space-y-2">
            {weeks.map(week => {
              const isOpen = expandedWeeks.has(week.weekStart)

              let wNew = 0, wCorr = 0
              for (const person of activePeople) {
                for (const col of week.columns) {
                  if (!col.inWindow || col.isHoliday) continue
                  const cell = allCells.get(entryKey(person.id, col.date))
                  if (cell?.kind === 'new') wNew++
                  else if (cell?.kind === 'correction') wCorr++
                }
              }

              return (
                <div key={week.weekStart} className="rounded-lg border border-border overflow-hidden">
                  <button
                    onClick={() => toggleWeek(week.weekStart)}
                    className="w-full flex items-center gap-2 px-4 py-2.5 bg-surface-50 hover:bg-surface-100 transition-colors text-left select-none"
                  >
                    {isOpen
                      ? <ChevronDown  size={14} className="text-muted flex-shrink-0" />
                      : <ChevronRight size={14} className="text-muted flex-shrink-0" />}
                    <span className="text-sm font-semibold text-gray-800">{week.label}</span>
                    {wNew  > 0 && <span className="pill bg-blue-100 text-blue-700 text-[10px]">신규 {wNew}</span>}
                    {wCorr > 0 && <span className="pill bg-amber-100 text-amber-700 text-[10px]">정정 {wCorr}</span>}
                    {wNew === 0 && wCorr === 0 && (
                      <span className="text-xs text-muted">변경 없음</span>
                    )}
                  </button>

                  {isOpen && (
                    <div className="overflow-x-auto">
                      <table className="border-t border-border" style={{ tableLayout: 'fixed', width: '100%', minWidth: `${200 + week.columns.length * 80}px` }}>
                        <colgroup>
                          {/* code label col */}
                          <col style={{ width: '160px', minWidth: '160px' }} />
                          {/* one fixed-width col per day */}
                          {week.columns.map(col => (
                            <col key={col.date} style={{ width: '80px', minWidth: '80px' }} />
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
                                className={[
                                  'py-2 text-center text-xs font-medium',
                                  !col.inWindow  ? 'text-gray-300 bg-gray-50/50' :
                                  col.isHoliday  ? 'text-gray-400 bg-gray-50' :
                                  'text-gray-700',
                                ].join(' ')}
                              >
                                <div>{col.label}</div>
                                {col.isHoliday && col.inWindow && (
                                  <div className="text-[9px] text-gray-400 font-normal">공휴일</div>
                                )}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {filteredPeople.map((person, personIdx) => {
                            const codeRows = buildCodeRows(person.id, week, allCells)
                            if (codeRows.length === 0) return null

                            const zebraRow = ZEBRA_BG[personIdx % 2]
                            const zebraHdr = ZEBRA_HDR[personIdx % 2]

                            return (
                              <Fragment key={person.id}>
                                {/* Person group header — bold top border for visual separation */}
                                <tr className={`${zebraHdr} border-t-2 border-slate-300/60`}>
                                  <td
                                    colSpan={week.columns.length + 1}
                                    className={`px-3 py-1.5 sticky left-0 ${zebraHdr}`}
                                  >
                                    <span className="font-semibold text-gray-700 text-xs">{person.name}</span>
                                    <span className="ml-1.5 text-[10px] text-muted font-normal">{person.rank}</span>
                                  </td>
                                </tr>
                                {/* Code rows */}
                                {codeRows.map(row => (
                                  <tr key={row.code} className={`${zebraRow} border-b border-border/20 hover:brightness-[0.97]`}>
                                    {/* Code label — sticky left */}
                                    <td className={`px-3 py-1.5 font-mono text-[11px] text-gray-700 sticky left-0 ${zebraRow} z-10 border-r border-border/20`}>
                                      <span className="flex items-center gap-1 min-w-0">
                                        <span className="truncate">{row.code}</span>
                                        {row.provisional && (
                                          <AlertTriangle size={9} className="text-amber-500 flex-shrink-0" aria-label="임시 코드" />
                                        )}
                                      </span>
                                    </td>
                                    {/* Day cells */}
                                    {week.columns.map(col => {
                                      if (!col.inWindow) {
                                        return <td key={col.date} className="bg-gray-50/40" />
                                      }
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

      {/* AL-17: temp-code edit modal */}
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
