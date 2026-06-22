import type { WorkItem } from '@/types'

// §4 / §9.1 / PRD v2.3 B.1 — type-based color families
// project=blue, proposal=amber/yellow, pipeline=gray
export const TYPE_FAMILY: Record<string, readonly string[]> = {
  project:  ['#1e40af', '#2563eb', '#1d4ed8', '#3b82f6', '#1e3a8a', '#60a5fa'],
  proposal: ['#d97706', '#f59e0b', '#b45309', '#fbbf24', '#92400e', '#f97316'],
  pipeline: ['#6b7280', '#4b5563', '#374151', '#9ca3af', '#64748b', '#1f2937'],
}

// PRD v2.3 B.1 LEAVE_GREEN — leave-type specific green/teal shades
export const LEAVE_GREEN: Record<string, string> = {
  '지정휴가':          '#10b981',
  '프로젝트휴가':      '#059669',
  '주말/휴일대체':     '#14b8a6',
  '포상휴가':          '#84cc16',
  '특별휴가':          '#22c55e',
  '지연보상':          '#0d9488',
  '리프레시':          '#34d399',
  '휴직':              '#84a98c',
  '종료 후 잔여 소진': '#16a34a',
}

const LEAVE_FALLBACK = '#10b981'

/** Derive leave bar color from leave_type. */
export function leaveColor(leaveType: string | null): string {
  return LEAVE_GREEN[leaveType ?? ''] ?? LEAVE_FALLBACK
}

/**
 * Build Map<workItem.id, hex-color> by assigning each item an index
 * within its type group (order = array order), cycling through TYPE_FAMILY.
 */
export function buildWorkItemColorMap(workItems: WorkItem[]): Map<string, string> {
  const counter: Record<string, number> = {}
  const map = new Map<string, string>()
  for (const wi of workItems) {
    const family = TYPE_FAMILY[wi.type] ?? TYPE_FAMILY.project
    const i = counter[wi.type] ?? 0
    map.set(wi.id, family[i % family.length])
    counter[wi.type] = i + 1
  }
  return map
}

/** First (representative) color for a type. Used for legend/swatches. */
export function typeRepColor(type: string): string {
  return (TYPE_FAMILY[type] ?? TYPE_FAMILY.project)[0]
}

/** Derive assignment bar color: leave uses LEAVE_GREEN, work uses colorMap. */
export function barColorOf(
  wi:        WorkItem | undefined,
  kind:      'work' | 'leave',
  leaveType: string | null,
  colorMap:  Map<string, string>,
): string {
  if (kind === 'leave') return leaveColor(leaveType)
  if (!wi) return '#94a3b8'
  return colorMap.get(wi.id) ?? (TYPE_FAMILY[wi.type]?.[0] ?? '#2563eb')
}
