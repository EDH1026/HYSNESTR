-- =============================================================
-- Migration 0039: PRD v2.100 — 권한 축소 (People·연차 관리·타임시트 지침·공휴일 동기화)
-- =============================================================
-- 실행 순서: 0038 이후
-- 멱등 보장: DROP POLICY IF EXISTS / CREATE POLICY
--
-- 요약:
--   editor는 people(인력 관리)·annual_leave_adjustments(연차 관리)·
--   timesheet_guideline_snapshot·timesheet_guideline_documents(타임시트 지침)·
--   holidays 쓰기(공휴일 동기화)에 대한 접근을 잃는다. assistant는 people·
--   holidays 쓰기 접근을 잃지만 annual_leave_adjustments·timesheet_guideline_*의
--   기존 SELECT(열람 전용) 접근은 유지한다. people/holidays의 SELECT는 전 역할
--   그대로 유지(타임라인 인력 칩·CV·영업일 계산 등 다른 화면이 계속 사용).
--
-- 진단 중 발견한 부수 이슈: annual_leave_adjustments 테이블은 RLS가 켜져 있는데
-- (relrowsecurity=true) INSERT/UPDATE/DELETE 정책이 하나도 없었다(SELECT만 존재) —
-- 즉 admin을 포함해 아무도 연차 수동보정을 추가/삭제할 수 없는 상태였다. 이번에
-- admin 전용 쓰기 정책을 신설해 함께 바로잡는다. 이 테이블은 리포지토리
-- 마이그레이션 이력에 CREATE TABLE 흔적이 없어(라이브 DB에 수동 반영된 드리프트로
-- 추정) 이 마이그레이션은 정책만 다루고 테이블 구조는 건드리지 않는다.
-- =============================================================


-- ════════════════════════════════════════════════════════════
-- 1. people — SELECT 유지, INSERT/UPDATE/DELETE를 admin 전용으로 축소
-- ════════════════════════════════════════════════════════════

DROP POLICY IF EXISTS people_insert ON public.people;
DROP POLICY IF EXISTS people_update ON public.people;
DROP POLICY IF EXISTS people_delete ON public.people;

CREATE POLICY people_insert ON public.people
  FOR INSERT WITH CHECK (my_role() = 'admin');

CREATE POLICY people_update ON public.people
  FOR UPDATE USING (my_role() = 'admin');

CREATE POLICY people_delete ON public.people
  FOR DELETE USING (my_role() = 'admin');

-- people_select은 변경하지 않는다 (auth.uid() IS NOT NULL — 전 역할 조회 유지).


-- ════════════════════════════════════════════════════════════
-- 2. annual_leave_adjustments — SELECT을 admin·assistant로 축소(editor 제외),
--    누락돼 있던 INSERT/UPDATE/DELETE를 admin 전용으로 신설
-- ════════════════════════════════════════════════════════════

DROP POLICY IF EXISTS al_adjustments_select ON public.annual_leave_adjustments;
DROP POLICY IF EXISTS al_adjustments_insert ON public.annual_leave_adjustments;
DROP POLICY IF EXISTS al_adjustments_update ON public.annual_leave_adjustments;
DROP POLICY IF EXISTS al_adjustments_delete ON public.annual_leave_adjustments;

CREATE POLICY al_adjustments_select ON public.annual_leave_adjustments
  FOR SELECT USING (my_role() IN ('admin', 'assistant'));

CREATE POLICY al_adjustments_insert ON public.annual_leave_adjustments
  FOR INSERT WITH CHECK (my_role() = 'admin');

CREATE POLICY al_adjustments_update ON public.annual_leave_adjustments
  FOR UPDATE USING (my_role() = 'admin');

CREATE POLICY al_adjustments_delete ON public.annual_leave_adjustments
  FOR DELETE USING (my_role() = 'admin');


-- ════════════════════════════════════════════════════════════
-- 3. timesheet_guideline_snapshot — SELECT을 admin·assistant로 축소,
--    INSERT/UPDATE/DELETE를 admin 전용으로 축소
-- ════════════════════════════════════════════════════════════

DROP POLICY IF EXISTS tgs_select ON public.timesheet_guideline_snapshot;
DROP POLICY IF EXISTS tgs_insert ON public.timesheet_guideline_snapshot;
DROP POLICY IF EXISTS tgs_update ON public.timesheet_guideline_snapshot;
DROP POLICY IF EXISTS tgs_delete ON public.timesheet_guideline_snapshot;

CREATE POLICY tgs_select ON public.timesheet_guideline_snapshot
  FOR SELECT USING (my_role() IN ('admin', 'assistant'));

CREATE POLICY tgs_insert ON public.timesheet_guideline_snapshot
  FOR INSERT WITH CHECK (my_role() = 'admin');

CREATE POLICY tgs_update ON public.timesheet_guideline_snapshot
  FOR UPDATE USING (my_role() = 'admin');

CREATE POLICY tgs_delete ON public.timesheet_guideline_snapshot
  FOR DELETE USING (my_role() = 'admin');


-- ════════════════════════════════════════════════════════════
-- 4. timesheet_guideline_documents — SELECT을 admin·assistant로 축소,
--    INSERT/DELETE를 admin 전용으로 축소 (UPDATE 정책은 기존에도 없었음 — 그대로 둠)
-- ════════════════════════════════════════════════════════════

DROP POLICY IF EXISTS tgd_select ON public.timesheet_guideline_documents;
DROP POLICY IF EXISTS tgd_insert ON public.timesheet_guideline_documents;
DROP POLICY IF EXISTS tgd_delete ON public.timesheet_guideline_documents;

CREATE POLICY tgd_select ON public.timesheet_guideline_documents
  FOR SELECT USING (my_role() IN ('admin', 'assistant'));

CREATE POLICY tgd_insert ON public.timesheet_guideline_documents
  FOR INSERT WITH CHECK (my_role() = 'admin');

CREATE POLICY tgd_delete ON public.timesheet_guideline_documents
  FOR DELETE USING (my_role() = 'admin');


-- ════════════════════════════════════════════════════════════
-- 5. holidays — SELECT 유지(영업일 계산에 전역 사용), 쓰기를 admin 전용으로 축소
-- ════════════════════════════════════════════════════════════
-- 기존엔 app_can('global', NULL, 'edit')를 썼는데 이 함수는 editor에게도 전역
-- edit을 부여한다(다른 테이블 다수가 이 동작에 의존하므로 app_can() 자체는
-- 건드리지 않는다) — holidays 쓰기만 my_role()='admin'으로 직접 좁힌다.

DROP POLICY IF EXISTS holidays_insert ON public.holidays;
DROP POLICY IF EXISTS holidays_update ON public.holidays;
DROP POLICY IF EXISTS holidays_delete ON public.holidays;

CREATE POLICY holidays_insert ON public.holidays
  FOR INSERT WITH CHECK (my_role() = 'admin');

CREATE POLICY holidays_update ON public.holidays
  FOR UPDATE USING (my_role() = 'admin');

CREATE POLICY holidays_delete ON public.holidays
  FOR DELETE USING (my_role() = 'admin');

-- holidays_select은 변경하지 않는다 (auth.uid() IS NOT NULL — 전 역할 조회 유지).


-- ════════════════════════════════════════════════════════════
-- 검증
-- ════════════════════════════════════════════════════════════

NOTIFY pgrst, 'reload schema';

SELECT tablename, policyname, cmd, roles
  FROM pg_policies
 WHERE tablename IN (
   'people', 'annual_leave_adjustments',
   'timesheet_guideline_snapshot', 'timesheet_guideline_documents', 'holidays'
 )
 ORDER BY tablename, cmd;

SELECT 'migration 0039 (v2.100 scope down permissions) done' AS result;
