/**
 * AuditLogViewer — read-only audit trail for admins
 *
 * Shows who made what change and when. Rows come from the audit_log table
 * (append-only, WITH CHECK(false) prevents client inserts).
 */
import { useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { useAuditLog } from './adminHooks'

const LIMIT_OPTIONS = [50, 100, 200, 500]

const ACTION_PILL: Record<string, string> = {
  create: 'bg-green-100 text-green-700',
  update: 'bg-blue-100  text-blue-700',
  delete: 'bg-red-100   text-red-700',
  grant:  'bg-violet-100 text-violet-700',
  revoke: 'bg-orange-100 text-orange-700',
}

function actionPill(action: string) {
  return ACTION_PILL[action] ?? 'bg-gray-100 text-gray-600'
}

export default function AuditLogViewer() {
  const [limit,          setLimit]          = useState(100)
  const [filterType,     setFilterType]     = useState('')
  const [filterAction,   setFilterAction]   = useState('')

  const { data = [], isLoading, error, refetch, isFetching } = useAuditLog(limit)

  const targetTypes  = [...new Set(data.map(e => e.target_type))].sort()
  const actionTypes  = [...new Set(data.map(e => e.action))].sort()

  const filtered = data.filter(
    e =>
      (!filterType   || e.target_type === filterType) &&
      (!filterAction || e.action      === filterAction),
  )

  function fmtAt(iso: string) {
    try {
      return new Intl.DateTimeFormat('ko-KR', {
        year:   'numeric', month:  '2-digit', day:    '2-digit',
        hour:   '2-digit', minute: '2-digit', second: '2-digit',
      }).format(new Date(iso))
    } catch {
      return iso
    }
  }

  if (error) return (
    <p className="text-sm text-red-600 py-4">
      감사 로그를 불러오지 못했습니다:{' '}
      {error instanceof Error ? error.message : '알 수 없는 오류가 발생했습니다.'}
    </p>
  )

  return (
    <div className="space-y-3">
      {/* Controls */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <label className="text-xs text-muted font-medium">최대 조회</label>
          <select
            value={limit}
            onChange={e => setLimit(Number(e.target.value))}
            className="input text-xs py-1"
          >
            {LIMIT_OPTIONS.map(n => <option key={n} value={n}>{n}건</option>)}
          </select>
        </div>

        {targetTypes.length > 0 && (
          <div className="flex items-center gap-2">
            <label className="text-xs text-muted font-medium">대상 타입</label>
            <select
              value={filterType}
              onChange={e => setFilterType(e.target.value)}
              className="input text-xs py-1"
            >
              <option value="">전체</option>
              {targetTypes.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
        )}

        {actionTypes.length > 0 && (
          <div className="flex items-center gap-2">
            <label className="text-xs text-muted font-medium">Action</label>
            <select
              value={filterAction}
              onChange={e => setFilterAction(e.target.value)}
              className="input text-xs py-1"
            >
              <option value="">전체</option>
              {actionTypes.map(a => <option key={a} value={a}>{a}</option>)}
            </select>
          </div>
        )}

        <button
          onClick={() => refetch()}
          disabled={isFetching}
          className="btn-secondary text-xs py-1 gap-1.5"
        >
          <RefreshCw size={11} className={isFetching ? 'animate-spin' : ''} />
          새로고침
        </button>

        <span className="text-xs text-muted ml-auto">
          {filtered.length}건 표시 / {data.length}건 조회
        </span>
      </div>

      {/* Table */}
      {isLoading ? (
        <p className="text-sm text-muted py-4">Loading…</p>
      ) : filtered.length === 0 ? (
        <p className="text-sm text-muted py-4 text-center">감사 로그가 없습니다.</p>
      ) : (
        <div className="card overflow-hidden p-0 overflow-x-auto">
          <table className="w-full text-xs min-w-[700px]">
            <thead>
              <tr className="border-b border-border bg-surface-50 text-muted">
                <th className="px-3 py-2.5 text-left font-medium whitespace-nowrap">일시</th>
                <th className="px-3 py-2.5 text-left font-medium">사용자</th>
                <th className="px-3 py-2.5 text-left font-medium">Action</th>
                <th className="px-3 py-2.5 text-left font-medium">대상 타입</th>
                <th className="px-3 py-2.5 text-left font-medium">대상 ID</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {filtered.map(e => (
                <tr key={e.id} className="hover:bg-surface-50">
                  <td className="px-3 py-2 font-mono whitespace-nowrap text-muted">
                    {fmtAt(e.at)}
                  </td>
                  <td className="px-3 py-2 text-gray-800">
                    {e.user_name ?? (
                      e.user_id
                        ? <span className="text-muted">{e.user_id.slice(0, 8)}…</span>
                        : <span className="text-muted italic">(삭제된 계정)</span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <span className={`pill text-[10px] ${actionPill(e.action)}`}>{e.action}</span>
                  </td>
                  <td className="px-3 py-2 text-muted">{e.target_type}</td>
                  <td className="px-3 py-2 font-mono text-muted text-[10px]">
                    {e.target_id?.slice(0, 12)}…
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
