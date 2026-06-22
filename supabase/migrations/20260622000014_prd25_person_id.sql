-- =============================================================
-- Migration 0014: PRD v2.5 §6.2 — profiles.person_id 직접 연결
-- =============================================================
-- 실행 순서: 0001~0013 이후
-- 멱등 보장: CREATE OR REPLACE, ADD COLUMN IF NOT EXISTS
--
-- 변경 요약:
--   1. profiles.person_id 컬럼 — 0001에서 이미 생성됨 (멱등 확인만)
--      uuid REFERENCES people(id) ON DELETE SET NULL
--   2. my_person_id() 재정의 — LPN 조인 제거, profiles.person_id 직접 반환
--      SELECT person_id FROM profiles WHERE id = auth.uid()
--   3. profiles.lpn 코멘트 갱신 — 표시/식별용, 더 이상 매칭 키로 사용 안 함
--
-- 배경 (PRD v2.5 §6.2):
--   기존 my_person_id()는 LPN 조인(profiles.lpn ↔ people.lpn) 후
--   profiles.person_id를 폴백으로 사용했다.
--   §6.2부터는 person_id 직접 참조만 사용.
--   LPN은 표시/감사 목적의 식별 번호로만 유지.
-- =============================================================


-- ════════════════════════════════════════════════════════════
-- 1. profiles.person_id 존재 확인 (0001에서 이미 정의됨)
-- ════════════════════════════════════════════════════════════
-- 0001_tables.sql에서:
--   person_id uuid REFERENCES public.people(id) ON DELETE SET NULL
-- 이미 생성됨. ADD COLUMN IF NOT EXISTS는 멱등이므로 안전하게 재확인.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS person_id uuid
    REFERENCES public.people(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.profiles.person_id
  IS 'profiles → people 본인 연결. 관리자가 AccountManager에서 직접 설정. '
     'NULL = 인력 미연결. LPN 매칭이 아닌 이 컬럼이 본인 식별의 기준. (PRD v2.5 §6.2)';


-- ════════════════════════════════════════════════════════════
-- 2. profiles.lpn 코멘트 갱신 (더 이상 매칭 키 아님)
-- ════════════════════════════════════════════════════════════

COMMENT ON COLUMN public.profiles.lpn
  IS 'LPN (인력 식별 번호). 표시/감사 목적 전용. '
     '§6.2부터 본인 인력 매칭에 사용되지 않음 — profiles.person_id 직접 참조로 대체. (PRD v2.5 §6.2)';


-- ════════════════════════════════════════════════════════════
-- 3. my_person_id() 재정의 — profiles.person_id 직접 반환
-- ════════════════════════════════════════════════════════════
-- 기존: LPN 조인 (profiles.lpn ↔ people.lpn), 실패 시 person_id 폴백
-- 변경: profiles.person_id 단일 경로

CREATE OR REPLACE FUNCTION public.my_person_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT person_id
  FROM   public.profiles
  WHERE  id = auth.uid()
$$;

COMMENT ON FUNCTION public.my_person_id()
  IS 'profiles.person_id를 직접 반환. NULL = 인력 미연결. '
     '관리자가 Admin > 계정 관리에서 연결 설정. (PRD v2.5 §6.2)';


-- ════════════════════════════════════════════════════════════
-- 검증 쿼리 (Supabase SQL Editor에서 실행)
-- ════════════════════════════════════════════════════════════

-- 1) profiles.person_id 컬럼 확인
SELECT column_name, data_type, is_nullable
FROM   information_schema.columns
WHERE  table_schema = 'public'
  AND  table_name   = 'profiles'
  AND  column_name  = 'person_id';
-- 기대값: person_id, uuid, YES

-- 2) my_person_id() 함수 본문 확인
SELECT pg_get_functiondef(oid)
FROM   pg_proc
WHERE  proname = 'my_person_id'
  AND  pronamespace = 'public'::regnamespace;
-- 기대값: SELECT person_id FROM public.profiles WHERE id = auth.uid()

SELECT 'migration 0014 (PRD v2.5 §6.2) done' AS result;
