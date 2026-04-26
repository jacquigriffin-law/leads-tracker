-- Leads Tracker Supabase schema
-- Run in Supabase SQL editor.
-- Sections: core tables, RLS, audit log, retention guidance.

create extension if not exists pgcrypto;

-- ── Core tables ───────────────────────────────────────────────────────────────

create table if not exists public.leads (
  id bigint primary key,
  source_account text,
  date_received timestamptz,
  sender_name text,
  sender_email text,
  sender_phone text,
  subject text,
  source_rule text,
  source_platform text,
  matter_type text,
  priority text,
  status text,
  notes text,
  draft_reply text,
  raw_preview text,
  reviewed_at timestamptz,
  location text,
  opposing_party text,
  next_action text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.lead_states (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  lead_id bigint not null references public.leads(id) on delete cascade,
  actioned boolean not null default false,
  leap boolean not null default false,
  no_action boolean not null default false,
  la_accepted boolean not null default false,
  comment text not null default '',
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique(user_id, lead_id)
);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = timezone('utc', now());
  return new;
end;
$$;

drop trigger if exists leads_set_updated_at on public.leads;
create trigger leads_set_updated_at
before update on public.leads
for each row execute function public.set_updated_at();

drop trigger if exists lead_states_set_updated_at on public.lead_states;
create trigger lead_states_set_updated_at
before update on public.lead_states
for each row execute function public.set_updated_at();

-- ── Row-level security ────────────────────────────────────────────────────────

alter table public.leads enable row level security;
alter table public.lead_states enable row level security;

-- Table privileges are kept narrow; RLS policies below still decide row access.
revoke all on public.leads from anon, authenticated;
revoke all on public.lead_states from anon, authenticated;
grant select on public.leads to authenticated;
grant select, insert, update, delete on public.lead_states to authenticated;

-- PRODUCTION: email-whitelist RLS — only named addresses can read leads.
-- Run supabase-rls-whitelist.sql (standalone script) to activate this policy
-- and simultaneously drop the broad starter policy below.
-- To verify which policy is active:
--   select policyname from pg_policies where tablename = 'leads';
drop policy if exists "whitelisted users can read leads" on public.leads;
create policy "whitelisted users can read leads"
on public.leads for select
using (
  auth.role() = 'authenticated'
  and (select email from auth.users where id = auth.uid())
    = any(array[
        'jacquigriffin@mobilesolicitor.com.au'
        -- add additional authorised email addresses here, one per line:
        -- 'assistant@mobilesolicitor.com.au',
        -- 'paralegal@familylawassist.net.au'
      ])
);

-- DANGER: broad starter policy — drop this once the whitelist policy above is
-- confirmed working. While both policies exist, the whitelist is redundant
-- because the broad policy will satisfy the OR-evaluation.
-- To drop: DROP POLICY "authenticated users can read leads" ON public.leads;
--
-- create policy "authenticated users can read leads"
-- on public.leads for select
-- using (auth.role() = 'authenticated');

-- No user can directly insert/update/delete leads — only service-role imports.
-- This prevents a compromised session from modifying source records.

drop policy if exists "authenticated users can read own lead state" on public.lead_states;
create policy "authenticated users can read own lead state"
on public.lead_states for select
using (auth.uid() = user_id);

drop policy if exists "authenticated users can insert own lead state" on public.lead_states;
create policy "authenticated users can insert own lead state"
on public.lead_states for insert
with check (auth.uid() = user_id);

drop policy if exists "authenticated users can update own lead state" on public.lead_states;
create policy "authenticated users can update own lead state"
on public.lead_states for update
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

drop policy if exists "authenticated users can delete own lead state" on public.lead_states;
create policy "authenticated users can delete own lead state"
on public.lead_states for delete
using (auth.uid() = user_id);

-- ── Audit log ─────────────────────────────────────────────────────────────────
-- Records who changed lead states and when.
-- Written only by the trigger function (security definer) — not by users directly.

create table if not exists public.lead_audit_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete set null,
  user_email text,
  action text not null,         -- 'INSERT', 'UPDATE', 'DELETE'
  table_name text not null,     -- 'lead_states'
  record_id text,               -- lead_id of the affected row
  changed_fields jsonb,         -- keys that changed (values omitted for privacy)
  created_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.lead_access_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete set null,
  user_email text,
  event_type text not null,
  target_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now())
);

alter table public.lead_audit_log enable row level security;
alter table public.lead_access_log enable row level security;

revoke all on public.lead_audit_log from anon, authenticated;
revoke all on public.lead_access_log from anon, authenticated;
grant select on public.lead_audit_log to authenticated;
grant select on public.lead_access_log to authenticated;

-- Users can read their own audit entries; no user can write directly.
drop policy if exists "users can read own audit log entries" on public.lead_audit_log;
create policy "users can read own audit log entries"
on public.lead_audit_log for select
using (auth.uid() = user_id);

-- Practice owner can read ALL audit log entries (cross-user review for compliance).
-- Replace the email address with the practice principal's address.
drop policy if exists "practice owner can read all audit log entries" on public.lead_audit_log;
create policy "practice owner can read all audit log entries"
on public.lead_audit_log for select
using (
  (select email from auth.users where id = auth.uid())
    = 'jacquigriffin@mobilesolicitor.com.au'
);

drop policy if exists "users can read own access log entries" on public.lead_access_log;
create policy "users can read own access log entries"
on public.lead_access_log for select
using (auth.uid() = user_id);

drop policy if exists "practice owner can read all access log entries" on public.lead_access_log;
create policy "practice owner can read all access log entries"
on public.lead_access_log for select
using (
  (select email from auth.users where id = auth.uid())
    = 'jacquigriffin@mobilesolicitor.com.au'
);

create or replace function public.log_lead_access_event(
  p_event_type text,
  p_target_id text default null,
  p_metadata jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid;
  v_email text;
begin
  v_user_id := auth.uid();
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;

  select email into v_email from auth.users where id = v_user_id;

  insert into public.lead_access_log (user_id, user_email, event_type, target_id, metadata)
  values (v_user_id, v_email, p_event_type, p_target_id, coalesce(p_metadata, '{}'::jsonb));
end;
$$;

revoke all on function public.log_lead_access_event(text, text, jsonb) from public;
grant execute on function public.log_lead_access_event(text, text, jsonb) to authenticated;

-- Audit trigger for lead_states changes.
create or replace function public.audit_lead_state_change()
returns trigger
language plpgsql
security definer  -- runs as table owner, bypassing RLS to write audit rows
set search_path = public
as $$
declare
  v_user_id uuid;
  v_lead_id text;
  v_changed jsonb;
  v_email text;
begin
  v_user_id := coalesce(new.user_id, old.user_id);
  v_lead_id := coalesce(new.lead_id, old.lead_id)::text;

  select email into v_email from auth.users where id = v_user_id;

  if TG_OP = 'UPDATE' then
    select jsonb_object_agg(key, true)
    into v_changed
    from jsonb_each(to_jsonb(new))
    where to_jsonb(new) ->> key is distinct from to_jsonb(old) ->> key
      and key not in ('updated_at');
  end if;

  insert into public.lead_audit_log (user_id, user_email, action, table_name, record_id, changed_fields)
  values (v_user_id, v_email, TG_OP, TG_TABLE_NAME, v_lead_id, v_changed);

  return coalesce(new, old);
end;
$$;

drop trigger if exists lead_states_audit on public.lead_states;
create trigger lead_states_audit
after insert or update or delete on public.lead_states
for each row execute function public.audit_lead_state_change();

-- ── Retention and deletion guidance ──────────────────────────────────────────
-- Under the Australian Privacy Act 1988 (and NSW legal practice obligations),
-- personal information must not be held longer than needed for its purpose.
--
-- Recommended schedule for this practice:
--   • Leads with status = 'declined' or 'no_action': purge after 12 months
--   • Leads with status = 'actioned' (matter opened): retain per matter file
--     retention rules (typically 7 years after matter closure)
--   • Audit log rows: retain for 7 years minimum
--   • lead_states rows: cascade-delete when lead is deleted
--
-- Manual deletion query (run in SQL editor, review before executing):
--   delete from public.leads
--   where status in ('declined', 'no_action')
--     and created_at < now() - interval '12 months';
--
-- Automated deletion function (schedule via pg_cron or a Supabase edge function):
--
-- create or replace function public.purge_expired_leads()
-- returns void language plpgsql security definer as $$
-- begin
--   delete from public.leads
--   where status in ('declined', 'no_action')
--     and created_at < now() - interval '12 months';
-- end;
-- $$;
--
-- Supabase Dashboard → Database → Extensions → enable pg_cron, then:
--   select cron.schedule('purge-expired-leads', '0 3 * * *', 'select public.purge_expired_leads()');

-- ── Example import from local data.json ───────────────────────────────────────
-- Use generate-supabase-import.mjs to produce an import SQL file, then run it
-- here via the SQL editor. Once leads are loaded into this table, update
-- config.js (supabase.enabled = true) and data.json is no longer needed.
--
-- insert into public.leads (id, source_account, date_received, sender_name, sender_email, subject, source_rule, source_platform, matter_type, priority, status, notes, draft_reply, raw_preview, reviewed_at)
-- values
--   (1, 'jacquigriffin@mobilesolicitor.com.au', '2026-03-27T00:00:00Z', 'Dylan Savage', 'Unknown', 'Legal inquiry from Dylan Savage', 'Lead classification system', 'mobilesolicitor.com.au', 'Fresh care matter (SHEPHERD)', 'URGENT', 'new', 'Father incarcerated, backup duty', '', 'Father incarcerated, backup duty', null)
-- on conflict (id) do update set
--   sender_name = excluded.sender_name,
--   sender_email = excluded.sender_email,
--   subject = excluded.subject,
--   source_platform = excluded.source_platform,
--   matter_type = excluded.matter_type,
--   priority = excluded.priority,
--   notes = excluded.notes,
--   raw_preview = excluded.raw_preview,
--   updated_at = timezone('utc', now());
