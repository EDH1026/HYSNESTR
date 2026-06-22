-- =============================================================
-- Migration 0004: Row Level Security — Enable + Policies
-- =============================================================
-- 실행 순서: 0003_triggers.sql 이후
-- =============================================================
-- 설계 원칙 (§6, N-3, 부록 B):
--   · 모든 테이블에 RLS 활성화 (비활성 테이블 없음)
--   · FORCE ROW LEVEL SECURITY: postgres 직접 접속도 정책 적용
--   · 유효 권한 = MAX(전역 역할, 리소스 grant, 본인 규칙) (§6.4)
--   · profiles/grants 전용 정책은 app_can() 대신 is_admin() 사용
--     → app_can()이 grants를 읽고, grants 정책이 app_can()을
--       호출하면 순환이 발생하기 때문 (재귀 방지)
-- =============================================================

-- ── RLS 활성화 ────────────────────────────────────────────────

ALTER TABLE public.people      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.work_items  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profiles    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.accruals    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.holidays    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.grants      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_log   ENABLE ROW LEVEL SECURITY;

-- postgres 직접 접속 시에도 정책 강제 적용
ALTER TABLE public.people      FORCE ROW LEVEL SECURITY;
ALTER TABLE public.work_items  FORCE ROW LEVEL SECURITY;
ALTER TABLE public.profiles    FORCE ROW LEVEL SECURITY;
ALTER TABLE public.assignments FORCE ROW LEVEL SECURITY;
ALTER TABLE public.accruals    FORCE ROW LEVEL SECURITY;
ALTER TABLE public.holidays    FORCE ROW LEVEL SECURITY;
ALTER TABLE public.grants      FORCE ROW LEVEL SECURITY;
ALTER TABLE public.audit_log   FORCE ROW LEVEL SECURITY;

-- =============================================================
-- people
-- =============================================================
-- SELECT : view 권한 보유자 + profiles.person_id 로 연결된 본인
-- INSERT : edit 권한 필요 (신규 id는 DB 생성; admin/editor 전역 역할로 판정)
-- UPDATE : edit 권한 필요
-- DELETE : edit 권한 필요

CREATE POLICY people_select ON public.people
  FOR SELECT USING (
    app_can('person', id, 'view')
    OR EXISTS (
      SELECT 1
      FROM public.profiles p
      WHERE p.id = auth.uid()
        AND p.person_id = people.id
    )
  );

CREATE POLICY people_insert ON public.people
  FOR INSERT WITH CHECK (
    app_can('person', id, 'edit')
  );

CREATE POLICY people_update ON public.people
  FOR UPDATE
  USING      (app_can('person', id, 'edit'))
  WITH CHECK (app_can('person', id, 'edit'));

CREATE POLICY people_delete ON public.people
  FOR DELETE USING (
    app_can('person', id, 'edit')
  );

-- =============================================================
-- work_items
-- =============================================================

CREATE POLICY work_items_select ON public.work_items
  FOR SELECT USING (
    app_can('work_item', id, 'view')
  );

CREATE POLICY work_items_insert ON public.work_items
  FOR INSERT WITH CHECK (
    app_can('work_item', id, 'edit')
  );

CREATE POLICY work_items_update ON public.work_items
  FOR UPDATE
  USING      (app_can('work_item', id, 'edit'))
  WITH CHECK (app_can('work_item', id, 'edit'));

CREATE POLICY work_items_delete ON public.work_items
  FOR DELETE USING (
    app_can('work_item', id, 'edit')
  );

-- =============================================================
-- profiles
-- =============================================================
-- is_admin() 사용 (app_can 대신): 순환 참조 방지
--
-- SELECT  : 본인 + admin 전체 열람
-- INSERT  : 트리거(SECURITY DEFINER handle_new_user)만 허용;
--           WITH CHECK (false) → 앱 직접 삽입 차단
-- UPDATE  : admin은 전 행 수정 가능
--           본인은 name 만 수정 가능 (global_role·status·person_id 동결)
-- DELETE  : admin 전용

CREATE POLICY profiles_select ON public.profiles
  FOR SELECT USING (
    id = auth.uid()
    OR is_admin()
  );

CREATE POLICY profiles_insert ON public.profiles
  FOR INSERT WITH CHECK (false);
  -- 트리거 함수(SECURITY DEFINER)는 RLS를 우회하므로 차단되지 않음

CREATE POLICY profiles_update_admin ON public.profiles
  FOR UPDATE
  USING      (is_admin())
  WITH CHECK (is_admin());

-- 본인: name 만 수정 허용 — global_role·status·person_id 는 기존 값과 동일해야 함
CREATE POLICY profiles_update_self ON public.profiles
  FOR UPDATE
  USING (id = auth.uid())
  WITH CHECK (
    id          = auth.uid()
    AND global_role = (SELECT p.global_role FROM public.profiles p WHERE p.id = auth.uid())
    AND status      = (SELECT p.status      FROM public.profiles p WHERE p.id = auth.uid())
    AND person_id   IS NOT DISTINCT FROM
                      (SELECT p.person_id   FROM public.profiles p WHERE p.id = auth.uid())
  );

CREATE POLICY profiles_delete ON public.profiles
  FOR DELETE USING (is_admin());

-- =============================================================
-- assignments
-- =============================================================
-- SELECT  : 해당 person 열람 권한 + 본인 배정 직접 열람
-- INSERT  : 해당 person edit 권한
-- UPDATE  : 해당 person edit 권한
-- DELETE  : 해당 person edit 권한

CREATE POLICY assignments_select ON public.assignments
  FOR SELECT USING (
    app_can('person', person_id, 'view')
    OR EXISTS (
      SELECT 1
      FROM public.profiles p
      WHERE p.id = auth.uid()
        AND p.person_id = assignments.person_id
    )
  );

CREATE POLICY assignments_insert ON public.assignments
  FOR INSERT WITH CHECK (
    app_can('person', person_id, 'edit')
  );

CREATE POLICY assignments_update ON public.assignments
  FOR UPDATE
  USING      (app_can('person', person_id, 'edit'))
  WITH CHECK (app_can('person', person_id, 'edit'));

CREATE POLICY assignments_delete ON public.assignments
  FOR DELETE USING (
    app_can('person', person_id, 'edit')
  );

-- =============================================================
-- accruals
-- =============================================================

CREATE POLICY accruals_select ON public.accruals
  FOR SELECT USING (
    app_can('person', person_id, 'view')
    OR EXISTS (
      SELECT 1
      FROM public.profiles p
      WHERE p.id = auth.uid()
        AND p.person_id = accruals.person_id
    )
  );

CREATE POLICY accruals_insert ON public.accruals
  FOR INSERT WITH CHECK (
    app_can('person', person_id, 'edit')
  );

CREATE POLICY accruals_update ON public.accruals
  FOR UPDATE
  USING      (app_can('person', person_id, 'edit'))
  WITH CHECK (app_can('person', person_id, 'edit'));

CREATE POLICY accruals_delete ON public.accruals
  FOR DELETE USING (
    app_can('person', person_id, 'edit')
  );

-- =============================================================
-- holidays
-- =============================================================
-- SELECT  : 인증된 모든 사용자 (타임라인·영업일 계산에 필요)
-- INSERT  : editor 이상 전역 권한
-- UPDATE  : editor 이상 전역 권한
-- DELETE  : editor 이상 전역 권한

CREATE POLICY holidays_select ON public.holidays
  FOR SELECT USING (auth.uid() IS NOT NULL);

CREATE POLICY holidays_insert ON public.holidays
  FOR INSERT WITH CHECK (
    app_can('global', null, 'edit')
  );

CREATE POLICY holidays_update ON public.holidays
  FOR UPDATE
  USING      (app_can('global', null, 'edit'))
  WITH CHECK (app_can('global', null, 'edit'));

CREATE POLICY holidays_delete ON public.holidays
  FOR DELETE USING (
    app_can('global', null, 'edit')
  );

-- =============================================================
-- grants
-- =============================================================
-- is_admin() 사용 (app_can 대신): 순환 참조 방지
--   → app_can이 grants를 읽고, grants 정책이 app_can을 다시
--     호출하면 재귀가 발생한다.
--
-- SELECT  : 본인 grants 조회 가능 (F-RBAC-4) + admin 전체
-- INSERT  : admin 전용
-- UPDATE  : admin 전용
-- DELETE  : admin 전용

CREATE POLICY grants_select ON public.grants
  FOR SELECT USING (
    user_id = auth.uid()
    OR is_admin()
  );

CREATE POLICY grants_insert ON public.grants
  FOR INSERT WITH CHECK (is_admin());

CREATE POLICY grants_update ON public.grants
  FOR UPDATE
  USING      (is_admin())
  WITH CHECK (is_admin());

CREATE POLICY grants_delete ON public.grants
  FOR DELETE USING (is_admin());

-- =============================================================
-- audit_log
-- =============================================================
-- SELECT  : 본인 행위 이력 조회 (F-RBAC-4) + admin 전체
-- INSERT  : WITH CHECK (false) → 앱 직접 삽입 차단
--           트리거 함수(SECURITY DEFINER)는 RLS 우회 → 정상 기록
-- UPDATE  : 정책 없음 = 전면 차단 (append-only 보장)
-- DELETE  : 정책 없음 = 전면 차단

CREATE POLICY audit_log_select ON public.audit_log
  FOR SELECT USING (
    user_id = auth.uid()
    OR is_admin()
  );

CREATE POLICY audit_log_insert ON public.audit_log
  FOR INSERT WITH CHECK (false);
  -- 실제 삽입은 audit_trigger_fn (SECURITY DEFINER) 가 담당
