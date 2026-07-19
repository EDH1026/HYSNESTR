-- =============================================================
-- Migration 0036: PRD v2.93 LV-16 / ADM-9⑧ — 특별휴가 검증 오발동 수정
-- =============================================================
-- 실행 순서: 0035 이후
-- 멱등 보장: CREATE OR REPLACE FUNCTION, DROP TRIGGER IF EXISTS
--
-- 증상: bulk_status_transition의 "Closed로 잠금" (assignments.status만
--   바꾸는 UPDATE)에서 "특별휴가 잔여가 부족합니다" 에러로 실패. 그런데
--   Leave Ledger에는 특별휴가를 초과 사용한 사람이 없다.
--
-- 원인 1 (오발동): trg_check_special_leave_assignment
--   (20260709000021_v221_assignment_leave_check.sql)가 WHEN 조건 없이
--   BEFORE INSERT OR UPDATE에 걸려 있어, status만 바뀌는 UPDATE에도
--   무조건 재검증이 돈다. 검증 자체는 그 행의 start/end_date/leave_type
--   등 "사용량에 영향을 주는" 값이 바뀌지 않았는데도 다시 실행된다.
--
-- 원인 2 (Ledger와 잔여 불일치): 이 트리거의 사용일수 계산이
--   `EXTRACT(DOW FROM d.day) NOT IN (0,6)` 로 주말만 제외하고
--   **공휴일(holidays 테이블)은 전혀 제외하지 않는다** — 반면 클라이언트
--   Ledger/validateLeave.computeSpecialLeaveBalance는 workdayCount()로
--   주말 *및* 공휴일을 모두 제외한다. 사용 구간에 공휴일이 하루라도
--   끼어 있으면 트리거의 "사용일수"가 Ledger보다 1일 더 많게 계산되어
--   "잔여 4.0/요청 5" 처럼 실제로는 없는 부족이 나타난다. 자기 자신
--   이중차감(자기 행을 사용량에서 빼는 로직)은 트리거·클라이언트 모두
--   이미 동일하게(TG_OP='INSERT' OR id<>NEW.id / excludeId) 처리하고
--   있어 그 부분은 버그가 아니었음을 대조 확인했다.
--
-- 조치:
--   1. count_workdays(start,end) — 주말+공휴일(recurring 포함) 제외
--      영업일 수를 계산하는 공용 함수 신설(클라이언트 workdayCount와
--      동일 시맨틱).
--   2. compute_special_leave_balance(person_id, exclude_id) — 적립 합
--      - Σ(자기 자신을 뺀 특별휴가 assignments의 count_workdays) 로
--      잔여를 계산하는 공용 함수 신설. 트리거·Ledger 양쪽이 같은
--      영업일 계산 규칙을 쓰도록 통일한다.
--   3. check_special_leave_assignment() 트리거 함수가 이 두 공용
--      함수를 사용하도록 재정의.
--   4. 트리거를 INSERT용/UPDATE용으로 분리하고, UPDATE 쪽에만 WHEN
--      조건을 걸어 start/end_date/leave_type/kind/person_id 중 하나라도
--      바뀐 경우에만 재검증한다(status/note만 바뀐 UPDATE는 스킵).
-- =============================================================


-- ════════════════════════════════════════════════════════════
-- 1. count_workdays — 주말+공휴일 제외 영업일 수 (공용, LV-8과 동일 규칙)
-- ════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.is_holiday_date(p_day date)
RETURNS boolean
LANGUAGE sql STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.holidays h
    WHERE (h.recurring = false AND h.date = p_day)
       OR (h.recurring = true
           AND EXTRACT(MONTH FROM h.date) = EXTRACT(MONTH FROM p_day)
           AND EXTRACT(DAY   FROM h.date) = EXTRACT(DAY   FROM p_day))
  );
$$;

COMMENT ON FUNCTION public.is_holiday_date(date) IS
  'PRD v2.93: p_day가 holidays 테이블 기준 공휴일인지(recurring 매년 반복 포함) 판정.';

CREATE OR REPLACE FUNCTION public.count_workdays(p_start date, p_end date)
RETURNS int
LANGUAGE sql STABLE
AS $$
  SELECT COUNT(*)::int
  FROM generate_series(p_start, p_end, '1 day'::interval) d(day)
  WHERE EXTRACT(DOW FROM d.day) NOT IN (0, 6)   -- 0=Sun, 6=Sat
    AND NOT public.is_holiday_date(d.day::date);
$$;

COMMENT ON FUNCTION public.count_workdays(date, date) IS
  'PRD v2.93: [p_start,p_end] 구간의 영업일 수(주말+공휴일 제외) — 클라이언트 workdayCount()와 동일 규칙.';


-- ════════════════════════════════════════════════════════════
-- 2. compute_special_leave_balance — Ledger·검증 공용 잔여 계산
-- ════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.compute_special_leave_balance(
  p_person_id  uuid,
  p_exclude_id uuid DEFAULT NULL
)
RETURNS numeric
LANGUAGE plpgsql STABLE
AS $$
DECLARE
  v_accrual_balance numeric;
  v_used_days       numeric := 0;
  v_rec             RECORD;
BEGIN
  SELECT COALESCE(SUM(
    CASE WHEN direction = 'accrual' THEN days ELSE -days END
  ), 0)
  INTO v_accrual_balance
  FROM public.accruals
  WHERE person_id = p_person_id
    AND type      = '특별휴가';

  FOR v_rec IN
    SELECT start::date AS s, end_date::date AS e
    FROM public.assignments
    WHERE person_id  = p_person_id
      AND kind       = 'leave'
      AND leave_type = '특별휴가'
      AND (p_exclude_id IS NULL OR id <> p_exclude_id)
  LOOP
    v_used_days := v_used_days + public.count_workdays(v_rec.s, v_rec.e);
  END LOOP;

  RETURN v_accrual_balance - v_used_days;
END;
$$;

COMMENT ON FUNCTION public.compute_special_leave_balance(uuid, uuid) IS
  'PRD v2.93 LV-16: 특별휴가 잔여 = 적립합 - Σ(본인 제외 기존 특별휴가 assignments의 영업일). '
  'p_exclude_id는 검증 대상 행 자신(UPDATE 시 자기 이중차감 방지) — client validateLeave.computeSpecialLeaveBalance와 동일 규칙.';


-- ════════════════════════════════════════════════════════════
-- 3. check_special_leave_assignment() — 공용 함수 사용하도록 재정의
-- ════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.check_special_leave_assignment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_balance  numeric;
  v_req_days int;
BEGIN
  IF NEW.kind <> 'leave' OR NEW.leave_type <> '특별휴가' THEN
    RETURN NEW;
  END IF;

  v_balance := public.compute_special_leave_balance(
    NEW.person_id,
    CASE WHEN TG_OP = 'UPDATE' THEN NEW.id ELSE NULL END
  );
  v_req_days := public.count_workdays(NEW.start::date, NEW.end_date::date);

  IF v_balance < v_req_days THEN
    RAISE EXCEPTION '특별휴가 잔여가 부족합니다 (잔여: %, 요청: %일)',
      v_balance, v_req_days
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;


-- ════════════════════════════════════════════════════════════
-- 4. 트리거 분리 — status-only UPDATE는 스킵
-- ════════════════════════════════════════════════════════════

DROP TRIGGER IF EXISTS trg_check_special_leave_assignment ON public.assignments;

-- INSERT: 특별휴가 신규 생성은 항상 검증
CREATE TRIGGER trg_check_special_leave_assignment_ins
  BEFORE INSERT ON public.assignments
  FOR EACH ROW
  WHEN (NEW.kind = 'leave' AND NEW.leave_type = '특별휴가')
  EXECUTE FUNCTION public.check_special_leave_assignment();

-- UPDATE: 사용량에 영향을 주는 컬럼이 실제로 바뀔 때만 검증
-- (status/note 등만 바뀌는 bulk_status_transition류 UPDATE는 스킵)
CREATE TRIGGER trg_check_special_leave_assignment_upd
  BEFORE UPDATE ON public.assignments
  FOR EACH ROW
  WHEN (
    NEW.kind = 'leave' AND NEW.leave_type = '특별휴가' AND (
      OLD.start        IS DISTINCT FROM NEW.start OR
      OLD.end_date      IS DISTINCT FROM NEW.end_date OR
      OLD.leave_type    IS DISTINCT FROM NEW.leave_type OR
      OLD.kind          IS DISTINCT FROM NEW.kind OR
      OLD.person_id     IS DISTINCT FROM NEW.person_id
    )
  )
  EXECUTE FUNCTION public.check_special_leave_assignment();

COMMENT ON FUNCTION public.check_special_leave_assignment() IS
  'PRD v2.93 LV-16: 특별휴가 잔여 검증. INSERT는 항상, UPDATE는 사용량 관련 컬럼(start/end_date/'
  'leave_type/kind/person_id) 변경 시에만 trg_..._upd의 WHEN 조건으로 걸러 실행(status-only 잠금/해제는 스킵).';


-- ════════════════════════════════════════════════════════════
-- 검증
-- ════════════════════════════════════════════════════════════

NOTIFY pgrst, 'reload schema';

SELECT tgname, tgtype, tgenabled
  FROM pg_trigger
 WHERE tgrelid = 'public.assignments'::regclass
   AND tgname LIKE 'trg_check_special_leave%';

SELECT 'migration 0036 (v2.93 special leave check fix) done' AS result;
