-- ============================================================================
-- Recall Education — Supabase setup
-- Run this ONCE in the Supabase SQL editor (Project → SQL → New query).
-- It is idempotent: safe to re-run.
-- ============================================================================

-- ---------- 1. TABLES --------------------------------------------------------

create table if not exists public.profiles (
  id                            uuid primary key references auth.users(id) on delete cascade,
  full_name                     text,
  year_group                    text,
  dob                           date,
  parent_email                  text,
  requires_parental_consent     boolean not null default false,
  consent_status                text    not null default 'not_required'
                                 check (consent_status in ('not_required','pending','granted','denied')),
  created_at                    timestamptz not null default now(),
  updated_at                    timestamptz not null default now()
);

create table if not exists public.parental_consents (
  id                uuid primary key default gen_random_uuid(),
  student_user_id   uuid not null references auth.users(id) on delete cascade,
  parent_email      text not null,
  token             uuid not null default gen_random_uuid() unique,
  status            text not null default 'pending'
                    check (status in ('pending','granted','denied','expired')),
  expires_at        timestamptz not null default (now() + interval '7 days'),
  created_at        timestamptz not null default now(),
  decided_at        timestamptz
);

create index if not exists parental_consents_student_idx
  on public.parental_consents (student_user_id);
create index if not exists parental_consents_token_idx
  on public.parental_consents (token);

-- ---------- 2. AUTO-CREATE A PROFILE ROW ON SIGNUP --------------------------
-- Fires after auth.users gets a new row. Reads metadata the client put in
-- options.data at signUp() time and writes it into profiles.

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  meta jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  dob_text text := meta->>'dob';
  dob_date date := null;
  age_years int := null;
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

  insert into public.profiles (
    id, full_name, year_group, dob, parent_email, requires_parental_consent
  )
  values (
    new.id,
    meta->>'full_name',
    meta->>'year_group',
    dob_date,
    meta->>'parent_email',
    coalesce(age_years is not null and age_years < 16, false)
  )
  on conflict (id) do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- 3. CONSENT GRANT / DENY FUNCTION --------------------------------
-- Callable by anon (the parent, who is not signed in) using a token. The
-- function looks up the consent row, marks it decided, updates the student's
-- profile, and returns a small status object the consent page can read.

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
       set consent_status = 'denied', updated_at = now()
     where id = c.student_user_id;
    return jsonb_build_object('ok', false, 'reason', 'expired');
  end if;

  if c.status <> 'pending' then
    return jsonb_build_object('ok', false, 'reason', 'already_decided', 'status', c.status);
  end if;

  update public.parental_consents
     set status = decision, decided_at = now()
   where id = c.id;

  update public.profiles
     set consent_status = case when decision = 'granted' then 'granted' else 'denied' end,
         updated_at = now()
   where id = c.student_user_id;

  return jsonb_build_object('ok', true, 'status', decision);
end;
$$;

grant execute on function public.grant_consent(uuid, text) to anon, authenticated;

-- ---------- 4. LOOK UP A CONSENT TOKEN (for the consent page to render) -----
-- Returns the student's name + DOB so the parent can see who they're
-- consenting to. No PII beyond name + DOB. The token is the secret.

create or replace function public.peek_consent(consent_token uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  c public.parental_consents%rowtype;
  p public.profiles%rowtype;
begin
  select * into c from public.parental_consents where token = consent_token;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'unknown_token');
  end if;
  select * into p from public.profiles where id = c.student_user_id;

  return jsonb_build_object(
    'ok', true,
    'status', c.status,
    'expires_at', c.expires_at,
    'student_name', coalesce(p.full_name, '(name not provided)'),
    'student_dob', p.dob,
    'parent_email', c.parent_email
  );
end;
$$;

grant execute on function public.peek_consent(uuid) to anon, authenticated;

-- ---------- 5. SIGN-IN HOOK: block under-16s without consent ----------------
-- A custom_access_token_hook runs before a JWT is issued. If the user's
-- profile says they need parental consent and don't have it, we throw
-- 'access_denied' — Supabase will surface that as an auth error.
--
-- This requires the hook to be enabled in Supabase dashboard:
--   Authentication → Hooks → Custom Access Token → enable, point at this fn.
-- See the README after running this SQL.

create or replace function public.check_parental_consent(event jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  user_id uuid := (event->>'user_id')::uuid;
  p public.profiles%rowtype;
begin
  select * into p from public.profiles where id = user_id;

  if not found then
    return event; -- profile row not yet written; allow through (shouldn't happen)
  end if;

  if p.requires_parental_consent and p.consent_status <> 'granted' then
    raise exception 'parental_consent_required'
      using errcode = '42501'; -- insufficient_privilege
  end if;

  return event;
end;
$$;

grant execute on function public.check_parental_consent(jsonb) to supabase_auth_admin;

-- ---------- 6. ROW-LEVEL SECURITY -------------------------------------------

alter table public.profiles enable row level security;
alter table public.parental_consents enable row level security;

-- profiles: a user can read & update their own row. No one can insert from the
-- client (insert is done by the handle_new_user trigger with security definer).
drop policy if exists "profiles_select_own" on public.profiles;
create policy "profiles_select_own"
  on public.profiles for select
  to authenticated
  using (id = auth.uid());

drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own"
  on public.profiles for update
  to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

-- parental_consents: never directly readable/ writable by clients. All access
-- goes through the security-definer functions above.
drop policy if exists "consents_no_client_access" on public.parental_consents;
create policy "consents_no_client_access"
  on public.parental_consents for all
  to anon, authenticated
  using (false)
  with check (false);

-- ---------- 7. UPDATED_AT TRIGGER -------------------------------------------

create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists profiles_touch_updated_at on public.profiles;
create trigger profiles_touch_updated_at
  before update on public.profiles
  for each row execute function public.touch_updated_at();

-- ============================================================================
-- DONE. Next steps in the Supabase dashboard (not SQL):
--   1. Authentication → Providers → Email → enable "Confirm email"
--   2. Authentication → URL Configuration →
--        Site URL:           https://your-site/
--        Redirect URLs:      https://your-site/consent.html
--                            https://your-site/dashboard.html
--   3. Authentication → Hooks → Custom Access Token → enable,
--        select function: public.check_parental_consent
--   4. Authentication → Email Templates → "Confirm signup" — replace the body
--        with a short note pointing the parent at /consent.html?token=...
--        (we generate the link from the client; see signup.html)
-- ============================================================================
