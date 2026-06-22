-- =============================================================
-- Migration 0016: PRD v2.5 §5.5 W-4~W-6 / §6.4 — Closed 작업항목 잠금
-- =============================================================
-- 실행 순서: 0015 이후
-- 멱등 보장: CREATE OR REPLACE FUNCTION / DROP TRIGGER IF EXISTS → CREATE TRIGGER
--
-- 변경 요약:
--   1. check_work_item_closed_update() 트리거 함수:
--      OLD.status = 'closed' 인 행의 UPDATE 시 status 만 'open' 으로
--      변경하는 것만 허용. 다른 컬럼 변경은 거부.
--
--   2. check_assignment_closed_work_item() 트리거 함수:
--      INSERT / UPDATE / DELETE 대상 배정의 work_item.status = 'closed' 이면 거부.
--      work_item_id IS NULL (휴가 배정) 은 항상 통과.
--
-- 보안: SECURITY DEFINER — 트리거는 DB 수준 강제이므로 클라이언트 우회 불가
-- =============================================================


-- ════════════════════════════════════════════════════════════
-- 1. work_items — Closed 행 잠금 트리거
-- ════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.check_work_item_closed_update()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  -- 이전 상태가 'closed' 가 아니면 어떤 변경도 허용
  IF OLD.status IS DISTINCT FROM 'closed' THEN
    RETURN NEW;
  END IF;

  -- OLD.status = 'closed' 인 경우:
  -- 허용: status 를 'open' 으로 변경 (재오픈)
  -- 거부: status 를 'open' 이외로 변경하거나 다른 컬럼 변경

  IF NEW.status = 'open' THEN
    -- 재오픈 허용; 다른 컬럼은 OLD 값으로 강제 복원
    -- (단일 오퍼레이션으로 재오픈과 동시에 편집하는 경우 방지)
    NEW.type             := OLD.type;
    NEW.name             := OLD.name;
    NEW.color            := OLD.color;
    NEW.start            := OLD.start;
    NEW.main_start       := OLD.main_start;
    NEW.end_date         := OLD.end_date;
    NEW.engagement_number := OLD.engagement_number;
    NEW.client           := OLD.client;
    NEW.description      := OLD.description;
    NEW.hashtags         := OLD.hashtags;
    NEW.confidential     := OLD.confidential;
    NEW.project_status   := OLD.project_status;
    RETURN NEW;
  END IF;

  -- status = 'closed' 유지 또는 다른 값으로 변경 → 거부
  RAISE EXCEPTION 'CLOSED_WORK_ITEM'
    USING MESSAGE = 'Closed 작업항목은 먼저 Open으로 전환해야 편집할 수 있습니다.',
          HINT    = 'Set status to ''open'' before making other changes.';
END;
$$;

COMMENT ON FUNCTION public.check_work_item_closed_update() IS
  'PRD v2.5 §5.5 W-4: Closed 작업항목은 status=''open'' 복원 외 모든 UPDATE 거부';

DROP TRIGGER IF EXISTS trg_work_item_closed_update ON public.work_items;
CREATE TRIGGER trg_work_item_closed_update
  BEFORE UPDATE ON public.work_items
  FOR EACH ROW EXECUTE FUNCTION public.check_work_item_closed_update();


-- ════════════════════════════════════════════════════════════
-- 2. assignments — Closed 작업항목 배정 잠금 트리거
-- ════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.check_assignment_closed_work_item()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_work_item_id uuid;
  v_status       text;
BEGIN
  -- 대상 work_item_id 결정
  IF TG_OP = 'DELETE' THEN
    v_work_item_id := OLD.work_item_id;
  ELSE
    v_work_item_id := NEW.work_item_id;
  END IF;

  -- 휴가 배정 (work_item_id IS NULL) → 항상 허용
  IF v_work_item_id IS NULL THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;

  -- 연결된 work_item 상태 조회
  SELECT status INTO v_status
    FROM public.work_items
   WHERE id = v_work_item_id;

  IF v_status = 'closed' THEN
    RAISE EXCEPTION 'CLOSED_WORK_ITEM'
      USING MESSAGE = 'Closed 작업항목에는 배정을 추가·수정·삭제할 수 없습니다. 먼저 Open으로 전환하세요.',
            HINT    = 'Reopen the work item (set status=''open'') before modifying assignments.';
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$;

COMMENT ON FUNCTION public.check_assignment_closed_work_item() IS
  'PRD v2.5 §5.5 W-5/W-6: Closed 작업항목 배정 INSERT/UPDATE/DELETE 거부';

DROP TRIGGER IF EXISTS trg_assignment_closed_work_item ON public.assignments;
CREATE TRIGGER trg_assignment_closed_work_item
  BEFORE INSERT OR UPDATE OR DELETE ON public.assignments
  FOR EACH ROW EXECUTE FUNCTION public.check_assignment_closed_work_item();


-- ════════════════════════════════════════════════════════════
-- 검증 쿼리
-- ════════════════════════════════════════════════════════════

SELECT tgname, tgrelid::regclass AS table_name
FROM   pg_trigger
WHERE  tgname IN ('trg_work_item_closed_update', 'trg_assignment_closed_work_item');

SELECT 'migration 0016 (PRD v2.5 closed lock) done' AS result;
