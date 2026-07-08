import AnnualLeavePanel from '@/features/annualleave/AnnualLeavePanel'

export default function AnnualLeavePage() {
  return (
    <div className="h-full flex flex-col">
      <div className="flex-shrink-0 px-6 py-4 border-b border-border">
        <h1 className="text-lg font-semibold text-gray-900">연차 관리</h1>
        <p className="text-xs text-muted mt-0.5">법정연차 적립 · 퇴사 정산 · 타임시트 수치 안내 (editor/admin 전용)</p>
      </div>
      <div className="flex-1 overflow-hidden">
        <AnnualLeavePanel />
      </div>
    </div>
  )
}
