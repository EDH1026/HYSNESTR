import { useState } from 'react'
import { useAllPeople } from '@/features/people/hooks'
import { useAllWorkItems } from '@/features/workitems/hooks'
import { useAllAssignments } from '@/features/timeline/hooks'
import { useAuth } from '@/context/AuthContext'
import { useAuthz } from '@/hooks/useAuthz'
import CvPanel, { computeCv } from '@/features/cv/CvPanel'
import FilterChip from '@/components/FilterChip'
import type { Person, Rank } from '@/types'

const RANKS: Rank[] = ['Partner', 'SM', 'M', 'Senior', 'Staff', 'Intern']
const RANK_ORDER: Record<Rank, number> = { Partner: 0, SM: 1, M: 2, Senior: 3, Staff: 4, Intern: 5 }

// ── Viewer-only CV: shows own person's CV panel directly ──────

function ViewerCvView({ people, workItems, assignments, personId }: {
  people:      Person[]
  workItems:   ReturnType<typeof useAllWorkItems>['data'] & {}
  assignments: ReturnType<typeof useAllAssignments>['data'] & {}
  personId:    string | null
}) {
  const own = personId ? people.find(p => p.id === personId) ?? null : null

  if (!own) {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center text-center p-8 gap-2">
        <p className="text-base font-semibold text-gray-900">인력 레코드 미연결</p>
        <p className="text-sm text-muted max-w-sm">
          관리자에게 Admin &gt; 계정 관리에서 인력 레코드 연결을 요청하세요.
        </p>
      </div>
    )
  }

  const entries = computeCv(own.id, workItems ?? [], assignments ?? [])

  return (
    <div className="flex flex-col h-full">
      <div className="border-b border-border px-6 py-4">
        <h1 className="text-base font-semibold text-gray-900">내 CV</h1>
        <p className="text-xs text-muted">{own.name} · {own.rank}{own.role ? ` · ${own.role}` : ''} · {entries.length}개 프로젝트</p>
      </div>
      <div className="flex-1 overflow-auto">
        <CvPanel person={own} onClose={undefined} inline />
      </div>
    </div>
  )
}

// ── Editor/admin CV: full list with filters ───────────────────

export default function CVPage() {
  const { profile } = useAuth()
  const { isAssistant } = useAuthz()
  const isViewer = profile?.global_role === 'viewer' && !isAssistant()

  const { data: people      = [], isLoading: lP } = useAllPeople()
  const { data: workItems   = [], isLoading: lW } = useAllWorkItems()
  const { data: assignments = [], isLoading: lA } = useAllAssignments()

  const [panel,      setPanel]      = useState<Person | null>(null)
  const [nameSearch, setNameSearch] = useState('')
  const [rankFilter, setRankFilter] = useState<Rank[]>([])
  const [periodFrom, setPeriodFrom] = useState('')
  const [periodTo,   setPeriodTo]   = useState('')

  const isLoading = lP || lW || lA

  if (isLoading) return <div className="p-8 text-sm text-muted">Loading…</div>

  // Viewer: dedicated single-person view
  if (isViewer) {
    return (
      <ViewerCvView
        people={people}
        workItems={workItems}
        assignments={assignments}
        personId={profile?.person_id ?? null}
      />
    )
  }

  // Editor / admin: full filterable list
  const accessible = (() => {
    let out = [...people]

    if (nameSearch.trim()) {
      const q = nameSearch.toLowerCase()
      out = out.filter(p => p.name.toLowerCase().includes(q))
    }
    if (rankFilter.length) out = out.filter(p => rankFilter.includes(p.rank))

    if (periodFrom || periodTo) {
      out = out.filter(p => {
        const entries = computeCv(p.id, workItems, assignments)
        return entries.some(e =>
          e.periods.some(p => {
            if (periodTo   && p.start > periodTo)   return false
            if (periodFrom && p.end   < periodFrom) return false
            return true
          }),
        )
      })
    }

    return out.sort((a, b) => {
      const rankCmp = (RANK_ORDER[a.rank] ?? 99) - (RANK_ORDER[b.rank] ?? 99)
      if (rankCmp !== 0) return rankCmp
      return a.name.localeCompare(b.name, 'ko')
    })
  })()

  const hasFilter = !!(nameSearch || rankFilter.length || periodFrom || periodTo)

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-6 py-4">
        <div>
          <h1 className="text-base font-semibold text-gray-900">CV Generator</h1>
          <p className="text-xs text-muted">
            {hasFilter ? `${accessible.length} / ${people.length}` : people.length} 명
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
            <FilterChip key={r} label={r} active={rankFilter.includes(r)}
              onClick={() => setRankFilter(p => p.includes(r) ? p.filter(x => x !== r) : [...p, r])} />
          ))}
        </div>

        <div className="flex items-center gap-1.5">
          <span className="text-xs text-muted">기간</span>
          <input type="date" className="input py-0.5 text-xs w-36"
            value={periodFrom} onChange={e => setPeriodFrom(e.target.value)} />
          <span className="text-xs text-muted">~</span>
          <input type="date" className="input py-0.5 text-xs w-36"
            value={periodTo} onChange={e => setPeriodTo(e.target.value)} />
        </div>

        {hasFilter && (
          <button className="text-xs text-muted hover:text-gray-700"
            onClick={() => { setNameSearch(''); setRankFilter([]); setPeriodFrom(''); setPeriodTo('') }}>
            초기화
          </button>
        )}
      </div>

      {/* People list */}
      <div className="flex-1 overflow-auto p-6">
        {accessible.length === 0 ? (
          <div className="text-center py-16 text-muted text-sm">
            {hasFilter ? '조건에 맞는 인력이 없습니다.' : '인력이 없습니다.'}
          </div>
        ) : (
          <div className="card overflow-hidden p-0">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-surface-50 text-xs text-muted">
                  <th className="px-4 py-2.5 text-left font-medium">이름</th>
                  <th className="px-4 py-2.5 text-left font-medium">직급</th>
                  <th className="px-4 py-2.5 text-left font-medium">역할</th>
                  <th className="px-4 py-2.5 text-right font-medium">프로젝트 수</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {accessible.map(p => {
                  const entries = computeCv(p.id, workItems, assignments)
                  return (
                    <tr key={p.id} className="hover:bg-surface-50 transition-colors cursor-pointer"
                        onClick={() => setPanel(p)}>
                      <td className="px-4 py-3 font-medium text-gray-900">{p.name}</td>
                      <td className="px-4 py-3">
                        <span className="pill bg-brand-100 text-brand-700">{p.rank}</span>
                      </td>
                      <td className="px-4 py-3 text-muted">{p.role || '—'}</td>
                      <td className="px-4 py-3 text-right text-muted tabular-nums">{entries.length}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {panel && <CvPanel person={panel} onClose={() => setPanel(null)} />}
    </div>
  )
}
