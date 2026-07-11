/**
 * TimesheetGuidelineTab — AL-12/13/14
 * 8주 슬라이딩 윈도우(±2주 과거, +6주 미래) 안의 영업일마다
 * resolveTimesheetCode(8-priority)를 실행해 타임시트 입력 지침을 생성한다.
 */
import { useState, useMemo, useCallback, type ChangeEvent } from 'react'
import { Loader2, Play, Download, Save, AlertTriangle, RefreshCw } from 'lucide-react'
import { useAllPeople }      from '@/features/people/hooks'
import { useAllAssignments } from '@/features/timeline/hooks'
import { useAllAccruals }    from '@/features/leave/hooks'
import { useAllWorkItems }   from '@/features/workitems/hooks'
import { useAllHolidays }    from '@/features/admin/hooks'
import { useAllAdjustments } from './hooks'
import { computeLedger, buildHolidaySet } from '@/features/leave/ledger'
import { resolveTimesheetCode } from './resolveTimesheetCode'
import type { ResolveContext } from './resolveTimesheetCode'
import { today, numToStr, isWeekend } from '@/lib/date'
import { supabase } from '@/lib/supabase'
import { escHtml, triggerDownload, HTML_EXPORT_CSS } from '@/lib/htmlExport'
import type { Rank } from '@/types'

// ── Constants ─────────────────────────────────────────────────

const WINDOW_PAST  = 14   // 2 weeks back
const WINDOW_AHEAD = 42   // 6 weeks forward  (total 8 weeks)

const RANK_ORDER: Record<Rank, number> = {
  Partner: 0, SM: 1, M: 2, Senior: 3, Staff: 4, Intern: 5,
}

// ── Types ──────────────────────────────────────────────────────

interface GuidelineEntry {
  personId:    string
  personName:  string
  personRank:  Rank
  date:        string
  computed:    string
  provisional: boolean
  existing:    string | null
  kind:        'new' | 'correction'
}

function entryKey(personId: string, date: string) {
  return `${personId}|${date}`
}

function sortEntries(a: GuidelineEntry, b: GuidelineEntry) {
  const dc = a.date.localeCompare(b.date)
  if (dc !== 0) return dc
  const rc = (RANK_ORDER[a.personRank] ?? 99) - (RANK_ORDER[b.personRank] ?? 99)
  if (rc !== 0) return rc
  return a.personName.localeCompare(b.personName, 'ko')
}

// ── OverrideInput sub-component ───────────────────────────────

function OverrideInput({
  computed,
  provisional,
  value,
  onChange,
}: {
  computed:    string
  provisional: boolean
  value:       string
  onChange:    (v: string) => void
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-center gap-1">
        <span className={`font-mono text-xs ${provisional ? 'text-amber-600' : 'text-gray-700'}`}>
          {computed}
        </span>
        {provisional && (
          <AlertTriangle size={11} className="text-amber-500 flex-shrink-0" title="임시 코드 — 추후 정정 필요" />
        )}
      </div>
      <input
        type="text"
        className="input py-0 text-xs font-mono w-36"
        placeholder="수정 코드 (선택)"
        value={value}
        onChange={(e: ChangeEvent<HTMLInputElement>) => onChange(e.target.value)}
      />
    </div>
  )
}

// ── HTML export helper ─────────────────────────────────────────

function generateGuidelineHtml(
  part1:       GuidelineEntry[],
  part2:       GuidelineEntry[],
  windowStart: string,
  windowEnd:   string,
  todayStr:    string,
  overrides:   Record<string, string>,
): string {
  const generated = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })

  function codeFor(e: GuidelineEntry): string {
    return overrides[entryKey(e.personId, e.date)]?.trim() || e.computed
  }

  function rowHtml(e: GuidelineEntry, showExisting: boolean): string {
    const code     = codeFor(e)
    const provFlag = e.provisional && !overrides[entryKey(e.personId, e.date)]?.trim()
    return `<tr>
      <td class="mono">${escHtml(e.date)}</td>
      <td>${escHtml(e.personName)}</td>
      <td><span class="pill pill-gray">${escHtml(e.personRank)}</span></td>
      ${showExisting ? `<td class="mono"><span style="text-decoration:line-through;color:#9ca3af">${escHtml(e.existing ?? '')}</span></td>` : ''}
      <td class="mono ${provFlag ? 'warn' : ''}">${escHtml(code)}${provFlag ? ' ⚠' : ''}</td>
    </tr>`
  }

  const p1Rows = part1.length
    ? part1.map(e => rowHtml(e, false)).join('')
    : '<tr><td colspan="4" class="empty">해당 항목 없음</td></tr>'

  const p2Rows = part2.length
    ? part2.map(e => rowHtml(e, true)).join('')
    : '<tr><td colspan="5" class="empty">해당 항목 없음</td></tr>'

  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<title>타임시트 지침 — ${escHtml(todayStr)}</title>
<style>
${HTML_EXPORT_CSS}
.warn { color: #d97706; font-weight: 600; }
</style>
</head>
<body>
<header>
  <h1>타임시트 지침</h1>
  <p class="meta">윈도우: ${escHtml(windowStart)} ~ ${escHtml(windowEnd)}</p>
  <p class="meta">생성: ${escHtml(generated)}</p>
</header>

<section>
  <h2>Part 1 — 신규 항목 (${part1.length}건)</h2>
  <table>
    <thead><tr><th>날짜</th><th>인력</th><th>직급</th><th>코드</th></tr></thead>
    <tbody>${p1Rows}</tbody>
  </table>
</section>

<section>
  <h2>Part 2 — 정정 항목 (${part2.length}건)</h2>
  <table>
    <thead><tr><th>날짜</th><th>인력</th><th>직급</th><th>이전 코드</th><th>신규 코드</th></tr></thead>
    <tbody>${p2Rows}</tbody>
  </table>
</section>
</body>
</html>`
}

// ── Entry table sub-component ─────────────────────────────────

function EntryTable({
  entries,
  showExisting,
  overrides,
  onOverride,
}: {
  entries:     GuidelineEntry[]
  showExisting: boolean
  overrides:   Record<string, string>
  onOverride:  (key: string, v: string) => void
}) {
  if (entries.length === 0) {
    return <p className="text-xs text-muted text-center py-4">해당 항목 없음</p>
  }

  return (
    <div className="card p-0 overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="bg-surface-50 border-b border-border text-muted">
            <th className="px-3 py-2 text-left font-medium whitespace-nowrap">날짜</th>
            <th className="px-3 py-2 text-left font-medium">인력</th>
            <th className="px-3 py-2 text-left font-medium">직급</th>
            {showExisting && <th className="px-3 py-2 text-left font-medium">이전 코드</th>}
            <th className="px-3 py-2 text-left font-medium">산출 코드</th>
            <th className="px-3 py-2 text-left font-medium">코드 수정 <span className="text-[10px] font-normal">(저장 전 수정 가능)</span></th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {entries.map(e => {
            const key = entryKey(e.personId, e.date)
            return (
              <tr key={key} className="hover:bg-surface-50">
                <td className="px-3 py-2 font-mono whitespace-nowrap">{e.date}</td>
                <td className="px-3 py-2 font-medium text-gray-800">{e.personName}</td>
                <td className="px-3 py-2">
                  <span className="pill bg-gray-100 text-gray-600 text-[10px]">{e.personRank}</span>
                </td>
                {showExisting && (
                  <td className="px-3 py-2 font-mono text-muted line-through">{e.existing}</td>
                )}
                <td className="px-3 py-2">
                  <span className={`font-mono ${e.provisional ? 'text-amber-600' : 'text-gray-700'}`}>
                    {e.computed}
                  </span>
                  {e.provisional && (
                    <AlertTriangle size={11} className="inline ml-1 text-amber-500" />
                  )}
                </td>
                <td className="px-3 py-2">
                  <OverrideInput
                    computed={e.computed}
                    provisional={e.provisional}
                    value={overrides[key] ?? ''}
                    onChange={v => onOverride(key, v)}
                  />
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
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

  const todayNum   = today()
  const todayStr   = numToStr(todayNum)
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

  const activePeople = useMemo(
    () => allPeople.filter(p => p.status !== 'resigned'),
    [allPeople],
  )

  const [isGenerating, setIsGenerating] = useState(false)
  const [isSaving,     setIsSaving]     = useState(false)
  const [genError,     setGenError]     = useState<string | null>(null)
  const [part1,        setPart1]        = useState<GuidelineEntry[]>([])
  const [part2,        setPart2]        = useState<GuidelineEntry[]>([])
  const [overrides,    setOverrides]    = useState<Record<string, string>>({})
  const [savedAt,      setSavedAt]      = useState<string | null>(null)
  const [generated,    setGenerated]    = useState(false)

  const handleOverride = useCallback((key: string, v: string) => {
    setOverrides(prev => ({ ...prev, [key]: v }))
  }, [])

  async function handleGenerate() {
    setIsGenerating(true)
    setGenError(null)
    try {
      const windowEndNum = todayNum + WINDOW_AHEAD

      // Build per-person lookup maps
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

      // Compute codes for every active person × working day
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
          computed.set(entryKey(person.id, dateStr), result)
        }
      }

      // Fetch existing snapshots for the window
      const { data: snapshotRows, error: fetchErr } = await (supabase as any)
        .from('timesheet_guideline_snapshot')
        .select('person_id, date, code')
        .gte('date', windowStart)
        .lte('date', windowEnd)
      if (fetchErr) throw fetchErr

      const snapshotMap = new Map<string, string>()
      for (const row of snapshotRows ?? []) {
        snapshotMap.set(entryKey(row.person_id, row.date), row.code)
      }

      // Classify into Part 1 (new) / Part 2 (correction)
      const newEntries:  GuidelineEntry[] = []
      const corrEntries: GuidelineEntry[] = []

      for (const person of activePeople) {
        for (const dateStr of workingDays) {
          const key  = entryKey(person.id, dateStr)
          const comp = computed.get(key)
          if (!comp) continue
          const existing = snapshotMap.get(key) ?? null
          const entry: Omit<GuidelineEntry, 'kind' | 'existing'> = {
            personId:    person.id,
            personName:  person.name,
            personRank:  person.rank,
            date:        dateStr,
            computed:    comp.code,
            provisional: comp.provisional ?? false,
          }
          if (existing === null) {
            newEntries.push({ ...entry, existing: null, kind: 'new' })
          } else if (existing !== comp.code) {
            corrEntries.push({ ...entry, existing, kind: 'correction' })
          }
          // existing === comp.code → no change, skip
        }
      }

      newEntries.sort(sortEntries)
      corrEntries.sort(sortEntries)

      setPart1(newEntries)
      setPart2(corrEntries)
      setOverrides({})
      setSavedAt(null)
      setGenerated(true)
    } catch (e) {
      setGenError(e instanceof Error ? e.message : '생성 실패')
    } finally {
      setIsGenerating(false)
    }
  }

  async function handleSave() {
    setIsSaving(true)
    setGenError(null)
    try {
      const runAt      = new Date().toISOString()
      const allEntries = [...part1, ...part2]

      const rows = allEntries.map(e => {
        const overrideCode = overrides[entryKey(e.personId, e.date)]?.trim()
        const finalCode    = overrideCode || e.computed
        return {
          person_id: e.personId,
          date:      e.date,
          code:      finalCode,
          detail:    (e.provisional && !overrideCode) ? '(임시 — 추후 정정 필요)' : null,
          run_at:    runAt,
        }
      })

      if (rows.length > 0) {
        const { error: upsertErr } = await (supabase as any)
          .from('timesheet_guideline_snapshot')
          .upsert(rows, { onConflict: 'person_id,date' })
        if (upsertErr) throw upsertErr
      }

      // Cleanup: remove entries older than window start
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

  function handleDownload() {
    triggerDownload(
      generateGuidelineHtml(part1, part2, windowStart, windowEnd, todayStr, overrides),
      `타임시트지침_${todayStr}.html`,
    )
  }

  const totalCount = part1.length + part2.length

  return (
    <div className="space-y-6">
      {/* Window info + generate button */}
      <div className="flex flex-wrap items-center gap-3">
        <div>
          <h3 className="text-sm font-semibold text-gray-800">타임시트 지침 생성</h3>
          <p className="text-xs text-muted mt-0.5">
            윈도우: {windowStart} ~ {windowEnd}
            <span className="ml-2">영업일 {workingDays.length}일</span>
            <span className="ml-2">대상 인원 {activePeople.length}명</span>
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {generated && (
            <>
              <button
                onClick={handleDownload}
                disabled={totalCount === 0}
                className="btn-secondary text-xs py-1 gap-1 disabled:opacity-40"
              >
                <Download size={13} /> HTML 저장
              </button>
              <button
                onClick={handleSave}
                disabled={isSaving || totalCount === 0}
                className="btn-primary text-xs py-1 gap-1 disabled:opacity-40"
              >
                {isSaving
                  ? <><Loader2 size={13} className="animate-spin" /> 저장 중…</>
                  : <><Save size={13} /> {totalCount}건 저장</>}
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
        <div className="flex items-center gap-2 text-xs text-muted py-2">
          <Loader2 size={14} className="animate-spin" /> 데이터 로딩 중…
        </div>
      )}

      {genError && (
        <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 flex items-center gap-2">
          <AlertTriangle size={13} className="flex-shrink-0" />
          {genError}
        </div>
      )}

      {savedAt && (
        <div className="rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-700">
          저장 완료 — {savedAt}
        </div>
      )}

      {!generated && !isGenerating && (
        <div className="rounded-md border border-border bg-surface-50 px-4 py-8 text-center">
          <p className="text-sm text-muted">
            "지침 생성" 버튼을 눌러 타임시트 코드 지침을 산출하세요.
          </p>
          <p className="text-xs text-muted mt-1">
            8주 윈도우 내 전 인원의 일자별 코드를 분석합니다.
          </p>
        </div>
      )}

      {generated && (
        <>
          {/* Part 1 — 신규 항목 */}
          <section>
            <div className="flex items-center gap-2 mb-2">
              <h3 className="text-sm font-semibold text-gray-800">
                Part 1 — 신규 항목
              </h3>
              <span className="pill bg-brand-100 text-brand-700 text-[10px]">{part1.length}건</span>
              <span className="text-xs text-muted">스냅샷에 없는 신규 일자</span>
            </div>
            <EntryTable
              entries={part1}
              showExisting={false}
              overrides={overrides}
              onOverride={handleOverride}
            />
          </section>

          {/* Part 2 — 정정 항목 */}
          <section>
            <div className="flex items-center gap-2 mb-2">
              <h3 className="text-sm font-semibold text-gray-800">
                Part 2 — 정정 항목
              </h3>
              <span className={`pill text-[10px] ${part2.length > 0 ? 'bg-amber-100 text-amber-700' : 'bg-gray-100 text-gray-500'}`}>
                {part2.length}건
              </span>
              <span className="text-xs text-muted">기존 스냅샷과 코드가 달라진 일자</span>
            </div>
            <EntryTable
              entries={part2}
              showExisting={true}
              overrides={overrides}
              onOverride={handleOverride}
            />
          </section>
        </>
      )}
    </div>
  )
}
