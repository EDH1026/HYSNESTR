-- =============================================================
-- Migration 0018: PRD v2.14 §2/§6.3/§6.5/부록 B.3 — assistant 역할
-- =============================================================
-- 실행 순서: 0017 이후
-- 멱등 보장: CREATE OR REPLACE / DROP IF EXISTS / ALTER TABLE
--
-- 변경 요약:
--   1. profiles.global_role CHECK에 'assistant' 추가
--   2. is_assistant() 헬퍼 함수 생성
--   3. accruals SELECT 정책: assistant는 본인 외 전체 조회 허용
--      (viewer는 여전히 본인만; people/work_items/assignments는 기존 정책으로 충분)
--
-- assistant 역할 요약 (PRD §6.3):
--   · viewer와 동일하지만 모든 인력의 CV·Leave를 열람 가능
--   · 쓰기 권한 없음 (INSERT/UPDATE/DELETE 모두 차단 유지)
-- =============================================================


-- ════════════════════════════════════════════════════════════
-- 1. profiles.global_role CHECK 확장
-- ════════════════════════════════════════════════════════════

ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS profiles_global_role_check;

ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_global_role_check
    CHECK (global_role IN ('admin', 'editor', 'viewer', 'assistant'));

COMMENT ON COLUMN public.profiles.global_role IS
  'admin: 전권 | editor: 전체 수정 | viewer: 전체 열람(본인 Leave/CV) | assistant: 전체 열람(모든 인력 CV·Leave)';


-- ════════════════════════════════════════════════════════════
-- 2. is_assistant() 헬퍼
-- ════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.is_assistant()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.profiles
    WHERE id          = auth.uid()
      AND global_role = 'assistant'
      AND status      = 'active'
  )
$$;

COMMENT ON FUNCTION public.is_assistant() IS
  'Returns true if the current user has global_role = ''assistant'' and is active.';


-- ════════════════════════════════════════════════════════════
-- 3. accruals SELECT — assistant는 전체 열람 허용
-- ════════════════════════════════════════════════════════════

DROP POLICY IF EXISTS accruals_select ON public.accruals;

CREATE POLICY accruals_select ON public.accruals
  FOR SELECT USING (
    auth.uid() IS NOT NULL
    AND (
      my_role() IN ('editor', 'admin', 'assistant')  -- editor/admin/assistant: 전체
      OR person_id = my_person_id()                  -- viewer: 본인만
    )
  );


-- ════════════════════════════════════════════════════════════
-- 검증 쿼리
-- ════════════════════════════════════════════════════════════

SELECT 'migration 0018 (PRD v2.14 assistant role) done' AS result;
