/**
 * WorkItemDetailPanel — §5.7/§5.8 shared right-side detail panel.
 *
 * Extracted from HashtagPage.tsx (§5.8 Engagement 검색) so CV Generator (§5.9)
 * can reuse the exact same component instead of re-implementing a subset of it.
 */
import { useMemo } from 'react'
import { Calendar, Lock, FileText, Tag, Users, X } from 'lucide-react'
import { dateToNum } from '@/lib/date'
import { RANK_ORDER } from '@/features/timeline/constants'
import type { WorkItem, Person, Assignment } from '@/types'

// §4 PRD v2.3 — type pill styles aligned to type color families
export const TYPE_PILL: Record<string, string> = {
  project:  'bg-blue-100 text-blue-800',
  proposal: 'bg-amber-100 text-amber-800',
  pipeline: 'bg-gray-100 text-gray-700',
}

export function fmtDate(s: string): string {
  return s.replace(/-/g, '.')
}

export function periodStr(start: string, end: string): string {
  return `${fmtDate(start)} ~ ${fmtDate(end)}`
}

interface Props {
  wi:          WorkItem
  assignments: Assignment[]
  peopleMap:   Map<string, Person>
  colorMap:    Map<string, string>
  onClose:     () => void
}

export default function WorkItemDetailPanel({ wi, assignments, peopleMap, colorMap, onClose }: Props) {
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
