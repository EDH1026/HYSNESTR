-- PRD v2.29 AL-9 — annual_leave_grants: grant_type 컬럼 추가 + UNIQUE 제약 변경
--
-- 문제: (person_id, year) UNIQUE 제약으로 인해 수동 입력 행과 자동계산 행이
--       같은 역년에 충돌 → "duplicate key" 오류.
--
-- 해결:
--   1. grant_type 컬럼 추가 ('first_year_monthly' | 'annual')
--   2. 기존 행은 모두 'annual' 로 채움
--   3. 구 UNIQUE (person_id, year) 삭제
--   4. 신 UNIQUE (person_id, year, grant_type) 추가
--
-- 이후 Edge Function 은 INSERT ... ON CONFLICT (person_id, year, grant_type) DO NOTHING
-- 으로 바뀌어, 수동 행과 충돌 시 에러 없이 건너뜀.
--
-- year 컬럼: 현재 역년(calendar year) 기준으로 저장됨.
--   (FY 라벨 = month>=7 ? year+1 : year 로 변환 시 기존 수동 입력 행의 의미가
--    6개월 앞당겨지는 부작용이 있어, 이번 마이그레이션에서는 변경하지 않는다.)

-- ════════════════════════════════════════════════════════════════
-- 1. grant_type 컬럼 추가 (DEFAULT 'annual' → 기존 행 자동 채움)
-- ════════════════════════════════════════════════════════════════
ALTER TABLE public.annual_leave_grants
  ADD COLUMN IF NOT EXISTS grant_type TEXT NOT NULL DEFAULT 'annual'
    CONSTRAINT annual_leave_grants_grant_type_check
    CHECK (grant_type IN ('first_year_monthly', 'annual'));

-- ════════════════════════════════════════════════════════════════
-- 2. 구 UNIQUE (person_id, year) 삭제
-- ════════════════════════════════════════════════════════════════
ALTER TABLE public.annual_leave_grants
  DROP CONSTRAINT IF EXISTS annual_leave_grants_person_id_year_key;

-- ════════════════════════════════════════════════════════════════
-- 3. 신 UNIQUE (person_id, year, grant_type) 추가
-- ════════════════════════════════════════════════════════════════
ALTER TABLE public.annual_leave_grants
  ADD CONSTRAINT annual_leave_grants_person_year_granttype_key
    UNIQUE (person_id, year, grant_type);

-- ════════════════════════════════════════════════════════════════
-- 4. 검증
-- ════════════════════════════════════════════════════════════════
SELECT
  'migration 0025 (v2.29 grant_type) done' AS result,
  count(*)                                  AS total_grants,
  count(*) FILTER (WHERE grant_type = 'annual')            AS annual_count,
  count(*) FILTER (WHERE grant_type = 'first_year_monthly') AS monthly_count
FROM public.annual_leave_grants;
