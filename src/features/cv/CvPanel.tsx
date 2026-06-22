/**
 * CvPanel — per-person CV panel (PRD §5.9)
 *
 * - 기본: project 유형만 표시 (pipeline 항상 제외)
 * - 토글: "제안서 포함" 시 proposal도 표시
 * - Open/Closed 무관 전체 표시
 * - 읽기: work_items_safe 뷰 사용 (기밀 마스킹)
 */
import { useState, useMemo } from 'react'
import { Download } from 'lucide-react'
import Modal from '@/components/Modal'
import { useAllWorkItems } from '@/features/workitems/hooks'
import { useAssignmentsByPerson } from '@/features/timeline/hooks'
import { useAuthz } from '@/hooks/useAuthz'
import type { Person, WorkItem, Assignment } from '@/types'

// ── CV entry (one row per project / proposal) ─────────────────

export interface CvEntry {
  workItem: WorkItem
  start:    string    // earliest assignment start for this person
  end:      string    // latest assignment end_date for this person
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

      // §5.9 V-1: for projects with a pre-study phase, use (assignment ∩ main phase).
      // If the person only participated in pre-study, exclude this project from CV.
      if (w.type === 'project' && w.main_start) {
        const mainStart = w.main_start   // "YYYY-MM-DD" — start of main phase
        const mainEnd   = w.end_date     // "YYYY-MM-DD" — end of main phase

        // Keep only assignments that overlap the main phase
        const mainMine = mine.filter(
          a => a.start <= mainEnd && a.end_date >= mainStart,
        )
        if (mainMine.length === 0) return []  // pre-study only → exclude

        // Clamp each assignment to main phase boundaries
        const start = mainMine
          .map(a => (a.start >= mainStart ? a.start : mainStart))
          .sort()[0]
        const end   = mainMine
          .map(a => (a.end_date <= mainEnd ? a.end_date : mainEnd))
          .sort().reverse()[0]

        return [{ workItem: w, start, end }]
      }

      // Proposals and projects without pre-study: use full assignment range
      const start = mine.map(a => a.start).sort()[0]
      const end   = mine.map(a => a.end_date).sort().reverse()[0]
      return [{ workItem: w, start, end }]
    })
    .sort((a, b) => b.end.localeCompare(a.end))
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
        <dt>Period</dt><dd>${e.start} – ${e.end}</dd>
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

  // Default: projects only; toggle to also include proposals
  const [includeProposal, setIncludeProposal] = useState(false)

  const entries = useMemo(
    () => computeCv(person.id, workItems, assignments, includeProposal),
    [person.id, workItems, assignments, includeProposal],
  )

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
    const html    = generateHtml(person, entries, includeProposal)
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
        <div className="flex items-center gap-2">
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
          <button onClick={handleDownload} className="btn-primary gap-1.5 text-xs">
            <Download size={13} /> Download HTML
          </button>
        </div>
      </div>

      {/* Count summary */}
      <p className="text-[11px] text-muted -mt-1">
        {entries.length}건 · Pipeline 제외 · Open/Closed 전체
      </p>

      {/* Entry list */}
      {entries.length === 0 ? (
        <div className="text-center py-12 text-muted text-sm">{emptyMsg}</div>
      ) : (
        <div className="space-y-3">
          {entries.map(e => (
            <article key={e.workItem.id} className="rounded-lg border border-border p-4 space-y-2">
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-1.5 min-w-0">
                  {e.workItem.type === 'proposal' && (
                    <span className="pill bg-sky-100 text-sky-700 text-[10px] flex-shrink-0">제안서</span>
                  )}
                  <h3 className="text-sm font-semibold text-gray-900 truncate">{e.workItem.name}</h3>
                </div>
                <span className="flex-shrink-0 font-mono text-xs text-muted">
                  {e.start} – {e.end}
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
      )}
    </>
  )

  if (inline) {
    return <div className="p-6 space-y-4 max-w-3xl">{content}</div>
  }

  return (
    <Modal title={`${person.name} — CV`} onClose={onClose!} size="lg">
      {content}
    </Modal>
  )
}
