-- =============================================================
-- Migration 0046: PRD v2.114 §5.5 W-10 — project engagement 코드 비율 배분
-- =============================================================
-- 실행 순서: 0045 이후
--
-- 변경 요약:
--   1. work_items.engagement_code_splits jsonb 컬럼 추가 (project 전용)
--   2. 저장 시 서버 검증 트리거 — percent 합계 100, code 비어있지 않음,
--      project 유형에서만 값을 가질 수 있음
--   3. work_items_safe 뷰 재생성 — engagement_code_splits 포함
--      (engagement_number 와 동일한 confidential 마스킹 정책 적용)
-- =============================================================


-- ════════════════════════════════════════════════════════════
-- 1. work_items.engagement_code_splits
-- ════════════════════════════════════════════════════════════
-- 형식: [{"code": "A", "percent": 75}, {"code": "B", "percent": 25}]
-- NULL(미설정)이면 기존과 완전히 동일하게 동작(TSG-1⑥ 단일 코드 경로).

ALTER TABLE public.work_items
  ADD COLUMN IF NOT EXISTS engagement_code_splits jsonb;

COMMENT ON COLUMN public.work_items.engagement_code_splits IS
  'W-10: project 유형 전용 — 하나의 project를 여러 engagement 코드로 '
  '비율 분할해 타임시트를 생성할 때 사용. 형식: '
  '[{"code":"A","percent":75},{"code":"B","percent":25}]. '
  'NULL이면 분할 없음(기존 동작, 하위 호환). percent 합계 100 검증은 '
  'work_items_validate_splits 트리거로 서버에서 강제. (PRD v2.114)';


-- ════════════════════════════════════════════════════════════
-- 2. 서버 검증 트리거
-- ════════════════════════════════════════════════════════════
-- - NULL이면 통과(미설정 허용)
-- - type <> 'project' 이면서 NULL이 아니면 거부(proposal/pipeline은 NULL 고정)
-- - 배열이 아니면 거부
-- - 각 원소의 code가 공백 아닌 문자열이어야 함
-- - percent 합계가 정확히 100이어야 함(아니면 현재 합계를 에러 메시지에 안내)

CREATE OR REPLACE FUNCTION public.validate_engagement_code_splits()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  item        jsonb;
  total       numeric := 0;
  code_val    text;
  percent_val numeric;
BEGIN
  IF NEW.engagement_code_splits IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.type <> 'project' THEN
    RAISE EXCEPTION 'engagement_code_splits는 project 유형에서만 설정할 수 있습니다.';
  END IF;

  IF jsonb_typeof(NEW.engagement_code_splits) <> 'array' THEN
    RAISE EXCEPTION 'engagement_code_splits는 배열이어야 합니다.';
  END IF;

  IF jsonb_array_length(NEW.engagement_code_splits) = 0 THEN
    RAISE EXCEPTION 'engagement_code_splits를 설정하려면 최소 1개 항목이 필요합니다(비우려면 NULL을 사용하세요).';
  END IF;

  FOR item IN SELECT * FROM jsonb_array_elements(NEW.engagement_code_splits)
  LOOP
    code_val := item->>'code';
    IF code_val IS NULL OR btrim(code_val) = '' THEN
      RAISE EXCEPTION 'engagement_code_splits의 code는 공백이 아닌 문자열이어야 합니다.';
    END IF;

    BEGIN
      percent_val := (item->>'percent')::numeric;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'engagement_code_splits의 percent 값이 숫자가 아닙니다: %', item->>'percent';
    END;

    IF percent_val IS NULL THEN
      RAISE EXCEPTION 'engagement_code_splits의 percent 값이 비어 있습니다.';
    END IF;

    total := total + percent_val;
  END LOOP;

  IF total <> 100 THEN
    RAISE EXCEPTION 'engagement_code_splits의 percent 합계는 100이어야 합니다(현재 합계: %).', total;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS work_items_validate_splits ON public.work_items;
CREATE TRIGGER work_items_validate_splits
  BEFORE INSERT OR UPDATE ON public.work_items
  FOR EACH ROW
  EXECUTE FUNCTION public.validate_engagement_code_splits();


-- ════════════════════════════════════════════════════════════
-- 3. work_items_safe 뷰 재생성
-- ════════════════════════════════════════════════════════════
-- 0028(v2.54)의 정의에 engagement_code_splits를 추가.
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
    THEN NULL::jsonb
    ELSE engagement_code_splits
  END                                       AS engagement_code_splits,

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
  'name/client/description/hashtags/engagement_number/temp_engagement_code/'
  'engagement_code_splits 마스킹. 0046 재생성: engagement_code_splits 추가. (PRD v2.114)';

NOTIFY pgrst, 'reload schema';

SELECT 'migration 0046 (v2.114 W-10 engagement_code_splits) done' AS result;
