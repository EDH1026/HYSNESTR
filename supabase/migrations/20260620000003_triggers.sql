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
