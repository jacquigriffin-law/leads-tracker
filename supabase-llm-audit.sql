-- LeadFlow LLM Processing Audit Log
-- Run in Supabase SQL editor after supabase-schema.sql.
--
-- PURPOSE: records every call to an LLM that involves lead or email data.
-- IMPORTANT: this table must NEVER store raw email bodies, full message content,
-- or extracted PII. Only metadata and summary fields are permitted here.
-- The source of truth for lead data is the leads table, not this log.
--
-- RETENTION: 7 years minimum (NSW legal practice rules, LPU Rule 14).

-- ── llm_processing_log table ─────────────────────────────────────────────────

create table if not exists public.llm_processing_log (
  id                        uuid primary key default gen_random_uuid(),
  user_id                   uuid references auth.users(id) on delete set null,
  user_email                text,
  lead_id                   text,           -- reference to leads.id (as text for flexibility)
  source_label              text,           -- mailbox label e.g. 'JGMS', 'FLA'
  model_id                  text not null,  -- e.g. 'claude-sonnet-4-6'
  prompt_tokens             int,
  completion_tokens         int,
  injection_risk_detected   boolean not null default false,
  pii_redacted              boolean not null default false,
  extraction_schema_version text,           -- version string of LLM_EXTRACTION_SCHEMA used
  requires_human_review     boolean not null default true,  -- always true; enforced by insert function
  output_summary            text,           -- human-readable triage summary only — no raw LLM output containing PII
  created_at                timestamptz not null default timezone('utc', now())
);

comment on table public.llm_processing_log is
  'Audit trail for every LLM call that touches lead or email data. '
  'Retain 7 years minimum (NSW legal practice rules). '
  'Never store raw email bodies or PII here — summaries and metadata only. '
  'requires_human_review is always true; LLM output must not be actioned without practitioner sign-off.';

comment on column public.llm_processing_log.output_summary is
  'Human-readable triage hint only (e.g. "matter_type: family_law, urgency: urgent"). '
  'Must not contain names, contact details, or verbatim email content.';

comment on column public.llm_processing_log.injection_risk_detected is
  'True when the email snippet triggered a prompt-injection pattern check. '
  'If true, the LLM call should have been aborted — log the block event instead.';

-- ── Row-level security ────────────────────────────────────────────────────────

alter table public.llm_processing_log enable row level security;

-- Narrow table privileges: authenticated users may SELECT only.
-- All inserts flow through the security-definer function below.
revoke all on public.llm_processing_log from anon, authenticated;
grant select on public.llm_processing_log to authenticated;

-- Each user can read their own LLM processing log entries.
drop policy if exists "users can read own llm log entries" on public.llm_processing_log;
create policy "users can read own llm log entries"
on public.llm_processing_log for select
using (auth.uid() = user_id);

-- Practice owner can read ALL entries for compliance review.
drop policy if exists "practice owner can read all llm log entries" on public.llm_processing_log;
create policy "practice owner can read all llm log entries"
on public.llm_processing_log for select
using (
  (auth.jwt() ->> 'email') = 'jacquigriffin@mobilesolicitor.com.au'
);

-- ── Insert function (security definer) ───────────────────────────────────────
-- This is the ONLY permitted route for writing to llm_processing_log.
-- No user or application role may INSERT directly.
-- Called from server-side code only (Vercel serverless, never from the browser).

create or replace function public.log_llm_processing(
  p_lead_id                   text      default null,
  p_source_label              text      default null,
  p_model_id                  text      default 'unknown',
  p_prompt_tokens             int       default null,
  p_completion_tokens         int       default null,
  p_injection_risk_detected   boolean   default false,
  p_pii_redacted              boolean   default false,
  p_extraction_schema_version text      default null,
  p_output_summary            text      default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id  uuid;
  v_email    text;
  v_id       uuid;
begin
  v_user_id := auth.uid();
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;

  v_email := coalesce(auth.jwt() ->> 'email', 'unknown');

  -- Enforce: requires_human_review is always true regardless of caller input.
  insert into public.llm_processing_log (
    user_id, user_email, lead_id, source_label, model_id,
    prompt_tokens, completion_tokens,
    injection_risk_detected, pii_redacted,
    extraction_schema_version, requires_human_review,
    output_summary
  ) values (
    v_user_id, v_email, p_lead_id, p_source_label, p_model_id,
    p_prompt_tokens, p_completion_tokens,
    coalesce(p_injection_risk_detected, false), coalesce(p_pii_redacted, false),
    p_extraction_schema_version, true,  -- always true
    p_output_summary
  ) returning id into v_id;

  return v_id;
end;
$$;

revoke all on function public.log_llm_processing(text, text, text, int, int, boolean, boolean, text, text) from public;
grant execute on function public.log_llm_processing(text, text, text, int, int, boolean, boolean, text, text) to authenticated;

-- ── Retention guidance ────────────────────────────────────────────────────────
-- Minimum retention: 7 years (NSW LPU Rule 14 — matter records and compliance logs).
--
-- Manual deletion query (review carefully before executing):
--   delete from public.llm_processing_log
--   where created_at < now() - interval '7 years';
--
-- Automated retention function (schedule via pg_cron after the schema is stable):
--
-- create or replace function public.purge_expired_llm_logs()
-- returns void language plpgsql security definer set search_path = public as $$
-- begin
--   delete from public.llm_processing_log
--   where created_at < now() - interval '7 years';
-- end; $$;
--
-- Enable pg_cron: Supabase Dashboard → Database → Extensions → pg_cron
-- Then schedule:
--   select cron.schedule(
--     'purge-expired-llm-logs',
--     '0 4 * * 0',   -- 04:00 UTC every Sunday
--     'select public.purge_expired_llm_logs()'
--   );
