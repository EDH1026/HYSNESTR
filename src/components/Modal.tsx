import { type ReactNode, useEffect } from 'react'
import { X } from 'lucide-react'

interface Props {
  title:    string
  onClose:  () => void
  children: ReactNode
  size?:    'sm' | 'md' | 'lg'
}

const SIZE = { sm: 'max-w-sm', md: 'max-w-lg', lg: 'max-w-2xl' }

export default function Modal({ title, onClose, children, size = 'md' }: Props) {
  // Esc to close (§9.3)
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', h)
    return () => document.removeEventListener('keydown', h)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40"
      onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className={`card w-full ${SIZE[size]} max-h-[90vh] flex flex-col`}>
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-4 py-3 flex-shrink-0">
          <h2 className="text-sm font-semibold text-gray-900">{title}</h2>
          <button
            onClick={onClose}
            className="rounded p-1 text-muted hover:bg-surface-100 hover:text-gray-700 transition-colors"
          >
            <X size={16} />
          </button>
        </div>
        {/* Body — scrollable */}
        <div className="overflow-y-auto flex-1 px-4 py-4 space-y-4">
          {children}
        </div>
      </div>
    </div>
  )
}
