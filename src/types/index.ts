// ---------------------------------------------------------------------------
// Enum-like string union types
// ---------------------------------------------------------------------------

export type GlobalRole = 'admin' | 'editor' | 'viewer' | 'assistant'

export type Rank = 'Partner' | 'SM' | 'M' | 'Senior' | 'Staff' | 'Intern'

export type WorkItemType = 'project' | 'proposal' | 'pipeline'

export type AssignmentKind = 'work' | 'leave'

// Must match the DB CHECK constraint in assignments.leave_type
export type LeaveType =
  | '리프레시'          // unpaid, no balance effect
  | '지정휴가'          // paid, deducted
  | '프로젝트휴가'      // paid, accrued automatically from project main phase
  | '주말/휴일대체'     // paid, accrued from weekend_dates
  | '포상휴가'          // paid, manual accrual
  | '특별휴가'          // paid, manual accrual
  | '지연보상'          // paid, automatic when accrual delayed ≥15 days
  | '휴직'              // unpaid, no balance effect
  | '종료 후 잔여 소진' // paid, use remaining balance after project end

export type AccrualType = Exclude<LeaveType, '리프레시' | '지정휴가' | '휴직' | '종료 후 잔여 소진'>

export type GrantScope = 'global' | 'person' | 'work_item'

export type GrantLevel = 'view' | 'edit' | 'admin'

// ---------------------------------------------------------------------------
// Database row types (mirror Supabase Postgres tables)
// ---------------------------------------------------------------------------

/** Linked to auth.users — one row per login account. */
export interface Profile {
  id: string                  // = auth.users.id (UUID)
  name: string
  global_role: GlobalRole
  person_id: string | null    // links to people.id when the user is also a team member
  lpn?: string | null         // 인력 식별 번호 — LPN 매칭용 (PRD §4); optional until database.ts regenerated
  status: 'active' | 'inactive'
}

export type PersonStatus = 'active' | 'resigned' | 'upcoming'

/** A team member (人力). Separate from auth account. */
export interface Person {
  id: string
  name: string
  rank: Rank
  role: string                // job title / functional role
  lpn: string | null          // 인력 식별 번호 (PRD §4)
  hire_date: string | null    // YYYY-MM-DD
  termination_date: string | null
  status: PersonStatus
  nbd_code: string | null     // NBD engagement code (Partner rank only, AL-11)
}

/**
 * A time-boxed work item: project or proposal.
 * Projects have a pre-study phase (start → main_start - 1) and a main phase (main_start → end_date).
 * Proposals have no pre-study split.
 */
export interface WorkItem {
  id: string
  type: WorkItemType
  name: string
  // color field intentionally omitted — derived from type via src/lib/colors.ts (PRD v2.3 §4)
  start: string               // YYYY-MM-DD — overall start (pre-study for projects)
  main_start: string | null   // YYYY-MM-DD — main phase start (projects only)
  end_date: string            // YYYY-MM-DD
  engagement_number: string | null
  temp_engagement_code?: string | null        // AL-17: 정식 코드 미확정 시 임시 타임시트 코드 (PRD v2.54)
  client: string | null
  hashtags: string[]
  status?: 'open' | 'closed' | null           // 전 유형 공통 (PRD v2.4 §3); optional until database.ts regenerated
  project_status?: 'open' | 'closed' | null  // 레거시: project 전용, 하위 호환 유지. 신규 코드는 status 사용
  description?: string | null                 // §3 PRD v2.2 — 자유 텍스트 상세 설명
  confidential?: boolean                      // §3 PRD v2.2 — true = editor/admin만 이름·고객사 원본 노출
}

/**
 * An assignment of a person to a work item or a leave block.
 * kind=work  → person is working on work_item_id
 * kind=leave → person is on leave (leave_type required)
 *
 * Individual start/end dates are independent of the work item's dates.
 * weekend_dates lists specific calendar dates (YYYY-MM-DD) on which the
 * person actually worked during a weekend or public holiday.
 */
export interface Assignment {
  id: string
  person_id: string
  kind: AssignmentKind
  work_item_id: string | null
  weekend_dates: string[]     // actual weekend/holiday dates worked
  leave_type: LeaveType | null
  start: string               // YYYY-MM-DD
  end_date: string            // YYYY-MM-DD
  note: string | null
}

/**
 * A leave accrual record — one row per accrual event.
 * Usages are stored as Assignment rows (kind=leave); the FIFO deduction
 * logic references these accrual rows to track remaining balance.
 */
export interface Accrual {
  id: string
  person_id: string
  type: AccrualType
  days: number                // positive = earned/deducted amount (always positive)
  date: string                // YYYY-MM-DD — date accrual was credited / deducted
  source: string | null       // work_item_id that caused the accrual
  note: string | null
  direction?: 'accrual' | 'usage'  // undefined/'accrual' = adds; 'usage' = manual deduction
}

/** A public or custom holiday. */
export interface Holiday {
  id: string
  name: string
  date: string                // YYYY-MM-DD
  recurring: boolean          // true = same month/day repeats every year
  source?: 'auto' | 'manual'  // HOL-4: 'auto' = API-synced; 'manual' = admin-added (default)
}

/**
 * Fine-grained permission grant.
 * Effective permission = MAX(global_role, any matching grant, self-rule).
 */
export interface Grant {
  id: string
  user_id: string
  scope: GrantScope           // 'global' | 'person' | 'work_item'
  resource_id: string | null  // null when scope='global'
  level: GrantLevel
}

/** App-wide settings (single row in the settings table). */
export interface Settings {
  fiscal_year_start_month: number   // 1=Jan … 12=Dec (default 7=Jul, FY26=2025-07-01~2026-06-30)
}

/** A row from the leave_types reference table (PRD v2.4 §5.6). */
export interface LeaveTypeRecord {
  name:       string
  active:     boolean
  sort_order: number
}

/** Snapshot of per-person per-day timesheet code (AL-12 8-week sliding window). */
export interface TimesheetGuidelineSnapshot {
  person_id: string
  date:      string   // YYYY-MM-DD
  code:      string
  detail:    string | null
  run_at:    string   // ISO timestamp of last generation run
}

/** Immutable audit trail for all data and permission changes. */
export interface AuditLog {
  id: string
  user_id: string
  action: string              // e.g. "create", "update", "delete", "grant"
  target_type: string         // table name, e.g. "people", "assignments"
  target_id: string
  at: string                  // ISO timestamp
}

// ---------------------------------------------------------------------------
// §5.13 Annual leave (법정연차) types
// ---------------------------------------------------------------------------

/** Manual +/- adjustment to annual leave balance. */
export interface AnnualLeaveAdjustment {
  id:         string
  person_id:  string
  direction:  'accrual' | 'usage'
  days:       number          // positive or negative
  date:       string          // YYYY-MM-DD
  note:       string | null
  created_at: string
}

// ---------------------------------------------------------------------------
// Derived / UI-only types (not stored in the DB)
// ---------------------------------------------------------------------------

/** Computed leave balance for a person at a given reference date. */
export interface LeaveBalance {
  person_id: string
  accrued: number
  used: number
  remaining: number
  by_type: Partial<Record<AccrualType, { accrued: number; used: number }>>
}
