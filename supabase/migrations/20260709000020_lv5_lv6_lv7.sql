-- PRD v2.20 §5.10 LV-5 · LV-6 · LV-7
--
-- 변경 요약
--   1. 특별휴가 잔여 검증 트리거 (FIX B / LV-6 서버)
--      direction='usage', type='특별휴가', days>0 인 INSERT 시
--      잔여 특별휴가 < 요청 일수이면 EXCEPTION 을 발생시킨다.
--   2. 기존 특별휴가 usage 레코드 감사 로그 등록 (FIX D)
--      LV-5 배포 전에 입력된 특별휴가 사용 레코드를 소급 감사 기록한다.

-- ════════════════════════════════════════════════════════════
-- 1. 특별휴가 잔여 검증 트리거 (FIX B / LV-6)
-- ════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.check_special_leave_balance()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_balance numeric;
BEGIN
  IF NEW.direction = 'usage' AND NEW.type = '특별휴가' AND NEW.days > 0 THEN
    -- 잔여 특별휴가 = Σ accrual.days − Σ usage.days  (음수 usage = 회수, 차감 완화)
    SELECT COALESCE(SUM(
      CASE WHEN direction = 'accrual' THEN days ELSE -days END
    ), 0)
    INTO v_balance
    FROM public.accruals
    WHERE person_id = NEW.person_id
      AND type      = '특별휴가';

    IF v_balance < NEW.days THEN
      RAISE EXCEPTION '특별휴가 잔여가 부족합니다 (잔여: %, 요청: %)', v_balance, NEW.days;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_check_special_leave_balance ON public.accruals;

CREATE TRIGGER trg_check_special_leave_balance
  BEFORE INSERT ON public.accruals
  FOR EACH ROW
  EXECUTE FUNCTION public.check_special_leave_balance();

-- ════════════════════════════════════════════════════════════
-- 2. 기존 특별휴가 usage 레코드 감사 로그 등록 (FIX D)
-- ════════════════════════════════════════════════════════════
-- LV-5 FIFO 제한 적용 이전에 저장된 특별휴가 usage 레코드를
-- audit_log 에 소급 기록한다. user_id = NULL (시스템 작업).

INSERT INTO public.audit_log (user_id, action, target_type, target_id, payload, at)
SELECT
  NULL,
  'special_leave_usage_lv5_retroactive',
  'accrual',
  id,
  jsonb_build_object(
    'person_id', person_id,
    'type',      type,
    'days',      days,
    'date',      date,
    'note',      note,
    'reason',    'PRD v2.20 LV-5 FIFO source restriction retroactive audit'
  ),
  now()
FROM public.accruals
WHERE direction = 'usage'
  AND type      = '특별휴가'
  AND days      > 0;
