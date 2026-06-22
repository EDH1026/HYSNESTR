-- =============================================================
-- Migration 0008: Pipeline 제약·DEFAULT 방어 수정
-- =============================================================
-- 실행 순서: 0007_rls_v2.sql 이후 (또는 독립적으로 실행 가능)
--
-- 문제 1) work_items.type 체크 제약
--   migration 0001의 인라인 CHECK auto-name이 'work_items_type_check'가
--   아닌 다른 이름으로 생성된 경우, migration 0005가 DROP IF EXISTS로
--   넘어가 pipeline을 허용하지 않는 OLD 제약이 남아 있을 수 있음.
--   → pg_constraint 시스템 카탈로그에서 'pipeline'을 포함하지 않는
--     type CHECK 제약을 모두 찾아 DROP하고 wi_type_values를 재보증한다.
--
-- 문제 2) project_status DEFAULT
--   migration 0006은 project_status의 DEFAULT를 'open'으로 설정했다.
--   pipeline·proposal 신규 삽입 시 project_status를 명시하지 않으면
--   DEFAULT 'open'이 사용되어 pipeline 행에 잘못된 값이 저장된다.
--   → DEFAULT를 NULL로 변경하고 기존 비-project 행을 NULL로 정리한다.
--
-- 이 마이그레이션은 0006이 미적용(컬럼 없음)인 상태에서도 안전하게
-- 실행된다: 각 블록이 컬럼 존재 여부를 확인하고 분기한다.
-- =============================================================


-- ── 1. type 체크 제약 완전 정비 ──────────────────────────────

DO $$
DECLARE
  cname text;
BEGIN
  -- pipeline 을 포함하지 않는 type 체크 제약을 모두 삭제
  FOR cname IN
    SELECT conname
    FROM   pg_constraint
    WHERE  conrelid  = 'public.work_items'::regclass
      AND  contype   = 'c'
      AND  pg_get_constraintdef(oid) ILIKE '%project%'
      AND  pg_get_constraintdef(oid) NOT ILIKE '%pipeline%'
  LOOP
    EXECUTE format('ALTER TABLE public.work_items DROP CONSTRAINT %I', cname);
  END LOOP;
END $$;

-- wi_type_values 는 0005가 추가했을 수 있으므로 DROP → re-ADD 로 멱등 보장
ALTER TABLE public.work_items
  DROP CONSTRAINT IF EXISTS wi_type_values;

ALTER TABLE public.work_items
  ADD CONSTRAINT wi_type_values
  CHECK (type IN ('project', 'proposal', 'pipeline'));


-- ── 2. project_status DEFAULT NULL 변경 ──────────────────────
-- (컬럼이 없으면 0006이 아직 미적용 → 아무것도 하지 않음)

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM   information_schema.columns
    WHERE  table_schema = 'public'
      AND  table_name   = 'work_items'
      AND  column_name  = 'project_status'
  ) THEN
    -- DEFAULT 'open' → NULL (프론트가 project 유형에만 명시적으로 'open' 전달)
    ALTER TABLE public.work_items
      ALTER COLUMN project_status SET DEFAULT NULL;

    -- 기존 pipeline·proposal 행 정리
    UPDATE public.work_items
    SET    project_status = NULL
    WHERE  type <> 'project';
  END IF;
END $$;
