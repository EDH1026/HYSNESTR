import { useState, useMemo, type FormEvent } from 'react'
import { Loader2, Trash2 } from 'lucide-react'
import Modal from '@/components/Modal'
import { useCreatePerson, useUpdatePerson, useDeletePerson } from './hooks'
import { useHistory } from '@/lib/history'
import { makePersonCreate, makePersonUpdate, makePersonDelete } from '@/lib/historyOps'
import { today, numToStr } from '@/lib/date'
import type { Person, Rank } from '@/types'

const RANKS: Rank[] = ['Partner', 'SM', 'M', 'Senior', 'Staff', 'Intern']

interface Props {
  person?:  Person      // undefined → create mode
  readOnly: boolean
  onClose:  () => void
}

export default function PersonModal({ person, readOnly, onClose }: Props) {
  const isEdit = !!person
  const create = useCreatePerson()
  const update = useUpdatePerson()
  const remove = useDeletePerson()
  const { push } = useHistory()

  const todayStr = useMemo(() => numToStr(today()), [])

  const [form, setForm] = useState({
    name:             person?.name             ?? '',
    rank:             (person?.rank            ?? 'Staff') as Rank,
    role:             person?.role             ?? '',
    lpn:              person?.lpn              ?? '',
    hire_date:        person?.hire_date        ?? '',
    termination_date: person?.termination_date ?? '',
  })
  const [err, setErr] = useState<string | null>(null)

  const f = <K extends keyof typeof form>(k: K) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
      setForm(prev => ({ ...prev, [k]: e.target.value }))

  const lpnWarn = useMemo(() => {
    const v = form.lpn.trim()
    return v && !/^\d{5}$/.test(v) ? '형식 권장: 숫자 5자리 (예: 12345)' : null
  }, [form.lpn])

  const derivedStatus = useMemo((): 'active' | 'resigned' | '입사예정' => {
    if (form.hire_date && form.hire_date > todayStr) return '입사예정'
    if (form.termination_date && form.termination_date < todayStr) return 'resigned'
    return 'active'
  }, [form.hire_date, form.termination_date, todayStr])

  const STATUS_PILL = {
    active:    'bg-emerald-100 text-emerald-700',
    resigned:  'bg-gray-100 text-gray-600',
    입사예정: 'bg-blue-100 text-blue-700',
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setErr(null)
    const payload = {
      name:             form.name,
      rank:             form.rank,
      role:             form.role,
      lpn:              form.lpn.trim() || null,
      hire_date:        form.hire_date        || null,
      termination_date: form.termination_date || null,
      // status is not written to DB — computed at read time from hire_date/termination_date
    }
    try {
      if (isEdit) {
        await update.mutateAsync({ id: person.id, ...payload })
        push(makePersonUpdate(person, payload))
      } else {
        const created = await create.mutateAsync(payload)
        push(makePersonCreate(created))
      }
      onClose()
    } catch (err) {
      setErr(err instanceof Error ? err.message : 'Save failed')
    }
  }

  async function handleDelete() {
    if (!isEdit) return
    if (!confirm(`Delete "${person.name}" and all their assignments and accruals?`)) return
    const target = person
    try {
      await remove.mutateAsync(target.id)
      push(makePersonDelete(target))
      onClose()
    } catch (err) {
      setErr(err instanceof Error ? err.message : 'Delete failed')
    }
  }

  const isPending = create.isPending || update.isPending

  return (
    <Modal title={isEdit ? 'Edit Person' : 'New Person'} onClose={onClose} size="md">
      <form onSubmit={handleSubmit} className="space-y-3">
        {/* Name */}
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-700">Name *</label>
          <input
            required
            className="input"
            value={form.name}
            onChange={f('name')}
            disabled={readOnly}
            placeholder="Full name"
          />
        </div>

        {/* Rank + Role */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-700">Rank *</label>
            <select
              required
              className="input"
              value={form.rank}
              onChange={f('rank')}
              disabled={readOnly}
            >
              {RANKS.map(r => <option key={r} value={r}>{r}</option>)}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-700">Role</label>
            <input
              className="input"
              value={form.role}
              onChange={f('role')}
              disabled={readOnly}
              placeholder="e.g. Strategy Consultant"
            />
          </div>
        </div>

        {/* LPN */}
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-700">
            LPN
            <span className="ml-1 text-[10px] text-muted">인력 식별 번호 (표시·감사 목적)</span>
          </label>
          <input
            className="input font-mono text-xs"
            value={form.lpn}
            onChange={f('lpn')}
            disabled={readOnly}
            placeholder="00000"
          />
          {lpnWarn && !readOnly && (
            <p className="mt-1 text-[11px] text-amber-600">{lpnWarn}</p>
          )}
        </div>

        {/* Hire date + Termination date */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-700">입사일</label>
            <input
              type="date"
              className="input"
              value={form.hire_date}
              onChange={f('hire_date')}
              disabled={readOnly}
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-700">퇴사일</label>
            <input
              type="date"
              className="input"
              value={form.termination_date}
              onChange={f('termination_date')}
              disabled={readOnly}
            />
          </div>
        </div>

        {/* Derived employment status */}
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-700">
            재직 상태
            <span className="ml-1 text-[10px] text-muted">날짜 기반 자동 파생 — 저장 시 반영됩니다</span>
          </label>
          <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_PILL[derivedStatus]}`}>
            {derivedStatus}
          </span>
        </div>

        {err && (
          <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{err}</div>
        )}

        {/* Actions */}
        {!readOnly && (
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
        )}
        {readOnly && (
          <button type="button" onClick={onClose} className="btn-secondary w-full">Close</button>
        )}
      </form>
    </Modal>
  )
}
