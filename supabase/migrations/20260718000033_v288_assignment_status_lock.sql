-- =============================================================
-- Migration 0033: PRD v2.88 — assignments(kind='leave') Open/Closed 잠금
-- =============================================================
-- 실행 순서: 0032 이후
-- 멱등 보장: ADD COLUMN IF NOT EXISTS / DROP CONSTRAINT IF EXISTS /
--            CREATE OR REPLACE FUNCTION / DROP TRIGGER IF EXISTS → CREATE TRIGGER
--
-- 변경 요약:
--   1. assignments.status 컬럼 추가 (text, 'open'|'closed', DEFAULT 'open')
--      기존 데이터는 DEFAULT 'open' — 별도 백필 불필요.
--
--   2. check_assignment_leave_closed() 트리거 함수 (BEFORE UPDATE OR DELETE):
--      kind='leave' AND OLD.status='closed' 인 행에 대해:
--        UPDATE (status → 'open'): 허용, 단 다른 컬럼은 OLD 값으로 강제 복원
--        UPDATE (기타): 거부
--        DELETE: 거부
--
--   3. RLS: 기존 assignments_update 정책이 editor/admin only UPDATE를 이미 강제하므로
--      status 변경 권한을 위한 추가 정책 불필요.
--
--   4. daily_hours 제약 수정: PRD v2.87에서 UI는 0을 허용하도록 변경했으나
--      DB 제약이 daily_hours > 0 (0 미허용)이었던 문제를 함께 수정.
--      → CHECK (daily_hours IS NULL OR (daily_hours >= 0 AND daily_hours <= 24))
--
-- 보안: SECURITY DEFINER — DB 수준 강제이므로 클라이언트 우회 불가
-- =============================================================


-- ════════════════════════════════════════════════════════════
-- 1. assignments.status 컬럼 추가
-- ════════════════════════════════════════════════════════════

ALTER TABLE public.assignments
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'open';

ALTER TABLE public.assignments
  DROP CONSTRAINT IF EXISTS assignments_status_values;

ALTER TABLE public.assignments
  ADD CONSTRAINT assignments_status_values
    CHECK (status IN ('open', 'closed'));

COMMENT ON COLUMN public.assignments.status IS
  'PRD v2.88: 휴가 배정 잠금 상태. ''closed''이면 내용 편집·삭제 불가; status=''open'' 전환만 허용.';


-- ════════════════════════════════════════════════════════════
-- 2. daily_hours 제약 수정: 0 허용 (PRD v2.87 DB 미수정 버그)
-- ════════════════════════════════════════════════════════════

ALTER TABLE public.assignments
  DROP CONSTRAINT IF EXISTS assignments_daily_hours_range;

ALTER TABLE public.assignments
  ADD CONSTRAINT assignments_daily_hours_range
    CHECK (daily_hours IS NULL OR (daily_hours >= 0 AND daily_hours <= 24));

COMMENT ON COLUMN public.assignments.daily_hours IS
  'TSG-14: Partner 다중 배정 시 해당 프로젝트에 투입하는 하루 시간. '
  'NULL=단일 배정(8h 전체). 0=해당 프로젝트 0h(전부 NBD). (PRD v2.78/v2.87)';


-- ════════════════════════════════════════════════════════════
-- 3. leave Closed lock 트리거 함수
-- ════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.check_assignment_leave_closed()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  -- kind='leave' 가 아닌 배정(work assignment)은 이 트리거와 무관
  IF TG_OP = 'DELETE' THEN
    IF OLD.kind IS DISTINCT FROM 'leave' THEN RETURN OLD; END IF;
  ELSE
    IF OLD.kind IS DISTINCT FROM 'leave' THEN RETURN NEW; END IF;
  END IF;

  -- kind='leave' 이지만 OLD.status='closed' 가 아니면 허용
  IF OLD.status IS DISTINCT FROM 'closed' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;

  -- ── 여기서부터: kind='leave' AND OLD.status='closed' ────────

  -- DELETE 거부
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'CLOSED_LEAVE_ASSIGNMENT'
      USING MESSAGE = 'Closed 휴가 배정은 삭제할 수 없습니다. 먼저 Open으로 전환하세요.',
            HINT    = 'Set status to ''open'' before deleting.';
  END IF;

  -- UPDATE: status → 'open' (재오픈) 만 허용
  -- 다른 컬럼은 OLD 값으로 강제 복원 (재오픈과 동시 편집 방지)
  IF NEW.status = 'open' THEN
    NEW.person_id     := OLD.person_id;
    NEW.kind          := OLD.kind;
    NEW.work_item_id  := OLD.work_item_id;
    NEW.weekend_dates := OLD.weekend_dates;
    NEW.leave_type    := OLD.leave_type;
    NEW.start         := OLD.start;
    NEW.end_date      := OLD.end_date;
    NEW.note          := OLD.note;
    NEW.daily_hours   := OLD.daily_hours;
    RETURN NEW;
  END IF;

  -- status='closed' 유지 또는 다른 값으로 변경 → 거부
  RAISE EXCEPTION 'CLOSED_LEAVE_ASSIGNMENT'
    USING MESSAGE = 'Closed 휴가 배정은 Open 전환 외 편집·삭제할 수 없습니다.',
          HINT    = 'Set status to ''open'' before making other changes.';
END;
$$;

COMMENT ON FUNCTION public.check_assignment_leave_closed() IS
  'PRD v2.88: kind=''leave'' AND status=''closed'' 인 배정의 편집·삭제 거부. status→''open'' 전환만 허용.';

DROP TRIGGER IF EXISTS trg_assignment_leave_closed ON public.assignments;
CREATE TRIGGER trg_assignment_leave_closed
  BEFORE UPDATE OR DELETE ON public.assignments
  FOR EACH ROW EXECUTE FUNCTION public.check_assignment_leave_closed();


-- ════════════════════════════════════════════════════════════
-- 4. 검증 쿼리
-- ════════════════════════════════════════════════════════════

-- 트리거 등록 확인
SELECT tgname, tgrelid::regclass AS table_name, tgenabled
FROM   pg_trigger
WHERE  tgname IN (
  'trg_assignment_leave_closed',
  'trg_assignment_closed_work_item',
  'trg_check_special_leave_assignment'
);

-- 컬럼 확인
SELECT column_name, data_type, column_default, is_nullable
FROM   information_schema.columns
WHERE  table_schema = 'public'
  AND  table_name   = 'assignments'
  AND  column_name  IN ('status', 'daily_hours')
ORDER BY column_name;

-- ── 동작 검증 SQL (Supabase SQL Editor에서 직접 실행) ──────────
--
-- [1] 테스트용 데이터 준비 (실제 person_id로 교체 후 실행)
--
-- DO $$
-- DECLARE
--   v_pid uuid := '<실제_person_id>';  -- 교체 필요
--   v_id  uuid;
-- BEGIN
--
--   -- [A] open 배정 생성
--   INSERT INTO public.assignments
--     (person_id, kind, leave_type, start, end_date, status)
--   VALUES (v_pid, 'leave', '지정휴가', '2026-09-01', '2026-09-03', 'open')
--   RETURNING id INTO v_id;
--   RAISE NOTICE 'created open assignment: %', v_id;
--
--   -- [B] open → closed 전환 (성공 기대)
--   UPDATE public.assignments SET status = 'closed' WHERE id = v_id;
--   RAISE NOTICE '[B] open→closed OK';
--
--   -- [C] closed 배정 기간 UPDATE 시도 (거부 기대)
--   BEGIN
--     UPDATE public.assignments SET end_date = '2026-09-10' WHERE id = v_id;
--     RAISE EXCEPTION '[C] FAIL: 거부했어야 하는데 통과됨';
--   EXCEPTION WHEN OTHERS THEN
--     RAISE NOTICE '[C] closed 편집 거부 OK: %', SQLERRM;
--   END;
--
--   -- [D] closed 배정 DELETE 시도 (거부 기대)
--   BEGIN
--     DELETE FROM public.assignments WHERE id = v_id;
--     RAISE EXCEPTION '[D] FAIL: 거부했어야 하는데 통과됨';
--   EXCEPTION WHEN OTHERS THEN
--     RAISE NOTICE '[D] closed DELETE 거부 OK: %', SQLERRM;
--   END;
--
--   -- [E] closed → open 전환 (성공 기대; 다른 컬럼은 그대로)
--   UPDATE public.assignments
--     SET status = 'open', end_date = '2026-09-10'  -- end_date는 복원되어야 함
--   WHERE id = v_id;
--   RAISE NOTICE '[E] closed→open OK';
--
--   -- end_date 복원 확인: 여전히 2026-09-03이어야 함
--   DECLARE v_end date;
--   BEGIN
--     SELECT end_date INTO v_end FROM public.assignments WHERE id = v_id;
--     IF v_end::text <> '2026-09-03' THEN
--       RAISE EXCEPTION '[E] FAIL: end_date 복원 실패 (got %)', v_end;
--     END IF;
--     RAISE NOTICE '[E] end_date 복원 확인 OK (still 2026-09-03)';
--   END;
--
--   -- [F] open 상태에서 기간 UPDATE (성공 기대)
--   UPDATE public.assignments SET end_date = '2026-09-05' WHERE id = v_id;
--   RAISE NOTICE '[F] open 상태 편집 OK';
--
--   -- 정리
--   DELETE FROM public.assignments WHERE id = v_id;
--   RAISE NOTICE 'cleanup done';
--
-- END $$;

SELECT 'migration 0033 (PRD v2.88 assignment status lock) done' AS result;
