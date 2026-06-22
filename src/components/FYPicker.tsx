/**
 * FYPicker — compact fiscal-year / date-range selector.
 * Shows 전체, FY(current-1..current+1), and custom date-range buttons.
 */
import { numToStr, fyOf, fyRange, today } from '@/lib/date'

export interface FYFilter {
  mode:    'all' | 'fy' | 'range'
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
  return [undefined, undefined]
}

interface Props {
  value:      FYFilter
  onChange:   (v: FYFilter) => void
  startMonth: number
}

export default function FYPicker({ value, onChange, startMonth }: Props) {
  const curFY   = fyOf(today(), startMonth)
  const fyYears = [curFY - 1, curFY, curFY + 1]

  const base    = 'px-2.5 py-1 text-xs font-medium rounded border transition-colors'
  const on      = 'bg-brand-600 text-white border-brand-600'
  const off     = 'bg-white text-gray-700 border-border hover:bg-surface-50'

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-xs text-muted font-medium mr-0.5">기간</span>

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
