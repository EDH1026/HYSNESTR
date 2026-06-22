-- Migration 0011: add '종료 후 잔여 소진' to assignments.leave_type CHECK constraint
-- (PRD §5.3 #5 — post-project residual leave burn)

ALTER TABLE public.assignments
  DROP CONSTRAINT IF EXISTS assignments_leave_type_check;

ALTER TABLE public.assignments
  ADD CONSTRAINT assignments_leave_type_check CHECK (
    leave_type IN (
      '리프레시', '지정휴가', '프로젝트휴가',
      '주말/휴일대체', '포상휴가', '특별휴가', '지연보상', '휴직',
      '종료 후 잔여 소진'
    )
  );

SELECT 'migration 0011 done' AS result;
