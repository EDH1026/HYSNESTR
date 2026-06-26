-- =============================================================
-- Migration 0017: PRD v2.12 §5.5a / 부록 C — Bulk Upload RPC
-- =============================================================
-- 실행 순서: 0016 이후
-- 멱등 보장: CREATE OR REPLACE FUNCTION
--
-- 변경 요약:
--   1. bulk_upload_work_items(p_mode, p_rows)
--      - p_mode: 'append' | 'replace'
--      - p_rows: jsonb 배열 (각 요소는 work_item 필드)
--      - admin 전용 (is_admin() 체크, SECURITY INVOKER)
--      - 단일 트랜잭션 — 실패 시 전체 롤백
--      - replace 모드: 연결 assignments 포함 전량 삭제 후 삽입
--      - audit_log 기록
-- =============================================================


-- ════════════════════════════════════════════════════════════
-- 1. bulk_upload_work_items
-- ════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.bulk_upload_work_items(
  p_mode text,          -- 'append' | 'replace'
  p_rows jsonb          -- array of work-item objects
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row         jsonb;
  v_inserted    int := 0;
  v_deleted_wi  int := 0;
  v_deleted_as  int := 0;
  v_new_id      uuid;
  v_hashtags    text[];
  v_confidential boolean;
BEGIN
  -- ── 권한 검사 (admin 전용) ─────────────────────────────────
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'FORBIDDEN'
      USING MESSAGE = 'bulk_upload_work_items는 admin 역할만 실행할 수 있습니다.';
  END IF;

  -- ── 모드 검증 ─────────────────────────────────────────────
  IF p_mode NOT IN ('append', 'replace') THEN
    RAISE EXCEPTION 'INVALID_MODE'
      USING MESSAGE = 'p_mode는 ''append'' 또는 ''replace'' 이어야 합니다.';
  END IF;

  -- ── Replace 모드: 기존 데이터 전량 삭제 ───────────────────
  IF p_mode = 'replace' THEN
    -- 연결된 assignments 먼저 삭제 (FK 무결성)
    DELETE FROM public.assignments
     WHERE work_item_id IN (SELECT id FROM public.work_items);
    GET DIAGNOSTICS v_deleted_as = ROW_COUNT;

    DELETE FROM public.work_items;
    GET DIAGNOSTICS v_deleted_wi = ROW_COUNT;
  END IF;

  -- ── 행 삽입 ──────────────────────────────────────────────
  FOR v_row IN SELECT jsonb_array_elements(p_rows)
  LOOP
    -- hashtags: jsonb array → text[]
    IF (v_row->>'hashtags') IS NULL OR (v_row->>'hashtags') = '' THEN
      v_hashtags := '{}';
    ELSE
      SELECT array_agg(trim(x))
        INTO v_hashtags
        FROM unnest(string_to_array(v_row->>'hashtags', ';')) x
       WHERE trim(x) <> '';
    END IF;

    -- confidential: text → boolean
    v_confidential := COALESCE(
      (v_row->>'confidential')::boolean,
      false
    );

    INSERT INTO public.work_items (
      type,
      name,
      engagement_number,
      client,
      start,
      main_start,
      end_date,
      status,
      description,
      hashtags,
      confidential
    ) VALUES (
      v_row->>'type',
      v_row->>'name',
      NULLIF(trim(COALESCE(v_row->>'engagement_number', '')), ''),
      NULLIF(trim(COALESCE(v_row->>'client', '')), ''),
      (v_row->>'start')::date,
      NULLIF(trim(COALESCE(v_row->>'main_start', '')), '')::date,
      (v_row->>'end_date')::date,
      COALESCE(NULLIF(trim(COALESCE(v_row->>'status', '')), ''), 'open'),
      NULLIF(trim(COALESCE(v_row->>'description', '')), ''),
      v_hashtags,
      v_confidential
    )
    RETURNING id INTO v_new_id;

    v_inserted := v_inserted + 1;
  END LOOP;

  -- ── audit_log 기록 ────────────────────────────────────────
  INSERT INTO public.audit_log (user_id, action, target_type, target_id)
  VALUES (
    auth.uid(),
    'bulk_upload:' || p_mode
      || ' inserted=' || v_inserted
      || CASE WHEN p_mode = 'replace'
              THEN ' deleted_wi=' || v_deleted_wi || ' deleted_as=' || v_deleted_as
              ELSE '' END,
    'work_items',
    NULL
  );

  RETURN jsonb_build_object(
    'mode',        p_mode,
    'inserted',    v_inserted,
    'deleted_wi',  v_deleted_wi,
    'deleted_as',  v_deleted_as
  );
END;
$$;

COMMENT ON FUNCTION public.bulk_upload_work_items(text, jsonb) IS
  'PRD v2.12 §5.5a: admin-only bulk insert/replace for work_items. '
  'replace mode deletes all assignments + work_items first. Atomic transaction.';


-- ════════════════════════════════════════════════════════════
-- 검증 쿼리
-- ════════════════════════════════════════════════════════════

SELECT 'migration 0017 (PRD v2.12 bulk upload RPC) done' AS result;
