-- =============================================================
-- Migration 0040: PRD v2.100 LV-17 — 역할 무관 일관된 휴가 원장 데이터 RPC
-- =============================================================
-- 실행 순서: 0039 이후
-- 멱등 보장: CREATE OR REPLACE
--
-- 배경: computeLedger()(순수 함수, src/features/leave/ledger.ts)는 그 자체는
-- role과 무관하지만, 이를 호출하는 화면들이 assignments/accruals/work_items를
-- 클라이언트에서 직접 SELECT해 넘겨준다. 이 세 테이블은 "일반 화면 노출용"으로
-- 설계된 role별 RLS 제한을 갖고 있다:
--   - assignments_select: admin/editor는 전체, 그 외(assistant·viewer)는
--     파이프라인(work_items.type='pipeline')에 연결된 배정을 못 본다.
--   - work_items_select: admin/editor는 전체, 그 외는 파이프라인 행 자체를 못 본다.
--   - accruals_select: admin/editor/assistant는 전체, viewer는 본인 것만.
-- 실제 라이브 데이터로 admin 세션과 viewer(본인) 세션에서 동일 person_id를
-- 조회해 대조한 결과, 파이프라인 연결 배정 1건이 viewer에게는 보이지 않는
-- 비대칭을 확인했다(SQL로 재현). computeLedger 자체는 파이프라인 work_item을
-- 적립 계산에서 이미 제외하므로 이번 케이스는 수치까지 어긋나진 않았지만,
-- "호출자 role에 따라 원장 계산에 쓰이는 원천 데이터 자체가 달라지는" 구조적
-- 결함은 실재하며, 다른 데이터 조합에서는 실제로 수치가 어긋날 수 있다.
--
-- 조치: person_id를 명시적으로 받는 단일 SECURITY DEFINER RPC를 신설한다.
-- 함수 내부에서 호출자 권한을 검증한 뒤(admin/editor/assistant는 임의
-- person_id, viewer는 본인 person_id만), 검증을 통과하면 role별 SELECT
-- 제한을 우회해 그 인력의 전체 원천 데이터를 반환한다 — 같은 대상 인력이면
-- 호출자가 누구든 항상 동일한 데이터로 계산되도록 보장한다.
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
    -- 임의 person_id(들) 조회 가능. NULL이면 "전체"로 취급(아래 WHERE에서 처리).
    v_ids := p_person_ids;
  ELSE
    -- viewer(및 그 외 미지정 역할): 본인 person_id로만 강제.
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

    -- 위 assignments가 참조하는 work_item(파이프라인 포함, role 무관 전체)만 반환.
    'work_items', COALESCE((
      SELECT jsonb_agg(to_jsonb(w))
        FROM public.work_items w
       WHERE w.id IN (
         SELECT DISTINCT work_item_id
           FROM public.assignments
          WHERE work_item_id IS NOT NULL
            AND (v_ids IS NULL OR person_id = ANY(v_ids))
       )
    ), '[]'::jsonb)
  );
END;
$$;

COMMENT ON FUNCTION public.get_leave_ledger_data(uuid[]) IS
  'PRD v2.100 LV-17: computeLedger()에 넣을 assignments/accruals/work_items를 '
  '호출자 role과 무관하게 동일한 대상 인력에 대해 항상 동일하게 반환한다. '
  'admin/editor/assistant는 임의 person_id(들) 또는 NULL(전체), viewer는 본인만.';


-- ════════════════════════════════════════════════════════════
-- 검증
-- ════════════════════════════════════════════════════════════

NOTIFY pgrst, 'reload schema';

SELECT proname FROM pg_proc WHERE proname = 'get_leave_ledger_data';

SELECT 'migration 0040 (v2.100 LV-17 leave ledger RPC) done' AS result;
