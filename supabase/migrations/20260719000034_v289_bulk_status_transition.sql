-- =============================================================
-- Migration 0034: PRD v2.89 — 일괄 상태 전환 RPC (Bulk Status Transition)
-- =============================================================
-- 실행 순서: 0033 이후
-- 멱등 보장: CREATE OR REPLACE FUNCTION
--
-- 변경 요약:
--   1. bulk_status_preview(p_from, p_to, p_targets, p_direction)
--      - admin 전용 (is_admin() 체크, SECURITY DEFINER)
--      - 변경 없이 대상 건수만 집계 반환 (미리보기 전용)
--
--   2. bulk_status_transition(p_from, p_to, p_targets, p_direction)
--      - admin 전용 (is_admin() 체크, SECURITY DEFINER)
--      - end_date가 범위 내인 대상의 status를 일괄 전환
--      - 기존 트리거와 충돌 없음:
--        · open→closed: check_work_item_closed_update / check_assignment_leave_closed
--          는 OLD.status='closed'일 때만 개입 → open 출발은 통과
--        · closed→open: 양 트리거 모두 허용 (복원 로직은 status만 변경이면 무해)
--      - audit_log 기록 (SECURITY DEFINER 내부 → RLS 우회)
--      - 단일 트랜잭션: 실패 시 전체 롤백
--
-- 보안: SECURITY DEFINER — 서버에서 admin 권한 재검증, 클라이언트 우회 불가
-- =============================================================


-- ════════════════════════════════════════════════════════════
-- 1. bulk_status_preview — 미리보기 (읽기 전용)
-- ════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.bulk_status_preview(
  p_from      date,          -- 범위 시작 (inclusive)
  p_to        date,          -- 범위 종료 (inclusive), end_date 기준
  p_targets   text[],        -- {'work_items'} · {'leave_assignments'} · 둘 다
  p_direction text           -- 'close' | 'open'
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
    RAISE EXCEPTION 'FORBIDDEN'
      USING MESSAGE = 'bulk_status_preview는 admin 역할만 실행할 수 있습니다.';
  END IF;

  -- ── 입력 검증 ─────────────────────────────────────────────
  IF p_direction NOT IN ('close', 'open') THEN
    RAISE EXCEPTION 'INVALID_DIRECTION'
      USING MESSAGE = 'p_direction은 ''close'' 또는 ''open'' 이어야 합니다.';
  END IF;

  IF p_from IS NULL OR p_to IS NULL OR p_from > p_to THEN
    RAISE EXCEPTION 'INVALID_RANGE'
      USING MESSAGE = '날짜 범위가 유효하지 않습니다. from <= to 이어야 합니다.';
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
  'PRD v2.89: admin-only preview. Returns affected row counts without making changes.';


-- ════════════════════════════════════════════════════════════
-- 2. bulk_status_transition — 실행 (단일 트랜잭션)
-- ════════════════════════════════════════════════════════════

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
    RAISE EXCEPTION 'FORBIDDEN'
      USING MESSAGE = 'bulk_status_transition는 admin 역할만 실행할 수 있습니다.';
  END IF;

  -- ── 입력 검증 ─────────────────────────────────────────────
  IF p_direction NOT IN ('close', 'open') THEN
    RAISE EXCEPTION 'INVALID_DIRECTION'
      USING MESSAGE = 'p_direction은 ''close'' 또는 ''open'' 이어야 합니다.';
  END IF;

  IF p_from IS NULL OR p_to IS NULL OR p_from > p_to THEN
    RAISE EXCEPTION 'INVALID_RANGE'
      USING MESSAGE = '날짜 범위가 유효하지 않습니다.';
  END IF;

  IF p_targets IS NULL OR array_length(p_targets, 1) IS NULL THEN
    RAISE EXCEPTION 'NO_TARGETS'
      USING MESSAGE = '대상 유형이 선택되지 않았습니다.';
  END IF;

  v_target_st := CASE p_direction WHEN 'close' THEN 'closed' ELSE 'open' END;

  -- ── 상태 전환 ─────────────────────────────────────────────
  -- work_items: open→closed 는 check_work_item_closed_update 트리거 통과
  --             (OLD.status != 'closed' 인 경우만 업데이트하므로 트리거는 미개입)
  -- closed→open 은 트리거가 허용 (status→'open' 경로)
  IF 'work_items' = ANY(p_targets) THEN
    UPDATE public.work_items
       SET status = v_target_st
     WHERE end_date BETWEEN p_from AND p_to
       AND (status IS DISTINCT FROM v_target_st);
    GET DIAGNOSTICS v_wi_updated = ROW_COUNT;
  END IF;

  -- assignments(kind='leave'): check_assignment_leave_closed 트리거와 동일 분석
  IF 'leave_assignments' = ANY(p_targets) THEN
    UPDATE public.assignments
       SET status = v_target_st
     WHERE kind = 'leave'
       AND end_date BETWEEN p_from AND p_to
       AND (status IS DISTINCT FROM v_target_st);
    GET DIAGNOSTICS v_la_updated = ROW_COUNT;
  END IF;

  -- ── audit_log 기록 ────────────────────────────────────────
  -- SECURITY DEFINER 내부 실행이므로 audit_log RLS(WITH CHECK false)를 우회
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
  'PRD v2.89: admin-only bulk status transition. Single transaction; logs to audit_log.';


-- ════════════════════════════════════════════════════════════
-- 검증 쿼리
-- ════════════════════════════════════════════════════════════

-- PostgREST 스키마 캐시 강제 갱신 (함수 생성 직후 인식되도록)
NOTIFY pgrst, 'reload schema';

SELECT proname, prosecdef, provolatile
  FROM pg_proc
 WHERE proname IN ('bulk_status_preview', 'bulk_status_transition')
   AND pronamespace = 'public'::regnamespace;

SELECT 'migration 0034 (PRD v2.89 bulk status transition) done' AS result;
