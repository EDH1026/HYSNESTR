/**
 * MePage — viewer 전용 본인 화면 (내 CV + 내 휴가)
 *
 * - 인력 연결은 profiles.person_id 직접 참조 (PRD v2.5 §6.2; Admin > 계정 관리에서 설정)
 * - 읽기 전용: viewer는 수동 적립·배정 생성 버튼 없음
 * - editor/admin도 접근 가능하나 사이드바에는 viewer에게만 노출
 */
import { useState, useMemo, useCallback } from 'react'
import { Loader2, BookOpen, FileText } from 'lucide-react'
import { useMyPerson } from '@/hooks/useMyPerson'
import { useAssignmentsByPerson } from '@/features/timeline/hooks'
import { useAccrualsByPerson } from '@/features/leave/hooks'
import { useAllWorkItems } from '@/features/workitems/hooks'
import { useAllHolidays } from '@/features/admin/hooks'
import { computeLedger, buildHolidaySet } from '@/features/leave/ledger'
import { computeCv } from '@/features/cv/CvPanel'
import { dateToNum, numToStr, today } from '@/lib/date'
import type { Ledger } from '@/features/leave/ledger'
import type { CvEntry } from '@/features/cv/CvPanel'
import type { WorkItem } from '@/types'

type Tab = 'leave' | 'cv'

// ── SummaryCard (copied from LeavePanel to avoid Modal dependency) ────

type CardColor = 'brand' | 'gray' | 'green' | 'red'
const CARD_STYLES: Record<CardColor, { bg: string; text: string; num: string }> = {
  brand: { bg: 'bg-brand-50',   text: 'text-brand-700',   num: 'text-brand-800'  },
  gray:  { bg: 'bg-surface-100',text: 'text-muted',        num: 'text-gray-800'   },
  green: { bg: 'bg-emerald-50', text: 'text-emerald-700', num: 'text-emerald-900' },
  red:   { bg: 'bg-red-50',     text: 'text-red-600',     num: 'text-red-700'    },
}
function SummaryCard({ label, value, color }: { label: string; value: number; color: CardColor }) {
  const s = CARD_STYLES[color]
  return (
    <div className={`rounded-lg p-3 ${s.bg}`}>
      <p className={`text-xs font-medium ${s.text}`}>{label}</p>
      <p className={`text-2xl font-bold tabular-nums mt-1 ${s.num}`}>{value}</p>
      <p className={`text-xs ${s.text}`}>일</p>
    </div>
  )
}

// ── Leave tab ─────────────────────────────────────────────────

function LeaveTab({
  ledger,
  isLoading,
  asOfStr,
  onAsOfChange,
  wiMap,
}: {
  ledger:       Ledger | null
  isLoading:    boolean
  asOfStr:      string
  onAsOfChange: (s: string) => void
  wiMap:        Map<string, WorkItem>
}) {
  if (isLoading || !ledger) {
    return (
      <div className="flex items-center justify-center py-16 text-muted text-sm">
        <Loader2 size={18} className="animate-spin mr-2" /> 계산 중…
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Reference date */}
      <div className="flex items-center gap-3">
        <label className="text-xs font-medium text-gray-700">기준일</label>
        <input
          type="date"
          className="input py-1 text-xs w-36"
          value={asOfStr}
          onChange={e => onAsOfChange(e.target.value)}
        />
      </div>

      {/* Summary */}
      <div className="grid grid-cols-3 gap-3">
        <SummaryCard label="총 적립" value={ledger.totalAccrued} color="brand" />
        <SummaryCard label="사용"    value={ledger.totalUsed}    color="gray" />
        <SummaryCard label="잔여"    value={ledger.remaining}    color={ledger.remaining < 0 ? 'red' : 'green'} />
      </div>

      {/* Breakdown by type */}
      {Object.keys(ledger.byType).length > 0 && (
        <section>
          <h3 className="mb-2 text-xs font-semibold text-muted uppercase tracking-wide">유형별 현황</h3>
          <div className="card p-0 overflow-hidden">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-surface-50 border-b border-border text-muted">
                  <th className="px-3 py-2 text-left font-medium">유형</th>
                  <th className="px-3 py-2 text-right font-medium">적립</th>
                  <th className="px-3 py-2 text-right font-medium">사용</th>
                  <th className="px-3 py-2 text-right font-medium">잔여</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {(Object.entries(ledger.byType) as [string, { accrued: number; used: number }][]).map(([type, v]) => (
                  <tr key={type} className="hover:bg-surface-50">
                    <td className="px-3 py-2 font-medium text-gray-700">{type}</td>
                    <td className="px-3 py-2 text-right">{v.accrued}</td>
                    <td className="px-3 py-2 text-right">{v.used}</td>
                    <td className="px-3 py-2 text-right font-medium">{Math.round((v.accrued - v.used) * 10) / 10}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Accrual history */}
      <section>
        <h3 className="mb-2 text-xs font-semibold text-muted uppercase tracking-wide">적립 이력</h3>
        {ledger.accruals.length === 0 ? (
          <p className="text-xs text-muted text-center py-4">적립 내역 없음</p>
        ) : (
          <div className="card p-0 overflow-hidden">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-surface-50 border-b border-border text-muted">
                  <th className="px-3 py-2 text-left font-medium">날짜</th>
                  <th className="px-3 py-2 text-left font-medium">유형</th>
                  <th className="px-3 py-2 text-left font-medium">원천</th>
                  <th className="px-3 py-2 text-right font-medium">적립</th>
                  <th className="px-3 py-2 text-right font-medium">잔여</th>
                  <th className="px-3 py-2 text-center font-medium">구분</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {ledger.accruals.map(e => (
                  <tr key={e.id} className="hover:bg-surface-50">
                    <td className="px-3 py-2 font-mono">{e.date}</td>
                    <td className="px-3 py-2">
                      <span className="pill bg-brand-100 text-brand-700">{e.type}</span>
                    </td>
                    <td className="px-3 py-2 text-muted">
                      {e.sourceId
                        ? (wiMap.get(e.sourceId)?.name ?? e.sourceId)
                        : (!e.isAuto && e.note ? e.note : '—')}
                    </td>
                    <td className="px-3 py-2 text-right font-medium">+{e.days}</td>
                    <td className="px-3 py-2 text-right">
                      <span className={e.remaining === 0 ? 'text-muted line-through' : 'font-medium'}>{e.remaining}</span>
                    </td>
                    <td className="px-3 py-2 text-center">
                      {e.isAuto
                        ? <span className="pill bg-surface-100 text-muted text-[10px]">자동</span>
                        : <span className="pill bg-emerald-100 text-emerald-700 text-[10px]">수동</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Usage history */}
      {ledger.usages.length > 0 && (
        <section>
          <h3 className="mb-2 text-xs font-semibold text-muted uppercase tracking-wide">사용 이력 (유급)</h3>
          <div className="card p-0 overflow-hidden">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-surface-50 border-b border-border text-muted">
                  <th className="px-3 py-2 text-left font-medium">기간</th>
                  <th className="px-3 py-2 text-left font-medium">유형</th>
                  <th className="px-3 py-2 text-right font-medium">사용일</th>
                  <th className="px-3 py-2 text-right font-medium">부족분</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {ledger.usages.map(u => (
                  <tr key={u.assignmentId} className={u.deficit > 0 ? 'bg-red-50' : 'hover:bg-surface-50'}>
                    <td className="px-3 py-2 font-mono">
                      {u.start}{u.start !== u.end ? ` ~ ${u.end}` : ''}
                    </td>
                    <td className="px-3 py-2">
                      <span className="pill bg-violet-100 text-violet-700">{u.type}</span>
                    </td>
                    <td className="px-3 py-2 text-right font-medium">{u.days}일</td>
                    <td className="px-3 py-2 text-right">
                      {u.deficit > 0
                        ? <span className="text-red-600 font-medium">−{u.deficit}일</span>
                        : <span className="text-muted">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Unpaid leave */}
      {ledger.unpaid.length > 0 && (
        <section>
          <h3 className="mb-2 text-xs font-semibold text-muted uppercase tracking-wide">무급 휴가</h3>
          <div className="card p-0 overflow-hidden">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-surface-50 border-b border-border text-muted">
                  <th className="px-3 py-2 text-left font-medium">기간</th>
                  <th className="px-3 py-2 text-left font-medium">유형</th>
                  <th className="px-3 py-2 text-right font-medium">영업일</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {ledger.unpaid.map(u => (
                  <tr key={u.assignmentId} className="hover:bg-surface-50">
                    <td className="px-3 py-2 font-mono">{u.start} ~ {u.end}</td>
                    <td className="px-3 py-2">
                      <span className="pill bg-gray-100 text-gray-600">{u.type}</span>
                    </td>
                    <td className="px-3 py-2 text-right">{u.days}일</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  )
}

// ── CV tab ────────────────────────────────────────────────────

function CvTab({ entries }: { entries: CvEntry[] }) {
  if (entries.length === 0) {
    return (
      <div className="text-center py-16 text-muted text-sm">
        수행한 프로젝트가 없습니다.
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {entries.map(e => (
        <article
          key={e.workItem.id}
          className="rounded-lg border border-border p-4 space-y-2"
        >
          <div className="flex items-start justify-between gap-2">
            <h3 className="text-sm font-semibold text-gray-900">{e.workItem.name}</h3>
            <span className="flex-shrink-0 font-mono text-xs text-muted">
              {e.periods.map(p => `${p.start} – ${p.end}`).join(', ')}
            </span>
          </div>
          <dl className="grid grid-cols-[130px_1fr] gap-x-3 gap-y-1 text-xs">
            <dt className="text-muted font-medium">Engagement No.</dt>
            <dd className="text-gray-700">{e.workItem.engagement_number ?? '—'}</dd>
            <dt className="text-muted font-medium">Client</dt>
            <dd className="text-gray-700">{e.workItem.client ?? '—'}</dd>
          </dl>
          {e.workItem.hashtags.length > 0 && (
            <div className="flex flex-wrap gap-1.5 pt-1">
              {e.workItem.hashtags.map(h => (
                <span key={h} className="pill bg-brand-100 text-brand-700 text-[11px]">#{h}</span>
              ))}
            </div>
          )}
        </article>
      ))}
    </div>
  )
}

// ── Main ──────────────────────────────────────────────────────

export default function MePage() {
  const [tab, setTab]       = useState<Tab>('leave')
  const [asOfStr, setAsOfStr] = useState(numToStr(today()))

  const { data: person, isLoading: loadingPerson } = useMyPerson()
  const personId = person?.id

  const { data: assignments = [], isLoading: loadingA } = useAssignmentsByPerson(personId)
  const { data: accruals   = [], isLoading: loadingB } = useAccrualsByPerson(personId)
  const { data: workItems  = [], isLoading: loadingW } = useAllWorkItems()
  const { data: holidays   = [], isLoading: loadingH } = useAllHolidays()

  const isDataLoading = loadingA || loadingB || loadingW || loadingH

  const holidaySet = useMemo(() => {
    const yr = new Date().getFullYear()
    return buildHolidaySet(holidays, yr - 3, yr + 3)
  }, [holidays])

  const isHoliday = useCallback((n: number) => holidaySet.has(n), [holidaySet])
  const asOf      = useMemo(() => dateToNum(asOfStr), [asOfStr])

  const ledger = useMemo(() => {
    if (!personId || isDataLoading) return null
    return computeLedger(personId, { workItems, assignments, accruals, isHoliday, today: asOf })
  }, [personId, workItems, assignments, accruals, isHoliday, asOf, isDataLoading])

  const cvEntries = useMemo(
    () => personId ? computeCv(personId, workItems, assignments) : [],
    [personId, workItems, assignments],
  )

  const wiMap = useMemo(() => new Map(workItems.map(w => [w.id, w])), [workItems])

  if (loadingPerson) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <Loader2 size={22} className="animate-spin text-muted" />
      </div>
    )
  }

  if (!person) {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center text-center p-8 gap-2">
        <p className="text-base font-semibold text-gray-900">인력 레코드 미연결</p>
        <p className="text-sm text-muted max-w-sm">
          관리자에게 Admin &gt; 계정 관리에서 인력 레코드 연결을 요청하세요.
        </p>
      </div>
    )
  }

  const TABS: { key: Tab; label: string; icon: typeof BookOpen }[] = [
    { key: 'leave', label: '내 휴가', icon: BookOpen },
    { key: 'cv',    label: '내 CV',  icon: FileText  },
  ]

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="border-b border-border px-6 py-4">
        <h1 className="text-base font-semibold text-gray-900">{person.name}</h1>
        <p className="text-xs text-muted">
          {person.rank}{person.role ? ` · ${person.role}` : ''}
          {person.lpn ? <span className="ml-2 font-mono">LPN: {person.lpn}</span> : null}
        </p>
      </div>

      {/* Tabs */}
      <div className="flex gap-0.5 border-b border-border px-6 bg-surface-50">
        {TABS.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={[
              'flex items-center gap-1.5 px-3 py-2 text-xs font-medium transition-colors border-b-2 -mb-px',
              tab === key
                ? 'border-brand-600 text-brand-700'
                : 'border-transparent text-muted hover:text-gray-700',
            ].join(' ')}
          >
            <Icon size={13} /> {label}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto p-6">
        {tab === 'leave' && (
          <LeaveTab
            ledger={ledger}
            isLoading={isDataLoading}
            asOfStr={asOfStr}
            onAsOfChange={setAsOfStr}
            wiMap={wiMap}
          />
        )}
        {tab === 'cv' && <CvTab entries={cvEntries} />}
      </div>
    </div>
  )
}
