/**
 * Centralized TanStack Query key factory.
 * Keep every key here so invalidation is consistent across features.
 */

export const queryKeys = {
  people: {
    all:  ()            => ['people']       as const,
    byId: (id: string) => ['people', id]   as const,
  },

  workItems: {
    all:    ()                        => ['workItems']                   as const,
    byId:   (id: string)              => ['workItems', id]               as const,
    byType: (type: string)            => ['workItems', { type }]         as const,
  },

  assignments: {
    all:        ()                     => ['assignments']                        as const,
    byPerson:   (personId: string)     => ['assignments', { personId }]          as const,
    byWorkItem: (workItemId: string)   => ['assignments', { workItemId }]        as const,
  },

  accruals: {
    all:      ()                   => ['accruals']               as const,
    byPerson: (personId: string)   => ['accruals', { personId }] as const,
  },

  holidays: {
    all: () => ['holidays'] as const,
  },

  grants: {
    all:     ()                 => ['grants']             as const,
    byUser:  (userId: string)   => ['grants', { userId }] as const,
  },

  profiles: {
    all:  ()            => ['profiles']       as const,
    byId: (id: string) => ['profiles', id]   as const,
  },

  auditLog: {
    list: () => ['auditLog'] as const,
  },

  myPersonId: {
    get: () => ['myPersonId'] as const,
  },

  settings: {
    get: () => ['settings'] as const,
  },

  leaveTypes: {
    all: () => ['leaveTypes'] as const,
  },

  annualLeave: {
    adjustments:    (personId: string) => ['annualLeaveAdjustments', { personId }] as const,
    allAdjustments: ()                 => ['annualLeaveAdjustments', 'all']        as const,
  },

  timesheetSnapshot: {
    all: () => ['timesheetGuidelineSnapshot'] as const,
  },

  // PRD v2.100 LV-17: server-computed, role-consistent ledger source data.
  ledgerData: {
    forPeople: (personIds: string[] | 'all') =>
      ['ledgerData', personIds === 'all' ? 'all' : [...personIds].sort()] as const,
  },
} as const
