/**
 * TimesheetGuidelineTab — AL-12/13/14/15
 * 주차별(×인력별) 매트릭스 형식으로 타임시트 코드 지침을 표시한다.
 * 최신 주 위에, 최근 1-2주 기본 펼침, 이전 주 기본 접힘.
 */
import { useState, useMemo, useCallback, useRef, useEffect, type ChangeEvent } from 'react'
import {
  Loader2, Play, Download, Save, AlertTriangle, RefreshCw,
  ChevronDown, ChevronRight,
} from 'lucide-react'
import { useAllPeople }      from '@/features/people/hooks'
import { useAllAssignments } from '@/features/timeline/hooks'
import { useAllAccruals }    from '@/features/leave/hooks'
import { useAllWorkItems }   from '@/features/workitems/hooks'
import { useAllHolidays }    from '@/features/admin/hooks'
import { useAllAdjustments } from './hooks'
import { computeLedger, buildHolidaySet } from '@/features/leave/ledger'
import { resolveTimesheetCode } from './resolveTimesheetCode'
import type { ResolveContext } from './resolveTimesheetCode'
import { today, numToStr, isWeekend, weekStart } from '@/lib/date'
import { parseSearchQuery } from '@/lib/searchQuery'
import { supabase } from '@/lib/supabase'
import { escHtml, triggerDownload, HTML_EXPORT_CSS } from '@/lib/htmlExport'
import type { Person, Rank } from '@/types'

// ── Constants ─────────────────────────────────────────────────

const WINDOW_PAST  = 14   // 2 weeks back
const WINDOW_AHEAD = 42   // 6 weeks forward  (8 weeks total)
const DAY_NAMES    = ['월', '화', '수', '목', '금'] as const

const RANK_ORDER: Record<Rank, number> = {
  Partner: 0, SM: 1, M: 2, Senior: 3, Staff: 4, Intern: 5,
}

// ── Types ──────────────────────────────────────────────────────

interface CellData {
  computed:    string
  provisional: boolean
  existing:    string | null
  kind:        'new' | 'correction' | 'unchanged'
}

interface ColInfo {
  date:      string    // "YYYY-MM-DD"
  label:     string    // "월 7/6"
  isHoliday: boolean
  inWindow:  boolean   // within [windowStart, windowEnd]
}

interface WeekInfo {
  weekStart: string   // "YYYY-MM-DD" (Monday)
  label:     string   // "7/6(월) ~ 7/10(금)"
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
  let monNum = weekStart(windowStartNum)
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

  return weeks.reverse()  // latest week first
}

function sortPeople(people: Person[]): Person[] {
  return [...people].sort((a, b) => {
    const rc = (RANK_ORDER[a.rank] ?? 99) - (RANK_ORDER[b.rank] ?? 99)
    return rc !== 0 ? rc : a.name.localeCompare(b.name, 'ko')
  })
}

// ── HTML export ────────────────────────────────────────────────

function generateGuidelineHtml(
  weeks:       WeekInfo[],
  people:      Person[],
  allCells:    Map<string, CellData>,
  windowStart: string,
  windowEnd:   string,
  todayStr:    string,
  overrides:   Record<string, string>,
): string {
  const generated = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })
  const sorted    = sortPeople(people)

  const weekSections = weeks.map(week => {
    const colHeaders = week.columns.map(col =>
      `<th class="${col.isHoliday ? 'holiday' : ''}">${escHtml(col.label)}${col.isHoliday && col.inWindow ? '<br><small>(공휴일)</small>' : ''}</th>`
    ).join('')

    const rows = sorted.map(person => {
      const cells = week.columns.map(col => {
        if (!col.inWindow) return `<td class="out-of-window"></td>`
        if (col.isHoliday)  return `<td class="holiday">—</td>`
        const key  = entryKey(person.id, col.date)
        const cell = allCells.get(key)
        if (!cell) return `<td></td>`
        const ov   = overrides[key]?.trim()
        const code = ov || cell.computed
        const prov = cell.provisional && !ov
        if (cell.kind === 'new') {
          return `<td class="new-entry">${escHtml(code)}${prov ? ' ⚠' : ''}</td>`
        }
        if (cell.kind === 'correction') {
          return `<td class="correction"><del>${escHtml(cell.existing ?? '')}</del> → ${escHtml(code)}${prov ? ' ⚠' : ''}</td>`
        }
        return `<td class="mono-sm">${escHtml(code)}</td>`
      }).join('')
      return `<tr><td class="person-cell"><strong>${escHtml(person.name)}</strong><br><span class="rank">${escHtml(person.rank)}</span></td>${cells}</tr>`
    }).join('')

    return `<section>
<h2>${escHtml(week.label)}</h2>
<table>
<thead><tr><th class="person-cell">이름</th>${colHeaders}</tr></thead>
<tbody>${rows}</tbody>
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
.new-entry { background:#eff6ff; color:#1d4ed8; font-family:monospace; }
.correction { background:#fffbeb; }
.correction del { color:#9ca3af; }
.holiday { background:#f9fafb; color:#9ca3af; text-align:center; }
.out-of-window { background:#fafafa; }
.person-cell { min-width:80px; }
.mono-sm { font-family:monospace; font-size:11px; }
.rank { font-size:10px; color:#6b7280; }
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

  // ── Local state ───────────────────────────────────────────

  const [isGenerating, setIsGenerating] = useState(false)
  const [isSaving,     setIsSaving]     = useState(false)
  const [genError,     setGenError]     = useState<string | null>(null)
  const [allCells,     setAllCells]     = useState<Map<string, CellData>>(new Map())
  const [overrides,    setOverrides]    = useState<Record<string, string>>({})
  const [savedAt,      setSavedAt]      = useState<string | null>(null)
  const [generated,    setGenerated]    = useState(false)
  const [nameSearch,   setNameSearch]   = useState('')

  // Accordion — default: first 2 weeks (latest) expanded after generation
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

  const handleOverride = useCallback((key: string, v: string) => {
    setOverrides(prev => ({ ...prev, [key]: v }))
  }, [])

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

      // Build unified cell map (includes unchanged for matrix display)
      const cells = new Map<string, CellData>()
      for (const person of activePeople) {
        for (const dateStr of workingDays) {
          const key  = entryKey(person.id, dateStr)
          const comp = computed.get(key)
          if (!comp) continue
          const existing = snapMap.get(key) ?? null
          const kind: 'new' | 'correction' | 'unchanged' =
            existing === null      ? 'new' :
            existing !== comp.code ? 'correction' : 'unchanged'
          cells.set(key, { computed: comp.code, provisional: comp.provisional, existing, kind })
        }
      }

      setAllCells(cells)
      setOverrides({})
      setSavedAt(null)
      setGenerated(true)
      expandInitRef.current = false  // re-init accordion on re-generate
    } catch (e) {
      setGenError(e instanceof Error ? e.message : '생성 실패')
    } finally {
      setIsGenerating(false)
    }
  }

  // ── Save ──────────────────────────────────────────────────

  async function handleSave() {
    setIsSaving(true)
    setGenError(null)
    try {
      const runAt = new Date().toISOString()
      const rows: object[] = []

      for (const [key, cell] of allCells.entries()) {
        const [personId, date] = key.split('|')
        const ov     = overrides[key]?.trim()
        const code   = ov || cell.computed
        const detail = cell.provisional && !ov ? '(임시 — 추후 정정 필요)' : null
        rows.push({ person_id: personId, date, code, detail, run_at: runAt })
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

      setSavedAt(new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }))
    } catch (e) {
      setGenError(e instanceof Error ? e.message : '저장 실패')
    } finally {
      setIsSaving(false)
    }
  }

  // ── Render ────────────────────────────────────────────────

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
                  generateGuidelineHtml(weeks, filteredPeople, allCells, windowStart, windowEnd, todayStr, overrides),
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
                  : <><Save size={13} /> {newCount + corrCount}건 저장</>}
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

      {genError && (
        <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 flex items-center gap-2">
          <AlertTriangle size={13} className="flex-shrink-0" /> {genError}
        </div>
      )}

      {savedAt && (
        <div className="rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-700">
          저장 완료 — {savedAt}
        </div>
      )}

      {!generated && !isGenerating && (
        <div className="rounded-md border border-border bg-surface-50 px-4 py-10 text-center">
          <p className="text-sm text-muted">"지침 생성" 버튼을 눌러 타임시트 코드 지침을 산출하세요.</p>
          <p className="text-xs text-muted mt-1">8주 윈도우 내 전 인원의 일자별 코드를 주차별 매트릭스로 표시합니다.</p>
        </div>
      )}

      {generated && (
        <>
          {/* Summary bar + search */}
          <div className="flex items-center gap-3 flex-wrap border-b border-border pb-3">
            <span className="pill bg-blue-100 text-blue-700 text-[10px]">신규 {newCount}건</span>
            <span className={`pill text-[10px] ${corrCount > 0 ? 'bg-amber-100 text-amber-700' : 'bg-gray-100 text-gray-500'}`}>
              정정 {corrCount}건
            </span>
            <div className="ml-auto flex items-center gap-2">
              <input
                className="input py-1 text-xs w-52"
                placeholder="이름 검색… (AND/OR 지원)"
                value={nameSearch}
                onChange={(e: ChangeEvent<HTMLInputElement>) => setNameSearch(e.target.value)}
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
          </div>

          {/* Weekly accordion sections */}
          <div className="space-y-2">
            {weeks.map(week => {
              const isOpen = expandedWeeks.has(week.weekStart)

              // Count new/corr for this week across ALL people (for header badge)
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
                  {/* Section header */}
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

                  {/* Matrix table */}
                  {isOpen && (
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs border-t border-border">
                        <thead>
                          <tr className="bg-surface-50 border-b border-border">
                            <th className="px-3 py-2 text-left font-medium text-muted whitespace-nowrap sticky left-0 bg-surface-50 z-10 min-w-[90px]">
                              이름
                            </th>
                            {week.columns.map(col => (
                              <th
                                key={col.date}
                                className={[
                                  'px-2 py-2 text-center font-medium min-w-[80px]',
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
                        <tbody className="divide-y divide-border/40">
                          {filteredPeople.length === 0 ? (
                            <tr>
                              <td colSpan={6} className="px-3 py-4 text-center text-muted">검색 결과 없음</td>
                            </tr>
                          ) : filteredPeople.map(person => (
                            <tr key={person.id} className="hover:bg-surface-50/40">
                              {/* Name cell — sticky */}
                              <td className="px-3 py-1.5 sticky left-0 bg-white z-10 border-r border-border/40">
                                <div className="font-medium text-gray-800 truncate max-w-[84px]">{person.name}</div>
                                <div className="text-[10px] text-muted">{person.rank}</div>
                              </td>

                              {week.columns.map(col => {
                                // Outside window
                                if (!col.inWindow) {
                                  return (
                                    <td key={col.date} className="px-2 py-1.5 bg-gray-50/40" />
                                  )
                                }
                                // Holiday
                                if (col.isHoliday) {
                                  return (
                                    <td key={col.date} className="px-2 py-1.5 bg-gray-50 text-center text-[10px] text-muted">—</td>
                                  )
                                }

                                const key  = entryKey(person.id, col.date)
                                const cell = allCells.get(key)

                                if (!cell) {
                                  return <td key={col.date} className="px-2 py-1.5" />
                                }

                                const ov  = overrides[key] ?? ''
                                const prov = cell.provisional && !ov.trim()

                                return (
                                  <td
                                    key={col.date}
                                    className={[
                                      'px-2 py-1.5 align-top',
                                      cell.kind === 'new'        ? 'bg-blue-50' :
                                      cell.kind === 'correction' ? 'bg-amber-50' : '',
                                    ].join(' ')}
                                  >
                                    {/* Correction: show old code struck-out */}
                                    {cell.kind === 'correction' && (
                                      <div className="font-mono text-[9px] text-gray-400 line-through leading-tight">
                                        {cell.existing}
                                      </div>
                                    )}

                                    {/* Current computed (or override) code */}
                                    <div className={[
                                      'font-mono text-xs leading-tight flex items-center gap-0.5',
                                      cell.kind === 'new'        ? 'text-blue-700' :
                                      cell.kind === 'correction' ? 'text-amber-700' :
                                      'text-gray-700',
                                    ].join(' ')}>
                                      {ov.trim() || cell.computed}
                                      {prov && <AlertTriangle size={9} className="text-amber-500 flex-shrink-0" aria-label="임시 코드" />}
                                    </div>

                                    {/* Override input for new / correction cells */}
                                    {(cell.kind === 'new' || cell.kind === 'correction') && (
                                      <input
                                        type="text"
                                        className="mt-0.5 w-full border border-border/60 rounded px-1 py-0 text-[10px] font-mono bg-white/80 focus:outline-none focus:ring-1 focus:ring-brand-400"
                                        placeholder="수정 코드"
                                        value={ov}
                                        onChange={(e: ChangeEvent<HTMLInputElement>) => handleOverride(key, e.target.value)}
                                      />
                                    )}
                                  </td>
                                )
                              })}
                            </tr>
                          ))}
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
    </div>
  )
}
