-- =============================================================
-- Migration 0030: PRD v2.76 §5.14 TSG-12
-- =============================================================
-- 변경 요약:
--   timesheet_guideline_documents 테이블 생성
--   RLS: editor/admin → SELECT/INSERT, assistant → SELECT
-- =============================================================

CREATE TABLE IF NOT EXISTS public.timesheet_guideline_documents (
  id           uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  generated_at timestamptz  NOT NULL DEFAULT now(),
  generated_by uuid         REFERENCES auth.users(id),
  window_start date         NOT NULL,
  window_end   date         NOT NULL,
  content      jsonb        NOT NULL
);

COMMENT ON TABLE public.timesheet_guideline_documents IS
  'TSG-12: 특정 시점의 타임시트 지침 매트릭스 전체를 JSON으로 보관. '
  '반영(timesheet_guideline_snapshot)과 독립된 순수 기록용. (PRD v2.76)';

ALTER TABLE public.timesheet_guideline_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.timesheet_guideline_documents FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tgd_select ON public.timesheet_guideline_documents;
DROP POLICY IF EXISTS tgd_insert ON public.timesheet_guideline_documents;

-- SELECT: editor / admin / assistant
CREATE POLICY tgd_select ON public.timesheet_guideline_documents
  FOR SELECT USING (
    my_role() IN ('admin', 'editor', 'assistant')
  );

-- INSERT: editor / admin 전용
CREATE POLICY tgd_insert ON public.timesheet_guideline_documents
  FOR INSERT WITH CHECK (
    my_role() IN ('admin', 'editor')
  );

SELECT 'migration 0030 (v2.76 TSG-12 guideline_documents) done' AS result;
