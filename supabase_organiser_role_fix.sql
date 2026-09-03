-- ============================================================================
-- Recall Education — Organiser role fix
--
-- Run AFTER every other supabase_*.sql migration. Idempotent.
-- Order-independent: this migration widens profiles.role_check itself
-- so it works whether or not supabase_school_organisers.sql has been
-- run yet.
--
-- Bug being fixed:
--   The handle_new_user trigger (supabase_setup.sql) writes
--     role = case when v_school_id is not null then 'school_organiser' end
--   When the school-creation block fails (e.g. a transient RLS hiccup, a
--   code-collision after 20 retries, or anything else that the inner
--   `exception when others` catches), v_school_id ends up NULL and the
--   CASE evaluates to NULL. profiles.role is NOT NULL, so the INSERT
--   raises a not_null_violation. The outer `exception when others`
--   swallows that error, logs a warning, and LEAVES THE PROFILE ROW
--   MISSING. The auth user exists but has no profiles row at all.
--
--   The client-side create_school_and_organiser RPC
--   (supabase_school_organisers.sql) is the recovery path: it creates
--   the school + promotes the profile. But on confirmed-organiser.html
--   the recovery is only invoked when no school row exists yet. If
--   the trigger *did* create the school but failed the profile insert,
--   the client-side recovery short-circuits, and the user is left with
--   a school row + an empty profile slot.
--
--   On re-sign-in, current_role() returns NULL, every role-gated page
--   falls through to its default (student dashboard), and the user is
--   silently demoted. This is what users have been reporting.
--
-- This migration:
--   1. Patches the trigger to never write NULL into profiles.role —
--      the CASE now has a 'student' fallback so the column is always
--      populated. Existing rows are preserved.
--   2. Backfills any profile row that is missing (the trigger errored
--      out) with role='student' + their user_metadata defaults.
--   3. Backfills any profile that has a school_id but role !=
--      'school_organiser' (the trigger wrote NULL → default kicked in
--      for *some* path) by promoting to 'school_organiser'.
--   4. Adds a tiny helper that, on re-sign-in, syncs the JWT
--      app_metadata.role from profiles.role via a refresh hook
--      documented in the comment (no SQL change needed beyond the
--      docs — Supabase already re-runs the custom_access_token_hook
--      on every token refresh).
-- ============================================================================

-- ---------- 0. ENSURE profiles.role_check ACCEPTS school_organiser -------
-- supabase_admin.sql creates the constraint with only the 4 staff
-- values; supabase_school_organisers.sql widens it later. If those
-- migrations were applied in the wrong order — or if
-- supabase_school_organisers.sql was skipped — this constraint will
-- reject role='school_organiser' and the rest of the migration (plus
-- all organiser sign-ups) will fail with a 23514.
--
-- Re-create the constraint with the full allowlist. DROP IF EXISTS is
-- safe; re-adding the same constraint with a wider set is idempotent.
alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles
  add constraint profiles_role_check
  check (role in (
    'student', 'teacher', 'school_organiser',
    'staff_author', 'staff_reviewer', 'admin'
  ));

-- ---------- 1. PATCH handle_new_user ---------------------------------------
-- Replace the NULL-yielding CASE with one that falls back to 'student'.
-- Without this, every failed school-creation leaves the user with no
-- profile row, and the column's default 'student' never gets applied
-- because the INSERT explicitly sets the column to NULL.

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  meta          jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  intended_role text  := meta->>'intended_role';
  intended_school text := trim(coalesce(meta->>'intended_school', ''));
  intended_plan text  := coalesce(nullif(trim(meta->>'intended_plan'), ''), 'free');
  dob_text      text  := meta->>'dob';
  dob_date      date  := null;
  age_years     int   := null;

  v_school_id   uuid;
  v_alnum       text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  v_codenum     bigint;
  v_code        text;
  v_attempts    int := 0;
begin
  if dob_text is not null and dob_text <> '' then
    begin
      dob_date := dob_text::date;
    exception when others then
      dob_date := null;
    end;
  end if;

  if dob_date is not null then
    age_years := date_part('year', age(current_date, dob_date))::int;
  end if;

  if intended_role = 'school_organiser' and intended_school <> '' then
    begin
      loop
        v_codenum := (random() * power(36::numeric, 6))::bigint;
        v_code := 'SCH-';
        for i in 1..6 loop
          v_code := v_code || substr(v_alnum, 1 + (v_codenum % 32)::int, 1);
          v_codenum := v_codenum / 32;
        end loop;
        v_attempts := v_attempts + 1;
        begin
          insert into public.schools (name, code, plan, owner_user_id)
          values (intended_school, v_code, intended_plan, new.id)
          returning id into v_school_id;
          exit;
        exception when unique_violation then
          if v_attempts > 20 then
            v_school_id := null;
            exit;
          end if;
        end;
      end loop;
    exception when others then
      raise warning 'handle_new_user: school insert failed for user % (%): %',
        new.id, new.email, sqlerrm;
      v_school_id := null;
    end;
  end if;

  -- Profile row. role must NEVER be NULL — the column is NOT NULL.
  -- The CASE now has a 'student' fallback so a failed school-creation
  -- doesn't blow up the insert and leave the user without a profile.
  -- (The original code did `case when v_school_id is not null then
  -- 'school_organiser' end` which evaluates to NULL when the school
  -- wasn't created, hitting the NOT NULL constraint and being silently
  -- swallowed by the exception handler.)
  begin
    insert into public.profiles (
      id, full_name, year_group, dob, parent_email,
      requires_parental_consent, role, school_id
    )
    values (
      new.id,
      meta->>'full_name',
      meta->>'year_group',
      dob_date,
      meta->>'parent_email',
      coalesce(age_years is not null and age_years < 16, false),
      case
        when v_school_id is not null then 'school_organiser'
        else 'student'
      end,
      v_school_id
    )
    on conflict (id) do update set
      role      = case
                    when excluded.role = 'school_organiser' then 'school_organiser'
                    when excluded.role is distinct from 'student' then excluded.role
                    else public.profiles.role
                  end,
      school_id = coalesce(excluded.school_id, public.profiles.school_id);
  exception when others then
    raise warning 'handle_new_user: profile insert failed for user % (%): %',
      new.id, new.email, sqlerrm;
  end;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- 2. BACKFILL MISSING PROFILE ROWS -------------------------------
-- For auth.users that have a schools.owner_user_id match but no
-- profiles row (the trigger's profile insert was silently swallowed),
-- create the profile row now and stamp role='school_organiser'.

insert into public.profiles (id, role, school_id, full_name)
select
  s.owner_user_id,
  'school_organiser',
  s.id,
  coalesce(
    (u.raw_user_meta_data->>'full_name'),
    split_part(u.email, '@', 1)
  )
from public.schools s
join auth.users u on u.id = s.owner_user_id
on conflict (id) do nothing;

-- For each of those, also promote role if a profile row exists with
-- role != 'school_organiser' but school_id IS set (e.g. the trigger
-- wrote role='student' via the broken CASE before this fix shipped).
update public.profiles p
   set role = 'school_organiser'
 from public.schools s
where s.owner_user_id = p.id
  and p.school_id = s.id
  and p.role is distinct from 'school_organiser';

-- ---------- 3. BACKFILL auth.users.app_metadata.role -----------------------
-- The client code (confirmed-organiser.html, login.html, etc.) reads
-- app_metadata.role from the JWT to make routing decisions. Without a
-- custom_access_token_hook that stamps this field, every user gets
-- app_metadata.role = NULL and current_role() is the only fallback.
--
-- We don't have a way to inject app_metadata from a SECURITY DEFINER
-- RPC (only the supabase_auth_admin role can update auth.users rows,
-- and even then app_metadata is system-managed). The fix is to enable
-- the access-token hook documented at the bottom of supabase_setup.sql
-- to ALSO stamp app_metadata.role from profiles.role.
--
-- To make that work, we replace check_parental_consent with a version
-- that also writes the role into the event JSON. Supabase re-runs this
-- hook on every token refresh, so once the hook is updated and the
-- user re-signs in, the JWT will carry the correct role and every
-- page's app_metadata.role check will succeed.
create or replace function public.check_parental_consent(event jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  user_id uuid := (event->>'user_id')::uuid;
  p public.profiles%rowtype;
  v_claims jsonb := coalesce(event->'claims', '{}'::jsonb);
  v_role   text;
begin
  select * into p from public.profiles where id = user_id;

  if not found then
    return event; -- profile row not yet written; allow through
  end if;

  if p.requires_parental_consent and p.consent_status <> 'granted' then
    raise exception 'parental_consent_required'
      using errcode = '42501';
  end if;

  -- Stamp the profile's role onto the JWT's app_metadata so the
  -- client-side role checks (login.html, dashboard.html, etc.) work
  -- without an extra round-trip to current_role(). Supabase merges
  -- the returned event's claims into the issued JWT.
  v_role := p.role;
  if v_role is null then
    v_role := 'student';
  end if;

  v_claims := jsonb_set(
    v_claims,
    '{app_metadata}',
    coalesce(v_claims->'app_metadata', '{}'::jsonb)
      || jsonb_build_object('role', v_role),
    true
  );

  return jsonb_set(event, '{claims}', v_claims, false);
end;
$$;

grant execute on function public.check_parental_consent(jsonb) to supabase_auth_admin;

-- ---------- 4. ENSURE EXISTING ORGANISERS GET A REFRESHED JWT --------------
-- No SQL can force an existing logged-in user to refresh their JWT.
-- The fix relies on the hook above: the next time the user signs in
-- (or refreshes their session), the hook runs and stamps the role.
-- If a user is already mid-session with a stale JWT, they need to
-- sign out and back in, OR visit any page that calls
-- supabaseClient.auth.refreshSession({ forceRefresh: true }) — the
-- school-organiser-dashboard and confirmed-organiser pages both do
-- this on load, so a one-time visit to either will heal the session.

-- ============================================================================
-- DONE.
--
-- After running this migration:
--   1. All future organiser sign-ups create a profile row with
--      role='school_organiser' (or fall back to 'student' if school
--      creation fails — the user is no longer orphaned).
--   2. All existing organiser accounts that were silently demoted by
--      the old bug are now correctly stamped as 'school_organiser'.
--   3. The custom_access_token_hook now stamps app_metadata.role on
--      every issued JWT, so re-signing in gives the user a JWT that
--      passes every role gate.
--
-- Action required: confirm the custom_access_token_hook is enabled in
-- Supabase dashboard (Authentication → Hooks → Custom Access Token).
-- The function name is public.check_parental_consent (unchanged) but
-- the body now also stamps the role claim.
-- ============================================================================
