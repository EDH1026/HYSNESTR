-- =============================================================
-- Migration 0031: PRD v2.77 §5.14 TSG-12
-- =============================================================
-- 변경 요약:
--   timesheet_guideline_documents에 DELETE 정책 추가
--   (이 지침 반영 시 전체 삭제 / 개별 삭제 기능 지원)
-- =============================================================

DROP POLICY IF EXISTS tgd_delete ON public.timesheet_guideline_documents;

-- DELETE: editor / admin 전용
CREATE POLICY tgd_delete ON public.timesheet_guideline_documents
  FOR DELETE USING (
    my_role() IN ('admin', 'editor')
  );

SELECT 'migration 0031 (v2.77 TSG-12 tgd_delete_policy) done' AS result;
