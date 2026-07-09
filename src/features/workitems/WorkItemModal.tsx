import { useState, useRef, useMemo, type FormEvent, type KeyboardEvent } from 'react'
import { Loader2, Trash2, X as XIcon, LockKeyhole } from 'lucide-react'
import Modal from '@/components/Modal'
import { useCreateWorkItem, useUpdateWorkItem, useDeleteWorkItem } from './hooks'
import { useHistory } from '@/lib/history'
import { makeWorkItemCreate, makeWorkItemUpdate, makeWorkItemDelete } from '@/lib/historyOps'
import type { WorkItem, WorkItemType } from '@/types'

const WI_TYPES: { value: WorkItemType; label: string }[] = [
  { value: 'project',  label: 'Project'  },
  { value: 'proposal', label: 'Proposal' },
  { value: 'pipeline', label: 'Pipeline' },
]

// §9.1 PRD v2.3 — type button active colors match the type family (blue/amber/gray)
const TYPE_ACTIVE_BG: Record<WorkItemType, string> = {
  project:  'bg-blue-700',
  proposal: 'bg-amber-600',
  pipeline: 'bg-red-700',
}

interface Props {
  workItem?:        WorkItem   // undefined → create mode
  readOnly:         boolean
  canToggleStatus?: boolean    // allow toggling Open/Closed even when readOnly (W-4)
  lockedMessage?:   string     // shown when read-only due to Closed status (not role)
  onClose:          () => void
}

export default function WorkItemModal({ workItem, readOnly, canToggleStatus, lockedMessage, onClose }: Props) {
  const isEdit = !!workItem
  const create = useCreateWorkItem()
  const update = useUpdateWorkItem()
  const remove = useDeleteWorkItem()
  const { push } = useHistory()

  const initType = (workItem?.type ?? 'project') as WorkItemType
  const [form, setForm] = useState({
    type:               initType,
    name:                workItem?.name        ?? '',
    start:               workItem?.start       ?? '',
    main_start:          workItem?.main_start  ?? '',
    end_date:            workItem?.end_date    ?? '',
    engagement_number:   workItem?.engagement_number ?? '',
    client:              workItem?.client      ?? '',
    description:         workItem?.description ?? '',
    hashtags:            workItem?.hashtags    ?? [] as string[],
    // status: 전 유형 공통 (PRD v2.4 §3). 구 project_status 에서 이관.
    status:             (workItem?.status ?? workItem?.project_status ?? 'open') as 'open' | 'closed',
    confidential:        workItem?.confidential ?? false,
  })
  const [hashInput, setHashInput] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const hashInputRef = useRef<HTMLInputElement>(null)

  const engWarn = useMemo(() => {
    const v = form.engagement_number.trim()
    return v && !/^(?:E-\d{8}|C\d{6}[A-Z]{2})$/.test(v) ? '형식 권장: E-00000000 또는 C000000AA' : null
  }, [form.engagement_number])

  // ── Hashtag helpers ────────────────────────────────────────

  function commitHashInput() {
    const tag = hashInput.trim().replace(/^#/, '').trim()
    if (tag && !form.hashtags.includes(tag)) {
      setForm(f => ({ ...f, hashtags: [...f.hashtags, tag] }))
    }
    setHashInput('')
  }

  function handleHashKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === ' ' || e.key === ',' || e.key === 'Enter') {
      e.preventDefault()
      commitHashInput()
    } else if (e.key === 'Backspace' && hashInput === '' && form.hashtags.length > 0) {
      setForm(f => ({ ...f, hashtags: f.hashtags.slice(0, -1) }))
    }
  }

  function removeTag(tag: string) {
    setForm(f => ({ ...f, hashtags: f.hashtags.filter(t => t !== tag) }))
  }

  // ── Validation ─────────────────────────────────────────────

  function validate(): string | null {
    if (form.start && form.end_date && form.start > form.end_date)
      return 'Start date must be before or equal to end date'
    if (form.type === 'project' && form.main_start) {
      if (form.start && form.main_start < form.start)
        return 'Main start must be ≥ overall start'
      if (form.end_date && form.main_start > form.end_date)
        return 'Main start must be ≤ end date'
    }
    return null
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    commitHashInput()
    setErr(null)
    const ve = validate()
    if (ve) { setErr(ve); return }

    // project_status is only sent for project type (column added in migration 0006).
    // Proposal and pipeline rows omit it entirely so the DB uses DEFAULT NULL
    // (migration 0008 changes the DEFAULT from 'open' to NULL).
    const payload: Record<string, unknown> = {
      type:              form.type,
      name:              form.name,
      start:             form.start,
      main_start:        form.type === 'project' && form.main_start ? form.main_start : null,
      end_date:          form.end_date,
      engagement_number: form.engagement_number || null,
      client:            form.client            || null,
      description:       form.description || null,
      hashtags:          form.hashtags,
      confidential:      form.confidential,
      status:            form.status,
    }
    try {
      if (isEdit) {
        await update.mutateAsync({ id: workItem.id, ...payload } as any)
        push(makeWorkItemUpdate(workItem, payload))
      } else {
        const created = await create.mutateAsync(payload as any)
        push(makeWorkItemCreate(created))
      }
      onClose()
    } catch (err) {
      setErr(err instanceof Error ? err.message : 'Save failed')
    }
  }

  async function handleDelete() {
    if (!isEdit) return
    if (!confirm(`Delete "${workItem.name}" and all its assignments?`)) return
    const target = workItem
    try {
      await remove.mutateAsync(target.id)
      push(makeWorkItemDelete(target))
      onClose()
    } catch (err) {
      setErr(err instanceof Error ? err.message : 'Delete failed')
    }
  }

  const isPending = create.isPending || update.isPending

  return (
    <Modal title={isEdit ? 'Edit Work Item' : 'New Work Item'} onClose={onClose} size="lg">
      <form onSubmit={handleSubmit} className="space-y-4">
        {/* Closed lock banner (W-4) */}
        {readOnly && lockedMessage && (
          <div className="flex items-center gap-2 rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-600">
            <LockKeyhole size={13} className="flex-shrink-0 text-gray-400" />
            {lockedMessage}
          </div>
        )}
        {/* Type */}
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-700">Type *</label>
          <div className="flex rounded-md overflow-hidden border border-border">
            {WI_TYPES.map(t => {
              const isActive = form.type === t.value
              return (
                <button
                  key={t.value}
                  type="button"
                  disabled={readOnly}
                  onClick={() => setForm(f => ({ ...f, type: t.value }))}
                  className={[
                    'flex-1 py-2 text-xs font-medium transition-colors',
                    isActive ? `${TYPE_ACTIVE_BG[t.value]} text-white` : 'bg-white text-gray-700 hover:bg-surface-50',
                    readOnly ? 'cursor-default' : '',
                  ].join(' ')}
                >
                  {t.label}
                </button>
              )
            })}
          </div>
        </div>

        {/* Name */}
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-700">Name *</label>
          <input
            required
            className="input"
            value={form.name}
            onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
            disabled={readOnly}
            placeholder="Work item name"
          />
        </div>

        {/* Dates */}
        <div className="grid grid-cols-3 gap-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-700">
              Overall Start *
            </label>
            <input
              required type="date" className="input"
              value={form.start}
              onChange={e => setForm(f => ({ ...f, start: e.target.value }))}
              disabled={readOnly}
            />
          </div>
          {form.type === 'project' && (
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-700">
                Main Phase Start
                <span className="ml-1 text-[10px] text-muted">(project only)</span>
              </label>
              <input
                type="date" className="input"
                value={form.main_start}
                onChange={e => setForm(f => ({ ...f, main_start: e.target.value }))}
                disabled={readOnly}
              />
            </div>
          )}
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-700">End Date *</label>
            <input
              required type="date" className="input"
              value={form.end_date}
              onChange={e => setForm(f => ({ ...f, end_date: e.target.value }))}
              disabled={readOnly}
            />
          </div>
        </div>

        {/* Status — 전 유형 공통 (PRD v2.4 §3) */}
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-700">상태</label>
          <div className="flex w-48 rounded-md overflow-hidden border border-border">
            {(['open', 'closed'] as const).map(s => (
              <button
                key={s}
                type="button"
                disabled={readOnly && !canToggleStatus}
                onClick={async () => {
                  if (readOnly && canToggleStatus && isEdit) {
                    try {
                      await update.mutateAsync({ id: workItem!.id, status: s } as any)
                      push(makeWorkItemUpdate(workItem!, { status: s }))
                      onClose()
                    } catch (e) {
                      setErr(e instanceof Error ? e.message : 'Failed')
                    }
                  } else {
                    setForm(f => ({ ...f, status: s }))
                  }
                }}
                className={[
                  'flex-1 py-2 text-xs font-medium transition-colors',
                  form.status === s
                    ? s === 'open'
                      ? 'bg-emerald-500 text-white'
                      : 'bg-gray-500 text-white'
                    : 'bg-white text-gray-700 hover:bg-surface-50',
                  (readOnly && !canToggleStatus) ? 'cursor-default' : '',
                ].join(' ')}
              >
                {s === 'open' ? 'Open' : 'Closed'}
              </button>
            ))}
          </div>
        </div>

        {/* Engagement & Client */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-700">
              Engagement No.
            </label>
            <input
              className="input"
              value={form.engagement_number}
              onChange={e => setForm(f => ({ ...f, engagement_number: e.target.value }))}
              disabled={readOnly}
              placeholder="E-00000000 / C000000AA"
            />
            {engWarn && !readOnly && (
              <p className="mt-1 text-[11px] text-amber-600">{engWarn}</p>
            )}
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-700">Client</label>
            <input
              className="input"
              value={form.client}
              onChange={e => setForm(f => ({ ...f, client: e.target.value }))}
              disabled={readOnly}
              placeholder="Client name"
            />
          </div>
        </div>

        {/* Description */}
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-700">
            Description
            <span className="ml-1 text-[10px] text-muted">선택</span>
          </label>
          <textarea
            className="input resize-none"
            rows={3}
            value={form.description}
            onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
            disabled={readOnly}
            placeholder="업무 배경, 범위, 특이사항 등…"
          />
        </div>

        {/* Confidential */}
        <label className={[
          'flex items-start gap-2.5 rounded-lg border p-3 transition-colors cursor-pointer',
          form.confidential
            ? 'border-amber-300 bg-amber-50'
            : 'border-border bg-surface-50 hover:bg-surface-100',
          readOnly ? 'cursor-default' : '',
        ].join(' ')}>
          <input
            type="checkbox"
            checked={form.confidential}
            onChange={e => !readOnly && setForm(f => ({ ...f, confidential: e.target.checked }))}
            disabled={readOnly}
            className="mt-0.5 accent-amber-500 w-4 h-4 flex-shrink-0"
          />
          <div>
            <div className="text-sm font-medium text-gray-800">
              기밀 (Confidential)
            </div>
            <div className="text-[11px] text-muted mt-0.5">
              비-editor에게 작업명·고객사·설명·해시태그·Engagement No.를 마스킹합니다
            </div>
          </div>
        </label>

        {/* Hashtags */}
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-700">
            Hashtags
            <span className="ml-1 text-[10px] text-muted">space or comma to add</span>
          </label>
          <div
            className="flex flex-wrap gap-1.5 rounded-md border border-border bg-white p-2 min-h-[38px] cursor-text"
            onClick={() => hashInputRef.current?.focus()}
          >
            {form.hashtags.map(tag => (
              <span
                key={tag}
                className="inline-flex items-center gap-1 rounded-full bg-brand-100 text-brand-700 px-2 py-0.5 text-xs font-medium"
              >
                #{tag}
                {!readOnly && (
                  <button
                    type="button"
                    onClick={e => { e.stopPropagation(); removeTag(tag) }}
                    className="hover:text-brand-900 leading-none"
                  >
                    <XIcon size={10} />
                  </button>
                )}
              </span>
            ))}
            {!readOnly && (
              <input
                ref={hashInputRef}
                className="flex-1 min-w-[80px] text-sm outline-none bg-transparent placeholder:text-muted"
                placeholder={form.hashtags.length === 0 ? 'strategy, digital, …' : ''}
                value={hashInput}
                onChange={e => setHashInput(e.target.value)}
                onKeyDown={handleHashKey}
                onBlur={commitHashInput}
              />
            )}
          </div>
        </div>

        {err && (
          <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{err}</div>
        )}

        {/* Actions */}
        {!readOnly ? (
          <div className="flex gap-2 pt-1">
            <button type="submit" disabled={isPending} className="btn-primary flex-1">
              {isPending ? <Loader2 size={14} className="animate-spin" /> : isEdit ? 'Save' : 'Create'}
            </button>
            {isEdit && (
              <button type="button" onClick={handleDelete} disabled={remove.isPending} className="btn-danger">
                <Trash2 size={14} />
              </button>
            )}
            <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
          </div>
        ) : (
          <div className="flex gap-2 pt-1">
            <button type="button" onClick={onClose} className="btn-secondary w-full">Close</button>
          </div>
        )}
      </form>
    </Modal>
  )
}
