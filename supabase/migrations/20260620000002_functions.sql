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
