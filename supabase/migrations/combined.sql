-- ===== 20260620000001_tables.sql =====

-- =============================================================
-- Migration 0001: Core tables  (PRD §4.1, 부록 B.1)
-- =============================================================
-- Run order matters: people → work_items → profiles → assignments
--                    → accruals → holidays → grants → audit_log
-- =============================================================

-- ── people: 인력 목록 ─────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.people (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text        NOT NULL,
  rank       text        NOT NULL
               CHECK (rank IN ('Partner','SM','M','Senior','Staff','Intern')),
  role       text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE  public.people      IS '인력 목록 (§4.1)';
COMMENT ON COLUMN public.people.rank IS 'Partner|SM|M|Senior|Staff|Intern';

-- ── work_items: 프로젝트·제안서 ──────────────────────────────

CREATE TABLE IF NOT EXISTS public.work_items (
  id                uuid     PRIMARY KEY DEFAULT gen_random_uuid(),
  type              text     NOT NULL CHECK (type IN ('project','proposal')),
  name              text     NOT NULL,
  color             text,
  start             date     NOT NULL,
  main_start        date,                   -- 본 프로젝트 시작 (project only)
  end_date          date     NOT NULL,
  engagement_number text,
  client            text,
  hashtags          text[]   NOT NULL DEFAULT '{}',
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  -- 날짜 정합성
  CONSTRAINT wi_dates_order       CHECK (start <= end_date),
  CONSTRAINT wi_main_in_range     CHECK (
    main_start IS NULL
    OR (main_start >= start AND main_start <= end_date)
  ),
  -- proposal에는 main_start 없음 (§4.2)
  CONSTRAINT wi_proposal_no_main  CHECK (type = 'project' OR main_start IS NULL)
);

COMMENT ON TABLE  public.work_items            IS '프로젝트·제안서 작업 항목 (§4.1, §4.2)';
COMMENT ON COLUMN public.work_items.main_start IS 'project: pre-study 종료 직후 본 프로젝트 시작일. proposal은 NULL.';

-- ── profiles: auth.users 와 1:1 계정 프로필 ──────────────────

CREATE TABLE IF NOT EXISTS public.profiles (
  id          uuid  PRIMARY KEY REFERENCES auth.users ON DELETE CASCADE,
  name        text,
  global_role text  NOT NULL DEFAULT 'viewer'
                    CHECK (global_role IN ('admin','editor','viewer')),
  person_id   uuid  REFERENCES public.people(id) ON DELETE SET NULL,
  status      text  NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','inactive')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE  public.profiles             IS '로그인 계정 프로필; person_id 로 본인 인력 레코드 연결 (§4.1, §6)';
COMMENT ON COLUMN public.profiles.global_role IS 'admin: 전권 | editor: 전체 수정 | viewer: 전체 열람';
COMMENT ON COLUMN public.profiles.person_id   IS 'profiles → people 본인 연결. NULL 허용(관리 전용 계정 등)';
COMMENT ON COLUMN public.profiles.status      IS 'inactive: 로그인 차단 대상 (퇴사 등)';

-- ── assignments: 인력 배정 (work·leave) ──────────────────────

CREATE TABLE IF NOT EXISTS public.assignments (
  id            uuid   PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id     uuid   NOT NULL REFERENCES public.people(id)     ON DELETE CASCADE,
  kind          text   NOT NULL CHECK (kind IN ('work','leave')),
  work_item_id  uuid   REFERENCES public.work_items(id)          ON DELETE CASCADE,
  weekend_dates date[] NOT NULL DEFAULT '{}',
  leave_type    text   CHECK (leave_type IN (
                  '리프레시','지정휴가','프로젝트휴가',
                  '주말/휴일대체','포상휴가','특별휴가','지연보상','휴직'
                )),
  start         date   NOT NULL,
  end_date      date   NOT NULL,
  note          text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT asgn_dates_order       CHECK (start <= end_date),
  -- kind = work 이면 work_item 필수 (§4.3)
  CONSTRAINT asgn_work_needs_item   CHECK (kind <> 'work'  OR work_item_id IS NOT NULL),
  -- kind = leave 이면 leave_type 필수
  CONSTRAINT asgn_leave_needs_type  CHECK (kind <> 'leave' OR leave_type   IS NOT NULL)
);

COMMENT ON TABLE  public.assignments              IS '인력 배정 단위 (§4.1, §4.3)';
COMMENT ON COLUMN public.assignments.weekend_dates IS '실 근무한 주말·공휴일 날짜 목록 (§7.2, F-1.8)';

-- ── accruals: 휴가 적립 내역 ──────────────────────────────────

CREATE TABLE IF NOT EXISTS public.accruals (
  id          uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id   uuid         NOT NULL REFERENCES public.people(id)    ON DELETE CASCADE,
  type        text         NOT NULL,      -- 적립 유형 레이블 (자유 문자열)
  days        numeric(5,1) NOT NULL,      -- 0.5 단위 허용
  date        date         NOT NULL,      -- 적립 기준일
  source      uuid         REFERENCES public.work_items(id)         ON DELETE SET NULL,
  note        text,
  created_at  timestamptz  NOT NULL DEFAULT now(),
  updated_at  timestamptz  NOT NULL DEFAULT now()
);

COMMENT ON TABLE  public.accruals        IS '휴가 적립 내역 (§4.1, §7)';
COMMENT ON COLUMN public.accruals.source IS '자동 적립 원천 프로젝트 (§7.1, §7.2)';

-- ── holidays: 공휴일 ──────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.holidays (
  id         uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text    NOT NULL,
  date       date    NOT NULL,
  recurring  boolean NOT NULL DEFAULT false,  -- true: 매년 반복 (월/일 기준)
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE  public.holidays           IS '공휴일 (§4.1, §5.6)';
COMMENT ON COLUMN public.holidays.recurring IS 'true = 매년 같은 월/일 반복 (창립기념일 등)';

-- ── grants: 리소스 단위 권한 ──────────────────────────────────
-- scope = global: 전역 추가 권한 (resource_id NULL)
-- scope = person / work_item: 특정 리소스 단위 권한

CREATE TABLE IF NOT EXISTS public.grants (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES auth.users  ON DELETE CASCADE,
  scope       text NOT NULL CHECK (scope IN ('global','person','work_item')),
  resource_id uuid,                               -- global 이면 NULL
  level       text NOT NULL CHECK (level IN ('view','edit','admin')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),

  -- (user_id, scope, resource_id) 조합 중복 방지; NULL = NULL 동등 처리 (PG 15+)
  CONSTRAINT grants_unique UNIQUE NULLS NOT DISTINCT (user_id, scope, resource_id),

  -- global scope 이면 resource_id 는 반드시 NULL
  CONSTRAINT grants_global_no_resource    CHECK (scope <> 'global' OR resource_id IS NULL),
  -- person/work_item scope 이면 resource_id 필수
  CONSTRAINT grants_scoped_needs_resource CHECK (scope  = 'global' OR resource_id IS NOT NULL)
);

COMMENT ON TABLE public.grants IS '사람/프로젝트 단위 리소스 권한 (§4.1, §6.3, 부록 B.1)';

-- ── audit_log: 변경·권한 이력 (append-only) ──────────────────

CREATE TABLE IF NOT EXISTS public.audit_log (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid REFERENCES auth.users ON DELETE SET NULL,
  action      text NOT NULL,          -- INSERT | UPDATE | DELETE
  target_type text NOT NULL,          -- 테이블 이름
  target_id   uuid,
  payload     jsonb,                  -- INSERT: new row / UPDATE: {old,new} / DELETE: old row
  at          timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.audit_log IS '변경·권한 이력 append-only (§4.1, N-5, F-RBAC-3)';

-- ── Indexes ───────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_profiles_person_id        ON public.profiles(person_id)       WHERE person_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_assignments_person_id     ON public.assignments(person_id);
CREATE INDEX IF NOT EXISTS idx_assignments_work_item_id  ON public.assignments(work_item_id);
CREATE INDEX IF NOT EXISTS idx_accruals_person_id        ON public.accruals(person_id);
CREATE INDEX IF NOT EXISTS idx_accruals_source           ON public.accruals(source)           WHERE source IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_holidays_date             ON public.holidays(date);
CREATE INDEX IF NOT EXISTS idx_grants_user_id            ON public.grants(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_at              ON public.audit_log(at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_user_id         ON public.audit_log(user_id)         WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_audit_log_target          ON public.audit_log(target_type, target_id);

-- ===== 20260620000002_functions.sql =====

-- =============================================================
-- Migration 0002: Helper functions
-- =============================================================
-- 실행 순서: 0001_tables.sql 이후
-- =============================================================
-- 함수별 SECURITY DEFINER 이유
--   app_can / is_admin / handle_new_user / audit_trigger_fn
--   은 RLS 정책 내부 또는 트리거에서 호출되므로,
--   RLS를 우회하여 profiles·grants를 직접 읽을 수 있어야
--   재귀 참조(순환 정책 평가)가 발생하지 않는다.
-- =============================================================

-- ── 1. updated_at 자동 갱신 ──────────────────────────────────

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- ── 2. auth.users 생성 시 profiles 자동 삽입 ─────────────────

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id, name, global_role, status)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'name', NEW.email),
    'viewer',   -- 기본 역할; 관리자가 별도로 승격
    'active'
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

-- ── 3. is_admin(): admin 여부 판정 (SECURITY DEFINER) ─────────
--
-- profiles 테이블 자신의 RLS 정책과 grants 정책에서 사용한다.
-- app_can() 내부가 grants를 읽고, grants 정책이 다시 app_can을
-- 호출하면 순환이 발생하므로, profiles/grants 전용 정책에서는
-- app_can 대신 is_admin()을 사용한다.

CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.profiles
    WHERE id          = auth.uid()
      AND global_role = 'admin'
      AND status      = 'active'
  )
$$;

-- ── 4. app_can(): 메인 권한 판정 함수 (부록 B.2) ──────────────
--
-- 현재 인증 사용자가 _scope 범위의 _resource 에 대해
-- 최소 _need 수준 이상의 권한을 갖는지 반환한다.
--
-- 판정 우선순위 (MAX 원칙, §6.4):
--   1. profiles.global_role = 'admin'  → 항상 허용
--   2. global_role에 따른 전역 권한    → editor: view·edit / viewer: view
--   3. grants 테이블의 리소스 단위 권한
--
-- SECURITY DEFINER: RLS 없이 profiles·grants를 직접 읽어
-- 정책 평가 시 순환 참조를 방지한다.

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
    -- 1. admin은 모든 리소스에 대해 전권
    EXISTS (SELECT 1 FROM me WHERE global_role = 'admin')

    -- 2. 전역 역할 기반 권한 (editor→view+edit, viewer→view)
    OR EXISTS (
      SELECT 1 FROM me
      WHERE (global_role = 'editor' AND _need IN ('view','edit'))
         OR (global_role = 'viewer' AND _need = 'view')
    )

    -- 3. grants 테이블: 정확한 리소스 grant 또는 전역 grant
    OR EXISTS (
      SELECT 1
      FROM public.grants g
      WHERE g.user_id = auth.uid()
        AND (
              -- 리소스 정확히 일치 (NULL 포함 동등 비교)
              (g.scope = _scope AND g.resource_id IS NOT DISTINCT FROM _resource)
              -- 또는 scope = 'global' 전역 grant
              OR g.scope = 'global'
            )
        AND (
              g.level = 'admin'
              OR (g.level = 'edit' AND _need IN ('view','edit'))
              OR (g.level = 'view' AND _need = 'view')
            )
    )
$$;

-- ── 5. audit_trigger_fn(): 범용 감사 로그 트리거 함수 ──────────
--
-- INSERT·UPDATE·DELETE 이후 audit_log 에 행을 기록한다.
-- SECURITY DEFINER: audit_log INSERT 정책이 잠겨 있어도
-- 트리거는 항상 기록할 수 있어야 한다.

CREATE OR REPLACE FUNCTION public.audit_trigger_fn()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.audit_log (user_id, action, target_type, target_id, payload)
  VALUES (
    auth.uid(),
    TG_OP,
    TG_TABLE_NAME,
    CASE TG_OP
      WHEN 'DELETE' THEN (to_jsonb(OLD) ->> 'id')::uuid
      ELSE               (to_jsonb(NEW) ->> 'id')::uuid
    END,
    CASE TG_OP
      WHEN 'INSERT' THEN to_jsonb(NEW)
      WHEN 'UPDATE' THEN jsonb_build_object('old', to_jsonb(OLD), 'new', to_jsonb(NEW))
      WHEN 'DELETE' THEN to_jsonb(OLD)
    END
  );
  RETURN COALESCE(NEW, OLD);
END;
$$;

-- ===== 20260620000003_triggers.sql =====

-- =============================================================
-- Migration 0003: Triggers
-- =============================================================
-- 실행 순서: 0002_functions.sql 이후
-- =============================================================

-- ── auth.users → profiles 자동 생성 ──────────────────────────
-- Supabase Auth 에서 신규 사용자가 생성될 때 profiles 행을
-- global_role='viewer' 로 자동 삽입한다 (§6, A-2).

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_user();

-- ── updated_at 자동 갱신 ──────────────────────────────────────

CREATE TRIGGER tg_people_updated_at
  BEFORE UPDATE ON public.people
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER tg_work_items_updated_at
  BEFORE UPDATE ON public.work_items
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER tg_profiles_updated_at
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER tg_assignments_updated_at
  BEFORE UPDATE ON public.assignments
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER tg_accruals_updated_at
  BEFORE UPDATE ON public.accruals
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER tg_holidays_updated_at
  BEFORE UPDATE ON public.holidays
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER tg_grants_updated_at
  BEFORE UPDATE ON public.grants
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── 감사 로그 트리거 (audit_log 자체 제외) ───────────────────
-- 모든 데이터·권한 변경을 audit_log 에 기록한다 (N-5, F-RBAC-3).

CREATE TRIGGER tg_audit_people
  AFTER INSERT OR UPDATE OR DELETE ON public.people
  FOR EACH ROW EXECUTE FUNCTION public.audit_trigger_fn();

CREATE TRIGGER tg_audit_work_items
  AFTER INSERT OR UPDATE OR DELETE ON public.work_items
  FOR EACH ROW EXECUTE FUNCTION public.audit_trigger_fn();

CREATE TRIGGER tg_audit_profiles
  AFTER INSERT OR UPDATE OR DELETE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.audit_trigger_fn();

CREATE TRIGGER tg_audit_assignments
  AFTER INSERT OR UPDATE OR DELETE ON public.assignments
  FOR EACH ROW EXECUTE FUNCTION public.audit_trigger_fn();

CREATE TRIGGER tg_audit_accruals
  AFTER INSERT OR UPDATE OR DELETE ON public.accruals
  FOR EACH ROW EXECUTE FUNCTION public.audit_trigger_fn();

CREATE TRIGGER tg_audit_holidays
  AFTER INSERT OR UPDATE OR DELETE ON public.holidays
  FOR EACH ROW EXECUTE FUNCTION public.audit_trigger_fn();

CREATE TRIGGER tg_audit_grants
  AFTER INSERT OR UPDATE OR DELETE ON public.grants
  FOR EACH ROW EXECUTE FUNCTION public.audit_trigger_fn();

-- ===== 20260620000004_rls.sql =====

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

-- ===== 20260620000005_pipeline.sql =====

-- =============================================================
-- Migration 0005: 'pipeline' work_item type + restricted RLS
-- =============================================================
-- 기존 마이그레이션(0001–0004)은 수정하지 않는다.
--
-- 변경 요약
--   1. work_items.type 체크 제약에 'pipeline' 추가
--   2. is_pipeline_work_item() SECURITY DEFINER 헬퍼 함수 추가
--   3. work_items SELECT 정책: pipeline은 edit 이상만 조회 가능
--   4. assignments SELECT 정책: pipeline 배정은 self-view 포함
--      view-only 경로를 완전 차단하고 work_item edit 권한만 허용
--   5. accruals 및 나머지 테이블 정책은 변경하지 않음
--
-- ─── 취약점 분석 ────────────────────────────────────────────────
-- assignments SELECT 정책에서 "연결된 work_item이 pipeline인지"를
-- 일반 서브쿼리(SELECT ... FROM work_items WHERE type='pipeline')로
-- 판단하면, 해당 work_item 자체가 RLS로 숨겨진 상태에서는 EXISTS가
-- false를 반환한다. 그 결과 ELSE 분기(self-view)로 흘러 pipeline
-- 배정이 뷰어에게 노출되는 허점이 생긴다.
-- → is_pipeline_work_item() 을 SECURITY DEFINER로 만들어 work_items
--   RLS를 우회해서 실제 type 값을 읽도록 해야 이 문제가 없어진다.
-- =============================================================


-- ── 1. work_items.type 체크 제약 확장 ────────────────────────
-- PostgreSQL이 인라인 컬럼 CHECK에 자동 부여하는 이름은
-- '{table}_{column}_check' 규칙을 따른다.
-- 이 마이그레이션이 실행되는 DB에서 그 이름이 다르더라도
-- IF EXISTS 덕분에 오류 없이 넘어간다.

ALTER TABLE public.work_items
  DROP CONSTRAINT IF EXISTS work_items_type_check;

-- 명시적 이름으로 다시 추가 (project·proposal 기존 값 유지)
ALTER TABLE public.work_items
  ADD CONSTRAINT wi_type_values
  CHECK (type IN ('project','proposal','pipeline'));

-- 참고: 기존 wi_proposal_no_main 제약
--   CHECK (type = 'project' OR main_start IS NULL)
-- 은 pipeline에도 올바르게 동작한다 (pipeline은 main_start = NULL 강제).
-- 이름이 proposal_no_main 으로 다소 오해를 줄 수 있으나 로직은 정확하므로
-- 변경하지 않는다.

COMMENT ON COLUMN public.work_items.type
  IS 'project | proposal | pipeline';


-- ── 2. is_pipeline_work_item() 헬퍼 ─────────────────────────
-- assignments SELECT 정책에서 work_items RLS를 우회하여
-- 해당 work_item 의 실제 type 을 확인하기 위한 함수.
--
-- SECURITY DEFINER 필수 이유:
--   pipeline work_item은 edit 권한이 없는 사용자에게 RLS로 숨겨진다.
--   만약 일반 서브쿼리를 쓰면 그 사용자에게는 pipeline 여부를 판별
--   하는 EXISTS가 항상 false 를 반환해 ELSE(self-view) 경로로 흘러
--   pipeline 배정이 노출된다. SECURITY DEFINER 로 실제 type 을 읽어야
--   이 취약점이 사라진다.

CREATE OR REPLACE FUNCTION public.is_pipeline_work_item(_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  -- _id 가 NULL 이면 서브쿼리가 0행 반환 → COALESCE → false
  SELECT COALESCE(
    (SELECT type = 'pipeline' FROM work_items WHERE id = _id),
    false
  )
$$;


-- ── 3. work_items SELECT 정책 교체 ───────────────────────────
-- 비-pipeline : app_can(view) 이상이면 조회 가능 (기존 동작 유지)
-- pipeline    : app_can(edit) 이상이어야 조회 가능
--              (admin은 app_can이 항상 true를 반환하므로 별도 분기 불필요)

DROP POLICY IF EXISTS work_items_select ON public.work_items;

CREATE POLICY work_items_select ON public.work_items
  FOR SELECT USING (
    CASE type
      WHEN 'pipeline' THEN app_can('work_item', id, 'edit')
      ELSE                  app_can('work_item', id, 'view')
    END
  );

-- INSERT / UPDATE / DELETE 정책은 기존 그대로 edit 권한을 요구한다.
-- (work_items_insert / work_items_update / work_items_delete 정책 유지)


-- ── 4. assignments SELECT 정책 교체 ──────────────────────────
-- pipeline 배정 : work_item에 대한 edit 권한 필요.
--                 self-view(본인 person_id) 경로를 명시적으로 차단.
-- 그 외 배정    : 기존 동작 유지 (person view 권한 또는 self-view)
--
-- is_pipeline_work_item() 이 SECURITY DEFINER이므로 pipeline work_item이
-- RLS로 숨겨져 있어도 올바르게 true 를 반환해 THEN 분기를 탄다.

DROP POLICY IF EXISTS assignments_select ON public.assignments;

CREATE POLICY assignments_select ON public.assignments
  FOR SELECT USING (
    CASE
      -- ── pipeline 배정 ────────────────────────────────────────
      -- work_item_id 가 NULL 인 leave 배정은 false → ELSE 분기
      WHEN is_pipeline_work_item(work_item_id) THEN
        app_can('work_item', work_item_id, 'edit')

      -- ── 비-pipeline 배정 (project·proposal·leave) ────────────
      ELSE
        app_can('person', person_id, 'view')
        OR EXISTS (
          SELECT 1
          FROM public.profiles p
          WHERE p.id        = auth.uid()
            AND p.person_id = assignments.person_id
        )
    END
  );

-- assignments INSERT / UPDATE / DELETE 정책은 변경하지 않는다.
-- (person edit 권한 요구, 기존 정책 그대로)


-- ── 5. accruals 및 기타 테이블 영향 없음 확인 ─────────────────
-- accruals.source(= work_item_id)는 pipeline work_item 을 가리킬 수
-- 있으나, accruals SELECT 정책은 person view 권한 기반이므로
-- 정책 변경이 필요하지 않다.
--
-- accruals 에서 source UUID 를 확보하더라도 사용자가 그 UUID 로
-- work_items 를 직접 조회하면 pipeline이라면 work_items_select 정책이
-- edit 권한을 요구해 차단한다.
--
-- 따라서 accruals / holidays / grants / audit_log / profiles / people
-- 의 기존 정책은 그대로 유지한다.
