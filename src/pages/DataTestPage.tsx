/**
 * DataTestPage — CRUD acceptance test screen (임시).
 *
 * Tests that the data-access hooks work end-to-end with RLS:
 *   - Only permitted rows are returned (viewer cannot see pipeline assignments)
 *   - Mutations that exceed permissions fail with an RLS error message
 *   - Cascades work correctly (delete person → assignments/accruals gone)
 */

import { useState, type FormEvent } from 'react'
import { AlertCircle, Loader2, Plus, Trash2, Pencil, Check, X } from 'lucide-react'

import { useAllPeople, useCreatePerson, useUpdatePerson, useDeletePerson } from '@/features/people/hooks'
import { useAllWorkItems, useCreateWorkItem, useDeleteWorkItem } from '@/features/workitems/hooks'
import {
  useAllAssignments,
  useCreateAssignment,
  useDeleteAssignment,
} from '@/features/timeline/hooks'
import { useAuthz } from '@/hooks/useAuthz'
import type { Rank, WorkItemType, AssignmentKind } from '@/types'

// ── Shared helpers ────────────────────────────────────────────

function QueryError({ error }: { error: unknown }) {
  if (!error) return null
  const msg = error instanceof Error ? error.message : String(error)
  return (
    <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
      <AlertCircle size={14} className="mt-0.5 flex-shrink-0" />
      <span>{msg}</span>
    </div>
  )
}

function LoadingRow({ cols }: { cols: number }) {
  return (
    <tr>
      <td colSpan={cols} className="py-6 text-center text-sm text-muted">
        <Loader2 size={16} className="inline animate-spin mr-2" />
        Loading…
      </td>
    </tr>
  )
}

function EmptyRow({ cols, message = 'No data' }: { cols: number; message?: string }) {
  return (
    <tr>
      <td colSpan={cols} className="py-6 text-center text-sm text-muted">
        {message}
      </td>
    </tr>
  )
}

// ── Tab: People ───────────────────────────────────────────────

const RANKS: Rank[] = ['Partner', 'SM', 'M', 'Senior', 'Staff', 'Intern']

function PeopleTab() {
  const { data: people = [], isLoading, error } = useAllPeople()
  const createPerson  = useCreatePerson()
  const updatePerson  = useUpdatePerson()
  const deletePerson  = useDeletePerson()
  const { canEdit }   = useAuthz()

  const [form, setForm]       = useState({ name: '', rank: 'Staff' as Rank, role: '' })
  const [showForm, setShow]   = useState(false)
  const [editId, setEditId]   = useState<string | null>(null)
  const [editForm, setEditForm] = useState({ name: '', rank: 'Staff' as Rank, role: '' })
  const [mutErr, setMutErr]   = useState<string | null>(null)

  const canWrite = canEdit('global')

  async function handleAdd(e: FormEvent) {
    e.preventDefault()
    setMutErr(null)
    try {
      await createPerson.mutateAsync(form)
      setForm({ name: '', rank: 'Staff', role: '' })
      setShow(false)
    } catch (err) {
      setMutErr(err instanceof Error ? err.message : 'Create failed')
    }
  }

  async function handleSaveEdit(id: string) {
    setMutErr(null)
    try {
      await updatePerson.mutateAsync({ id, ...editForm })
      setEditId(null)
    } catch (err) {
      setMutErr(err instanceof Error ? err.message : 'Update failed')
    }
  }

  function startEdit(p: { id: string; name: string; rank: Rank; role: string }) {
    setEditId(p.id)
    setEditForm({ name: p.name, rank: p.rank, role: p.role })
  }

  async function handleDelete(id: string, name: string) {
    if (!confirm(`Delete "${name}" and all their assignments / accruals?`)) return
    setMutErr(null)
    try {
      await deletePerson.mutateAsync(id)
    } catch (err) {
      setMutErr(err instanceof Error ? err.message : 'Delete failed')
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-gray-900">
          People <span className="text-sm font-normal text-muted">({people.length} visible)</span>
        </h2>
        {canWrite && (
          <button className="btn-primary gap-1.5" onClick={() => setShow(s => !s)}>
            <Plus size={14} /> Add person
          </button>
        )}
      </div>

      <QueryError error={error ?? mutErr} />

      {/* Add form */}
      {showForm && (
        <form onSubmit={handleAdd} className="card p-4 flex flex-wrap gap-3 items-end">
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-700">Name *</label>
            <input required className="input w-40" value={form.name}
              onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-700">Rank *</label>
            <select required className="input w-28" value={form.rank}
              onChange={e => setForm(f => ({ ...f, rank: e.target.value as Rank }))}>
              {RANKS.map(r => <option key={r}>{r}</option>)}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-700">Role</label>
            <input className="input w-36" value={form.role}
              onChange={e => setForm(f => ({ ...f, role: e.target.value }))} />
          </div>
          <button type="submit" disabled={createPerson.isPending} className="btn-primary">
            {createPerson.isPending ? <Loader2 size={14} className="animate-spin" /> : 'Add'}
          </button>
          <button type="button" className="btn-secondary" onClick={() => setShow(false)}>Cancel</button>
        </form>
      )}

      {/* Table */}
      <div className="card overflow-hidden">
        <table className="w-full text-sm">
          <thead className="border-b border-border bg-surface-50">
            <tr>
              {['Name', 'Rank', 'Role', canWrite ? 'Actions' : ''].map(h => (
                <th key={h} className="px-4 py-2.5 text-left text-xs font-medium text-muted uppercase tracking-wide">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {isLoading ? <LoadingRow cols={4} /> :
             people.length === 0 ? <EmptyRow cols={4} message="No people visible" /> :
             people.map(p => (
              <tr key={p.id} className="hover:bg-surface-50">
                <td className="px-4 py-2.5">
                  {editId === p.id
                    ? <input className="input py-1 w-32" value={editForm.name}
                        onChange={e => setEditForm(f => ({ ...f, name: e.target.value }))} />
                    : p.name}
                </td>
                <td className="px-4 py-2.5">
                  {editId === p.id
                    ? <select className="input py-1 w-24" value={editForm.rank}
                        onChange={e => setEditForm(f => ({ ...f, rank: e.target.value as Rank }))}>
                        {RANKS.map(r => <option key={r}>{r}</option>)}
                      </select>
                    : <span className="pill">{p.rank}</span>}
                </td>
                <td className="px-4 py-2.5 text-muted">
                  {editId === p.id
                    ? <input className="input py-1 w-32" value={editForm.role}
                        onChange={e => setEditForm(f => ({ ...f, role: e.target.value }))} />
                    : p.role}
                </td>
                {canWrite && (
                  <td className="px-4 py-2.5">
                    {editId === p.id ? (
                      <div className="flex gap-1.5">
                        <button onClick={() => handleSaveEdit(p.id)}
                          className="btn-primary py-1 px-2 gap-1 text-xs" disabled={updatePerson.isPending}>
                          <Check size={12} /> Save
                        </button>
                        <button onClick={() => setEditId(null)} className="btn-secondary py-1 px-2">
                          <X size={12} />
                        </button>
                      </div>
                    ) : (
                      <div className="flex gap-1.5">
                        <button onClick={() => startEdit(p)} className="btn-secondary py-1 px-2">
                          <Pencil size={12} />
                        </button>
                        <button onClick={() => handleDelete(p.id, p.name)}
                          disabled={deletePerson.isPending} className="btn-danger py-1 px-2">
                          <Trash2 size={12} />
                        </button>
                      </div>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ── Tab: Work Items ───────────────────────────────────────────

const WI_TYPES: WorkItemType[] = ['project', 'proposal', 'pipeline']

function WorkItemsTab() {
  const { data: items = [], isLoading, error } = useAllWorkItems()
  const createWI   = useCreateWorkItem()
  const deleteWI   = useDeleteWorkItem()
  const { canEdit } = useAuthz()

  const [form, setForm]     = useState({
    type: 'project' as WorkItemType,
    name: '', color: '#6366f1',
    start: '', main_start: '', end_date: '',
    engagement_number: '', client: '', hashtags: [] as string[],
  })
  const [showForm, setShow] = useState(false)
  const [mutErr, setMutErr] = useState<string | null>(null)

  const canWrite = canEdit('global')

  async function handleAdd(e: FormEvent) {
    e.preventDefault()
    setMutErr(null)
    try {
      await createWI.mutateAsync({
        ...form,
        main_start:        form.main_start        || null,
        engagement_number: form.engagement_number || null,
        client:            form.client            || null,
        status: 'open',
      } as any)
      setForm({ type: 'project', name: '', color: '#6366f1', start: '', main_start: '', end_date: '', engagement_number: '', client: '', hashtags: [] })
      setShow(false)
    } catch (err) {
      setMutErr(err instanceof Error ? err.message : 'Create failed')
    }
  }

  async function handleDelete(id: string, name: string) {
    if (!confirm(`Delete "${name}" and all its assignments?`)) return
    setMutErr(null)
    try { await deleteWI.mutateAsync(id) }
    catch (err) { setMutErr(err instanceof Error ? err.message : 'Delete failed') }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-gray-900">
          Work Items <span className="text-sm font-normal text-muted">({items.length} visible)</span>
        </h2>
        {canWrite && (
          <button className="btn-primary gap-1.5" onClick={() => setShow(s => !s)}>
            <Plus size={14} /> Add item
          </button>
        )}
      </div>

      <QueryError error={error ?? mutErr} />

      {showForm && (
        <form onSubmit={handleAdd} className="card p-4 grid grid-cols-2 gap-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-700">Type *</label>
            <select required className="input" value={form.type}
              onChange={e => setForm(f => ({ ...f, type: e.target.value as WorkItemType }))}>
              {WI_TYPES.map(t => <option key={t}>{t}</option>)}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-700">Name *</label>
            <input required className="input" value={form.name}
              onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-700">Start *</label>
            <input required type="date" className="input" value={form.start}
              onChange={e => setForm(f => ({ ...f, start: e.target.value }))} />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-700">End date *</label>
            <input required type="date" className="input" value={form.end_date}
              onChange={e => setForm(f => ({ ...f, end_date: e.target.value }))} />
          </div>
          {form.type === 'project' && (
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-700">Main start</label>
              <input type="date" className="input" value={form.main_start}
                onChange={e => setForm(f => ({ ...f, main_start: e.target.value }))} />
            </div>
          )}
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-700">Client</label>
            <input className="input" value={form.client}
              onChange={e => setForm(f => ({ ...f, client: e.target.value }))} />
          </div>
          <div className="col-span-2 flex gap-2">
            <button type="submit" disabled={createWI.isPending} className="btn-primary">
              {createWI.isPending ? <Loader2 size={14} className="animate-spin" /> : 'Add'}
            </button>
            <button type="button" className="btn-secondary" onClick={() => setShow(false)}>Cancel</button>
          </div>
        </form>
      )}

      <div className="card overflow-hidden">
        <table className="w-full text-sm">
          <thead className="border-b border-border bg-surface-50">
            <tr>
              {['Type', 'Name', 'Start', 'End', 'Client', canWrite ? 'Actions' : ''].map(h => (
                <th key={h} className="px-4 py-2.5 text-left text-xs font-medium text-muted uppercase tracking-wide">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {isLoading ? <LoadingRow cols={6} /> :
             items.length === 0 ? <EmptyRow cols={6} message="No work items visible" /> :
             items.map(wi => (
              <tr key={wi.id} className="hover:bg-surface-50">
                <td className="px-4 py-2.5">
                  <span className={`pill ${wi.type === 'pipeline' ? 'bg-orange-100 text-orange-700' : ''}`}>
                    {wi.type}
                  </span>
                </td>
                <td className="px-4 py-2.5 font-medium">{wi.name}</td>
                <td className="px-4 py-2.5 text-muted">{wi.start}</td>
                <td className="px-4 py-2.5 text-muted">{wi.end_date}</td>
                <td className="px-4 py-2.5 text-muted">{wi.client ?? '—'}</td>
                {canWrite && (
                  <td className="px-4 py-2.5">
                    <button onClick={() => handleDelete(wi.id, wi.name)}
                      disabled={deleteWI.isPending} className="btn-danger py-1 px-2">
                      <Trash2 size={12} />
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ── Tab: Assignments ──────────────────────────────────────────

function AssignmentsTab() {
  const { data: assignments = [], isLoading, error } = useAllAssignments()
  const { data: people      = [] }                    = useAllPeople()
  const { data: workItems   = [] }                    = useAllWorkItems()
  const createAsgn  = useCreateAssignment()
  const deleteAsgn  = useDeleteAssignment()
  const { canEdit } = useAuthz()

  const [form, setForm]     = useState({
    person_id: '', kind: 'work' as AssignmentKind,
    work_item_id: '' as string | null,
    leave_type: null as import('@/types').LeaveType | null,
    start: '', end_date: '', note: '',
    weekend_dates: [] as string[],
  })
  const [showForm, setShow] = useState(false)
  const [mutErr, setMutErr] = useState<string | null>(null)

  const canWrite = canEdit('global') || people.some(p => canEdit('person', p.id))

  const personName  = (id: string) => people.find(p => p.id === id)?.name   ?? id.slice(0, 8)
  const workItemName = (id: string | null) => id ? (workItems.find(w => w.id === id)?.name ?? id.slice(0, 8)) : '—'

  async function handleAdd(e: FormEvent) {
    e.preventDefault()
    setMutErr(null)
    try {
      await createAsgn.mutateAsync({
        person_id: form.person_id,
        kind: form.kind,
        work_item_id: form.kind === 'work' ? form.work_item_id : null,
        leave_type: form.kind === 'leave' ? '리프레시' : null,
        start: form.start,
        end_date: form.end_date,
        note: form.note || null,
        weekend_dates: [],
      })
      setForm(f => ({ ...f, person_id: '', work_item_id: '', start: '', end_date: '', note: '' }))
      setShow(false)
    } catch (err) {
      setMutErr(err instanceof Error ? err.message : 'Create failed')
    }
  }

  async function handleDelete(id: string) {
    if (!confirm('Delete this assignment?')) return
    setMutErr(null)
    try { await deleteAsgn.mutateAsync(id) }
    catch (err) { setMutErr(err instanceof Error ? err.message : 'Delete failed') }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-gray-900">
          Assignments <span className="text-sm font-normal text-muted">({assignments.length} visible)</span>
        </h2>
        {canWrite && (
          <button className="btn-primary gap-1.5" onClick={() => setShow(s => !s)}>
            <Plus size={14} /> Add assignment
          </button>
        )}
      </div>

      <QueryError error={error ?? mutErr} />

      {showForm && (
        <form onSubmit={handleAdd} className="card p-4 grid grid-cols-2 gap-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-700">Person *</label>
            <select required className="input" value={form.person_id}
              onChange={e => setForm(f => ({ ...f, person_id: e.target.value }))}>
              <option value="">— select —</option>
              {people.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-700">Kind *</label>
            <select required className="input" value={form.kind}
              onChange={e => setForm(f => ({ ...f, kind: e.target.value as AssignmentKind }))}>
              <option value="work">work</option>
              <option value="leave">leave</option>
            </select>
          </div>
          {form.kind === 'work' && (
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-700">Work item *</label>
              <select required className="input" value={form.work_item_id ?? ''}
                onChange={e => setForm(f => ({ ...f, work_item_id: e.target.value }))}>
                <option value="">— select —</option>
                {workItems.map(w => <option key={w.id} value={w.id}>{w.name} ({w.type})</option>)}
              </select>
            </div>
          )}
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-700">Start *</label>
            <input required type="date" className="input" value={form.start}
              onChange={e => setForm(f => ({ ...f, start: e.target.value }))} />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-700">End date *</label>
            <input required type="date" className="input" value={form.end_date}
              onChange={e => setForm(f => ({ ...f, end_date: e.target.value }))} />
          </div>
          <div className="col-span-2 flex gap-2">
            <button type="submit" disabled={createAsgn.isPending} className="btn-primary">
              {createAsgn.isPending ? <Loader2 size={14} className="animate-spin" /> : 'Add'}
            </button>
            <button type="button" className="btn-secondary" onClick={() => setShow(false)}>Cancel</button>
          </div>
        </form>
      )}

      <div className="card overflow-hidden">
        <table className="w-full text-sm">
          <thead className="border-b border-border bg-surface-50">
            <tr>
              {['Person', 'Work item', 'Kind', 'Start', 'End', canWrite ? 'Actions' : ''].map(h => (
                <th key={h} className="px-4 py-2.5 text-left text-xs font-medium text-muted uppercase tracking-wide">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {isLoading ? <LoadingRow cols={6} /> :
             assignments.length === 0 ? <EmptyRow cols={6} message="No assignments visible" /> :
             assignments.map(a => (
              <tr key={a.id} className="hover:bg-surface-50">
                <td className="px-4 py-2.5 font-medium">{personName(a.person_id)}</td>
                <td className="px-4 py-2.5 text-muted">{workItemName(a.work_item_id)}</td>
                <td className="px-4 py-2.5"><span className="pill">{a.kind}</span></td>
                <td className="px-4 py-2.5 text-muted">{a.start}</td>
                <td className="px-4 py-2.5 text-muted">{a.end_date}</td>
                {canWrite && (
                  <td className="px-4 py-2.5">
                    <button onClick={() => handleDelete(a.id)}
                      disabled={deleteAsgn.isPending} className="btn-danger py-1 px-2">
                      <Trash2 size={12} />
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────

type Tab = 'people' | 'workitems' | 'assignments'

const TABS: { id: Tab; label: string }[] = [
  { id: 'people',      label: 'People'      },
  { id: 'workitems',   label: 'Work Items'  },
  { id: 'assignments', label: 'Assignments' },
]

export default function DataTestPage() {
  const [tab, setTab] = useState<Tab>('people')

  return (
    <div className="p-6 space-y-6 max-w-5xl">
      <div>
        <h1 className="text-lg font-semibold text-gray-900">Data Access Layer — CRUD Test</h1>
        <p className="text-sm text-muted mt-1">
          Rows shown reflect RLS permissions for your account. Mutations that exceed
          your permission will receive an error from Postgres.
        </p>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-border">
        {TABS.map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={[
              'px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px',
              tab === t.id
                ? 'border-brand-600 text-brand-700'
                : 'border-transparent text-muted hover:text-gray-900',
            ].join(' ')}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Content */}
      {tab === 'people'      && <PeopleTab />}
      {tab === 'workitems'   && <WorkItemsTab />}
      {tab === 'assignments' && <AssignmentsTab />}
    </div>
  )
}
