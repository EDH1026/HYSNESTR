-- =============================================================
-- Migration 0007: RLS v2 — §6 viewer 범위 축소
-- =============================================================
-- 실행 순서: 0006_prd4.sql 이후
--
-- 변경 요약
--   1. app_can(): viewer 전역 view 권한 제거.
--      viewer는 명시적 grant 또는 본인 행 규칙으로만 접근.
--   2. people SELECT  : editor/admin(app_can) 또는 my_person_id() 자신
--   3. assignments SELECT : 동일 패턴 + pipeline 규칙 유지
--   4. accruals SELECT    : editor/admin 또는 my_person_id() 자신
--   5. work_items SELECT  : editor/admin 또는 본인 배정 항목(CV 표시용)
--                           pipeline은 기존대로 edit 이상만
--
-- 기존 데이터·권한에 영향 없음:
--   · app_can()는 CREATE OR REPLACE — 정책에 즉시 반영
--   · DROP POLICY IF EXISTS → CREATE POLICY 로 멱등 보장
-- =============================================================


-- ── 1. app_can() 교체: viewer 전역 view 제거 ─────────────────
--
-- 변경 전: (global_role = 'viewer' AND _need = 'view') → 전체 view 허용
-- 변경 후: editor 이상만 전역 역할로 허용. viewer는 반드시
--          명시적 grant 또는 아래 정책의 본인 규칙을 통해야만 접근.

CREATE OR REPLACE FUNCTION public.app_can(
  _scope    text,
  _resource uuid,
  _need     text
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH me AS (
    SELECT global_role, person_id
    FROM public.profiles
    WHERE id     = auth.uid()
      AND status = 'active'
  )
  SELECT
    -- 1. admin: 모든 리소스 전권
    EXISTS (SELECT 1 FROM me WHERE global_role = 'admin')

    -- 2. editor: view·edit 전역 허용 (viewer는 전역 허용 없음)
    OR EXISTS (
      SELECT 1 FROM me
      WHERE global_role = 'editor'
        AND _need IN ('view','edit')
    )

    -- 3. grants 테이블: 명시적 리소스 grant (viewer도 grant 있으면 허용)
    OR EXISTS (
      SELECT 1
      FROM public.grants g
      WHERE g.user_id = auth.uid()
        AND (
              (g.scope = _scope AND g.resource_id IS NOT DISTINCT FROM _resource)
              OR g.scope = 'global'
            )
        AND (
              g.level = 'admin'
              OR (g.level = 'edit' AND _need IN ('view','edit'))
              OR (g.level = 'view' AND _need = 'view')
            )
    )
$$;

COMMENT ON FUNCTION public.app_can(text, uuid, text)
  IS 'editor/admin 전역 허용 + 명시적 grant. viewer는 본인 행 규칙으로 별도 처리. (§6, 부록 B.2)';


-- ── 2. people SELECT 재작성 ───────────────────────────────────
-- editor/admin : app_can(view) — 변경 후에도 true
-- viewer       : my_person_id() 와 id 가 일치하는 본인 행만

DROP POLICY IF EXISTS people_select ON public.people;

CREATE POLICY people_select ON public.people
  FOR SELECT USING (
    app_can('person', id, 'view')
    OR id = my_person_id()
  );


-- ── 3. assignments SELECT 재작성 ──────────────────────────────
-- pipeline 배정 : work_item edit 권한 필요 (기존 유지)
-- 그 외         : editor/admin(app_can) 또는 본인 배정(my_person_id)

DROP POLICY IF EXISTS assignments_select ON public.assignments;

CREATE POLICY assignments_select ON public.assignments
  FOR SELECT USING (
    CASE
      -- pipeline 배정: SECURITY DEFINER 함수로 RLS 우회해 pipeline 여부 판별
      WHEN is_pipeline_work_item(work_item_id) THEN
        app_can('work_item', work_item_id, 'edit')

      -- 비-pipeline (project·proposal·leave)
      ELSE
        app_can('person', person_id, 'view')
        OR person_id = my_person_id()
    END
  );


-- ── 4. accruals SELECT 재작성 ─────────────────────────────────

DROP POLICY IF EXISTS accruals_select ON public.accruals;

CREATE POLICY accruals_select ON public.accruals
  FOR SELECT USING (
    app_can('person', person_id, 'view')
    OR person_id = my_person_id()
  );


-- ── 5. work_items SELECT 재작성 ──────────────────────────────
-- pipeline     : edit 권한 이상 (기존 유지)
-- 그 외         : editor/admin(app_can) 또는 본인 배정 항목
--                 — viewer가 자신의 CV(이력)에서 프로젝트명을 볼 수 있도록
--                   본인이 kind='work'로 배정된 non-pipeline 항목에 한해 허용
--
-- 보안 메모:
--   assignments 서브쿼리는 RLS를 거침.
--   viewer의 assignments_select 는 my_person_id() 자신 행만 허용하므로
--   타인의 배정을 통해 work_item 이 노출되지 않음.
--   pipeline work_item은 CASE 첫 번째 분기에서 차단되므로
--   ELSE 분기의 서브쿼리에 도달하지 않음.

DROP POLICY IF EXISTS work_items_select ON public.work_items;

CREATE POLICY work_items_select ON public.work_items
  FOR SELECT USING (
    CASE type
      WHEN 'pipeline' THEN
        app_can('work_item', id, 'edit')
      ELSE
        app_can('work_item', id, 'view')
        -- viewer: 본인이 배정된 project·proposal 한정 (CV 표시용)
        OR EXISTS (
          SELECT 1
          FROM public.assignments a
          WHERE a.work_item_id = work_items.id
            AND a.person_id    = my_person_id()
            AND a.kind         = 'work'
        )
    END
  );
