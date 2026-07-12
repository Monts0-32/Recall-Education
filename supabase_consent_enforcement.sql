-- ============================================================================
-- Recall Education — Consent enforcement migration
-- Run this ONCE in the Supabase SQL editor, on top of supabase_setup.sql.
-- It is idempotent: safe to re-run.
--
-- What this does:
--   1. Adds a `deleted_at` column to profiles (soft-delete).
--   2. Updates `check_parental_consent` so soft-deleted users are blocked
--      by the auth hook (returns "not found" as if the user doesn't exist).
--   3. Updates `grant_consent` to soft-delete the account on "denied".
--   4. Adds a pg_cron job that runs daily:
--        - soft-deletes under-16s whose consent has been pending for >3 days
--        - hard-deletes soft-deleted accounts older than 30 days
--
-- Run order matters: this assumes supabase_setup.sql has been applied
-- (profiles, parental_consents, grant_consent, check_parental_consent
-- all already exist).
-- ============================================================================

-- pg_cron ships separately from the rest of Postgres. It's available on
-- every Supabase project but isn't enabled by default. We try to enable
-- it here so the rest of the migration can just use cron.schedule().
-- If the extension is already enabled this is a no-op; if it's not
-- allowed in your plan, the create extension will fail with a clear
-- error and you can enable it manually in Dashboard → Database →
-- Extensions first, then re-run this file.
create extension if not exists pg_cron;

-- ---------- 1. SOFT-DELETE COLUMN -------------------------------------------

alter table public.profiles
  add column if not exists deleted_at timestamptz;

-- Index for the cron sweep (it scans for rows with deleted_at IS NOT NULL).
create index if not exists profiles_deleted_at_idx
  on public.profiles (deleted_at)
  where deleted_at is not null;

-- ---------- 2. CHECK_PARENTAL_CONSENT — also block soft-deleted users ------

create or replace function public.check_parental_consent(event jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  user_id uuid := (event->>'user_id')::uuid;
  p public.profiles%rowtype;
  auth_method text := event->>'authentication_method';
begin
  select * into p from public.profiles where id = user_id;

  if not found then
    return event; -- profile row not yet written; allow through (shouldn't happen)
  end if;

  -- Soft-deleted accounts are blocked from signing in entirely.
  if p.deleted_at is not null then
    raise exception 'account_removed'
      using errcode = '42501'; -- insufficient_privilege
  end if;

  if p.requires_parental_consent and p.consent_status <> 'granted' then
    -- Email-confirmation flow: the user just clicked the link in the
    -- "Confirm your email" message. We let this token through so the
    -- /auth/confirmed.html page can render the proper "waiting for
    -- your parent" UI. The dashboard's own check then blocks them
    -- from doing anything until consent is granted. Subsequent
    -- sign-ins (with authentication_method = 'password' or 'otp' or
    -- 'magiclink' for an already-confirmed user) will be blocked here.
    if auth_method = 'email/signup' then
      return event;
    end if;

    raise exception 'parental_consent_required'
      using errcode = '42501'; -- insufficient_privilege
  end if;

  return event;
end;
$$;

grant execute on function public.check_parental_consent(jsonb) to supabase_auth_admin;

-- ---------- 3. GRANT_CONSENT — soft-delete on denied ------------------------

create or replace function public.grant_consent(consent_token uuid, decision text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  c public.parental_consents%rowtype;
  result jsonb;
begin
  if decision not in ('granted','denied') then
    raise exception 'decision must be granted or denied';
  end if;

  select * into c
    from public.parental_consents
   where token = consent_token
   for update;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'unknown_token');
  end if;

  if c.expires_at < now() then
    update public.parental_consents
       set status = 'expired', decided_at = now()
     where id = c.id;
    update public.profiles
       set consent_status = 'denied',
           deleted_at     = now(),
           updated_at     = now()
     where id = c.student_user_id;
    return jsonb_build_object('ok', false, 'reason', 'expired');
  end if;

  if c.status <> 'pending' then
    return jsonb_build_object('ok', false, 'reason', 'already_decided', 'status', c.status);
  end if;

  update public.parental_consents
     set status = decision, decided_at = now()
   where id = c.id;

  -- On grant: clear consent and let the student in. On deny: mark the
  -- account as soft-deleted. The student can no longer sign in (the
  -- check_parental_consent hook blocks them) and the 30-day hard-delete
  -- cron will eventually remove the row.
  if decision = 'granted' then
    update public.profiles
       set consent_status = 'granted',
           updated_at     = now()
     where id = c.student_user_id;
  else
    update public.profiles
       set consent_status = 'denied',
           deleted_at     = now(),
           updated_at     = now()
     where id = c.student_user_id;
  end if;

  return jsonb_build_object('ok', true, 'status', decision);
end;
$$;

grant execute on function public.grant_consent(uuid, text) to anon, authenticated;

-- ---------- 4. DAILY CRON: enforce 3-day consent window --------------------
--
-- Finds under-16s whose consent has been "pending" for more than 3 days
-- and soft-deletes them. Also hard-deletes any soft-deleted account
-- older than 30 days. Hard delete cascades through auth.users → profiles
-- → parental_consents, removing all PII.

create or replace function public.enforce_consent_expiry()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  -- 1) Soft-delete under-16s whose consent is still pending after 3 days.
  --    "3 days" is measured from parental_consents.created_at, not from
  --    auth.users.created_at — the clock starts when the parent was
  --    emailed, not when the student signed up. If the parent was
  --    emailed multiple times, we look at the most recent row.
  update public.profiles p
     set consent_status = 'denied',
         deleted_at     = now(),
         updated_at     = now()
   where p.requires_parental_consent = true
     and p.consent_status = 'pending'
     and p.deleted_at is null
     and exists (
       select 1
         from public.parental_consents pc
        where pc.student_user_id = p.id
          and pc.status = 'pending'
     )
     and (
       select max(pc.created_at)
         from public.parental_consents pc
        where pc.student_user_id = p.id
     ) < now() - interval '3 days';

  -- 2) Hard-delete soft-deleted accounts that are older than 30 days.
  --    We delete from auth.users so all foreign keys cascade. This is
  --    GDPR Article 17 ("right to erasure") in action.
  delete from auth.users
   where id in (
     select id
       from public.profiles
      where deleted_at is not null
        and deleted_at < now() - interval '30 days'
   );
end;
$$;

-- The cron job needs to be run by a role that's allowed to delete from
-- auth.users. supabase_admin has that permission. We grant it on the
-- function so pg_cron can call it.
grant execute on function public.enforce_consent_expiry() to supabase_admin;

-- ---------- 5. SCHEDULE THE CRON ------------------------------------------
--
-- pg_cron is built into Supabase. It runs as the `postgres` role, so
-- the function above needs SECURITY DEFINER (which it has) to do its
-- work. The schedule is "every day at 03:17 UK-ish" — picked off the
-- :00/:30 marks so the fleet of cron jobs across Supabase customers
-- doesn't all fire at the same instant.
--
-- If pg_cron isn't already enabled on your project, run this first in
-- the Supabase SQL editor:
--   create extension if not exists pg_cron;

-- Remove the old job if you re-run this migration; the name is
-- unique to this project.
select cron.unschedule('enforce-consent-expiry')
  where exists (
    select 1 from cron.job where jobname = 'enforce-consent-expiry'
  );

select cron.schedule(
  'enforce-consent-expiry',                -- job name
  '17 3 * * *',                            -- every day at 03:17 UTC
  $cron$ select public.enforce_consent_expiry(); $cron$
);

-- ============================================================================
-- DONE. After running this:
--   1. Re-enable the Custom Access Token hook in the Supabase dashboard
--      (Auth → Hooks → Custom Access Token → enable, point at
--      public.check_parental_consent).
--   2. Make sure pg_cron is enabled: create extension if not exists pg_cron;
--   3. Verify the cron is scheduled: select * from cron.job;
--   4. The next time the cron runs, you'll see a row in
--      cron.job_run_details with the function's output.
-- ============================================================================
