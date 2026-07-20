import { useState, useEffect, useMemo } from 'react'
import { NavLink, Outlet } from 'react-router-dom'
import type { LucideIcon } from 'lucide-react'
import logo from '@/assets/logo.png'
import {
  LayoutDashboard,
  CalendarDays,
  Users,
  Briefcase,
  Umbrella,
  CalendarCheck,
  CalendarCheck2,
  ClipboardList,
  FileText,
  Hash,
  Settings,
  LogOut,
  Menu,
  X,
  Undo2,
  Redo2,
  AlertTriangle,
  Lock,
  Search,
} from 'lucide-react'
import { useAuth } from '@/context/AuthContext'
import { useHistory } from '@/lib/history'
import { useMobile } from '@/hooks/useMobile'
import { useAuthz } from '@/hooks/useAuthz'
import { useAllAssignments } from '@/features/timeline/hooks'
import { useAllPeople }      from '@/features/people/hooks'
import { useAllWorkItems }   from '@/features/workitems/hooks'
import { useAllHolidays }    from '@/features/admin/hooks'
import { buildHolidaySet }   from '@/features/leave/ledger'
import { buildWorkItemColorMap } from '@/lib/colors'
import GlobalSearchPalette from './GlobalSearchPalette'
import WorkItemDetailModal from '@/features/workitems/WorkItemDetailModal'
import type { GlobalRole, WorkItem } from '@/types'

const NAV: {
  to:                 string
  label:              string
  icon:               LucideIcon
  editorOnly?:         boolean   // hidden for viewer (editor/assistant/admin)
  adminOnly?:          boolean   // hidden for non-admin
  adminOrAssistantOnly?: boolean // hidden for editor/viewer (PRD v2.100)
}[] = [
  // ── Viewer-accessible (§6.3) ──────────────────────────────
  { to: '/dashboard',  label: 'Dashboard',       icon: LayoutDashboard },
  { to: '/timeline',   label: 'Timeline',        icon: CalendarDays    },
  // ── Editor / admin only ───────────────────────────────────
  { to: '/work-items',   label: 'Work Items',     icon: Briefcase,       editorOnly: true },
  // ── Viewer-accessible (cont.) ─────────────────────────────
  { to: '/hashtags',   label: 'Engagement 검색', icon: Hash            },
  { to: '/cv',         label: 'CV Generator',    icon: FileText        },
  // ── Admin only (v2.100 — was editorOnly) ──────────────────
  { to: '/people',       label: 'People',         icon: Users,           adminOnly: true },
  // ── Admin only (v2.103 — was editorOnly) ──────────────────
  { to: '/holidays',     label: 'Holidays',       icon: CalendarCheck,   adminOnly: true },
  // ── Viewer-accessible (cont.) ─────────────────────────────
  { to: '/leave',      label: 'Leave',           icon: Umbrella        },
  // ── Admin / assistant only (v2.100 — was editorOnly) ──────
  { to: '/annual-leave',         label: '연차 관리',     icon: CalendarCheck2, adminOrAssistantOnly: true },
  { to: '/timesheet-guideline', label: '타임시트 지침', icon: ClipboardList,  adminOrAssistantOnly: true },
  // ── Admin only ────────────────────────────────────────────
  { to: '/admin',      label: 'Admin',            icon: Settings,        adminOnly: true  },
]

const ROLE_PILL: Record<GlobalRole, string> = {
  admin:     'bg-brand-100 text-brand-700',
  editor:    'bg-green-100 text-green-700',
  viewer:    'bg-gray-100  text-gray-600',
  assistant: 'bg-purple-100 text-purple-700',
}

export default function AppLayout() {
  const { profile, signOut } = useAuth()
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [searchOpen,  setSearchOpen]  = useState(false)
  const [detailWI,    setDetailWI]    = useState<WorkItem | null>(null)
  const { canUndo, canRedo, undoLabel, redoLabel, error, undo, redo, clearError } = useHistory()
  const isMobile = useMobile()
  const { canEdit, isAdmin: isAdminFn } = useAuthz()

  const displayName    = profile?.name ?? '—'
  const role           = profile?.global_role ?? 'viewer'
  const isAdmin        = role === 'admin'
  const isViewer       = role === 'viewer'
  const isAssistantRole = role === 'assistant'
  const canUseHistory  = !isViewer && !isMobile

  // §5.11a: data for WorkItemDetailModal shown from global search
  const { data: allAssignments = [] } = useAllAssignments()
  const { data: allPeople      = [] } = useAllPeople()
  const { data: allWorkItems   = [] } = useAllWorkItems()
  const { data: allHolidays    = [] } = useAllHolidays()
  const peopleMap = useMemo(
    () => new Map(allPeople.map(p => [p.id, p])),
    [allPeople],
  )
  // v2.95: WorkItemDetailModal의 Pre-study 종료일(prevWorkday) 계산용
  const holidaySet = useMemo(() => {
    const yr = new Date().getFullYear()
    return buildHolidaySet(allHolidays, yr - 3, yr + 3)
  }, [allHolidays])
  const colorMap = useMemo(() => buildWorkItemColorMap(allWorkItems), [allWorkItems])

  useEffect(() => {
    function handler(e: KeyboardEvent) {
      // §5.11a: Ctrl+K / Cmd+K → open global search
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault()
        setSearchOpen(v => !v)
        return
      }
      if (!canUseHistory) return
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      if ((e.target as HTMLElement)?.isContentEditable) return
      if (e.ctrlKey || e.metaKey) {
        if (e.key === 'z' && !e.shiftKey) { e.preventDefault(); void undo() }
        if (e.key === 'y' || (e.key === 'Z' && e.shiftKey)) { e.preventDefault(); void redo() }
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [canUseHistory, undo, redo])

  const navItems = NAV.filter(item => {
    if (item.adminOnly)           return isAdmin
    if (item.adminOrAssistantOnly) return isAdmin || isAssistantRole
    if (item.editorOnly)          return !isViewer
    return true
  })

  const sidebar = (
    <aside className="flex w-56 flex-shrink-0 flex-col border-r border-border bg-surface-0 h-full">
      {/* Logo */}
      <div className="flex h-14 items-center gap-2.5 border-b border-border px-4 min-w-0">
        <img src={logo} alt="" className="h-8 w-8 flex-shrink-0 object-contain" />
        <div className="min-w-0">
          <p className="text-[11px] font-semibold text-gray-900 leading-tight truncate">Strategy Team Dashboard</p>
        </div>
        {/* Close button — mobile only */}
        <button className="ml-auto lg:hidden text-muted hover:text-gray-700" onClick={() => setSidebarOpen(false)}>
          <X size={16} />
        </button>
      </div>

      {/* §5.11a: Global search button */}
      <div className="px-3 py-2 border-b border-border">
        <button
          onClick={() => setSearchOpen(true)}
          className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-muted hover:text-gray-700 hover:bg-surface-100 rounded-md transition-colors border border-border bg-surface-50"
        >
          <Search size={13} />
          <span className="flex-1 text-left text-xs">검색…</span>
          <kbd className="text-[10px] text-muted/70">Ctrl K</kbd>
        </button>
      </div>

      {/* Nav */}
      <nav className="flex-1 overflow-y-auto py-3">
        {navItems.map(({ to, label, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            onClick={() => setSidebarOpen(false)}
            className={({ isActive }) =>
              [
                'flex items-center gap-3 px-4 py-2 text-sm font-medium transition-colors',
                isActive
                  ? 'bg-brand-50 text-brand-700'
                  : 'text-muted hover:bg-surface-100 hover:text-gray-900',
              ].join(' ')
            }
          >
            <Icon size={16} />
            {label}
          </NavLink>
        ))}
      </nav>

      {/* PRD v2.107 §5.1: 작업내역(실행취소/재실행) 패널 상단 보안 경고 — 전 역할 공통,
          undo/redo 버튼 자체는 기존처럼 editor/admin(canUseHistory)에게만 노출 */}
      <div className="border-t border-border">
        <p className="sticky top-0 bg-surface-0 px-3 pt-2 pb-1 text-[10px] leading-snug text-muted">
          프로젝트 수행 및 제안 내역은 법적 문제를 유발할 수 있으므로 회사의 명시적 허락없이 외부 공개 불가
        </p>
        {canUseHistory && (
          <div className="px-3 pb-2 flex items-center gap-1">
            <button
              onClick={() => void undo()}
              disabled={!canUndo}
              title={undoLabel ? `실행취소: ${undoLabel} (Ctrl+Z)` : '실행취소 (Ctrl+Z)'}
              className={[
                'flex items-center gap-1.5 px-2 py-1.5 rounded text-xs font-medium transition-colors flex-1 truncate',
                canUndo ? 'text-gray-700 hover:bg-surface-100' : 'text-muted/40 cursor-not-allowed',
              ].join(' ')}
            >
              <Undo2 size={13} className="flex-shrink-0" />
              <span className="truncate">{undoLabel ?? '실행취소'}</span>
            </button>
            <button
              onClick={() => void redo()}
              disabled={!canRedo}
              title={redoLabel ? `재실행: ${redoLabel} (Ctrl+Y)` : '재실행 (Ctrl+Y)'}
              className={[
                'flex-shrink-0 p-1.5 rounded transition-colors',
                canRedo ? 'text-gray-700 hover:bg-surface-100' : 'text-muted/40 cursor-not-allowed',
              ].join(' ')}
            >
              <Redo2 size={13} />
            </button>
          </div>
        )}
      </div>

      {/* User info + sign-out + credit */}
      <div className="border-t border-border p-3 space-y-2">
        <div className="flex items-center gap-2 rounded-md px-3 py-2">
          <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-brand-100 text-brand-700 text-xs font-semibold">
            {displayName.charAt(0).toUpperCase()}
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-gray-900">{displayName}</p>
            <span className={`inline-block rounded px-1.5 py-0.5 text-[11px] font-medium leading-tight ${ROLE_PILL[role]}`}>
              {role}
            </span>
          </div>
        </div>

        <button
          onClick={signOut}
          className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm text-muted hover:bg-surface-100 hover:text-gray-900 transition-colors"
        >
          <LogOut size={16} />
          Sign out
        </button>

        <p className="px-3 text-[10px] text-muted/70 leading-tight">Created by Eudong Hwang</p>
      </div>
    </aside>
  )

  return (
    <div className="flex h-screen overflow-hidden bg-surface-50">
      {/* Desktop sidebar */}
      <div className="hidden lg:flex flex-shrink-0">
        {sidebar}
      </div>

      {/* Mobile sidebar overlay */}
      {sidebarOpen && (
        <div className="lg:hidden fixed inset-0 z-40 flex">
          <div className="flex-shrink-0">{sidebar}</div>
          <div className="flex-1 bg-black/30" onClick={() => setSidebarOpen(false)} />
        </div>
      )}

      {/* Main */}
      <main className="flex flex-1 flex-col overflow-hidden min-w-0">
        {/* Mobile top bar */}
        <div className="lg:hidden flex items-center gap-3 px-4 py-2 border-b border-border bg-surface-0 flex-shrink-0">
          <button onClick={() => setSidebarOpen(true)} className="text-muted hover:text-gray-700">
            <Menu size={20} />
          </button>
          <img src={logo} alt="" className="h-8 w-8 flex-shrink-0 object-contain" />
          <span className="text-xs font-semibold text-gray-900">Strategy Team Dashboard</span>
          {/* §5.11a: search icon (mobile) */}
          <button onClick={() => setSearchOpen(true)} className="text-muted hover:text-gray-700 p-1">
            <Search size={18} />
          </button>
          {canUseHistory && (
            <div className="ml-auto flex items-center gap-1">
              <button onClick={() => void undo()} disabled={!canUndo}
                title={undoLabel ? `실행취소: ${undoLabel}` : '실행취소'}
                className={canUndo ? 'text-gray-700 p-1' : 'text-muted/40 p-1 cursor-not-allowed'}>
                <Undo2 size={16} />
              </button>
              <button onClick={() => void redo()} disabled={!canRedo}
                title={redoLabel ? `재실행: ${redoLabel}` : '재실행'}
                className={canRedo ? 'text-gray-700 p-1' : 'text-muted/40 p-1 cursor-not-allowed'}>
                <Redo2 size={16} />
              </button>
            </div>
          )}
        </div>
        {/* Mobile read-only banner (§6.6 MOB-3) */}
        {isMobile && (
          <div className="flex items-center gap-2 px-4 py-2 bg-amber-50 border-b border-amber-200 text-xs text-amber-700 flex-shrink-0">
            <Lock size={12} className="flex-shrink-0" />
            <span>모바일에서는 읽기 전용으로 제공됩니다.</span>
          </div>
        )}
        {/* History error banner */}
        {error && (
          <div className="flex items-start gap-2 px-4 py-2 bg-red-50 border-b border-red-200 text-xs text-red-700 flex-shrink-0">
            <AlertTriangle size={13} className="flex-shrink-0 mt-0.5" />
            <span className="flex-1">{error}</span>
            <button onClick={clearError} className="flex-shrink-0 text-red-500 hover:text-red-700 ml-2">
              <X size={13} />
            </button>
          </div>
        )}
        <div className="flex-1 overflow-y-auto">
          <Outlet />
        </div>
      </main>

      {/* §5.11a: Global search palette */}
      {searchOpen && (
        <GlobalSearchPalette
          onClose={() => setSearchOpen(false)}
          onSelectWorkItem={wi => { setDetailWI(wi); setSearchOpen(false) }}
        />
      )}

      {/* §5.11a: Work item detail modal opened from search */}
      {detailWI && (() => {
        const latest = allWorkItems.find(w => w.id === detailWI.id) ?? detailWI
        const isClosed = (latest.status ?? latest.project_status ?? 'open') === 'closed'
        const canEditWI = !isClosed && (isAdminFn() || canEdit('work_item', latest.id))
        // v2.95: 전역 검색에서도 실제 편집 경로가 없으므로 onEdit 미전달 → 편집 버튼 미노출
        return (
          <WorkItemDetailModal
            workItem={latest}
            assignments={allAssignments}
            peopleMap={peopleMap}
            colorMap={colorMap}
            canEdit={canEditWI}
            isHoliday={n => holidaySet.has(n)}
            onClose={() => setDetailWI(null)}
          />
        )
      })()}
    </div>
  )
}
