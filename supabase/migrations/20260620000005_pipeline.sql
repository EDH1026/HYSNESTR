-- =============================================================
-- Migration 0005: 'pipeline' work_item type + restricted RLS
-- =============================================================
-- 기존 마이그레이션(0001–0004)은 수정하지 않는다.
--
-- 변경 요약
--   1. work_items.type 체크 제약에 'pipeline' 추가
--   2. is_pipeline_work_item() SECURITY DEFINER 헬퍼 함수 추가
--   3. work_items SELECT 정책: pipeline은 edit 이상만 조회 가능
--   4. assignments SELECT 정책: pipeline 배정은 self-view 포함
--      view-only 경로를 완전 차단하고 work_item edit 권한만 허용
--   5. accruals 및 나머지 테이블 정책은 변경하지 않음
--
-- ─── 취약점 분석 ────────────────────────────────────────────────
-- assignments SELECT 정책에서 "연결된 work_item이 pipeline인지"를
-- 일반 서브쿼리(SELECT ... FROM work_items WHERE type='pipeline')로
-- 판단하면, 해당 work_item 자체가 RLS로 숨겨진 상태에서는 EXISTS가
-- false를 반환한다. 그 결과 ELSE 분기(self-view)로 흘러 pipeline
-- 배정이 뷰어에게 노출되는 허점이 생긴다.
-- → is_pipeline_work_item() 을 SECURITY DEFINER로 만들어 work_items
--   RLS를 우회해서 실제 type 값을 읽도록 해야 이 문제가 없어진다.
-- =============================================================


-- ── 1. work_items.type 체크 제약 확장 ────────────────────────
-- PostgreSQL이 인라인 컬럼 CHECK에 자동 부여하는 이름은
-- '{table}_{column}_check' 규칙을 따른다.
-- 이 마이그레이션이 실행되는 DB에서 그 이름이 다르더라도
-- IF EXISTS 덕분에 오류 없이 넘어간다.

ALTER TABLE public.work_items
  DROP CONSTRAINT IF EXISTS work_items_type_check;

-- 명시적 이름으로 다시 추가 (project·proposal 기존 값 유지)
ALTER TABLE public.work_items
  ADD CONSTRAINT wi_type_values
  CHECK (type IN ('project','proposal','pipeline'));

-- 참고: 기존 wi_proposal_no_main 제약
--   CHECK (type = 'project' OR main_start IS NULL)
-- 은 pipeline에도 올바르게 동작한다 (pipeline은 main_start = NULL 강제).
-- 이름이 proposal_no_main 으로 다소 오해를 줄 수 있으나 로직은 정확하므로
-- 변경하지 않는다.

COMMENT ON COLUMN public.work_items.type
  IS 'project | proposal | pipeline';


-- ── 2. is_pipeline_work_item() 헬퍼 ─────────────────────────
-- assignments SELECT 정책에서 work_items RLS를 우회하여
-- 해당 work_item 의 실제 type 을 확인하기 위한 함수.
--
-- SECURITY DEFINER 필수 이유:
--   pipeline work_item은 edit 권한이 없는 사용자에게 RLS로 숨겨진다.
--   만약 일반 서브쿼리를 쓰면 그 사용자에게는 pipeline 여부를 판별
--   하는 EXISTS가 항상 false 를 반환해 ELSE(self-view) 경로로 흘러
--   pipeline 배정이 노출된다. SECURITY DEFINER 로 실제 type 을 읽어야
--   이 취약점이 사라진다.

CREATE OR REPLACE FUNCTION public.is_pipeline_work_item(_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  -- _id 가 NULL 이면 서브쿼리가 0행 반환 → COALESCE → false
  SELECT COALESCE(
    (SELECT type = 'pipeline' FROM work_items WHERE id = _id),
    false
  )
$$;


-- ── 3. work_items SELECT 정책 교체 ───────────────────────────
-- 비-pipeline : app_can(view) 이상이면 조회 가능 (기존 동작 유지)
-- pipeline    : app_can(edit) 이상이어야 조회 가능
--              (admin은 app_can이 항상 true를 반환하므로 별도 분기 불필요)

DROP POLICY IF EXISTS work_items_select ON public.work_items;

CREATE POLICY work_items_select ON public.work_items
  FOR SELECT USING (
    CASE type
      WHEN 'pipeline' THEN app_can('work_item', id, 'edit')
      ELSE                  app_can('work_item', id, 'view')
    END
  );

-- INSERT / UPDATE / DELETE 정책은 기존 그대로 edit 권한을 요구한다.
-- (work_items_insert / work_items_update / work_items_delete 정책 유지)


-- ── 4. assignments SELECT 정책 교체 ──────────────────────────
-- pipeline 배정 : work_item에 대한 edit 권한 필요.
--                 self-view(본인 person_id) 경로를 명시적으로 차단.
-- 그 외 배정    : 기존 동작 유지 (person view 권한 또는 self-view)
--
-- is_pipeline_work_item() 이 SECURITY DEFINER이므로 pipeline work_item이
-- RLS로 숨겨져 있어도 올바르게 true 를 반환해 THEN 분기를 탄다.

DROP POLICY IF EXISTS assignments_select ON public.assignments;

CREATE POLICY assignments_select ON public.assignments
  FOR SELECT USING (
    CASE
      -- ── pipeline 배정 ────────────────────────────────────────
      -- work_item_id 가 NULL 인 leave 배정은 false → ELSE 분기
      WHEN is_pipeline_work_item(work_item_id) THEN
        app_can('work_item', work_item_id, 'edit')

      -- ── 비-pipeline 배정 (project·proposal·leave) ────────────
      ELSE
        app_can('person', person_id, 'view')
        OR EXISTS (
          SELECT 1
          FROM public.profiles p
          WHERE p.id        = auth.uid()
            AND p.person_id = assignments.person_id
        )
    END
  );

-- assignments INSERT / UPDATE / DELETE 정책은 변경하지 않는다.
-- (person edit 권한 요구, 기존 정책 그대로)


-- ── 5. accruals 및 기타 테이블 영향 없음 확인 ─────────────────
-- accruals.source(= work_item_id)는 pipeline work_item 을 가리킬 수
-- 있으나, accruals SELECT 정책은 person view 권한 기반이므로
-- 정책 변경이 필요하지 않다.
--
-- accruals 에서 source UUID 를 확보하더라도 사용자가 그 UUID 로
-- work_items 를 직접 조회하면 pipeline이라면 work_items_select 정책이
-- edit 권한을 요구해 차단한다.
--
-- 따라서 accruals / holidays / grants / audit_log / profiles / people
-- 의 기존 정책은 그대로 유지한다.
