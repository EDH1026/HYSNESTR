/**
 * FYPicker — compact fiscal-year / date-range selector.
 * Shows preset quick-picks (T-11), FY buttons, and custom date-range.
 */
import {
  numToStr, fyOf, fyRange, today,
  weekStart, monthStart, nextMonthStart, addMonths, yearMonth,
} from '@/lib/date'

export interface FYFilter {
  mode:    'all' | 'fy' | 'range' | 'week' | 'month' | 'quarter'
  fyYear?: number   // mode='fy'
  from?:   string   // mode='range', YYYY-MM-DD
  to?:     string   // mode='range', YYYY-MM-DD
}

/** Resolves a FYFilter to inclusive YYYY-MM-DD strings, or [undefined, undefined] for 'all'. */
export function resolveFYFilter(
  f: FYFilter,
  startMonth: number,
): [string | undefined, string | undefined] {
  if (f.mode === 'fy' && f.fyYear != null) {
    const [s, e] = fyRange(f.fyYear, startMonth)
    return [numToStr(s), numToStr(e)]
  }
  if (f.mode === 'range') return [f.from, f.to]
  if (f.mode === 'week') {
    const t = today()
    return [numToStr(weekStart(t)), numToStr(weekStart(t) + 6)]
  }
  if (f.mode === 'month') {
    const t = today()
    return [numToStr(monthStart(t)), numToStr(nextMonthStart(t) - 1)]
  }
  if (f.mode === 'quarter') {
    const t      = today()
    const fyYear = fyOf(t, startMonth)
    const [fyS]  = fyRange(fyYear, startMonth)
    const mo     = yearMonth(t).month
    const offset = (mo - startMonth + 12) % 12
    const qIdx   = Math.floor(offset / 3)
    const qStart = addMonths(fyS, qIdx * 3)
    const qEnd   = nextMonthStart(addMonths(qStart, 2)) - 1
    return [numToStr(qStart), numToStr(qEnd)]
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
  // T-7-TEMP: FY09~FY28 전체 목록 (초기 데이터 셋업용)
  const fyYears = Array.from({ length: 20 }, (_, i) => 2009 + i)

  const base    = 'px-2.5 py-1 text-xs font-medium rounded border transition-colors'
  const on      = 'bg-brand-600 text-white border-brand-600'
  const off     = 'bg-white text-gray-700 border-border hover:bg-surface-50'

  // T-11: preset helper — clicking an active preset deactivates it (→ 'all')
  function togglePreset(next: FYFilter) {
    const alreadyActive =
      next.mode === 'fy'
        ? value.mode === 'fy' && value.fyYear === next.fyYear
        : value.mode === next.mode
    onChange(alreadyActive ? { mode: 'all' } : next)
  }

  const isFYActive = value.mode === 'fy' && value.fyYear === curFY

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
      <button className={`${base} ${isFYActive ? on : off}`}
        onClick={() => togglePreset({ mode: 'fy', fyYear: curFY })}>이번 FY</button>

      {/* Divider */}
      <span style={{ width: 1, height: 16, background: '#d1d5db', display: 'inline-block', flexShrink: 0, marginInline: 2 }} />

      <button className={`${base} ${value.mode === 'all' ? on : off}`}
        onClick={() => onChange({ mode: 'all' })}>전체</button>

      {fyYears.map(fy => (
        <button key={fy}
          className={`${base} ${value.mode === 'fy' && value.fyYear === fy ? on : off}`}
          onClick={() => onChange({ mode: 'fy', fyYear: fy })}>
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
