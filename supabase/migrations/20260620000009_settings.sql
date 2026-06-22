-- =============================================================
-- Migration 0009: App settings (dashboard §8)
-- =============================================================
-- Single-row settings table (enforced by PK = 1 check).
-- fiscal_year_start_month: 1=Jan … 12=Dec  (EY Korea default: 4=Apr)
-- =============================================================

CREATE TABLE IF NOT EXISTS public.settings (
  id                      integer  PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  fiscal_year_start_month integer  NOT NULL DEFAULT 4
    CHECK (fiscal_year_start_month BETWEEN 1 AND 12)
);

-- Seed the single row
INSERT INTO public.settings (id) VALUES (1) ON CONFLICT DO NOTHING;

-- RLS (FORCE: postgres direct connections also enforced, consistent with 0004)
ALTER TABLE public.settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.settings FORCE ROW LEVEL SECURITY;

-- All authenticated users can read settings (needed by dashboard)
DROP POLICY IF EXISTS settings_select ON public.settings;
CREATE POLICY settings_select ON public.settings
  FOR SELECT USING (auth.role() = 'authenticated');

-- Only admin can update
DROP POLICY IF EXISTS settings_update ON public.settings;
CREATE POLICY settings_update ON public.settings
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = auth.uid()
        AND global_role = 'admin'
        AND status = 'active'
    )
  );
