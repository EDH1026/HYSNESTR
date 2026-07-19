-- =============================================================
-- Migration 0037: PRD v2.97 ADM-10 — 초대 계정 비밀번호 최초 설정 강제
-- =============================================================
-- 실행 순서: 0036 이후
-- 멱등 보장: ALTER TABLE ... ADD COLUMN IF NOT EXISTS, CREATE OR REPLACE, DROP POLICY IF EXISTS
--
-- 배경: Supabase Auth의 "Send invitation"(auth.admin.inviteUserByEmail)은 초대 링크를
-- 클릭하는 순간 곧바로 유효한 로그인 세션을 발급한다 — Supabase 자체에는 "비밀번호를
-- 설정하기 전까지 로그인을 막는" 기능이 없다. 세션 발급 자체를 지연시킬 수 없으므로,
-- "로그인은 됐지만 이 플래그가 꺼지기 전까지는 앱의 실제 기능에 접근 불가"로 막는다.
--
-- 변경 요약:
--   1. profiles.must_set_password 컬럼 추가 (기본 false)
--   2. handle_new_user() 트리거 함수 수정 — auth.users.invited_at이 채워진(=초대로
--      생성된) 계정만 must_set_password=true로 INSERT. CSV 일괄 업로드 등 invite를
--      거치지 않는 계정 생성 경로는 이 트리거를 타지 않거나 invited_at이 NULL이므로
--      영향받지 않는다(기본값 false 그대로).
--   3. profiles_update_self RLS 정책에 must_set_password 동결 조건 추가 — 본인이
--      일반 UPDATE로 이 컬럼을 바꾸는 경로를 RLS 자체로 차단한다(기존 global_role·
--      status·person_id 동결과 동일한 패턴). admin은 관리 목적상 그대로 변경 가능.
--   4. complete_password_setup() RPC 신설 — SECURITY DEFINER, auth.uid() 기준 본인
--      행만 must_set_password=false로 전환. RLS를 우회하므로 이 RPC를 통해서만
--      false로 바뀔 수 있는 유일한 경로가 된다.
-- =============================================================


-- ════════════════════════════════════════════════════════════
-- 1. 컬럼 추가
-- ════════════════════════════════════════════════════════════

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS must_set_password boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.profiles.must_set_password IS
  'PRD v2.97 ADM-10: true면 비밀번호를 아직 설정하지 않은 초대 계정 — '
  '전역 라우트 가드가 비밀번호 설정 페이지 외 모든 화면을 차단한다. '
  'complete_password_setup() RPC를 통해서만 false로 전환 가능(RLS로 일반 UPDATE 차단).';


-- ════════════════════════════════════════════════════════════
-- 2. handle_new_user() — 초대 계정만 must_set_password=true로 생성
-- ════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id, name, global_role, status, must_set_password)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'name', NEW.email),
    'viewer',   -- 기본 역할; 관리자가 별도로 승격
    'active',
    -- auth.admin.inviteUserByEmail()로 생성된 사용자만 auth.users.invited_at이 채워진다
    -- (Dashboard의 "Invite user"와 invite-user Edge Function 둘 다 동일하게 이 컬럼을
    -- 채우므로, 초대 경로가 무엇이든 이 트리거 하나로 정확히 판별된다).
    (NEW.invited_at IS NOT NULL)
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;


-- ════════════════════════════════════════════════════════════
-- 3. profiles_update_self — must_set_password 동결
-- ════════════════════════════════════════════════════════════

DROP POLICY IF EXISTS profiles_update_self ON public.profiles;

CREATE POLICY profiles_update_self ON public.profiles
  FOR UPDATE
  USING (id = auth.uid())
  WITH CHECK (
    id          = auth.uid()
    AND global_role = (SELECT p.global_role FROM public.profiles p WHERE p.id = auth.uid())
    AND status      = (SELECT p.status      FROM public.profiles p WHERE p.id = auth.uid())
    AND person_id   IS NOT DISTINCT FROM
                      (SELECT p.person_id   FROM public.profiles p WHERE p.id = auth.uid())
    AND must_set_password = (SELECT p.must_set_password FROM public.profiles p WHERE p.id = auth.uid())
  );


-- ════════════════════════════════════════════════════════════
-- 4. complete_password_setup() — 유일한 false 전환 경로
-- ════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.complete_password_setup()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'FORBIDDEN: 로그인이 필요합니다.';
  END IF;

  -- SECURITY DEFINER → RLS(profiles_update_self의 must_set_password 동결 조건)를 우회하여
  -- 본인 행의 must_set_password만 false로 전환한다.
  UPDATE public.profiles
     SET must_set_password = false
   WHERE id = auth.uid();
END;
$$;

COMMENT ON FUNCTION public.complete_password_setup() IS
  'PRD v2.97 ADM-10: 초대 계정이 새 비밀번호 설정을 완료한 뒤 호출 — '
  '본인의 profiles.must_set_password를 false로 전환하는 유일한 경로(SECURITY DEFINER).';


-- ════════════════════════════════════════════════════════════
-- 검증
-- ════════════════════════════════════════════════════════════

NOTIFY pgrst, 'reload schema';

SELECT column_name, data_type, column_default
  FROM information_schema.columns
 WHERE table_schema='public' AND table_name='profiles' AND column_name='must_set_password';

SELECT proname FROM pg_proc WHERE proname = 'complete_password_setup';

SELECT 'migration 0037 (v2.97 must_set_password) done' AS result;
