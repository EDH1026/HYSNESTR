-- PRD v2.21 §5.10 LV-6 서버 강제 (assignments 테이블)
--
-- 변경 요약
--   1. 특별휴가 leave assignment 생성·수정 시 잔여 검증 트리거
--      kind='leave' AND leave_type='특별휴가' 인 INSERT/UPDATE 에 대해
--      accruals 잔여(적립−사용) < 요청 영업일 수 이면 EXCEPTION 을 발생시킨다.
--      → v2.20 migration(20260709000020)은 accruals 테이블을 보호하고,
--        이 migration은 assignments 테이블을 보호해 모든 진입 경로를 차단한다.

-- ════════════════════════════════════════════════════════════
-- 1. 특별휴가 assignments 잔여 검증 함수
-- ════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.check_special_leave_assignment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_accrual_balance numeric;
  v_used_days       numeric := 0;
  v_req_days        numeric;
  v_rec             RECORD;
BEGIN
  IF NEW.kind <> 'leave' OR NEW.leave_type <> '특별휴가' THEN
    RETURN NEW;
  END IF;

  -- 특별휴가 적립 잔여 (accruals 테이블 기준)
  SELECT COALESCE(SUM(
    CASE WHEN direction = 'accrual' THEN days ELSE -days END
  ), 0)
  INTO v_accrual_balance
  FROM public.accruals
  WHERE person_id = NEW.person_id
    AND type      = '특별휴가';

  -- 기존 특별휴가 assignments 사용 영업일 합산 (주말 제외, 이 행 제외)
  FOR v_rec IN
    SELECT start::date AS s, end_date::date AS e
    FROM public.assignments
    WHERE person_id  = NEW.person_id
      AND kind       = 'leave'
      AND leave_type = '특별휴가'
      AND (TG_OP = 'INSERT' OR id <> NEW.id)
  LOOP
    SELECT v_used_days + COUNT(*)
    INTO   v_used_days
    FROM generate_series(v_rec.s, v_rec.e, '1 day'::interval) d(day)
    WHERE EXTRACT(DOW FROM d.day) NOT IN (0, 6);
  END LOOP;

  -- 이번 요청 영업일 수
  SELECT COUNT(*)
  INTO   v_req_days
  FROM generate_series(NEW.start::date, NEW.end_date::date, '1 day'::interval) d(day)
  WHERE EXTRACT(DOW FROM d.day) NOT IN (0, 6);

  IF v_accrual_balance < v_used_days + v_req_days THEN
    RAISE EXCEPTION '특별휴가 잔여가 부족합니다 (잔여: %, 요청: %일)',
      (v_accrual_balance - v_used_days), v_req_days
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_check_special_leave_assignment ON public.assignments;

CREATE TRIGGER trg_check_special_leave_assignment
  BEFORE INSERT OR UPDATE ON public.assignments
  FOR EACH ROW
  EXECUTE FUNCTION public.check_special_leave_assignment();
