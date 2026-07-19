-- =============================================================
-- Migration 0038: PRD v2.98 ADM-10 정정 — 초대 계정 게이트 우회 버그 수정
-- =============================================================
-- 실행 순서: 0037 이후
-- 멱등 보장: CREATE OR REPLACE, 백필 UPDATE는 조건에 맞는 행이 없으면 no-op
--
-- 근본 원인 (실제 라이브 데이터로 확인):
--   auth.users 행이 생성되는 시점(INSERT)에는 invited_at이 아직 NULL이고,
--   Supabase Auth가 그 직후 별도 UPDATE로 invited_at을 채운다(관찰된 간격 ~4ms).
--   0037의 handle_new_user()는 AFTER INSERT 트리거에서 NEW.invited_at을 읽으므로
--   초대 경로(앱이든 Supabase Dashboard든 무관하게) 항상 NULL을 보게 되어
--   must_set_password가 절대 true로 세팅될 수 없었다 — Dashboard 직접 초대가
--   원인이 아니라 이 조건 자체가 구조적으로 성립 불가능했다.
--
-- 수정 방향: "invite 시점 판별"을 포기하고 "신규 계정은 기본 잠금"으로 반전한다.
--   auth.users에 새 행이 생기는 경로는 초대(앱 Edge Function 또는 Supabase
--   Dashboard의 Invite/Create user) 뿐이며(CSV 일괄 업로드는 people/work_items만
--   건드리고 auth.users를 전혀 만들지 않음 — BulkUploadPanel.tsx 확인됨), 자체
--   회원가입(auth.signUp) 경로도 이 프로젝트엔 없다. 따라서 모든 신규 계정을
--   기본적으로 잠가도 안전하다.
--
-- 변경 요약:
--   1. handle_new_user() — invited_at 체크 제거, 신규 profiles 행은 항상
--      must_set_password = true로 생성.
--   2. AuthGuard(클라이언트, 별도 커밋)는 profiles 조회 실패/행 없음(no row)도
--      "차단"으로 처리하도록 fail-closed 전환 — 이 마이그레이션과 별개로 수정.
--   3. 일회성 백필 — 이번에 실제로 문제 됐던, 초대는 됐으나 아직 비밀번호를
--      설정한 적 없는 계정만 신중하게 골라 true로 되돌린다. 대상 기준:
--        - auth.users.invited_at이 NOT NULL (초대 경로로 생성됨)
--        - profiles.must_set_password가 현재 false
--        - auth.users.last_sign_in_at이 confirmed_at으로부터 1분 이내
--          (= 초대 링크 클릭 시점의 자동 로그인 1회뿐, 그 이후 실제 비밀번호로
--          재로그인한 이력이 없다는 뜻 — 이미 정상적으로 비밀번호를 설정해 쓰고
--          있는 계정은 last_sign_in_at이 confirmed_at보다 훨씬 뒤로 벌어져 있으므로
--          이 조건에 걸리지 않는다)
--      admin 계정(eudong.hwang@gmail.com)과 기존 테스트 계정(invited_at NULL,
--      즉 Dashboard "Create user"로 직접 만들어져 애초에 초대 경로가 아닌 계정)은
--      이 조건에 해당하지 않아 잠기지 않는다.
-- =============================================================


-- ════════════════════════════════════════════════════════════
-- 1. handle_new_user() — 신규 계정은 무조건 must_set_password = true
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
    'viewer',
    'active',
    -- v2.98: invited_at은 이 INSERT 시점엔 아직 채워지지 않는 경우가 있어
    -- 신뢰할 수 없는 판별 기준이었다(0037의 버그). auth.users를 만드는 유일한
    -- 경로가 초대(앱/Dashboard)뿐이므로 신규 계정은 항상 true로 시작한다.
    true
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

COMMENT ON COLUMN public.profiles.must_set_password IS
  'PRD v2.98 ADM-10: true면 아직 스스로 비밀번호를 설정한 적 없는 계정 — '
  '전역 라우트 가드가 비밀번호 설정 페이지 외 모든 화면을 차단한다. 모든 신규 '
  '계정(auth.users INSERT 트리거)이 기본 true로 생성되며, '
  'complete_password_setup() RPC를 통해서만 false로 전환 가능(RLS로 일반 UPDATE 차단).';


-- ════════════════════════════════════════════════════════════
-- 2. 일회성 백필 — 이미 초대됐지만 아직 비번 설정 안 한 계정만 정정
-- ════════════════════════════════════════════════════════════

UPDATE public.profiles p
   SET must_set_password = true
  FROM auth.users u
 WHERE p.id = u.id
   AND u.invited_at IS NOT NULL
   AND p.must_set_password = false
   AND u.last_sign_in_at IS NOT NULL
   AND u.confirmed_at IS NOT NULL
   AND u.last_sign_in_at - u.confirmed_at < interval '1 minute';


-- ════════════════════════════════════════════════════════════
-- 검증
-- ════════════════════════════════════════════════════════════

NOTIFY pgrst, 'reload schema';

SELECT u.email, u.invited_at, u.last_sign_in_at, u.confirmed_at, p.must_set_password
  FROM auth.users u JOIN public.profiles p ON p.id = u.id
 ORDER BY u.created_at DESC;

SELECT 'migration 0038 (v2.98 must_set_password fix) done' AS result;
