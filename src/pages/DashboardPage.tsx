/**
 * DashboardPage — §5.1 대시보드 / §8 Utilization
 *
 * Editor / Admin 전용. 4종 가동률 카드 + 금주 복귀 예정자 + 업무지정 필요대상.
 */
import { useMemo, useState } from 'react'
import { PieChart, Pie, Cell } from 'recharts'
import { useNavigate } from 'react-router-dom'
import { useAllPeople }      from '@/features/people/hooks'
import { useAllWorkItems }   from '@/features/workitems/hooks'
import { useAllAssignments } from '@/features/timeline/hooks'
import { useAllHolidays }    from '@/features/admin/hooks'
import { useSettings }       from '@/features/admin/hooks'
import { useAuth }           from '@/context/AuthContext'
import { useAuthz }          from '@/hooks/useAuthz'
import { buildWorkItemColorMap } from '@/lib/colors'
import WorkItemDetailModal   from '@/features/workitems/WorkItemDetailModal'
import {
  today, dateToNum, numToStr,
  monthStart, weekStart, nextWorkday, fyOf, fyRange, isWeekend,
} from '@/lib/date'
import { computeUtil } from '@/features/dashboard/utilization'
import type { Person, WorkItem } from '@/types'

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type WeekBucket = '지난주' | '이번주' | '다음주'
type WiRow = { wi: WorkItem; dateNum: number; bucket: WeekBucket }

const BUCKET_STYLE: Record<WeekBucket, string> = {
  '지난주': 'bg-gray-100  text-gray-600',
  '이번주': 'bg-brand-100 text-brand-700',
  '다음주': 'bg-amber-100 text-amber-700',
}

const BUCKET_DATE_COLOR: Record<WeekBucket, string> = {
  '지난주': 'bg-gray-50  border border-gray-200  text-gray-600',
  '이번주': 'bg-brand-50 border border-brand-200 text-brand-700',
  '다음주': 'bg-amber-50 border border-amber-200 text-amber-700',
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────────────────────

function ProjectWeekList({ title, rows, isViewer, label, dateLabel, accentColor, onClickWI }: {
  title:       string
  rows:        WiRow[]
  isViewer:    boolean
  label:       (n: number) => string
  dateLabel:   string
  accentColor: string
  onClickWI:   (wi: WorkItem) => void  // D-6: drill-down
}) {
  return (
    <section className="card p-5">
      <h2 className="text-xs font-semibold text-gray-700 mb-3 flex items-center gap-2">
        <span className={`w-2 h-2 rounded-full flex-shrink-0 ${accentColor}`} />
        {title}
        <span className="ml-auto text-muted font-normal text-[11px]">지난주·이번주·다음주</span>
      </h2>
      {rows.length === 0 ? (
        <p className="text-sm text-muted py-4 text-center">해당 기간 프로젝트 없음</p>
      ) : (
        <div className="space-y-1">
          {rows.map(({ wi, dateNum, bucket }) => {
            const name    = isViewer && wi.confidential ? '(비공개)' : wi.name
            const masked  = name === '(비공개)'
            return (
              <div
                key={wi.id}
                className={`flex items-center gap-2 py-2 border-b border-border/50 last:border-0 min-w-0 rounded transition-colors ${!masked ? 'cursor-pointer hover:bg-surface-50' : ''}`}
                onClick={() => { if (!masked) onClickWI(wi) }}
              >
                <span className={`pill text-[10px] flex-shrink-0 ${BUCKET_STYLE[bucket]}`}>{bucket}</span>
                <span className={`text-sm font-medium truncate flex-1 ${masked ? 'text-muted italic' : 'text-gray-900'}`}>
                  {name}
                </span>
                {wi.client && (!wi.confidential || !isViewer) && (
                  <span className="text-xs text-muted truncate hidden sm:block max-w-[100px]">{wi.client}</span>
                )}
                <span className={`flex-shrink-0 text-[11px] font-medium tabular-nums rounded px-2 py-0.5 ${BUCKET_DATE_COLOR[bucket]}`}>
                  {dateLabel} {label(dateNum)}
                </span>
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}

function DonutCard({ title, sub, num, den, color }: {
  title: string; sub: string; num: number; den: number; color: string
}) {
  const pctStr   = den > 0 ? (num / den * 100).toFixed(1) + '%' : '―'
  const chartData = den > 0
    ? [{ v: num }, { v: Math.max(den - num, 0) }]
    : [{ v: 1 }]
  const colors   = den > 0 ? [color, '#e5e7eb'] : ['#e5e7eb']

  return (
    <div className="card p-4 flex flex-col items-center gap-1.5 min-w-0">
      <div className="self-stretch flex items-center gap-1.5">
        <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: color }} />
        <span className="text-xs font-semibold text-muted uppercase tracking-wide truncate">{title}</span>
      </div>

      <div className="relative flex-shrink-0">
        <PieChart width={108} height={108}>
          <Pie data={chartData} cx={54} cy={54}
            innerRadius={33} outerRadius={50}
            startAngle={90} endAngle={-270}
            dataKey="v" strokeWidth={0} isAnimationActive={false}>
            {colors.map((c, i) => <Cell key={i} fill={c} />)}
          </Pie>
        </PieChart>
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <span className={`font-bold leading-none ${den > 0 ? 'text-[17px] text-gray-900' : 'text-xl text-muted'}`}>
            {pctStr}
          </span>
        </div>
      </div>

      {den > 0 && (
        <p className="text-xs text-muted tabular-nums">{num} / {den} 영업일</p>
      )}

      <p className="text-[11px] text-muted border-t border-border pt-1.5 w-full text-center mt-auto leading-tight">
        {sub}
      </p>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Main component
// ─────────────────────────────────────────────────────────────────────────────

export default function DashboardPage() {
  const { profile }         = useAuth()
  const isViewer            = profile?.global_role === 'viewer'
  const { canEdit, isAdmin } = useAuthz()
  const navigate            = useNavigate()

  const { data: people      = [], isLoading: lP } = useAllPeople()
  const { data: workItems   = [], isLoading: lW } = useAllWorkItems()
  const { data: assignments = [], isLoading: lA } = useAllAssignments()
  const { data: holidays    = [], isLoading: lH } = useAllHolidays()
  const { data: settings,         isLoading: lS } = useSettings()

  const isLoading = lP || lW || lA || lH || lS

  // D-6: work item detail drill-down state
  const [detailWorkItem, setDetailWorkItem] = useState<WorkItem | null>(null)
  const peopleMap = useMemo(() => new Map(people.map(p => [p.id, p])), [people])
  const colorMap  = useMemo(() => buildWorkItemColorMap(workItems), [workItems])

  const todayNum    = useMemo(() => today(), [])
  const fym         = settings?.fiscal_year_start_month ?? 7
  const currentFY   = useMemo(() => fyOf(todayNum, fym), [todayNum, fym])
  const [selectedFY, setSelectedFY] = useState<number | null>(null)
  const activeFY    = selectedFY ?? currentFY

  // Build holiday fast-lookup set (year ±3 range)
  const holidaySet = useMemo(() => {
    const s   = new Set<number>()
    const yr  = new Date().getFullYear()
    for (const h of holidays) {
      const base = dateToNum(h.date)
      if (!h.recurring) {
        s.add(base)
      } else {
        const bd = new Date(base * 86_400_000)
        for (let y = yr - 3; y <= yr + 3; y++) {
          s.add(dateToNum(new Date(Date.UTC(y, bd.getUTCMonth(), bd.getUTCDate()))))
        }
      }
    }
    return s
  }, [holidays])
  const isHoliday = useMemo(() => (n: number) => holidaySet.has(n), [holidaySet])

  // ── Period definitions ─────────────────────────────────────
  const periods = useMemo(() => {
    const weekMon          = weekStart(todayNum)
    const weekSun          = weekMon + 6
    const [fyStart, fyEnd] = fyRange(activeFY, fym)
    const ytdEnd           = Math.min(todayNum, fyEnd)

    return {
      ytd:  [fyStart, ytdEnd]            as [number, number],
      mtd:  [monthStart(todayNum), todayNum] as [number, number],
      week: [weekMon, weekSun]           as [number, number],
      day:  [todayNum, todayNum]         as [number, number],
      weekMon,
      weekSun,
      fyStart,
      fyEnd,
    }
  }, [todayNum, fym, activeFY])

  // ── 4 utilization cards ────────────────────────────────────
  const utils = useMemo(() => {
    if (isLoading) return null
    return {
      ytd:  computeUtil(...periods.ytd,  people, assignments, workItems, isHoliday),
      mtd:  computeUtil(...periods.mtd,  people, assignments, workItems, isHoliday),
      week: computeUtil(...periods.week, people, assignments, workItems, isHoliday),
      day:  computeUtil(...periods.day,  people, assignments, workItems, isHoliday),
    }
  }, [isLoading, periods, people, assignments, workItems, isHoliday])

  // ── 금주 복귀 예정자 ───────────────────────────────────────
  // People whose leave (kind='leave') ends such that nextWorkday(end) ∈ this week
  const returning = useMemo(() => {
    if (isLoading) return []
    const { weekMon, weekSun } = periods
    const activePeople = people.filter(p => p.status === 'active')
    const result: { person: Person; returnDay: number }[] = []
    const seen = new Set<string>()

    for (const p of activePeople) {
      const myLeaves = assignments.filter(a => a.person_id === p.id && a.kind === 'leave')
      let bestRetDay = -1
      for (const a of myLeaves) {
        const retDay = nextWorkday(dateToNum(a.end_date), isHoliday)
        if (retDay >= weekMon && retDay <= weekSun) {
          if (retDay > bestRetDay) bestRetDay = retDay
        }
      }
      if (bestRetDay > 0 && !seen.has(p.id)) {
        seen.add(p.id)
        result.push({ person: p, returnDay: bestRetDay })
      }
    }

    return result.sort((a, b) => a.returnDay - b.returnDay)
  }, [isLoading, periods, people, assignments, isHoliday])

  // ── 입사 예정자 ───────────────────────────────────────────
  // People whose hire_date > today, sorted ascending
  const upcomingHires = useMemo(() => {
    if (isLoading) return [] as Person[]
    const todayStr = numToStr(todayNum)
    return people
      .filter(p => p.hire_date && p.hire_date > todayStr)
      .sort((a, b) => (a.hire_date ?? '').localeCompare(b.hire_date ?? ''))
  }, [isLoading, people, todayNum])

  // ── 업무지정 필요대상 ──────────────────────────────────────
  // §5.1: Active people who have at least one unassigned business day in [today, today+6]
  const needsAssignment = useMemo(() => {
    if (isLoading) return [] as { person: Person; unassignedDays: number[] }[]
    const result: { person: Person; unassignedDays: number[] }[] = []

    for (const p of people) {
      if (p.status !== 'active') continue
      if (p.rank === 'Partner') continue
      const myAsgn = assignments.filter(a => a.person_id === p.id)
      const unassigned: number[] = []

      for (let d = todayNum; d <= todayNum + 6; d++) {
        if (isWeekend(d) || isHoliday(d)) continue
        const covered = myAsgn.some(a =>
          dateToNum(a.start) <= d && d <= dateToNum(a.end_date),
        )
        if (!covered) unassigned.push(d)
      }

      if (unassigned.length > 0) result.push({ person: p, unassignedDays: unassigned })
    }

    // Sort: most unassigned days first, then by name
    return result.sort(
      (a, b) =>
        b.unassignedDays.length - a.unassignedDays.length ||
        a.person.name.localeCompare(b.person.name, 'ko'),
    )
  }, [isLoading, todayNum, people, assignments, isHoliday])

  // ── §5.11 Kick-off / Ending (지난주·이번주·다음주) ─────────
  const { kickoffRows, endingRows } = useMemo(() => {
    if (isLoading) return { kickoffRows: [] as WiRow[], endingRows: [] as WiRow[] }
    const mon     = periods.weekMon
    const lastMon = mon - 7
    const nextMon = mon + 7

    function bucket(n: number): WeekBucket | null {
      if (n >= lastMon && n <= lastMon + 6) return '지난주'
      if (n >= mon     && n <= mon     + 6) return '이번주'
      if (n >= nextMon && n <= nextMon + 6) return '다음주'
      return null
    }

    const projects = workItems.filter(w => w.type === 'project')

    const kickoffRows: WiRow[] = []
    const endingRows:  WiRow[] = []

    for (const w of projects) {
      const kickD = dateToNum(w.main_start ?? w.start)
      const bk    = bucket(kickD)
      if (bk) kickoffRows.push({ wi: w, dateNum: kickD, bucket: bk })

      const endD = dateToNum(w.end_date)
      const be   = bucket(endD)
      if (be) endingRows.push({ wi: w, dateNum: endD, bucket: be })
    }

    kickoffRows.sort((a, b) => a.dateNum - b.dateNum)
    endingRows.sort((a, b) => a.dateNum - b.dateNum)
    return { kickoffRows, endingRows }
  }, [isLoading, workItems, periods])

  // ── Period label helpers ───────────────────────────────────
  function label(d: number) {
    const dt = new Date(d * 86_400_000)
    return `${dt.getUTCFullYear()}.${String(dt.getUTCMonth()+1).padStart(2,'0')}.${String(dt.getUTCDate()).padStart(2,'0')}`
  }

  function fmtUnassignedDays(days: number[]): string {
    if (days.length === 0) return ''
    const md = (n: number) => {
      const dt = new Date(n * 86_400_000)
      return `${String(dt.getUTCMonth()+1).padStart(2,'0')}.${String(dt.getUTCDate()).padStart(2,'0')}`
    }
    if (days.length <= 3) return days.map(md).join(', ')
    return `${md(days[0])} ~ ${md(days[days.length - 1])}`
  }

  const fyYears = [currentFY - 1, currentFY, currentFY + 1]
  const btnBase = 'px-2.5 py-1 text-xs font-medium rounded border transition-colors'
  const btnOn   = 'bg-brand-600 text-white border-brand-600'
  const btnOff  = 'bg-white text-gray-700 border-border hover:bg-surface-50'

  if (isLoading) {
    return <div className="p-8 text-sm text-muted">Loading…</div>
  }

  const todayDateStr = label(todayNum)

  return (
    <div className="flex flex-col h-full overflow-auto bg-surface-50">
      {/* Header */}
      <div className="flex-shrink-0 flex flex-wrap items-center gap-3 border-b border-border px-6 py-4 bg-surface-0">
        <div className="flex-1 min-w-0">
          <h1 className="text-base font-semibold text-gray-900">대시보드</h1>
          <p className="text-xs text-muted">{todayDateStr} 기준</p>
        </div>
        {/* FY selector for YTD card */}
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-muted font-medium">YTD 회계연도</span>
          {fyYears.map(fy => (
            <button key={fy}
              className={`${btnBase} ${activeFY === fy ? btnOn : btnOff}`}
              onClick={() => setSelectedFY(fy === currentFY ? null : fy)}>
              FY{String(fy).slice(-2)}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 p-6 space-y-6 min-h-0">

        {/* ── Utilization cards ── */}
        <section>
          <h2 className="text-xs font-semibold uppercase tracking-wider text-muted mb-3">
            Utilization — Partner 제외, 재직기간 내 Project 배정 영업일
          </h2>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <DonutCard
              title={`FY${String(activeFY).slice(-2)} YTD`}
              sub={`${label(periods.ytd[0])} ~ ${label(periods.ytd[1])}`}
              num={utils?.ytd.num  ?? 0}
              den={utils?.ytd.den  ?? 0}
              color="#4f46e5"
            />
            <DonutCard
              title="MTD"
              sub={`${label(periods.mtd[0])} ~ ${label(periods.mtd[1])}`}
              num={utils?.mtd.num  ?? 0}
              den={utils?.mtd.den  ?? 0}
              color="#818cf8"
            />
            <DonutCard
              title="금주 (예정 포함)"
              sub={`${label(periods.week[0])} ~ ${label(periods.week[1])}`}
              num={utils?.week.num ?? 0}
              den={utils?.week.den ?? 0}
              color="#a78bfa"
            />
            <DonutCard
              title="실시간 (오늘)"
              sub={todayDateStr}
              num={utils?.day.num  ?? 0}
              den={utils?.day.den  ?? 0}
              color="#10b981"
            />
          </div>
        </section>

        {/* ── §5.11 Kick-off / Ending ── */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">

          {/* 프로젝트 Kick-off */}
          <ProjectWeekList
            title="프로젝트 Kick-off"
            rows={kickoffRows}
            isViewer={isViewer}
            label={label}
            dateLabel="시작"
            accentColor="bg-brand-400"
            onClickWI={setDetailWorkItem}
          />

          {/* 프로젝트 종료 */}
          <ProjectWeekList
            title="프로젝트 종료"
            rows={endingRows}
            isViewer={isViewer}
            label={label}
            dateLabel="종료"
            accentColor="bg-rose-400"
            onClickWI={setDetailWorkItem}
          />

        </div>

        {/* ── 금주 복귀 예정자 + 입사 예정자 + 업무지정 필요대상 ── */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">

          {/* 금주 복귀 예정자 */}
          <section className="card p-5">
            <h2 className="text-xs font-semibold text-gray-700 mb-3 flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-amber-400 flex-shrink-0" />
              금주 복귀 예정자
              <span className="ml-auto text-muted font-normal">
                {label(periods.weekMon)} ~ {label(periods.weekSun)}
              </span>
            </h2>
            {returning.length === 0 ? (
              <p className="text-sm text-muted py-4 text-center">이번 주 복귀 예정자 없음</p>
            ) : (
              <div className="space-y-1">
                {returning.map(({ person: p, returnDay }) => (
                  <div key={p.id} className="flex items-center justify-between py-2 border-b border-border/50 last:border-0">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="pill bg-surface-100 text-gray-700 text-[11px]">{p.rank}</span>
                      {/* D-6: click → timeline highlight */}
                      <button
                        className="text-sm font-medium text-gray-900 truncate hover:text-brand-600 hover:underline text-left"
                        onClick={() => navigate('/timeline', { state: { highlightPersonId: p.id } })}
                      >{p.name}</button>
                      {p.role && <span className="text-xs text-muted truncate hidden sm:block">{p.role}</span>}
                    </div>
                    <div className="flex-shrink-0 text-xs font-medium text-emerald-700 bg-emerald-50 border border-emerald-200 rounded px-2 py-0.5">
                      복귀 {label(returnDay)}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* 입사 예정자 */}
          <section className="card p-5">
            <h2 className="text-xs font-semibold text-gray-700 mb-3 flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-brand-400 flex-shrink-0" />
              입사 예정자
            </h2>
            {upcomingHires.length === 0 ? (
              <p className="text-sm text-muted py-4 text-center">입사 예정자 없음</p>
            ) : (
              <div className="space-y-1">
                {upcomingHires.map(p => (
                  <div key={p.id} className="flex items-center justify-between py-2 border-b border-border/50 last:border-0">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="pill bg-surface-100 text-gray-700 text-[11px]">{p.rank}</span>
                      <span className="text-sm font-medium text-gray-900 truncate">{p.name}</span>
                    </div>
                    <div className="flex-shrink-0 text-xs font-medium text-brand-700 bg-brand-50 border border-brand-200 rounded px-2 py-0.5">
                      입사 {label(dateToNum(p.hire_date!))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* 업무지정 필요대상 */}
          <section className="card p-5">
            <h2 className="text-xs font-semibold text-gray-700 mb-3 flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-red-400 flex-shrink-0" />
              업무지정 필요대상
              <span className="ml-auto text-muted font-normal text-[11px]">향후 7일 내 미배정 영업일</span>
            </h2>
            {needsAssignment.length === 0 ? (
              <p className="text-sm text-muted py-4 text-center">모든 구성원에 일정이 있습니다</p>
            ) : (
              <div className="space-y-1">
                {needsAssignment.map(({ person: p, unassignedDays }) => (
                  <div key={p.id} className="flex items-center gap-2 py-2 border-b border-border/50 last:border-0">
                    <span className="pill bg-surface-100 text-gray-700 text-[11px]">{p.rank}</span>
                    {/* D-6: click → timeline highlight */}
                    <button
                      className="text-sm font-medium text-gray-900 truncate hover:text-brand-600 hover:underline text-left"
                      onClick={() => navigate('/timeline', { state: { highlightPersonId: p.id } })}
                    >{p.name}</button>
                    {p.role && <span className="text-xs text-muted truncate hidden sm:block">{p.role}</span>}
                    <div className="ml-auto flex-shrink-0 text-right">
                      <span className="block text-[11px] text-red-600 font-semibold">
                        {unassignedDays.length}일 미배정
                      </span>
                      <span className="block text-[10px] text-muted tabular-nums leading-tight">
                        {fmtUnassignedDays(unassignedDays)}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

        </div>
      </div>

      {/* D-6: Work item detail drill-down */}
      {detailWorkItem && (() => {
        const latest   = workItems.find(w => w.id === detailWorkItem.id) ?? detailWorkItem
        const isClosed = (latest.status ?? latest.project_status ?? 'open') === 'closed'
        const canEditWI = !isClosed && (isAdmin() || canEdit('work_item', latest.id))
        return (
          <WorkItemDetailModal
            workItem={latest}
            assignments={assignments}
            peopleMap={peopleMap}
            colorMap={colorMap}
            canEdit={canEditWI}
            onClose={() => setDetailWorkItem(null)}
            onEdit={() => setDetailWorkItem(null)}
          />
        )
      })()}
    </div>
  )
}
