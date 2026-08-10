-- =============================================================
-- Migration 0050: PRD v2.126 — TOTP 2단계 인증을 선택이 아닌 필수로 (RLS)
-- =============================================================
-- 실행 순서: 0049 이후
-- 멱등 보장: CREATE OR REPLACE FUNCTION
--
-- ⚠️ 적용 전 필수 확인: PRD v2.126 클라이언트 커밋(AuthGuard의 mfaSetupRequired
--    → /mfa-setup 강제 이동, MfaSetupPage 신설)이 실제 배포되어 있어야 한다.
--    이 마이그레이션은 TOTP를 등록하지 않은 계정도 aal2가 아니면 모든
--    public.* 데이터 접근을 차단한다 — 클라이언트가 배포되지 않은 상태에서
--    적용하면 아직 아무도 등록을 안 했으므로 전원(관리자 포함)이 빈 화면만
--    보게 된다. 배포 확인 후에만 이 파일을 db push 할 것.
--
-- 배경:
--   0049는 "TOTP를 등록한 계정만" aal2를 요구했다(opt-in) — 등록하지 않은
--   계정은 그대로 비밀번호만으로 통과했다. "MFA 미등록이면 아예 정보를
--   못 보게 해야 하는 것 아닌가"라는 피드백에 따라 opt-in 예외를 제거한다.
--
-- 방식:
--   mfa_satisfied()에서 "verified factor가 없으면 통과" 분기를 제거하고
--   무조건 aal2 세션인지만 확인한다. 등록 직후 verify() 성공 시 세션이
--   자동으로 aal2로 올라가므로(MFA_CHALLENGE_VERIFIED), 등록을 막 마친
--   계정은 곧바로 통과한다 — 별도 재로그인 불필요.
--
-- 영향받지 않는 경로 (확인됨, §"알려진 한계" 문서 참고):
--   · profiles_select/grants_select의 "본인 행" 규칙(id/user_id = auth.uid())은
--     is_admin()을 거치지 않으므로 이 게이트와 무관 — 로그인 직후 자기 프로필은
--     항상 읽힌다(그래야 /mfa-setup 화면 자체가 뜬다).
--   · TOTP enroll()/challenge()/verify()는 Supabase Auth 서비스 호출이라
--     RLS와 무관 — aal1 상태에서도 정상 동작한다.
--
-- 롤백:
--   문제 발생 시 mfa_satisfied()를 0049의 정의(verified factor 없으면
--   무조건 true)로 재실행하면 즉시 opt-in 상태로 되돌아간다.
-- =============================================================

CREATE OR REPLACE FUNCTION public.mfa_satisfied()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT (auth.jwt() ->> 'aal') = 'aal2'
$$;

COMMENT ON FUNCTION public.mfa_satisfied() IS
  '모든 계정에 aal2(2단계 인증 완료) 세션을 무조건 요구한다 — TOTP 미등록 '
  '계정은 /mfa-setup에서 등록을 마쳐야 통과. (PRD v2.126, opt-in이었던 '
  'v2.125에서 전환)';

NOTIFY pgrst, 'reload schema';

SELECT 'migration 0050 (v2.126 TOTP mandatory) done' AS result;
