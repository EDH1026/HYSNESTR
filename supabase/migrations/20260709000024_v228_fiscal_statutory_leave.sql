-- PRD v2.28 §5.13 AL-2 — 법정연차 자동 계산 기준일 변경 (1월 1일 → 7월 1일)
--
-- 변경 내용:
--   1. 기존에 '근로기준법 자동계산' 비고로 저장된 자동 생성 행을 전부 삭제한다.
--      (1/1 기준으로 잘못 생성된 행 포함. 관리자 수동 보정 행은 이 패턴에 해당하지 않으면 보존.)
--   2. 새 값은 fill-statutory-leave Edge Function (7/1 기준)으로 재생성한다.
--      배포 후 Admin > 법정연차 배치 탭에서 anchorDate=오늘(또는 2026-07-01)로 실행.
--
-- pg_cron 자동 스케줄 설정 (Supabase Dashboard 에서 수동 실행 필요):
-- ─────────────────────────────────────────────────────────────────────
-- 1. Supabase Dashboard → Database → Extensions → pg_cron 활성화
-- 2. Supabase Dashboard → Database → Extensions → pg_net 활성화
-- 3. Dashboard SQL Editor 또는 MigrationPanel 에서 아래 SQL 실행:
--
--   SELECT cron.schedule(
--     'fill-statutory-leave-annual',
--     '0 0 1 7 *',   -- 매년 7/1 00:00 UTC (= 09:00 KST)
--     format(
--       $cmd$
--         SELECT net.http_post(
--           url    := %L,
--           headers := jsonb_build_object(
--             'Content-Type',  'application/json',
--             'Authorization', 'Bearer ' || current_setting('app.service_role_key')
--           ),
--           body := '{"anchorDate":"auto"}'::jsonb
--         );
--       $cmd$,
--       current_setting('app.supabase_url') || '/functions/v1/fill-statutory-leave'
--     )
--   );
--
--   -- app.supabase_url, app.service_role_key 는 Dashboard → Settings → Custom Postgres Role
--   -- 또는 아래처럼 직접 설정:
--   ALTER DATABASE postgres SET app.supabase_url = 'https://YOUR_PROJECT.supabase.co';
--   ALTER DATABASE postgres SET app.service_role_key = 'YOUR_SERVICE_ROLE_KEY';
-- ─────────────────────────────────────────────────────────────────────

-- ════════════════════════════════════════════════════════════════
-- 1. 자동 생성 법정연차 행 삭제 (수동 보정 행은 보존)
-- ════════════════════════════════════════════════════════════════
DELETE FROM public.annual_leave_grants
WHERE note LIKE '근로기준법 자동계산%';

SELECT
  'migration 0024 (v2.28 fiscal statutory leave reset) done' AS result,
  count(*) AS remaining_grants
FROM public.annual_leave_grants;
