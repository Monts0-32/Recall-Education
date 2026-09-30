-- ============================================================================
-- Recall Education — Global site settings migration
-- Run this AFTER supabase_setup.sql, supabase_tables.sql and
-- supabase_admin.sql (it reuses _log_staff_action and widens the staff
-- audit action allowlist defined there). Idempotent: safe to re-run.
--
-- What this does:
--   1. Adds public.site_settings — a tiny key/value table for settings
--      that apply to the whole site (not per-school; school_settings
--      covers that). Seeded with supabase_mode = 'proxy'.
--   2. supabase_mode is the site-wide switch the admin sets from
--      admin.html ("Site settings"):
--        'proxy'  (default) — every page talks to Supabase through our
--                  own origin at /db/* (the Cloudflare Worker proxy),
--                  which works behind school firewalls that break
--                  QUIC/HTTP3 to *.supabase.co.
--        'direct' — pages talk straight to hkjiyibpeqdoqzlyqzwz.supabase.co.
--   3. get_supabase_mode() — public SECURITY DEFINER read (anon +
--      authenticated) used by db-config.js on every page load. STABLE so
--      PostgREST accepts it as a GET /rpc call. RPC-only access — no
--      SELECT policy, so future secrets dropped in site_settings are
--      never exposed to the anon key.
--   4. set_supabase_mode() — admin-only SECURITY DEFINER write, audited
--      via _log_staff_action.
--   5. Widens staff_audit_log_action_check with 'site_setting_changed'.
-- ============================================================================

-- ---------- 1. SITE_SETTINGS TABLE ---------------------------------------

create table if not exists public.site_settings (
  key        text primary key,
  value      text not null,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null
);

-- Seed the one setting we manage today. ON CONFLICT DO NOTHING keeps any
-- admin-set value on re-runs.
insert into public.site_settings (key, value)
values ('supabase_mode', 'proxy')
on conflict (key) do nothing;

-- RLS on, no policies: deny-all for direct table access. All reads and
-- writes go through the RPCs below (same pattern as staff_audit_log and
-- the signup-routing RPCs).
alter table public.site_settings enable row level security;

-- ---------- 2. WIDEN THE AUDIT ACTION ALLOWLIST --------------------------

-- _log_staff_action's CHECK constraint is a fixed allowlist; add the new
-- action idempotently (drop-then-add, same pattern as supabase_admin.sql).
--
-- NOT VALID: the live audit log predates the allowlist and contains
-- historical action values outside it, so a full constraint would be
-- rejected by those rows (23514). NOT VALID keeps the allowlist enforced
-- for every NEW row — including 'site_setting_changed' — while exempting
-- the pre-existing history. To see what's out there:
--   select action, count(*) from public.staff_audit_log
--    group by action order by 2 desc;
-- (If those values all look legitimate, add them to the list below and
-- run `alter table public.staff_audit_log validate constraint
-- staff_audit_log_action_check;` to make it fully enforced.)
alter table public.staff_audit_log
  drop constraint if exists staff_audit_log_action_check;
alter table public.staff_audit_log
  add constraint staff_audit_log_action_check
  check (action in (
    'invite_sent', 'invite_revoked', 'invite_resent',
    'role_changed', 'access_revoked',
    'lesson_published', 'lesson_unpublished', 'lesson_archived',
    'admin_login', 'admin_action',
    'user_deleted',
    'row_deleted',
    'site_setting_changed'
  )) not valid;

-- ---------- 3. PUBLIC READ RPC --------------------------------------------

-- Defensive drops (see the supabase_admin.sql rationale: a stale live
-- version with a different return type blocks CREATE OR REPLACE).
drop function if exists public.get_supabase_mode();
drop function if exists public.set_supabase_mode(text);

-- STABLE + no args + returns scalar -> callable as GET /rpc/get_supabase_mode,
-- which is what db-config.js's background mode check uses (through the
-- /db proxy, with the apikey query param). Coalesce to 'proxy' so a fresh
-- install (or a deleted row) falls back to the safe default.
create or replace function public.get_supabase_mode()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select value from public.site_settings where key = 'supabase_mode'),
    'proxy'
  );
$$;

grant execute on function public.get_supabase_mode()
  to anon, authenticated;

-- ---------- 4. ADMIN-ONLY WRITE RPC ---------------------------------------

-- Same admin guard as the staff-invite RPCs in supabase_admin.sql. Returns
-- a friendly {ok, reason} shape for expected failures rather than raising,
-- so admin.html can toast the reason; unexpected errors still raise.
create or replace function public.set_supabase_mode(
  p_mode text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller uuid := auth.uid();
begin
  if v_caller is null then
    raise exception 'not authenticated';
  end if;
  if not exists (
    select 1 from public.profiles
     where id = v_caller and role = 'admin'
  ) then
    raise exception 'admin role required' using errcode = '42501';
  end if;

  if p_mode not in ('proxy', 'direct') then
    return jsonb_build_object('ok', false, 'reason', 'invalid_mode');
  end if;

  update public.site_settings
     set value      = p_mode,
         updated_at = now(),
         updated_by = v_caller
   where key = 'supabase_mode';

  if not found then
    insert into public.site_settings (key, value, updated_by)
    values ('supabase_mode', p_mode, v_caller);
  end if;

  perform public._log_staff_action(
    'site_setting_changed', 'site_settings', null,
    jsonb_build_object('supabase_mode', p_mode)
  );

  return jsonb_build_object(
    'ok', true,
    'mode', p_mode,
    'updated_at', now()
  );
end;
$$;

grant execute on function public.set_supabase_mode(text)
  to authenticated;