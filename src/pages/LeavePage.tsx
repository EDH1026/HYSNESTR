/**
 * LeavePage — per-person leave balance overview
 *
 * Editor/admin: filterable people list (name · rank · status) + modal LeavePanel.
 * Viewer: own leave data rendered inline (no modal, no filter).
 */
import { useState, useMemo, useCallback } from 'react'
import { BookOpen } from 'lucide-react'
import { useAllPeople } from '@/features/people/hooks'
import { useAllAssignments } from '@/features/timeline/hooks'
import { useAllAccruals } from '@/features/leave/hooks'
import { useAllWorkItems } from '@/features/workitems/hooks'
import { useAllHolidays } from '@/features/admin/hooks'
import { useAuth } from '@/context/AuthContext'
import { useAuthz } from '@/hooks/useAuthz'
import LeavePanel from '@/features/leave/LeavePanel'
import FilterChip from '@/components/FilterChip'
import { computeLedger, buildHolidaySet } from '@/features/leave/ledger'
import { today } from '@/lib/date'
import type { Person, Rank } from '@/types'

const RANKS: Rank[] = ['Partner', 'SM', 'M', 'Senior', 'Staff', 'Intern']
const RANK_ORDER: Record<Rank, number> = { Partner: 0, SM: 1, M: 2, Senior: 3, Staff: 4, Intern: 5 }

export default function LeavePage() {
  const { profile } = useAuth()
  const { isAssistant } = useAuthz()
  const isViewer = profile?.global_role === 'viewer' && !isAssistant()

  const { data: people      = [], isLoading: lP } = useAllPeople()
  const { data: assignments = [], isLoading: lA } = useAllAssignments()
  const { data: accruals    = [], isLoading: lB } = useAllAccruals()
  const { data: workItems   = [], isLoading: lW } = useAllWorkItems()
  const { data: holidays    = [], isLoading: lH } = useAllHolidays()

  const isLoading = lP || lA || lB || lW || lH

  // Editor/admin — modal panel
  const [panel, setPanel] = useState<Person | null>(null)

  // Editor/admin — filter state (재직만 기본 표시)
  const [nameSearch,   setNameSearch]   = useState('')
  const [rankFilter,   setRankFilter]   = useState<Rank[]>([])
  const [statusFilter, setStatusFilter] = useState<string[]>(['active'])

  const holidaySet = useMemo(() => {
    const yr = new Date().getFullYear()
    return buildHolidaySet(holidays, yr - 3, yr + 3)
  }, [holidays])

  const isHoliday = useCallback((n: number) => holidaySet.has(n), [holidaySet])
  const todayNum  = today()

  // Viewer: own person resolved from profile.person_id
  const ownPerson = useMemo(
    () => (isViewer && profile?.person_id)
      ? people.find(p => p.id === profile.person_id) ?? null
      : null,
    [isViewer, people, profile?.person_id],
  )

  // Editor/admin: filtered + sorted people list
  const filteredPeople = useMemo(() => {
    if (isViewer) return []
    let out = [...people]
    if (nameSearch.trim()) {
      const q = nameSearch.toLowerCase()
      out = out.filter(p => p.name.toLowerCase().includes(q))
    }
    if (rankFilter.length)   out = out.filter(p => rankFilter.includes(p.rank))
    if (statusFilter.length) out = out.filter(p => statusFilter.includes(p.status ?? 'active'))
    return out.sort((a, b) => {
      const rc = (RANK_ORDER[a.rank] ?? 99) - (RANK_ORDER[b.rank] ?? 99)
      return rc !== 0 ? rc : a.name.localeCompare(b.name, 'ko')
    })
  }, [people, nameSearch, rankFilter, statusFilter, isViewer])

  const summaries = useMemo(() => {
    if (isLoading || isViewer) return []
    return filteredPeople.map(p => {
      const ledger = computeLedger(p.id, {
        workItems, assignments, accruals, isHoliday, today: todayNum, personRank: p.rank,
      })
      return { person: p, ledger }
    })
  }, [filteredPeople, workItems, assignments, accruals, isHoliday, todayNum, isLoading, isViewer])

  const hasFilter = !!(nameSearch || rankFilter.length || statusFilter.length !== 1 || !statusFilter.includes('active'))

  function resetFilter() {
    setNameSearch('')
    setRankFilter([])
    setStatusFilter(['active'])
  }

  function toggleRank(r: Rank) {
    setRankFilter(prev => prev.includes(r) ? prev.filter(x => x !== r) : [...prev, r])
  }

  function toggleStatus(s: string) {
    setStatusFilter(prev => prev.includes(s) ? prev.filter(x => x !== s) : [...prev, s])
  }

  if (isLoading) return <div className="p-8 text-sm text-muted">Loading…</div>

  // ── Viewer: no person linked ──────────────────────────────────
  if (isViewer && !ownPerson) {
    return (
      <div className="flex flex-col h-full">
        <div className="border-b border-border px-6 py-4">
          <h1 className="text-base font-semibold text-gray-900">내 Leave</h1>
        </div>
        <div className="flex min-h-[60vh] flex-col items-center justify-center text-center p-8 gap-2">
          <p className="text-base font-semibold text-gray-900">인력 레코드 미연결</p>
          <p className="text-sm text-muted max-w-sm">
            관리자에게 Admin &gt; 계정 관리에서 인력 레코드 연결을 요청하세요.
          </p>
        </div>
      </div>
    )
  }

  // ── Viewer: own leave inline ──────────────────────────────────
  if (isViewer && ownPerson) {
    return (
      <div className="flex flex-col h-full overflow-hidden">
        <div className="border-b border-border px-6 py-4 flex-shrink-0">
          <h1 className="text-base font-semibold text-gray-900">내 Leave</h1>
          <p className="text-xs text-muted">
            {ownPerson.name} · {ownPerson.rank}
            {ownPerson.role ? ` · ${ownPerson.role}` : ''}
          </p>
        </div>
        <LeavePanel person={ownPerson} inline />
      </div>
    )
  }

  // ── Editor / admin: filter + table + modal ───────────────────
  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-6 py-4">
        <div>
          <h1 className="text-base font-semibold text-gray-900">Leave</h1>
          <p className="text-xs text-muted">
            {hasFilter
              ? `${filteredPeople.length} / ${people.length} 명`
              : `${people.length} 명`}
          </p>
        </div>
      </div>

      {/* Filter bar */}
      <div className="flex flex-wrap gap-2 items-center border-b border-border px-6 py-2.5 bg-surface-50">
        <input
          className="input py-1 text-xs w-44"
          placeholder="이름 검색…"
          value={nameSearch}
          onChange={e => setNameSearch(e.target.value)}
        />

        <div className="flex flex-wrap gap-1 items-center">
          <span className="text-xs text-muted">직급</span>
          {RANKS.map(r => (
            <FilterChip key={r} label={r} active={rankFilter.includes(r)} onClick={() => toggleRank(r)} />
          ))}
        </div>

        <div className="flex gap-1 items-center">
          <span className="text-xs text-muted">재직</span>
          <FilterChip label="재직" active={statusFilter.includes('active')}   onClick={() => toggleStatus('active')} />
          <FilterChip label="퇴직" active={statusFilter.includes('resigned')} onClick={() => toggleStatus('resigned')} />
        </div>

        {hasFilter && (
          <button
            className="text-xs text-muted hover:text-gray-700"
            onClick={resetFilter}
          >
            초기화
          </button>
        )}
      </div>

      {/* People table */}
      <div className="flex-1 overflow-auto p-6">
        {summaries.length === 0 ? (
          <div className="text-center py-16 text-muted text-sm">
            {hasFilter ? '조건에 맞는 인력이 없습니다.' : '인력이 없습니다.'}
          </div>
        ) : (
          <div className="card overflow-hidden p-0">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-surface-50 text-xs text-muted">
                  <th className="px-4 py-2.5 text-left font-medium">Name</th>
                  <th className="px-4 py-2.5 text-left font-medium">Rank</th>
                  <th className="px-4 py-2.5 text-left font-medium">재직</th>
                  <th className="px-4 py-2.5 text-right font-medium">총 적립</th>
                  <th className="px-4 py-2.5 text-right font-medium">사용</th>
                  <th className="px-4 py-2.5 text-right font-medium">잔여</th>
                  <th className="px-4 py-2.5 w-16" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {summaries.map(({ person: p, ledger: l }) => (
                  <tr key={p.id} className="hover:bg-surface-50 transition-colors">
                    <td className="px-4 py-3 font-medium text-gray-900">{p.name}</td>
                    <td className="px-4 py-3">
                      <span className="pill bg-brand-100 text-brand-700">{p.rank}</span>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`pill text-xs ${(p.status ?? 'active') === 'active' ? 'bg-emerald-100 text-emerald-700' : 'bg-gray-100 text-gray-500'}`}>
                        {(p.status ?? 'active') === 'active' ? '재직' : '퇴직'}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">{l.totalAccrued}</td>
                    <td className="px-4 py-3 text-right tabular-nums text-muted">{l.totalUsed}</td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      <span className={[
                        'font-semibold',
                        l.remaining > 0 ? 'text-emerald-700' :
                        l.remaining < 0 ? 'text-red-600' : 'text-muted',
                      ].join(' ')}>
                        {l.remaining}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button
                        onClick={() => setPanel(p)}
                        className="btn-secondary text-xs py-1 gap-1.5"
                      >
                        <BookOpen size={11} /> 상세
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {panel && <LeavePanel person={panel} onClose={() => setPanel(null)} />}
    </div>
  )
}
