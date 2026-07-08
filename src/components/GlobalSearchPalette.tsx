/**
 * GlobalSearchPalette — §5.11a 전역 검색 팔레트 (Ctrl+K)
 *
 * 인력(이름·LPN) + 작업항목(이름·고객사·Engagement No.·해시태그·description) 클라이언트 검색.
 * 권한 준수: work_items_safe 경유이므로 masking은 서버에서 처리됨.
 * Pipeline은 RLS로 editor/admin에게만 노출됨 (viewer는 useAllWorkItems() 결과에 pipeline 없음).
 */
import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { Search, Users, Briefcase, X } from 'lucide-react'
import { useAllPeople }    from '@/features/people/hooks'
import { useAllWorkItems } from '@/features/workitems/hooks'
import type { Person, WorkItem } from '@/types'

interface Props {
  onClose:          () => void
  onSelectWorkItem: (wi: WorkItem) => void
}

const MAX_RESULTS = 6

function highlight(text: string, q: string): string {
  return text  // purely used for matching; rendering shows raw text
}

function matchesPerson(p: Person, q: string): boolean {
  const lq = q.toLowerCase()
  if (p.name.toLowerCase().includes(lq)) return true
  if (p.lpn?.toLowerCase().includes(lq)) return true
  if (p.role?.toLowerCase().includes(lq)) return true
  return false
}

function matchesWorkItem(wi: WorkItem, q: string): boolean {
  if (wi.name === '(비공개)') return false   // masked confidential — skip
  const lq = q.toLowerCase()
  if (wi.name.toLowerCase().includes(lq)) return true
  if (wi.client?.toLowerCase().includes(lq)) return true
  if (wi.engagement_number?.toLowerCase().includes(lq)) return true
  if (wi.description?.toLowerCase().includes(lq)) return true
  if (wi.hashtags?.some(h => h.toLowerCase().includes(lq))) return true
  return false
}

export default function GlobalSearchPalette({ onClose, onSelectWorkItem }: Props) {
  const navigate = useNavigate()
  const inputRef  = useRef<HTMLInputElement>(null)
  const [raw, setRaw] = useState('')
  const [q,   setQ]   = useState('')

  const { data: people    = [] } = useAllPeople()
  const { data: workItems = [] } = useAllWorkItems()

  // Debounce query
  useEffect(() => {
    const t = setTimeout(() => setQ(raw.trim()), 180)
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
    return people.filter(p => p.status === 'active' && matchesPerson(p, q)).slice(0, MAX_RESULTS)
  }, [q, people])

  const matchedWIs = useMemo(() => {
    if (!q) return [] as WorkItem[]
    return workItems.filter(wi => matchesWorkItem(wi, q)).slice(0, MAX_RESULTS)
  }, [q, workItems])

  function selectPerson(p: Person) {
    navigate('/timeline', { state: { highlightPersonId: p.id } })
    onClose()
  }

  function selectWorkItem(wi: WorkItem) {
    onSelectWorkItem(wi)
    onClose()
  }

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

        {/* Results */}
        <div className="max-h-96 overflow-y-auto">
          {!q && (
            <p className="px-4 py-6 text-center text-sm text-muted">이름, 고객사, 해시태그 등으로 검색하세요</p>
          )}

          {noResults && (
            <p className="px-4 py-6 text-center text-sm text-muted">"{q}"에 맞는 결과 없음</p>
          )}

          {matchedPeople.length > 0 && (
            <section>
              <div className="flex items-center gap-1.5 px-4 pt-3 pb-1">
                <Users size={11} className="text-muted" />
                <span className="text-[10px] font-semibold uppercase tracking-wider text-muted">인력</span>
              </div>
              {matchedPeople.map(p => (
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
              <div className="flex items-center gap-1.5 px-4 pt-3 pb-1">
                <Briefcase size={11} className="text-muted" />
                <span className="text-[10px] font-semibold uppercase tracking-wider text-muted">작업항목</span>
              </div>
              {matchedWIs.map(wi => (
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
