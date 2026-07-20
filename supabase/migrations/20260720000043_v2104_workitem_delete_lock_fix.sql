-- =============================================================
-- Migration 0043: PRD v2.104 T-23 정정 — RAISE EXCEPTION 구문 오류 수정
-- =============================================================
-- 실행 순서: 0042 이후
-- 멱등 보장: CREATE OR REPLACE FUNCTION
--
-- 0042의 check_work_item_closed_delete()가 `RAISE EXCEPTION 'CODE' USING MESSAGE = ...`
-- 구문을 써서 SQLSTATE 42601("RAISE option already specified: MESSAGE")로 항상 실패했다
-- (v2.92 ADM-9에서 이미 겪은 것과 동일한 오류 패턴 — RAISE EXCEPTION 뒤의 문자열
-- 리터럴 자체가 이미 MESSAGE를 지정하므로 USING MESSAGE를 추가로 쓰면 충돌한다).
-- 단일 포맷 문자열로 통일해 수정한다.
-- =============================================================

CREATE OR REPLACE FUNCTION public.check_work_item_closed_delete()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF OLD.status = 'closed' THEN
    RAISE EXCEPTION 'CLOSED_WORK_ITEM: Closed 작업항목은 먼저 Open으로 전환해야 삭제할 수 있습니다.';
  END IF;
  RETURN OLD;
END;
$$;

SELECT 'migration 0043 (v2.104 T-23 delete lock raise fix) done' AS result;
