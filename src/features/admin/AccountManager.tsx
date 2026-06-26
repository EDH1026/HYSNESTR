/**
 * AccountManager — admin-only user account management
 *
 * Lists all profiles and allows admins to:
 * - Link to a Person record (profiles.person_id — §6.2 identity source)
 * - Change global_role (admin / editor / viewer)
 * - Edit LPN (display/audit purposes only — no longer used for matching)
 * - Activate / deactivate accounts
 *
 * Note: creating/inviting new accounts requires the Supabase Dashboard
 * (Auth → Users → Invite user) or a server-side Edge Function with the
 * service_role key. The anon key cannot call auth.admin.inviteUserByEmail().
 */
import { useState, useEffect } from 'react'
import { AlertTriangle, CheckCircle2, XCircle, Info } from 'lucide-react'
import { useAllProfiles, useUpdateProfile } from './adminHooks'
import { useAllPeople } from '@/features/people/hooks'
import { useAuth } from '@/context/AuthContext'
import type { GlobalRole } from '@/types'

const ROLE_OPTIONS: GlobalRole[] = ['viewer', 'assistant', 'editor', 'admin']

const ROLE_PILL: Record<GlobalRole, string> = {
  admin:     'bg-brand-100 text-brand-700',
  editor:    'bg-green-100 text-green-700',
  viewer:    'bg-gray-100  text-gray-600',
  assistant: 'bg-purple-100 text-purple-700',
}

export default function AccountManager() {
  const { profile: self } = useAuth()
  const { data: profiles = [], isLoading, error } = useAllProfiles()
  const { data: people   = [] }                   = useAllPeople()
  const updateProfile = useUpdateProfile()
  const [updating, setUpdating] = useState<string | null>(null)
  const [lpnDraft, setLpnDraft] = useState<Record<string, string>>({})

  // Initialise LPN drafts from server data (only for profiles not yet in draft)
  useEffect(() => {
    setLpnDraft(prev => {
      const next = { ...prev }
      for (const p of profiles) {
        if (!(p.id in next)) next[p.id] = p.lpn ?? ''
      }
      return next
    })
  }, [profiles])

  function getLpnValue(id: string, serverLpn: string | null | undefined): string {
    return id in lpnDraft ? lpnDraft[id] : (serverLpn ?? '')
  }

  async function handleRoleChange(id: string, role: GlobalRole) {
    setUpdating(id)
    try {
      await updateProfile.mutateAsync({ id, global_role: role })
    } finally {
      setUpdating(null)
    }
  }

  async function handleToggleStatus(id: string, current: 'active' | 'inactive') {
    setUpdating(id)
    try {
      await updateProfile.mutateAsync({
        id,
        status: current === 'active' ? 'inactive' : 'active',
      })
    } finally {
      setUpdating(null)
    }
  }

  async function handleLpnBlur(id: string, serverLpn: string | null | undefined) {
    const draft   = lpnDraft[id]
    if (draft === undefined) return
    const trimmed = draft.trim() || null
    const server  = serverLpn ?? null
    if (trimmed === server) return
    setUpdating(id)
    try {
      await updateProfile.mutateAsync({ id, lpn: trimmed })
      // Clear draft so input reflects the (now-fresh) server value
      setLpnDraft(d => { const n = { ...d }; delete n[id]; return n })
    } finally {
      setUpdating(null)
    }
  }

  async function handlePersonChange(id: string, personId: string) {
    setUpdating(id)
    try {
      await updateProfile.mutateAsync({ id, person_id: personId || null })
    } finally {
      setUpdating(null)
    }
  }

  if (isLoading) return <p className="text-sm text-muted py-4">Loading…</p>
  if (error)     return <p className="text-sm text-red-600 py-4">{String(error)}</p>

  return (
    <div className="space-y-4">
      {/* Invite notice */}
      <div className="rounded-md border border-blue-200 bg-blue-50 p-3 text-xs text-blue-800">
        <p className="font-semibold">신규 계정 초대</p>
        <p className="mt-1">
          새 계정을 만들려면 <strong>Supabase 대시보드 → Authentication → Users → Invite user</strong>를
          사용하세요. 클라이언트에서는 service_role 없이 auth.admin API를 호출할 수 없습니다.
        </p>
      </div>

      {/* Person link guidance */}
      <div className="rounded-md border border-indigo-200 bg-indigo-50 p-3 text-xs text-indigo-800 flex gap-2">
        <Info size={14} className="mt-0.5 flex-shrink-0" />
        <div>
          <p className="font-semibold">인력 연결 안내 (PRD v2.5 §6.2)</p>
          <p className="mt-1">
            각 계정의 <strong>연결 인력</strong>을 People 레코드와 연결해야
            본인 CV·휴가가 정상 매칭됩니다. 연결 후 관리자가 별도 grant를 부여하지 않아도
            본인 데이터 열람 권한이 자동으로 동작합니다.
            LPN은 표시·감사 목적으로만 유지됩니다.
          </p>
        </div>
      </div>

      <div className="card overflow-hidden p-0 overflow-x-auto">
        <table className="w-full text-sm min-w-[700px]">
          <thead>
            <tr className="border-b border-border bg-surface-50 text-xs text-muted">
              <th className="px-4 py-2.5 text-left font-medium">이름</th>
              <th className="px-4 py-2.5 text-left font-medium">연결 인력</th>
              <th className="px-4 py-2.5 text-left font-medium">LPN</th>
              <th className="px-4 py-2.5 text-left font-medium">전역 역할</th>
              <th className="px-4 py-2.5 text-left font-medium">상태</th>
              <th className="px-4 py-2.5 text-right font-medium">활성화</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {profiles.map(p => {
              const isSelf = p.id === self?.id
              const busy   = updating === p.id
              return (
                <tr key={p.id} className="hover:bg-surface-50 transition-colors">
                  <td className="px-4 py-3 font-medium text-gray-900">
                    {p.name}
                    {isSelf && (
                      <span className="ml-2 text-xs text-muted">(나)</span>
                    )}
                  </td>

                  {/* Person link selector */}
                  <td className="px-4 py-3">
                    <select
                      className="input py-0.5 text-xs w-40"
                      value={p.person_id ?? ''}
                      disabled={busy}
                      onChange={e => handlePersonChange(p.id, e.target.value)}
                    >
                      <option value="">없음 (미연결)</option>
                      {people.map(person => (
                        <option key={person.id} value={person.id}>
                          {person.name} ({person.rank})
                        </option>
                      ))}
                    </select>
                  </td>

                  {/* LPN — display/audit only */}
                  <td className="px-4 py-3">
                    {(() => {
                      const val = getLpnValue(p.id, p.lpn)
                      const warn = val.trim() && !/^\d{5}$/.test(val.trim())
                      return (
                        <div>
                          <input
                            type="text"
                            className={[
                              'input py-0.5 w-24 font-mono text-xs',
                              warn ? 'border-amber-400' : '',
                            ].join(' ')}
                            value={val}
                            onChange={e => setLpnDraft(d => ({ ...d, [p.id]: e.target.value }))}
                            onBlur={() => handleLpnBlur(p.id, p.lpn)}
                            onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }}
                            disabled={busy}
                            placeholder="00000"
                            title="숫자 5자리 형식 권장 (표시용)"
                          />
                          {warn && (
                            <p className="mt-0.5 text-[10px] text-amber-600">숫자 5자리 권장</p>
                          )}
                        </div>
                      )
                    })()}
                  </td>

                  <td className="px-4 py-3">
                    <select
                      value={p.global_role}
                      disabled={isSelf || busy}
                      onChange={e => handleRoleChange(p.id, e.target.value as GlobalRole)}
                      className={`input py-0.5 text-xs font-medium ${ROLE_PILL[p.global_role]}`}
                    >
                      {ROLE_OPTIONS.map(r => (
                        <option key={r} value={r}>{r}</option>
                      ))}
                    </select>
                  </td>
                  <td className="px-4 py-3">
                    {p.status === 'active' ? (
                      <span className="flex items-center gap-1 text-xs text-emerald-700">
                        <CheckCircle2 size={12} /> active
                      </span>
                    ) : (
                      <span className="flex items-center gap-1 text-xs text-red-600">
                        <XCircle size={12} /> inactive
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {isSelf ? (
                      <span className="text-xs text-muted">—</span>
                    ) : (
                      <button
                        disabled={busy}
                        onClick={() => handleToggleStatus(p.id, p.status)}
                        className={
                          p.status === 'active'
                            ? 'btn-danger text-xs py-1'
                            : 'btn-secondary text-xs py-1'
                        }
                      >
                        {busy
                          ? '…'
                          : p.status === 'active'
                          ? '비활성화'
                          : '활성화'}
                      </button>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {updateProfile.isError && (
        <p className="flex items-center gap-1 text-xs text-red-600">
          <AlertTriangle size={12} />
          {String(updateProfile.error)}
        </p>
      )}
    </div>
  )
}
