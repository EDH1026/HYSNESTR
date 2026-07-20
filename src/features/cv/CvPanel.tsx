/**
 * CvPanel — per-person CV panel (PRD §5.9)
 *
 * - 기본: project 유형만 표시 (pipeline 항상 제외)
 * - 토글: "제안서 포함" 시 proposal도 표시
 * - Open/Closed 무관 전체 표시
 * - 읽기: work_items_safe 뷰 사용 (기밀 마스킹)
 */
import { useState, useMemo, useEffect } from 'react'
import { Download, Search } from 'lucide-react'
import Modal from '@/components/Modal'
import { useAllWorkItems } from '@/features/workitems/hooks'
import { useAssignmentsByPerson, useAllAssignments } from '@/features/timeline/hooks'
import { useAllPeople } from '@/features/people/hooks'
import { useAuthz } from '@/hooks/useAuthz'
import { dateToNum } from '@/lib/date'
import { buildWorkItemColorMap } from '@/lib/colors'
import { parseSearchQuery } from '@/lib/searchQuery'
import WorkItemDetailPanel from '@/features/workitems/WorkItemDetailPanel'
import type { Person, WorkItem, Assignment } from '@/types'

// ── CV entry (one row per project / proposal) ─────────────────

export interface CvEntry {
  workItem: WorkItem
  periods:  Array<{start: string; end: string}>   // V-4: actual merged intervals
}

function mergeIntervals(
  ivs: Array<{start: string; end: string}>,
): Array<{start: string; end: string}> {
  if (ivs.length === 0) return []
  const sorted = [...ivs].sort((a, b) => a.start.localeCompare(b.start))
  const merged = [{ ...sorted[0] }]
  for (let i = 1; i < sorted.length; i++) {
    const last = merged[merged.length - 1]
    if (dateToNum(sorted[i].start) <= dateToNum(last.end) + 1) {
      if (sorted[i].end > last.end) last.end = sorted[i].end
    } else {
      merged.push({ ...sorted[i] })
    }
  }
  return merged
}

export function computeCv(
  personId:        string,
  workItems:       WorkItem[],
  assignments:     Assignment[],
  includeProposal: boolean = false,
): CvEntry[] {
  return workItems
    .filter(w =>
      w.type === 'project' ||
      (includeProposal && w.type === 'proposal'),
    )
    .flatMap(w => {
      const mine = assignments.filter(
        a => a.person_id    === personId
          && a.work_item_id === w.id
          && a.kind         === 'work',
      )
      if (mine.length === 0) return []

      // §5.9 V-1/V-4: for projects with a pre-study phase, clamp to main phase.
      // If the person only participated in pre-study, exclude this project from CV.
      if (w.type === 'project' && w.main_start) {
        const mainStart = w.main_start
        const mainEnd   = w.end_date

        const mainMine = mine.filter(
          a => a.start <= mainEnd && a.end_date >= mainStart,
        )
        if (mainMine.length === 0) return []

        const intervals = mainMine.map(a => ({
          start: a.start < mainStart ? mainStart : a.start,
          end:   a.end_date > mainEnd ? mainEnd : a.end_date,
        }))
        return [{ workItem: w, periods: mergeIntervals(intervals) }]
      }

      // Proposals and projects without pre-study: use full assignment ranges
      const intervals = mine.map(a => ({ start: a.start, end: a.end_date }))
      return [{ workItem: w, periods: mergeIntervals(intervals) }]
    })
    .sort((a, b) => {
      const endA = a.periods[a.periods.length - 1]?.end ?? ''
      const endB = b.periods[b.periods.length - 1]?.end ?? ''
      return endB.localeCompare(endA)
    })
}

// ── HTML generator ────────────────────────────────────────────

function generateHtml(person: Person, entries: CvEntry[], includeProposal: boolean): string {
  const generated = new Date().toLocaleDateString('ko-KR', {
    year: 'numeric', month: 'long', day: 'numeric',
  })

  const projectRows = entries.map(e => {
    const typeLabel = e.workItem.type === 'proposal' ? ' (제안서)' : ''
    const tags = e.workItem.hashtags.length > 0
      ? `<div class="tags">${e.workItem.hashtags.map(h => `<span class="tag">#${escHtml(h)}</span>`).join('')}</div>`
      : ''
    return `
    <article class="card">
      <h2 class="proj-name">${escHtml(e.workItem.name)}${escHtml(typeLabel)}</h2>
      <dl class="details">
        <dt>Engagement No.</dt><dd>${escHtml(e.workItem.engagement_number ?? '—')}</dd>
        <dt>Client</dt><dd>${escHtml(e.workItem.client ?? '—')}</dd>
        <dt>Period</dt><dd>${e.periods.map(p => `${p.start} – ${p.end}`).join(', ')}</dd>
      </dl>
      ${tags}
    </article>`
  }).join('\n')

  const subtitle = includeProposal ? '프로젝트 · 제안서' : '프로젝트'

  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>${escHtml(person.name)} — CV</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Noto Sans KR",sans-serif;
  font-size:13px;line-height:1.65;color:#111827;max-width:820px;margin:0 auto;padding:48px 40px}
header{border-bottom:2px solid #2563eb;padding-bottom:20px;margin-bottom:36px}
h1{font-size:28px;font-weight:700;color:#111827}
.subtitle{margin-top:6px;color:#6b7280;font-size:14px}
.meta{margin-top:4px;color:#9ca3af;font-size:11px}
.card{border:1px solid #e5e7eb;border-radius:8px;padding:18px 22px;margin-bottom:14px;break-inside:avoid}
h2.proj-name{font-size:15px;font-weight:600;color:#111827;margin-bottom:10px}
dl.details{display:grid;grid-template-columns:150px 1fr;gap:4px 12px;font-size:13px}
dt{color:#6b7280;font-weight:500}
dd{color:#374151}
.tags{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}
.tag{background:#eef2ff;color:#4338ca;border-radius:999px;padding:2px 10px;font-size:11px;font-weight:500}
@media print{
  body{padding:20px;max-width:none}
  @page{margin:20mm}
  .card{border-color:#d1d5db;box-shadow:none}
}
</style>
</head>
<body>
<header>
  <h1>${escHtml(person.name)}</h1>
  <p class="subtitle">${escHtml(person.rank)}${person.role ? ' · ' + escHtml(person.role) : ''}</p>
  <p class="meta">${escHtml(subtitle)} | Generated ${generated}</p>
</header>
<main>
${entries.length === 0
    ? '<p style="color:#6b7280;text-align:center;padding:40px 0">No project history.</p>'
    : projectRows}
</main>
</body>
</html>`
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function triggerDownload(content: string, filename: string, mime: string) {
  const blob = new Blob([content], { type: mime })
  const url  = URL.createObjectURL(blob)
  const a    = Object.assign(document.createElement('a'), { href: url, download: filename })
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

// ── Panel component ───────────────────────────────────────────

interface Props {
  person:   Person
  onClose?: () => void  // undefined → inline (no modal wrapper)
  inline?:  boolean     // true → render inline, no Modal
}

export default function CvPanel({ person, onClose, inline }: Props) {
  const { canView } = useAuthz()
  const { data: workItems   = [] } = useAllWorkItems()
  const { data: assignments = [] } = useAssignmentsByPerson(person.id)
  // §5.8 reuse: WorkItemDetailPanel's participant list needs everyone assigned to a
  // work item, not just this person's own assignments — so a bulk read is required
  // here even though `assignments` above (person-scoped) already covers computeCv().
  const { data: allAssignments = [] } = useAllAssignments()
  const { data: allPeople      = [] } = useAllPeople()

  // Default: projects only; toggle to also include proposals
  const [includeProposal, setIncludeProposal] = useState(false)
  const [engSearch,       setEngSearch]       = useState('')
  const [filterOnly,      setFilterOnly]      = useState(false)
  const [detailWI,        setDetailWI]        = useState<WorkItem | null>(null)

  const peopleMap = useMemo(() => new Map(allPeople.map(p => [p.id, p])), [allPeople])
  const colorMap  = useMemo(() => buildWorkItemColorMap(workItems), [workItems])

  useEffect(() => {
    if (!detailWI) return
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') setDetailWI(null) }
    document.addEventListener('keydown', h)
    return () => document.removeEventListener('keydown', h)
  }, [detailWI])

  const entries = useMemo(
    () => computeCv(person.id, workItems, assignments, includeProposal),
    [person.id, workItems, assignments, includeProposal],
  )

  const filteredEntries = useMemo(() => {
    if (!engSearch.trim()) return entries
    const matches = parseSearchQuery(engSearch)
    return entries.filter(e =>
      matches([e.workItem.name, e.workItem.client ?? '', e.workItem.description ?? '', ...e.workItem.hashtags]),
    )
  }, [entries, engSearch])

  if (!canView('person', person.id)) {
    if (inline) {
      return <p className="p-8 text-sm text-muted">열람 권한이 없습니다.</p>
    }
    return (
      <Modal title={`${person.name} — CV`} onClose={onClose!} size="sm">
        <p className="text-sm text-muted">열람 권한이 없습니다.</p>
      </Modal>
    )
  }

  function handleDownload() {
    const toExport = filterOnly ? filteredEntries : entries
    const html    = generateHtml(person, toExport, includeProposal)
    const safe    = person.name.replace(/[^a-zA-Z0-9가-힣_-]/g, '_')
    const dateStr = new Date().toISOString().slice(0, 10)
    triggerDownload(html, `CV_${safe}_${dateStr}.html`, 'text/html;charset=utf-8')
  }

  const emptyMsg = includeProposal
    ? '수행한 프로젝트·제안서가 없습니다.'
    : '수행한 프로젝트가 없습니다.'

  const content = (
    <>
      {/* Header controls */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <p className="text-sm font-semibold text-gray-900">{person.name}</p>
          <p className="text-xs text-muted">{person.rank}{person.role ? ` · ${person.role}` : ''}</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {/* Project / Proposal toggle */}
          <div className="flex rounded-md overflow-hidden border border-border text-xs font-medium">
            <button
              type="button"
              onClick={() => setIncludeProposal(false)}
              className={[
                'px-2.5 py-1.5 transition-colors',
                !includeProposal
                  ? 'bg-blue-600 text-white'
                  : 'bg-white text-gray-600 hover:bg-surface-50',
              ].join(' ')}
            >
              프로젝트만
            </button>
            <button
              type="button"
              onClick={() => setIncludeProposal(true)}
              className={[
                'px-2.5 py-1.5 transition-colors',
                includeProposal
                  ? 'bg-sky-500 text-white'
                  : 'bg-white text-gray-600 hover:bg-surface-50',
              ].join(' ')}
            >
              제안서 포함
            </button>
          </div>
          <label className="flex items-center gap-1.5 text-xs text-muted cursor-pointer select-none">
            <input
              type="checkbox"
              checked={filterOnly}
              onChange={e => setFilterOnly(e.target.checked)}
              className="h-3.5 w-3.5 rounded border-border accent-blue-600"
            />
            필터링된 항목만 내보내기
          </label>
          <button onClick={handleDownload} className="btn-secondary gap-1.5 text-xs">
            <Download size={13} /> Download HTML
          </button>
        </div>
      </div>

      {/* Engagement search */}
      <div className="relative">
        <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted pointer-events-none" />
        <input
          className="input pl-7 py-1.5 text-xs w-full"
          placeholder="Engagement 검색 (프로젝트명, 고객사, 해시태그…)"
          value={engSearch}
          onChange={e => setEngSearch(e.target.value)}
        />
      </div>

      {/* Count summary */}
      <p className="text-[11px] text-muted -mt-1">
        {engSearch.trim()
          ? `${filteredEntries.length} / ${entries.length}건`
          : `${entries.length}건`}
        · Pipeline 제외 · Open/Closed 전체
      </p>

      {/* PRD V-19: entry list + right-side detail panel — same master-detail split as
          Engagement 검색 (§5.8 HashtagPage), reusing WorkItemDetailPanel as-is. */}
      <div className="flex items-start gap-4">
        <div className={detailWI ? 'w-72 flex-shrink-0 space-y-3' : 'flex-1 space-y-3'}>
          {filteredEntries.length === 0 ? (
            <div className="text-center py-12 text-muted text-sm">
              {entries.length === 0 ? emptyMsg : '검색 결과 없음'}
            </div>
          ) : (
            filteredEntries.map(e => {
              const selected = detailWI?.id === e.workItem.id
              return (
                <article
                  key={e.workItem.id}
                  onClick={() => setDetailWI(e.workItem)}
                  className={[
                    'rounded-lg border p-4 space-y-2 cursor-pointer transition-colors',
                    selected
                      ? 'border-brand-500 bg-brand-50 shadow-card'
                      : 'border-border hover:border-brand-300 hover:bg-surface-50',
                  ].join(' ')}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-1.5 min-w-0">
                      {e.workItem.type === 'proposal' && (
                        <span className="pill bg-sky-100 text-sky-700 text-[10px] flex-shrink-0">제안서</span>
                      )}
                      <h3 className="text-sm font-semibold text-gray-900 truncate">{e.workItem.name}</h3>
                    </div>
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
              )
            })
          )}
        </div>

        {detailWI && (
          <div className="flex-1 min-w-0 rounded-lg border border-border overflow-hidden bg-surface-0">
            <WorkItemDetailPanel
              wi={detailWI}
              assignments={allAssignments}
              peopleMap={peopleMap}
              colorMap={colorMap}
              onClose={() => setDetailWI(null)}
            />
          </div>
        )}
      </div>
    </>
  )

  if (inline) {
    // V-19: widened from max-w-3xl so the list+detail split (§5.8 layout) has room.
    return <div className="p-6 space-y-4 max-w-4xl">{content}</div>
  }

  return (
    <Modal title={`${person.name} — CV`} onClose={onClose!} size="xl">
      {content}
    </Modal>
  )
}
