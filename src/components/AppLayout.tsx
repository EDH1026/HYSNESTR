import { useState, useEffect } from 'react'
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
  FileText,
  Hash,
  Settings,
  Database,
  LogOut,
  Menu,
  X,
  Undo2,
  Redo2,
  AlertTriangle,
  Lock,
} from 'lucide-react'
import { useAuth } from '@/context/AuthContext'
import { useHistory } from '@/lib/history'
import { useMobile } from '@/hooks/useMobile'
import type { GlobalRole } from '@/types'

const NAV: {
  to:           string
  label:        string
  icon:         LucideIcon
  editorOnly?:  boolean   // hidden for viewer
  adminOnly?:   boolean   // hidden for non-admin
}[] = [
  // ── Viewer-accessible (§6.3) ──────────────────────────────
  { to: '/dashboard',  label: 'Dashboard',       icon: LayoutDashboard },
  { to: '/timeline',   label: 'Timeline',        icon: CalendarDays    },
  { to: '/hashtags',   label: 'Engagement 검색', icon: Hash            },
  { to: '/cv',         label: 'CV Generator',    icon: FileText        },
  { to: '/leave',      label: 'Leave',           icon: Umbrella        },
  // ── Editor / admin only ───────────────────────────────────
  { to: '/people',     label: 'People',          icon: Users,           editorOnly: true },
  { to: '/work-items', label: 'Work Items',       icon: Briefcase,       editorOnly: true },
  { to: '/holidays',   label: 'Holidays',         icon: CalendarCheck,   editorOnly: true },
  // ── Admin only ────────────────────────────────────────────
  { to: '/migration',  label: 'Migration',        icon: Database,        adminOnly: true  },
  { to: '/admin',      label: 'Admin',            icon: Settings,        adminOnly: true  },
]

const ROLE_PILL: Record<GlobalRole, string> = {
  admin:  'bg-brand-100 text-brand-700',
  editor: 'bg-green-100 text-green-700',
  viewer: 'bg-gray-100  text-gray-600',
}

export default function AppLayout() {
  const { profile, signOut } = useAuth()
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const { canUndo, canRedo, undoLabel, redoLabel, error, undo, redo, clearError } = useHistory()
  const isMobile = useMobile()

  const displayName    = profile?.name ?? '—'
  const role           = profile?.global_role ?? 'viewer'
  const isAdmin        = role === 'admin'
  const isViewer       = role === 'viewer'
  const canUseHistory  = !isViewer && !isMobile

  useEffect(() => {
    function handler(e: KeyboardEvent) {
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
    if (item.adminOnly)  return isAdmin
    if (item.editorOnly) return !isViewer
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

      {/* Undo / Redo — editor/admin only */}
      {canUseHistory && (
        <div className="border-t border-border px-3 py-2 flex items-center gap-1">
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
    </div>
  )
}
