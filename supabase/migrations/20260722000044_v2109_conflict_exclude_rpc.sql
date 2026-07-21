-- =============================================================
-- Migration 0044: PRD v2.109 §E-3b — 충돌 제외 배정 생성 RPC
-- =============================================================
-- 실행 순서: 0043 이후
-- 멱등 보장: CREATE OR REPLACE FUNCTION
--
-- 배경: E-3a(0022)는 Partner 외 직급의 겹침을 즉시 하드 차단한다. v2.109는
-- 차단 전에 "충돌 구간 제외 후 배정" 대안을 제시하는 UX를 추가하는데, 그
-- 대안을 실행할 때 클라이언트가 계산한 분할 구간을 그대로 믿고 저장하면
-- 동시 편집 사이에 새로 생긴 충돌을 놓칠 수 있다. 이 RPC는 호출 시점의
-- 최신 assignments 데이터로 겹침을 다시 계산하고, 요청 구간에서 겹침
-- 구간을 뺀 나머지를 연속 구간별로 나눠 각각 별도 레코드로 INSERT한다.
--
-- 겹침 하드 차단(E-3a 트리거)은 그대로 유지 — 각 INSERT마다 트리거가
-- 재검증하므로, 이 함수의 스냅숏 계산과 실제 INSERT 사이에 새로운 겹침이
-- 끼어들면(Partner 외 직급) 트리거가 여전히 막고 전체 트랜잭션이 롤백된다.
-- =============================================================

CREATE OR REPLACE FUNCTION public.create_assignment_excluding_conflicts(
  p_person_id     uuid,
  p_kind          text,
  p_work_item_id  uuid,
  p_leave_type    text,
  p_start         date,
  p_end_date      date,
  p_weekend_dates date[],
  p_note          text,
  p_daily_hours   numeric
)
RETURNS SETOF public.assignments
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row       record;
  v_starts    date[] := ARRAY[]::date[];
  v_ends      date[] := ARRAY[]::date[];
  v_cur_s     date;
  v_cur_e     date;
  v_has_cur   boolean := false;
  v_gap_start date;
  v_created   public.assignments%ROWTYPE;
  v_any       boolean := false;
  i           int;
BEGIN
  -- ── 권한 검사 (assignments_insert RLS 정책과 동일 기준) ──
  IF my_role() NOT IN ('editor', 'admin') THEN
    RAISE EXCEPTION 'FORBIDDEN'
      USING MESSAGE = '배정 생성 권한이 없습니다.';
  END IF;

  IF p_start IS NULL OR p_end_date IS NULL OR p_start > p_end_date THEN
    RAISE EXCEPTION 'INVALID_RANGE'
      USING MESSAGE = '날짜 범위가 유효하지 않습니다.';
  END IF;

  -- ── 1) 이 시점 최신 데이터로 겹치는 배정 구간을 조회·병합 ──
  FOR v_row IN
    SELECT start, end_date FROM public.assignments
     WHERE person_id = p_person_id
       AND start     <= p_end_date
       AND end_date  >= p_start
     ORDER BY start
  LOOP
    IF NOT v_has_cur THEN
      v_cur_s := v_row.start; v_cur_e := v_row.end_date; v_has_cur := true;
    ELSIF v_row.start <= v_cur_e + 1 THEN
      IF v_row.end_date > v_cur_e THEN v_cur_e := v_row.end_date; END IF;
    ELSE
      v_starts := array_append(v_starts, v_cur_s);
      v_ends   := array_append(v_ends,   v_cur_e);
      v_cur_s := v_row.start; v_cur_e := v_row.end_date;
    END IF;
  END LOOP;
  IF v_has_cur THEN
    v_starts := array_append(v_starts, v_cur_s);
    v_ends   := array_append(v_ends,   v_cur_e);
  END IF;

  -- ── 2) 요청 구간에서 병합된 겹침 구간을 뺀 나머지(gap)마다 별도 INSERT ──
  v_gap_start := p_start;
  FOR i IN 1 .. COALESCE(array_length(v_starts, 1), 0) LOOP
    IF v_starts[i] > v_gap_start THEN
      INSERT INTO public.assignments (
        person_id, kind, work_item_id, leave_type, start, end_date,
        weekend_dates, note, daily_hours
      ) VALUES (
        p_person_id, p_kind, p_work_item_id, p_leave_type,
        v_gap_start, v_starts[i] - 1,
        COALESCE(
          (SELECT array_agg(d) FROM unnest(p_weekend_dates) d
            WHERE d BETWEEN v_gap_start AND v_starts[i] - 1),
          ARRAY[]::date[]
        ),
        p_note, p_daily_hours
      ) RETURNING * INTO v_created;
      v_any := true;
      RETURN NEXT v_created;
    END IF;
    IF v_ends[i] + 1 > v_gap_start THEN
      v_gap_start := v_ends[i] + 1;
    END IF;
  END LOOP;

  IF v_gap_start <= p_end_date THEN
    INSERT INTO public.assignments (
      person_id, kind, work_item_id, leave_type, start, end_date,
      weekend_dates, note, daily_hours
    ) VALUES (
      p_person_id, p_kind, p_work_item_id, p_leave_type,
      v_gap_start, p_end_date,
      COALESCE(
        (SELECT array_agg(d) FROM unnest(p_weekend_dates) d
          WHERE d BETWEEN v_gap_start AND p_end_date),
        ARRAY[]::date[]
      ),
      p_note, p_daily_hours
    ) RETURNING * INTO v_created;
    v_any := true;
    RETURN NEXT v_created;
  END IF;

  IF NOT v_any THEN
    RAISE EXCEPTION 'NO_REMAINING_RANGE'
      USING MESSAGE = '요청한 기간 전체가 기존 배정과 겹쳐 생성할 구간이 없습니다.';
  END IF;

  RETURN;
END;
$$;

COMMENT ON FUNCTION public.create_assignment_excluding_conflicts(
  uuid, text, uuid, text, date, date, date[], text, numeric
) IS
  'PRD v2.109 E-3b: 겹침 구간을 서버가 최신 데이터로 재계산해 제외한 뒤, 남은 연속 구간마다 별도 assignments 레코드를 생성한다. editor/admin만 실행 가능(FORBIDDEN). 겹침이 전 구간을 덮으면 NO_REMAINING_RANGE.';

-- PostgREST 스키마 캐시 강제 갱신
NOTIFY pgrst, 'reload schema';

SELECT proname, prosecdef
  FROM pg_proc
 WHERE proname = 'create_assignment_excluding_conflicts'
   AND pronamespace = 'public'::regnamespace;

SELECT 'migration 0044 (PRD v2.109 E-3b conflict-exclude RPC) done' AS result;
