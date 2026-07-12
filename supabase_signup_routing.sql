-- ============================================================================
-- Recall Education — Sign-up routing, schools, and teacher accounts
-- Run this AFTER supabase_setup.sql, supabase_tables.sql, supabase_staff.sql,
-- supabase_uploads.sql, supabase_consent_enforcement.sql, supabase_dashboard.sql,
-- supabase_admin.sql, and supabase_units.sql. Idempotent: safe to re-run.
--
-- What this does:
--   1. Widens profiles.role to include 'teacher' (in addition to the
--      existing student / staff_author / staff_reviewer / admin).
--   2. Adds profiles.school_id so teachers can be linked to a school.
--   3. Adds the public.schools table — one row per school, with a
--      short code (e.g. 'BIRM-2024') that teachers can type during
--      sign-up to attach to the school.
--   4. Adds public.teacher_signup_codes — optional one-time codes
--      that school admins can issue. Today the table is created but
--      no UI to issue them; the teacher sign-up form accepts both
--      a one-time code AND the permanent school.code.
--   5. Defines 2 anon-callable RPCs for sign-up-time code lookups.
--   6. Adds a SECURITY DEFINER RPC for the lesson creator to create
--      a new exam board AND its anchoring (subject, board, year)
--      units row in one call (the previous iteration's "+ Add board"
--      button created a board reference but no units row, so the
--      new board didn't show up in the catalog).
-- ============================================================================

-- ---------- 1. WIDEN PROFILES.ROLE + ADD SCHOOL_ID -----------------------

-- Drop the 4-value CHECK (student/staff_author/staff_reviewer/admin)
-- temporarily so we can add 'teacher'.
alter table public.profiles drop constraint if exists profiles_role_check;

alter table public.profiles
  alter column role set default 'student';
alter table public.profiles
  add constraint profiles_role_check
  check (role in ('student', 'teacher', 'staff_author', 'staff_reviewer', 'admin'));

alter table public.profiles
  add column if not exists school_id uuid references public.schools(id) on delete set null;
create index if not exists profiles_school_idx on public.profiles (school_id);

-- ---------- 2. SCHOOLS TABLE ----------------------------------------------
-- One row per school. The `code` is a short, human-typable string that
-- teachers use at sign-up. It's globally unique. RLS: public read so
-- the anon-callable lookup RPC can work; writes only via the future
-- school-admin UI (not implemented in this iteration).

create table if not exists public.schools (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  code        text not null unique,
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);
create index if not exists schools_code_idx on public.schools (code);

alter table public.schools enable row level security;
drop policy if exists "schools_read_active" on public.schools;
create policy "schools_read_active" on public.schools for select
  to anon, authenticated
  using (active = true);

-- No public write policy. Schools are created via the seed block below
-- today; later they'll be created by an admin RPC.

-- Pre-seed two schools so the lookup RPC isn't dead on first run.
insert into public.schools (name, code) values
  ('Birmingham Grammar School', 'BIRM-2024'),
  ('Cardiff Sixth Form College', 'CARD-2024')
on conflict (code) do nothing;

-- ---------- 3. TEACHER SIGNUP CODES ---------------------------------------
-- Optional disposable codes a school admin can issue to specific
-- teachers. The teacher sign-up form accepts EITHER this code or the
-- school's permanent code. We create the table now so the
-- school-admin work later doesn't need another migration.

create table if not exists public.teacher_signup_codes (
  id          uuid primary key default gen_random_uuid(),
  school_id   uuid not null references public.schools(id) on delete cascade,
  code        text not null unique,
  used_at     timestamptz,
  used_by     uuid references auth.users(id) on delete set null,
  expires_at  timestamptz,
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now()
);
create index if not exists teacher_codes_school_idx on public.teacher_signup_codes (school_id);
create index if not exists teacher_codes_code_idx    on public.teacher_signup_codes (code);

alter table public.teacher_signup_codes enable row level security;
-- No public read policy — the lookup is done through SECURITY DEFINER
-- RPCs that return just the school_id, never the raw row.

-- ============================================================================
-- 4. RPCs
-- ============================================================================

-- ---------- 4a. lookup_school_by_code ---------------------------------------
-- Anon-callable. Returns { ok, school_id, school_name, school_code, reason? }.
-- Used by signup-teacher.html to validate the school code the user types
-- and surface the school's display name on the form.

create or replace function public.lookup_school_by_code(p_code text)
returns table (
  ok          boolean,
  school_id   uuid,
  school_name text,
  school_code text,
  reason      text
)
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_clean text := trim(coalesce(p_code, ''));
  v_row   record;
begin
  if v_clean = '' then
    ok := false; school_id := null; school_name := null; school_code := null;
    reason := 'empty';
    return next; return;
  end if;

  -- First, check whether this is a one-time teacher_signup_codes entry.
  select tsc.school_id, s.name, s.code
    into v_row
    from public.teacher_signup_codes tsc
    join public.schools s on s.id = tsc.school_id
   where tsc.code = v_clean
     and tsc.used_at is null
     and (tsc.expires_at is null or tsc.expires_at > now())
   limit 1;

  if found then
    ok := true; school_id := v_row.school_id; school_name := v_row.name; school_code := v_row.code;
    reason := null;
    return next; return;
  end if;

  -- Otherwise, look up the school's permanent code.
  select id, name, code into v_row
    from public.schools
   where code = v_clean and active = true;

  if found then
    ok := true; school_id := v_row.id; school_name := v_row.name; school_code := v_row.code;
    reason := null;
    return next; return;
  end if;

  ok := false; school_id := null; school_name := null; school_code := null;
  reason := 'not_found';
  return next;
end;
$$;

grant execute on function public.lookup_school_by_code(text) to anon, authenticated;

-- ---------- 4b. claim_teacher_signup_code ---------------------------------
-- If the code the user typed is a one-time teacher_signup_codes entry,
-- mark it used and return the school_id. Idempotent for permanent school
-- codes (no row to mark).
--
-- Returns { ok, school_id, reason? }. The teacher's sign-up form calls
-- this on submit so one-time codes don't get reused.

create or replace function public.claim_teacher_signup_code(p_code text)
returns table (
  ok        boolean,
  school_id uuid,
  reason    text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_clean text := trim(coalesce(p_code, ''));
  v_tsc   record;
  v_school record;
begin
  if v_clean = '' then
    ok := false; school_id := null; reason := 'empty';
    return next; return;
  end if;

  -- Is this a one-time code?
  select tsc.id, tsc.school_id, tsc.used_at
    into v_tsc
    from public.teacher_signup_codes tsc
   where tsc.code = v_clean
   limit 1;

  if found then
    if v_tsc.used_at is not null then
      ok := false; school_id := null; reason := 'already_used';
      return next; return;
    end if;
    if v_tsc.expires_at is not null and v_tsc.expires_at < now() then
      ok := false; school_id := null; reason := 'expired';
      return next; return;
    end if;
    update public.teacher_signup_codes
       set used_at = now()
     where id = v_tsc.id;
    ok := true; school_id := v_tsc.school_id; reason := null;
    return next; return;
  end if;

  -- Not a one-time code — is it a permanent school code?
  select id into v_school from public.schools where code = v_clean and active = true;
  if found then
    ok := true; school_id := v_school.id; reason := null;
    return next; return;
  end if;

  ok := false; school_id := null; reason := 'not_found';
  return next;
end;
$$;

grant execute on function public.claim_teacher_signup_code(text) to anon, authenticated;

-- ---------- 4c. attach_teacher_to_school ----------------------------------
-- After a teacher signs up, stamp their profile with role='teacher'
-- and school_id=<school>. The trigger that creates a profile row on
-- auth.users insert doesn't know about either field, so the sign-up
-- form calls this RPC after signUp succeeds. If the profile row
-- doesn't exist yet (auth hook races), we create it.

create or replace function public.attach_teacher_to_school(
  p_user_id  uuid,
  p_school_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  -- The caller (the new teacher themselves) must own this user_id.
  -- auth.uid() returns the caller; we don't accept arbitrary ids.
  if auth.uid() is null or auth.uid() <> p_user_id then
    raise exception 'cannot attach another user to a school' using errcode = '42501';
  end if;

  insert into public.profiles (id, role, school_id)
  values (p_user_id, 'teacher', p_school_id)
  on conflict (id) do update
    set role      = 'teacher',
        school_id = p_school_id;
end;
$$;

grant execute on function public.attach_teacher_to_school(uuid, uuid) to authenticated;

-- ---------- 4d. create_board_for_subject_year -----------------------------
-- The lesson creator's "+ Add board" button. Creates the exam board
-- reference (if it doesn't already exist) AND the anchoring units row
-- for (subject, board, year) so the new board shows up in the catalog.
-- Admin-only.

create or replace function public.create_board_for_subject_year(
  p_subject_id uuid,
  p_year_id    uuid,
  p_name       text
)
returns table (
  board_id   uuid,
  unit_id    uuid,
  board_name text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_clean text := trim(coalesce(p_name, ''));
  v_board record;
  v_unit_id uuid;
begin
  perform public._assert_admin();
  if v_clean = '' then
    raise exception 'name is required';
  end if;

  -- Upsert into exam_boards.
  insert into public.exam_boards (name)
  values (v_clean)
  on conflict (name) do update set name = excluded.name
  returning id, name into v_board;

  -- Anchor: a default "Curriculum" unit for (subject, board, year).
  insert into public.units (subject_id, exam_board_id, year_id, name, sort_order)
  values (p_subject_id, v_board.id, p_year_id, 'Curriculum', 0)
  on conflict (subject_id, exam_board_id, year_id, name) do nothing
  returning id into v_unit_id;

  if v_unit_id is null then
    select id into v_unit_id
      from public.units
     where subject_id = p_subject_id
       and exam_board_id = v_board.id
       and year_id = p_year_id
       and name = 'Curriculum';
  end if;

  perform public._log_staff_action(
    'admin_action', 'exam_board', v_board.id,
    jsonb_build_object('op', 'create_for_subject_year',
                       'name', v_clean,
                       'subject_id', p_subject_id,
                       'year_id', p_year_id,
                       'unit_id', v_unit_id)
  );

  board_id := v_board.id;
  unit_id  := v_unit_id;
  board_name := v_board.name;
  return next;
end;
$$;

grant execute on function public.create_board_for_subject_year(uuid, uuid, text) to authenticated;

-- ============================================================================
-- DONE. After running this:
--   1. signup-teacher.html can call lookup_school_by_code() and
--      claim_teacher_signup_code() to attach teachers to schools.
--   2. The lesson creator's "+ Add board" button can call
--      create_board_for_subject_year() to atomically create the
--      exam_boards row AND the anchoring units row in one RPC.
--   3. profiles.school_id is queryable; the staff/admin views can
--      later filter "show me every teacher at Birmingham" without
--      another migration.
-- ============================================================================
