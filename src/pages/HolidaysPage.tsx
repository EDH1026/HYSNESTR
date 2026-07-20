import { useState } from 'react'
import { Navigate } from 'react-router-dom'
import { CalendarPlus, Pencil, RefreshCw, Calendar } from 'lucide-react'
import { useAllHolidays } from '@/features/admin/hooks'
import { useAuthz } from '@/hooks/useAuthz'
import HolidayModal from '@/features/admin/HolidayModal'
import type { Holiday } from '@/types'

export default function HolidaysPage() {
  const { data: holidays = [], isLoading, error } = useAllHolidays()
  const { isAdmin, isMobile } = useAuthz()
  const [modal, setModal] = useState<Holiday | null | false>(false)

  // PRD v2.103: this screen leaked to editor/assistant via the route/menu (both already
  // fixed) — third layer of defense, matching AdminPage's own internal isAdmin() check.
  // Placed after every hook call above (React error #300 — early returns must never
  // change the hook call count/order between renders).
  if (!isAdmin()) return <Navigate to="/timeline" replace />

  // PRD v2.100: holidays writes are admin-only now (RLS narrowed) — canEdit('global')
  // would still say yes for editor, so check admin directly to match the DB policy.
  const editable = !isMobile
  const open = modal !== false

  if (isLoading) return <div className="p-8 text-sm text-muted">Loading…</div>
  if (error)     return <div className="p-8 text-sm text-red-600">{String(error)}</div>

  const recurring = holidays.filter(h => h.recurring)
  const oneOff    = holidays.filter(h => !h.recurring)

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-6 py-4">
        <div>
          <h1 className="text-base font-semibold text-gray-900">Holidays</h1>
          <p className="text-xs text-muted">
            {recurring.length} recurring · {oneOff.length} one-off
          </p>
        </div>
        {editable && (
          <button className="btn-primary gap-1.5 text-xs" onClick={() => setModal(null)}>
            <CalendarPlus size={14} /> 휴일 추가
          </button>
        )}
      </div>

      <div className="flex-1 overflow-auto p-6 space-y-6">
        {holidays.length === 0 && (
          <div className="text-center py-16 text-muted text-sm">
            No holidays configured.{editable && ' Click "휴일 추가" to add one.'}
          </div>
        )}

        {/* Recurring */}
        {recurring.length > 0 && (
          <section>
            <h2 className="mb-3 flex items-center gap-2 text-xs font-semibold text-muted uppercase tracking-wide">
              <RefreshCw size={12} /> Recurring (annual)
            </h2>
            <div className="card overflow-hidden p-0">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-surface-50 text-xs text-muted">
                    <th className="px-4 py-2.5 text-left font-medium">Name</th>
                    <th className="px-4 py-2.5 text-left font-medium">Month / Day</th>
                    <th className="px-4 py-2.5 w-12" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {recurring.map(h => (
                    <HolidayRow key={h.id} holiday={h} editable={editable} onEdit={setModal} />
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {/* One-off */}
        {oneOff.length > 0 && (
          <section>
            <h2 className="mb-3 flex items-center gap-2 text-xs font-semibold text-muted uppercase tracking-wide">
              <Calendar size={12} /> One-off
            </h2>
            <div className="card overflow-hidden p-0">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-surface-50 text-xs text-muted">
                    <th className="px-4 py-2.5 text-left font-medium">Name</th>
                    <th className="px-4 py-2.5 text-left font-medium">Date</th>
                    <th className="px-4 py-2.5 w-12" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {oneOff.map(h => (
                    <HolidayRow key={h.id} holiday={h} editable={editable} onEdit={setModal} />
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}
      </div>

      {open && (
        <HolidayModal
          holiday={modal ?? undefined}
          readOnly={!editable}
          onClose={() => setModal(false)}
        />
      )}
    </div>
  )
}

function HolidayRow({
  holiday, editable, onEdit,
}: {
  holiday: Holiday
  editable: boolean
  onEdit: (h: Holiday) => void
}) {
  const dateDisplay = holiday.recurring
    ? holiday.date.slice(5)          // "MM-DD"
    : holiday.date                   // "YYYY-MM-DD"

  return (
    <tr className="hover:bg-surface-50 transition-colors">
      <td className="px-4 py-3 font-medium text-gray-900">{holiday.name}</td>
      <td className="px-4 py-3 font-mono text-xs text-muted">{dateDisplay}</td>
      <td className="px-4 py-3 text-right">
        <button
          onClick={() => onEdit(holiday)}
          className="rounded p-1.5 text-muted hover:bg-surface-100 hover:text-gray-700 transition-colors"
          title={editable ? 'Edit' : 'View'}
        >
          <Pencil size={13} />
        </button>
      </td>
    </tr>
  )
}
