-- =============================================================
-- Migration 0010: PRD v2.1 §4 스키마·시드 보강
-- =============================================================
-- 실행 순서: 이전 마이그레이션(0001~0009) 이후
-- 멱등 보장: 이미 적용된 환경에서 재실행해도 안전합니다.
--
-- 변경 요약
--   1. accruals.direction 컬럼 추가 ('accrual'|'usage', DEFAULT 'accrual')
--   2. 누락 컬럼 멱등 추가:
--        profiles.lpn
--        people.lpn / hire_date / termination_date / status
--        work_items.project_status (open|closed)
--   3. settings: fiscal_year_start_month = 7 upsert
--        key-value 구조(0006)와 single-row 구조(0009) 양쪽 대응
--   4. 공휴일 기본값 시드 (idempotent — 중복 삽입 안 됨)
--   5. 헬퍼 함수 생성/교체 (CREATE OR REPLACE → 멱등)
--        fiscal_year(date)  ← 신규 (0001~0009 에 없음)
--        my_role()          ← 0006 재확인
--        my_person_id()     ← 0006 재확인 (LPN 매칭)
-- =============================================================


-- ════════════════════════════════════════════════════════════
-- 1. accruals.direction
-- ════════════════════════════════════════════════════════════
-- 적립(accrual) / 사용(usage) 구분 컬럼.
-- 기존 행은 모두 'accrual'(적립)로 처리.

ALTER TABLE public.accruals
  ADD COLUMN IF NOT EXISTS direction text
    NOT NULL DEFAULT 'accrual'
    CHECK (direction IN ('accrual','usage'));

COMMENT ON COLUMN public.accruals.direction
  IS 'accrual = 휴가 적립 | usage = 휴가 사용 차감. (PRD v2.1 §4)';


-- ════════════════════════════════════════════════════════════
-- 2. 누락 컬럼 멱등 추가
-- ════════════════════════════════════════════════════════════
-- ADD COLUMN IF NOT EXISTS: 컬럼 존재 시 전체 문 무시 (에러 없음).

-- ── 2-a. profiles.lpn ────────────────────────────────────────

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS lpn text;

COMMENT ON COLUMN public.profiles.lpn
  IS 'my_person_id() LPN 매칭 기준. auth 계정↔people 연결에 사용. (PRD v2.1 §4)';


-- ── 2-b. people 확장 컬럼 ────────────────────────────────────

ALTER TABLE public.people
  ADD COLUMN IF NOT EXISTS lpn              text,
  ADD COLUMN IF NOT EXISTS hire_date        date,
  ADD COLUMN IF NOT EXISTS termination_date date,
  ADD COLUMN IF NOT EXISTS status           text
    NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','resigned'));

-- people.lpn UNIQUE 제약 — pg_constraint 직접 조회해 조건부 추가
-- (ADD COLUMN IF NOT EXISTS 는 제약을 재생성하지 않으므로 별도 처리)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE  conname  = 'people_lpn_key'
      AND  conrelid = 'public.people'::regclass
  ) THEN
    ALTER TABLE public.people ADD CONSTRAINT people_lpn_key UNIQUE (lpn);
  END IF;
END $$;

COMMENT ON COLUMN public.people.lpn              IS '인력 식별 번호 (LPN). UNIQUE, NULL 허용 (미발급자).';
COMMENT ON COLUMN public.people.hire_date        IS '입사일.';
COMMENT ON COLUMN public.people.termination_date IS '퇴사일. NULL = 재직 중.';
COMMENT ON COLUMN public.people.status           IS 'active | resigned';


-- ── 2-c. work_items.project_status ──────────────────────────

ALTER TABLE public.work_items
  ADD COLUMN IF NOT EXISTS project_status text DEFAULT NULL
    CHECK (project_status IN ('open','closed'));

-- project 행 중 project_status 가 NULL 인 것을 'open' 으로 초기화
-- (0006 적용 후 0008 이 DEFAULT 를 NULL 로 변경한 환경에서도 안전)
UPDATE public.work_items
   SET project_status = 'open'
 WHERE type = 'project'
   AND project_status IS NULL;

-- proposal·pipeline 행 정리
UPDATE public.work_items
   SET project_status = NULL
 WHERE type <> 'project'
   AND project_status IS NOT NULL;

COMMENT ON COLUMN public.work_items.project_status
  IS 'project 유형 전용: open | closed. proposal·pipeline 은 NULL. (PRD v2.1 §4)';


-- ════════════════════════════════════════════════════════════
-- 3. settings: fiscal_year_start_month = 7 upsert
-- ════════════════════════════════════════════════════════════
-- Migration 0006 → key-value 구조 (key text PK, value text)
-- Migration 0009 → single-row 구조 (id int PK, fiscal_year_start_month int)
-- 두 구조를 information_schema 로 판별해 분기한다.

DO $$
BEGIN

  -- ── key-value 구조 (0006 패턴) ─────────────────────────────
  IF EXISTS (
    SELECT 1
    FROM   information_schema.columns
    WHERE  table_schema = 'public'
      AND  table_name   = 'settings'
      AND  column_name  = 'key'
  ) THEN
    INSERT INTO public.settings (key, value)
    VALUES ('fiscal_year_start_month', '7')
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

  -- ── single-row 구조 (0009 패턴) ────────────────────────────
  ELSIF EXISTS (
    SELECT 1
    FROM   information_schema.columns
    WHERE  table_schema = 'public'
      AND  table_name   = 'settings'
      AND  column_name  = 'fiscal_year_start_month'
  ) THEN
    INSERT INTO public.settings (id, fiscal_year_start_month)
    VALUES (1, 7)
    ON CONFLICT (id) DO UPDATE SET fiscal_year_start_month = 7;

  END IF;

END $$;


-- ════════════════════════════════════════════════════════════
-- 4. 공휴일 기본값 시드 (idempotent)
-- ════════════════════════════════════════════════════════════
-- (name, date) 복합 UNIQUE 인덱스가 없으면 먼저 생성한다.
-- ON CONFLICT (name, date) DO NOTHING → 이미 존재하는 행 무시.

CREATE UNIQUE INDEX IF NOT EXISTS idx_holidays_name_date
  ON public.holidays (name, date);

-- ── 4-a. 법정 공휴일 (매년 반복, recurring = true) ────────────
-- 기준 연도를 2000-xx-xx 로 통일. 앱의 buildHolidaySet() 이
-- year 범위를 순회해 실제 날짜를 확장한다.

INSERT INTO public.holidays (name, date, recurring) VALUES
  ('신정',    '2000-01-01', true),
  ('삼일절',  '2000-03-01', true),
  ('어린이날','2000-05-05', true),
  ('현충일',  '2000-06-06', true),
  ('광복절',  '2000-08-15', true),
  ('개천절',  '2000-10-03', true),
  ('한글날',  '2000-10-09', true),
  ('성탄절',  '2000-12-25', true)
ON CONFLICT (name, date) DO NOTHING;

-- ── 4-b. 설날 연휴 (2025, 2026) ──────────────────────────────

INSERT INTO public.holidays (name, date, recurring) VALUES
  ('설날 연휴', '2025-01-28', false),
  ('설날',     '2025-01-29', false),
  ('설날 연휴', '2025-01-30', false),
  ('설날 연휴', '2026-02-17', false),
  ('설날',     '2026-02-18', false),
  ('설날 연휴', '2026-02-19', false)
ON CONFLICT (name, date) DO NOTHING;

-- ── 4-c. 부처님오신날 (2025: 05-05 어린이날 공휴일 중복, 2026: 05-24) ──

INSERT INTO public.holidays (name, date, recurring) VALUES
  ('부처님오신날', '2025-05-05', false),
  ('부처님오신날', '2026-05-24', false)
ON CONFLICT (name, date) DO NOTHING;

-- ── 4-d. 추석 연휴 (2025, 2026) ──────────────────────────────
-- ※ 대체공휴일은 관보 확정 전 변동 가능 — 관리자 화면에서 수정하세요.

INSERT INTO public.holidays (name, date, recurring) VALUES
  ('추석 연휴',       '2025-10-05', false),
  ('추석',            '2025-10-06', false),
  ('추석 연휴',       '2025-10-07', false),
  ('추석 대체공휴일', '2025-10-08', false),
  ('추석 연휴',       '2026-09-23', false),
  ('추석',            '2026-09-24', false),
  ('추석 연휴',       '2026-09-25', false)
ON CONFLICT (name, date) DO NOTHING;


-- ════════════════════════════════════════════════════════════
-- 5. 헬퍼 함수 (부록 B)
-- ════════════════════════════════════════════════════════════

-- ── 5-a. fiscal_year(date) ────────────────────────────────────
-- 7월 시작 회계연도 번호(4자리 연도)를 반환한다.
--
-- 정의:
--   FY2026 = 2025-07-01 ~ 2026-06-30
--   월 ≥ 7  → 연도 + 1   (예: 2025-08-01 → 2026)
--   월 < 7  → 연도 그대로 (예: 2026-03-01 → 2026)
--
-- 검증 예시:
--   SELECT fiscal_year('2025-06-30');  -- 2025  (FY25의 마지막 날)
--   SELECT fiscal_year('2025-07-01');  -- 2026  (FY26의 첫 날)
--   SELECT fiscal_year('2026-06-30');  -- 2026  (FY26의 마지막 날)
--   SELECT fiscal_year('2026-07-01');  -- 2027  (FY27의 첫 날)

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
  IS '7월 시작 회계연도(4자리). fiscal_year(''2025-07-01'') = 2026 (FY26 첫날). (PRD v2.1 부록 B)';


-- ── 5-b. my_role() ────────────────────────────────────────────
-- 현재 인증 사용자의 global_role 반환.
-- 미인증(auth.uid() IS NULL) 또는 비활성(inactive) 계정이면 NULL.

CREATE OR REPLACE FUNCTION public.my_role()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT global_role
  FROM   public.profiles
  WHERE  id     = auth.uid()
    AND  status = 'active'
$$;

COMMENT ON FUNCTION public.my_role()
  IS '현재 인증 사용자의 global_role(admin|editor|viewer). 미인증/비활성 → NULL. (PRD v2.1 부록 B)';


-- ── 5-c. my_person_id() ───────────────────────────────────────
-- 현재 인증 사용자의 people.id 를 반환한다.
--
-- 우선순위:
--   1. profiles.lpn ↔ people.lpn 정확히 일치  (LPN 등록 계정)
--   2. profiles.person_id 직접 참조           (LPN 미등록 폴백)
--
-- SECURITY DEFINER: RLS 를 우회해 profiles·people 를 읽어야
-- 현재 사용자가 자신의 person_id 를 항상 확인할 수 있다.

CREATE OR REPLACE FUNCTION public.my_person_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    -- 1순위: LPN 매칭
    (
      SELECT pe.id
      FROM   public.people   pe
      JOIN   public.profiles pr ON pr.lpn = pe.lpn
      WHERE  pr.id  = auth.uid()
        AND  pr.lpn IS NOT NULL
        AND  pe.lpn IS NOT NULL
      LIMIT 1
    ),
    -- 2순위: person_id 직접 참조 폴백
    (
      SELECT person_id
      FROM   public.profiles
      WHERE  id = auth.uid()
    )
  )
$$;

COMMENT ON FUNCTION public.my_person_id()
  IS 'LPN 매칭 우선, 미등록 시 profiles.person_id 폴백으로 people.id 반환. (PRD v2.1 부록 B.1)';
