import { useState, useMemo } from 'react'
import { UserPlus, Pencil, BookOpen, FileText, ChevronUp, ChevronDown } from 'lucide-react'
import { useAllPeople } from '@/features/people/hooks'
import { useAuthz } from '@/hooks/useAuthz'
import PersonModal from '@/features/people/PersonModal'
import LeavePanel from '@/features/leave/LeavePanel'
import CvPanel from '@/features/cv/CvPanel'
import type { Person, Rank } from '@/types'

const RANKS: Rank[] = ['Partner', 'SM', 'M', 'Senior', 'Staff', 'Intern']
const RANK_ORDER: Record<Rank, number> = { Partner: 0, SM: 1, M: 2, Senior: 3, Staff: 4, Intern: 5 }

function Chip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} className={[
      'px-2 py-0.5 text-xs rounded-full border transition-colors',
      active ? 'bg-brand-600 text-white border-brand-600' : 'bg-white text-gray-600 border-border hover:border-brand-400',
    ].join(' ')}>
      {label}
    </button>
  )
}

type SortField = 'name' | 'rank' | 'role'

function SortTh({ label, field, sort, dir, onSort }: {
  label: string; field: SortField; sort: SortField; dir: 'asc' | 'desc'
  onSort: (f: SortField) => void
}) {
  const active = sort === field
  return (
    <th className="px-4 py-2.5 text-left font-medium cursor-pointer select-none hover:text-gray-700"
      onClick={() => onSort(field)}>
      <span className="flex items-center gap-0.5">
        {label}
        {active && (dir === 'asc' ? <ChevronUp size={11} /> : <ChevronDown size={11} />)}
      </span>
    </th>
  )
}

export default function PeoplePage() {
  const { data: people = [], isLoading, error } = useAllPeople()
  const { canEdit, canView } = useAuthz()
  const editable = canEdit('global')

  const [editModal,  setEditModal]  = useState<Person | null | false>(false)
  const [leavePanel, setLeavePanel] = useState<Person | null>(null)
  const [cvPanel,    setCvPanel]    = useState<Person | null>(null)

  const [nameSearch,   setNameSearch]   = useState('')
  const [rankFilter,   setRankFilter]   = useState<Rank[]>([])
  const [statusFilter, setStatusFilter] = useState<string[]>([])
  const [sort,         setSort]         = useState<SortField>('rank')
  const [sortDir,      setSortDir]      = useState<'asc' | 'desc'>('asc')

  function toggleRank(r: Rank) {
    setRankFilter(p => p.includes(r) ? p.filter(x => x !== r) : [...p, r])
  }
  function toggleStatus(s: string) {
    setStatusFilter(p => p.includes(s) ? p.filter(x => x !== s) : [...p, s])
  }
  function handleSort(field: SortField) {
    if (sort === field) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSort(field); setSortDir('asc') }
  }

  const filtered = useMemo(() => {
    let out = [...people]
    if (nameSearch.trim()) {
      const q = nameSearch.toLowerCase()
      out = out.filter(p => p.name.toLowerCase().includes(q) || (p.role ?? '').toLowerCase().includes(q))
    }
    if (rankFilter.length)   out = out.filter(p => rankFilter.includes(p.rank))
    if (statusFilter.length) out = out.filter(p => statusFilter.includes(p.status))
    out.sort((a, b) => {
      let cmp = 0
      if (sort === 'name') cmp = a.name.localeCompare(b.name, 'ko')
      if (sort === 'rank') cmp = (RANK_ORDER[a.rank] ?? 99) - (RANK_ORDER[b.rank] ?? 99)
      if (sort === 'role') cmp = (a.role ?? '').localeCompare(b.role ?? '', 'ko')
      return sortDir === 'desc' ? -cmp : cmp
    })
    return out
  }, [people, nameSearch, rankFilter, statusFilter, sort, sortDir])

  const hasFilter = nameSearch || rankFilter.length > 0 || statusFilter.length > 0

  if (isLoading) return <div className="p-8 text-sm text-muted">Loading…</div>
  if (error)     return <div className="p-8 text-sm text-red-600">{String(error)}</div>

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-6 py-4">
        <div>
          <h1 className="text-base font-semibold text-gray-900">People</h1>
          <p className="text-xs text-muted">
            {hasFilter ? `${filtered.length} / ${people.length}` : people.length} 명
          </p>
        </div>
        {editable && (
          <button className="btn-primary gap-1.5 text-xs" onClick={() => setEditModal(null)}>
            <UserPlus size={14} /> Add Person
          </button>
        )}
      </div>

      {/* Filter bar */}
      <div className="flex flex-wrap gap-2 items-center border-b border-border px-6 py-2.5 bg-surface-50">
        <input
          className="input py-1 text-xs w-44"
          placeholder="이름 / 역할 검색…"
          value={nameSearch}
          onChange={e => setNameSearch(e.target.value)}
        />
        <div className="flex flex-wrap gap-1 items-center">
          <span className="text-xs text-muted">직급</span>
          {RANKS.map(r => (
            <Chip key={r} label={r} active={rankFilter.includes(r)} onClick={() => toggleRank(r)} />
          ))}
        </div>
        <div className="flex gap-1 items-center">
          <span className="text-xs text-muted">상태</span>
          <Chip label="재직" active={statusFilter.includes('active')}   onClick={() => toggleStatus('active')} />
          <Chip label="퇴직" active={statusFilter.includes('resigned')} onClick={() => toggleStatus('resigned')} />
        </div>
        {hasFilter && (
          <button className="text-xs text-muted hover:text-gray-700"
            onClick={() => { setNameSearch(''); setRankFilter([]); setStatusFilter([]) }}>
            초기화
          </button>
        )}
      </div>

      {/* Table */}
      <div className="flex-1 overflow-auto p-6">
        {filtered.length === 0 ? (
          <div className="text-center py-16 text-muted text-sm">조건에 맞는 인력이 없습니다.</div>
        ) : (
          <div className="card overflow-hidden p-0">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-surface-50 text-xs text-muted">
                  <SortTh label="이름" field="name" sort={sort} dir={sortDir} onSort={handleSort} />
                  <SortTh label="직급" field="rank" sort={sort} dir={sortDir} onSort={handleSort} />
                  <SortTh label="역할" field="role" sort={sort} dir={sortDir} onSort={handleSort} />
                  <th className="px-4 py-2.5 text-left font-medium">상태</th>
                  <th className="px-4 py-2.5 text-right font-medium">작업</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {filtered.map(p => {
                  const canViewP = canView('person', p.id)
                  return (
                    <tr key={p.id} className="hover:bg-surface-50 transition-colors">
                      <td className="px-4 py-3 font-medium text-gray-900">{p.name}</td>
                      <td className="px-4 py-3">
                        <span className="pill bg-brand-100 text-brand-700">{p.rank}</span>
                      </td>
                      <td className="px-4 py-3 text-muted">{p.role || '—'}</td>
                      <td className="px-4 py-3">
                        <span className={`pill text-xs ${p.status === 'active' ? 'bg-emerald-100 text-emerald-700' : 'bg-gray-100 text-gray-500'}`}>
                          {p.status === 'active' ? '재직' : '퇴직'}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <div className="flex justify-end gap-1">
                          {canViewP && (
                            <button onClick={() => setCvPanel(p)}
                              className="rounded p-1.5 text-muted hover:bg-emerald-100 hover:text-emerald-700 transition-colors"
                              title="CV">
                              <FileText size={13} />
                            </button>
                          )}
                          {canViewP && (
                            <button onClick={() => setLeavePanel(p)}
                              className="rounded p-1.5 text-muted hover:bg-violet-100 hover:text-violet-700 transition-colors"
                              title="Leave Ledger">
                              <BookOpen size={13} />
                            </button>
                          )}
                          <button onClick={() => setEditModal(p)}
                            className="rounded p-1.5 text-muted hover:bg-surface-100 hover:text-gray-700 transition-colors"
                            title={editable ? 'Edit' : 'View'}>
                            <Pencil size={13} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {editModal !== false && (
        <PersonModal person={editModal ?? undefined} readOnly={!editable} onClose={() => setEditModal(false)} />
      )}
      {leavePanel && <LeavePanel person={leavePanel} onClose={() => setLeavePanel(null)} />}
      {cvPanel    && <CvPanel    person={cvPanel}    onClose={() => setCvPanel(null)} />}
    </div>
  )
}
