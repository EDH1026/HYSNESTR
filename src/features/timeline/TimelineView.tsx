/**
 * TimelineView — Gantt-style timeline (PRD §5.1–5.2)
 *
 * Layout:
 *   ┌──────────────┬─────────────────────────────────────┐
 *   │  Controls    │                                     │
 *   ├──────────────┼─────────────────────────────────────┤
 *   │  Labels col  │  Date header  (sticky top)          │
 *   │  (sticky L)  ├─────────────────────────────────────┤
 *   │              │  Grid body   (scroll X + Y)         │
 *   │  (scroll Y)  │                                     │
 *   └──────────────┴─────────────────────────────────────┘
 *
 * Coordinate system:
 *   x = (dayNumber - viewStart) * dayWidth  (pixels from left of grid)
 *   w = (endDayNum - startDayNum + 1) * dayWidth
 */

import {
  useState, useRef, useEffect, useCallback, useMemo, useLayoutEffect, Fragment,
  Component,
  type ErrorInfo, type ReactNode,
  type PointerEvent as ReactPointerEvent,
  type MouseEvent as ReactMouseEvent,
  type DragEvent as ReactDragEvent,
} from 'react'
import { createPortal } from 'react-dom'
import { useLocation, useNavigate } from 'react-router-dom'
import { ZoomIn, ZoomOut, Calendar, Users, Briefcase, Info, SlidersHorizontal, ChevronUp, ChevronDown, ChevronRight, Eye, Pencil, Copy, Trash2, FileText, CalendarDays, Lock, Unlock } from 'lucide-react'

import {
  dateToNum, numToStr, today, isWeekend, isSaturday,
  monthBoundaries, weekBoundaries, nextMonthStart, monthStart, addMonths,
  monthYearLabel, dayOfMonthLabel, weekdayLabel, numToDate,
  snapLeaveEnd, workdayCount, nextWorkday,
} from '@/lib/date'
import { useAllPeople }                          from '@/features/people/hooks'
import { useAllWorkItems, useUpdateWorkItem }     from '@/features/workitems/hooks'
import {
  useAllAssignments,
  useUpdateAssignment,
  useDeleteAssignment,
} from '@/features/timeline/hooks'
import { useAllHolidays, useSettings }   from '@/features/admin/hooks'
import { useAuthz }         from '@/hooks/useAuthz'
import { useHistory }       from '@/lib/history'
import { makeAssignmentDrag, makeWorkItemUpdate, makeAssignmentDelete, combine } from '@/lib/historyOps'
import type { HistoryEntry } from '@/lib/history'
import { useAuth }          from '@/hooks/useAuth'
import FYPicker, { type FYFilter, resolveFYFilter } from '@/components/FYPicker'
import { parseSearchQuery } from '@/lib/searchQuery'
import AssignmentModal      from './AssignmentModal'
import { computeSpecialLeaveBalance, hasAssignmentOverlap } from '@/features/leave/validateLeave'
import WorkItemDetailModal  from '@/features/workitems/WorkItemDetailModal'
import WorkItemModal        from '@/features/workitems/WorkItemModal'

import type { Assignment, Person, WorkItem } from '@/types'
import type { ViewMode, RowData, ModalState } from './types'
import {
  LABEL_W, ROW_H, HEADER_ROW_H, BAR_PAD, HANDLE_W, DRAG_THRESHOLD,
  DAY_MIN, DAY_MAX,
  ZOOM_WEEK, ZOOM_DAY,
  WEEKEND_BG, HOLIDAY_BG, TODAY_COLOR,
  RANK_ORDER,
} from './constants'

// T-11 v2.90: Error Boundary — prevents any render exception from blanking the full app
class TimelineErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  constructor(props: { children: ReactNode }) {
    super(props)
    this.state = { error: null }
  }
  static getDerivedStateFromError(error: Error) { return { error } }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[TimelineErrorBoundary]', error, info.componentStack)
  }
  render() {
    if (this.state.error) {
      return (
        <div className="flex flex-col items-center justify-center flex-1 text-sm gap-3 py-12">
          <p className="text-red-600 font-medium">타임라인 렌더링 오류</p>
          <p className="text-xs font-mono text-gray-500">{this.state.error.message}</p>
          <button className="btn-secondary text-xs" onClick={() => this.setState({ error: null })}>
            다시 시도
          </button>
        </div>
      )
    }
    return this.props.children
  }
}

// T-1: compute dayWidth so ~90 days (≈3 months) fill the grid on first load
function calcDefaultDayWidth(): number {
  const lW = window.innerWidth < 768 ? 120 : LABEL_W
  return Math.max(DAY_MIN, Math.min(DAY_MAX, Math.round((window.innerWidth - lW) / 90)))
}

// T-17: virtual leave preview — fill empty workdays with phantom leave blocks
function computeVirtualLeaveBlocks(
  personId:           string,
  projectedRemaining: number,
  allAssignments:     Assignment[],
  todayNum:           number,
  holidaySet:         Set<number>,
): Array<{ start: number; end: number }> {
  const daysToFill = Math.floor(projectedRemaining)
  if (daysToFill <= 0) return []

  // Mark every calendar day covered by a real assignment for this person
  const occupied = new Set<number>()
  for (const a of allAssignments) {
    if (a.person_id !== personId) continue
    const s = dateToNum(a.start)
    const e = dateToNum(a.end_date)
    for (let d = s; d <= e; d++) occupied.add(d)
  }

  // Scan forward, collecting empty workdays until quota is exhausted
  const virtualDays: number[] = []
  let remaining = daysToFill
  let scan      = todayNum + 1
  const maxScan = todayNum + 730   // 2-year horizon

  while (remaining > 0 && scan <= maxScan) {
    if (!isWeekend(scan) && !holidaySet.has(scan) && !occupied.has(scan)) {
      virtualDays.push(scan)
      remaining--
    }
    scan++
  }

  if (virtualDays.length === 0) return []

  // Group consecutive virtual days into visual blocks.
  // A new block starts whenever a real-assignment day falls between two virtual days.
  // Non-working days (weekends/holidays) between virtual days are included in the same block.
  const blocks: Array<{ start: number; end: number }> = []
  let blockStart       = virtualDays[0]
  let blockLastVirtual = virtualDays[0]

  for (let i = 1; i < virtualDays.length; i++) {
    const prev = virtualDays[i - 1]
    const curr = virtualDays[i]
    let gap = false
    for (let d = prev + 1; d < curr; d++) {
      if (occupied.has(d)) { gap = true; break }
    }
    if (gap) {
      blocks.push({ start: blockStart, end: blockLastVirtual })
      blockStart = curr
    }
    blockLastVirtual = curr
  }
  blocks.push({ start: blockStart, end: blockLastVirtual })

  return blocks
}
import {
  TYPE_FAMILY, LEAVE_GREEN, buildWorkItemColorMap, barColorOf,
} from '@/lib/colors'
import { useAllAccruals }  from '@/features/leave/hooks'
import { computeLedger }   from '@/features/leave/ledger'

import type { Accrual } from '@/types'

// ─────────────────────────────────────────────────────────────────────────────
// Helper: person / work-item lookup maps
// ─────────────────────────────────────────────────────────────────────────────

function idx<T extends { id: string }>(arr: T[]): Map<string, T> {
  return new Map(arr.map(x => [x.id, x]))
}


// Color derivation uses barColorOf from @/lib/colors (PRD v2.3 §4/§9.1).
// barColor is now a thin wrapper used inside GridRow where colorMap is available.

// ─────────────────────────────────────────────────────────────────────────────
// Sub-component: DateHeader
// ─────────────────────────────────────────────────────────────────────────────

interface DateHeaderProps {
  viewStart:  number
  viewEnd:    number
  dayWidth:   number
  totalWidth: number
}

function DateHeader({ viewStart, viewEnd, dayWidth, totalWidth }: DateHeaderProps) {
  const showWeek = dayWidth >= ZOOM_WEEK
  const showDay  = dayWidth >= ZOOM_DAY

  const months = useMemo(
    () => monthBoundaries(viewStart, viewEnd),
    [viewStart, viewEnd],
  )
  const weeks = useMemo(
    () => showWeek ? weekBoundaries(viewStart, viewEnd) : [],
    [viewStart, viewEnd, showWeek],
  )

  return (
    <div style={{ width: totalWidth, position: 'relative' }}>
      {/* Month row */}
      <div style={{ height: HEADER_ROW_H, position: 'relative' }} className="bg-surface-50">
        {months.map(ms => {
          const end      = nextMonthStart(ms) - 1
          const cStart   = Math.max(ms, viewStart)
          const cEnd     = Math.min(end, viewEnd)
          const left     = (cStart - viewStart) * dayWidth
          const width    = (cEnd - cStart + 1) * dayWidth
          return (
            <div
              key={ms}
              style={{ position: 'absolute', left, width, height: HEADER_ROW_H }}
              className="flex items-center px-2 border-r border-border text-xs font-semibold text-gray-700 overflow-hidden whitespace-nowrap"
            >
              {width > 40 ? monthYearLabel(ms) : ''}
            </div>
          )
        })}
      </div>

      {/* Week row */}
      {showWeek && (
        <div style={{ height: HEADER_ROW_H, position: 'relative' }} className="bg-surface-50">
          {weeks.map(ws => {
            const cStart = Math.max(ws, viewStart)
            const cEnd   = Math.min(ws + 6, viewEnd)
            const left   = (cStart - viewStart) * dayWidth
            const width  = (cEnd - cStart + 1) * dayWidth
            return (
              <div
                key={ws}
                style={{ position: 'absolute', left, width, height: HEADER_ROW_H }}
                className="flex items-center px-1 border-r border-border/50 text-[11px] text-muted overflow-hidden whitespace-nowrap"
              >
                {width > 20 ? dayOfMonthLabel(ws) : ''}
              </div>
            )
          })}
        </div>
      )}

      {/* Day row */}
      {showDay && (
        <div style={{ height: HEADER_ROW_H, position: 'relative' }} className="bg-surface-50">
          {Array.from({ length: viewEnd - viewStart + 1 }, (_, i) => {
            const d   = viewStart + i
            const wd  = isWeekend(d)
            const sat = isSaturday(d)
            return (
              <div
                key={d}
                style={{
                  position: 'absolute',
                  left:   i * dayWidth,
                  width:  dayWidth,
                  height: HEADER_ROW_H,
                }}
                className={[
                  'flex flex-col items-center justify-center border-r border-border/30 text-[10px] leading-none',
                  wd ? (sat ? 'text-blue-500' : 'text-red-500') : 'text-muted',
                ].join(' ')}
              >
                {dayWidth >= 14 && <span>{dayOfMonthLabel(d)}</span>}
                {dayWidth >= 22 && <span>{weekdayLabel(d).slice(0, 1)}</span>}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-component: Background layer (weekends, holidays, today line)
// ─────────────────────────────────────────────────────────────────────────────

interface BgLayerProps {
  viewStart:   number
  viewEnd:     number
  dayWidth:    number
  holidaySet:  Set<number>
  todayNum:    number
}

function BgLayer({ viewStart, viewEnd, dayWidth, holidaySet, todayNum }: BgLayerProps) {
  const strips = useMemo(() => {
    const out: JSX.Element[] = []
    for (let d = viewStart; d <= viewEnd; d++) {
      if (holidaySet.has(d)) {
        out.push(
          <div key={d} style={{
            position: 'absolute', left: (d - viewStart) * dayWidth, top: 0,
            width: dayWidth, height: '100%', background: HOLIDAY_BG,
          }} />,
        )
      } else if (isWeekend(d)) {
        out.push(
          <div key={d} style={{
            position: 'absolute', left: (d - viewStart) * dayWidth, top: 0,
            width: dayWidth, height: '100%', background: WEEKEND_BG,
          }} />,
        )
      }
    }
    return out
  }, [viewStart, viewEnd, dayWidth, holidaySet])

  return (
    <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'hidden' }}>
      {strips}
      {/* Today line */}
      {todayNum >= viewStart && todayNum <= viewEnd && (
        <div style={{
          position: 'absolute',
          left: (todayNum - viewStart) * dayWidth + dayWidth / 2 - 1,
          top: 0, bottom: 0, width: 2,
          background: TODAY_COLOR, opacity: 0.55,
          zIndex: 6,
        }} />
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-component: WorkItem background band (work-item view)
// ─────────────────────────────────────────────────────────────────────────────

interface WorkItemBandProps {
  color:         string
  wi:            WorkItem
  dayWidth:      number
  viewStart:     number
  viewEnd:       number
  canEdit:       boolean
  onUpdate:      (id: string, patch: { start?: string; end_date?: string; main_start?: string | null }) => void
  onOpenDetail?: () => void
}

function WorkItemBand({ wi, color, dayWidth, viewStart, viewEnd, canEdit, onUpdate, onOpenDetail }: WorkItemBandProps) {
  const startNum   = useMemo(() => dateToNum(wi.start), [wi.start])
  const endNum     = useMemo(() => dateToNum(wi.end_date), [wi.end_date])
  const mainNum    = useMemo(() => wi.main_start ? dateToNum(wi.main_start) : null, [wi.main_start])

  const [live, setLive] = useState({ start: startNum, end: endNum, main: mainNum })
  const dragRef = useRef<{
    edge: 'left' | 'right' | 'body'
    origStart: number; origEnd: number; origMain: number | null
    startX: number; moved: boolean
  } | null>(null)
  const bandRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setLive({ start: startNum, end: endNum, main: mainNum })
  }, [startNum, endNum, mainNum])

  // T-17: clamp to viewport
  const visStart = Math.max(live.start, viewStart)
  const visEnd   = Math.min(live.end,   viewEnd)

  const x    = (visStart - viewStart) * dayWidth
  const w    = Math.max((Math.max(visEnd, visStart) - visStart + 1) * dayWidth, 4)
  const preW = (live.main && live.main > visStart) ? (live.main - visStart) * dayWidth : 0

  function handlePointerDown(e: ReactPointerEvent, edge: 'left' | 'right' | 'body') {
    if (!canEdit) return
    e.stopPropagation()
    e.preventDefault()
    dragRef.current = {
      edge,
      origStart: live.start, origEnd: live.end, origMain: live.main,
      startX: e.clientX, moved: false,
    }
    bandRef.current?.setPointerCapture(e.pointerId)
  }

  function handlePointerMove(e: ReactPointerEvent) {
    if (!dragRef.current) return
    const dx = e.clientX - dragRef.current.startX
    if (Math.abs(dx) > DRAG_THRESHOLD) dragRef.current.moved = true
    const dd = Math.round(dx / dayWidth)
    const { edge, origStart, origEnd, origMain } = dragRef.current

    if (edge === 'body') {
      setLive({ start: origStart + dd, end: origEnd + dd, main: origMain != null ? origMain + dd : null })
    } else if (edge === 'left') {
      setLive(l => ({ ...l, start: Math.min(origStart + dd, origEnd - 1) }))
    } else {
      setLive(l => ({ ...l, end: Math.max(origEnd + dd, origStart + 1) }))
    }
  }

  function handlePointerUp() {
    if (!dragRef.current) return
    const { moved } = dragRef.current
    dragRef.current = null
    if (moved) {
      onUpdate(wi.id, {
        start:      numToStr(live.start),
        end_date:   numToStr(live.end),
        main_start: live.main ? numToStr(live.main) : null,
      })
    }
  }

  return (
    <div
      ref={bandRef}
      data-band="true"
      style={{
        position: 'absolute', left: x,
        top: 1, height: ROW_H - 2, width: w,
        zIndex: 1, display: 'flex',
        cursor: canEdit ? 'grab' : 'default',
      }}
      onPointerDown={e => handlePointerDown(e, 'body')}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={() => {
        dragRef.current = null
        setLive({ start: startNum, end: endNum, main: mainNum })
      }}
      onDoubleClick={onOpenDetail ? (e) => { e.stopPropagation(); onOpenDetail() } : undefined}
    >
      {/* Left resize handle */}
      {canEdit && (
        <div
          style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: HANDLE_W, cursor: 'ew-resize', zIndex: 4 }}
          onPointerDown={e => { e.stopPropagation(); handlePointerDown(e, 'left') }}
        />
      )}

      {/* Pre-study section (hatched) */}
      {live.main && live.main > live.start && (
        <div style={{
          width: preW, height: '100%', flexShrink: 0,
          background: `repeating-linear-gradient(-45deg, transparent, transparent 3px, ${color}55 3px, ${color}55 7px)`,
          border: `1px solid ${color}66`,
          borderRadius: '3px 0 0 3px', borderRight: 'none',
        }} />
      )}

      {/* Main phase (solid fill) */}
      <div style={{
        flex: 1, height: '100%',
        background: `${color}30`,
        border: `1px solid ${color}66`,
        borderRadius: live.main && live.main > live.start ? '0 3px 3px 0' : '3px',
        borderLeft: live.main && live.main > live.start ? `2px solid ${color}aa` : undefined,
      }} />

      {/* Right resize handle */}
      {canEdit && (
        <div
          style={{ position: 'absolute', right: 0, top: 0, bottom: 0, width: HANDLE_W, cursor: 'ew-resize', zIndex: 4 }}
          onPointerDown={e => { e.stopPropagation(); handlePointerDown(e, 'right') }}
        />
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-component: AssignmentBar
// ─────────────────────────────────────────────────────────────────────────────

interface TooltipInfo {
  title: string
  lines: string[]
}

interface AssignmentBarProps {
  assignment:   Assignment
  label:        string
  color:        string
  dayWidth:     number
  viewStart:    number
  viewEnd:      number      // T-17: bars outside this range are clipped
  topOffset?:   number      // px from row top (default BAR_PAD)
  height?:      number      // px (default ROW_H - 2*BAR_PAD)
  isLeave:      boolean
  holidaySet:   Set<number>
  canEdit:      boolean
  hasConflict?: boolean     // §9.3: same person has overlapping work assignments
  preStudyStart?: number | null // §5.6: main_start day of the work item; bars before this get hatched pre-study style
  tooltipInfo?: TooltipInfo
  clampStart?:  number          // E-6: earliest allowed start day for non-Partner live drag preview
  onDragLive?:  (id: string, liveStart: number, liveEnd: number) => void  // T-16: real-time lane recompute
  onDragEnd?:   () => void      // T-16: clear live drag state
  onUpdate:     (id: string, patch: { start: string; end_date: string }, dragKind?: 'move' | 'resize-left' | 'resize-right') => void
  onClick:      (a: Assignment) => void
  onContextMenu?: (a: Assignment, x: number, y: number) => void  // T-12: right-click context menu
  onDoubleClick?: () => void   // T-15: workitem-sub bar dblclick → person highlight
  // T-14: multi-select / bulk-resize
  isSelected?:          boolean
  multiMoveDelta?:      number | null   // follower: both endpoints shift (move)
  multiResizeEndDelta?:   number | null // follower: end shifts (resize-right)
  multiResizeStartDelta?: number | null // follower: start shifts (resize-left)
  onToggleSelect?: (a: Assignment) => void
}

function AssignmentBar({
  assignment, label, color, dayWidth, viewStart, viewEnd,
  topOffset = BAR_PAD,
  height    = ROW_H - 2 * BAR_PAD,
  isLeave, holidaySet, canEdit, hasConflict, preStudyStart, tooltipInfo,
  clampStart, onDragLive, onDragEnd,
  onUpdate, onClick, onContextMenu, onDoubleClick,
  isSelected, multiMoveDelta, multiResizeEndDelta, multiResizeStartDelta, onToggleSelect,
}: AssignmentBarProps) {
  const origStart = useMemo(() => dateToNum(assignment.start),    [assignment.start])
  const origEnd   = useMemo(() => dateToNum(assignment.end_date), [assignment.end_date])

  const [liveStart, setLiveStart] = useState(origStart)
  const [liveEnd,   setLiveEnd]   = useState(origEnd)
  // E-7: hover state drives visual handle emphasis
  const [hovered, setHovered] = useState(false)

  const containerRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{
    kind:         'move' | 'resize-left' | 'resize-right'
    origStart:    number; origEnd: number; startX: number; moved: boolean
    origWorkdays: number
    modKey:       boolean   // T-14: shift/ctrl pressed at drag start
  } | null>(null)

  useEffect(() => { setLiveStart(origStart) }, [origStart])
  useEffect(() => { setLiveEnd(origEnd)     }, [origEnd])

  // React error #300 fix (v2.91): these hooks must run unconditionally on every
  // render of this instance (same key=a.id regardless of viewport) — they were
  // previously declared after the T-17 early return below, so a viewStart/viewEnd
  // change (preset/FY click) could flip the same fiber between calling 9 hooks and
  // 12 hooks across renders, violating the Rules of Hooks.
  const [tipPos,   setTipPos]   = useState<{ x: number; y: number } | null>(null)
  const [dragTip,  setDragTip]  = useState<{ x: number; y: number } | null>(null)
  const isHolidayFn = useCallback((n: number) => holidaySet.has(n), [holidaySet])

  // T-17: skip render entirely if the bar is fully outside the viewport
  if (origEnd < viewStart || origStart > viewEnd) return null

  // T-14: follower bars show offset position during multi-drag / bulk-resize
  const dispStart = multiMoveDelta      != null ? origStart + multiMoveDelta      :
                    multiResizeStartDelta != null ? origStart + multiResizeStartDelta :
                    liveStart
  const dispEnd   = multiMoveDelta    != null ? origEnd + multiMoveDelta    :
                    multiResizeEndDelta != null ? origEnd + multiResizeEndDelta :
                    liveEnd

  // T-17: clamp rendered position to viewport; bar outside range is not drawn
  const renderStart = Math.max(dispStart, viewStart)
  const renderEnd   = Math.min(dispEnd,   viewEnd)

  const x = (renderStart - viewStart) * dayWidth
  const w = Math.max((renderEnd - renderStart + 1) * dayWidth, 3)

  // E-7: overhang container — HANDLE_HIT px hit-zone on each side regardless of bar width;
  //      container widens as needed to guarantee MIN_MOVE_PX of central move zone.
  const HANDLE_HIT  = 8   // px per side (4px inside bar + 4px outside)
  const MIN_MOVE_PX = 8   // minimum central move zone px
  const innerBarOffset = Math.max(
    HANDLE_HIT / 2,
    Math.ceil((MIN_MOVE_PX + 2 * HANDLE_HIT - w) / 2),
  )
  const containerW    = w + 2 * innerBarOffset
  const containerLeft = x - innerBarOffset

  function getKind(posX: number): 'resize-left' | 'resize-right' | 'move' {
    if (!canEdit) return 'move'
    if (posX <= HANDLE_HIT)              return 'resize-left'
    if (posX >= containerW - HANDLE_HIT) return 'resize-right'
    return 'move'
  }

  function onPointerDown(e: ReactPointerEvent) {
    setTipPos(null)
    e.stopPropagation()
    if (!canEdit) return
    if (multiMoveDelta != null || multiResizeEndDelta != null || multiResizeStartDelta != null) return  // T-14: follower during bulk op
    e.preventDefault()
    const rect = e.currentTarget.getBoundingClientRect()
    const posX = e.clientX - rect.left
    const kind = getKind(posX)
    const origWorkdays = isLeave ? workdayCount(liveStart, liveEnd, holidaySet) : 0
    const modKey = e.shiftKey || e.ctrlKey || e.metaKey
    dragRef.current = { kind, origStart: liveStart, origEnd: liveEnd, startX: e.clientX, moved: false, origWorkdays, modKey }
    containerRef.current?.setPointerCapture(e.pointerId)
    // Snap cursor immediately to drag operation
    if (containerRef.current) containerRef.current.style.cursor = kind === 'move' ? 'grabbing' : 'ew-resize'
  }

  function onPointerMove(e: ReactPointerEvent) {
    // Update cursor (imperative — avoids re-render on every mouse move)
    if (canEdit && containerRef.current) {
      if (dragRef.current) {
        containerRef.current.style.cursor = dragRef.current.kind === 'move' ? 'grabbing' : 'ew-resize'
      } else {
        const rect = containerRef.current.getBoundingClientRect()
        containerRef.current.style.cursor = getKind(e.clientX - rect.left) === 'move' ? 'grab' : 'ew-resize'
      }
    }
    // Tooltip tracking during hover (not during drag)
    if (tooltipInfo && !dragRef.current) setTipPos({ x: e.clientX, y: e.clientY })

    if (!dragRef.current) return
    const dx = e.clientX - dragRef.current.startX
    if (Math.abs(dx) > DRAG_THRESHOLD) dragRef.current.moved = true
    const dd = Math.round(dx / dayWidth)
    const { kind, origStart: os, origEnd: oe, origWorkdays } = dragRef.current

    if (kind === 'move') {
      const rawStart = os + dd
      // §5.3 #2: snap leave start to first workday on/after the dragged position
      let newStart = isLeave ? nextWorkday(rawStart - 1, isHolidayFn) : rawStart
      // E-6: real-time clamp — prevent leftward overlap with preceding blocks
      if (clampStart !== undefined && newStart < clampStart) newStart = clampStart
      const newEnd = isLeave && origWorkdays > 0
        ? snapLeaveEnd(newStart, origWorkdays, isHolidayFn)
        : oe + (newStart - os)
      setLiveStart(newStart)
      setLiveEnd(newEnd)
      onDragLive?.(assignment.id, newStart, newEnd)
    } else if (kind === 'resize-left') {
      let rawLeft = os + dd
      if (clampStart !== undefined) rawLeft = Math.max(rawLeft, clampStart)
      const newStart = Math.min(rawLeft, oe)
      setLiveStart(newStart)
      onDragLive?.(assignment.id, newStart, oe)
    } else {
      const newEnd = Math.max(oe + dd, os)
      setLiveEnd(newEnd)
      onDragLive?.(assignment.id, os, newEnd)
    }
    // T-13: update drag-preview tooltip position
    setDragTip({ x: e.clientX, y: e.clientY })
  }

  function onPointerUp() {
    if (!dragRef.current) return
    const moved  = dragRef.current.moved
    const kind   = dragRef.current.kind
    const modKey = dragRef.current.modKey
    dragRef.current = null
    setDragTip(null)
    if (containerRef.current) containerRef.current.style.cursor = canEdit ? 'grab' : 'pointer'
    if (!moved) {
      // T-14: Shift/Ctrl+click → toggle selection; plain click → open edit modal
      if (modKey && onToggleSelect) onToggleSelect(assignment)
      else onClick(assignment)
    } else {
      onUpdate(assignment.id, { start: numToStr(liveStart), end_date: numToStr(liveEnd) }, kind)
    }
    onDragEnd?.()
  }

  function onPointerCancel() {
    dragRef.current = null
    setDragTip(null)
    if (containerRef.current) containerRef.current.style.cursor = canEdit ? 'grab' : 'pointer'
    setLiveStart(origStart)
    setLiveEnd(origEnd)
    onDragEnd?.()
  }

  // Grip visual style (shared for left/right)
  const gripStyle = (side: 'left' | 'right'): React.CSSProperties => ({
    position: 'absolute',
    ...(side === 'left'
      ? { left: innerBarOffset - HANDLE_HIT / 2 }
      : { left: innerBarOffset + w - HANDLE_HIT / 2 }),
    top: '50%', transform: 'translateY(-50%)',
    width:  HANDLE_HIT,
    height: '65%',
    maxHeight: 20,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    pointerEvents: 'none',
  })

  return (
    <>
      {/* E-7: container is wider than the visual bar, providing overhang hit-zones */}
      <div
        ref={containerRef}
        data-assignment-bar="true"
        style={{
          position:   'absolute',
          left:       containerLeft,
          top:        topOffset,
          width:      containerW,
          height,
          zIndex:     10,
          userSelect: 'none',
          cursor:     canEdit ? 'grab' : 'pointer',
          overflow:   'visible',
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onDoubleClick={onDoubleClick ? e => { e.stopPropagation(); onDoubleClick() } : undefined}
        onMouseEnter={e => {
          setHovered(true)
          if (tooltipInfo) setTipPos({ x: e.clientX, y: e.clientY })
        }}
        onMouseLeave={() => { setHovered(false); setTipPos(null) }}
      >
        {/* ── Visual bar (clips fills/labels to bar bounds) ── */}
        <div style={{
          position:     'absolute',
          left:         innerBarOffset,
          top:          0,
          width:        w,
          height:       '100%',
          borderRadius: 4,
          overflow:     'hidden',
          // T-14: selection ring
          boxShadow:    isSelected
            ? '0 0 0 2px #3b82f6, 0 0 0 3.5px rgba(255,255,255,0.85)'
            : '0 1px 2px rgba(0,0,0,0.15)',
          pointerEvents:'none',
        }}>
          {(() => {
            const preStudyPx = (preStudyStart != null && preStudyStart > renderStart)
              ? Math.max(0, Math.min((preStudyStart - renderStart) * dayWidth, w))
              : 0
            const mainPx = w - preStudyPx
            const labelPad = 4  // px from bar edges for text

            return (
              <>
                {/* Pre-study hatched fill */}
                {preStudyPx > 0 && (
                  <div style={{
                    position: 'absolute', left: 0, top: 0, width: preStudyPx, height: '100%',
                    background: `repeating-linear-gradient(-45deg,${color}bb,${color}bb 2px,${color}44 2px,${color}44 5px)`,
                    borderRight: mainPx > 0 ? `1.5px solid ${color}` : 'none',
                  }} />
                )}

                {/* Main phase solid fill */}
                {mainPx > 0 && (
                  <div style={{
                    position: 'absolute', left: preStudyPx, top: 0, right: 0, height: '100%',
                    background: color,
                  }} />
                )}

                {/* Pre-study label */}
                {preStudyPx >= 36 && (
                  <div style={{
                    position: 'absolute',
                    left: labelPad, top: 0, bottom: 0, width: preStudyPx - labelPad,
                    display: 'flex', alignItems: 'center', paddingInline: 3,
                    fontSize: 10, fontStyle: 'italic', fontWeight: 400, color: 'white',
                    overflow: 'hidden', whiteSpace: 'nowrap', zIndex: 1,
                  }}>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>Pre-study</span>
                  </div>
                )}

                {/* Main phase label */}
                {mainPx >= 28 && (
                  <div style={{
                    position: 'absolute',
                    left:  preStudyPx + labelPad,
                    top:   0, bottom: 0, right: labelPad,
                    display: 'flex', alignItems: 'center', paddingInline: 2,
                    fontSize: 11, fontWeight: 500, color: 'white',
                    overflow: 'hidden', whiteSpace: 'nowrap', zIndex: 1,
                  }}>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', flex: 1 }}>{label}</span>
                  </div>
                )}

                {/* §9.3 Conflict indicator */}
                {hasConflict && (
                  <div title="⚠ 중복 배정" style={{
                    position: 'absolute', top: 3, right: 3,
                    width: 7, height: 7, borderRadius: '50%',
                    background: '#f97316', border: '1.5px solid white',
                    zIndex: 20, pointerEvents: 'none',
                  }} />
                )}
                {/* PRD v2.88: Closed leave lock indicator */}
                {isLeave && assignment.status === 'closed' && (
                  <div title="🔒 Closed — 편집 잠금" style={{
                    position: 'absolute', top: 2, left: 3,
                    display: 'flex', alignItems: 'center',
                    zIndex: 20, pointerEvents: 'none',
                    opacity: 0.85,
                  }}>
                    <Lock size={9} color="white" strokeWidth={2.5} />
                  </div>
                )}
              </>
            )
          })()}
        </div>

        {/* ── E-7: Resize grip visuals (centered on bar edges, pointer-events:none) ── */}
        {canEdit && (
          <>
            <div style={gripStyle('left')}>
              <div style={{
                width:      hovered ? 3 : 2,
                height:     '100%',
                background: hovered ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.45)',
                borderRadius: 2,
                boxShadow:  hovered ? '0 0 4px rgba(0,0,0,0.35)' : 'none',
                transition: 'width 0.1s ease, background 0.1s ease',
              }} />
            </div>
            <div style={gripStyle('right')}>
              <div style={{
                width:      hovered ? 3 : 2,
                height:     '100%',
                background: hovered ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.45)',
                borderRadius: 2,
                boxShadow:  hovered ? '0 0 4px rgba(0,0,0,0.35)' : 'none',
                transition: 'width 0.1s ease, background 0.1s ease',
              }} />
            </div>
          </>
        )}
        {/* T-12 v2.90: kebab action button — left-click replaces right-click context menu */}
        {onContextMenu && (hovered || isSelected) && w >= 16 && (
          <button
            style={{
              position: 'absolute',
              right: innerBarOffset,
              top: '50%', transform: 'translateY(-50%)',
              width: 20, height: 20,
              zIndex: 25,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: 'rgba(0,0,0,0.38)',
              borderRadius: 3, border: 'none', cursor: 'pointer',
              color: 'white', fontSize: 13, lineHeight: '1',
              pointerEvents: 'auto',
            }}
            onPointerDown={e => e.stopPropagation()}
            onClick={e => { e.stopPropagation(); onContextMenu(assignment, e.clientX, e.clientY) }}
          >
            ⋯
          </button>
        )}
      </div>

      {/* T-13: Drag-preview tooltip — live dates during move / resize */}
      {dragTip && createPortal(
        <div style={{
          position:     'fixed',
          left:         dragTip.x + 14,
          top:          dragTip.y - 42,
          zIndex:       9999,
          pointerEvents:'none',
          background:   'rgba(15,23,42,0.92)',
          color:        'white',
          borderRadius: 6,
          padding:      '4px 10px',
          fontSize:     12,
          fontWeight:   500,
          lineHeight:   1.5,
          boxShadow:    '0 4px 12px rgba(0,0,0,0.3)',
          whiteSpace:   'nowrap',
        }}>
          {(() => {
            const s = dayOfMonthLabel(liveStart)
            const e = dayOfMonthLabel(liveEnd)
            if (isLeave) {
              const wd = workdayCount(liveStart, liveEnd, holidaySet)
              return `${s} → ${e} · 영업일 ${wd}일`
            }
            const cd = liveEnd - liveStart + 1
            return `${s} → ${e} · ${cd}일`
          })()}
        </div>,
        document.body,
      )}

      {/* Hover tooltip — portal so it renders above all stacking contexts */}
      {tipPos && tooltipInfo && createPortal(
        <div style={{
          position: 'fixed',
          left: tipPos.x + 14,
          top:  tipPos.y - 8,
          zIndex: 9999,
          pointerEvents: 'none',
          background: 'rgba(15,23,42,0.92)',
          color: 'white',
          borderRadius: 6,
          padding: '6px 10px',
          fontSize: 11,
          lineHeight: 1.6,
          boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
          maxWidth: 260,
          whiteSpace: 'pre-wrap',
        }}>
          <div style={{ fontWeight: 600, marginBottom: 2 }}>{tooltipInfo.title}</div>
          {tooltipInfo.lines.map((l, i) => (
            <div key={i} style={{ color: 'rgba(255,255,255,0.8)', fontSize: 10 }}>{l}</div>
          ))}
        </div>,
        document.body,
      )}
    </>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-component: Row label column entry
// ─────────────────────────────────────────────────────────────────────────────

interface RowLabelProps {
  row:              RowData
  color?:           string
  isExpanded?:      boolean
  highlighted?:     boolean
  rowHeight?:       number   // T-16: variable height for multi-lane person rows
  onOpenDetail?:    () => void
  onToggleExpand?:  () => void
  onDoubleClick?:   () => void
}

function RowLabel({ row, color = '#1e40af', isExpanded, highlighted, rowHeight, onToggleExpand, onOpenDetail, onDoubleClick }: RowLabelProps) {
  if (row.kind === 'person') {
    const p = row.person
    return (
      <div
        style={{ height: rowHeight ?? ROW_H, borderLeft: highlighted ? '3px solid #eab308' : '3px solid transparent' }}
        className="flex items-center gap-2 pl-2 pr-3 border-b border-border/50 select-none"
        onDoubleClick={onDoubleClick}
        title={onDoubleClick ? `더블클릭: ${p.name} 하이라이트 토글` : undefined}
      >
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-gray-900 truncate">{p.name}</div>
          <div className="text-[11px] text-muted">{p.rank}</div>
        </div>
      </div>
    )
  }
  if (row.kind === 'workitem') {
    const wi    = row.workItem
    return (
      <div
        style={{ height: ROW_H }}
        className="flex items-center gap-1.5 px-2 border-b border-border/50"
        onDoubleClick={onOpenDetail ? (e) => { e.stopPropagation(); onOpenDetail() } : undefined}
      >
        {/* Expand / collapse toggle */}
        <button
          onClick={e => { e.stopPropagation(); onToggleExpand?.() }}
          onDoubleClick={e => e.stopPropagation()}
          className="flex-shrink-0 w-5 h-5 flex items-center justify-center rounded text-muted hover:text-gray-700 hover:bg-surface-100 transition-colors"
          title={isExpanded ? '접기' : '인원 펼치기'}
        >
          {isExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </button>
        <div style={{ width: 3, height: 22, borderRadius: 2, background: color, flexShrink: 0 }} />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-gray-900 truncate">{wi.name}</div>
          <div className="text-[11px] text-muted">{wi.type}{wi.client ? ` · ${wi.client}` : ''}</div>
        </div>
      </div>
    )
  }
  if (row.kind === 'workitem-sub') {
    const p = row.person
    return (
      <div
        style={{ height: ROW_H, borderLeft: highlighted ? '3px solid #eab308' : '3px solid transparent' }}
        className="flex items-center gap-2 pl-6 pr-3 border-b border-border/30 bg-surface-50/60"
        onDoubleClick={onDoubleClick}
        title={onDoubleClick ? `더블클릭: ${p.name} 하이라이트 토글` : undefined}
      >
        <div style={{ width: 2, height: 16, borderRadius: 1, background: '#cbd5e1', flexShrink: 0 }} />
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium text-gray-700 truncate">{p.name}</div>
          <div className="text-[10px] text-muted">{p.rank}</div>
        </div>
      </div>
    )
  }
  if (row.kind === 'leave-person-sub') {
    const p = row.person
    return (
      <div style={{ height: ROW_H }} className="flex items-center gap-2 pl-8 pr-3 border-b border-border/30 bg-surface-50/60">
        <div style={{ width: 2, height: 16, borderRadius: 1, background: '#10b981', flexShrink: 0 }} />
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium text-gray-700 truncate">{p.name}</div>
          <div className="text-[10px] text-muted">{p.rank}</div>
        </div>
      </div>
    )
  }
  // leave-all — §5.2 T-3: collapsible
  return (
    <div style={{ height: ROW_H }} className="flex items-center gap-1.5 px-2 border-b border-border/50">
      <button
        onClick={e => { e.stopPropagation(); onToggleExpand?.() }}
        className="flex-shrink-0 w-5 h-5 flex items-center justify-center rounded text-muted hover:text-gray-700 hover:bg-surface-100 transition-colors"
        title={isExpanded ? '접기' : '인력별 펼치기'}
      >
        {isExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
      </button>
      <div style={{ width: 3, height: 22, borderRadius: 2, background: '#10b981', flexShrink: 0 }} />
      <span className="text-sm font-medium text-emerald-700">휴가 (전체)</span>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-component: Ghost bar (while drag-creating)
// ─────────────────────────────────────────────────────────────────────────────

function GhostBar({ startNum, endNum, dayWidth, viewStart }: {
  startNum: number; endNum: number; dayWidth: number; viewStart: number
}) {
  const x = (startNum - viewStart) * dayWidth
  const w = Math.max((endNum - startNum + 1) * dayWidth, 3)
  return (
    <div style={{
      position: 'absolute', left: x, top: BAR_PAD, width: w, height: ROW_H - 2 * BAR_PAD,
      background: 'rgba(99,102,241,0.18)',
      border: '2px dashed rgba(99,102,241,0.55)',
      borderRadius: 4, pointerEvents: 'none', zIndex: 8,
    }} />
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-component: AssignmentContextMenu (T-12)
// ─────────────────────────────────────────────────────────────────────────────

interface CtxMenuProps {
  assignment:  Assignment
  x:           number
  y:           number
  workItem?:   WorkItem
  hasEditRole:         boolean   // user has edit permission (ignoring Closed status)
  isClosed:            boolean   // linked work item is Closed, OR leave is status='closed'
  leaveLocked:         boolean   // leave assignment is specifically status='closed'
  canSeeLeave:         boolean   // viewer: only own person; editor+: always
  onClose:             () => void
  onEdit:              () => void
  onDuplicate:         () => void
  onDelete:            () => void
  onDetail:            () => void
  onLeave:             () => void
  onToggleLeaveStatus: () => void
}

function AssignmentContextMenu({
  assignment, x, y,
  hasEditRole, isClosed, leaveLocked, canSeeLeave,
  onClose, onEdit, onDuplicate, onDelete, onDetail, onLeave, onToggleLeaveStatus,
}: CtxMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function onMouseDown(e: MouseEvent) {
      if (!menuRef.current?.contains(e.target as Node)) onClose()
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onMouseDown)
    document.addEventListener('keydown',   onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('keydown',   onKeyDown)
    }
  }, [onClose])

  // Clamp to viewport
  const MENU_W = 196
  const left = Math.min(x + 4, window.innerWidth  - MENU_W - 8)
  const top  = Math.min(y + 4, window.innerHeight - 220)

  const hasDetail    = !!assignment.work_item_id
  const hasViewItems = hasDetail || canSeeLeave
  const hasDivider   = hasEditRole && hasViewItems

  const item = (disabled?: boolean) => [
    'w-full flex items-center gap-2 px-3 py-[5px] text-[13px] text-left rounded transition-colors',
    disabled
      ? 'text-muted cursor-not-allowed opacity-50'
      : 'text-gray-700 hover:bg-surface-100 cursor-pointer',
  ].join(' ')

  const dangerItem = (disabled?: boolean) => [
    item(disabled),
    !disabled ? 'hover:bg-red-50 hover:text-red-700 text-red-600' : '',
  ].join(' ')

  return createPortal(
    <div
      ref={menuRef}
      style={{ position: 'fixed', left, top, zIndex: 9999, minWidth: MENU_W }}
      className="bg-white border border-border rounded-lg shadow-card-md py-1"
      onContextMenu={e => e.preventDefault()}
    >
      {hasEditRole && (
        <>
          <button
            className={item(isClosed)}
            disabled={isClosed}
            title={isClosed ? 'Closed 상태 — 편집 불가' : undefined}
            onClick={isClosed ? undefined : () => { onClose(); onEdit() }}
          >
            <Pencil size={13} /> 편집
            {isClosed && <span className="ml-auto text-[10px] text-muted">Closed</span>}
          </button>
          <button
            className={item(isClosed)}
            disabled={isClosed}
            title={isClosed ? 'Closed 상태 — 복제 불가' : undefined}
            onClick={isClosed ? undefined : () => { onClose(); onDuplicate() }}
          >
            <Copy size={13} /> 복제
          </button>
          <button
            className={dangerItem(isClosed)}
            disabled={isClosed}
            title={isClosed ? 'Closed 상태 — 삭제 불가' : undefined}
            onClick={isClosed ? undefined : () => { onClose(); onDelete() }}
          >
            <Trash2 size={13} /> 삭제
          </button>
          {assignment.kind === 'leave' && (
            <>
              <div className="border-t border-border/50 my-1" />
              <button
                className={item()}
                onClick={() => { onClose(); onToggleLeaveStatus() }}
              >
                {leaveLocked
                  ? <><Unlock size={13} /> Open으로 해제</>
                  : <><Lock   size={13} /> Closed로 잠금</>}
              </button>
            </>
          )}
        </>
      )}

      {hasDivider && <div className="border-t border-border/50 my-1" />}

      {hasDetail && (
        <button
          className={item()}
          onClick={() => { onClose(); onDetail() }}
        >
          <FileText size={13} /> 작업 상세 열기
        </button>
      )}
      {canSeeLeave && (
        <button
          className={item()}
          onClick={() => { onClose(); onLeave() }}
        >
          <CalendarDays size={13} /> 이 사람 휴가 보기
        </button>
      )}
    </div>,
    document.body,
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Legend
// ─────────────────────────────────────────────────────────────────────────────

// Legend is rendered inline below — no constant needed.

// ─────────────────────────────────────────────────────────────────────────────
// Sub-component: PersonChipStrip (§5.2 — drag-to-assign)
// ─────────────────────────────────────────────────────────────────────────────

interface PersonChipStripProps {
  people:              Person[]
  highlightedPersonIds: Set<string>
  onToggleHighlight:   (personId: string) => void
  onClearAll:          () => void
}

function PersonChipStrip({ people, highlightedPersonIds, onToggleHighlight, onClearAll }: PersonChipStripProps) {
  // §5.2 T-7: active + upcoming people by rank; resigned excluded
  const groups = RANKS
    .map(rank => ({
      rank,
      people: people
        .filter(p => p.status !== 'resigned' && p.rank === rank)
        .sort((a, b) => a.name.localeCompare(b.name, 'ko')),
    }))
    .filter(g => g.people.length > 0)

  return (
    <div className="flex-shrink-0 flex flex-wrap items-center gap-x-2 gap-y-1 px-4 py-1.5 border-b border-border bg-blue-50/50">
      <span className="text-[11px] text-blue-700 font-semibold flex-shrink-0 whitespace-nowrap">
        인력 칩 →
      </span>
      {groups.map((g, gi) => (
        <Fragment key={g.rank}>
          {/* Rank group separator (not before first group) */}
          {gi > 0 && (
            <span style={{ width: 1, height: 14, background: '#bfdbfe', display: 'inline-block', flexShrink: 0 }} />
          )}
          {/* Rank label */}
          <span className="text-[10px] font-bold text-blue-400 whitespace-nowrap flex-shrink-0">{g.rank}</span>
          {/* Person chips — T-12: click toggles highlight, drag creates assignment */}
          {g.people.map(p => {
            const lit = highlightedPersonIds.has(p.id)
            return (
              <div
                key={p.id}
                draggable
                onDragStart={e => {
                  e.dataTransfer.setData('text/plain', p.id)
                  e.dataTransfer.effectAllowed = 'copy'
                }}
                onClick={() => onToggleHighlight(p.id)}
                className={[
                  'px-2 py-0.5 rounded-full border text-[11px] font-medium cursor-grab transition-all select-none',
                  lit
                    ? 'bg-yellow-300 border-yellow-400 text-yellow-900 shadow-sm ring-1 ring-yellow-500'
                    : 'bg-white border-blue-200 text-blue-800 hover:bg-blue-50 hover:border-blue-400 hover:shadow-sm',
                ].join(' ')}
                title={`${p.name} (${p.rank}) — 클릭: 선택/해제 · 드래그: 배정 생성`}
              >
                {p.name}
              </div>
            )
          })}
        </Fragment>
      ))}
      {/* T-12: clear-all button when any person is highlighted */}
      {highlightedPersonIds.size > 0 && (
        <button
          onClick={onClearAll}
          className="ml-1 text-[10px] text-blue-500 hover:text-blue-700 underline whitespace-nowrap flex-shrink-0"
        >
          전체 해제
        </button>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-component: FilterBar (§5.2 F-1.8)
// ─────────────────────────────────────────────────────────────────────────────

const RANKS = ['Partner', 'SM', 'M', 'Senior', 'Staff', 'Intern'] as const
const WI_TYPES = ['project', 'proposal', 'pipeline'] as const

type PersonSortBy = 'name' | 'rank'
type WiSortBy     = 'start' | 'name' | 'status' | 'type'

interface FilterBarProps {
  viewMode:      ViewMode
  // person
  personSort:    PersonSortBy; personDir: 'asc' | 'desc'
  showResigned:  boolean;      rankFilter: string[]
  personNameSearch: string
  // workitem
  wiSort:        WiSortBy;     wiDir: 'asc' | 'desc'
  showClosed:    boolean;      typeFilter: string[]
  clientFilter:  string;       hashFilter: string
  nameFilter:    string;       unifiedFilter: string
  // callbacks
  onPersonSort:      (by: PersonSortBy) => void
  onShowResigned:    (v: boolean) => void
  onRankFilter:      (rank: string) => void
  onPersonNameSearch:(v: string) => void
  onWiSort:          (by: WiSortBy) => void
  onShowClosed:      (v: boolean) => void
  onTypeFilter:      (type: string) => void
  onClientFilter:    (v: string) => void
  onHashFilter:      (v: string) => void
  onNameFilter:      (v: string) => void
  onUnifiedFilter:   (v: string) => void
}

function SortBtn({ label, active, dir, onClick }: { label: string; active: boolean; dir: 'asc'|'desc'; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={[
        'inline-flex items-center gap-0.5 px-2 py-0.5 rounded text-[11px] font-medium border transition-colors',
        active
          ? 'bg-brand-600 text-white border-brand-600'
          : 'bg-white text-gray-600 border-border hover:bg-surface-100',
      ].join(' ')}
    >
      {label}
      {active && (dir === 'asc' ? <ChevronUp size={10} /> : <ChevronDown size={10} />)}
    </button>
  )
}

function ChipBtn({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={[
        'px-2 py-0.5 rounded-full text-[11px] font-medium border transition-colors',
        active
          ? 'bg-brand-100 text-brand-700 border-brand-300'
          : 'bg-white text-gray-500 border-border hover:bg-surface-100',
      ].join(' ')}
    >
      {label}
    </button>
  )
}

function FilterBar({
  viewMode,
  personSort, personDir, showResigned, rankFilter, personNameSearch,
  wiSort, wiDir, showClosed, typeFilter, clientFilter, hashFilter, nameFilter, unifiedFilter,
  onPersonSort, onShowResigned, onRankFilter, onPersonNameSearch,
  onWiSort, onShowClosed, onTypeFilter, onClientFilter, onHashFilter, onNameFilter, onUnifiedFilter,
}: FilterBarProps) {
  // §9.3: debounce text-filter inputs (200 ms) so each keystroke doesn't rerender the whole grid
  const [localName,     setLocalName]     = useState(personNameSearch)
  const [localClient,   setLocalClient]   = useState(clientFilter)
  const [localHash,     setLocalHash]     = useState(hashFilter)
  const [localWiName,   setLocalWiName]   = useState(nameFilter)
  const [localUnified,  setLocalUnified]  = useState(unifiedFilter)
  const nameTimer     = useRef<ReturnType<typeof setTimeout>>()
  const clientTimer   = useRef<ReturnType<typeof setTimeout>>()
  const hashTimer     = useRef<ReturnType<typeof setTimeout>>()
  const wiNameTimer   = useRef<ReturnType<typeof setTimeout>>()
  const unifiedTimer  = useRef<ReturnType<typeof setTimeout>>()

  useEffect(() => setLocalName(personNameSearch),  [personNameSearch])
  useEffect(() => setLocalClient(clientFilter),    [clientFilter])
  useEffect(() => setLocalHash(hashFilter),        [hashFilter])
  useEffect(() => setLocalWiName(nameFilter),      [nameFilter])
  useEffect(() => setLocalUnified(unifiedFilter),  [unifiedFilter])

  function handleNameChange(val: string) {
    setLocalName(val)
    clearTimeout(nameTimer.current)
    nameTimer.current = setTimeout(() => onPersonNameSearch(val), 200)
  }
  function handleClientChange(val: string) {
    setLocalClient(val)
    clearTimeout(clientTimer.current)
    clientTimer.current = setTimeout(() => onClientFilter(val), 200)
  }
  function handleHashChange(val: string) {
    setLocalHash(val)
    clearTimeout(hashTimer.current)
    hashTimer.current = setTimeout(() => onHashFilter(val), 200)
  }
  function handleWiNameChange(val: string) {
    setLocalWiName(val)
    clearTimeout(wiNameTimer.current)
    wiNameTimer.current = setTimeout(() => onNameFilter(val), 200)
  }
  function handleUnifiedChange(val: string) {
    setLocalUnified(val)
    clearTimeout(unifiedTimer.current)
    unifiedTimer.current = setTimeout(() => onUnifiedFilter(val), 200)
  }

  return (
    <div className="flex-shrink-0 flex flex-wrap items-center gap-x-4 gap-y-1.5 px-4 py-2 border-b border-border bg-surface-50 text-xs">
      {viewMode === 'person' ? (
        <>
          <div className="flex items-center gap-1">
            <span className="text-muted mr-1">정렬</span>
            <SortBtn label="이름"  active={personSort === 'name'} dir={personDir} onClick={() => onPersonSort('name')} />
            <SortBtn label="직급"  active={personSort === 'rank'} dir={personDir} onClick={() => onPersonSort('rank')} />
          </div>
          <input
            className="input py-0.5 px-2 text-[11px] w-28"
            placeholder="이름 검색…"
            value={localName}
            onChange={e => handleNameChange(e.target.value)}
          />
          <div className="flex items-center gap-1">
            <span className="text-muted mr-1">직급</span>
            {RANKS.map(r => (
              <ChipBtn key={r} label={r} active={rankFilter.includes(r)} onClick={() => onRankFilter(r)} />
            ))}
          </div>
          <label className="flex items-center gap-1.5 cursor-pointer text-gray-600">
            <input
              type="checkbox"
              checked={showResigned}
              onChange={e => onShowResigned(e.target.checked)}
              className="accent-brand-600"
            />
            퇴직자 표시
          </label>
        </>
      ) : (
        <>
          <div className="flex items-center gap-1">
            <span className="text-muted mr-1">정렬</span>
            <SortBtn label="시작일" active={wiSort === 'start'}  dir={wiDir} onClick={() => onWiSort('start')} />
            <SortBtn label="이름"   active={wiSort === 'name'}   dir={wiDir} onClick={() => onWiSort('name')}  />
            <SortBtn label="상태"   active={wiSort === 'status'} dir={wiDir} onClick={() => onWiSort('status')}/>
            <SortBtn label="유형"   active={wiSort === 'type'}   dir={wiDir} onClick={() => onWiSort('type')  }/>
          </div>
          <div className="flex items-center gap-1">
            <span className="text-muted mr-1">유형</span>
            {WI_TYPES.map(t => (
              <ChipBtn key={t} label={t} active={typeFilter.includes(t)} onClick={() => onTypeFilter(t)} />
            ))}
          </div>
          <label className="flex items-center gap-1.5 cursor-pointer text-gray-600">
            <input
              type="checkbox"
              checked={showClosed}
              onChange={e => onShowClosed(e.target.checked)}
              className="accent-brand-600"
            />
            Closed 표시
          </label>
          <input
            className="input py-0.5 px-2 text-[11px] w-28"
            placeholder="Client"
            value={localClient}
            onChange={e => handleClientChange(e.target.value)}
          />
          <input
            className="input py-0.5 px-2 text-[11px] w-28"
            placeholder="#hashtag"
            value={localHash}
            onChange={e => handleHashChange(e.target.value)}
          />
          <input
            className="input py-0.5 px-2 text-[11px] w-28"
            placeholder="프로젝트명"
            value={localWiName}
            onChange={e => handleWiNameChange(e.target.value)}
          />
          <input
            className="input py-0.5 px-2 text-[11px] w-36"
            placeholder="통합검색…"
            value={localUnified}
            onChange={e => handleUnifiedChange(e.target.value)}
          />
        </>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// T-16: greedy lane packing for overlapping assignments (Person view)
// ─────────────────────────────────────────────────────────────────────────────

function packLanes(
  asgns: Assignment[],
): { laneMap: Map<string, number>; laneCount: number } {
  const sorted   = [...asgns].sort((a, b) => a.start.localeCompare(b.start))
  const laneMap  = new Map<string, number>()
  const laneEnds: string[] = []
  for (const a of sorted) {
    let placed = -1
    for (let i = 0; i < laneEnds.length; i++) {
      if (laneEnds[i] < a.start) { placed = i; break }
    }
    if (placed === -1) { placed = laneEnds.length; laneEnds.push('') }
    laneMap.set(a.id, placed)
    laneEnds[placed] = a.end_date
  }
  return { laneMap, laneCount: Math.max(1, laneEnds.length) }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main component: TimelineView
// ─────────────────────────────────────────────────────────────────────────────

export default function TimelineView() {
  const { data: people    = [] } = useAllPeople()
  const { data: workItems = [] } = useAllWorkItems()
  const { data: assignments = [] } = useAllAssignments()
  const { data: holidays  = [] } = useAllHolidays()
  const { data: accruals  = [] } = useAllAccruals() as { data: Accrual[] }
  const { data: settings }       = useSettings()
  const updateAssignment = useUpdateAssignment()
  const deleteAssignment = useDeleteAssignment()
  const updateWorkItem   = useUpdateWorkItem()
  const { canEdit }      = useAuthz()
  const { push }         = useHistory()
  const { myPersonId }   = useAuth()
  const startMonth       = settings?.fiscal_year_start_month ?? 7

  useLayoutEffect(() => {
    function updateLabelW() {
      setLabelW(window.innerWidth < 768 ? 120 : LABEL_W)
    }
    window.addEventListener('resize', updateLabelW)
    return () => window.removeEventListener('resize', updateLabelW)
  }, [])

  const [viewMode,          setViewMode]          = useState<ViewMode>('person')
  const [dayWidth,          setDayWidth]          = useState(calcDefaultDayWidth)
  const [labelW,            setLabelW]            = useState(() => window.innerWidth < 768 ? 120 : LABEL_W)
  const [modal,             setModal]             = useState<ModalState>({ open: false, mode: 'create', prefill: {} })
  const [expandedWorkItems,    setExpandedWorkItems]    = useState<Set<string>>(new Set())
  const [expandedLeave,        setExpandedLeave]        = useState(false)
  const [highlightedPersonIds, setHighlightedPersonIds] = useState<Set<string>>(new Set())
  const [detailWorkItem,    setDetailWorkItem]     = useState<WorkItem | null>(null)
  const [editWorkItem,      setEditWorkItem]       = useState<WorkItem | null>(null)
  // T-17: virtual leave preview toggle
  const [showVirtualLeave, setShowVirtualLeave] = useState(false)

  // T-12: right-click context menu
  const [ctxMenu, setCtxMenu] = useState<{ assignment: Assignment; x: number; y: number } | null>(null)

  // T-14: multi-select
  const [selectedIds,          setSelectedIds]          = useState<Set<string>>(new Set())
  const [multiDragLeaderId,    setMultiDragLeaderId]    = useState<string | null>(null)
  const [multiDragDelta,       setMultiDragDelta]       = useState<number | null>(null)
  // T-14 bulk-resize: live preview deltas (only one is non-null at a time)
  const [multiResizeEndDelta,   setMultiResizeEndDelta]   = useState<number | null>(null)
  const [multiResizeStartDelta, setMultiResizeStartDelta] = useState<number | null>(null)
  // Stable refs for useCallback closures (selectedIds / assignments declared above; peopleMapRef declared after peopleMap)
  const selectedIdsRef  = useRef(selectedIds)
  const assignmentsRef  = useRef(assignments)
  useEffect(() => { selectedIdsRef.current  = selectedIds  }, [selectedIds])
  useEffect(() => { assignmentsRef.current  = assignments  }, [assignments])

  // T-16: live drag position so Partner lane counts recompute in real-time during drag
  const [draggingLive, setDraggingLive] = useState<{ id: string; start: number; end: number } | null>(null)
  const handleDragLive = useCallback((id: string, liveStart: number, liveEnd: number) => {
    const a = assignmentsRef.current.find(x => x.id === id)
    if (!a) return
    // T-16: Partner work bar → trigger live lane recompute
    if (a.kind === 'work' && peopleMapRef.current.get(a.person_id)?.rank === 'Partner') {
      setDraggingLive({ id, start: liveStart, end: liveEnd })
    }
    // T-14: multi-drag/resize delta for follower bars live preview
    if (selectedIdsRef.current.size > 1 && selectedIdsRef.current.has(id)) {
      const aStart = dateToNum(a.start)
      const aEnd   = dateToNum(a.end_date)
      setMultiDragLeaderId(id)
      if (liveStart === aStart && liveEnd !== aEnd) {
        // resize-right: only end moved
        setMultiResizeEndDelta(liveEnd - aEnd)
        setMultiDragDelta(null)
        setMultiResizeStartDelta(null)
      } else if (liveEnd === aEnd && liveStart !== aStart) {
        // resize-left: only start moved
        setMultiResizeStartDelta(liveStart - aStart)
        setMultiDragDelta(null)
        setMultiResizeEndDelta(null)
      } else {
        // move: both endpoints shift together
        setMultiDragDelta(liveStart - aStart)
        setMultiResizeEndDelta(null)
        setMultiResizeStartDelta(null)
      }
    }
  }, [])
  const handleDragEnd = useCallback(() => {
    setDraggingLive(null)
    setMultiDragLeaderId(null)
    setMultiDragDelta(null)
    setMultiResizeEndDelta(null)
    setMultiResizeStartDelta(null)
  }, [])

  // ─── Sort / filter state (§5.2 F-1.8) ────────────────────────────────────
  const [showFilter,   setShowFilter]   = useState(true)   // T-19: open by default
  // Person view
  const [personSort,   setPersonSort]   = useState<'name' | 'rank'>('rank')
  const [personDir,    setPersonDir]    = useState<'asc' | 'desc'>('asc')
  const [showResigned,      setShowResigned]      = useState(false)
  const [rankFilter,        setRankFilter]        = useState<string[]>([])
  const [personNameSearch,  setPersonNameSearch]  = useState('')
  // Work-item view
  const [wiSort,       setWiSort]       = useState<'start' | 'name' | 'status' | 'type'>('start')
  const [wiDir,        setWiDir]        = useState<'asc' | 'desc'>('asc')
  const [showClosed,   setShowClosed]   = useState(false)
  const [typeFilter,   setTypeFilter]   = useState<string[]>([])
  const [clientFilter,  setClientFilter]  = useState('')
  const [hashFilter,    setHashFilter]    = useState('')
  const [nameFilter,    setNameFilter]    = useState('')
  const [unifiedFilter, setUnifiedFilter] = useState('')
  const [fyFilter,      setFyFilter]      = useState<FYFilter>({ mode: 'month' })  // T-16: default '이번 달'

  // Scroll refs
  const labelsBodyRef = useRef<HTMLDivElement>(null)
  const gridBodyRef   = useRef<HTMLDivElement>(null)
  const isSyncingRef  = useRef(false)

  // Lookup maps
  const peopleMap    = useMemo(() => idx(people),    [people])
  const workItemMap  = useMemo(() => idx(workItems), [workItems])
  const colorMap     = useMemo(() => buildWorkItemColorMap(workItems), [workItems])
  // peopleMapRef: stable ref for useCallback closures (must be after peopleMap)
  const peopleMapRef = useRef(peopleMap)
  useEffect(() => { peopleMapRef.current = peopleMap }, [peopleMap])

  const todayNum = useMemo(() => today(), [])

  // Permission helpers
  const globalEdit  = canEdit('global')
  const isWIClosed  = (wi: WorkItem) => (wi.status ?? wi.project_status ?? 'open') === 'closed'
  // Full edit permission: role-based AND item must be open (W-4)
  const canEditWI   = (wi: WorkItem) =>
    !isWIClosed(wi) && (
      wi.type === 'pipeline' ? canEdit('work_item', wi.id) || globalEdit : globalEdit || canEdit('work_item', wi.id)
    )
  // Status-toggle permission: role-based only, does NOT require item to be open
  const canToggleWIStatus = (wi: WorkItem) =>
    wi.type === 'pipeline' ? canEdit('work_item', wi.id) || globalEdit : globalEdit || canEdit('work_item', wi.id)
  // Assignment edit: blocked when leave is Closed (PRD v2.88), or linked work item is Closed (W-5/W-6)
  const canEditAsgn = (a: Assignment) => {
    if (a.kind === 'leave' && a.status === 'closed') return false
    if (a.work_item_id) {
      const wi = workItemMap.get(a.work_item_id)
      if (wi && isWIClosed(wi)) return false
    }
    return globalEdit ||
      canEdit('person', a.person_id) ||
      (a.work_item_id ? canEdit('work_item', a.work_item_id) : false)
  }
  const canEditPipeline = canEdit('global') ||
    workItems.some(w => w.type === 'pipeline' && canEdit('work_item', w.id))

  // View range — T-11: preset/range returns exact window; 'all' = today ±7 months
  const { viewStart, viewEnd } = useMemo(() => {
    const defaultStart = monthStart(addMonths(todayNum, -7))
    const defaultEnd   = nextMonthStart(addMonths(todayNum, 7)) - 1
    const [fyFrom, fyTo] = resolveFYFilter(fyFilter, startMonth)
    if (fyFrom && fyTo) {
      const vs = dateToNum(fyFrom)
      const ve = dateToNum(fyTo)
      // Guard: reject NaN/Infinity or inverted ranges (e.g. from manual range input)
      if (Number.isFinite(vs) && Number.isFinite(ve) && vs <= ve) {
        return { viewStart: vs, viewEnd: ve }
      }
    }
    return { viewStart: defaultStart, viewEnd: defaultEnd }
  }, [todayNum, fyFilter, startMonth])

  // T-11/T-16: auto-zoom + scroll to today whenever the filter preset changes
  useEffect(() => {
    const [from, to] = resolveFYFilter(fyFilter, startMonth)
    if (!from || !to) return
    const rangeStart = dateToNum(from)
    const rangeEnd   = dateToNum(to)
    if (!Number.isFinite(rangeStart) || !Number.isFinite(rangeEnd)) return
    const rangeSpan  = rangeEnd - rangeStart + 1
    if (rangeSpan <= 0) return
    const lW    = window.innerWidth < 768 ? 120 : LABEL_W
    const gridW = Math.max(400, window.innerWidth - lW - 20)
    const newDayW = Math.max(DAY_MIN, Math.min(DAY_MAX, Math.floor(gridW / rangeSpan)))
    setDayWidth(newDayW)
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const el = gridBodyRef.current
      if (!el) return
      const inRange = todayNum >= rangeStart && todayNum <= rangeEnd
      const left = inRange
        ? Math.max(0, (todayNum - rangeStart) * newDayW - el.clientWidth / 2)
        : 0
      el.scrollTo({ left, behavior: 'smooth' })
    }))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fyFilter, startMonth])

  const totalWidth  = (viewEnd - viewStart + 1) * dayWidth
  const headerTiers = dayWidth < ZOOM_WEEK ? 1 : dayWidth < ZOOM_DAY ? 2 : 3
  const headerH     = headerTiers * HEADER_ROW_H

  // Holiday set (with recurring support)
  const holidaySet = useMemo(() => {
    const s = new Set<number>()
    for (const h of holidays) {
      const base = dateToNum(h.date)
      if (!h.recurring) {
        s.add(base)
      } else {
        const bd   = numToDate(base)
        const bMon = bd.getUTCMonth()
        const bDay = bd.getUTCDate()
        const sy   = numToDate(viewStart).getUTCFullYear()
        const ey   = numToDate(viewEnd).getUTCFullYear()
        for (let y = sy; y <= ey; y++) {
          const d = dateToNum(new Date(Date.UTC(y, bMon, bDay)))
          if (d >= viewStart && d <= viewEnd) s.add(d)
        }
      }
    }
    return s
  }, [holidays, viewStart, viewEnd])

  // T-17: per-person virtual leave blocks (only computed when toggle is on & person view)
  const virtualLeaveBlocksMap = useMemo((): Map<string, Array<{ start: number; end: number }>> => {
    if (!showVirtualLeave || viewMode !== 'person') return new Map()
    const isHol = (n: number) => holidaySet.has(n)
    const map   = new Map<string, Array<{ start: number; end: number }>>()
    for (const p of people) {
      const ledger = computeLedger(p.id, {
        workItems,
        assignments,
        accruals,
        isHoliday: isHol,
        today: todayNum,
      })
      const blocks = computeVirtualLeaveBlocks(
        p.id, ledger.projectedRemaining, assignments, todayNum, holidaySet,
      )
      if (blocks.length > 0) map.set(p.id, blocks)
    }
    return map
  }, [showVirtualLeave, viewMode, people, accruals, assignments, workItems, holidaySet, todayNum])

  // Build row list — filtered and sorted (§5.2 F-1.8)
  const rows: RowData[] = useMemo(() => {
    if (viewMode === 'person') {
      const nameQ = personNameSearch.trim().toLowerCase()
      let fp = people
        .filter(p => showResigned || p.status !== 'resigned')
        .filter(p => rankFilter.length === 0 || rankFilter.includes(p.rank))
        .filter(p => !nameQ || p.name.toLowerCase().includes(nameQ))

      fp = [...fp].sort((a, b) => {
        let cmp = 0
        if (personSort === 'name') cmp = a.name.localeCompare(b.name, 'ko')
        if (personSort === 'rank') cmp = (RANK_ORDER[a.rank] ?? 99) - (RANK_ORDER[b.rank] ?? 99)
        return personDir === 'desc' ? -cmp : cmp
      })

      return fp.map(p => ({ kind: 'person' as const, person: p, key: p.id }))
    }

    // viewer: confidential items mask name+client; pipeline items omit description
    const isConf    = (wi: WorkItem) => !!wi.confidential && !globalEdit
    const isPipelineViewer = (wi: WorkItem) => wi.type === 'pipeline' && !globalEdit

    const clientQ  = parseSearchQuery(clientFilter)
    const hashQ    = parseSearchQuery(hashFilter)
    const nameQ2   = parseSearchQuery(nameFilter)
    const unifiedQ = parseSearchQuery(unifiedFilter)

    let fw = workItems.filter(wi => {
      if (!showClosed && (wi.status ?? wi.project_status) === 'closed') return false
      if (typeFilter.length > 0 && !typeFilter.includes(wi.type)) return false
      // Client search — skip match on confidential items (viewer sees null)
      if (clientFilter && !isConf(wi)) {
        if (!clientQ([wi.client ?? ''])) return false
      } else if (clientFilter && isConf(wi)) {
        return false  // masked item can't match a client query
      }
      // Hashtag search
      if (hashFilter && !hashQ(wi.hashtags)) return false
      // Name search
      if (nameFilter && !nameQ2([isConf(wi) ? '' : wi.name])) return false
      // Unified search: OR across name · client · description · hashtags (field visibility respected)
      if (unifiedFilter) {
        const fields: string[] = [
          ...wi.hashtags,
          isConf(wi) ? '' : wi.name,
          isConf(wi) ? '' : (wi.client ?? ''),
          isPipelineViewer(wi) ? '' : (wi.description ?? ''),
        ]
        if (!unifiedQ(fields)) return false
      }
      return true
    })

    fw = [...fw].sort((a, b) => {
      let cmp = 0
      if (wiSort === 'start')  cmp = a.start.localeCompare(b.start)
      if (wiSort === 'name')   cmp = a.name.localeCompare(b.name, 'ko')
      if (wiSort === 'type')   cmp = a.type.localeCompare(b.type)
      if (wiSort === 'status') cmp = (a.status ?? a.project_status ?? '').localeCompare(b.status ?? b.project_status ?? '')
      return wiDir === 'desc' ? -cmp : cmp
    })

    // §5.2 T-3: people with any leave assignments (for leave sub-rows), sorted by rank then name
    const leavePeople = [...new Set(
      assignments.filter(a => a.kind === 'leave').map(a => a.person_id),
    )]
      .map(pid => peopleMap.get(pid))
      .filter((p): p is Person => !!p)
      .sort((a, b) => {
        const ro = (RANK_ORDER[a.rank] ?? 99) - (RANK_ORDER[b.rank] ?? 99)
        return ro !== 0 ? ro : a.name.localeCompare(b.name, 'ko')
      })

    return [
      ...fw.flatMap(wi => {
        const base = [{ kind: 'workitem' as const, workItem: wi, key: wi.id }]
        if (!expandedWorkItems.has(wi.id)) return base
        // §5.2 T-6: unique people with work assignments, sorted by rank then name
        const personIds = [...new Set(
          assignments
            .filter(a => a.work_item_id === wi.id && a.kind === 'work')
            .map(a => a.person_id),
        )]
        const subRows = personIds
          .map(pid => peopleMap.get(pid))
          .filter((p): p is Person => !!p)
          .sort((a, b) => {
            const ro = (RANK_ORDER[a.rank] ?? 99) - (RANK_ORDER[b.rank] ?? 99)
            return ro !== 0 ? ro : a.name.localeCompare(b.name, 'ko')
          })
          .map(p => ({
            kind:     'workitem-sub' as const,
            workItem: wi,
            person:   p,
            key:      `${wi.id}:${p.id}`,
          }))
        return [...base, ...subRows]
      }),
      // §5.2 T-3: leave-all row + optional per-person sub-rows
      { kind: 'leave-all' as const, key: 'leave-all' },
      ...(expandedLeave ? leavePeople.map(p => ({
        kind:   'leave-person-sub' as const,
        person: p,
        key:    `leave:${p.id}`,
      })) : []),
    ]
  }, [
    viewMode, people, workItems, assignments, peopleMap,
    personSort, personDir, showResigned, rankFilter, personNameSearch,
    wiSort, wiDir, showClosed, typeFilter, clientFilter, hashFilter, nameFilter, unifiedFilter,
    expandedWorkItems, expandedLeave,
  ])

  // T-16: lane packing per person row (only in person view)
  const rowLaneData = useMemo(() => {
    const m = new Map<string, { laneMap: Map<string, number>; laneCount: number }>()
    if (viewMode !== 'person') return m
    for (const row of rows) {
      if (row.kind !== 'person') continue
      let rowAsgns = assignments.filter(a => a.person_id === row.person.id)
      // T-16: apply live drag position for Partner rows so lanes recompute in real-time during drag
      if (draggingLive && row.person.rank === 'Partner') {
        rowAsgns = rowAsgns.map(a =>
          a.id === draggingLive.id
            ? { ...a, start: numToStr(draggingLive.start), end_date: numToStr(draggingLive.end) }
            : a
        )
      }
      m.set(row.key, packLanes(rowAsgns))
    }
    return m
  }, [rows, assignments, viewMode, draggingLive])

  const rowHeights = useMemo(
    () => rows.map(row => (rowLaneData.get(row.key)?.laneCount ?? 1) * ROW_H),
    [rows, rowLaneData],
  )

  const rowTops = useMemo(() => {
    const tops: number[] = []
    let acc = 0
    for (const h of rowHeights) { tops.push(acc); acc += h }
    return tops
  }, [rowHeights])

  // Ref kept in sync so RAF callbacks can read the latest rowTops after re-renders
  const rowTopsRef = useRef<number[]>([])
  useEffect(() => { rowTopsRef.current = rowTops }, [rowTops])

  // Scroll sync — vertical only (header X is native via single container)
  function handleGridScroll() {
    if (isSyncingRef.current) return
    isSyncingRef.current = true
    const el = gridBodyRef.current
    if (labelsBodyRef.current) labelsBodyRef.current.scrollTop = el?.scrollTop ?? 0
    isSyncingRef.current = false
  }
  function handleLabelsScroll() {
    if (isSyncingRef.current) return
    isSyncingRef.current = true
    if (gridBodyRef.current) gridBodyRef.current.scrollTop = labelsBodyRef.current?.scrollTop ?? 0
    isSyncingRef.current = false
  }

  // clientX → day number (accounts for grid scroll)
  const clientXToDay = useCallback((clientX: number): number => {
    const rect = gridBodyRef.current?.getBoundingClientRect()
    if (!rect) return viewStart
    const scrollLeft = gridBodyRef.current?.scrollLeft ?? 0
    return viewStart + Math.floor((clientX - rect.left + scrollLeft) / dayWidth)
  }, [viewStart, dayWidth])

  // Scroll to today (+ reset zoom to ~3 months when called from the button)
  function scrollToToday() {
    const newW = calcDefaultDayWidth()
    setDayWidth(newW)   // T-1: reset to ~3-month zoom (no-op on mount since state was already newW)
    requestAnimationFrame(() => {
      const el = gridBodyRef.current
      if (!el) return
      el.scrollTo({ left: Math.max(0, (todayNum - viewStart) * newW - el.clientWidth / 2), behavior: 'smooth' })
    })
  }

  // D-6 / §5.11a: handle navigation state (dashboard drill-down + global search jump)
  // T-16 fix: track last-handled key (not a boolean) so re-navigation to the same/different
  // person via Ctrl+K (same route, no remount) always re-triggers correctly.
  const location = useLocation()
  const navigate = useNavigate()
  const navState = (location.state ?? null) as {
    highlightPersonId?:    string
    openDetailWorkItemId?: string
  } | null
  const lastHandledNavKey = useRef<string>('')
  useEffect(() => {
    const pid = navState?.highlightPersonId ?? ''
    const wid = navState?.openDetailWorkItemId ?? ''

    if (!pid && !wid) {
      // navState was cleared (by us below) → reset key so the next navigation re-triggers
      lastHandledNavKey.current = ''
      return
    }

    const key = `${pid}|${wid}`
    if (key === lastHandledNavKey.current) return  // guard against rows-refetch re-runs
    if (rows.length === 0) return                  // wait for data

    lastHandledNavKey.current = key
    // Clear through React Router so useLocation() updates and dep changes for next navigation
    navigate(location.pathname, { replace: true, state: null })

    if (pid) {
      setHighlightedPersonIds(new Set([pid]))
      setViewMode('person')
      // Double RAF: first frame lets React flush state-update re-renders (setHighlightedPersonIds),
      // second frame reads the fresh rowTopsRef and performs the scroll.
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const el = gridBodyRef.current
        if (!el) return
        const rowIdx = rows.findIndex(r => r.kind === 'person' && r.person.id === pid)
        const freshTop = rowIdx >= 0 ? Math.max(0, rowTopsRef.current[rowIdx] - 60) : undefined
        const leftToday = Math.max(0, (todayNum - viewStart) * dayWidth - el.clientWidth / 2)
        el.scrollTo({ left: leftToday, ...(freshTop !== undefined ? { top: freshTop } : {}), behavior: 'smooth' })
        if (freshTop !== undefined) labelsBodyRef.current?.scrollTo({ top: freshTop, behavior: 'smooth' })
      }))
    }

    if (wid) {
      const wi = workItems.find(w => w.id === wid)
      if (wi) setDetailWorkItem(wi)
    }
  }, [rows, navState?.highlightPersonId, navState?.openDetailWorkItemId])  // eslint-disable-line react-hooks/exhaustive-deps

  // T-14: Escape clears multi-select
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setSelectedIds(new Set())
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  // Modal helpers
  function openCreate(row: RowData, startNum: number, endNum: number) {
    const prefill: ModalState['prefill'] = { startNum, endNum }
    if (row.kind === 'person') {
      prefill.personId = row.person.id
      // §5.3 #5: find the most recent project work-assignment end for this person
      const personWorkEnds = assignments
        .filter(a => a.person_id === row.person.id && a.kind === 'work')
        .map(a => dateToNum(a.end_date))
      if (personWorkEnds.length > 0) {
        prefill.lastProjectEndNum = Math.max(...personWorkEnds)
      }
    }
    if (row.kind === 'workitem')          { prefill.workItemId = row.workItem.id; prefill.kind = 'work' }
    if (row.kind === 'workitem-sub')      { prefill.workItemId = row.workItem.id; prefill.personId = row.person.id; prefill.kind = 'work' }
    if (row.kind === 'leave-all')           prefill.kind       = 'leave'
    if (row.kind === 'leave-person-sub')  { prefill.personId = row.person.id; prefill.kind = 'leave' }
    setModal({ open: true, mode: 'create', prefill })
  }
  function openEdit(a: Assignment) {
    setModal({ open: true, mode: 'edit', prefill: {}, editTarget: a })
  }
  function closeModal() {
    setModal(m => ({ ...m, open: false }))
  }

  function toggleExpand(wiId: string) {
    setExpandedWorkItems(prev => {
      const next = new Set(prev)
      if (next.has(wiId)) next.delete(wiId)
      else next.add(wiId)
      return next
    })
  }

  function handleDropPerson(personId: string, row: RowData) {
    const wi = row.kind === 'workitem' || row.kind === 'workitem-sub' ? row.workItem : null
    if (!wi) return
    setModal({
      open:   true,
      mode:   'create',
      prefill: {
        personId,
        workItemId: wi.id,
        kind:       'work',
        startNum:   dateToNum(wi.start),
        endNum:     dateToNum(wi.end_date),
      },
    })
  }

  // T-12: person highlight toggle (client-only, no DB, no sharing)
  function toggleHighlight(personId: string) {
    setHighlightedPersonIds(prev => {
      const next = new Set(prev)
      if (next.has(personId)) next.delete(personId); else next.add(personId)
      return next
    })
  }
  // T-12/T-14: click on empty grid area clears highlights and multi-selection
  function handleGridBodyClick(e: ReactMouseEvent) {
    if (!(e.target as Element).closest('[data-assignment-bar]')) {
      setHighlightedPersonIds(new Set())
      setSelectedIds(new Set())
    }
  }

  // ─── T-12: Context-menu handlers ─────────────────────────────────────────

  function handleCtxDelete(a: Assignment) {
    if (a.kind === 'leave' && a.status === 'closed') {
      window.alert('Closed 휴가 배정은 삭제할 수 없습니다. 먼저 Open으로 전환하세요.')
      return
    }
    const label = a.kind === 'leave'
      ? `${a.leave_type ?? '휴가'} (${a.start} ~ ${a.end_date})`
      : `배정 (${a.start} ~ ${a.end_date})`
    if (!window.confirm(`삭제하시겠습니까?\n${label}`)) return
    deleteAssignment.mutate(a.id, {
      onSuccess: () => push(makeAssignmentDelete(a)),
    })
  }

  function handleToggleLeaveStatus(a: Assignment) {
    const newStatus: 'open' | 'closed' = a.status === 'closed' ? 'open' : 'closed'
    updateAssignment.mutate({ id: a.id, status: newStatus })
  }

  function handleCtxDuplicate(a: Assignment) {
    const isHol  = (n: number) => holidaySet.has(n)
    const origEnd   = dateToNum(a.end_date)
    const origStart = dateToNum(a.start)
    const duration  = origEnd - origStart

    const newStart = a.kind === 'leave' ? nextWorkday(origEnd, isHol) : origEnd + 1
    const newEnd   = newStart + duration

    setModal({
      open:   true,
      mode:   'create',
      prefill: {
        personId:   a.person_id,
        workItemId: a.work_item_id ?? undefined,
        kind:       a.kind as 'work' | 'leave',
        leaveType:  a.leave_type ?? undefined,
        startNum:   newStart,
        endNum:     newEnd,
      },
    })
  }

  function handleCtxViewLeave(personId: string) {
    setViewMode('person')
    const p = peopleMap.get(personId)
    if (p) setPersonNameSearch(p.name)
    setShowFilter(true)
    // Scroll to today so the person's leave bars are visible
    requestAnimationFrame(() => scrollToToday())
  }

  // ─── T-14: Multi-select handlers ─────────────────────────────────────────

  function handleToggleSelect(a: Assignment) {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(a.id)) next.delete(a.id)
      else next.add(a.id)
      return next
    })
  }

  function handleMultiDragCommit(leaderId: string, leaderPatch: { start: string; end_date: string }) {
    const leader = assignments.find(a => a.id === leaderId)
    if (!leader) return
    const delta = dateToNum(leaderPatch.start) - dateToNum(leader.start)
    if (delta === 0) { setSelectedIds(new Set()); return }
    const isHol = (n: number) => holidaySet.has(n)
    const allPairs: { id: string; oldStart: string; oldEnd: string; newStart: string; newEnd: string }[] = []
    const wiExpItems: { kind: string; work_item_id: string | null | undefined; newStart: string; newEnd: string }[] = []
    for (const selId of selectedIds) {
      const a = assignments.find(x => x.id === selId)
      if (!a || !canEditAsgn(a)) continue
      const origS = dateToNum(a.start)
      const origE = dateToNum(a.end_date)
      let newS: number, newE: number
      if (a.kind === 'leave') {
        const wdCount = Math.max(1, workdayCount(origS, origE, holidaySet))
        newS = nextWorkday(origS + delta - 1, isHol)
        newE = snapLeaveEnd(newS, wdCount, isHol)
      } else {
        newS = origS + delta
        newE = origE + delta
      }
      const p = { start: numToStr(newS), end_date: numToStr(newE) }
      updateAssignment.mutate({ id: selId, ...p })
      allPairs.push({ id: selId, oldStart: a.start, oldEnd: a.end_date, newStart: p.start, newEnd: p.end_date })
      // E-5: collect items for work item expansion check
      wiExpItems.push({ kind: a.kind, work_item_id: a.work_item_id, newStart: p.start, newEnd: p.end_date })
    }
    if (allPairs.length > 0) {
      const asgnEntry = makeAssignmentDrag('다중 배정 이동', allPairs)
      const wiExps = buildWIExpansions(wiExpItems)
      push(wiExps.length ? combine('다중 배정 이동', asgnEntry, ...wiExps) : asgnEntry)
    }
    setSelectedIds(new Set())
  }

  // T-14 bulk resize — commit resize-right or resize-left across all selected bars
  function handleMultiResizeCommit(
    leaderId: string,
    leaderPatch: { start: string; end_date: string },
    dragKind: 'resize-left' | 'resize-right',
  ) {
    const leader = assignments.find(a => a.id === leaderId)
    if (!leader) return
    const isHol = (n: number) => holidaySet.has(n)
    const allPairs: { id: string; oldStart: string; oldEnd: string; newStart: string; newEnd: string }[] = []
    const wiExpItems: { kind: string; work_item_id: string | null | undefined; newStart: string; newEnd: string }[] = []

    if (dragKind === 'resize-right') {
      const endDelta = dateToNum(leaderPatch.end_date) - dateToNum(leader.end_date)
      if (endDelta === 0) { setSelectedIds(new Set()); return }
      for (const selId of selectedIds) {
        const a = assignments.find(x => x.id === selId)
        if (!a || !canEditAsgn(a)) continue
        const origS = dateToNum(a.start)
        const origE = dateToNum(a.end_date)
        // For leave: snap new end to workday; for work: apply delta directly (clamp ≥ start)
        const rawNewE = origE + endDelta
        const newE = a.kind === 'leave'
          ? (endDelta > 0 ? nextWorkday(rawNewE - 1, isHol) : Math.max(origS, rawNewE))
          : Math.max(rawNewE, origS)
        const p = { start: a.start, end_date: numToStr(newE) }
        updateAssignment.mutate({ id: selId, ...p })
        allPairs.push({ id: selId, oldStart: a.start, oldEnd: a.end_date, newStart: a.start, newEnd: p.end_date })
        wiExpItems.push({ kind: a.kind, work_item_id: a.work_item_id, newStart: a.start, newEnd: p.end_date })
      }
    } else {
      const startDelta = dateToNum(leaderPatch.start) - dateToNum(leader.start)
      if (startDelta === 0) { setSelectedIds(new Set()); return }
      for (const selId of selectedIds) {
        const a = assignments.find(x => x.id === selId)
        if (!a || !canEditAsgn(a)) continue
        const origS = dateToNum(a.start)
        const origE = dateToNum(a.end_date)
        const rawNewS = origS + startDelta
        // For leave: snap new start to workday; for work: apply delta directly (clamp ≤ end)
        const newS = a.kind === 'leave'
          ? nextWorkday(rawNewS - 1, isHol)
          : Math.min(rawNewS, origE)
        const p = { start: numToStr(newS), end_date: a.end_date }
        updateAssignment.mutate({ id: selId, ...p })
        allPairs.push({ id: selId, oldStart: a.start, oldEnd: a.end_date, newStart: p.start, newEnd: a.end_date })
        wiExpItems.push({ kind: a.kind, work_item_id: a.work_item_id, newStart: p.start, newEnd: a.end_date })
      }
    }

    if (allPairs.length > 0) {
      const asgnEntry = makeAssignmentDrag('다중 배정 리사이즈', allPairs)
      const wiExps = buildWIExpansions(wiExpItems)
      push(wiExps.length ? combine('다중 배정 리사이즈', asgnEntry, ...wiExps) : asgnEntry)
    }
    setSelectedIds(new Set())
  }

  // Mutation callbacks
  function handleUpdateAssignment(id: string, patch: { start: string; end_date: string }, dragKind?: 'move' | 'resize-left' | 'resize-right') {
    // T-14: intercept multi-drag bulk move
    if (dragKind === 'move' && selectedIds.size > 1 && selectedIds.has(id)) {
      handleMultiDragCommit(id, patch)
      return
    }
    // T-14: intercept bulk resize-right when ALL selected bars share the same end_date
    if (dragKind === 'resize-right' && selectedIds.size > 1 && selectedIds.has(id)) {
      const leader = assignments.find(a => a.id === id)
      if (leader) {
        const allSameEnd = [...selectedIds].every(sid => {
          const a = assignments.find(x => x.id === sid)
          return a && a.end_date === leader.end_date
        })
        if (allSameEnd) { handleMultiResizeCommit(id, patch, 'resize-right'); return }
      }
    }
    // T-14: intercept bulk resize-left when ALL selected bars share the same start date
    if (dragKind === 'resize-left' && selectedIds.size > 1 && selectedIds.has(id)) {
      const leader = assignments.find(a => a.id === id)
      if (leader) {
        const allSameStart = [...selectedIds].every(sid => {
          const a = assignments.find(x => x.id === sid)
          return a && a.start === leader.start
        })
        if (allSameStart) { handleMultiResizeCommit(id, patch, 'resize-left'); return }
      }
    }
    const moved = assignments.find(a => a.id === id)
    if (moved?.kind === 'leave' && moved.status === 'closed') return  // PRD v2.88 defense-in-depth
    if (!moved?.person_id) {
      updateAssignment.mutate({ id, ...patch })
      return
    }

    const newStart = dateToNum(patch.start)
    const newEnd   = dateToNum(patch.end_date)
    const oldStart = dateToNum(moved.start)
    const isHol    = (n: number) => holidaySet.has(n)
    const siblings = assignments.filter(a => a.person_id === moved.person_id && a.id !== id)

    // T-16: Partners' work assignments may overlap freely — skip cascade push and clamp
    const movedPerson = peopleMap.get(moved.person_id)
    if (movedPerson?.rank === 'Partner' && moved.kind === 'work') {
      updateAssignment.mutate({ id, ...patch })
      const asgnEntry = makeAssignmentDrag('배정 이동', [{
        id, oldStart: moved.start, oldEnd: moved.end_date, newStart: patch.start, newEnd: patch.end_date,
      }])
      // E-5: auto-expand work item if assignment goes out of bounds
      const wiExps = buildWIExpansions([{ kind: moved.kind, work_item_id: moved.work_item_id, newStart: patch.start, newEnd: patch.end_date }])
      push(wiExps.length ? combine('배정 이동', asgnEntry, ...wiExps) : asgnEntry)
      return
    }

    // T-16a: Partner leave → only leave siblings participate in conflict checks
    // (Partner work siblings are transparent; leave-leave overlap is still forbidden)
    const effectiveSiblings = (movedPerson?.rank === 'Partner' && moved.kind === 'leave')
      ? siblings.filter(s => s.kind === 'leave')
      : siblings

    // E-4/E-6: downstream-only cascade. Moving right → push following blocks.
    // Moving left → clamp the dragged block against preceding blocks (no leftward push).
    const pushPatches: { id: string; start: string; end_date: string }[] = []
    let effectivePatch = patch

    if (newStart >= oldStart) {
      // Moved right (or resize-right): push overlapping siblings rightward (downstream only)
      let rightEdge = newEnd
      for (const a of [...effectiveSiblings].sort((a, b) => dateToNum(a.start) - dateToNum(b.start))) {
        const aS = dateToNum(a.start), aE = dateToNum(a.end_date)
        if (aE < newStart || aS > rightEdge) continue   // no overlap with cascade zone
        const nS = rightEdge + 1
        const nE = a.kind === 'leave'
          ? snapLeaveEnd(nS, Math.max(1, workdayCount(aS, aE, holidaySet)), isHol)
          : nS + (aE - aS)
        pushPatches.push({ id: a.id, start: numToStr(nS), end_date: numToStr(nE) })
        rightEdge = nE
      }
    } else {
      // E-6: Moved/resized left — clamp against preceding blocks, no leftward cascade.
      // "Preceding" = started before our original position AND now overlaps our new range.
      const preceding = effectiveSiblings.filter(
        a => dateToNum(a.start) < oldStart && dateToNum(a.end_date) >= newStart,
      )
      if (preceding.length > 0) {
        const maxPrecEnd = preceding.reduce((m, a) => Math.max(m, dateToNum(a.end_date)), -1)
        const clampedStart = nextWorkday(maxPrecEnd, isHol)
        if (clampedStart > newStart) {
          effectivePatch = { start: numToStr(clampedStart), end_date: patch.end_date }
        }
      }
      // pushPatches stays empty — no leftward cascade
    }

    // FIX 1 (E-6): block 특별휴가 resize if new workday count exceeds balance
    if (moved.kind === 'leave' && moved.leave_type === '특별휴가' &&
        (dragKind === 'resize-left' || dragKind === 'resize-right')) {
      const newDays = workdayCount(dateToNum(effectivePatch.start), dateToNum(effectivePatch.end_date), holidaySet)
      const oldDays = workdayCount(dateToNum(moved.start), dateToNum(moved.end_date), holidaySet)
      if (newDays > oldDays) {
        const bal = computeSpecialLeaveBalance(moved.person_id, accruals, assignments, holidaySet, id)
        if (newDays > bal) {
          window.alert(`특별휴가 잔여가 부족합니다 (잔여: ${bal}일, 요청: ${newDays}일)`)
          return
        }
      }
    }

    // FIX 2 (E-3a): block overlap for non-Partner ranks.
    // Exclude pushPatches IDs — those siblings are being cascaded out of the way.
    if (movedPerson?.rank !== 'Partner') {
      const pushedIds = new Set(pushPatches.map(p => p.id))
      const nonCascaded = assignments.filter(a => !pushedIds.has(a.id))
      if (hasAssignmentOverlap(moved.person_id, effectivePatch.start, effectivePatch.end_date, nonCascaded, id)) {
        window.alert(`배정 기간이 겹칩니다. ${movedPerson?.name ?? ''}(${movedPerson?.rank})는 중복 배정이 허용되지 않습니다.`)
        return
      }
    }

    // Fire moved block first, then cascade patches
    updateAssignment.mutate({ id, ...effectivePatch })
    for (const p of pushPatches) updateAssignment.mutate(p)

    // Build undo/redo pairs covering the moved block and all cascaded siblings
    const allPairs = [
      { id, oldStart: moved.start, oldEnd: moved.end_date, newStart: effectivePatch.start, newEnd: effectivePatch.end_date },
      ...pushPatches.map(pp => {
        const orig = assignments.find(a => a.id === pp.id)
        return { id: pp.id, oldStart: orig?.start ?? pp.start, oldEnd: orig?.end_date ?? pp.end_date, newStart: pp.start, newEnd: pp.end_date }
      }),
    ]
    // E-5: auto-expand work items for moved + cascaded work assignments
    const asgnEntry = makeAssignmentDrag('배정 이동', allPairs)
    const wiExpItems = [
      { kind: moved.kind, work_item_id: moved.work_item_id, newStart: effectivePatch.start, newEnd: effectivePatch.end_date },
      ...pushPatches.map(pp => {
        const orig = assignments.find(a => a.id === pp.id)
        return { kind: orig?.kind ?? '', work_item_id: orig?.work_item_id, newStart: pp.start, newEnd: pp.end_date }
      }),
    ]
    const wiExps = buildWIExpansions(wiExpItems)
    push(wiExps.length ? combine('배정 이동', asgnEntry, ...wiExps) : asgnEntry)
  }
  function handleUpdateWorkItem(
    id: string,
    patch: { start?: string; end_date?: string; main_start?: string | null },
  ) {
    const wi = workItemMap.get(id)
    updateWorkItem.mutate({ id, ...patch })
    if (wi) push(makeWorkItemUpdate(wi, patch))
  }

  // E-5: compute work item expansion patches for a batch of assignment changes.
  // Returns one entry per affected work item (collapsed to min start / max end).
  // Fires updateWorkItem mutations as a side effect; returns HistoryEntry[] for bundling.
  function buildWIExpansions(
    items: { kind: string; work_item_id: string | null | undefined; newStart: string; newEnd: string }[],
  ): HistoryEntry[] {
    // Collect max end / min start per wiId across all items
    const agg = new Map<string, { minS: string; maxE: string; wi: WorkItem }>()
    for (const item of items) {
      if (item.kind !== 'work' || !item.work_item_id) continue
      const wi = workItemMap.get(item.work_item_id)
      if (!wi || isWIClosed(wi)) continue
      const cur = agg.get(item.work_item_id)
      if (!cur) {
        agg.set(item.work_item_id, { minS: item.newStart, maxE: item.newEnd, wi })
      } else {
        if (dateToNum(item.newStart) < dateToNum(cur.minS)) cur.minS = item.newStart
        if (dateToNum(item.newEnd)   > dateToNum(cur.maxE)) cur.maxE = item.newEnd
      }
    }
    const entries: HistoryEntry[] = []
    for (const [wiId, { minS, maxE, wi }] of agg) {
      const patch: { start?: string; end_date?: string } = {}
      if (dateToNum(maxE) > dateToNum(wi.end_date))  patch.end_date = maxE
      if (dateToNum(minS) < dateToNum(wi.start))     patch.start    = minS
      if (!patch.start && !patch.end_date) continue
      updateWorkItem.mutate({ id: wiId, ...patch })
      entries.push(makeWorkItemUpdate(wi, patch))
    }
    return entries
  }

  // ─── Per-row grid content renderer ────────────────────────────────────────

  function renderRowContent(row: RowData) {
    const canCreate =
      row.kind === 'leave-all'         ? globalEdit :
      row.kind === 'leave-person-sub'  ? globalEdit :
      row.kind === 'person'            ? (globalEdit || canEdit('person', row.person.id)) :
      row.kind === 'workitem'          ? canEditWI(row.workItem) :
      row.kind === 'workitem-sub'      ? canEditWI(row.workItem) :
      false

    // Assignments for this row
    // §5.2 T-3: workitem rows show only the span band (WorkItemBand); per-person bars live in workitem-sub sub-rows only.
    let rowAssignments: Assignment[]
    if (row.kind === 'person') {
      rowAssignments = assignments.filter(a => a.person_id === row.person.id)
    } else if (row.kind === 'workitem') {
      rowAssignments = []
    } else if (row.kind === 'workitem-sub') {
      rowAssignments = assignments.filter(a =>
        a.work_item_id === row.workItem.id &&
        a.person_id    === row.person.id   &&
        a.kind         === 'work',
      )
    } else if (row.kind === 'leave-person-sub') {
      rowAssignments = assignments.filter(a => a.kind === 'leave' && a.person_id === row.person.id)
    } else {
      rowAssignments = assignments.filter(a => a.kind === 'leave')
    }

    return (
      <GridRow
        key={row.key}
        row={row}
        rowAssignments={rowAssignments}
        laneMap={rowLaneData.get(row.key)?.laneMap}
        dayWidth={dayWidth}
        viewStart={viewStart}
        viewEnd={viewEnd}
        canCreate={canCreate}
        globalEdit={globalEdit}
        canEditAsgn={canEditAsgn}
        canEditWI={canEditWI}
        clientXToDay={clientXToDay}
        peopleMap={peopleMap}
        workItemMap={workItemMap}
        colorMap={colorMap}
        holidaySet={holidaySet}
        virtualLeaveBlocks={row.kind === 'person' ? virtualLeaveBlocksMap.get(row.person.id) : undefined}
        onUpdate={handleUpdateAssignment}
        onUpdateWI={handleUpdateWorkItem}
        onOpenCreate={openCreate}
        onOpenEdit={openEdit}
        onDropPerson={handleDropPerson}
        onOpenDetail={row.kind === 'workitem' ? (wi) => setDetailWorkItem(wi) : undefined}
        onDragLive={handleDragLive}
        onDragEnd={handleDragEnd}
        onBarCtxMenu={(a, x, y) => setCtxMenu({ assignment: a, x, y })}
        onPersonDblClick={globalEdit ? toggleHighlight : undefined}
        selectedIds={selectedIds}
        multiDragLeaderId={multiDragLeaderId}
        multiDragDelta={multiDragDelta}
        multiResizeEndDelta={multiResizeEndDelta}
        multiResizeStartDelta={multiResizeStartDelta}
        onToggleSelect={handleToggleSelect}
      />
    )
  }

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col h-full overflow-hidden select-none bg-surface-0">
      {/* ── Controls bar ── */}
      <div className="flex-shrink-0 flex items-center flex-wrap gap-3 px-4 py-2 border-b border-border bg-surface-50">
        {/* View toggle */}
        <div className="flex rounded-md overflow-hidden border border-border">
          <button
            onClick={() => setViewMode('person')}
            className={[
              'flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium transition-colors',
              viewMode === 'person'
                ? 'bg-brand-600 text-white'
                : 'bg-white text-gray-700 hover:bg-surface-100',
            ].join(' ')}
          >
            <Users size={12} /> Person
          </button>
          <button
            onClick={() => setViewMode('workitem')}
            className={[
              'flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium transition-colors',
              viewMode === 'workitem'
                ? 'bg-brand-600 text-white'
                : 'bg-white text-gray-700 hover:bg-surface-100',
            ].join(' ')}
          >
            <Briefcase size={12} /> Work Item
          </button>
        </div>

        {/* Zoom */}
        <div className="flex items-center gap-1.5">
          <button onClick={() => setDayWidth(d => Math.max(DAY_MIN, d - (d > 12 ? 4 : 1)))}
                  className="btn-secondary p-1.5" title="Zoom out">
            <ZoomOut size={13} />
          </button>
          <input
            type="range" min={DAY_MIN} max={DAY_MAX} value={dayWidth}
            onChange={e => setDayWidth(Number(e.target.value))}
            className="w-24 accent-brand-600"
          />
          <button onClick={() => setDayWidth(d => Math.min(DAY_MAX, d + (d >= 12 ? 4 : 1)))}
                  className="btn-secondary p-1.5" title="Zoom in">
            <ZoomIn size={13} />
          </button>
          <span className="text-xs text-muted w-10 text-right">
            {dayWidth < ZOOM_WEEK ? 'Mo' : dayWidth < ZOOM_DAY ? 'Wk' : 'Day'}
          </span>
        </div>

        {/* Today */}
        <button onClick={scrollToToday} className="btn-secondary gap-1.5">
          <Calendar size={13} /> Today
        </button>

        {/* T-17: virtual leave preview toggle (person view only) */}
        {viewMode === 'person' && (
          <button
            onClick={() => setShowVirtualLeave(v => !v)}
            title="잔여 예정 휴가 가상 배정 미리보기"
            className={[
              'btn-secondary gap-1.5 text-xs',
              showVirtualLeave ? 'ring-2 ring-emerald-400 text-emerald-700' : '',
            ].join(' ')}
          >
            <Eye size={13} />
            잔여 예정
          </button>
        )}

        {/* New assignment */}
        {globalEdit && (
          <button
            onClick={() => setModal({ open: true, mode: 'create', prefill: { startNum: todayNum, endNum: todayNum } })}
            className="btn-primary gap-1.5"
          >
            + New
          </button>
        )}

        {/* Filter toggle */}
        <button
          onClick={() => setShowFilter(f => !f)}
          className={['btn-secondary gap-1.5', showFilter ? 'ring-2 ring-brand-400' : ''].join(' ')}
          title="Sort &amp; Filter"
        >
          <SlidersHorizontal size={13} />
          {(viewMode === 'person'
            ? (rankFilter.length > 0 || showResigned || fyFilter.mode !== 'all')
            : (typeFilter.length > 0 || showClosed || clientFilter || hashFilter || nameFilter || unifiedFilter || fyFilter.mode !== 'all')
          ) && <span className="w-1.5 h-1.5 rounded-full bg-brand-500" />}
        </button>

        {/* Legend — Work(파랑/노랑/회색 계열) · Leave(녹색 계열) */}
        <div className="ml-auto flex flex-wrap items-center gap-x-2.5 gap-y-1">
          {/* ── Work 군 — representative first shade of each family ── */}
          <span className="text-[10px] font-bold text-blue-700 uppercase tracking-wide">Work</span>
          {([
            { type: 'project',  label: 'Project'  },
            { type: 'proposal', label: 'Proposal' },
            // Pipeline legend only shown to editor/admin who can see pipeline items
            ...(globalEdit ? [{ type: 'pipeline' as const, label: 'Pipeline' }] : []),
          ] as const).map(l => (
            <span key={l.label} className="flex items-center gap-1 text-[11px] text-muted">
              <span style={{ display: 'inline-block', width: 14, height: 10, borderRadius: 2, background: (TYPE_FAMILY[l.type] ?? TYPE_FAMILY.project)[0] }} />
              {l.label}
            </span>
          ))}
          <span className="flex items-center gap-1 text-[11px] text-muted">
            <span style={{
              display: 'inline-block', width: 14, height: 10, borderRadius: 2,
              background: 'repeating-linear-gradient(-45deg,#bfdbfe,#bfdbfe 2px,#dbeafe 2px,#dbeafe 5px)',
              border: '1px solid #93c5fd',
            }} />
            Pre-study
          </span>

          {/* divider */}
          <span style={{ width: 1, height: 14, background: '#d1d5db', display: 'inline-block', flexShrink: 0 }} />

          {/* ── Leave — single representative swatch (detail colors on bars only) ── */}
          <span className="flex items-center gap-1 text-[11px] text-muted">
            <span style={{ display: 'inline-block', width: 14, height: 10, borderRadius: 2, background: LEAVE_GREEN['지정휴가'] }} />
            Leave
          </span>

          {/* T-17: virtual leave legend */}
          {showVirtualLeave && viewMode === 'person' && (
            <>
              <span style={{ width: 1, height: 14, background: '#d1d5db', display: 'inline-block', flexShrink: 0 }} />
              <span className="flex items-center gap-1 text-[11px] text-emerald-700 font-medium">
                <span style={{
                  display: 'inline-block', width: 14, height: 10, borderRadius: 2,
                  background: 'repeating-linear-gradient(-45deg,rgba(134,239,172,0.6),rgba(134,239,172,0.6) 3px,rgba(220,252,231,0.4),rgba(220,252,231,0.4) 6px)',
                  border: '1.5px dashed rgba(74,222,128,0.8)',
                }} />
                가상 배정
              </span>
            </>
          )}

          {/* divider */}
          <span style={{ width: 1, height: 14, background: '#d1d5db', display: 'inline-block', flexShrink: 0 }} />

          {/* Background markers */}
          <span className="flex items-center gap-1 text-[11px] text-muted">
            <span style={{ display: 'inline-block', width: 14, height: 10, borderRadius: 2, background: WEEKEND_BG, border: '1px solid #e5e7eb' }} />
            Weekend
          </span>
          <span className="flex items-center gap-1 text-[11px] text-muted">
            <span style={{ display: 'inline-block', width: 14, height: 10, borderRadius: 2, background: HOLIDAY_BG }} />
            Holiday
          </span>

          {!globalEdit && (
            <span className="flex items-center gap-1 text-[11px] text-amber-600 font-medium">
              <Info size={11} /> View only
            </span>
          )}
        </div>
      </div>

      {/* ── Person chip palette (T-11/T-12: both views, editor/admin only) ── */}
      {globalEdit && <PersonChipStrip
        people={people}
        highlightedPersonIds={highlightedPersonIds}
        onToggleHighlight={toggleHighlight}
        onClearAll={() => setHighlightedPersonIds(new Set())}
      />}

      {/* ── Filter / Sort panel ── */}
      {showFilter && (
        <>
          <FilterBar
            viewMode={viewMode}
            personSort={personSort}  personDir={personDir}
            showResigned={showResigned}  rankFilter={rankFilter}
            personNameSearch={personNameSearch}
            wiSort={wiSort}          wiDir={wiDir}
            showClosed={showClosed}  typeFilter={typeFilter}
            clientFilter={clientFilter}  hashFilter={hashFilter}
            nameFilter={nameFilter}      unifiedFilter={unifiedFilter}
            onPersonSort={(by) => {
              if (personSort === by) setPersonDir(d => d === 'asc' ? 'desc' : 'asc')
              else { setPersonSort(by); setPersonDir('asc') }
            }}
            onShowResigned={setShowResigned}
            onRankFilter={(r) => setRankFilter(prev =>
              prev.includes(r) ? prev.filter(x => x !== r) : [...prev, r]
            )}
            onPersonNameSearch={setPersonNameSearch}
            onWiSort={(by) => {
              if (wiSort === by) setWiDir(d => d === 'asc' ? 'desc' : 'asc')
              else { setWiSort(by); setWiDir('asc') }
            }}
            onShowClosed={setShowClosed}
            onTypeFilter={(t) => setTypeFilter(prev =>
              prev.includes(t) ? prev.filter(x => x !== t) : [...prev, t]
            )}
            onClientFilter={setClientFilter}
            onHashFilter={setHashFilter}
            onNameFilter={setNameFilter}
            onUnifiedFilter={setUnifiedFilter}
          />
          <div className="flex-shrink-0 flex items-center px-4 py-1.5 border-b border-border bg-surface-50">
            <FYPicker value={fyFilter} onChange={setFyFilter} startMonth={startMonth} />
          </div>
        </>
      )}

      {/* ── Active filter chips (§9.3 — always visible even when filter panel collapsed) ── */}
      {(rankFilter.length > 0 || typeFilter.length > 0 || clientFilter || hashFilter || nameFilter || unifiedFilter) && (
        <div className="flex-shrink-0 flex flex-wrap items-center gap-1.5 px-4 py-1.5 border-b border-amber-200 bg-amber-50/70">
          {rankFilter.map(r => (
            <span key={r} className="inline-flex items-center gap-1 rounded-full bg-white border border-amber-300 text-amber-800 text-[11px] px-2 py-0.5 font-medium">
              직급 {r}
              <button onClick={() => setRankFilter(p => p.filter(x => x !== r))} className="text-amber-500 hover:text-amber-800 leading-none">×</button>
            </span>
          ))}
          {typeFilter.map(t => (
            <span key={t} className="inline-flex items-center gap-1 rounded-full bg-white border border-amber-300 text-amber-800 text-[11px] px-2 py-0.5 font-medium">
              유형 {t}
              <button onClick={() => setTypeFilter(p => p.filter(x => x !== t))} className="text-amber-500 hover:text-amber-800 leading-none">×</button>
            </span>
          ))}
          {clientFilter && (
            <span className="inline-flex items-center gap-1 rounded-full bg-white border border-amber-300 text-amber-800 text-[11px] px-2 py-0.5 font-medium">
              Client: {clientFilter}
              <button onClick={() => setClientFilter('')} className="text-amber-500 hover:text-amber-800 leading-none">×</button>
            </span>
          )}
          {hashFilter && (
            <span className="inline-flex items-center gap-1 rounded-full bg-white border border-amber-300 text-amber-800 text-[11px] px-2 py-0.5 font-medium">
              #{hashFilter}
              <button onClick={() => setHashFilter('')} className="text-amber-500 hover:text-amber-800 leading-none">×</button>
            </span>
          )}
          {nameFilter && (
            <span className="inline-flex items-center gap-1 rounded-full bg-white border border-amber-300 text-amber-800 text-[11px] px-2 py-0.5 font-medium">
              이름: {nameFilter}
              <button onClick={() => setNameFilter('')} className="text-amber-500 hover:text-amber-800 leading-none">×</button>
            </span>
          )}
          {unifiedFilter && (
            <span className="inline-flex items-center gap-1 rounded-full bg-white border border-amber-300 text-amber-800 text-[11px] px-2 py-0.5 font-medium">
              검색: {unifiedFilter}
              <button onClick={() => setUnifiedFilter('')} className="text-amber-500 hover:text-amber-800 leading-none">×</button>
            </span>
          )}
          <button
            onClick={() => { setRankFilter([]); setTypeFilter([]); setClientFilter(''); setHashFilter(''); setNameFilter(''); setUnifiedFilter('') }}
            className="text-[11px] text-muted hover:text-gray-700 ml-1 underline"
          >
            모두 지우기
          </button>
        </div>
      )}

      {/* ── Timeline body ── */}
      <div className="flex flex-1 overflow-hidden">
        {/* Label column */}
        <div style={{ width: labelW }} className="flex-shrink-0 flex flex-col overflow-hidden">
          {/* Corner */}
          <div style={{ height: headerH }} className="flex-shrink-0 border-b border-border bg-surface-100" />
          {/* Labels */}
          <div
            ref={labelsBodyRef}
            className="flex-1 overflow-y-auto overflow-x-hidden"
            onScroll={handleLabelsScroll}
          >
            {rows.map((row, i) => (
              <RowLabel
                key={row.key}
                row={row}
                rowHeight={rowHeights[i]}
                color={row.kind === 'workitem' ? (colorMap.get(row.workItem.id) ?? (TYPE_FAMILY[row.workItem.type]?.[0] ?? '#1e40af')) : undefined}
                isExpanded={
                  (row.kind === 'workitem' && expandedWorkItems.has(row.workItem.id)) ||
                  (row.kind === 'leave-all' && expandedLeave)
                }
                highlighted={
                  globalEdit && row.kind === 'person' && viewMode === 'person'
                    ? highlightedPersonIds.has(row.person.id)
                    : globalEdit && row.kind === 'workitem-sub' && viewMode === 'workitem'
                    ? highlightedPersonIds.has(row.person.id)
                    : undefined
                }
                onToggleExpand={
                  row.kind === 'workitem'  ? () => toggleExpand(row.workItem.id) :
                  row.kind === 'leave-all' ? () => setExpandedLeave(v => !v) :
                  undefined
                }
                onOpenDetail={row.kind === 'workitem' ? () => setDetailWorkItem(row.workItem) : undefined}
                onDoubleClick={
                  globalEdit && row.kind === 'person' && viewMode === 'person'
                    ? () => toggleHighlight(row.person.id)
                    : globalEdit && row.kind === 'workitem-sub' && viewMode === 'workitem'
                    ? () => toggleHighlight(row.person.id)
                    : undefined
                }
              />
            ))}
          </div>
        </div>

        {/* Label column resize handle */}
        <div
          className="flex-shrink-0 w-1 bg-border hover:bg-brand-400 transition-colors cursor-col-resize select-none z-10"
          onPointerDown={e => {
            e.preventDefault()
            const startX = e.clientX
            const startW = labelW
            const handleMove = (ev: PointerEvent) => {
              setLabelW(Math.max(120, Math.min(600, startW + ev.clientX - startX)))
            }
            const handleUp = () => {
              window.removeEventListener('pointermove', handleMove)
              window.removeEventListener('pointerup', handleUp)
            }
            window.addEventListener('pointermove', handleMove)
            window.addEventListener('pointerup', handleUp)
          }}
        />

        {/* Grid panel — single scroll container (T-8: header + body share one scrollLeft) */}
        <TimelineErrorBoundary>
        <div className="flex flex-1 flex-col overflow-hidden">
          <div
            ref={gridBodyRef}
            className="flex-1 overflow-auto"
            onScroll={handleGridScroll}
            onClick={handleGridBodyClick}
          >
            {/* Date header — sticky at top, shares scrollLeft with canvas (T-8) */}
            <div
              style={{ position: 'sticky', top: 0, height: headerH, width: totalWidth, zIndex: 30 }}
              className="border-b border-border bg-surface-50"
            >
              <DateHeader
                viewStart={viewStart} viewEnd={viewEnd}
                dayWidth={dayWidth} totalWidth={totalWidth}
              />
            </div>

            {/* §9.3: empty state when all rows filtered out */}
            {rows.length === 0 && (
              <div className="flex items-center justify-center h-48 text-sm text-muted">
                {viewMode === 'person' ? '조건에 맞는 구성원이 없습니다.' : '조건에 맞는 작업항목이 없습니다.'}
              </div>
            )}
            <div
              style={{
                width: totalWidth,
                minHeight: rowHeights.reduce((s, h) => s + h, 0),
                position: 'relative',
                isolation: 'isolate',  // contain bar z-indices below sticky header (z=30)
              }}
            >
              {/* Background (weekends / holidays / today) */}
              <BgLayer
                viewStart={viewStart} viewEnd={viewEnd}
                dayWidth={dayWidth} holidaySet={holidaySet}
                todayNum={todayNum}
              />

              {/* Row dividers + content */}
              {rows.map((row, i) => (
                <div
                  key={row.key}
                  style={{
                    position: 'absolute', top: rowTops[i], left: 0,
                    width: totalWidth, height: rowHeights[i],
                    borderBottom: '1px solid rgba(0,0,0,0.05)',
                  }}
                >
                  {renderRowContent(row)}
                </div>
              ))}
            </div>
          </div>
        </div>
        </TimelineErrorBoundary>
      </div>

      {/* ── Assignment modal ── */}
      <AssignmentModal
        state={modal}
        people={people}
        workItems={workItems}
        accruals={accruals}
        assignments={assignments}
        canEditPipeline={canEditPipeline}
        onClose={closeModal}
        onWorkItemExpand={(wiId, newStart, newEnd) => {
          // E-5: modal create/edit path — fire expansion and return HistoryEntry for bundling
          const exps = buildWIExpansions([{ kind: 'work', work_item_id: wiId, newStart, newEnd }])
          return exps[0] ?? null
        }}
      />

      {/* ── Work item detail modal (§5.7) ── */}
      {detailWorkItem && (() => {
        const latest = workItems.find(w => w.id === detailWorkItem.id) ?? detailWorkItem
        return (
          <WorkItemDetailModal
            workItem={latest}
            assignments={assignments}
            peopleMap={peopleMap}
            colorMap={colorMap}
            canEdit={canEditWI(latest)}
            canToggleStatus={canToggleWIStatus(latest)}
            onClose={() => setDetailWorkItem(null)}
            onEdit={() => { setDetailWorkItem(null); setEditWorkItem(latest) }}
          />
        )
      })()}

      {/* ── Work item edit modal (opened from detail) ── */}
      {editWorkItem && (
        <WorkItemModal
          workItem={editWorkItem}
          readOnly={!canEditWI(editWorkItem)}
          lockedMessage={
            isWIClosed(editWorkItem) && canToggleWIStatus(editWorkItem)
              ? 'Closed 상태입니다. 상세 화면의 상태 배지를 눌러 Open으로 전환하세요.'
              : undefined
          }
          onClose={() => setEditWorkItem(null)}
        />
      )}

      {/* ── T-12: Assignment right-click context menu ── */}
      {ctxMenu && (() => {
        const a             = ctxMenu.assignment
        const wi            = a.work_item_id ? workItemMap.get(a.work_item_id) : undefined
        const isLeaveLocked = a.kind === 'leave' && a.status === 'closed'
        const closed        = isLeaveLocked || (wi ? isWIClosed(wi) : false)
        // "has edit role" = user has role permission, independent of Closed status
        const hasRole   = globalEdit || canEdit('person', a.person_id) ||
                          (a.work_item_id ? canEdit('work_item', a.work_item_id) : false)
        const seeLeave  = hasRole || a.person_id === myPersonId
        return (
          <AssignmentContextMenu
            assignment={a}
            x={ctxMenu.x}
            y={ctxMenu.y}
            workItem={wi}
            hasEditRole={hasRole}
            isClosed={closed}
            leaveLocked={isLeaveLocked}
            canSeeLeave={seeLeave}
            onClose={() => setCtxMenu(null)}
            onEdit={() => openEdit(a)}
            onDuplicate={() => handleCtxDuplicate(a)}
            onDelete={() => handleCtxDelete(a)}
            onDetail={() => { if (wi) setDetailWorkItem(wi) }}
            onLeave={() => handleCtxViewLeave(a.person_id)}
            onToggleLeaveStatus={() => handleToggleLeaveStatus(a)}
          />
        )
      })()}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-component: GridRow (drag-create + bar rendering per row)
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────

interface GridRowProps {
  row:            RowData
  rowAssignments: Assignment[]
  laneMap?:       Map<string, number>   // T-16: lane index per assignment id
  dayWidth:       number
  viewStart:      number
  viewEnd:        number                // T-17: bar clipping bound
  canCreate:      boolean
  globalEdit:     boolean
  canEditAsgn:    (a: Assignment) => boolean
  canEditWI:      (wi: WorkItem)  => boolean
  clientXToDay:   (clientX: number) => number
  peopleMap:      Map<string, Person>
  workItemMap:    Map<string, WorkItem>
  colorMap:       Map<string, string>
  holidaySet:          Set<number>
  virtualLeaveBlocks?: Array<{ start: number; end: number }>
  onUpdate:       (id: string, patch: { start: string; end_date: string }, dragKind?: 'move' | 'resize-left' | 'resize-right') => void
  onUpdateWI:     (id: string, patch: { start?: string; end_date?: string; main_start?: string | null }) => void
  onOpenCreate:   (row: RowData, startNum: number, endNum: number) => void
  onOpenEdit:     (a: Assignment) => void
  onDropPerson:    (personId: string, row: RowData) => void
  onOpenDetail?:   (wi: WorkItem) => void
  onDragLive?:     (id: string, liveStart: number, liveEnd: number) => void
  onDragEnd?:      () => void
  onBarCtxMenu?:   (a: Assignment, x: number, y: number) => void   // T-12
  onPersonDblClick?: (personId: string) => void   // T-15: workitem-sub person dblclick
  // T-14: multi-select / bulk-resize
  selectedIds?:          Set<string>
  multiDragLeaderId?:    string | null
  multiDragDelta?:       number | null
  multiResizeEndDelta?:   number | null
  multiResizeStartDelta?: number | null
  onToggleSelect?:    (a: Assignment) => void
}

function GridRow({
  row, rowAssignments, laneMap, dayWidth, viewStart, viewEnd,
  canCreate, globalEdit, canEditAsgn, canEditWI, clientXToDay,
  peopleMap, workItemMap, colorMap, holidaySet,
  virtualLeaveBlocks,
  onUpdate, onUpdateWI, onOpenCreate, onOpenEdit, onDropPerson, onOpenDetail,
  onDragLive, onDragEnd, onBarCtxMenu, onPersonDblClick,
  selectedIds, multiDragLeaderId, multiDragDelta, multiResizeEndDelta, multiResizeStartDelta, onToggleSelect,
}: GridRowProps) {
  const rowRef    = useRef<HTMLDivElement>(null)
  const createRef = useRef<{ anchor: number } | null>(null)
  const [ghost,   setGhost] = useState<{ start: number; end: number } | null>(null)

  // §9.3: detect overlapping work assignments for same person (person view only)
  const conflictIds = useMemo(() => {
    if (row.kind !== 'person') return new Set<string>()
    const work = rowAssignments.filter(a => a.kind === 'work')
    const ids  = new Set<string>()
    for (let i = 0; i < work.length; i++) {
      const s1 = dateToNum(work[i].start), e1 = dateToNum(work[i].end_date)
      for (let j = i + 1; j < work.length; j++) {
        const s2 = dateToNum(work[j].start), e2 = dateToNum(work[j].end_date)
        if (s1 <= e2 && s2 <= e1) { ids.add(work[i].id); ids.add(work[j].id) }
      }
    }
    return ids
  }, [row.kind, rowAssignments])

  // E-6 / T-16a: per-assignment earliest allowed start day for live drag clamping.
  // Partner work bars are never clamped (they may overlap freely).
  // Partner leave bars clamp only against other leave siblings (T-16a).
  // Non-Partner bars clamp against all siblings.
  const clampStartFor = useMemo(() => {
    const m = new Map<string, number>()
    if (row.kind !== 'person') return m
    const isPartner = row.person.rank === 'Partner'
    const isHolFn = (n: number) => holidaySet.has(n)
    for (const a of rowAssignments) {
      if (isPartner && a.kind === 'work') continue  // T-16: Partner work bars never clamped
      const aS = dateToNum(a.start)
      // T-16a: for Partner leave, only check preceding leave siblings; work siblings are invisible
      const candidates = (isPartner && a.kind === 'leave')
        ? rowAssignments.filter(b => b.id !== a.id && b.kind === 'leave')
        : rowAssignments.filter(b => b.id !== a.id)
      let maxEnd = -Infinity
      for (const b of candidates) {
        if (dateToNum(b.start) < aS) maxEnd = Math.max(maxEnd, dateToNum(b.end_date))
      }
      if (maxEnd !== -Infinity) m.set(a.id, nextWorkday(maxEnd, isHolFn))
    }
    return m
  }, [row, rowAssignments, holidaySet])

  function startX(e: ReactPointerEvent | ReactMouseEvent) {
    return clientXToDay((e as ReactPointerEvent).clientX ?? (e as ReactMouseEvent).clientX)
  }

  function handlePointerDown(e: ReactPointerEvent) {
    if (!canCreate) return
    if ((e.target as Element).closest('[data-assignment-bar],[data-band]')) return
    e.preventDefault()
    const day = startX(e)
    createRef.current = { anchor: day }
    setGhost({ start: day, end: day })
    rowRef.current?.setPointerCapture(e.pointerId)
  }

  function handlePointerMove(e: ReactPointerEvent) {
    if (!createRef.current) return
    const day = startX(e)
    setGhost({
      start: Math.min(createRef.current.anchor, day),
      end:   Math.max(createRef.current.anchor, day),
    })
  }

  function handlePointerUp(e: ReactPointerEvent) {
    if (!createRef.current) return
    const day = startX(e)
    const s   = Math.min(createRef.current.anchor, day)
    const en  = Math.max(createRef.current.anchor, day)
    createRef.current = null
    setGhost(null)
    onOpenCreate(row, s, en)
  }

  function handleDblClick(e: ReactMouseEvent) {
    if (!canCreate) return
    if ((e.target as Element).closest('[data-assignment-bar],[data-band]')) return
    const day = clientXToDay(e.clientX)
    onOpenCreate(row, day, day)
  }

  // Bar label — full name; CSS handles ellipsis for narrow bars (§5.2 §1)
  function barLabel(a: Assignment): string {
    if (row.kind === 'person') {
      if (a.kind === 'leave') return a.leave_type ?? 'Leave'
      const wi = workItemMap.get(a.work_item_id ?? '')
      if (!wi) return '—'
      return wi.client ? `[${wi.client}] ${wi.name}` : wi.name
    }
    if (row.kind === 'workitem-sub') {
      const p = peopleMap.get(a.person_id)
      return p?.name ?? '—'
    }
    // leave-person-sub: row already identifies the person; show leave type on the bar
    if (row.kind === 'leave-person-sub') return a.leave_type ?? 'Leave'
    // workitem or leave-all: show who the bar belongs to
    const p = peopleMap.get(a.person_id)
    return p?.name ?? '—'
  }

  // §5.6: compute pre-study boundary (main_start day) for a work assignment
  function getPreStudyStart(a: Assignment): number | null {
    if (a.kind !== 'work') return null
    const wi = workItemMap.get(a.work_item_id ?? '')
    if (!wi || wi.type !== 'project' || !wi.main_start) return null
    return dateToNum(wi.main_start)
  }

  // Hover tooltip content (§5.2 §2 + §9.3 conflict warning + §5.6 pre-study)
  function barTooltip(a: Assignment): TooltipInfo {
    const wi        = workItemMap.get(a.work_item_id ?? '')
    const p         = peopleMap.get(a.person_id)
    const dateRange = `${a.start}  →  ${a.end_date}`
    const isConf    = !!wi?.confidential && !globalEdit
    const wiName    = isConf ? '(비공개)' : (wi?.name ?? '—')
    const client    = isConf ? null : wi?.client
    const conflictLine  = conflictIds.has(a.id) ? '⚠ 중복 배정 주의' : ''

    // §5.6: pre-study overlap
    const preStudyBound = getPreStudyStart(a)
    const aStart        = dateToNum(a.start)
    const preStudyLine  = (preStudyBound != null && aStart < preStudyBound) ? '◈ Pre-study 구간 포함' : ''

    if (a.kind === 'leave') {
      return {
        title: a.leave_type ?? 'Leave',
        lines: [
          p ? `대상: ${p.name}` : '',
          dateRange,
          a.status === 'closed' ? '🔒 Closed — 편집·삭제 잠금' : '',
        ].filter(Boolean),
      }
    }
    if (row.kind === 'person') {
      return {
        title: wiName,
        lines: [
          client ? `고객사: ${client}` : '',
          dateRange,
          preStudyLine,
          conflictLine,
        ].filter(Boolean),
      }
    }
    // workitem, workitem-sub
    return {
      title: p?.name ?? '—',
      lines: [
        wiName + (client ? ` · ${client}` : ''),
        dateRange,
        preStudyLine,
        conflictLine,
      ].filter(Boolean),
    }
  }

  // Drag-and-drop handlers (chip → workitem row)
  function handleDragOver(e: ReactDragEvent) {
    if (row.kind !== 'workitem' && row.kind !== 'workitem-sub') return
    if (!canCreate) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }

  function handleDrop(e: ReactDragEvent) {
    if (row.kind !== 'workitem' && row.kind !== 'workitem-sub') return
    if (!canCreate) return
    e.preventDefault()
    const personId = e.dataTransfer.getData('text/plain')
    if (personId) onDropPerson(personId, row)
  }

  return (
    <div
      ref={rowRef}
      style={{ position: 'absolute', inset: 0, cursor: canCreate ? 'crosshair' : 'default' }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onDoubleClick={handleDblClick}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {/* Work item band (only in workitem view) */}
      {row.kind === 'workitem' && (
        <WorkItemBand
          wi={row.workItem}
          color={colorMap.get(row.workItem.id) ?? (TYPE_FAMILY[row.workItem.type]?.[0] ?? '#1e40af')}
          dayWidth={dayWidth}
          viewStart={viewStart}
          viewEnd={viewEnd}
          canEdit={canEditWI(row.workItem)}
          onUpdate={onUpdateWI}
          onOpenDetail={onOpenDetail ? () => onOpenDetail(row.workItem) : undefined}
        />
      )}

      {/* T-17: virtual leave preview blocks — behind real bars (z=3) */}
      {virtualLeaveBlocks && virtualLeaveBlocks.map((blk, i) => {
        const clampedStart = Math.max(blk.start, viewStart)
        const clampedEnd   = Math.min(blk.end,   viewEnd)
        if (clampedEnd < clampedStart) return null
        const left  = (clampedStart - viewStart) * dayWidth
        const width = (clampedEnd - clampedStart + 1) * dayWidth
        return (
          <div
            key={`vl-${i}`}
            title="가상 배정 (잔여 예정 휴가)"
            style={{
              position:      'absolute',
              left:          Math.max(0, left),
              width:         Math.max(2, width),
              top:           BAR_PAD,
              height:        ROW_H - BAR_PAD * 2,
              borderRadius:  3,
              background:    'repeating-linear-gradient(-45deg,rgba(134,239,172,0.55),rgba(134,239,172,0.55) 3px,rgba(220,252,231,0.35),rgba(220,252,231,0.35) 6px)',
              border:        '1.5px dashed rgba(74,222,128,0.8)',
              boxSizing:     'border-box',
              pointerEvents: 'none',
              zIndex:        3,
            }}
          />
        )
      })}

      {/* Ghost bar while drag-creating */}
      {ghost && (
        <GhostBar
          startNum={ghost.start} endNum={ghost.end}
          dayWidth={dayWidth} viewStart={viewStart}
        />
      )}

      {/* Assignment bars */}
      {rowAssignments.map(a => {
        const lane       = laneMap?.get(a.id) ?? 0
        const wi         = workItemMap.get(a.work_item_id ?? '')
        const color      = barColorOf(wi, a.kind, a.leave_type, colorMap)
        const isSelected = selectedIds?.has(a.id) ?? false
        const isLeader   = a.id === multiDragLeaderId
        // T-16: Partners' work bars get onDragLive for lane recompute; T-14: selected bars get it for multi-drag delta
        const needsDragLive =
          (row.kind === 'person' && row.person.rank === 'Partner' && a.kind === 'work') ||
          (isSelected && (selectedIds?.size ?? 0) > 1)
        return (
          <AssignmentBar
            key={a.id}
            assignment={a}
            label={barLabel(a)}
            color={color}
            dayWidth={dayWidth}
            viewStart={viewStart}
            viewEnd={viewEnd}
            topOffset={lane * ROW_H + BAR_PAD}
            isLeave={a.kind === 'leave'}
            holidaySet={holidaySet}
            canEdit={canEditAsgn(a)}
            hasConflict={conflictIds.has(a.id)}
            preStudyStart={getPreStudyStart(a)}
            tooltipInfo={barTooltip(a)}
            clampStart={clampStartFor.get(a.id)}
            onDragLive={needsDragLive ? onDragLive : undefined}
            onDragEnd={needsDragLive ? onDragEnd : undefined}
            onUpdate={onUpdate}
            onClick={onOpenEdit}
            onContextMenu={onBarCtxMenu}
            onDoubleClick={row.kind === 'workitem-sub' && onPersonDblClick ? () => onPersonDblClick(row.person.id) : undefined}
            isSelected={isSelected}
            multiMoveDelta={isSelected && !isLeader ? multiDragDelta : null}
            multiResizeEndDelta={isSelected && !isLeader ? multiResizeEndDelta : null}
            multiResizeStartDelta={isSelected && !isLeader ? multiResizeStartDelta : null}
            onToggleSelect={onToggleSelect}
          />
        )
      })}

      {/* Weekend / holiday work markers — absolute calendar position.
          Rendered as siblings of AssignmentBar (NOT children), so they
          stay fixed to the day column and do NOT move when the bar is dragged.
          Each marker is a rotated square (diamond) centred on its day. */}
      {rowAssignments.flatMap(a => {
        const lane = laneMap?.get(a.id) ?? 0
        return (a.weekend_dates ?? []).map(dateStr => {
          const dayNum = dateToNum(dateStr)
          const cx     = (dayNum - viewStart) * dayWidth + dayWidth / 2
          const SIZE   = Math.min(8, Math.max(5, dayWidth * 0.4))
          return (
            <div
              key={`wm-${a.id}-${dateStr}`}
              title={`주말/휴일 실근무: ${dateStr}`}
              style={{
                position:     'absolute',
                left:         cx - SIZE / 2,
                top:          lane * ROW_H + ROW_H / 2 - SIZE / 2,
                width:        SIZE,
                height:       SIZE,
                background:   '#f59e0b',
                transform:    'rotate(45deg)',
                borderRadius: 1,
                pointerEvents:'none',
                zIndex:       12,    // above bars (z=10)
                boxShadow:    '0 0 0 1.5px #fff',
              }}
            />
          )
        })
      })}
    </div>
  )
}
