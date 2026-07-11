import TimesheetGuidelineTab from '@/features/annualleave/TimesheetGuidelineTab'

export default function TimesheetGuidelinePage() {
  return (
    <div className="h-full flex flex-col">
      <div className="flex-shrink-0 px-6 py-4 border-b border-border">
        <h1 className="text-lg font-semibold text-gray-900">타임시트 지침</h1>
        <p className="text-xs text-muted mt-0.5">
          TSG-1~9 · engagement code 지침 산출 · 스냅샷 관리 (editor/admin 전용)
        </p>
      </div>
      <div className="flex-1 overflow-auto p-6">
        <TimesheetGuidelineTab />
      </div>
    </div>
  )
}
