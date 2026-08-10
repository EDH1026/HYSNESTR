-- =============================================================
-- Migration 0049: PRD v2.125 — TOTP 2단계 인증 서버측 강제 (RLS)
-- =============================================================
-- 실행 순서: 0048 이후
-- 멱등 보장: CREATE OR REPLACE FUNCTION
--
-- 배경:
--   클라이언트에 TOTP 등록 UI(MfaSetupModal)와 로그인 후 챌린지 화면
--   (MfaChallengePage)을 추가했다. 그것만으로는 UX 게이트일 뿐이다 —
--   MFA를 등록한 계정이라도 challenge를 건너뛰고 aal1(비밀번호만 확인된)
--   세션의 access token을 그대로 REST API에 사용하면 서버는 이를 막을
--   방법이 없었다(CLAUDE.md: "Never rely on client-side checks alone for
--   security"). 이 마이그레이션은 그 서버측 강제를 추가한다.
--
-- 방식:
--   1. public.mfa_satisfied() 신설 — 이 계정에 verified TOTP factor가
--      "없으면" 항상 true(기존과 동일하게 통과, MFA 미등록 계정은 영향 없음).
--      "있으면" 현재 세션의 JWT aal 클레임이 'aal2'일 때만 true.
--      (Supabase 공식 문서가 권장하는 auth.mfa_factors 기반 패턴과 동일)
--   2. app_can() / my_role() / is_admin() / is_assistant() — 이 앱의 RLS·RPC
--      권한 판단의 4개 주요 진입점(코드베이스 전체 grep으로 확인) 각각에
--      mfa_satisfied()를 AND 조건으로 추가. 넷 중 하나라도 통과 못 하면
--      NULL/false를 반환해 기존에 이미 "미인증·비활성 계정은 접근 불가"로
--      처리하던 모든 정책·RPC가 자동으로 aal1 세션도 동일하게 차단한다
--      (my_role() 반환값이 NULL이면 이미 FORBIDDEN 처리되는 것과 동일 경로).
--   3. settings_update 정책 — 위 4개 함수를 거치지 않고 profiles를 직접
--      조회해 admin 여부를 판단하던 유일하게 발견된 인라인 예외. is_admin()
--      호출로 교체(grep으로 "CREATE POLICY ... FROM public.profiles" 패턴을
--      전수 조사해 발견 — people_select 등 나머지는 app_can() 또는 "본인 행"
--      규칙이라 문제 없음).
--
-- 알려진 한계 (적용 전 반드시 확인) ─────────────────────────────
--   위 4개 함수 + settings_update가 이 프로젝트에서 발견된 권한 판단
--   진입점의 사실상 전부지만(grep 전수 조사 완료), 모든 SECURITY DEFINER
--   RPC 본문 내부 로직까지 한 줄씩 재검증하지는 못했다. 적용 전에:
--     · MFA를 등록한 테스트 계정으로 아직 challenge를 완료하지 않은 상태에서
--       주요 화면(대시보드/타임라인/관리자)이 실제로 차단되는지 확인
--     · 이상 없으면 admin 계정부터 먼저 MFA 등록을 권장하고 점진적으로 확대
--
-- 롤백:
--   문제 발생 시 app_can()/my_role()/is_admin()은 마이그레이션 0002·0007·
--   20260621000010_prd21_schema.sql의 정의로, is_assistant()는
--   20260626000018_assistant_role.sql의 정의로, settings_update 정책은
--   20260620000009_settings.sql의 정의로 각각 재실행하면 즉시 원복된다.
-- =============================================================

-- ── 1. mfa_satisfied() ───────────────────────────────────────

CREATE OR REPLACE FUNCTION public.mfa_satisfied()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    NOT EXISTS (
      SELECT 1 FROM auth.mfa_factors
      WHERE user_id = auth.uid() AND status = 'verified'
    )
    OR (auth.jwt() ->> 'aal') = 'aal2'
$$;

COMMENT ON FUNCTION public.mfa_satisfied() IS
  'TOTP factor를 등록하지 않은 계정은 항상 true. 등록한 계정은 현재 세션이 '
  'aal2(2단계 인증 완료)일 때만 true. (PRD v2.125)';

-- ── 2. app_can(): MFA 게이트 추가 ─────────────────────────────

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
    public.mfa_satisfied()
    AND (
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
    )
$$;

COMMENT ON FUNCTION public.app_can(text, uuid, text)
  IS 'editor/admin 전역 허용 + 명시적 grant. viewer는 본인 행 규칙으로 별도 처리. '
     'TOTP 등록 계정은 aal2 세션이어야 통과(PRD v2.125). (§6, 부록 B.2)';

-- ── 3. my_role(): MFA 게이트 추가 ─────────────────────────────

CREATE OR REPLACE FUNCTION public.my_role()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE WHEN public.mfa_satisfied() THEN global_role ELSE NULL END
  FROM   public.profiles
  WHERE  id     = auth.uid()
    AND  status = 'active'
$$;

COMMENT ON FUNCTION public.my_role()
  IS '현재 인증 사용자의 global_role(admin|editor|viewer). 미인증/비활성/'
     'TOTP 등록했는데 aal2 미완료 → NULL. (PRD v2.1 부록 B, v2.125)';

-- ── 4. is_admin(): MFA 게이트 추가 ────────────────────────────

CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.mfa_satisfied() AND EXISTS (
    SELECT 1
    FROM public.profiles
    WHERE id          = auth.uid()
      AND global_role = 'admin'
      AND status      = 'active'
  )
$$;

-- ── 5. is_assistant(): MFA 게이트 추가 (20260626000018_assistant_role.sql) ──

CREATE OR REPLACE FUNCTION public.is_assistant()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.mfa_satisfied() AND EXISTS (
    SELECT 1
    FROM public.profiles
    WHERE id          = auth.uid()
      AND global_role = 'assistant'
      AND status      = 'active'
  )
$$;

COMMENT ON FUNCTION public.is_assistant() IS
  'Returns true if the current user has global_role = ''assistant'' and is active, '
  'and (if enrolled) has completed the aal2 TOTP challenge (PRD v2.125).';

-- ── 6. settings_update 정책: is_admin() 인라인 중복 대신 재사용 ──
-- 기존 정책(20260620000009_settings.sql)은 app_can()/is_admin()을 거치지 않고
-- profiles를 직접 조회해 admin 여부를 판단했다 — mfa_satisfied() 게이트를
-- 우회하는 경로였으므로 is_admin() 호출로 교체한다.
-- 존재 여부를 먼저 확인한다(0047의 패턴과 동일) — 최초 적용 시도에서
-- public.settings 테이블 자체가 이 운영 DB에 없는 것으로 확인됐다
-- (0009에서 만들어졌어야 하나 현재 부재 — 별도로 조사 필요한 이슈이며
-- 이 마이그레이션의 본래 목적과 무관하므로 여기서는 막지 않고 건너뛴다).

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'settings'
  ) THEN
    EXECUTE 'DROP POLICY IF EXISTS settings_update ON public.settings';
    EXECUTE 'CREATE POLICY settings_update ON public.settings FOR UPDATE USING (public.is_admin())';
    RAISE NOTICE 'settings_update policy replaced with is_admin()';
  ELSE
    RAISE NOTICE 'public.settings table not found — skipping settings_update policy (see migration header)';
  END IF;
END;
$$;

NOTIFY pgrst, 'reload schema';

SELECT 'migration 0049 (v2.125 TOTP MFA aal2 enforcement) done' AS result;
