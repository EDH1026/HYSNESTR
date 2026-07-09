-- PRD v2.22 §5.10 E-3a — 비파트너 중복 배정 방지 (INSERT)
--
-- UPDATE는 클라이언트 캐스케이드가 겹침 방지를 담당하므로 INSERT만 트리거.
-- Partner 직급은 중복 허용 (공동 배정 시나리오).

CREATE OR REPLACE FUNCTION public.check_assignment_no_overlap()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rank text;
BEGIN
  -- Get person rank
  SELECT rank INTO v_rank FROM public.people WHERE id = NEW.person_id;

  -- Partners may overlap freely
  IF v_rank IS NULL OR v_rank = 'Partner' THEN
    RETURN NEW;
  END IF;

  -- Check for any overlapping assignment for this person
  IF EXISTS (
    SELECT 1 FROM public.assignments a
    WHERE a.person_id = NEW.person_id
      AND a.start     <= NEW.end_date
      AND a.end_date  >= NEW.start
  ) THEN
    RAISE EXCEPTION '동일 기간에 이미 배정이 있습니다. 해당 직급(%s)은 중복 배정이 허용되지 않습니다.',
      v_rank
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_check_assignment_no_overlap ON public.assignments;

CREATE TRIGGER trg_check_assignment_no_overlap
  BEFORE INSERT ON public.assignments
  FOR EACH ROW
  EXECUTE FUNCTION public.check_assignment_no_overlap();
