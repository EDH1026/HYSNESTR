-- =============================================================
-- Migration 0048: PRD v2.122 — W-11 project 유형은 main_start 필수
-- =============================================================
-- 실행 순서: 0047 이후
-- 멱등 보장: 기존 제약 DROP 후 재생성.
--
-- 배경:
--   §7.1 프로젝트휴가 계산은 (assignment ∩ main_phase) 구간만 사용한다
--   (main_phase = main_start ~ end_date). project 유형인데 main_start가
--   비어 있으면 이 교집합이 항상 공집합이 되어 프로젝트휴가가 전혀
--   적립되지 않는다 — 실사용 중 이 문제로 발견됨.
--   지금까지는 UI(WorkItemModal)와 벌크 업로드에서만 값이 있을 때의
--   범위(start~end_date)를 검사했고, "비어있으면 안 된다"는 검사가
--   없어 project 행이 main_start NULL로 저장될 수 있었다.
--
-- 조치:
--   type='project'이면 main_start NOT NULL을 CHECK 제약으로 강제한다.
--   NOT VALID로 추가해 기존에 이미 main_start가 비어 있는 project 행이
--   있어도 이번 마이그레이션은 실패하지 않는다(그 행들은 앱에서 값을
--   채워야 프로젝트휴가가 정상 적립됨). 기존 위반 행을 모두 정정한 뒤
--   아래 VALIDATE CONSTRAINT를 별도로 실행해 완전히 강제할 것.
--
--   기존 위반 행 조회:
--     SELECT id, name, start, end_date FROM public.work_items
--      WHERE type = 'project' AND main_start IS NULL;
--
--   정정 후 검증 활성화:
--     ALTER TABLE public.work_items VALIDATE CONSTRAINT wi_project_requires_main;
-- =============================================================

ALTER TABLE public.work_items
  DROP CONSTRAINT IF EXISTS wi_project_requires_main;

ALTER TABLE public.work_items
  ADD CONSTRAINT wi_project_requires_main
  CHECK (type <> 'project' OR main_start IS NOT NULL)
  NOT VALID;

SELECT 'migration 0048 (v2.122 W-11 project requires main_start) done' AS result;
