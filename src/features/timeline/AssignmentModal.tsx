/**
 * AssignmentModal — create / edit / view an Assignment.
 *
 * Features added beyond the draft version:
 *   • kind=work: selecting a work item auto-fills start/end dates (editable)
 *   • Weekend actual-workday picker: Sat/Sun -> 0.5, non-weekend holiday -> 1.0 (S7 rule2)
 *   • Leave type dropdown with paid/unpaid label
 *   • Date validation: start ≤ end
 *   • Read-only mode (no save button) when readOnly=true
 */
import { useState, useEffect, useMemo, type FormEvent } from 'react'
import { Loader2, Trash2, Plus, X as XIcon } from 'lucide-react'
import { dateToNum, numToStr, isWeekend, numToDate, nextWorkday, weekendHolidayAccrual } from '@/lib/date'
import Modal                            from '@/components/Modal'
import { useAllHolidays, useLeaveTypes }  from '@/features/admin/hooks'
import { useCreateAssignment, useUpdateAssignment, useDeleteAssignment } from './hooks'
import { useHistory }  from '@/lib/history'
import { makeAssignmentCreate, makeAssignmentModalEdit, makeAssignmentDelete, combine } from '@/lib/historyOps'
import type { HistoryEntry } from '@/lib/history'
import type { WorkItem, Person, Assignment, Accrual, LeaveType } from '@/types'
import { computeSpecialLeaveBalance, hasAssignmentOverlap } from '@/features/leave/validateLeave'
import type { ModalState } from './types'

// ── Leave paid/unpaid metadata (client-side; not stored in DB) ──
const LEAVE_PAID: Record<string, boolean> = {
  '리프레시':          false,
  '지정휴가':          true,
  '프로젝트휴가':      true,
  '주말/휴일대체':     true,
  '포상휴가':          true,
  '특별휴가':          true,
  '지연보상':          true,
  '휴직':              false,
  '종료 후 잔여 소진': true,
}

// ── Weekend date picker ───────────────────────────────────────

interface WeekendPickerProps {
  value:      string[]
  onChange:   (dates: string[]) => void
  holidaySet: Set<number>
  disabled:   boolean
}

function WeekendPicker({ value, onChange, holidaySet, disabled }: WeekendPickerProps) {
  const [input, setInput] = useState('')
  const [pickerErr, setPickerErr] = useState<string | null>(null)

  function dayValue(dateStr: string): 0 | 0.5 | 1.0 {
    return weekendHolidayAccrual(dateToNum(dateStr), n => holidaySet.has(n))
  }

  function addDate() {
    if (!input) return
    const n = dateToNum(input)
    if (!isWeekend(n) && !holidaySet.has(n)) {
      setPickerErr('주말 또는 공휴일만 추가할 수 있습니다')
      return
    }
    if (value.includes(input)) {
      setPickerErr('이미 추가된 날짜입니다')
      return
    }
    onChange([...value, input].sort())
    setInput('')
    setPickerErr(null)
  }

  const totalDays = value.reduce((s, d) => s + dayValue(d), 0)

  return (
    <div className="space-y-2">
      {/* Chip list */}
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {value.map(d => (
            <span
              key={d}
              className="inline-flex items-center gap-1 rounded-full bg-violet-100 text-violet-700 px-2 py-0.5 text-xs font-medium"
            >
              {d}
              <span className="opacity-70">(+{dayValue(d)})</span>
              {!disabled && (
                <button
                  type="button"
                  onClick={() => onChange(value.filter(x => x !== d))}
                  className="hover:text-violet-900"
                >
                  <XIcon size={10} />
                </button>
              )}
            </span>
          ))}
          <span className="text-xs text-muted self-center">
            합계 {totalDays}일
          </span>
        </div>
      )}

      {/* Add row */}
      {!disabled && (
        <div className="flex gap-2 items-start">
          <div className="flex-1">
            <input
              type="date"
              className="input"
              value={input}
              onChange={e => { setInput(e.target.value); setPickerErr(null) }}
            />
            {pickerErr && (
              <p className="mt-1 text-xs text-red-600">{pickerErr}</p>
            )}
          </div>
          <button type="button" onClick={addDate} className="btn-secondary gap-1 flex-shrink-0">
            <Plus size={13} /> Add
          </button>
        </div>
      )}
      <p className="text-[11px] text-muted">
        토요일·일요일 = +0.5일, 공휴일(평일) = +1.0일
      </p>
    </div>
  )
}

// ── Main modal ────────────────────────────────────────────────

interface Props {
  state:           ModalState
  people:          Person[]
  workItems:       WorkItem[]
  accruals:        Accrual[]       // LV-6: used for 특별휴가 balance check
  assignments:     Assignment[]    // LV-6: used for 특별휴가 balance check
  canEditPipeline: boolean   // hides pipeline items in selector when false
  readOnly?:       boolean   // true → view only (no save button)
  onClose:         () => void
  // E-5: called after save when assignment is kind=work; returns HistoryEntry or null
  onWorkItemExpand?: (wiId: string, newStart: string, newEnd: string) => HistoryEntry | null
}

export default function AssignmentModal({
  state, people, workItems, accruals, assignments, canEditPipeline, readOnly = false, onClose, onWorkItemExpand,
}: Props) {
  const create = useCreateAssignment()
  const update = useUpdateAssignment()
  const remove = useDeleteAssignment()
  const { push } = useHistory()

  const { data: holidays    = [] } = useAllHolidays()
  const { data: leaveTypeRows = [] } = useLeaveTypes()

  // Active DB types (sort_order asc) + '종료 후 잔여 소진' pinned last (not in master table)
  const leaveOptions = useMemo(
    () => [
      ...leaveTypeRows.filter(lt => lt.active),
      { name: '종료 후 잔여 소진', active: true, sort_order: 99 },
    ],
    [leaveTypeRows],
  )
  const holidaySet = useMemo(() => {
    const s = new Set<number>()
    for (const h of holidays) {
      const base = dateToNum(h.date)
      if (!h.recurring) {
        s.add(base)
      } else {
        const d  = numToDate(base)
        const yr = new Date().getFullYear()
        for (let y = yr - 2; y <= yr + 3; y++) {
          s.add(dateToNum(new Date(Date.UTC(y, d.getUTCMonth(), d.getUTCDate()))))
        }
      }
    }
    return s
  }, [holidays])

  const blankForm = () => ({
    personId:     state.prefill.personId    ?? '',
    kind:         (state.prefill.kind       ?? 'work') as 'work' | 'leave',
    workItemId:   state.prefill.workItemId  ?? '',
    leaveType:    (state.prefill.leaveType ?? '') as LeaveType | '',
    start:        state.prefill.startNum != null ? numToStr(state.prefill.startNum) : '',
    end:          state.prefill.endNum   != null ? numToStr(state.prefill.endNum)   : '',
    weekendDates: [] as string[],
    note:         '',
    dailyHours:   '',
  })

  const [form, setForm] = useState(blankForm)
  const [err, setErr] = useState<string | null>(null)
  // Track whether user has manually overridden the auto-filled dates
  const [datesLocked, setDatesLocked] = useState(false)

  // Re-initialize form every time the modal opens in create mode.
  // AssignmentModal is always mounted (never unmounts), so useState() only
  // runs once. Without this effect the form keeps stale data from a previous
  // open, causing the "person not selected" bug when clicking a person row.
  useEffect(() => {
    if (!state.open || state.mode !== 'create') return
    setForm(blankForm())
    setDatesLocked(false)
    setErr(null)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.open, state.prefill])

  // Populate form in edit mode
  useEffect(() => {
    if (state.mode === 'edit' && state.editTarget) {
      const a = state.editTarget
      setForm({
        personId:     a.person_id,
        kind:         a.kind,
        workItemId:   a.work_item_id  ?? '',
        leaveType:    a.leave_type    ?? '',
        start:        a.start,
        end:          a.end_date,
        weekendDates: a.weekend_dates ?? [],
        note:         a.note          ?? '',
        dailyHours:   a.daily_hours != null ? String(a.daily_hours) : '',
      })
      setDatesLocked(true)  // edit mode: don't auto-fill dates
    }
    setErr(null)
  }, [state.editTarget, state.mode])

  // Auto-fill dates when a work item is selected (create mode only)
  useEffect(() => {
    if (state.mode !== 'create' || datesLocked || form.kind !== 'work' || !form.workItemId) return
    const wi = workItems.find(w => w.id === form.workItemId)
    if (wi) {
      setForm(f => ({ ...f, start: wi.start, end: wi.end_date }))
    }
  }, [form.workItemId])  // eslint-disable-line react-hooks/exhaustive-deps

  // §5.3 #5: auto-set start to next workday after last project end when leave type
  // '종료 후 잔여 소진' is selected and prefill carries lastProjectEndNum
  useEffect(() => {
    if (form.leaveType !== '종료 후 잔여 소진') return
    if (state.prefill.lastProjectEndNum == null) return
    const autoStart = numToStr(nextWorkday(state.prefill.lastProjectEndNum, n => holidaySet.has(n)))
    setForm(f => ({ ...f, start: autoStart }))
  }, [form.leaveType])  // eslint-disable-line react-hooks/exhaustive-deps

  // Exclude pipeline (unless authorized) and closed items from creation dropdown.
  // Gantt chart still renders closed rows — only the modal selector is filtered.
  const selectableWorkItems = workItems.filter(w => {
    if (w.type === 'pipeline' && !canEditPipeline) return false
    if ((w.status ?? w.project_status) === 'closed') return false
    return true
  })

  // Active + upcoming people selectable; resigned excluded.
  // Resigned people are kept if already assigned (edit fidelity).
  const selectablePeople = (() => {
    const nonResigned = people.filter(p => p.status !== 'resigned')
    if (form.personId) {
      const sel = people.find(p => p.id === form.personId)
      if (sel && sel.status === 'resigned' && !nonResigned.find(p => p.id === sel.id)) {
        return [...nonResigned, sel]
      }
    }
    return nonResigned
  })()

  function validateDates(): string | null {
    if (form.start && form.end && form.start > form.end)
      return 'Start date must be on or before end date'
    return null
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setErr(null)
    const ve = validateDates()
    if (ve) { setErr(ve); return }

    // LV-6: 특별휴가는 적립 잔여 한도 내에서만 입력 가능
    if (form.kind === 'leave' && form.leaveType === '특별휴가' && form.start && form.end) {
      let reqDays = 0
      const s = dateToNum(form.start), e2 = dateToNum(form.end)
      for (let d = s; d <= e2; d++) {
        if (!isWeekend(d) && !holidaySet.has(d)) reqDays++
      }
      const bal = computeSpecialLeaveBalance(
        form.personId, accruals, assignments, holidaySet,
        state.mode === 'edit' ? state.editTarget?.id : undefined,
      )
      if (reqDays > bal) {
        setErr(`특별휴가 잔여가 부족합니다 (잔여: ${bal}일, 요청: ${reqDays}일)`)
        return
      }
    }

    // E-3a: block overlapping assignments for non-Partner ranks
    if (form.start && form.end) {
      const person = people.find(p => p.id === form.personId)
      if (person && person.rank !== 'Partner') {
        const excludeId = state.mode === 'edit' ? state.editTarget?.id : undefined
        if (hasAssignmentOverlap(form.personId, form.start, form.end, assignments, excludeId)) {
          setErr(`배정 기간이 겹칩니다. ${person.name}(${person.rank})는 중복 배정이 허용되지 않습니다.`)
          return
        }
      }
    }

    const selectedPerson = people.find(p => p.id === form.personId)
    const base = {
      person_id:    form.personId,
      kind:         form.kind,
      work_item_id: form.kind === 'work'  ? (form.workItemId || null) : null,
      leave_type:   form.kind === 'leave' ? (form.leaveType as LeaveType) || null : null,
      start:        form.start,
      end_date:     form.end,
      weekend_dates: form.kind === 'work' ? form.weekendDates : [],
      note:         form.note || null,
      daily_hours:  form.kind === 'work' && selectedPerson?.rank === 'Partner' && form.dailyHours !== ''
        ? (isNaN(parseFloat(form.dailyHours)) ? null : parseFloat(form.dailyHours))
        : null,
    }
    try {
      // E-5: compute work item expansion (fires mutation inside callback, returns HistoryEntry)
      const wiEnt = base.kind === 'work' && base.work_item_id
        ? onWorkItemExpand?.(base.work_item_id, base.start, base.end_date) ?? null
        : null
      if (state.mode === 'create') {
        const created = await create.mutateAsync(base)
        const asgnEnt = makeAssignmentCreate(created)
        push(wiEnt ? combine('배정 생성', asgnEnt, wiEnt) : asgnEnt)
      } else if (state.editTarget) {
        await update.mutateAsync({ id: state.editTarget.id, ...base })
        const asgnEnt = makeAssignmentModalEdit(state.editTarget, base)
        push(wiEnt ? combine('배정 수정', asgnEnt, wiEnt) : asgnEnt)
      }
      onClose()
    } catch (err) {
      setErr(err instanceof Error ? err.message : 'Save failed')
    }
  }

  async function handleDelete() {
    if (!state.editTarget) return
    if (!confirm('Delete this assignment?')) return
    const target = state.editTarget
    try {
      await remove.mutateAsync(target.id)
      push(makeAssignmentDelete(target))
      onClose()
    } catch (err) {
      setErr(err instanceof Error ? err.message : 'Delete failed')
    }
  }

  if (!state.open) return null

  const isEdit    = state.mode === 'edit'
  const isPending = create.isPending || update.isPending
  const effectiveReadOnly = readOnly

  return (
    <Modal
      title={effectiveReadOnly ? 'View Assignment' : isEdit ? 'Edit Assignment' : 'New Assignment'}
      onClose={onClose}
      size="md"
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        {/* Person */}
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-700">Person *</label>
          <select
            required
            className="input"
            value={form.personId}
            disabled={effectiveReadOnly || (!isEdit && !!state.prefill.personId)}
            onChange={e => setForm(f => ({ ...f, personId: e.target.value }))}
          >
            <option value="">— select person —</option>
            {selectablePeople.map(p => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.rank}){p.status !== 'active' ? ` — ${p.status === 'resigned' ? '퇴직' : '입사예정'}` : ''}
              </option>
            ))}
          </select>
        </div>

        {/* Kind toggle */}
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-700">Kind</label>
          <div className="flex rounded-md overflow-hidden border border-border">
            {(['work', 'leave'] as const).map(k => (
              <button
                key={k}
                type="button"
                disabled={effectiveReadOnly}
                onClick={() => setForm(f => ({ ...f, kind: k }))}
                className={[
                  'flex-1 py-2 text-xs font-medium transition-colors',
                  form.kind === k
                    ? 'bg-brand-600 text-white'
                    : 'bg-white text-gray-700 hover:bg-surface-50',
                  effectiveReadOnly ? 'cursor-default' : '',
                ].join(' ')}
              >
                {k === 'work' ? 'Work' : 'Leave'}
              </button>
            ))}
          </div>
        </div>

        {/* ── Work kind fields ── */}
        {form.kind === 'work' && (
          <>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-700">Work Item *</label>
              <select
                required
                className="input"
                value={form.workItemId}
                disabled={effectiveReadOnly || (!!state.prefill.workItemId && !isEdit)}
                onChange={e => {
                  setForm(f => ({ ...f, workItemId: e.target.value }))
                  setDatesLocked(false)   // allow re-fill when user picks new item
                }}
              >
                <option value="">— select work item —</option>
                {selectableWorkItems.map(w => (
                  <option key={w.id} value={w.id}>
                    [{w.type}] {w.name}{w.client ? ` — ${w.client}` : ''}
                  </option>
                ))}
              </select>
            </div>

            {/* Dates (auto-filled, editable) */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-700">Start *</label>
                <input
                  required type="date" className="input"
                  value={form.start}
                  disabled={effectiveReadOnly}
                  onChange={e => {
                    setDatesLocked(true)
                    setForm(f => ({ ...f, start: e.target.value }))
                  }}
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-700">End *</label>
                <input
                  required type="date" className="input"
                  value={form.end}
                  disabled={effectiveReadOnly}
                  onChange={e => {
                    setDatesLocked(true)
                    setForm(f => ({ ...f, end: e.target.value }))
                  }}
                />
              </div>
            </div>

            {/* Partner 하루 투입 시간 (다중 배정 분할용) */}
            {people.find(p => p.id === form.personId)?.rank === 'Partner' && (
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-700">
                  하루 투입 시간
                  <span className="ml-1 text-[10px] text-muted">(다중 배정 시간 분할 — Partner 전용)</span>
                </label>
                <input
                  type="number" min="0" max="24" step="0.5"
                  className="input w-32 text-sm"
                  value={form.dailyHours}
                  disabled={effectiveReadOnly}
                  onChange={e => setForm(f => ({ ...f, dailyHours: e.target.value }))}
                  placeholder="예: 4"
                />
                <p className="mt-0.5 text-[10px] text-muted">설정 시 동일 날짜 다른 배정과 시간 합산. 합계 &lt; 8h이면 NBD로 자동 보충.</p>
              </div>
            )}

            {/* Weekend actual-workday dates */}
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-700">
                Weekend / Holiday Work Dates
                <span className="ml-1 text-[10px] text-muted">(주말·휴일 실근무일)</span>
              </label>
              <WeekendPicker
                value={form.weekendDates}
                onChange={dates => setForm(f => ({ ...f, weekendDates: dates }))}
                holidaySet={holidaySet}
                disabled={effectiveReadOnly}
              />
            </div>
          </>
        )}

        {/* ── Leave kind fields ── */}
        {form.kind === 'leave' && (
          <>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-700">Leave Type *</label>
              <select
                required
                className="input"
                value={form.leaveType}
                disabled={effectiveReadOnly}
                onChange={e => setForm(f => ({ ...f, leaveType: e.target.value as LeaveType }))}
              >
                <option value="">— select type —</option>
                {leaveOptions.map(lt => (
                  <option key={lt.name} value={lt.name}>
                    {lt.name} {LEAVE_PAID[lt.name] ? '(유급)' : '(무급)'}
                  </option>
                ))}
              </select>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-700">Start *</label>
                <input
                  required type="date" className="input"
                  value={form.start}
                  disabled={effectiveReadOnly}
                  onChange={e => setForm(f => ({ ...f, start: e.target.value }))}
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-700">End *</label>
                <input
                  required type="date" className="input"
                  value={form.end}
                  disabled={effectiveReadOnly}
                  onChange={e => setForm(f => ({ ...f, end: e.target.value }))}
                />
              </div>
            </div>

            <div>
              <label className="mb-1 block text-xs font-medium text-gray-700">Note</label>
              <input
                className="input"
                value={form.note}
                disabled={effectiveReadOnly}
                onChange={e => setForm(f => ({ ...f, note: e.target.value }))}
                placeholder="Optional"
              />
            </div>
          </>
        )}

        {err && (
          <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{err}</div>
        )}

        {/* Actions */}
        {!effectiveReadOnly ? (
          <div className="flex gap-2 pt-1">
            <button type="submit" disabled={isPending} className="btn-primary flex-1">
              {isPending
                ? <Loader2 size={14} className="animate-spin" />
                : isEdit ? 'Save' : 'Create'}
            </button>
            {isEdit && (
              <button
                type="button"
                onClick={handleDelete}
                disabled={remove.isPending}
                className="btn-danger"
              >
                <Trash2 size={14} />
              </button>
            )}
            <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
          </div>
        ) : (
          <button type="button" onClick={onClose} className="btn-secondary w-full">Close</button>
        )}
      </form>
    </Modal>
  )
}

