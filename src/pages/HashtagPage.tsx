/**
 * HashtagPage — §5.8 Engagement 검색
 *
 * 검색 대상: 작업명 · 고객사명 · Description · 해시태그 (부분 일치)
 * 결과 항목 → 참여 인력 + 해시태그 + 설명 상세
 * confidential 작업은 비-editor에게 마스킹 (이름·고객사·설명·해시태그 숨김)
 */
import { useState, useMemo, useCallback } from 'react'
import { Search, X, Tag, Users, Calendar, Lock, FileText } from 'lucide-react'
import { useAllWorkItems }   from '@/features/workitems/hooks'
import { useAllAssignments } from '@/features/timeline/hooks'
import { useAllPeople }      from '@/features/people/hooks'
import { dateToNum }         from '@/lib/date'
import { RANK_ORDER }             from '@/features/timeline/constants'
import { buildWorkItemColorMap }  from '@/lib/colors'
import { parseSearchQuery }       from '@/lib/searchQuery'
import type { WorkItem, Person, Assignment } from '@/types'

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function fmtDate(s: string): string {
  return s.replace(/-/g, '.')
}

function periodStr(start: string, end: string): string {
  return `${fmtDate(start)} ~ ${fmtDate(end)}`
}

// §4 PRD v2.3 — type pill styles aligned to type color families
const TYPE_PILL: Record<string, string> = {
  project:  'bg-blue-100 text-blue-800',
  proposal: 'bg-amber-100 text-amber-800',
  pipeline: 'bg-gray-100 text-gray-700',
}

// ─────────────────────────────────────────────────────────────────────────────
// ResultCard
// ─────────────────────────────────────────────────────────────────────────────

interface ResultCardProps {
  wi:          WorkItem
  query:       string
  selected:    boolean
  isConfidential: boolean
  onSelect:    () => void
}

function ResultCard({ wi, query, selected, isConfidential, onSelect }: ResultCardProps) {
  const q = query.toLowerCase()


  return (
    <button
      onClick={onSelect}
      className={[
        'w-full text-left rounded-lg border p-4 transition-all',
        selected
          ? 'border-brand-500 bg-brand-50 shadow-card'
          : 'border-border bg-surface-0 hover:border-brand-300 hover:bg-surface-50 shadow-card',
      ].join(' ')}
    >
      <div className="flex items-start justify-between gap-2 mb-1.5">
        <div className="flex items-center gap-1.5 min-w-0">
          {isConfidential && <Lock size={12} className="text-amber-500 flex-shrink-0" />}
          <span className="text-sm font-semibold text-gray-900 leading-snug truncate">
            {wi.name}
          </span>
        </div>
        <span className={`pill text-[11px] flex-shrink-0 ${TYPE_PILL[wi.type] ?? 'bg-gray-100 text-gray-600'}`}>
          {wi.type}
        </span>
      </div>

      {wi.client && (
        <div className="text-xs text-muted mb-1.5">{wi.client}</div>
      )}

      {/* Description snippet — show first 80 chars if matches */}
      {wi.description && wi.description.toLowerCase().includes(q) && (
        <div className="text-[11px] text-muted mb-1.5 line-clamp-2 italic">
          {wi.description.length > 100 ? wi.description.slice(0, 100) + '…' : wi.description}
        </div>
      )}

      <div className="text-[11px] text-muted flex items-center gap-1">
        <Calendar size={10} />
        {periodStr(wi.start, wi.end_date)}
      </div>

      {/* Hashtag chips — highlight matching */}
      {wi.hashtags.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {wi.hashtags.map(h => {
            const tagQ = q.startsWith('#') ? q.slice(1) : q
            const matches = h.toLowerCase().includes(tagQ)
            return (
              <span
                key={h}
                className={[
                  'inline-block rounded-full px-2 py-0.5 text-[11px] font-medium',
                  matches
                    ? 'bg-brand-500 text-white'
                    : 'bg-surface-100 text-gray-500',
                ].join(' ')}
              >
                #{h}
              </span>
            )
          })}
        </div>
      )}
    </button>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// DetailPanel
// ─────────────────────────────────────────────────────────────────────────────

interface DetailPanelProps {
  wi:          WorkItem
  assignments: Assignment[]
  peopleMap:   Map<string, Person>
  colorMap:    Map<string, string>
  onClose:     () => void
}

function DetailPanel({ wi, assignments, peopleMap, colorMap, onClose }: DetailPanelProps) {
  const color = colorMap.get(wi.id) ?? '#1e40af'

  const participants = useMemo(() => {
    const workAsgn = assignments.filter(a => a.work_item_id === wi.id && a.kind === 'work')

    const map = new Map<string, { person: Person; start: number; end: number }>()
    for (const a of workAsgn) {
      const p = peopleMap.get(a.person_id)
      if (!p) continue
      const s = dateToNum(a.start)
      const e = dateToNum(a.end_date)
      const existing = map.get(p.id)
      if (!existing) {
        map.set(p.id, { person: p, start: s, end: e })
      } else {
        map.set(p.id, { ...existing, start: Math.min(existing.start, s), end: Math.max(existing.end, e) })
      }
    }

    return [...map.values()].sort((a, b) => {
      const ro = (RANK_ORDER[a.person.rank] ?? 99) - (RANK_ORDER[b.person.rank] ?? 99)
      return ro !== 0 ? ro : a.person.name.localeCompare(b.person.name, 'ko')
    })
  }, [wi.id, assignments, peopleMap])

  function numToDateStr(n: number) {
    const d = new Date(n * 86_400_000)
    return `${d.getUTCFullYear()}.${String(d.getUTCMonth()+1).padStart(2,'0')}.${String(d.getUTCDate()).padStart(2,'0')}`
  }

  return (
    <div className="flex flex-col h-full">
      {/* Panel header */}
      <div className="flex items-start justify-between gap-3 p-5 border-b border-border">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 mb-1">
            <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ background: color }} />
            <span className={`pill text-[11px] ${TYPE_PILL[wi.type] ?? ''}`}>{wi.type}</span>
            {wi.confidential && (
              <span className="flex items-center gap-0.5 text-[10px] text-amber-600 font-medium">
                <Lock size={10} /> 기밀
              </span>
            )}
          </div>
          <h2 className="text-base font-semibold text-gray-900 leading-snug">{wi.name}</h2>
          {wi.client && <p className="text-xs text-muted mt-0.5">{wi.client}</p>}
          <p className="text-[11px] text-muted mt-1 flex items-center gap-1">
            <Calendar size={10} />
            {periodStr(wi.start, wi.end_date)}
          </p>
        </div>
        <button
          onClick={onClose}
          className="p-1 rounded hover:bg-surface-100 text-muted hover:text-gray-900 transition-colors flex-shrink-0"
        >
          <X size={16} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-5 space-y-5">
        {/* Description */}
        {wi.description && (
          <div>
            <div className="flex items-center gap-1.5 text-xs font-semibold text-gray-700 mb-2">
              <FileText size={12} />
              설명
            </div>
            <p className="text-xs text-gray-600 whitespace-pre-wrap leading-relaxed">{wi.description}</p>
          </div>
        )}

        {/* Hashtags */}
        <div>
          <div className="flex items-center gap-1.5 text-xs font-semibold text-gray-700 mb-2">
            <Tag size={12} />
            해시태그
          </div>
          {wi.hashtags.length === 0 ? (
            <p className="text-xs text-muted">태그 없음</p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {wi.hashtags.map(h => (
                <span key={h} className="inline-block rounded-full bg-brand-100 text-brand-700 px-2.5 py-1 text-xs font-medium">
                  #{h}
                </span>
              ))}
            </div>
          )}
        </div>

        {/* Participants */}
        <div>
          <div className="flex items-center gap-1.5 text-xs font-semibold text-gray-700 mb-2">
            <Users size={12} />
            참여 인력{participants.length > 0 && (
              <span className="font-normal text-muted">({participants.length}명)</span>
            )}
          </div>
          {participants.length === 0 ? (
            <p className="text-xs text-muted">배정된 인력 없음</p>
          ) : (
            <div className="space-y-1.5">
              {participants.map(({ person: p, start, end }) => (
                <div
                  key={p.id}
                  className="flex items-center justify-between gap-3 py-2.5 px-3 rounded-lg bg-surface-50 border border-border"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="pill bg-surface-100 text-gray-700 text-[11px] flex-shrink-0">{p.rank}</span>
                    <span className="text-sm font-medium text-gray-900 truncate">{p.name}</span>
                    {p.role && (
                      <span className="text-xs text-muted truncate hidden sm:block">{p.role}</span>
                    )}
                  </div>
                  <span className="text-[11px] text-muted flex-shrink-0">
                    {numToDateStr(start)} ~ {numToDateStr(end)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Engagement number */}
        {wi.engagement_number && (
          <div>
            <div className="text-xs font-semibold text-gray-700 mb-1">Engagement No.</div>
            <div className="text-xs text-muted font-mono">{wi.engagement_number}</div>
          </div>
        )}
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Main component
// ─────────────────────────────────────────────────────────────────────────────

export default function HashtagPage() {
  const { data: workItems   = [], isLoading: lW } = useAllWorkItems()
  const { data: assignments = [], isLoading: lA } = useAllAssignments()
  const { data: people      = [], isLoading: lP } = useAllPeople()
  const [query,    setQuery]    = useState('')
  const [selected, setSelected] = useState<WorkItem | null>(null)

  const isLoading  = lW || lA || lP

  const peopleMap = useMemo(
    () => new Map(people.map(p => [p.id, p])),
    [people],
  )
  const colorMap = useMemo(() => buildWorkItemColorMap(workItems), [workItems])

  const q = query.trim().toLowerCase()

  // Search across name · client · description · hashtags (§5.8, G-5)
  // Strip '#' so "#전략" matches the stored hashtag value "전략".
  const results = useMemo(() => {
    if (!q) return []
    const normalizedQ = q.replace(/#/g, '')
    const matches = parseSearchQuery(normalizedQ)
    return workItems
      .filter(wi => matches([wi.name, wi.client ?? '', wi.description ?? '', ...wi.hashtags]))
      .sort((a, b) => b.start.localeCompare(a.start))
  }, [workItems, q])

  const handleQueryChange = useCallback((v: string) => {
    setQuery(v)
    setSelected(null)
  }, [])

  const hasResults = results.length > 0
  const showDetail = selected !== null

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="flex-shrink-0 border-b border-border px-6 py-4 bg-surface-0">
        <h1 className="text-base font-semibold text-gray-900">Engagement 검색</h1>
        <p className="text-xs text-muted">작업명·고객사·설명·해시태그로 프로젝트/제안 목록과 참여 인력을 조회합니다</p>
      </div>

      {/* Search bar */}
      <div className="flex-shrink-0 px-6 py-3 border-b border-border bg-surface-50">
        <div className="relative max-w-lg">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted pointer-events-none" />
          <input
            type="text"
            className="input pl-9 pr-9"
            placeholder="작업명 / 고객사 / 설명 / 태그 검색…"
            value={query}
            onChange={e => handleQueryChange(e.target.value)}
            autoFocus
          />
          {query && (
            <button
              onClick={() => handleQueryChange('')}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-muted hover:text-gray-700"
            >
              <X size={14} />
            </button>
          )}
        </div>
        {q && (
          <p className="mt-1.5 text-[11px] text-muted">
            {isLoading ? '검색 중…'
              : hasResults
                ? `"${query.trim()}" 검색 결과 ${results.length}건`
                : `"${query.trim()}"에 해당하는 항목이 없습니다`}
          </p>
        )}
      </div>

      {/* Body */}
      <div className="flex flex-1 overflow-hidden">

        {/* Results column */}
        <div className={[
          'overflow-y-auto transition-all duration-200',
          showDetail ? 'w-80 flex-shrink-0 border-r border-border' : 'flex-1',
        ].join(' ')}>
          {!q ? (
            <div className="flex flex-col items-center justify-center h-full text-center p-8">
              <Search size={32} className="text-border mb-3" />
              <p className="text-sm font-medium text-muted">검색어를 입력하세요</p>
              <p className="text-xs text-muted mt-1">작업명, 고객사, 설명, 해시태그 어느 필드든 검색됩니다</p>
            </div>
          ) : isLoading ? (
            <div className="p-8 text-sm text-muted text-center">Loading…</div>
          ) : !hasResults ? (
            <div className="flex flex-col items-center justify-center h-full text-center p-8">
              <Search size={28} className="text-border mb-3" />
              <p className="text-sm font-medium text-muted">검색 결과 없음</p>
              <p className="text-xs text-muted mt-1">다른 검색어를 입력해 보세요</p>
            </div>
          ) : (
            <div className={['p-4 space-y-2', showDetail ? '' : 'max-w-2xl mx-auto'].join(' ')}>
              {results.map(wi => (
                <ResultCard
                  key={wi.id}
                  wi={wi}
                  query={query.trim()}
                  selected={selected?.id === wi.id}
                  isConfidential={!!wi.confidential}
                  onSelect={() => setSelected(wi)}
                />
              ))}
            </div>
          )}
        </div>

        {/* Detail panel */}
        {showDetail && (
          <div className="flex-1 overflow-hidden flex flex-col bg-surface-0">
            <DetailPanel
              wi={selected}
              assignments={assignments}
              peopleMap={peopleMap}
              colorMap={colorMap}
              onClose={() => setSelected(null)}
            />
          </div>
        )}
      </div>
    </div>
  )
}
