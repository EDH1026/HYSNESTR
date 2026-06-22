-- =============================================================
-- Migration 0013: PRD v2.4 §3 / §5.5 / §5.6
-- =============================================================
-- 실행 순서: 0001~0012 이후
-- 멱등 보장: ADD COLUMN IF NOT EXISTS / CREATE TABLE IF NOT EXISTS /
--            ON CONFLICT DO NOTHING / DROP VIEW IF EXISTS → CREATE VIEW
--
-- 변경 요약:
--   1. work_items.status  — 'open'|'closed', DEFAULT 'open', NOT NULL
--      · 전 유형(project / proposal / pipeline) 공통으로 적용
--      · 기존 project_status='closed' 값을 status 로 이관
--      · project_status 컬럼은 하위 호환 목적으로 유지
--   2. work_items_safe 뷰 재생성 — status 컬럼 노출 추가
--      (기존 마스킹 로직 동일, project_status 도 계속 노출)
--   3. leave_types 참조 테이블 + 8개 유형 시드
--
-- ※ 형식 안내 (DB 제약 없음 — 앱 단에서 유효성 검사):
--    · Engagement Code: 'E-00000000'  (E- 접두사 + 숫자 8자리)
--    · LPN            : '00000'       (숫자 5자리)
-- =============================================================


-- ════════════════════════════════════════════════════════════
-- 1. work_items.status  (전 유형 공통 open/closed)
-- ════════════════════════════════════════════════════════════
-- NOT NULL DEFAULT 'open': PostgreSQL 이 기존 행을 'open' 으로 채운다.
-- ADD COLUMN IF NOT EXISTS: 컬럼이 이미 있으면 전체 문 무시 (멱등).

ALTER TABLE public.work_items
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'closed'));

COMMENT ON COLUMN public.work_items.status
  IS 'open | closed. 전 유형(project/proposal/pipeline) 공통. '
     '기존 project_status 의 일반화. (PRD v2.4 §3)';

-- project 행 중 project_status = 'closed' 인 것만 status 로 이관.
-- · 'open' → 이미 DEFAULT 값과 일치, 업데이트 불필요.
-- · status = 'open' 조건: ADD COLUMN 직후 상태인 행만 덮어쓰기 (멱등 보장).
UPDATE public.work_items
   SET status = 'closed'
 WHERE type           = 'project'
   AND project_status = 'closed'
   AND status         = 'open';


-- ════════════════════════════════════════════════════════════
-- 2. work_items_safe 뷰 재생성
-- ════════════════════════════════════════════════════════════
-- 0012 의 뷰를 DROP → CREATE 로 교체.
-- · 마스킹 로직 동일 (confidential + my_role() 체크)
-- · project_status 유지 (하위 호환)
-- · status 컬럼 신규 추가

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
  project_status,   -- 하위 호환 유지 (project 전용 레거시, 신규 코드는 status 사용)
  status,           -- 전 유형 공통 (PRD v2.4 §3)
  created_at,
  updated_at

FROM public.work_items;

COMMENT ON VIEW public.work_items_safe
  IS 'work_items 마스킹 뷰. confidential=true 항목은 비-editor 에게 '
     'name/client/description/hashtags/engagement_number 마스킹. '
     '0013 재생성: status 컬럼 추가. (PRD v2.4 §3, 부록 B.3)';


-- ════════════════════════════════════════════════════════════
-- 3. leave_types 참조 테이블
-- ════════════════════════════════════════════════════════════
-- UI 드롭다운·유효성 검사의 권위 있는 소스.
-- assignments.leave_type 과는 논리적 연결 (FK 없음):
--   · assignments.leave_type 에 '종료 후 잔여 소진' 이 있어 FK 불가.
-- active=false: 레거시 데이터 보존 + 신규 배정 UI 에서 숨김.

CREATE TABLE IF NOT EXISTS public.leave_types (
  name       text    PRIMARY KEY,
  active     boolean NOT NULL DEFAULT true,
  sort_order int     NOT NULL
);

COMMENT ON TABLE  public.leave_types            IS '휴가 유형 마스터 테이블. (PRD v2.4 §5.6)';
COMMENT ON COLUMN public.leave_types.name       IS '휴가 유형 코드 (한글). assignments.leave_type 과 논리적 대응.';
COMMENT ON COLUMN public.leave_types.active     IS 'false = 신규 배정 불가; 기존 데이터는 보존.';
COMMENT ON COLUMN public.leave_types.sort_order IS 'UI 드롭다운 표시 순서 (오름차순).';

-- 감사 로그
DROP TRIGGER IF EXISTS tg_audit_leave_types ON public.leave_types;
CREATE TRIGGER tg_audit_leave_types
  AFTER INSERT OR UPDATE OR DELETE ON public.leave_types
  FOR EACH ROW EXECUTE FUNCTION public.audit_trigger_fn();

-- RLS
ALTER TABLE public.leave_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.leave_types FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS leave_types_select ON public.leave_types;
DROP POLICY IF EXISTS leave_types_insert ON public.leave_types;
DROP POLICY IF EXISTS leave_types_update ON public.leave_types;
DROP POLICY IF EXISTS leave_types_delete ON public.leave_types;

-- 인증 사용자 전체 읽기 (드롭다운 로딩)
CREATE POLICY leave_types_select ON public.leave_types
  FOR SELECT USING (auth.uid() IS NOT NULL);

-- 쓰기는 admin 전용
CREATE POLICY leave_types_insert ON public.leave_types
  FOR INSERT WITH CHECK (is_admin());

CREATE POLICY leave_types_update ON public.leave_types
  FOR UPDATE
  USING      (is_admin())
  WITH CHECK (is_admin());

CREATE POLICY leave_types_delete ON public.leave_types
  FOR DELETE USING (is_admin());

-- 8개 유형 시드 (sort_order = PRD v2.4 §5.6 표준 순서)
-- ON CONFLICT DO NOTHING: 재실행 시 중복 삽입 방지
INSERT INTO public.leave_types (name, sort_order) VALUES
  ('리프레시',      1),
  ('지정휴가',      2),
  ('프로젝트휴가',  3),
  ('주말/휴일대체', 4),
  ('포상휴가',      5),
  ('특별휴가',      6),
  ('지연보상',      7),
  ('휴직',          8)
ON CONFLICT (name) DO NOTHING;


-- ════════════════════════════════════════════════════════════
-- 검증 쿼리 (SQL Editor 에서 실행)
-- ════════════════════════════════════════════════════════════

-- 1) work_items.status 컬럼 추가 확인
SELECT column_name, data_type, column_default, is_nullable
FROM   information_schema.columns
WHERE  table_schema = 'public'
  AND  table_name   = 'work_items'
  AND  column_name  IN ('project_status', 'status')
ORDER BY column_name;
-- 기대값: project_status (nullable), status (NOT NULL, default 'open')

-- 2) 뷰에 status 컬럼 확인
SELECT column_name
FROM   information_schema.columns
WHERE  table_schema = 'public'
  AND  table_name   = 'work_items_safe'
  AND  column_name  IN ('project_status', 'status')
ORDER BY column_name;
-- 기대값: 두 컬럼 모두 반환

-- 3) leave_types 행 수 확인 (기대값: 8)
SELECT count(*) AS leave_type_count FROM public.leave_types;

-- 4) leave_types 전체 확인
SELECT name, active, sort_order
FROM   public.leave_types
ORDER BY sort_order;

SELECT 'migration 0013 (PRD v2.4) done' AS result;
