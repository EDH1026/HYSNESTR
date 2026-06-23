import { useState, useMemo } from 'react'
import { FolderPlus, Pencil, ChevronUp, ChevronDown, Lock } from 'lucide-react'
import { useAllWorkItems, useUpdateWorkItem } from '@/features/workitems/hooks'
import { useAuthz } from '@/hooks/useAuthz'
import { useSettings } from '@/features/admin/hooks'
import WorkItemModal from '@/features/workitems/WorkItemModal'
import FYPicker, { type FYFilter, resolveFYFilter } from '@/components/FYPicker'
import { buildWorkItemColorMap } from '@/lib/colors'
import type { WorkItem, WorkItemType } from '@/types'

const TYPES: WorkItemType[] = ['project', 'proposal', 'pipeline']
const TYPE_STYLES: Record<WorkItemType, string> = {
  project:  'bg-brand-100 text-brand-700',
  proposal: 'bg-amber-100 text-amber-700',
  pipeline: 'bg-red-100 text-red-700',
}
type SortField = 'start' | 'name' | 'status' | 'type'

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

function SortTh({ label, field, sort, dir, onSort }: {
  label: string; field: SortField; sort: SortField; dir: 'asc' | 'desc'
  onSort: (f: SortField) => void
}) {
  const active = sort === field
  return (
    <th className="px-4 py-2.5 text-left font-medium cursor-pointer select-none hover:text-gray-700 whitespace-nowrap"
      onClick={() => onSort(field)}>
      <span className="flex items-center gap-0.5">
        {label}
        {active && (dir === 'asc' ? <ChevronUp size={11} /> : <ChevronDown size={11} />)}
      </span>
    </th>
  )
}

export default function WorkItemsPage() {
  const { data: workItems = [], isLoading, error } = useAllWorkItems()
  const { canEdit } = useAuthz()
  const { data: settings } = useSettings()
  const updateWI     = useUpdateWorkItem()
  const editable     = canEdit('global')
  const startMonth   = settings?.fiscal_year_start_month ?? 7

  const colorMap = useMemo(() => buildWorkItemColorMap(workItems), [workItems])

  const [modal,        setModal]        = useState<WorkItem | null | false>(false)
  const [nameSearch,   setNameSearch]   = useState('')
  const [typeFilter,   setTypeFilter]   = useState<WorkItemType[]>([])
  const [statusFilter, setStatusFilter] = useState<string[]>([])
  const [clientSearch, setClientSearch] = useState('')
  const [hashSearch,   setHashSearch]   = useState('')
  const [fyFilter,     setFyFilter]     = useState<FYFilter>({ mode: 'all' })
  const [sort,         setSort]         = useState<SortField>('start')
  const [sortDir,      setSortDir]      = useState<'asc' | 'desc'>('asc')

  function toggleType(t: WorkItemType) {
    setTypeFilter(p => p.includes(t) ? p.filter(x => x !== t) : [...p, t])
  }
  function toggleStatus(s: string) {
    setStatusFilter(p => p.includes(s) ? p.filter(x => x !== s) : [...p, s])
  }
  function handleSort(field: SortField) {
    if (sort === field) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSort(field); setSortDir('asc') }
  }

  const hasPipeline    = workItems.some(w => w.type === 'pipeline')
  const [fyFrom, fyTo] = resolveFYFilter(fyFilter, startMonth)

  const filtered = useMemo(() => {
    let out = [...workItems]
    if (nameSearch.trim()) {
      const q = nameSearch.toLowerCase()
      out = out.filter(w => w.name.toLowerCase().includes(q) || (w.engagement_number ?? '').toLowerCase().includes(q))
    }
    if (typeFilter.length)   out = out.filter(w => typeFilter.includes(w.type))
    if (statusFilter.length) out = out.filter(w => statusFilter.includes(w.status ?? w.project_status ?? 'open'))
    if (clientSearch.trim()) {
      const q = clientSearch.toLowerCase()
      out = out.filter(w => (w.client ?? '').toLowerCase().includes(q))
    }
    if (hashSearch.trim()) {
      const q = hashSearch.toLowerCase()
      out = out.filter(w => w.hashtags.some(h => h.toLowerCase().includes(q)))
    }
    if (fyFrom && fyTo) {
      out = out.filter(w => w.start <= fyTo && w.end_date >= fyFrom)
    }
    out.sort((a, b) => {
      let cmp = 0
      if (sort === 'start')  cmp = a.start.localeCompare(b.start)
      if (sort === 'name')   cmp = a.name.localeCompare(b.name, 'ko')
      if (sort === 'type')   cmp = a.type.localeCompare(b.type)
      if (sort === 'status') cmp = (a.status ?? a.project_status ?? '').localeCompare(b.status ?? b.project_status ?? '')
      return sortDir === 'desc' ? -cmp : cmp
    })
    return out
  }, [workItems, nameSearch, typeFilter, statusFilter, clientSearch, hashSearch, fyFrom, fyTo, sort, sortDir])

  const hasFilter = !!(nameSearch || typeFilter.length || statusFilter.length || clientSearch || hashSearch || fyFilter.mode !== 'all')

  if (isLoading) return <div className="p-8 text-sm text-muted">Loading…</div>
  if (error)     return <div className="p-8 text-sm text-red-600">{String(error)}</div>

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-6 py-4">
        <div>
          <h1 className="text-base font-semibold text-gray-900">Work Items</h1>
          <p className="text-xs text-muted">
            {hasFilter ? `${filtered.length} / ${workItems.length}` : workItems.length} 항목
          </p>
        </div>
        {editable && (
          <button className="btn-primary gap-1.5 text-xs" onClick={() => setModal(null)}>
            <FolderPlus size={14} /> Add Work Item
          </button>
        )}
      </div>

      {/* Filter bar */}
      <div className="flex flex-wrap gap-2 items-center border-b border-border px-6 py-2.5 bg-surface-50">
        <input className="input py-1 text-xs w-44" placeholder="이름 / Engagement No.…"
          value={nameSearch} onChange={e => setNameSearch(e.target.value)} />
        <input className="input py-1 text-xs w-28" placeholder="고객사…"
          value={clientSearch} onChange={e => setClientSearch(e.target.value)} />
        <input className="input py-1 text-xs w-24" placeholder="#태그…"
          value={hashSearch} onChange={e => setHashSearch(e.target.value)} />

        <div className="flex gap-1 items-center">
          <span className="text-xs text-muted">유형</span>
          {(hasPipeline ? TYPES : TYPES.filter(t => t !== 'pipeline')).map(t => (
            <Chip key={t} label={t} active={typeFilter.includes(t)} onClick={() => toggleType(t)} />
          ))}
        </div>

        <div className="flex gap-1 items-center">
          <span className="text-xs text-muted">상태</span>
          <Chip label="Open"   active={statusFilter.includes('open')}   onClick={() => toggleStatus('open')} />
          <Chip label="Closed" active={statusFilter.includes('closed')} onClick={() => toggleStatus('closed')} />
        </div>

        {hasFilter && (
          <button className="text-xs text-muted hover:text-gray-700"
            onClick={() => {
              setNameSearch(''); setTypeFilter([]); setStatusFilter([])
              setClientSearch(''); setHashSearch(''); setFyFilter({ mode: 'all' })
            }}>
            초기화
          </button>
        )}
      </div>

      {/* FY picker row */}
      <div className="flex border-b border-border px-6 py-2 bg-surface-50">
        <FYPicker value={fyFilter} onChange={setFyFilter} startMonth={startMonth} />
      </div>

      {/* Table */}
      <div className="flex-1 overflow-auto p-6">
        {filtered.length === 0 ? (
          <div className="text-center py-16 text-muted text-sm">조건에 맞는 항목이 없습니다.</div>
        ) : (
          <div className="card overflow-hidden p-0">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-surface-50 text-xs text-muted">
                  <th className="px-4 py-2.5 text-left font-medium w-8" />
                  <SortTh label="이름"   field="name"   sort={sort} dir={sortDir} onSort={handleSort} />
                  <th className="px-4 py-2.5 text-left font-medium">고객사</th>
                  <SortTh label="시작일" field="start"  sort={sort} dir={sortDir} onSort={handleSort} />
                  <th className="px-4 py-2.5 text-left font-medium">종료일</th>
                  <SortTh label="유형"   field="type"   sort={sort} dir={sortDir} onSort={handleSort} />
                  <SortTh label="상태"   field="status" sort={sort} dir={sortDir} onSort={handleSort} />
                  <th className="px-4 py-2.5 w-12" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {filtered.map(w => (
                  <tr key={w.id} className="hover:bg-surface-50 transition-colors">
                    <td className="px-4 py-3">
                      <div className="h-4 w-4 rounded-sm" style={{ background: colorMap.get(w.id) ?? '#2563eb' }} />
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className={`font-medium ${w.name === '(비공개)' ? 'text-muted italic' : 'text-gray-900'}`}>
                          {w.name}
                        </span>
                        {w.confidential && (
                          <span className="inline-flex items-center gap-0.5 pill bg-amber-100 text-amber-700 text-[10px]">
                            <Lock size={9} />기밀
                          </span>
                        )}
                        {w.engagement_number && (
                          <span className="text-xs text-muted">{w.engagement_number}</span>
                        )}
                      </div>
                      {w.hashtags.length > 0 && (
                        <div className="mt-0.5 flex flex-wrap gap-1">
                          {w.hashtags.map(h => (
                            <span key={h} className="pill bg-surface-100 text-muted text-[10px]">#{h}</span>
                          ))}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-muted">{w.client || '—'}</td>
                    <td className="px-4 py-3 text-muted font-mono text-xs">{w.start}</td>
                    <td className="px-4 py-3 text-muted font-mono text-xs">{w.end_date}</td>
                    <td className="px-4 py-3">
                      <span className={`pill capitalize ${TYPE_STYLES[w.type]}`}>{w.type}</span>
                    </td>
                    <td className="px-4 py-3">
                      {(() => {
                        const s = w.status ?? w.project_status ?? 'open'
                        return editable ? (
                          <button
                            onClick={() => updateWI.mutate({ id: w.id, status: s === 'open' ? 'closed' : 'open' } as any)}
                            title={s === 'open' ? '클릭하여 Closed로 전환' : '클릭하여 Open으로 전환'}
                            className={`pill text-xs transition-colors ${s === 'open' ? 'bg-emerald-100 text-emerald-700 hover:bg-emerald-200' : 'bg-gray-100 text-gray-500 hover:bg-gray-200'}`}
                          >
                            {s}
                          </button>
                        ) : (
                          <span className={`pill text-xs ${s === 'open' ? 'bg-emerald-100 text-emerald-700' : 'bg-gray-100 text-gray-500'}`}>
                            {s}
                          </span>
                        )
                      })()}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button onClick={() => setModal(w)}
                        className="rounded p-1.5 text-muted hover:bg-surface-100 hover:text-gray-700 transition-colors"
                        title={editable ? 'Edit' : 'View'}>
                        <Pencil size={13} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {modal !== false && (() => {
        const isClosed = (modal?.status ?? modal?.project_status ?? 'open') === 'closed'
        const readOnly = !editable || isClosed
        return (
          <WorkItemModal
            workItem={modal ?? undefined}
            readOnly={readOnly}
            canToggleStatus={editable}
            lockedMessage={
              editable && isClosed
                ? 'Closed 상태입니다. 위 Open/Closed 토글로 전환하세요.'
                : undefined
            }
            onClose={() => setModal(false)}
          />
        )
      })()}
    </div>
  )
}
