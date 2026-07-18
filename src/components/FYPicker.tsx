/**
 * FYPicker — compact fiscal-year / date-range selector.
 * Shows preset quick-picks (T-11), FY buttons (FY22–28, multi-select), and custom date-range.
 *
 * T-7-TEMP reverted: FY22~FY28 only. '전체' button removed.
 * T-11: each preset auto-fits the exact range (no extra padding added by caller).
 */
import {
  numToStr, fyOf, fyRange, today,
  weekStart, monthStart, nextMonthStart, addMonths, yearMonth,
} from '@/lib/date'

export interface FYFilter {
  mode:     'all' | 'fy' | 'range' | 'week' | 'month' | 'quarter'
  fyYears?: number[]  // mode='fy': selected FY end-years; display range = min→max
  from?:    string    // mode='range', YYYY-MM-DD
  to?:      string    // mode='range', YYYY-MM-DD
}

/**
 * Resolves a FYFilter to inclusive YYYY-MM-DD [from, to] strings.
 * Returns [undefined, undefined] for 'all' (no filter).
 *
 * T-11: each preset returns the FULL display range (no padding needed at call site):
 *   week    → 3 weeks  (prev Mon … next Sun)
 *   month   → 3 months (prev month start … next month end)
 *   quarter → 3 quarters (prev Q start … next Q end); boundaries follow fiscal year
 *   fy      → exact FY; multi-FY = min FY start … max FY end
 *   range   → as typed
 */
export function resolveFYFilter(
  f:          FYFilter,
  startMonth: number,
): [string | undefined, string | undefined] {
  if (f.mode === 'fy' && f.fyYears && f.fyYears.length > 0) {
    const sorted = [...f.fyYears].sort((a, b) => a - b)
    const [s]   = fyRange(sorted[0], startMonth)
    const [, e] = fyRange(sorted[sorted.length - 1], startMonth)
    return [numToStr(s), numToStr(e)]
  }
  if (f.mode === 'range') return [f.from, f.to]
  if (f.mode === 'week') {
    const ws = weekStart(today())
    return [numToStr(ws - 7), numToStr(ws + 13)]   // Mon of prev week … Sun of next week
  }
  if (f.mode === 'month') {
    const t = today()
    return [
      numToStr(monthStart(addMonths(t, -1))),
      numToStr(nextMonthStart(addMonths(t, 1)) - 1),
    ]
  }
  if (f.mode === 'quarter') {
    const t      = today()
    const fyYear = fyOf(t, startMonth)
    const [fyS]  = fyRange(fyYear, startMonth)
    const mo     = yearMonth(t).month
    const offset = (mo - startMonth + 12) % 12
    const qIdx   = Math.floor(offset / 3)
    const qStart = addMonths(fyS, qIdx * 3)
    // 3 quarters: prev + current + next
    const prevQS = addMonths(qStart, -3)
    const nextQE = addMonths(qStart, 6) - 1   // last day of next quarter
    return [numToStr(prevQS), numToStr(nextQE)]
  }
  return [undefined, undefined]
}

interface Props {
  value:      FYFilter
  onChange:   (v: FYFilter) => void
  startMonth: number
}

export default function FYPicker({ value, onChange, startMonth }: Props) {
  const curFY   = fyOf(today(), startMonth)
  // T-7: FY22~FY28 only (T-7-TEMP FY09~FY28 reverted)
  const fyYears = Array.from({ length: 7 }, (_, i) => 2022 + i)

  const base = 'px-2.5 py-1 text-xs font-medium rounded border transition-colors'
  const on   = 'bg-brand-600 text-white border-brand-600'
  const off  = 'bg-white text-gray-700 border-border hover:bg-surface-50'

  // Toggle a single-FY preset (week/month/quarter/이번FY); clicking active → deactivate ('all')
  function togglePreset(next: FYFilter) {
    const alreadyActive =
      next.mode === 'fy'
        ? value.mode === 'fy' && (value.fyYears ?? []).length === 1 && value.fyYears![0] === next.fyYears?.[0]
        : value.mode === next.mode
    onChange(alreadyActive ? { mode: 'all' } : next)
  }

  // Multi-select toggle for individual FY year buttons
  function toggleFY(fy: number) {
    if (value.mode === 'fy') {
      const prev = value.fyYears ?? []
      if (prev.includes(fy)) {
        const remaining = prev.filter(y => y !== fy)
        onChange(remaining.length === 0 ? { mode: 'all' } : { mode: 'fy', fyYears: remaining })
      } else {
        onChange({ mode: 'fy', fyYears: [...prev, fy] })
      }
    } else {
      onChange({ mode: 'fy', fyYears: [fy] })
    }
  }

  // '이번 FY' button is active only when exactly [curFY] is selected
  const isThisFYOnly = value.mode === 'fy' &&
    (value.fyYears ?? []).length === 1 &&
    value.fyYears![0] === curFY

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-xs text-muted font-medium mr-0.5">기간</span>

      {/* T-11: one-click period presets */}
      <button className={`${base} ${value.mode === 'week'    ? on : off}`}
        onClick={() => togglePreset({ mode: 'week' })}>이번 주</button>
      <button className={`${base} ${value.mode === 'month'   ? on : off}`}
        onClick={() => togglePreset({ mode: 'month' })}>이번 달</button>
      <button className={`${base} ${value.mode === 'quarter' ? on : off}`}
        onClick={() => togglePreset({ mode: 'quarter' })}>이번 분기</button>
      <button className={`${base} ${isThisFYOnly ? on : off}`}
        onClick={() => togglePreset({ mode: 'fy', fyYears: [curFY] })}>이번 FY</button>

      {/* Divider */}
      <span style={{ width: 1, height: 16, background: '#d1d5db', display: 'inline-block', flexShrink: 0, marginInline: 2 }} />

      {/* T-7: FY22~FY28 multi-select (no '전체' button) */}
      {fyYears.map(fy => (
        <button key={fy}
          className={`${base} ${value.mode === 'fy' && (value.fyYears ?? []).includes(fy) ? on : off}`}
          onClick={() => toggleFY(fy)}>
          FY{String(fy).slice(-2)}
        </button>
      ))}

      <button className={`${base} ${value.mode === 'range' ? on : off}`}
        onClick={() => onChange({ mode: 'range', from: value.from ?? '', to: value.to ?? '' })}>
        직접 입력
      </button>

      {value.mode === 'range' && (
        <>
          <input type="date" className="input py-0.5 text-xs w-36"
            value={value.from ?? ''}
            onChange={e => onChange({ ...value, from: e.target.value })} />
          <span className="text-xs text-muted">~</span>
          <input type="date" className="input py-0.5 text-xs w-36"
            value={value.to ?? ''}
            onChange={e => onChange({ ...value, to: e.target.value })} />
        </>
      )}
    </div>
  )
}
