-- LeadFlow RLS upgrade: email-whitelist access policy for leads table
-- Run this in Supabase Dashboard → SQL Editor AFTER confirming leads are
-- imported and you can sign in successfully.
--
-- What this does:
--   Drops the broad "authenticated users can read leads" policy and replaces
--   it with an explicit email allow-list. Only the named email addresses can
--   read lead records — any other authenticated Supabase user is blocked at
--   the database level.
--
-- Step 1: Update the email array below with all authorised practice members.
-- Step 2: Verify by running:
--   select policyname, cmd, qual from pg_policies where tablename = 'leads';
-- Step 3: Paste and run this script in the SQL editor.
-- Step 4: Sign in as a non-listed address and confirm you see no leads.

begin;

alter table public.leads enable row level security;
revoke all on public.leads from anon, authenticated;
grant select on public.leads to authenticated;

drop policy if exists "authenticated users can read leads" on public.leads;
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

commit;

-- Verify:
-- select policyname from pg_policies where tablename = 'leads';
-- Expected: "whitelisted users can read leads" only.
