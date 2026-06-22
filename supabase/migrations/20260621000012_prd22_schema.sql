-- =============================================================
-- Migration 0012: PRD v2.2 §3 스키마 보강
-- =============================================================
-- 실행 순서: 0001~0011 이후
-- 멱등 보장: ADD COLUMN IF NOT EXISTS / CREATE OR REPLACE /
--            DO $$ 조건 분기로 재실행 시 에러 없음.
--
-- 변경 요약:
--   1. work_items.description  (text)             컬럼 추가
--   2. work_items.confidential (boolean DEFAULT false) 컬럼 추가
--   3. accruals.days 부호 CHECK 제약 제거
--      (numeric(5,1) 은 이미 부호 무관 — 추가 제약 있으면 제거)
--   4. fiscal_year(date) 함수 7월 기준 재생성
--      month ≥ 7 → year+1 / month < 7 → year
--   5. work_items_safe 마스킹 뷰 생성 (부록 B.3)
--      editor/admin : 모든 컬럼 원본 노출
--      그 외 (viewer·미인증) : confidential=true 항목의
--        name / client / description / hashtags / engagement_number 마스킹
-- =============================================================


-- ════════════════════════════════════════════════════════════
-- 1. work_items 컬럼 추가
-- ════════════════════════════════════════════════════════════

ALTER TABLE public.work_items
  ADD COLUMN IF NOT EXISTS description  text,
  ADD COLUMN IF NOT EXISTS confidential boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.work_items.description
  IS '작업 항목 상세 설명 (자유 텍스트). (PRD v2.2 §3)';

COMMENT ON COLUMN public.work_items.confidential
  IS 'true = 기밀 프로젝트. editor 미만 사용자에게 name/client/description/'
     'hashtags/engagement_number 마스킹. (PRD v2.2 §3, 부록 B.3)';


-- ════════════════════════════════════════════════════════════
-- 2. accruals.days 부호 제약 제거
-- ════════════════════════════════════════════════════════════
-- 원본 DDL(0001): numeric(5,1) NOT NULL — 부호 제약 없음.
-- direction='usage' 레코드에서 음수 days를 저장할 수 있도록
-- days 컬럼에 걸린 CHECK 제약(양수 강제 등)이 존재하면 모두 제거한다.
-- 제약이 없어도 에러 없이 넘어간다.

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.conname
    FROM   pg_constraint c
    JOIN   pg_class      t ON t.oid = c.conrelid
    JOIN   pg_namespace  n ON n.oid = t.relnamespace
    WHERE  n.nspname = 'public'
      AND  t.relname = 'accruals'
      AND  c.contype = 'c'
      AND  pg_get_constraintdef(c.oid) ILIKE '%days%'
  LOOP
    EXECUTE format(
      'ALTER TABLE public.accruals DROP CONSTRAINT IF EXISTS %I',
      r.conname
    );
    RAISE NOTICE 'Dropped constraint % from accruals', r.conname;
  END LOOP;
END $$;

COMMENT ON COLUMN public.accruals.days
  IS '0.5 단위 적립·차감 일수. 양수 = 적립(direction=accrual), 음수 허용 (부호 제약 없음). (PRD v2.2 §3)';


-- ════════════════════════════════════════════════════════════
-- 3. fiscal_year(date) 7월 기준 재생성
-- ════════════════════════════════════════════════════════════
-- FY 정의: FY26 = 2025-07-01 ~ 2026-06-30
--   month ≥ 7  →  year + 1    예) 2025-08-01 → 2026
--   month < 7  →  year        예) 2026-03-01 → 2026
--
-- CREATE OR REPLACE: 4월 기준 등 이전 버전이 있으면 덮어씀.
--
-- 검증 (SQL Editor에서 실행):
--   SELECT fiscal_year('2025-08-01');  -- 2026 ✓
--   SELECT fiscal_year('2026-03-01');  -- 2026 ✓
--   SELECT fiscal_year('2025-06-30');  -- 2025 ✓
--   SELECT fiscal_year('2025-07-01');  -- 2026 ✓

CREATE OR REPLACE FUNCTION public.fiscal_year(d date)
RETURNS integer
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT CASE
    WHEN EXTRACT(MONTH FROM d)::int >= 7
    THEN EXTRACT(YEAR  FROM d)::int + 1
    ELSE EXTRACT(YEAR  FROM d)::int
  END
$$;

COMMENT ON FUNCTION public.fiscal_year(date)
  IS '7월 시작 회계연도 번호. fiscal_year(''2025-07-01'') = 2026 (FY26 첫날). (PRD v2.2 §3)';


-- ════════════════════════════════════════════════════════════
-- 4. work_items_safe 마스킹 뷰 (부록 B.3)
-- ════════════════════════════════════════════════════════════
-- security_invoker = true (PG 15 / Supabase 기본 지원):
--   기반 테이블(work_items)의 RLS를 호출 사용자 컨텍스트로 적용.
--   → 행 수준 필터는 work_items RLS 정책이 그대로 담당.
--
-- my_role() 은 SECURITY DEFINER 이므로 뷰 내에서 호출 가능.
-- COALESCE(my_role(), '') 처리: 미인증(NULL) → 빈 문자열로 처리
-- → 'admin'/'editor' 에 해당하지 않으므로 마스킹 적용.
--
-- 마스킹 대상 (confidential = true && role NOT IN admin/editor):
--   name              → '(비공개)'
--   client            → NULL
--   description       → NULL
--   hashtags          → '{}'::text[]
--   engagement_number → NULL

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
  END                                     AS name,

  color,
  start,
  main_start,
  end_date,

  CASE
    WHEN confidential
      AND COALESCE(my_role(), '') NOT IN ('admin', 'editor')
    THEN NULL::text
    ELSE engagement_number
  END                                     AS engagement_number,

  CASE
    WHEN confidential
      AND COALESCE(my_role(), '') NOT IN ('admin', 'editor')
    THEN NULL::text
    ELSE client
  END                                     AS client,

  CASE
    WHEN confidential
      AND COALESCE(my_role(), '') NOT IN ('admin', 'editor')
    THEN NULL::text
    ELSE description
  END                                     AS description,

  CASE
    WHEN confidential
      AND COALESCE(my_role(), '') NOT IN ('admin', 'editor')
    THEN '{}'::text[]
    ELSE hashtags
  END                                     AS hashtags,

  confidential,
  project_status,
  created_at,
  updated_at

FROM public.work_items;

COMMENT ON VIEW public.work_items_safe
  IS 'work_items 마스킹 뷰(부록 B.3). confidential=true 항목은 비-editor에게 '
     'name/client/description/hashtags/engagement_number 를 마스킹.';


-- ════════════════════════════════════════════════════════════
-- 검증 쿼리 (SQL Editor에서 실행)
-- ════════════════════════════════════════════════════════════
-- 1) fiscal_year 함수 검증
SELECT
  fiscal_year('2025-08-01'::date) AS fy_2026_a,   -- 기대값: 2026
  fiscal_year('2026-03-01'::date) AS fy_2026_b,   -- 기대값: 2026
  fiscal_year('2025-06-30'::date) AS fy_2025,     -- 기대값: 2025
  fiscal_year('2025-07-01'::date) AS fy_2026_c;   -- 기대값: 2026

-- 2) 컬럼 존재 확인
-- SELECT column_name, data_type, column_default
-- FROM   information_schema.columns
-- WHERE  table_schema = 'public'
--   AND  table_name   = 'work_items'
--   AND  column_name  IN ('description', 'confidential');

-- 3) 뷰 존재 확인
-- SELECT viewname FROM pg_views
-- WHERE  schemaname = 'public' AND viewname = 'work_items_safe';

SELECT 'migration 0012 (PRD v2.2 §3) done' AS result;
