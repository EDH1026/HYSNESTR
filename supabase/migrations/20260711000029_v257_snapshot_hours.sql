-- =============================================================
-- Migration 0029: PRD v2.57 §5.14 TSG-8/TSG-10
-- =============================================================
-- 실행 순서: 0028 이후
-- 멱등 보장: ADD COLUMN IF NOT EXISTS, DROP CONSTRAINT DYNAMIC
--
-- 변경 요약:
--   1. timesheet_guideline_snapshot.hours 컬럼 추가
--      (셀별 투입 시간, 기본 8h)
--   2. 유니크 키 변경: (person_id, date) → (person_id, date, code)
--      TSG-8: 한 인력·날짜에 여러 코드(시간 분할) 지원
-- =============================================================


-- ════════════════════════════════════════════════════════════
-- 1. hours 컬럼 추가
-- ════════════════════════════════════════════════════════════

ALTER TABLE public.timesheet_guideline_snapshot
  ADD COLUMN IF NOT EXISTS hours NUMERIC(5,2) DEFAULT 8 NOT NULL;

COMMENT ON COLUMN public.timesheet_guideline_snapshot.hours IS
  'TSG-8: (인력, 날짜, 코드) 조합의 투입 시간(기본 8h). 수동 수정 시 0~24. (PRD v2.57)';


-- ════════════════════════════════════════════════════════════
-- 2. 유니크 키 변경
-- ════════════════════════════════════════════════════════════
-- 기존: UNIQUE(person_id, date)
-- 신규: UNIQUE(person_id, date, code)
--
-- 기존 제약 이름이 다를 수 있으므로 동적으로 찾아 삭제한다.

DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT c.conname, c.contype
    FROM pg_constraint c
    JOIN pg_class t ON c.conrelid = t.oid
    JOIN pg_namespace n ON t.relnamespace = n.oid
    WHERE n.nspname = 'public'
      AND t.relname = 'timesheet_guideline_snapshot'
      AND c.contype IN ('u', 'p')
  LOOP
    BEGIN
      -- primary key만 제거할 수 있으면 identity column이 없는 경우에만 안전
      -- (auto-generated serial pk가 있을 수 있으므로 2컬럼짜리만 제거)
      IF (
        SELECT array_length(c2.conkey, 1)
        FROM pg_constraint c2
        WHERE c2.conname = r.conname
          AND c2.conrelid = 'public.timesheet_guideline_snapshot'::regclass
      ) = 2 THEN
        EXECUTE format(
          'ALTER TABLE public.timesheet_guideline_snapshot DROP CONSTRAINT IF EXISTS %I',
          r.conname
        );
        RAISE NOTICE 'Dropped constraint: %', r.conname;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'Could not drop constraint %: %', r.conname, SQLERRM;
    END;
  END LOOP;
END $$;

-- 새 unique constraint (person_id, date, code)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON c.conrelid = t.oid
    JOIN pg_namespace n ON t.relnamespace = n.oid
    WHERE n.nspname = 'public'
      AND t.relname = 'timesheet_guideline_snapshot'
      AND c.conname = 'tgs_person_date_code_key'
  ) THEN
    ALTER TABLE public.timesheet_guideline_snapshot
      ADD CONSTRAINT tgs_person_date_code_key
      UNIQUE (person_id, date, code);
    RAISE NOTICE 'Added constraint tgs_person_date_code_key';
  END IF;
END $$;


-- ════════════════════════════════════════════════════════════
-- 검증
-- ════════════════════════════════════════════════════════════

SELECT 'migration 0029 (v2.57 snapshot hours + person_date_code key) done' AS result;
