-- LeadFlow Supabase retention/archive automation
-- Run manually in Supabase SQL Editor as the project owner.
-- Safe default: archives eligible leads; does NOT delete source lead rows unless
-- p_delete_after_archive=true is explicitly passed.
--
-- Approved policy recorded 28 Apr 2026:
--   • new/active/actioned leads stay while active or while a matter exists
--   • declined/no_action/not_suitable leads are reviewed after 90 days
--   • eligible inactive leads may be archived/deleted unless needed
--   • lead_access_log, lead_audit_log, and llm_processing_log kept 12 months
--   • raw email bodies/attachments are not stored in LeadFlow

create extension if not exists pgcrypto;

-- Optional. Supabase may require enabling this in Dashboard → Database → Extensions.
-- create extension if not exists pg_cron;

-- ── Archive table ────────────────────────────────────────────────────────────
-- Stores a privacy-minimised snapshot for governance evidence before optional
-- source-row deletion. It intentionally does not store draft_reply, raw_preview,
-- notes, sender_email, sender_phone, or opposing_party.

create table if not exists public.lead_retention_archive (
  id uuid primary key default gen_random_uuid(),
  lead_id bigint not null,
  archived_at timestamptz not null default timezone('utc', now()),
  archived_by text not null default coalesce(auth.jwt() ->> 'email', current_user),
  archive_reason text not null,
  retention_policy_version text not null default '2026-04-28',
  delete_after_archive boolean not null default false,
  deleted_from_leads boolean not null default false,
  source_account text,
  date_received timestamptz,
  subject text,
  source_platform text,
  matter_type text,
  priority text,
  status text,
  reviewed_at timestamptz,
  created_at timestamptz,
  updated_at timestamptz,
  source_snapshot jsonb not null default '{}'::jsonb,
  unique (lead_id, retention_policy_version)
);

alter table public.lead_retention_archive enable row level security;
revoke all on public.lead_retention_archive from anon, authenticated;
grant select on public.lead_retention_archive to authenticated;

-- Practice owner can read archive register for governance/audit review.
drop policy if exists "practice owner can read retention archive" on public.lead_retention_archive;
create policy "practice owner can read retention archive"
on public.lead_retention_archive for select
using ((auth.jwt() ->> 'email') = 'jacquigriffin@mobilesolicitor.com.au');

-- ── Candidate report ─────────────────────────────────────────────────────────
-- Dry-run first. This returns rows that would be archived by the automation.

create or replace function public.retention_review_candidates(
  p_review_after interval default interval '90 days'
)
returns table (
  lead_id bigint,
  status text,
  priority text,
  matter_type text,
  date_received timestamptz,
  reviewed_at timestamptz,
  age_days integer,
  reason text
)
language sql
security definer
set search_path = public
as $$
  with state_flags as (
    select
      lead_id,
      bool_or(actioned) as any_actioned,
      bool_or(leap) as any_leap,
      bool_or(la_accepted) as any_la_accepted,
      bool_or(no_action) as any_no_action
    from public.lead_states
    group by lead_id
  )
  select
    l.id as lead_id,
    l.status,
    l.priority,
    l.matter_type,
    l.date_received,
    l.reviewed_at,
    floor(extract(epoch from (timezone('utc', now()) - coalesce(l.reviewed_at, l.updated_at, l.created_at))) / 86400)::integer as age_days,
    case
      when lower(coalesce(l.status, '')) in ('declined', 'no_action', 'no action', 'not_suitable', 'not suitable', 'not-suitable') then 'inactive status over review age'
      when coalesce(sf.any_no_action, false) then 'lead state marked no_action over review age'
      else 'eligible inactive lead over review age'
    end as reason
  from public.leads l
  left join state_flags sf on sf.lead_id = l.id
  left join public.lead_retention_archive a on a.lead_id = l.id and a.retention_policy_version = '2026-04-28'
  where a.lead_id is null
    and coalesce(l.reviewed_at, l.updated_at, l.created_at) < timezone('utc', now()) - p_review_after
    and not coalesce(sf.any_actioned, false)
    and not coalesce(sf.any_leap, false)
    and not coalesce(sf.any_la_accepted, false)
    and lower(coalesce(l.status, '')) not in ('new', 'active', 'actioned', 'open', 'opened', 'matter_opened', 'matter opened', 'accepted', 'la_accepted', 'legal aid accepted')
    and (
      lower(coalesce(l.status, '')) in ('declined', 'no_action', 'no action', 'not_suitable', 'not suitable', 'not-suitable', 'closed', 'not proceeding')
      or coalesce(sf.any_no_action, false)
    )
  order by coalesce(l.reviewed_at, l.updated_at, l.created_at) asc;
$$;

revoke all on function public.retention_review_candidates(interval) from public;
grant execute on function public.retention_review_candidates(interval) to authenticated;

-- ── Archive/purge function ───────────────────────────────────────────────────
-- Safe default: p_delete_after_archive=false, so this creates archive register
-- rows only. If Jacqui deliberately passes true, matching source leads are then
-- deleted from public.leads after archive insertion. lead_states cascade-delete
-- because of existing FK on delete cascade.

create or replace function public.run_lead_retention_archive(
  p_review_after interval default interval '90 days',
  p_delete_after_archive boolean default false
)
returns table (
  archived_count integer,
  deleted_count integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_archived integer := 0;
  v_deleted integer := 0;
begin
  -- Only Jacqui can run this from an authenticated SQL/API context.
  -- Supabase SQL editor as owner/service role also works for setup/admin use.
  if auth.uid() is not null and coalesce(auth.jwt() ->> 'email', '') <> 'jacquigriffin@mobilesolicitor.com.au' then
    raise exception 'Only the practice owner may run retention archive';
  end if;

  with candidates as (
    select c.lead_id, c.reason
    from public.retention_review_candidates(p_review_after) c
  ), inserted as (
    insert into public.lead_retention_archive (
      lead_id,
      archive_reason,
      delete_after_archive,
      source_account,
      date_received,
      subject,
      source_platform,
      matter_type,
      priority,
      status,
      reviewed_at,
      created_at,
      updated_at,
      source_snapshot
    )
    select
      l.id,
      c.reason,
      p_delete_after_archive,
      l.source_account,
      l.date_received,
      l.subject,
      l.source_platform,
      l.matter_type,
      l.priority,
      l.status,
      l.reviewed_at,
      l.created_at,
      l.updated_at,
      jsonb_strip_nulls(jsonb_build_object(
        'lead_id', l.id,
        'source_account', l.source_account,
        'date_received', l.date_received,
        'subject', l.subject,
        'source_platform', l.source_platform,
        'matter_type', l.matter_type,
        'priority', l.priority,
        'status', l.status,
        'reviewed_at', l.reviewed_at,
        'created_at', l.created_at,
        'updated_at', l.updated_at
      ))
    from candidates c
    join public.leads l on l.id = c.lead_id
    on conflict (lead_id, retention_policy_version) do nothing
    returning lead_id
  )
  select count(*) into v_archived from inserted;

  if p_delete_after_archive then
    with deleted as (
      delete from public.leads l
      using public.lead_retention_archive a
      where a.lead_id = l.id
        and a.retention_policy_version = '2026-04-28'
        and a.delete_after_archive = true
        and a.deleted_from_leads = false
      returning l.id
    ), marked as (
      update public.lead_retention_archive a
      set deleted_from_leads = true
      where a.lead_id in (select id from deleted)
        and a.retention_policy_version = '2026-04-28'
      returning a.lead_id
    )
    select count(*) into v_deleted from marked;
  end if;

  return query select v_archived, v_deleted;
end;
$$;

revoke all on function public.run_lead_retention_archive(interval, boolean) from public;
grant execute on function public.run_lead_retention_archive(interval, boolean) to authenticated;

-- ── Log retention ────────────────────────────────────────────────────────────
-- Approved policy: retain access/audit/LLM processing logs for 12 months.
-- This does not touch archived lead snapshots.

create or replace function public.purge_expired_leadflow_logs(
  p_keep_for interval default interval '12 months'
)
returns table (
  lead_access_deleted integer,
  lead_audit_deleted integer,
  llm_processing_deleted integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_access integer := 0;
  v_audit integer := 0;
  v_llm integer := 0;
begin
  if auth.uid() is not null and coalesce(auth.jwt() ->> 'email', '') <> 'jacquigriffin@mobilesolicitor.com.au' then
    raise exception 'Only the practice owner may run log retention purge';
  end if;

  delete from public.lead_access_log
  where created_at < timezone('utc', now()) - p_keep_for;
  get diagnostics v_access = row_count;

  delete from public.lead_audit_log
  where created_at < timezone('utc', now()) - p_keep_for;
  get diagnostics v_audit = row_count;

  if to_regclass('public.llm_processing_log') is not null then
    execute 'delete from public.llm_processing_log where created_at < timezone(''utc'', now()) - $1'
    using p_keep_for;
    get diagnostics v_llm = row_count;
  end if;

  return query select v_access, v_audit, v_llm;
end;
$$;

revoke all on function public.purge_expired_leadflow_logs(interval) from public;
grant execute on function public.purge_expired_leadflow_logs(interval) to authenticated;

-- ── Recommended first run ────────────────────────────────────────────────────
-- 1. Dry-run/report candidates:
--      select * from public.retention_review_candidates(interval '90 days');
--
-- 2. Archive only, non-destructive:
--      select * from public.run_lead_retention_archive(interval '90 days', false);
--
-- 3. Optional later, only after Jacqui confirms deletion is appropriate:
--      select * from public.run_lead_retention_archive(interval '90 days', true);
--
-- 4. Purge old logs older than 12 months:
--      select * from public.purge_expired_leadflow_logs(interval '12 months');

-- ── Optional pg_cron schedule ────────────────────────────────────────────────
-- Use after confirming pg_cron is available. This schedules quiet-time monthly
-- archive-only review at 3:15am Sydney time. Supabase cron runs in the database
-- timezone, usually UTC; 17:15 UTC is 3:15am AEST and 4:15am AEDT.
--
-- select cron.schedule(
--   'leadflow-retention-archive-monthly',
--   '15 17 27 * *',
--   $$select * from public.run_lead_retention_archive(interval '90 days', false);$$
-- );
--
-- select cron.schedule(
--   'leadflow-log-retention-monthly',
--   '30 17 27 * *',
--   $$select * from public.purge_expired_leadflow_logs(interval '12 months');$$
-- );
