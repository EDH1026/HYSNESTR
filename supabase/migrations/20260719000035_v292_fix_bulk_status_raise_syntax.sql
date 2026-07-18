-- =============================================================
-- Migration 0035: PRD v2.92 ADM-9⑦ — bulk_status_* RAISE 문법 오류 수정
-- =============================================================
-- 실행 순서: 0034 이후
-- 멱등 보장: CREATE OR REPLACE FUNCTION
--
-- 버그: 0034에서 정의한 두 함수 모두
--   RAISE EXCEPTION 'CODE' USING MESSAGE = '...'
-- 형태를 썼는데, PL/pgSQL에서는 RAISE EXCEPTION 뒤에 오는 문자열 리터럴
-- 자체가 이미 MESSAGE 옵션을 지정하는 것이라 USING MESSAGE = ... 를
-- 추가로 쓰면 "RAISE option already specified: MESSAGE" (SQLSTATE 42601)
-- 문법 오류가 난다. is_admin() 체크(권한 없음)나 잘못된 인자로 호출될
-- 때마다(즉 정상 admin·정상 인자 경로 밖 전부) 이 오류가 발생해
-- "FORBIDDEN"/"INVALID_..." 같은 의도된 에러 대신 문법 오류가 노출된다.
--
-- 조치: 코드 접두어를 message 문자열 안에 포함한 단일 포맷 문자열로
-- 통일한다(USING MESSAGE 절 제거). 시그니처·로직·권한 검사는 그대로.
-- =============================================================

CREATE OR REPLACE FUNCTION public.bulk_status_preview(
  p_from      date,
  p_to        date,
  p_targets   text[],
  p_direction text
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_wi_count  int := 0;
  v_la_count  int := 0;
  v_target_st text;
BEGIN
  -- ── 권한 검사 ────────────────────────────────────────────
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'FORBIDDEN: bulk_status_preview는 admin 역할만 실행할 수 있습니다.';
  END IF;

  -- ── 입력 검증 ─────────────────────────────────────────────
  IF p_direction NOT IN ('close', 'open') THEN
    RAISE EXCEPTION 'INVALID_DIRECTION: p_direction은 ''close'' 또는 ''open'' 이어야 합니다.';
  END IF;

  IF p_from IS NULL OR p_to IS NULL OR p_from > p_to THEN
    RAISE EXCEPTION 'INVALID_RANGE: 날짜 범위가 유효하지 않습니다. from <= to 이어야 합니다.';
  END IF;

  v_target_st := CASE p_direction WHEN 'close' THEN 'closed' ELSE 'open' END;

  -- ── 집계 (변경 없음) ──────────────────────────────────────
  IF 'work_items' = ANY(p_targets) THEN
    SELECT COUNT(*) INTO v_wi_count
      FROM public.work_items
     WHERE end_date BETWEEN p_from AND p_to
       AND (status IS DISTINCT FROM v_target_st);
  END IF;

  IF 'leave_assignments' = ANY(p_targets) THEN
    SELECT COUNT(*) INTO v_la_count
      FROM public.assignments
     WHERE kind = 'leave'
       AND end_date BETWEEN p_from AND p_to
       AND (status IS DISTINCT FROM v_target_st);
  END IF;

  RETURN jsonb_build_object(
    'work_items',        v_wi_count,
    'leave_assignments', v_la_count,
    'direction',         p_direction,
    'from',              p_from,
    'to',                p_to
  );
END;
$$;

COMMENT ON FUNCTION public.bulk_status_preview(date, date, text[], text) IS
  'PRD v2.89: admin-only preview. Returns affected row counts without making changes. (v2.92: fixed RAISE syntax)';


CREATE OR REPLACE FUNCTION public.bulk_status_transition(
  p_from      date,
  p_to        date,
  p_targets   text[],
  p_direction text
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_wi_updated int := 0;
  v_la_updated int := 0;
  v_target_st  text;
BEGIN
  -- ── 권한 검사 ────────────────────────────────────────────
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'FORBIDDEN: bulk_status_transition는 admin 역할만 실행할 수 있습니다.';
  END IF;

  -- ── 입력 검증 ─────────────────────────────────────────────
  IF p_direction NOT IN ('close', 'open') THEN
    RAISE EXCEPTION 'INVALID_DIRECTION: p_direction은 ''close'' 또는 ''open'' 이어야 합니다.';
  END IF;

  IF p_from IS NULL OR p_to IS NULL OR p_from > p_to THEN
    RAISE EXCEPTION 'INVALID_RANGE: 날짜 범위가 유효하지 않습니다.';
  END IF;

  IF p_targets IS NULL OR array_length(p_targets, 1) IS NULL THEN
    RAISE EXCEPTION 'NO_TARGETS: 대상 유형이 선택되지 않았습니다.';
  END IF;

  v_target_st := CASE p_direction WHEN 'close' THEN 'closed' ELSE 'open' END;

  -- ── 상태 전환 ─────────────────────────────────────────────
  IF 'work_items' = ANY(p_targets) THEN
    UPDATE public.work_items
       SET status = v_target_st
     WHERE end_date BETWEEN p_from AND p_to
       AND (status IS DISTINCT FROM v_target_st);
    GET DIAGNOSTICS v_wi_updated = ROW_COUNT;
  END IF;

  IF 'leave_assignments' = ANY(p_targets) THEN
    UPDATE public.assignments
       SET status = v_target_st
     WHERE kind = 'leave'
       AND end_date BETWEEN p_from AND p_to
       AND (status IS DISTINCT FROM v_target_st);
    GET DIAGNOSTICS v_la_updated = ROW_COUNT;
  END IF;

  -- ── audit_log 기록 ────────────────────────────────────────
  INSERT INTO public.audit_log (user_id, action, target_type, target_id)
  VALUES (
    auth.uid(),
    'bulk_status_transition:' || p_direction
      || ' range=' || p_from::text || '~' || p_to::text
      || ' work_items=' || v_wi_updated
      || ' leave_assignments=' || v_la_updated,
    'bulk_status',
    NULL
  );

  RETURN jsonb_build_object(
    'work_items',        v_wi_updated,
    'leave_assignments', v_la_updated,
    'direction',         p_direction
  );
END;
$$;

COMMENT ON FUNCTION public.bulk_status_transition(date, date, text[], text) IS
  'PRD v2.89: admin-only bulk status transition. Single transaction; logs to audit_log. (v2.92: fixed RAISE syntax)';


-- ════════════════════════════════════════════════════════════
-- 검증
-- ════════════════════════════════════════════════════════════

NOTIFY pgrst, 'reload schema';

SELECT proname, prosecdef, provolatile
  FROM pg_proc
 WHERE proname IN ('bulk_status_preview', 'bulk_status_transition')
   AND pronamespace = 'public'::regnamespace;

SELECT 'migration 0035 (v2.92 fix bulk_status RAISE syntax) done' AS result;
