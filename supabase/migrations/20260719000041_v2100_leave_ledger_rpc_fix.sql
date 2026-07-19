-- =============================================================
-- Migration 0041: PRD v2.100 LV-17 정정 — get_leave_ledger_data() work_items 누락 보강
-- =============================================================
-- 실행 순서: 0040 이후
-- 멱등 보장: CREATE OR REPLACE
--
-- 0040의 work_items 서브쿼리는 assignments.work_item_id로 참조되는 work_item만
-- 모았다. 하지만 클라이언트(LeavePanel.tsx의 wiMap)는 수동 적립(accruals.source,
-- work_item_id를 가리키는 선택적 참조)의 출처 표시에도 같은 work_items 맵을
-- 쓰므로, accruals.source가 가리키지만 그 인력의 assignments에는 없는
-- work_item이 있으면 출처 이름이 누락된다. accruals.source 참조도 함께 포함한다.
-- =============================================================

CREATE OR REPLACE FUNCTION public.get_leave_ledger_data(p_person_ids uuid[] DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role       text := my_role();
  v_my_person  uuid := my_person_id();
  v_ids        uuid[];
BEGIN
  IF v_role IS NULL THEN
    RAISE EXCEPTION 'FORBIDDEN: 로그인이 필요합니다.';
  END IF;

  IF v_role IN ('admin', 'editor', 'assistant') THEN
    v_ids := p_person_ids;
  ELSE
    IF v_my_person IS NULL THEN
      RAISE EXCEPTION 'FORBIDDEN: 연결된 인력 정보가 없습니다.';
    END IF;
    IF p_person_ids IS NOT NULL AND NOT (p_person_ids <@ ARRAY[v_my_person]) THEN
      RAISE EXCEPTION 'FORBIDDEN: 본인 정보만 조회할 수 있습니다.';
    END IF;
    v_ids := ARRAY[v_my_person];
  END IF;

  RETURN jsonb_build_object(
    'assignments', COALESCE((
      SELECT jsonb_agg(to_jsonb(a))
        FROM public.assignments a
       WHERE v_ids IS NULL OR a.person_id = ANY(v_ids)
    ), '[]'::jsonb),

    'accruals', COALESCE((
      SELECT jsonb_agg(to_jsonb(c))
        FROM public.accruals c
       WHERE v_ids IS NULL OR c.person_id = ANY(v_ids)
    ), '[]'::jsonb),

    -- assignments.work_item_id + accruals.source(수동 적립 출처) 양쪽이 참조하는
    -- work_item을 모두 포함한다(role 무관 전체 — 파이프라인도 포함).
    'work_items', COALESCE((
      SELECT jsonb_agg(to_jsonb(w))
        FROM public.work_items w
       WHERE w.id IN (
         SELECT DISTINCT work_item_id
           FROM public.assignments
          WHERE work_item_id IS NOT NULL
            AND (v_ids IS NULL OR person_id = ANY(v_ids))
         UNION
         SELECT DISTINCT source
           FROM public.accruals
          WHERE source IS NOT NULL
            AND (v_ids IS NULL OR person_id = ANY(v_ids))
       )
    ), '[]'::jsonb)
  );
END;
$$;

NOTIFY pgrst, 'reload schema';

SELECT 'migration 0041 (v2.100 LV-17 rpc work_items fix) done' AS result;
