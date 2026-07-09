-- PRD v2.33 [5단계] annual_leave_grants 테이블 폐지
--
-- 법정연차 계산이 클라이언트 순수 함수(computeStatutoryLeave)로 전환됨.
-- DB 저장 행은 더 이상 사용되지 않으므로 백업 후 삭제.
--
-- 백업 테이블: annual_leave_grants_v233_backup (보존, 삭제 불가)
-- 원본 테이블: annual_leave_grants (삭제)
-- Edge Function: fill-statutory-leave (더 이상 배포 불필요 — 코드베이스에서 제거됨)

-- 1. 백업
CREATE TABLE IF NOT EXISTS public.annual_leave_grants_v233_backup
  AS SELECT * FROM public.annual_leave_grants;

COMMENT ON TABLE public.annual_leave_grants_v233_backup IS
  'PRD v2.33 보존 백업 (2026-07-10). 원본 annual_leave_grants는 삭제됨.';

-- 2. fill-statutory-leave Edge Function 관련 cron/스케줄 제거 (있을 경우)
--    pg_cron 설치 여부에 관계없이 실행 (없으면 스킵)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'cron' AND table_name = 'job'
  ) THEN
    DELETE FROM cron.job WHERE jobname LIKE '%fill-statutory-leave%';
    RAISE NOTICE 'Removed fill-statutory-leave cron jobs (if any)';
  ELSE
    RAISE NOTICE 'pg_cron not installed — skipping cron cleanup';
  END IF;
END;
$$;

-- 3. 원본 테이블 삭제 (RLS 정책·인덱스 포함)
DROP TABLE IF EXISTS public.annual_leave_grants CASCADE;

-- 4. 결과 확인
SELECT
  'migration 0027 (v2.33 drop annual_leave_grants) done' AS result,
  count(*)                                               AS backup_rows
FROM public.annual_leave_grants_v233_backup;
