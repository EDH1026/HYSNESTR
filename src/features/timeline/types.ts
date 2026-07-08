import type { Assignment, Person, WorkItem } from '@/types'

export type ViewMode = 'person' | 'workitem'

// Describes a single horizontal row in the grid
export type RowData =
  | { kind: 'person';           person: Person;                     key: string }
  | { kind: 'workitem';         workItem: WorkItem;                 key: string }
  | { kind: 'workitem-sub';     workItem: WorkItem; person: Person; key: string }
  | { kind: 'leave-all';                                            key: 'leave-all' }
  | { kind: 'leave-person-sub'; person: Person;                     key: string }

// State for the assignment create / edit modal
export interface ModalState {
  open:       boolean
  mode:       'create' | 'edit'
  prefill: {
    personId?:           string
    workItemId?:         string
    kind?:               'work' | 'leave'
    leaveType?:          string   // T-12: pre-fill leave type when duplicating
    startNum?:           number
    endNum?:             number
    lastProjectEndNum?:  number   // for '종료 후 잔여 소진' auto-date
  }
  editTarget?: Assignment
}
