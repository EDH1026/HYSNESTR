-- =============================================================
-- Migration 0042: PRD v2.104 T-23 — work_items DELETE에도 Closed 잠금 확장
-- =============================================================
-- 실행 순서: 0041 이후
-- 멱등 보장: CREATE OR REPLACE FUNCTION / DROP TRIGGER IF EXISTS → CREATE TRIGGER
--
-- 배경: T-23(Workitem 막대 케밥 메뉴)에서 "삭제" 기능이 신설됨에 따라 work_items에
-- DELETE 요청이 처음으로 클라이언트에서 발생할 수 있게 됐다. work_items_delete RLS
-- 정책(editor/admin만)은 이미 존재하지만, 기존 W-6 Closed 잠금 트리거
-- (check_work_item_closed_update, 0016)는 BEFORE UPDATE에만 걸려 있어 DELETE는
-- 다루지 않는다.
--
-- assignments.work_item_id는 ON DELETE CASCADE라서 work_item을 삭제하면 연결된
-- assignments가 자동으로 함께 삭제되고, 그 cascade 삭제는 기존
-- trg_assignment_closed_work_item(0016) 트리거를 그대로 통과하며 work_item이
-- Closed면 간접적으로 막힌다 — 그러나 **연결된 assignments가 0건인 Closed
-- work_item**은 cascade될 대상이 없어 이 간접 방어를 우회해 삭제될 수 있었다.
-- 이 허점을 막기 위해 work_items 자체에 BEFORE DELETE 트리거를 명시적으로 추가한다.
-- =============================================================

CREATE OR REPLACE FUNCTION public.check_work_item_closed_delete()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF OLD.status = 'closed' THEN
    RAISE EXCEPTION 'CLOSED_WORK_ITEM'
      USING MESSAGE = 'Closed 작업항목은 먼저 Open으로 전환해야 삭제할 수 있습니다.',
            HINT    = 'Reopen the work item (set status=''open'') before deleting it.';
  END IF;
  RETURN OLD;
END;
$$;

COMMENT ON FUNCTION public.check_work_item_closed_delete() IS
  'PRD v2.104 T-23: Closed 작업항목의 DELETE를 거부(연결 assignments가 0건이라 '
  'cascade 트리거로 간접 차단되지 않는 경우의 허점을 막는 명시적 방어).';

DROP TRIGGER IF EXISTS trg_work_item_closed_delete ON public.work_items;
CREATE TRIGGER trg_work_item_closed_delete
  BEFORE DELETE ON public.work_items
  FOR EACH ROW EXECUTE FUNCTION public.check_work_item_closed_delete();


-- ════════════════════════════════════════════════════════════
-- 검증
-- ════════════════════════════════════════════════════════════

SELECT tgname, tgrelid::regclass AS table_name
  FROM pg_trigger
 WHERE tgname = 'trg_work_item_closed_delete';

SELECT 'migration 0042 (v2.104 T-23 work_item delete lock) done' AS result;
