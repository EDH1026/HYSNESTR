-- =============================================================
-- Migration 0006: PRD §4 — 스키마 확장 v2
-- =============================================================
-- 실행 순서: 0005_pipeline.sql 이후
-- 기존 데이터에 영향 없음:
--   · ADD COLUMN IF NOT EXISTS 사용 (컬럼 존재 시 무시)
--   · INSERT … ON CONFLICT … DO NOTHING 으로 중복 방지
--   · DROP POLICY IF EXISTS → CREATE POLICY 로 정책 멱등 보장
--   · DO $$ BEGIN … END $$ 으로 UNIQUE 제약 중복 방지
-- =============================================================


-- ── 1. people 컬럼 추가 ───────────────────────────────────────
-- lpn: 인력 식별 번호 (UNIQUE, NULL 허용 — 미발급자 존재 가능)
-- hire_date / termination_date: 입·퇴사일 (NULL 허용)
-- status: 재직 상태 ('active' 기본값 → 기존 행 영향 없음)

ALTER TABLE public.people
  ADD COLUMN IF NOT EXISTS lpn              text,
  ADD COLUMN IF NOT EXISTS hire_date        date,
  ADD COLUMN IF NOT EXISTS termination_date date,
  ADD COLUMN IF NOT EXISTS status           text NOT NULL DEFAULT 'active'
                                            CHECK (status IN ('active','resigned'));

-- ADD COLUMN IF NOT EXISTS 는 제약 재생성을 건너뛰므로
-- UNIQUE 제약은 pg_constraint 를 직접 조회해 조건부 추가한다.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE  conname    = 'people_lpn_key'
      AND  conrelid   = 'public.people'::regclass
  ) THEN
    ALTER TABLE public.people ADD CONSTRAINT people_lpn_key UNIQUE (lpn);
  END IF;
END $$;

COMMENT ON COLUMN public.people.lpn              IS '인력 식별 번호 (LPN). UNIQUE, NULL 허용 (미발급자).';
COMMENT ON COLUMN public.people.hire_date        IS '입사일';
COMMENT ON COLUMN public.people.termination_date IS '퇴사일. NULL = 재직 중.';
COMMENT ON COLUMN public.people.status           IS 'active | resigned';


-- ── 2. work_items 컬럼 추가 ──────────────────────────────────
-- project 유형에만 의미 있음. proposal·pipeline 은 NULL 유지.
-- DEFAULT 'open' 은 기존 project 행을 'open' 으로 초기화한다.

ALTER TABLE public.work_items
  ADD COLUMN IF NOT EXISTS project_status text DEFAULT 'open'
                                          CHECK (project_status IN ('open','closed'));

-- proposal·pipeline 기존 행은 NULL 로 초기화 (project만 'open')
UPDATE public.work_items
  SET project_status = NULL
WHERE type <> 'project'
  AND project_status IS NOT NULL;

COMMENT ON COLUMN public.work_items.project_status
  IS 'project 유형 전용: open | closed. proposal·pipeline 은 NULL.';


-- ── 3. profiles 컬럼 추가 ────────────────────────────────────

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS lpn text;

COMMENT ON COLUMN public.profiles.lpn
  IS 'auth 계정과 people.lpn 을 연결하는 인력 식별 번호. my_person_id() LPN 매칭에 사용.';


-- ── 4. settings 테이블 ────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.settings (
  key   text PRIMARY KEY,
  value text
);

COMMENT ON TABLE public.settings
  IS '앱 전역 설정 key-value 저장소 (PRD §4).';

-- 감사 로그 트리거 (DROP IF EXISTS → 멱등)
DROP TRIGGER IF EXISTS tg_audit_settings ON public.settings;
CREATE TRIGGER tg_audit_settings
  AFTER INSERT OR UPDATE OR DELETE ON public.settings
  FOR EACH ROW EXECUTE FUNCTION public.audit_trigger_fn();

-- RLS 활성화
ALTER TABLE public.settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.settings FORCE ROW LEVEL SECURITY;

-- 정책 멱등 (DROP → CREATE)
DROP POLICY IF EXISTS settings_select ON public.settings;
DROP POLICY IF EXISTS settings_insert ON public.settings;
DROP POLICY IF EXISTS settings_update ON public.settings;
DROP POLICY IF EXISTS settings_delete ON public.settings;

-- 인증된 사용자 전체 읽기 허용 (앱 설정값 필요)
CREATE POLICY settings_select ON public.settings
  FOR SELECT USING (auth.uid() IS NOT NULL);

-- 쓰기는 admin 전용
CREATE POLICY settings_insert ON public.settings
  FOR INSERT WITH CHECK (is_admin());

CREATE POLICY settings_update ON public.settings
  FOR UPDATE
  USING      (is_admin())
  WITH CHECK (is_admin());

CREATE POLICY settings_delete ON public.settings
  FOR DELETE USING (is_admin());

-- 기본값 시드
INSERT INTO public.settings (key, value)
VALUES ('fiscal_year_start_month', '7')
ON CONFLICT (key) DO NOTHING;


-- ── 5. 공휴일 시드 ────────────────────────────────────────────
-- recurring=true : buildHolidaySet() 이 year 범위를 순회해 확장.
--                  기준 연도를 2000-xx-xx 로 통일.
-- recurring=false: 연도별 지정 공휴일 (최근 2개 연도: 2025, 2026).
--
-- 중복 방지: (name, date) 복합 유니크 인덱스 + ON CONFLICT DO NOTHING.
-- ※ 연도별 날짜는 관보 기준이며, 변경 시 관리자 화면에서 수정하세요.
-- ※ 이 인덱스 생성 전 동일 (name, date) 중복 데이터가 존재하면
--    CREATE UNIQUE INDEX 가 실패합니다 — 먼저 중복 행을 정리하세요.

CREATE UNIQUE INDEX IF NOT EXISTS idx_holidays_name_date
  ON public.holidays (name, date);

-- 5-a. 법정 공휴일 (매년 반복, recurring = true)
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

-- 5-b. 설날 연휴 (2025, 2026)
INSERT INTO public.holidays (name, date, recurring) VALUES
  ('설날 연휴', '2025-01-28', false),
  ('설날',     '2025-01-29', false),
  ('설날 연휴', '2025-01-30', false),
  ('설날 연휴', '2026-02-17', false),
  ('설날',     '2026-02-18', false),
  ('설날 연휴', '2026-02-19', false)
ON CONFLICT (name, date) DO NOTHING;

-- 5-c. 부처님오신날 (2025: 어린이날 05-05 와 동일, 2026: 05-24)
INSERT INTO public.holidays (name, date, recurring) VALUES
  ('부처님오신날', '2025-05-05', false),
  ('부처님오신날', '2026-05-24', false)
ON CONFLICT (name, date) DO NOTHING;

-- 5-d. 추석 연휴 (2025, 2026)
-- ※ 대체공휴일은 연도에 따라 달라질 수 있으므로 확인 후 수정하세요.
INSERT INTO public.holidays (name, date, recurring) VALUES
  ('추석 연휴',      '2025-10-05', false),
  ('추석',           '2025-10-06', false),
  ('추석 연휴',      '2025-10-07', false),
  ('추석 대체공휴일','2025-10-08', false),
  ('추석 연휴',      '2026-09-23', false),
  ('추석',           '2026-09-24', false),
  ('추석 연휴',      '2026-09-25', false)
ON CONFLICT (name, date) DO NOTHING;


-- ── 6. 헬퍼 함수 (부록 B.1) ──────────────────────────────────

-- 6-a. my_role(): 현재 사용자의 global_role 반환
--   미인증 또는 비활성(inactive) 계정이면 NULL 반환.
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
  IS '현재 인증 사용자의 global_role(admin|editor|viewer) 반환. 미인증/비활성이면 NULL.';

-- 6-b. my_person_id(): LPN 매칭으로 현재 사용자의 people.id 반환
--
-- 우선순위:
--   1. profiles.lpn ↔ people.lpn 정확히 일치 (LPN 등록 계정)
--   2. profiles.person_id 직접 참조 (LPN 미등록 폴백)
--
-- SECURITY DEFINER: people·profiles 를 RLS 없이 읽어
-- 현재 사용자가 자신의 person_id 를 항상 확인할 수 있게 한다.
CREATE OR REPLACE FUNCTION public.my_person_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    -- 1. LPN 매칭
    (
      SELECT pe.id
      FROM   public.people   pe
      JOIN   public.profiles pr ON pr.lpn = pe.lpn
      WHERE  pr.id  = auth.uid()
        AND  pr.lpn IS NOT NULL
        AND  pe.lpn IS NOT NULL
      LIMIT 1
    ),
    -- 2. 직접 참조 폴백
    (
      SELECT person_id
      FROM   public.profiles
      WHERE  id = auth.uid()
    )
  )
$$;

COMMENT ON FUNCTION public.my_person_id()
  IS 'LPN 매칭으로 현재 사용자의 people.id 반환. LPN 미등록 시 profiles.person_id 폴백. (부록 B.1)';
