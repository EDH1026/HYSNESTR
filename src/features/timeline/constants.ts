// Timeline layout constants
export const LABEL_W       = 320  // px — fixed left label column
export const ROW_H         = 44   // px — height of each timeline row
export const HEADER_ROW_H  = 28   // px — height of one header tier (month / week / day)
export const BAR_PAD       = 6    // px — vertical padding inside a row for bars
export const HANDLE_W      = 8    // px — resize handle width on each side
export const DRAG_THRESHOLD = 4   // px — min movement before drag is registered

// Day-width range (pixels per day)
export const DAY_MIN     = 3
export const DAY_MAX     = 50
export const DAY_DEFAULT = 8

// Zoom thresholds: dayWidth >= value → show that tier
export const ZOOM_WEEK = 8   // show week row
export const ZOOM_DAY  = 22  // show individual day row

// Color derivation moved to src/lib/colors.ts (PRD v2.3 §4/§9.1)
// Colors are derived from work-item type/leave-type — not stored per item.

// Rank seniority order (lower number = higher seniority) — used for person sort (§5.2 F-1.8)
export const RANK_ORDER: Record<string, number> = {
  Partner: 0, SM: 1, M: 2, Senior: 3, Staff: 4, Intern: 5,
}

// Background tints (inline style strings)
export const WEEKEND_BG = 'rgba(0,0,0,0.035)'
export const HOLIDAY_BG = 'rgba(239,68,68,0.07)'
export const TODAY_COLOR = '#6366f1'
