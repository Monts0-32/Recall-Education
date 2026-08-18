-- ============================================================================
-- Recall Education — Terms of Service + Privacy Policy acceptance
-- Run in the Supabase SQL editor. Idempotent: safe to re-run.
--
-- What this does:
--   1. Adds four columns to public.profiles to record when (and which
--      version of) the Terms of Service and Privacy Policy the user
--      agreed to at sign-up. Versions are stored as text so we can bump
--      them without altering the schema — when the legal copy changes,
--      we change the constant in client code and update any new
--      signups' accepted_version to the new value. Existing users keep
--      their old accepted_version until they explicitly re-consent.
--
--   2. Adds an RPC `record_terms_acceptance(text, text, timestamptz)` that
--      stamps the four columns for the calling user. SECURITY DEFINER
--      so the upsert bypasses RLS, but it still uses auth.uid() and
--      refuses any other user_id (defence in depth — the function can
--      only stamp your own row).
--
--   3. Updates `complete_student_profile` (the OAuth completion RPC)
--      to also record ToS/Privacy acceptance. OAuth users go through
--      complete-profile.html which already has a terms checkbox, so
--      the page passes the acceptance through to this RPC.
--
--   4. Updates `accept_staff_invite` (used by accept-invite.html and
--      signup-staff.html) to record acceptance in the same call so
--      staff don't need a separate confirmation step.
--
-- Enforcement model:
--   * Brand-new signups (this migration forward) — every signup flow
--     (signup.html, signup-teacher.html, signup-staff.html,
--     signup-organisation.html, signup.html ?invite=, complete-profile.html
--     for OAuth) requires an explicit checkbox that links to the
--     live ToS and Privacy pages, and writes the acceptance via
--     record_terms_acceptance (or one of the extended RPCs below).
--   * Existing users — unaffected. terms_accepted_at is nullable; an
--     absent value means "predates the ToS agreement feature" and we
--     don't block those users from signing in. A future migration can
--     prompt them to re-consent when the ToS version bumps.
--
-- Versioning:
--   * The current ToS / Privacy version is stored as a constant on the
--     client (see TERMS_VERSION in each signup page). The version
--     string here matches the "Last updated" date on the legal pages
--     (2026-08-18) so a future date-bump on the legal pages can be
--     mirrored in client code in lock-step.
-- ============================================================================

-- ---------- 1. PROFILE COLUMNS ---------------------------------------------

alter table public.profiles
  add column if not exists terms_accepted_at   timestamptz,
  add column if not exists terms_version       text,
  add column if not exists privacy_accepted_at timestamptz,
  add column if not exists privacy_version     text;

create index if not exists profiles_terms_pending_idx
  on public.profiles (id)
  where terms_accepted_at is null;

comment on column public.profiles.terms_accepted_at   is 'When the user accepted the Terms of Service (null = predates the feature).';
comment on column public.profiles.terms_version       is 'Version of the ToS the user accepted (e.g. ''2026-08-18'').';
comment on column public.profiles.privacy_accepted_at is 'When the user accepted the Privacy Policy (null = predates the feature).';
comment on column public.profiles.privacy_version     is 'Version of the Privacy Policy the user accepted.';

-- ---------- 2. RECORD_TERMS_ACCEPTANCE --------------------------------------
-- SECURITY DEFINER. Caller must be signed in; the RPC only stamps
-- auth.uid()'s row, so it can never be used to record acceptance on
-- someone else's behalf. Idempotent: re-running just overwrites the
-- four columns with the same values.
--
-- The two `p_*_at` arguments let the client pass an explicit timestamp
-- (used by email/password signups that record acceptance at the moment
-- the form was submitted, not when the SQL happens to run). Default is
-- now().

drop function if exists public.record_terms_acceptance(text, text, timestamptz, timestamptz);

create or replace function public.record_terms_acceptance(
  p_terms_version   text,
  p_privacy_version text,
  p_terms_at        timestamptz default null,
  p_privacy_at      timestamptz default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_terms_at   timestamptz := coalesce(p_terms_at,   now());
  v_privacy_at timestamptz := coalesce(p_privacy_at, now());
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if p_terms_version is null or length(trim(p_terms_version)) = 0 then
    raise exception 'terms_version is required';
  end if;
  if p_privacy_version is null or length(trim(p_privacy_version)) = 0 then
    raise exception 'privacy_version is required';
  end if;

  -- Upsert. A profile row normally exists at this point (handle_new_user
  -- creates it on auth.users insert, and signup-time RPCs like
  -- attach_student_to_school also create it). But if a fresh user hasn't
  -- been routed through any of those yet, the row may be missing — we
  -- create a minimal one here so the acceptance isn't lost.
  insert into public.profiles as p (id, terms_accepted_at, terms_version, privacy_accepted_at, privacy_version)
  values (v_uid, v_terms_at, p_terms_version, v_privacy_at, p_privacy_version)
  on conflict (id) do update
    set terms_accepted_at   = excluded.terms_accepted_at,
        terms_version       = excluded.terms_version,
        privacy_accepted_at = excluded.privacy_accepted_at,
        privacy_version     = excluded.privacy_version,
        updated_at          = now();
end;
$$;

grant execute on function public.record_terms_acceptance(text, text, timestamptz, timestamptz)
  to authenticated;

-- ---------- 3. EXTEND COMPLETE_STUDENT_PROFILE -----------------------------
-- OAuth users finish on complete-profile.html which already has a terms
-- checkbox. The page now passes p_terms_version / p_privacy_version +
-- p_terms_accepted (a boolean: did the user actually tick the box?) and
-- we record the acceptance inline.

drop function if exists public.complete_student_profile(text, text, date, text);

create or replace function public.complete_student_profile(
  p_full_name       text,
  p_year_group      text,
  p_dob             date,
  p_parent_email    text,
  p_terms_version   text    default null,
  p_privacy_version text    default null,
  p_terms_accepted  boolean default false
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  uid           uuid  := auth.uid();
  age_years     int;
  needs_consent boolean := false;
  v_role        text;
  own_email     text;
begin
  if uid is null then
    return jsonb_build_object('ok', false, 'reason', 'not_authenticated');
  end if;

  if p_dob is null then
    return jsonb_build_object('ok', false, 'reason', 'dob_required');
  end if;

  age_years := date_part('year', age(current_date, p_dob))::int;

  if age_years < 11 or age_years > 19 then
    return jsonb_build_object('ok', false, 'reason', 'age_out_of_range');
  end if;

  if age_years <= 15 then
    needs_consent := true;
    select email into own_email from auth.users where id = uid;
    if p_parent_email is null
       or p_parent_email = ''
       or lower(trim(p_parent_email)) = lower(coalesce(own_email, '')) then
      return jsonb_build_object('ok', false, 'reason', 'parent_email_required');
    end if;
  end if;

  -- ToS / Privacy acceptance is required for new signups. Existing rows
  -- where the columns are NULL (pre-this-feature accounts) are left
  -- alone here; only the OAuth-completion path reaches this RPC, and
  -- OAuth completion is always a fresh signup.
  if p_terms_accepted is not true then
    return jsonb_build_object('ok', false, 'reason', 'terms_required');
  end if;
  if p_terms_version is null or length(trim(p_terms_version)) = 0 then
    return jsonb_build_object('ok', false, 'reason', 'terms_version_required');
  end if;
  if p_privacy_version is null or length(trim(p_privacy_version)) = 0 then
    return jsonb_build_object('ok', false, 'reason', 'privacy_version_required');
  end if;

  insert into public.profiles
    (id, full_name, year_group, dob, parent_email, requires_parental_consent, role)
  values
    (uid,
     nullif(trim(p_full_name), ''),
     p_year_group,
     p_dob,
     case when needs_consent then p_parent_email else null end,
     needs_consent,
     'student')
  on conflict (id) do update set
    full_name                 = coalesce(nullif(trim(p_full_name), ''), public.profiles.full_name),
    year_group                = p_year_group,
    dob                       = p_dob,
    parent_email              = case when needs_consent then p_parent_email else null end,
    requires_parental_consent = needs_consent,
    updated_at                = now()
  returning role into v_role;

  -- Stamp acceptance (separate update so the column writes don't fight
  -- with the upsert above when the row already existed).
  update public.profiles
     set terms_accepted_at   = now(),
         terms_version       = p_terms_version,
         privacy_accepted_at = now(),
         privacy_version     = p_privacy_version,
         updated_at          = now()
   where id = uid;

  return jsonb_build_object(
    'ok', true,
    'needs_consent', needs_consent,
    'role', coalesce(v_role, 'student')
  );
end;
$$;

grant execute on function public.complete_student_profile(text, text, date, text, text, text, boolean)
  to authenticated;

-- ---------- 4. EXTEND ACCEPT_STAFF_INVITE -----------------------------------
-- accept_staff_invite is called by accept-invite.html (signed-in path)
-- and indirectly by signup-staff.html. The existing function takes
-- p_token + p_decision; we add four optional parameters for the legal
-- acceptance. If they're supplied we stamp the caller's profile. (The
-- staff-invite flow's frontend already shows a ToS/Privacy checkbox
-- before calling this — see signup-staff.html + accept-invite.html.)
--
-- The body mirrors the existing accept_staff_invite in supabase_admin.sql
-- verbatim — we don't want to drift its semantics. The only addition is
-- the four p_* parameters and a conditional UPDATE at the end that
-- stamps terms_accepted_at / privacy_accepted_at when both version
-- strings are present.

drop function if exists public.accept_staff_invite(uuid, text, text, text, timestamptz, timestamptz);
drop function if exists public.accept_staff_invite(uuid, text);

create or replace function public.accept_staff_invite(
  p_token           uuid,
  p_decision        text        default 'accepted',
  p_terms_version   text        default null,
  p_privacy_version text        default null,
  p_terms_at        timestamptz default null,
  p_privacy_at      timestamptz default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller uuid := auth.uid();
  v_caller_email text;
  v public.staff_invites%rowtype;
  v_terms_at   timestamptz := coalesce(p_terms_at,   now());
  v_privacy_at timestamptz := coalesce(p_privacy_at, now());
begin
  if v_caller is null then
    raise exception 'not authenticated';
  end if;
  if p_decision <> 'accepted' then
    raise exception 'decision must be "accepted"';
  end if;

  select * into v from public.staff_invites where token = p_token for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'unknown_token');
  end if;
  if v.status = 'accepted' then
    return jsonb_build_object('ok', false, 'reason', 'already_accepted');
  end if;
  if v.status = 'revoked' then
    return jsonb_build_object('ok', false, 'reason', 'revoked');
  end if;
  if v.expires_at < now() then
    update public.staff_invites
       set status = 'expired', decided_at = now()
     where id = v.id;
    return jsonb_build_object('ok', false, 'reason', 'expired');
  end if;

  -- Email must match — staff invites are personal, not transferable.
  select lower(email) into v_caller_email from auth.users where id = v_caller;
  if v_caller_email is null or v_caller_email <> lower(v.email) then
    return jsonb_build_object('ok', false, 'reason', 'email_mismatch',
                              'invited_email', v.email);
  end if;

  -- Upsert the profile row BEFORE the role update (same reason as the
  -- original: handle_new_user() can swallow profile-write failures and
  -- leave the row missing).
  insert into public.profiles (id, role)
    values (v_caller, v.role)
    on conflict (id) do nothing;

  update public.profiles
     set role = v.role,
         updated_at = now()
   where id = v_caller;

  -- Stamp ToS/Privacy acceptance if both versions were supplied.
  -- Legacy callers (admin scripts, the old accept-invite.html path)
  -- can pass NULLs and we just skip the update.
  if p_terms_version is not null and p_privacy_version is not null then
    update public.profiles
       set terms_accepted_at   = v_terms_at,
           terms_version       = p_terms_version,
           privacy_accepted_at = v_privacy_at,
           privacy_version     = p_privacy_version,
           updated_at          = now()
     where id = v_caller;
  end if;

  update public.staff_invites
     set status = 'accepted',
         decided_at = now(),
         accepted_by = v_caller
   where id = v.id;

  perform public._log_staff_action(
    'role_changed', 'profile', v_caller,
    jsonb_build_object('via_invite', true, 'role', v.role)
  );

  return jsonb_build_object('ok', true, 'role', v.role);
end;
$$;

grant execute on function public.accept_staff_invite(uuid, text, text, text, timestamptz, timestamptz)
  to authenticated;
