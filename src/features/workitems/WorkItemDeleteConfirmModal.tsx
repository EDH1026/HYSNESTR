import { Loader2 } from 'lucide-react'
import Modal from '@/components/Modal'
import type { WorkItem } from '@/types'

interface Props {
  workItem:        WorkItem
  assignmentCount: number | null   // PRD T-23: null while still being counted
  isDeleting:      boolean
  onConfirm:       () => void
  onClose:         () => void
}

/** PRD v2.104 T-23⑤ — shared by the workitem-band kebab and WorkItemModal's own delete button. */
export default function WorkItemDeleteConfirmModal({
  workItem, assignmentCount, isDeleting, onConfirm, onClose,
}: Props) {
  return (
    <Modal title="작업항목 삭제" onClose={onClose} size="sm">
      <div className="space-y-3">
        <p className="text-sm text-gray-700">
          <span className="font-semibold">"{workItem.name}"</span>을(를) 삭제하시겠습니까?
        </p>

        <div className="flex items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          {assignmentCount === null ? (
            <><Loader2 size={12} className="animate-spin flex-shrink-0" /> 연결된 배정 건수 확인 중…</>
          ) : assignmentCount > 0 ? (
            <span>연결된 <span className="font-semibold">{assignmentCount}건</span>의 배정도 함께 삭제됩니다.</span>
          ) : (
            <span>연결된 배정이 없습니다.</span>
          )}
        </div>

        <p className="text-xs text-muted">이 작업은 되돌릴 수 없습니다.</p>

        {/* autoFocus on Cancel (not Delete) so Enter/keyboard default never fires the destructive action */}
        <div className="flex gap-2 pt-1">
          <button type="button" autoFocus onClick={onClose} className="btn-secondary flex-1">
            취소
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={isDeleting || assignmentCount === null}
            className="btn-danger flex-1"
          >
            {isDeleting ? <Loader2 size={14} className="animate-spin mx-auto" /> : '삭제'}
          </button>
        </div>
      </div>
    </Modal>
  )
}
