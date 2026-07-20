/**
 * GlobalSearchPalette — §5.11a 전역 검색 팔레트 (Ctrl+K)
 *
 * 인력(이름·LPN) + 작업항목(이름·고객사·Engagement No.·해시태그·description) 클라이언트 검색.
 * 권한 준수: work_items_safe 경유이므로 masking은 서버에서 처리됨.
 * Pipeline은 RLS로 editor/admin에게만 노출됨 (viewer는 useAllWorkItems() 결과에 pipeline 없음).
 *
 * G-2: 최소 2글자 이상 입력 시 검색 실행.
 * G-6: 결과 개수 상한 없음 — 매칭 전체 표시, 스크롤로 탐색.
 */
import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { Search, Users, Briefcase, X, ChevronDown, ChevronUp } from 'lucide-react'
import { useAllPeople }    from '@/features/people/hooks'
import { useAllWorkItems } from '@/features/workitems/hooks'
import { parseSearchQuery } from '@/lib/searchQuery'
import { useAuth }  from '@/context/AuthContext'
import { useAuthz } from '@/hooks/useAuthz'
import type { Person, WorkItem } from '@/types'

interface Props {
  onClose:          () => void
  onSelectWorkItem: (wi: WorkItem) => void
}

const MIN_QUERY_LEN = 2

export default function GlobalSearchPalette({ onClose, onSelectWorkItem }: Props) {
  const navigate = useNavigate()
  const inputRef  = useRef<HTMLInputElement>(null)
  const [raw, setRaw] = useState('')
  const [q,   setQ]   = useState('')
  const [peopleCollapsed, setPeopleCollapsed] = useState(false)
  const [wiCollapsed,     setWiCollapsed]     = useState(false)

  // PRD v2.106 G-7: viewer·assistant only — light deterrent against right-click/drag-select
  // on result items (not a real security control; admin/editor unaffected; the search input
  // itself is untouched — this only wraps the results container below).
  const { profile } = useAuth()
  const { isAssistant } = useAuthz()
  const restrictInteraction = profile?.global_role === 'viewer' || isAssistant()

  const { data: people    = [] } = useAllPeople()
  const { data: workItems = [] } = useAllWorkItems()

  // Debounce query; only fire if meets minimum length
  useEffect(() => {
    const trimmed = raw.trim()
    const t = setTimeout(() => setQ(trimmed.length >= MIN_QUERY_LEN ? trimmed : ''), 180)
    return () => clearTimeout(t)
  }, [raw])

  useEffect(() => { inputRef.current?.focus() }, [])

  // Close on backdrop click / Escape
  const handleBackdrop = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) onClose()
  }, [onClose])

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const matchedPeople = useMemo(() => {
    if (!q) return [] as Person[]
    const matches = parseSearchQuery(q)
    return people.filter(p => p.status === 'active' && matches([p.name, p.lpn ?? '', p.role ?? '']))
  }, [q, people])

  const matchedWIs = useMemo(() => {
    if (!q) return [] as WorkItem[]
    const matches = parseSearchQuery(q)
    return workItems.filter(wi =>
      wi.name !== '(비공개)' &&
      matches([wi.name, wi.client ?? '', wi.engagement_number ?? '', wi.description ?? '', ...wi.hashtags])
    )
  }, [q, workItems])

  function selectPerson(p: Person) {
    navigate('/timeline', { state: { highlightPersonId: p.id } })
    onClose()
  }

  function selectWorkItem(wi: WorkItem) {
    onSelectWorkItem(wi)
    onClose()
  }

  const tooShort  = raw.trim().length > 0 && raw.trim().length < MIN_QUERY_LEN
  const noResults = q.length > 0 && matchedPeople.length === 0 && matchedWIs.length === 0

  const TYPE_KR: Record<string, string> = { project: '프로젝트', proposal: '제안', pipeline: 'Pipeline' }

  return createPortal(
    <div
      className="fixed inset-0 z-[200] flex items-start justify-center pt-[12vh] px-4 bg-black/40 backdrop-blur-sm"
      onClick={handleBackdrop}
    >
      <div className="w-full max-w-xl bg-white rounded-xl shadow-2xl overflow-hidden border border-border">
        {/* Input */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-border">
          <Search size={16} className="text-muted flex-shrink-0" />
          <input
            ref={inputRef}
            value={raw}
            onChange={e => setRaw(e.target.value)}
            placeholder="인력 이름, 작업항목, 고객사, 해시태그 검색…"
            className="flex-1 text-sm bg-transparent outline-none text-gray-900 placeholder:text-muted/60"
          />
          {raw && (
            <button onClick={() => setRaw('')} className="text-muted hover:text-gray-600">
              <X size={14} />
            </button>
          )}
          <kbd className="hidden sm:inline-flex items-center gap-0.5 px-1.5 py-0.5 text-[10px] text-muted border border-border rounded">
            Esc
          </kbd>
        </div>

        {/* Results — G-7: viewer/assistant get right-click + drag-select disabled here */}
        <div
          className={`max-h-[60vh] overflow-y-auto ${restrictInteraction ? 'select-none' : ''}`}
          onContextMenu={restrictInteraction ? e => e.preventDefault() : undefined}
        >
          {/* Empty / too-short hint */}
          {!raw && (
            <p className="px-4 py-6 text-center text-sm text-muted">이름, 고객사, 해시태그 등으로 검색하세요</p>
          )}
          {tooShort && (
            <p className="px-4 py-6 text-center text-sm text-muted">2글자 이상 입력하세요</p>
          )}

          {noResults && (
            <p className="px-4 py-6 text-center text-sm text-muted">"{q}"에 맞는 결과 없음</p>
          )}

          {matchedPeople.length > 0 && (
            <section>
              <button
                onClick={() => setPeopleCollapsed(c => !c)}
                className="w-full flex items-center gap-1.5 px-4 pt-3 pb-1 hover:bg-surface-50 transition-colors"
              >
                <Users size={11} className="text-muted" />
                <span className="text-[10px] font-semibold uppercase tracking-wider text-muted flex-1 text-left">
                  인력 ({matchedPeople.length})
                </span>
                {peopleCollapsed
                  ? <ChevronDown size={11} className="text-muted" />
                  : <ChevronUp   size={11} className="text-muted" />}
              </button>
              {!peopleCollapsed && matchedPeople.map(p => (
                <button
                  key={p.id}
                  onClick={() => selectPerson(p)}
                  className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-surface-50 text-left transition-colors"
                >
                  <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-brand-100 text-brand-700 text-xs font-semibold">
                    {p.name.charAt(0)}
                  </div>
                  <div className="min-w-0 flex-1">
                    <span className="text-sm font-medium text-gray-900">{p.name}</span>
                    {p.role && <span className="ml-2 text-xs text-muted">{p.role}</span>}
                  </div>
                  <span className="pill bg-surface-100 text-gray-600 text-[10px] flex-shrink-0">{p.rank}</span>
                </button>
              ))}
            </section>
          )}

          {matchedWIs.length > 0 && (
            <section className={matchedPeople.length > 0 ? 'border-t border-border/50' : ''}>
              <button
                onClick={() => setWiCollapsed(c => !c)}
                className="w-full flex items-center gap-1.5 px-4 pt-3 pb-1 hover:bg-surface-50 transition-colors"
              >
                <Briefcase size={11} className="text-muted" />
                <span className="text-[10px] font-semibold uppercase tracking-wider text-muted flex-1 text-left">
                  작업항목 ({matchedWIs.length})
                </span>
                {wiCollapsed
                  ? <ChevronDown size={11} className="text-muted" />
                  : <ChevronUp   size={11} className="text-muted" />}
              </button>
              {!wiCollapsed && matchedWIs.map(wi => (
                <button
                  key={wi.id}
                  onClick={() => selectWorkItem(wi)}
                  className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-surface-50 text-left transition-colors"
                >
                  <div className="flex-shrink-0 w-7 h-7 flex items-center justify-center rounded bg-surface-100">
                    <Briefcase size={13} className="text-muted" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <span className="text-sm font-medium text-gray-900 truncate block">{wi.name}</span>
                    <span className="text-xs text-muted truncate block">
                      {[wi.client, wi.engagement_number].filter(Boolean).join(' · ')}
                      {wi.hashtags?.length > 0 && (
                        <> · {wi.hashtags.map(h => `#${h}`).join(' ')}</>
                      )}
                    </span>
                  </div>
                  <span className="pill bg-surface-100 text-gray-600 text-[10px] flex-shrink-0">
                    {TYPE_KR[wi.type] ?? wi.type}
                  </span>
                </button>
              ))}
            </section>
          )}

          {(matchedPeople.length > 0 || matchedWIs.length > 0) && (
            <div className="px-4 py-2 border-t border-border/50">
              <p className="text-[10px] text-muted">↵ 선택 · Esc 닫기</p>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}
