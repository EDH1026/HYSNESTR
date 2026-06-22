-- =============================================================
-- Migration 0015: PRD v2.5 §6.3/§6.5/부록 B.3 — Viewer 전체 접근 RLS
-- =============================================================
-- 실행 순서: 0001~0014 이후
-- 멱등 보장: DROP POLICY IF EXISTS → CREATE POLICY
--
-- 변경 요약 (기존 0007_rls_v2 정책 교체):
--   1. people SELECT    : 인증 사용자 전체 허용 (viewer 포함)
--   2. work_items SELECT: viewer는 type<>'pipeline'만
--   3. assignments SELECT: viewer는 pipeline 아닌 work_item 배정만
--                          (is_pipeline_work_item(NULL)=false → leave 배정 포함)
--   4. accruals SELECT  : viewer는 본인(my_person_id())만 — 변경 없음
--   5. 모든 테이블 INSERT/UPDATE/DELETE:
--          my_role() IN ('editor','admin') 로 통일 (viewer 차단 명시)
--
-- 보안 메모:
--   · is_pipeline_work_item() SECURITY DEFINER — RLS 우회해 pipeline 판별
--     (일반 서브쿼리로 대체하면 pipeline이 RLS에 숨겨진 상태에서
--      EXISTS가 false를 반환해 viewer에게 pipeline 배정이 노출됨)
--   · work_items 읽기는 클라이언트가 work_items_safe 뷰로 통일
--     (security_invoker=true → work_items SELECT 정책 그대로 적용 +
--      my_role()로 confidential 마스킹)
-- =============================================================


-- ════════════════════════════════════════════════════════════
-- 1. people — 인증 사용자 전체 SELECT
-- ════════════════════════════════════════════════════════════

DROP POLICY IF EXISTS people_select ON public.people;

CREATE POLICY people_select ON public.people
  FOR SELECT USING (auth.uid() IS NOT NULL);

-- 쓰기: editor/admin 전용
DROP POLICY IF EXISTS people_insert ON public.people;
DROP POLICY IF EXISTS people_update ON public.people;
DROP POLICY IF EXISTS people_delete ON public.people;

CREATE POLICY people_insert ON public.people
  FOR INSERT WITH CHECK (my_role() IN ('editor','admin'));

CREATE POLICY people_update ON public.people
  FOR UPDATE
  USING      (my_role() IN ('editor','admin'))
  WITH CHECK (my_role() IN ('editor','admin'));

CREATE POLICY people_delete ON public.people
  FOR DELETE USING (my_role() IN ('editor','admin'));


-- ════════════════════════════════════════════════════════════
-- 2. work_items — viewer는 pipeline 제외
-- ════════════════════════════════════════════════════════════
-- 읽기 경로: 클라이언트는 work_items_safe 뷰를 사용.
-- work_items_safe(security_invoker=true) → 이 정책이 그대로 적용됨.
-- confidential 마스킹은 뷰에서 my_role() 기반으로 처리.

DROP POLICY IF EXISTS work_items_select ON public.work_items;

CREATE POLICY work_items_select ON public.work_items
  FOR SELECT USING (
    auth.uid() IS NOT NULL
    AND (
      my_role() IN ('editor','admin')   -- editor/admin: 전체(pipeline 포함)
      OR type <> 'pipeline'             -- viewer: pipeline 제외
    )
  );

DROP POLICY IF EXISTS work_items_insert ON public.work_items;
DROP POLICY IF EXISTS work_items_update ON public.work_items;
DROP POLICY IF EXISTS work_items_delete ON public.work_items;

CREATE POLICY work_items_insert ON public.work_items
  FOR INSERT WITH CHECK (my_role() IN ('editor','admin'));

CREATE POLICY work_items_update ON public.work_items
  FOR UPDATE
  USING      (my_role() IN ('editor','admin'))
  WITH CHECK (my_role() IN ('editor','admin'));

CREATE POLICY work_items_delete ON public.work_items
  FOR DELETE USING (my_role() IN ('editor','admin'));


-- ════════════════════════════════════════════════════════════
-- 3. assignments — viewer는 pipeline 작업항목 배정 제외
-- ════════════════════════════════════════════════════════════
-- is_pipeline_work_item(NULL) = false (leave 배정 포함)
-- is_pipeline_work_item(pipeline_id) = true (pipeline 배정 차단)

DROP POLICY IF EXISTS assignments_select ON public.assignments;

CREATE POLICY assignments_select ON public.assignments
  FOR SELECT USING (
    auth.uid() IS NOT NULL
    AND (
      my_role() IN ('editor','admin')                -- editor/admin: 전체
      OR NOT is_pipeline_work_item(work_item_id)     -- viewer: pipeline 배정 제외
    )
  );

DROP POLICY IF EXISTS assignments_insert ON public.assignments;
DROP POLICY IF EXISTS assignments_update ON public.assignments;
DROP POLICY IF EXISTS assignments_delete ON public.assignments;

CREATE POLICY assignments_insert ON public.assignments
  FOR INSERT WITH CHECK (my_role() IN ('editor','admin'));

CREATE POLICY assignments_update ON public.assignments
  FOR UPDATE
  USING      (my_role() IN ('editor','admin'))
  WITH CHECK (my_role() IN ('editor','admin'));

CREATE POLICY assignments_delete ON public.assignments
  FOR DELETE USING (my_role() IN ('editor','admin'));


-- ════════════════════════════════════════════════════════════
-- 4. accruals — viewer는 본인만 (변경 없음, 명시적 재정의)
-- ════════════════════════════════════════════════════════════

DROP POLICY IF EXISTS accruals_select ON public.accruals;

CREATE POLICY accruals_select ON public.accruals
  FOR SELECT USING (
    auth.uid() IS NOT NULL
    AND (
      my_role() IN ('editor','admin')
      OR person_id = my_person_id()
    )
  );

DROP POLICY IF EXISTS accruals_insert ON public.accruals;
DROP POLICY IF EXISTS accruals_update ON public.accruals;
DROP POLICY IF EXISTS accruals_delete ON public.accruals;

CREATE POLICY accruals_insert ON public.accruals
  FOR INSERT WITH CHECK (my_role() IN ('editor','admin'));

CREATE POLICY accruals_update ON public.accruals
  FOR UPDATE
  USING      (my_role() IN ('editor','admin'))
  WITH CHECK (my_role() IN ('editor','admin'));

CREATE POLICY accruals_delete ON public.accruals
  FOR DELETE USING (my_role() IN ('editor','admin'));


-- ════════════════════════════════════════════════════════════
-- 검증 쿼리
-- ════════════════════════════════════════════════════════════

-- people 정책 확인
SELECT policyname, cmd, qual
FROM   pg_policies
WHERE  tablename = 'people' AND schemaname = 'public'
ORDER BY policyname;

-- work_items 정책 확인
SELECT policyname, cmd
FROM   pg_policies
WHERE  tablename = 'work_items' AND schemaname = 'public'
ORDER BY policyname;

SELECT 'migration 0015 (PRD v2.5 viewer RLS) done' AS result;
