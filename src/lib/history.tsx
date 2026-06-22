import { createContext, useContext, useReducer, useCallback, type ReactNode } from 'react'

export interface HistoryEntry {
  label: string
  undo:  () => Promise<void>
  redo:  () => Promise<void>
}

interface State {
  undo:  HistoryEntry[]
  redo:  HistoryEntry[]
  error: string | null
}

type Action =
  | { type: 'PUSH';         entry: HistoryEntry }
  | { type: 'UNDO_SUCCESS'; entry: HistoryEntry }
  | { type: 'REDO_SUCCESS'; entry: HistoryEntry }
  | { type: 'ERROR';        message: string }
  | { type: 'CLEAR_ERROR' }

const MAX = 10

function reducer(s: State, a: Action): State {
  switch (a.type) {
    case 'PUSH':
      return { undo: [...s.undo.slice(-(MAX - 1)), a.entry], redo: [], error: null }
    case 'UNDO_SUCCESS':
      return { ...s, undo: s.undo.slice(0, -1), redo: [...s.redo.slice(-(MAX - 1)), a.entry], error: null }
    case 'REDO_SUCCESS':
      return { ...s, undo: [...s.undo.slice(-(MAX - 1)), a.entry], redo: s.redo.slice(0, -1), error: null }
    case 'ERROR':
      return { undo: [], redo: [], error: a.message }
    case 'CLEAR_ERROR':
      return { ...s, error: null }
    default: return s
  }
}

interface HistoryContextValue {
  canUndo:    boolean
  canRedo:    boolean
  undoLabel:  string | null
  redoLabel:  string | null
  error:      string | null
  push:       (entry: HistoryEntry) => void
  undo:       () => Promise<void>
  redo:       () => Promise<void>
  clearError: () => void
}

const Ctx = createContext<HistoryContextValue | null>(null)

export function HistoryProvider({ children }: { children: ReactNode }) {
  const [s, dispatch] = useReducer(reducer, { undo: [], redo: [], error: null })

  const push = useCallback((entry: HistoryEntry) => dispatch({ type: 'PUSH', entry }), [])

  const undo = useCallback(async () => {
    const entry = s.undo[s.undo.length - 1]
    if (!entry) return
    try {
      await entry.undo()
      dispatch({ type: 'UNDO_SUCCESS', entry })
    } catch (e) {
      dispatch({
        type: 'ERROR',
        message: `실행취소 실패: ${e instanceof Error ? e.message : '서버 오류'}. 스택을 초기화했습니다.`,
      })
    }
  }, [s.undo])

  const redo = useCallback(async () => {
    const entry = s.redo[s.redo.length - 1]
    if (!entry) return
    try {
      await entry.redo()
      dispatch({ type: 'REDO_SUCCESS', entry })
    } catch (e) {
      dispatch({
        type: 'ERROR',
        message: `재실행 실패: ${e instanceof Error ? e.message : '서버 오류'}. 스택을 초기화했습니다.`,
      })
    }
  }, [s.redo])

  const clearError = useCallback(() => dispatch({ type: 'CLEAR_ERROR' }), [])

  return (
    <Ctx.Provider value={{
      canUndo:   s.undo.length > 0,
      canRedo:   s.redo.length > 0,
      undoLabel: s.undo[s.undo.length - 1]?.label ?? null,
      redoLabel: s.redo[s.redo.length - 1]?.label ?? null,
      error:     s.error,
      push, undo, redo, clearError,
    }}>
      {children}
    </Ctx.Provider>
  )
}

export function useHistory() {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useHistory must be inside HistoryProvider')
  return ctx
}
