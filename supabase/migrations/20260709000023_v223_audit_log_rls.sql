-- PRD v2.23 §5.14 ADM-3, §6.5 — 감사 로그 조회 수정
--
-- 문제:
--   audit_log.user_id 가 auth.users(id) 를 참조하고 있어
--   PostgREST 가 audit_log ↔ profiles 조인 관계를 자동 인식하지 못한다.
--   결과: select('*, profiles(name)') 요청이 PostgREST 에러를 반환하고,
--         프런트엔드에서 PostgrestError 객체가 [object Object] 로 노출된다.
--
-- 변경 내용:
--   1. 기존 FK(→ auth.users) 를 제거하고 public.profiles(id) 를 참조하는
--      FK 로 교체한다. profiles.id = auth.users.id 이므로 값 도메인 동일.
--      NOT VALID 로 기존 데이터 검증을 건너뛴다.
--   2. audit_log SELECT 정책에 admin 허용이 이미 존재하는지 확인 후
--      없으면 추가한다 (초기 migration 에 이미 포함되어 있지만 멱등 처리).
--
-- ════════════════════════════════════════════════════════════════
-- 1. FK 재설정
-- ════════════════════════════════════════════════════════════════

-- 기존 FK 제거 (이름은 PostgreSQL 자동 생성 규칙: {table}_{col}_fkey)
ALTER TABLE public.audit_log
  DROP CONSTRAINT IF EXISTS audit_log_user_id_fkey;

-- profiles 를 가리키는 FK 추가
-- NOT VALID: 기존 행 검증 건너뜀; 신규 INSERT/UPDATE 는 즉시 강제
ALTER TABLE public.audit_log
  ADD CONSTRAINT audit_log_user_id_fkey
  FOREIGN KEY (user_id)
  REFERENCES public.profiles(id)
  ON DELETE SET NULL
  NOT VALID;

-- ════════════════════════════════════════════════════════════════
-- 2. RLS SELECT 정책 멱등 보장
-- ════════════════════════════════════════════════════════════════
-- 초기 migration(20260620000004_rls.sql) 에서 이미 생성된 정책이지만,
-- IF NOT EXISTS 를 사용해 중복 에러 없이 재확인한다.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename  = 'audit_log'
      AND policyname = 'audit_log_select'
  ) THEN
    EXECUTE $policy$
      CREATE POLICY audit_log_select ON public.audit_log
        FOR SELECT USING (
          user_id = auth.uid()
          OR is_admin()
        )
    $policy$;
  END IF;
END $$;

SELECT 'migration 0023 (v2.23 audit_log FK + RLS guard) done' AS result;
