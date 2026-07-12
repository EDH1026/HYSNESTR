-- =============================================================
-- Migration 0032: PRD v2.78 §5.14 TSG-14
-- =============================================================
-- 변경 요약:
--   assignments 테이블에 daily_hours 컬럼 추가
--   Partner 다중 프로젝트 배정 시 하루 투입시간 설정용
-- =============================================================

ALTER TABLE public.assignments
  ADD COLUMN IF NOT EXISTS daily_hours NUMERIC(4,1) DEFAULT NULL;

ALTER TABLE public.assignments
  DROP CONSTRAINT IF EXISTS assignments_daily_hours_range;

ALTER TABLE public.assignments
  ADD CONSTRAINT assignments_daily_hours_range
    CHECK (daily_hours IS NULL OR (daily_hours > 0 AND daily_hours <= 24));

COMMENT ON COLUMN public.assignments.daily_hours IS
  'TSG-14: Partner 다중 배정 시 해당 프로젝트에 투입하는 하루 시간. '
  'NULL이면 단일 배정으로 취급(8h). (PRD v2.78)';

SELECT 'migration 0032 (v2.78 TSG-14 assignment_daily_hours) done' AS result;
