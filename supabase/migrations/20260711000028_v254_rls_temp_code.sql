-- =============================================================
-- Migration 0028: PRD v2.54 §5.13 AL-13/AL-17/§6.5
-- =============================================================
-- 실행 순서: 0027 이후
-- 멱등 보장: DROP POLICY IF EXISTS / ADD COLUMN IF NOT EXISTS /
--            DROP VIEW IF EXISTS → CREATE VIEW
--
-- 변경 요약:
--   1. timesheet_guideline_snapshot RLS 정책 추가
--      (테이블은 PRD v2.51에서 생성·RLS 활성화됨; 정책 누락으로 저장 실패)
--   2. work_items.temp_engagement_code TEXT 컬럼 추가 (AL-17)
--   3. work_items_safe 뷰 재생성 — temp_engagement_code 포함
-- =============================================================


-- ════════════════════════════════════════════════════════════
-- 1. timesheet_guideline_snapshot RLS 정책
-- ════════════════════════════════════════════════════════════
-- RLS는 이미 활성화되어 있으나 정책이 없으면 모든 접근이 차단됨.
-- 정책 없는 RLS가 저장 실패의 근본 원인이므로 여기서 추가한다.

ALTER TABLE public.timesheet_guideline_snapshot ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.timesheet_guideline_snapshot FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tgs_select ON public.timesheet_guideline_snapshot;
DROP POLICY IF EXISTS tgs_insert ON public.timesheet_guideline_snapshot;
DROP POLICY IF EXISTS tgs_update ON public.timesheet_guideline_snapshot;
DROP POLICY IF EXISTS tgs_delete ON public.timesheet_guideline_snapshot;

-- SELECT: editor / admin / assistant (읽기 전용 역할 포함)
CREATE POLICY tgs_select ON public.timesheet_guideline_snapshot
  FOR SELECT USING (
    my_role() IN ('admin', 'editor', 'assistant')
  );

-- 쓰기: editor / admin 전용
CREATE POLICY tgs_insert ON public.timesheet_guideline_snapshot
  FOR INSERT WITH CHECK (
    my_role() IN ('admin', 'editor')
  );

CREATE POLICY tgs_update ON public.timesheet_guideline_snapshot
  FOR UPDATE USING (
    my_role() IN ('admin', 'editor')
  );

CREATE POLICY tgs_delete ON public.timesheet_guideline_snapshot
  FOR DELETE USING (
    my_role() IN ('admin', 'editor')
  );


-- ════════════════════════════════════════════════════════════
-- 2. work_items.temp_engagement_code
-- ════════════════════════════════════════════════════════════
-- AL-17: 정식 engagement_number 확정 전 임시 타임시트 코드.
-- resolveTimesheetCode가 engagement_number 없을 때 이 값을 사용 (provisional=true).
-- 정식 코드 입력 후 다음 지침 생성 시 스냅샷 비교로 자동 정정 지시 생성.

ALTER TABLE public.work_items
  ADD COLUMN IF NOT EXISTS temp_engagement_code TEXT;

COMMENT ON COLUMN public.work_items.temp_engagement_code IS
  'AL-17: 정식 engagement_number 확정 전 임시 타임시트 코드 (관리자 수동 입력). '
  'engagement_number 입력 시 다음 지침 생성에서 자동 정정 지시 생성됨. (PRD v2.54)';


-- ════════════════════════════════════════════════════════════
-- 3. work_items_safe 뷰 재생성
-- ════════════════════════════════════════════════════════════
-- temp_engagement_code 컬럼 추가.
-- confidential 마스킹: engagement_number 와 동일 정책 적용.

DROP VIEW IF EXISTS public.work_items_safe;

CREATE VIEW public.work_items_safe
WITH (security_invoker = true)
AS
SELECT
  id,
  type,

  CASE
    WHEN confidential
      AND COALESCE(my_role(), '') NOT IN ('admin', 'editor')
    THEN '(비공개)'::text
    ELSE name
  END                                       AS name,

  color,
  start,
  main_start,
  end_date,

  CASE
    WHEN confidential
      AND COALESCE(my_role(), '') NOT IN ('admin', 'editor')
    THEN NULL::text
    ELSE engagement_number
  END                                       AS engagement_number,

  CASE
    WHEN confidential
      AND COALESCE(my_role(), '') NOT IN ('admin', 'editor')
    THEN NULL::text
    ELSE temp_engagement_code
  END                                       AS temp_engagement_code,

  CASE
    WHEN confidential
      AND COALESCE(my_role(), '') NOT IN ('admin', 'editor')
    THEN NULL::text
    ELSE client
  END                                       AS client,

  CASE
    WHEN confidential
      AND COALESCE(my_role(), '') NOT IN ('admin', 'editor')
    THEN NULL::text
    ELSE description
  END                                       AS description,

  CASE
    WHEN confidential
      AND COALESCE(my_role(), '') NOT IN ('admin', 'editor')
    THEN '{}'::text[]
    ELSE hashtags
  END                                       AS hashtags,

  confidential,
  project_status,
  status,
  created_at,
  updated_at

FROM public.work_items;

COMMENT ON VIEW public.work_items_safe IS
  'work_items 마스킹 뷰. confidential=true 항목은 비-editor에게 '
  'name/client/description/hashtags/engagement_number/temp_engagement_code 마스킹. '
  '0028 재생성: temp_engagement_code 추가. (PRD v2.54)';


-- ════════════════════════════════════════════════════════════
-- 검증
-- ════════════════════════════════════════════════════════════

SELECT 'migration 0028 (v2.54 tgs-rls + temp_engagement_code) done' AS result;
