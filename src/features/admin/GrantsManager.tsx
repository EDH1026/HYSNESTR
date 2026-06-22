/**
 * GrantsManager — admin-only fine-grained permission management
 *
 * Lets an admin select a user and view/add/revoke per-resource grants.
 *
 * Pipeline visibility note (displayed inline):
 *   pipeline 열람은 RLS 카테고리 규칙으로 인코딩돼 있어 리소스별 grant와 별개입니다.
 *   view 수준의 grant만으로는 pipeline 열람 불가 — edit 이상이 필요합니다.
 */
import { useState, useMemo } from 'react'
import { Trash2, Plus, Info, AlertTriangle } from 'lucide-react'
import {
  useAllProfiles,
  useAllGrants,
  useCreateGrant,
  useDeleteGrant,
  type CreateGrantInput,
} from './adminHooks'
import { useAllPeople } from '@/features/people/hooks'
import { useAllWorkItems } from '@/features/workitems/hooks'
import type { GrantScope, GrantLevel } from '@/types'

const SCOPE_LABELS: Record<GrantScope, string> = {
  global:    '전체 (글로벌)',
  person:    '인력 (Person)',
  work_item: '업무 항목 (Work Item)',
}

const LEVEL_LABELS: Record<GrantLevel, string> = {
  view:  'view  — 열람',
  edit:  'edit  — 수정',
  admin: 'admin — 관리',
}

const LEVEL_PILL: Record<GrantLevel, string> = {
  view:  'bg-gray-100 text-gray-700',
  edit:  'bg-green-100 text-green-700',
  admin: 'bg-brand-100 text-brand-700',
}

// ── Sub-components ────────────────────────────────────────────

function PipelineNote() {
  return (
    <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800 flex gap-2">
      <Info size={13} className="flex-shrink-0 mt-0.5" />
      <div className="space-y-1">
        <p className="font-semibold">Pipeline 열람 규칙 (카테고리 RLS)</p>
        <p>
          <code className="bg-amber-100 px-1 rounded">type = 'pipeline'</code> 인 업무 항목은
          {' '}<strong>edit 이상의 권한</strong>이 있어야 열람됩니다.
          이 규칙은 RLS에 카테고리 규칙으로 인코딩되어 있으며, 리소스별 grant와 별개입니다.
        </p>
        <p>
          따라서: 특정 pipeline 항목에 <span className="font-semibold">view grant</span>만 부여해도 열람되지 않습니다.
          열람을 허용하려면 해당 항목에 <span className="font-semibold">edit grant</span> 이상을 부여하거나,
          전역 역할을 <code className="bg-amber-100 px-1 rounded">editor</code> 이상으로 설정하세요.
        </p>
      </div>
    </div>
  )
}

// ── AddGrantForm ──────────────────────────────────────────────

interface AddGrantFormProps {
  userId: string
}

function AddGrantForm({ userId }: AddGrantFormProps) {
  const { data: people      = [] } = useAllPeople()
  const { data: workItems   = [] } = useAllWorkItems()
  const createGrant = useCreateGrant()

  const [scope,      setScope]      = useState<GrantScope>('person')
  const [resourceId, setResourceId] = useState<string>('')
  const [level,      setLevel]      = useState<GrantLevel>('view')

  const resources = scope === 'person'
    ? people.map(p    => ({ id: p.id,    label: p.name }))
    : scope === 'work_item'
    ? workItems.map(w => ({ id: w.id,    label: `[${w.type}] ${w.name}` }))
    : []

  // Reset resource when scope changes
  function handleScopeChange(s: GrantScope) {
    setScope(s)
    setResourceId('')
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const input: CreateGrantInput = {
      user_id:     userId,
      scope,
      resource_id: scope === 'global' ? null : resourceId || null,
      level,
    }
    if (scope !== 'global' && !input.resource_id) return
    await createGrant.mutateAsync(input)
    setResourceId('')
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-wrap gap-2 items-end pt-2">
      {/* Scope */}
      <div className="flex flex-col gap-1">
        <label className="text-xs text-muted font-medium">범위</label>
        <select
          value={scope}
          onChange={e => handleScopeChange(e.target.value as GrantScope)}
          className="input text-xs py-1.5"
        >
          {(Object.keys(SCOPE_LABELS) as GrantScope[]).map(s => (
            <option key={s} value={s}>{SCOPE_LABELS[s]}</option>
          ))}
        </select>
      </div>

      {/* Resource */}
      {scope !== 'global' && (
        <div className="flex flex-col gap-1 min-w-[200px]">
          <label className="text-xs text-muted font-medium">리소스</label>
          <select
            value={resourceId}
            onChange={e => setResourceId(e.target.value)}
            required
            className="input text-xs py-1.5"
          >
            <option value="">— 선택 —</option>
            {resources.map(r => (
              <option key={r.id} value={r.id}>{r.label}</option>
            ))}
          </select>
        </div>
      )}

      {/* Level */}
      <div className="flex flex-col gap-1">
        <label className="text-xs text-muted font-medium">수준</label>
        <select
          value={level}
          onChange={e => setLevel(e.target.value as GrantLevel)}
          className="input text-xs py-1.5"
        >
          {(Object.keys(LEVEL_LABELS) as GrantLevel[]).map(l => (
            <option key={l} value={l}>{LEVEL_LABELS[l]}</option>
          ))}
        </select>
      </div>

      <button
        type="submit"
        disabled={createGrant.isPending}
        className="btn-primary gap-1.5 text-xs py-1.5"
      >
        <Plus size={12} /> {createGrant.isPending ? '추가 중…' : 'Grant 추가'}
      </button>

      {createGrant.isError && (
        <span className="text-xs text-red-600 flex items-center gap-1 self-end">
          <AlertTriangle size={11} /> {String(createGrant.error)}
        </span>
      )}
    </form>
  )
}

// ── Main component ────────────────────────────────────────────

export default function GrantsManager() {
  const { data: profiles  = [], isLoading: lP } = useAllProfiles()
  const { data: allGrants = [], isLoading: lG } = useAllGrants()
  const { data: people    = [] }                 = useAllPeople()
  const { data: workItems = [] }                 = useAllWorkItems()
  const deleteGrant = useDeleteGrant()

  const [selectedUserId, setSelectedUserId] = useState<string>('')

  const personMap    = useMemo(() => new Map(people.map(p    => [p.id, p.name])),    [people])
  const workItemMap  = useMemo(() => new Map(workItems.map(w => [w.id, `[${w.type}] ${w.name}`])), [workItems])

  const userGrants = useMemo(
    () => allGrants.filter(g => g.user_id === selectedUserId),
    [allGrants, selectedUserId],
  )

  function resourceLabel(scope: GrantScope, resourceId: string | null): string {
    if (scope === 'global')    return '전체'
    if (!resourceId)           return '—'
    if (scope === 'person')    return personMap.get(resourceId)    ?? resourceId
    if (scope === 'work_item') return workItemMap.get(resourceId)  ?? resourceId
    return resourceId
  }

  const isLoading = lP || lG

  if (isLoading) return <p className="text-sm text-muted py-4">Loading…</p>

  return (
    <div className="space-y-5">
      <PipelineNote />

      {/* User picker */}
      <div className="flex items-center gap-3">
        <label className="text-sm font-medium text-gray-700 flex-shrink-0">사용자 선택</label>
        <select
          value={selectedUserId}
          onChange={e => setSelectedUserId(e.target.value)}
          className="input text-sm flex-1 max-w-xs"
        >
          <option value="">— 사용자를 선택하세요 —</option>
          {profiles.map(p => (
            <option key={p.id} value={p.id}>
              {p.name} ({p.global_role})
            </option>
          ))}
        </select>
      </div>

      {selectedUserId && (
        <div className="space-y-3">
          {/* Current grants */}
          {userGrants.length === 0 ? (
            <p className="text-xs text-muted">현재 부여된 Grant가 없습니다.</p>
          ) : (
            <div className="card overflow-hidden p-0">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-surface-50 text-xs text-muted">
                    <th className="px-4 py-2 text-left font-medium">범위</th>
                    <th className="px-4 py-2 text-left font-medium">리소스</th>
                    <th className="px-4 py-2 text-left font-medium">수준</th>
                    <th className="px-4 py-2 text-right font-medium">삭제</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {userGrants.map(g => (
                    <tr key={g.id} className="hover:bg-surface-50">
                      <td className="px-4 py-2.5 text-muted text-xs">{SCOPE_LABELS[g.scope]}</td>
                      <td className="px-4 py-2.5 text-gray-800 text-xs">
                        {resourceLabel(g.scope, g.resource_id)}
                      </td>
                      <td className="px-4 py-2.5">
                        <span className={`pill text-[11px] ${LEVEL_PILL[g.level]}`}>{g.level}</span>
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        <button
                          onClick={() => deleteGrant.mutate(g.id)}
                          disabled={deleteGrant.isPending}
                          className="rounded p-1 text-muted hover:text-red-600 hover:bg-red-50 transition-colors"
                          title="Grant 삭제"
                        >
                          <Trash2 size={13} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Add grant form */}
          <div className="card space-y-2">
            <p className="text-xs font-medium text-gray-700">새 Grant 추가</p>
            <AddGrantForm userId={selectedUserId} />
          </div>

          {deleteGrant.isError && (
            <p className="flex items-center gap-1 text-xs text-red-600">
              <AlertTriangle size={11} /> {String(deleteGrant.error)}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
