import { useState, type FormEvent } from 'react'
import { Loader2, Trash2 } from 'lucide-react'
import Modal from '@/components/Modal'
import { useCreateHoliday, useUpdateHoliday, useDeleteHoliday } from './hooks'
import type { Holiday } from '@/types'

interface Props {
  holiday?:  Holiday    // undefined → create mode
  readOnly:  boolean
  onClose:   () => void
}

export default function HolidayModal({ holiday, readOnly, onClose }: Props) {
  const isEdit = !!holiday
  const create = useCreateHoliday()
  const update = useUpdateHoliday()
  const remove = useDeleteHoliday()

  const [form, setForm] = useState({
    name:      holiday?.name      ?? '',
    date:      holiday?.date      ?? '',
    recurring: holiday?.recurring ?? false,
  })
  const [err, setErr] = useState<string | null>(null)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setErr(null)
    try {
      if (isEdit) {
        await update.mutateAsync({ id: holiday.id, ...form })
      } else {
        await create.mutateAsync(form)
      }
      onClose()
    } catch (err) {
      setErr(err instanceof Error ? err.message : 'Save failed')
    }
  }

  async function handleDelete() {
    if (!isEdit) return
    if (!confirm(`Delete holiday "${holiday.name}"?`)) return
    try {
      await remove.mutateAsync(holiday.id)
      onClose()
    } catch (err) {
      setErr(err instanceof Error ? err.message : 'Delete failed')
    }
  }

  const isPending = create.isPending || update.isPending

  return (
    <Modal title={isEdit ? 'Edit Holiday' : 'New Holiday'} onClose={onClose} size="sm">
      <form onSubmit={handleSubmit} className="space-y-3">
        {/* Name */}
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-700">Name *</label>
          <input
            required
            className="input"
            value={form.name}
            onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
            disabled={readOnly}
            placeholder="e.g. New Year's Day"
          />
        </div>

        {/* Date */}
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-700">Date *</label>
          <input
            required
            type="date"
            className="input"
            value={form.date}
            onChange={e => setForm(f => ({ ...f, date: e.target.value }))}
            disabled={readOnly}
          />
          {form.recurring && (
            <p className="mt-1 text-[11px] text-muted">
              Year is ignored — this holiday repeats on the same month/day every year.
            </p>
          )}
        </div>

        {/* Recurring toggle */}
        <div>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              className="rounded border-border accent-brand-600"
              checked={form.recurring}
              onChange={e => setForm(f => ({ ...f, recurring: e.target.checked }))}
              disabled={readOnly}
            />
            <span className="text-sm text-gray-700">Recurring (same date every year)</span>
          </label>
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
          <button type="button" onClick={onClose} className="btn-secondary w-full">Close</button>
        )}
      </form>
    </Modal>
  )
}
