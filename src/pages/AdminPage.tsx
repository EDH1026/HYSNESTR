import { useState } from 'react'
import { Navigate } from 'react-router-dom'
import { useAuthz } from '@/hooks/useAuthz'
import AccountManager    from '@/features/admin/AccountManager'
import GrantsManager     from '@/features/admin/GrantsManager'
import AuditLogViewer    from '@/features/admin/AuditLogViewer'
import BackupRestore     from '@/features/admin/BackupRestore'
import SecurityChecklist from '@/features/admin/SecurityChecklist'
import HolidaySyncPanel  from '@/features/admin/HolidaySyncPanel'
import BulkUploadPanel   from '@/features/admin/BulkUploadPanel'
import MigrationPanel      from '@/features/admin/MigrationPanel'
import StatutoryFillPanel  from '@/features/admin/StatutoryFillPanel'
import { useSettings, useUpdateSettings, useLeaveTypes, useUpdateLeaveType } from '@/features/admin/hooks'

type Tab = 'accounts' | 'grants' | 'audit' | 'backup' | 'security' | 'settings' | 'holidays' | 'bulk' | 'migration' | 'statutory'

const TABS: { id: Tab; label: string }[] = [
  { id: 'accounts',  label: '계정 관리' },
  { id: 'grants',    label: 'Grant 관리' },
  { id: 'audit',     label: '감사 로그' },
  { id: 'backup',    label: '백업/복원' },
  { id: 'security',  label: '보안 체크리스트' },
  { id: 'settings',  label: '앱 설정' },
  { id: 'holidays',  label: '공휴일 동기화' },
  { id: 'bulk',      label: '일괄 업로드' },
  { id: 'migration', label: '데이터 이관' },
  { id: 'statutory', label: '법정연차 배치' },
]

const MONTH_NAMES = [
  '1월 (Jan)', '2월 (Feb)', '3월 (Mar)', '4월 (Apr)',
  '5월 (May)', '6월 (Jun)', '7월 (Jul)', '8월 (Aug)',
  '9월 (Sep)', '10월 (Oct)', '11월 (Nov)', '12월 (Dec)',
]

function LeaveTypesPanel() {
  const { data: leaveTypes = [], isLoading } = useLeaveTypes()
  const update = useUpdateLeaveType()
  const [toggling, setToggling] = useState<string | null>(null)

  async function toggleActive(name: string, current: boolean) {
    setToggling(name)
    try { await update.mutateAsync({ name, active: !current }) }
    finally { setToggling(null) }
  }

  if (isLoading) return <p className="text-sm text-muted">Loading…</p>

  return (
    <div>
      <h2 className="text-sm font-semibold text-gray-800 mb-1">휴가 유형 관리</h2>
      <p className="text-xs text-muted mb-3">
        비활성(inactive) 유형은 신규 배정의 선택 목록에서 제외됩니다. 기존 이력은 유지됩니다.
      </p>
      <div className="card overflow-hidden p-0">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-surface-50 text-xs text-muted">
              <th className="px-4 py-2 text-left font-medium">유형명</th>
              <th className="px-4 py-2 text-left font-medium">상태</th>
              <th className="px-4 py-2 text-right font-medium">전환</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {leaveTypes.map(lt => {
              const busy = toggling === lt.name
              return (
                <tr key={lt.name} className="hover:bg-surface-50 transition-colors">
                  <td className="px-4 py-2.5 font-medium text-gray-900">{lt.name}</td>
                  <td className="px-4 py-2.5">
                    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${lt.active ? 'bg-emerald-100 text-emerald-700' : 'bg-gray-100 text-gray-500'}`}>
                      {lt.active ? '활성' : '비활성'}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <button
                      disabled={busy}
                      onClick={() => void toggleActive(lt.name, lt.active)}
                      className={lt.active ? 'btn-danger text-xs py-1' : 'btn-secondary text-xs py-1'}
                    >
                      {busy ? '…' : lt.active ? '비활성화' : '활성화'}
                    </button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {update.isError && (
        <p className="text-xs text-red-600 mt-2">저장 실패: {String(update.error)}</p>
      )}
    </div>
  )
}

function SettingsPanel() {
  const { data: s, isLoading } = useSettings()
  const update = useUpdateSettings()

  if (isLoading) return <div className="text-sm text-muted">Loading…</div>

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-sm font-semibold text-gray-800 mb-1">대시보드 설정</h2>
        <p className="text-xs text-muted mb-4">YTD Utilization 계산에 사용할 회계연도 시작 월을 설정합니다.</p>
        <label className="block text-xs font-medium text-gray-700 mb-1">회계연도 시작 월</label>
        <select
          className="input w-48"
          value={s?.fiscal_year_start_month ?? 7}
          onChange={e => update.mutate({ fiscal_year_start_month: Number(e.target.value) })}
          disabled={update.isPending}
        >
          {MONTH_NAMES.map((name, i) => (
            <option key={i + 1} value={i + 1}>{name}</option>
          ))}
        </select>
        {update.isError && (
          <p className="text-xs text-red-600 mt-1">
            저장 실패: migration 0009가 Supabase에 적용되었는지 확인해 주세요.
          </p>
        )}
        {update.isSuccess && (
          <p className="text-xs text-emerald-700 mt-1">저장됨</p>
        )}
      </div>

      <div className="border-t border-border pt-6">
        <LeaveTypesPanel />
      </div>
    </div>
  )
}

export default function AdminPage() {
  const { isAdmin } = useAuthz()
  const [tab, setTab] = useState<Tab>('accounts')

  // Hard redirect for non-admins — sidebar already hides the nav item,
  // but this guards against direct URL navigation.
  if (!isAdmin()) return <Navigate to="/timeline" replace />

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="border-b border-border px-6 py-4">
        <h1 className="text-base font-semibold text-gray-900">Admin</h1>
        <p className="text-xs text-muted">admin 전용 관리 기능</p>
      </div>

      {/* Tab bar */}
      <div className="flex gap-1 border-b border-border px-6 pt-2 overflow-x-auto">
        {TABS.map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={[
              'px-4 py-2 text-sm font-medium whitespace-nowrap transition-colors',
              tab === t.id
                ? 'border-b-2 border-brand-600 text-brand-700'
                : 'text-muted hover:text-gray-900',
            ].join(' ')}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-auto p-6">
        <div className="max-w-3xl">
          {tab === 'accounts'  && <AccountManager />}
          {tab === 'grants'    && <GrantsManager />}
          {tab === 'audit'     && <AuditLogViewer />}
          {tab === 'backup'    && <BackupRestore />}
          {tab === 'security'  && <SecurityChecklist />}
          {tab === 'settings'  && <SettingsPanel />}
          {tab === 'holidays'  && <HolidaySyncPanel />}
          {tab === 'bulk'      && <BulkUploadPanel />}
          {tab === 'migration' && <MigrationPanel />}
          {tab === 'statutory' && <StatutoryFillPanel />}
        </div>
      </div>
    </div>
  )
}
