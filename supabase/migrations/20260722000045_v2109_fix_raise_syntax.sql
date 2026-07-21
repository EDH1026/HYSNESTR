-- =============================================================
-- Migration 0045: PRD v2.109 E-3b 정정 — RAISE EXCEPTION 구문 오류 수정
-- =============================================================
-- 실행 순서: 0044 이후
--
-- 0044의 create_assignment_excluding_conflicts()가 세 곳에서
-- `RAISE EXCEPTION 'CODE' USING MESSAGE = ...` 구문을 써서 SQLSTATE 42601
-- ("RAISE option already specified: MESSAGE")로 항상 실패했다(v2.92 ADM-9,
-- v2.104 T-23에서 이미 겪은 것과 동일한 오류 패턴 — RAISE EXCEPTION 뒤의 문자열
-- 리터럴 자체가 이미 MESSAGE를 지정하므로 USING MESSAGE를 추가로 쓰면 충돌한다).
-- 단일 포맷 문자열로 통일해 수정한다.
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
    RAISE EXCEPTION 'FORBIDDEN: 배정 생성 권한이 없습니다.';
  END IF;

  IF p_start IS NULL OR p_end_date IS NULL OR p_start > p_end_date THEN
    RAISE EXCEPTION 'INVALID_RANGE: 날짜 범위가 유효하지 않습니다.';
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
    RAISE EXCEPTION 'NO_REMAINING_RANGE: 요청한 기간 전체가 기존 배정과 겹쳐 생성할 구간이 없습니다.';
  END IF;

  RETURN;
END;
$$;

NOTIFY pgrst, 'reload schema';

SELECT 'migration 0045 (PRD v2.109 E-3b RAISE syntax fix) done' AS result;
