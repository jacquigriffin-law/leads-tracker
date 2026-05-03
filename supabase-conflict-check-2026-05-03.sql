-- ── Migration: Conflict Check tracking ──────────────────────────────────────
-- Date:    2026-05-03
-- Author:  ISA Ops (automated)
-- Purpose: Add optional conflict_status and conflict_notes columns to the
--          existing lead_states table to support per-lead conflict checking.
--
-- BACKWARD COMPATIBLE: all new columns are nullable with no default that would
-- break existing rows. The app works with or without this migration applied
-- (it silently omits new fields on save if the columns do not exist, matching
-- the same graceful-fallback pattern used by prospective_status/follow_up_date).
--
-- HOW TO APPLY:
--   Paste this file into the Supabase SQL Editor and run it.
--   It is idempotent — safe to run more than once.
--
-- DO NOT apply to production without a practitioner review of RLS policies.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Add conflict_status column (nullable text)
ALTER TABLE public.lead_states
  ADD COLUMN IF NOT EXISTS conflict_status TEXT;

-- 2. Add conflict_notes column (nullable text)
ALTER TABLE public.lead_states
  ADD COLUMN IF NOT EXISTS conflict_notes TEXT;

-- 3. Constrain conflict_status to defined lifecycle values
--    Drop constraint first so the migration is idempotent.
ALTER TABLE public.lead_states
  DROP CONSTRAINT IF EXISTS lead_states_conflict_status_check;

ALTER TABLE public.lead_states
  ADD CONSTRAINT lead_states_conflict_status_check
  CHECK (
    conflict_status IS NULL OR
    conflict_status IN (
      'requested',
      'clear',
      'needs_review',
      'possible_conflict',
      'blocked'
    )
  );

-- 4. Column documentation
COMMENT ON COLUMN public.lead_states.conflict_status IS
  'Conflict check lifecycle status. Values: requested | clear | needs_review | possible_conflict | blocked';

COMMENT ON COLUMN public.lead_states.conflict_notes IS
  'Free-text notes from the conflict check — outcome, parties checked, date requested, etc.';

-- 5. Index for fast conflict queries
CREATE INDEX IF NOT EXISTS idx_lead_states_conflict_status
  ON public.lead_states (conflict_status)
  WHERE conflict_status IS NOT NULL;

-- ── End of migration ──────────────────────────────────────────────────────────
