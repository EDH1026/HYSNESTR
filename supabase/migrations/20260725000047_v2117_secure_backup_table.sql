-- =============================================================
-- Migration 0047: 보안 수정 — annual_leave_grants_v233_backup 테이블 잠금
-- =============================================================
-- 실행 순서: 0046 이후
-- 멱등 보장: ENABLE/FORCE RLS · REVOKE 는 반복 실행해도 안전.
--
-- 배경(보안 점검 발견):
--   0027(v2.33)에서 `CREATE TABLE ... AS SELECT` 로 만든 보존 백업 테이블
--   annual_leave_grants_v233_backup 에 RLS가 켜져 있지 않았고, anon/authenticated
--   롤에 SELECT GRANT가 남아 있어 PostgREST(REST API)에 그대로 노출되어 있었다.
--   실측(anon 키):
--     GET /rest/v1/annual_leave_grants_v233_backup → HTTP 200, Content-Range */0
--     (대조군 settings → HTTP 404 PGRST205 = grant 회수되어 API에서 비노출)
--   현재 행 수가 0이라 실제 유출 데이터는 없으나, RLS가 없어 다음이 성립한다:
--     · 이 테이블에 행이 존재했다면 미인증 anon에게 전량 노출됨
--     · INSERT/UPDATE/DELETE 정책도 없어 anon 쓰기 벡터가 열려 있을 가능성이 큼
--   다른 모든 노출 테이블은 RLS로 보호되어 미인증 시 0행을 반환하는 것과 대비된다.
--
-- 조치(다중 방어):
--   1. ENABLE + FORCE ROW LEVEL SECURITY, 정책은 두지 않는다(deny-all).
--      이 테이블은 순수 보존 백업으로 앱·Edge Function이 조회하지 않으므로
--      admin SELECT 정책조차 불필요하다(필요 시 대시보드 service_role로 접근).
--   2. anon·authenticated 의 테이블 GRANT를 회수해 REST API 표면에서 제거한다
--      (settings 와 동일하게 PGRST205로 비노출 처리).
--   PRD v2.33 주석상 이 백업은 "보존, 삭제 불가"이므로 DROP 하지 않고 잠그기만 한다.
-- =============================================================

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name   = 'annual_leave_grants_v233_backup'
  ) THEN
    -- 1. RLS 활성화 + 강제 (정책 없음 → 전면 거부)
    EXECUTE 'ALTER TABLE public.annual_leave_grants_v233_backup ENABLE ROW LEVEL SECURITY';
    EXECUTE 'ALTER TABLE public.annual_leave_grants_v233_backup FORCE  ROW LEVEL SECURITY';

    -- 2. API 롤 GRANT 회수 (REST 표면에서 제거)
    EXECUTE 'REVOKE ALL ON public.annual_leave_grants_v233_backup FROM anon';
    EXECUTE 'REVOKE ALL ON public.annual_leave_grants_v233_backup FROM authenticated';

    RAISE NOTICE 'Locked annual_leave_grants_v233_backup (RLS forced, anon/authenticated grants revoked)';
  ELSE
    RAISE NOTICE 'annual_leave_grants_v233_backup not present — nothing to lock';
  END IF;
END;
$$;

-- PostgREST 스키마 캐시 리로드 (즉시 비노출 반영)
NOTIFY pgrst, 'reload schema';

SELECT 'migration 0047 (v2.117 secure backup table) done' AS result;
