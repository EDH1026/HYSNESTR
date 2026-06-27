-- =============================================================
-- Migration 0019: HOL-4 holiday source column + sync log table
-- =============================================================

-- ── Add source column to holidays ────────────────────────────
-- 'manual' = admin-added (never overwritten by auto-sync)
-- 'auto'   = synced from public holiday API

ALTER TABLE public.holidays
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'manual'
    CHECK (source IN ('auto', 'manual'));

COMMENT ON COLUMN public.holidays.source IS
  'auto = API-synced; manual = admin-added (HOL-4: auto-sync never overwrites manual rows)';

-- Back-fill existing rows as manual (they were all added by humans)
UPDATE public.holidays SET source = 'manual' WHERE source IS NULL;

-- ── holiday_sync_log: record every sync run ───────────────────

CREATE TABLE IF NOT EXISTS public.holiday_sync_log (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  synced_at    timestamptz NOT NULL DEFAULT now(),
  year_range   text        NOT NULL,          -- e.g. '2026~2027'
  added        int         NOT NULL DEFAULT 0,
  updated      int         NOT NULL DEFAULT 0,
  total        int         NOT NULL DEFAULT 0, -- API items with isHoliday='Y'
  error        text,                           -- partial/full error description
  triggered_by uuid        REFERENCES auth.users(id) ON DELETE SET NULL
);

COMMENT ON TABLE public.holiday_sync_log IS 'Record of each auto-sync run (HOL-5)';

ALTER TABLE public.holiday_sync_log ENABLE ROW LEVEL SECURITY;

-- All authenticated users may read the log (admins see it in the UI)
CREATE POLICY "sync_log_select" ON public.holiday_sync_log
  FOR SELECT TO authenticated USING (true);

-- INSERT is performed by the edge function using the service role key,
-- which bypasses RLS — no explicit INSERT policy needed here.
