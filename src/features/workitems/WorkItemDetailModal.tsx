import { useMemo } from 'react'
import { Pencil, Lock, Tag, CalendarRange, Building2, Hash, Users, LockKeyhole } from 'lucide-react'
import Modal from '@/components/Modal'
import { useUpdateWorkItem } from './hooks'
import { useHistory } from '@/lib/history'
import { makeWorkItemUpdate } from '@/lib/historyOps'
import { dateToNum, numToStr, prevWorkday } from '@/lib/date'
import { RANK_ORDER } from '@/features/timeline/constants'
import { TYPE_FAMILY } from '@/lib/colors'
import type { WorkItem, Person, Assignment } from '@/types'

// ── Type labels / badges ──────────────────────────────────────

const TYPE_LABEL: Record<string, string> = {
  project:  'Project',
  proposal: 'Proposal',
  pipeline: 'Pipeline',
}
const TYPE_CLS: Record<string, string> = {
  project:  'bg-blue-100 text-blue-700',
  proposal: 'bg-amber-100 text-amber-700',
  pipeline: 'bg-red-100 text-red-700',
}

// ── Participant computation ───────────────────────────────────

interface Participant {
  person:    Person
  mainStart: string
  mainEnd:   string
}

function computeParticipants(
  wi: WorkItem,
  assignments: Assignment[],
  peopleMap: Map<string, Person>,
): Participant[] {
  const mainS = wi.main_start ? dateToNum(wi.main_start) : dateToNum(wi.start)
  const mainE = dateToNum(wi.end_date)

  const byPerson = new Map<string, { s: number; e: number }>()
  for (const a of assignments) {
    if (a.work_item_id !== wi.id || a.kind !== 'work') continue
    const iS = Math.max(dateToNum(a.start),    mainS)
    const iE = Math.min(dateToNum(a.end_date), mainE)
    if (iS > iE) continue
    const prev = byPerson.get(a.person_id)
    byPerson.set(a.person_id, prev
      ? { s: Math.min(prev.s, iS), e: Math.max(prev.e, iE) }
      : { s: iS, e: iE })
  }

  return [...byPerson.entries()]
    .map(([pid, { s, e }]) => {
      const person = peopleMap.get(pid)
      if (!person) return null
      return { person, mainStart: numToStr(s), mainEnd: numToStr(e) }
    })
    .filter((p): p is Participant => p !== null)
    .sort((a, b) => {
      const ro = (RANK_ORDER[a.person.rank] ?? 99) - (RANK_ORDER[b.person.rank] ?? 99)
      return ro !== 0 ? ro : a.person.name.localeCompare(b.person.name, 'ko')
    })
}

// ── Component ─────────────────────────────────────────────────

interface Props {
  workItem:         WorkItem
  assignments:      Assignment[]
  peopleMap:        Map<string, Person>
  colorMap:         Map<string, string>
  canEdit:          boolean   // full edit: role OK + item open
  canToggleStatus?: boolean   // may toggle Open/Closed (role OK, ignores closed state)
  isHoliday?:       (n: number) => boolean  // v2.95: Pre-study 종료일(main_start 직전 영업일) 계산용
  onClose:          () => void
  onEdit?:          () => void  // v2.95: 없으면 편집 버튼을 렌더링하지 않음(호출부가 실제 편집 경로를 안 가진 경우)
}

export default function WorkItemDetailModal({
  workItem: wi, assignments, peopleMap, colorMap, canEdit, canToggleStatus = canEdit,
  isHoliday = () => false, onClose, onEdit,
}: Props) {
  const update = useUpdateWorkItem()
  const { push } = useHistory()

  const color    = colorMap.get(wi.id) ?? (TYPE_FAMILY[wi.type]?.[0] ?? '#2563eb')
  const status   = wi.status ?? wi.project_status ?? 'open'
  // work_items_safe may mask `confidential` field itself for viewers, so also detect masking from name
  const masked   = !canEdit && (!!wi.confidential || wi.name === '(비공개)')

  const participants = useMemo(
    () => computeParticipants(wi, assignments, peopleMap),
    [wi, assignments, peopleMap],
  )

  async function toggleStatus() {
    const next = status === 'open' ? 'closed' : 'open'
    await update.mutateAsync({ id: wi.id, status: next } as any)
    push(makeWorkItemUpdate(wi, { status: next }))
  }

  return (
    <Modal title="Work Item 상세" onClose={onClose} size="lg">

      {/* ── Closed lock banner (W-4) — v2.95: only mention editing when a real edit path exists ── */}
      {status === 'closed' && canToggleStatus && (
        <div className="flex items-center gap-2 rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-600">
          <LockKeyhole size={13} className="flex-shrink-0 text-gray-400" />
          <span>
            Closed 상태입니다. 위 상태 배지를 클릭해 <strong>Open</strong>으로 전환하면{onEdit ? ' 편집할 수 있습니다.' : ' 상태를 변경할 수 있습니다.'}
          </span>
        </div>
      )}

      {/* ── Header ─────────────────────────────────────────── */}
      <div className="flex items-start gap-3">
        {/* Left color accent */}
        <div style={{ width: 4, minHeight: 52, background: color, borderRadius: 2, flexShrink: 0, marginTop: 2 }} />

        <div className="flex-1 min-w-0">
          {/* Badge row */}
          <div className="flex flex-wrap items-center gap-2 mb-1.5">
            <span className={`pill text-xs font-semibold ${TYPE_CLS[wi.type] ?? 'bg-gray-100 text-gray-600'}`}>
              {TYPE_LABEL[wi.type] ?? wi.type}
            </span>

            {canToggleStatus ? (
              <button
                onClick={() => void toggleStatus()}
                disabled={update.isPending}
                title="클릭하여 Open/Closed 전환"
                className={[
                  'pill text-xs font-semibold transition-colors',
                  status === 'open'
                    ? 'bg-emerald-100 text-emerald-700 hover:bg-emerald-200'
                    : 'bg-gray-100 text-gray-500 hover:bg-gray-200',
                ].join(' ')}
              >
                {status === 'open' ? 'Open' : 'Closed'}
              </button>
            ) : (
              <span className={`pill text-xs ${status === 'open' ? 'bg-emerald-100 text-emerald-700' : 'bg-gray-100 text-gray-500'}`}>
                {status === 'open' ? 'Open' : 'Closed'}
              </span>
            )}

            {wi.confidential && (
              <span className="flex items-center gap-0.5 pill bg-amber-100 text-amber-700 text-xs">
                <Lock size={10} />
                {masked ? '비공개' : '비공개 (편집자 공개)'}
              </span>
            )}
          </div>

          {/* Name */}
          <h3 className={`text-base font-semibold break-words ${masked ? 'text-muted italic' : 'text-gray-900'}`}>
            {wi.name}
          </h3>

          {/* Client + Engagement No. */}
          <div className="flex flex-wrap gap-x-4 mt-0.5">
            {wi.client && (
              <span className="flex items-center gap-1 text-xs text-muted">
                <Building2 size={11} />{wi.client}
              </span>
            )}
            {wi.engagement_number && (
              <span className="flex items-center gap-1 text-xs text-muted font-mono">
                <Hash size={11} />{wi.engagement_number}
              </span>
            )}
            {!wi.client && !wi.engagement_number && (
              <span className="text-xs text-muted/60">—</span>
            )}
          </div>
        </div>

        {/* Edit button — editor/admin only (W-4: disabled when Closed); v2.95: only if caller has a real edit path */}
        {canToggleStatus && onEdit && (
          status === 'open' ? (
            <button onClick={onEdit} className="btn-secondary flex items-center gap-1.5 text-xs flex-shrink-0">
              <Pencil size={12} />편집
            </button>
          ) : (
            <button
              disabled
              title="Open으로 전환 후 편집 가능"
              className="btn-secondary flex items-center gap-1.5 text-xs flex-shrink-0 opacity-40 cursor-not-allowed"
            >
              <LockKeyhole size={12} />편집
            </button>
          )
        )}
      </div>

      {/* ── Period ─────────────────────────────────────────── */}
      <div className="rounded-md bg-surface-50 border border-border px-4 py-3 space-y-1.5">
        <p className="flex items-center gap-1.5 text-xs font-semibold text-gray-600">
          <CalendarRange size={12} />기간
        </p>
        {wi.main_start && wi.main_start > wi.start ? (
          <div className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-xs">
            <span className="text-muted">Pre-study</span>
            {/* v2.95: Pre-study 종료일 = main_start 직전 마지막 영업일 (본 프로젝트와 하루도 겹치지 않게) */}
            <span className="font-mono text-gray-700">{wi.start} ~ {numToStr(prevWorkday(dateToNum(wi.main_start), isHoliday))}</span>
            <span className="text-muted">본 프로젝트</span>
            <span className="font-mono text-gray-700">{wi.main_start} ~ {wi.end_date}</span>
          </div>
        ) : (
          <p className="text-xs font-mono text-gray-700">{wi.start} ~ {wi.end_date}</p>
        )}
      </div>

      {/* ── Description ────────────────────────────────────── */}
      {wi.description && (
        <div>
          <p className="text-xs font-semibold text-gray-600 mb-1.5">Description</p>
          <p className="text-sm text-gray-700 whitespace-pre-wrap leading-relaxed">{wi.description}</p>
        </div>
      )}

      {/* ── Hashtags ───────────────────────────────────────── */}
      {wi.hashtags.length > 0 && (
        <div className="flex flex-wrap gap-1.5 items-center">
          <Tag size={12} className="text-muted flex-shrink-0" />
          {wi.hashtags.map(h => (
            <span key={h} className="pill bg-surface-100 text-muted text-xs">#{h}</span>
          ))}
        </div>
      )}

      {/* ── Participants ────────────────────────────────────── */}
      <div>
        <p className="flex items-center gap-1.5 text-xs font-semibold text-gray-600 mb-2">
          <Users size={12} />참여 인력
          <span className="font-normal text-muted">({participants.length}명)</span>
        </p>
        {participants.length === 0 ? (
          <p className="text-xs text-muted">배정된 인력이 없습니다.</p>
        ) : (
          <div className="divide-y divide-border rounded-md border border-border overflow-hidden">
            {participants.map(({ person: p, mainStart, mainEnd }) => (
              <div key={p.id} className="flex items-center gap-3 px-3 py-2 bg-surface-0 hover:bg-surface-50 transition-colors">
                <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-brand-100 text-brand-700 text-xs font-semibold">
                  {p.name.charAt(0)}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium text-gray-900 truncate">{p.name}</p>
                  <p className="text-[11px] text-muted">{p.rank}{p.role ? ` · ${p.role}` : ''}</p>
                </div>
                <p className="text-[11px] text-muted font-mono whitespace-nowrap">
                  {mainStart} ~ {mainEnd}
                </p>
              </div>
            ))}
          </div>
        )}
      </div>

    </Modal>
  )
}
