-- LeadFlow hotfix: remove auth.users lookup from RLS policies/functions.
-- Error fixed: "permission denied for table users" after sign-in.
-- Run in Supabase SQL Editor for the LeadFlow project.

-- 1) Leads allow-list policy: use email claim from the signed-in JWT.
drop policy if exists "whitelisted users can read leads" on public.leads;
create policy "whitelisted users can read leads"
on public.leads for select
using (
  auth.role() = 'authenticated'
  and (auth.jwt() ->> 'email') = any(array[
    'jacquigriffin@mobilesolicitor.com.au'
  ])
);

-- 2) Audit/access log owner policies: avoid auth.users reads in policy checks.
drop policy if exists "practice owner can read all audit log entries" on public.lead_audit_log;
create policy "practice owner can read all audit log entries"
on public.lead_audit_log for select
using ((auth.jwt() ->> 'email') = 'jacquigriffin@mobilesolicitor.com.au');

drop policy if exists "practice owner can read all access log entries" on public.lead_access_log;
create policy "practice owner can read all access log entries"
on public.lead_access_log for select
using ((auth.jwt() ->> 'email') = 'jacquigriffin@mobilesolicitor.com.au');

-- 3) Update logging functions to use the JWT email claim, not auth.users.
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

  v_email := coalesce(auth.jwt() ->> 'email', 'unknown');

  insert into public.lead_access_log (user_id, user_email, event_type, target_id, metadata)
  values (v_user_id, v_email, p_event_type, p_target_id, p_metadata);
end;
$$;

create or replace function public.audit_lead_state_changes()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid;
  v_email text;
  v_action text;
  v_changed jsonb;
begin
  v_user_id := auth.uid();
  v_email := coalesce(auth.jwt() ->> 'email', 'unknown');
  v_action := lower(TG_OP);

  if TG_OP = 'INSERT' then
    v_changed := to_jsonb(NEW);
  elsif TG_OP = 'UPDATE' then
    v_changed := jsonb_strip_nulls(jsonb_build_object(
      'old', to_jsonb(OLD),
      'new', to_jsonb(NEW)
    ));
  elsif TG_OP = 'DELETE' then
    v_changed := to_jsonb(OLD);
  end if;

  insert into public.lead_audit_log (user_id, user_email, action, table_name, record_id, changed_fields)
  values (v_user_id, v_email, v_action, TG_TABLE_NAME, coalesce(NEW.lead_id, OLD.lead_id), v_changed);

  return coalesce(NEW, OLD);
end;
$$;

-- 4) If the optional LLM audit table exists, patch its owner policy/function too.
do $$
begin
  if to_regclass('public.llm_processing_log') is not null then
    drop policy if exists "practice owner can read all llm log entries" on public.llm_processing_log;
    create policy "practice owner can read all llm log entries"
    on public.llm_processing_log for select
    using ((auth.jwt() ->> 'email') = 'jacquigriffin@mobilesolicitor.com.au');
  end if;
end $$;

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

  if to_regclass('public.llm_processing_log') is null then
    raise exception 'llm_processing_log table does not exist. Run supabase-llm-audit.sql first.';
  end if;

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
    p_extraction_schema_version, true,
    p_output_summary
  ) returning id into v_id;

  return v_id;
end;
$$;

-- 5) Quick policy check.
select schemaname, tablename, policyname, cmd, qual
from pg_policies
where schemaname = 'public'
  and tablename in ('leads', 'lead_audit_log', 'lead_access_log', 'llm_processing_log')
order by tablename, policyname;
