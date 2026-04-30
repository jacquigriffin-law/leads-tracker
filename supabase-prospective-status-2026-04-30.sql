-- ── Migration: Prospective Client / Follow-up tracking ────────────────────────
-- Date:    2026-04-30
-- Author:  ISA Ops (automated)
-- Purpose: Add a prospective-client lifecycle status and optional follow-up date
--          to the existing lead_states table.
--
-- BACKWARD COMPATIBLE: all new columns are nullable with no default that would
-- break existing rows.  The app works with or without this migration applied
-- (it silently omits new fields on save if the column does not exist).
--
-- HOW TO APPLY:
--   Paste this file into the Supabase SQL Editor and run it.
--   It is idempotent — safe to run more than once.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Add prospective_status column (nullable text)
ALTER TABLE public.lead_states
  ADD COLUMN IF NOT EXISTS prospective_status TEXT;

-- 2. Add follow_up_date column (nullable date — practitioner-set target date)
ALTER TABLE public.lead_states
  ADD COLUMN IF NOT EXISTS follow_up_date DATE;

-- 3. Constrain prospective_status to the defined lifecycle values
--    Drop constraint first so the migration is idempotent.
ALTER TABLE public.lead_states
  DROP CONSTRAINT IF EXISTS lead_states_prospective_status_check;

ALTER TABLE public.lead_states
  ADD CONSTRAINT lead_states_prospective_status_check
  CHECK (
    prospective_status IS NULL OR
    prospective_status IN (
      'new_lead',
      'contacted',
      'awaiting_reply',
      'awaiting_documents',
      'awaiting_legal_aid',
      'ready_for_leap',
      'opened_in_leap',
      'declined',
      'closed_no_response'
    )
  );

-- 4. Column documentation
COMMENT ON COLUMN public.lead_states.prospective_status IS
  'Prospective client lifecycle status. Values: new_lead | contacted | awaiting_reply | awaiting_documents | awaiting_legal_aid | ready_for_leap | opened_in_leap | declined | closed_no_response';

COMMENT ON COLUMN public.lead_states.follow_up_date IS
  'Practitioner-set target date for follow-up action (optional).';

-- 5. Index for fast follow-up queries
CREATE INDEX IF NOT EXISTS idx_lead_states_prospective_status
  ON public.lead_states (prospective_status)
  WHERE prospective_status IS NOT NULL;

-- ── End of migration ──────────────────────────────────────────────────────────
