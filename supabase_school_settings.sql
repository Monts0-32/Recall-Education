-- ============================================================================
-- Recall Education — School Settings (teacher permissions)
-- Run AFTER supabase_tables.sql, supabase_school_organisers.sql and
-- supabase_classes_and_submissions.sql.
-- Idempotent: safe to re-run.
--
-- What this does:
--   1. Creates the school_settings table: per-school teacher permission
--      toggles, defaulting to all-on (preserves current behaviour).
--   2. Seeds a defaults row for every existing school.
--   3. Adds permission helpers:
--        _school_teacher_perm(school, key)       -- effective permission
--        _assert_school_staff_with_perm(...)     -- guard for gated RPCs
--   4. Adds get_school_settings / update_school_settings RPCs
--      (readable by all staff of the school so the UI can hide buttons,
--       writable by the organiser only).
--   5. Re-owns create_class so class creation respects the
--      "create_classes" toggle.
--
-- NOTE: the create_class below SUPERSEDES the version in
-- supabase_classes_and_submissions.sql. If you re-run that file, re-run
-- this one afterwards.
--
-- Permission keys:
--   create_classes     — create/manage classes
--   behaviour_praise   — behaviour logs + praise points
--   register_absences  — attendance register + absences
--   ops_announcements  — announcements + resource booking + clubs
-- The organiser of the school ALWAYS has every permission; the toggles
-- only constrain teachers.
-- ============================================================================

-- ============================================================================
-- 1. TABLE + SEED
-- ============================================================================

create table if not exists public.school_settings (
  school_id              uuid primary key references public.schools(id) on delete cascade,
  perm_create_classes     boolean not null default true,
  perm_behaviour_praise   boolean not null default true,
  perm_register_absences  boolean not null default true,
  perm_ops_announcements  boolean not null default true,
  updated_at              timestamptz not null default now(),
  updated_by              uuid references auth.users(id) on delete set null
);

-- Seed a defaults row for every existing school (no-op on re-run, and
-- harmless for schools created later — the helpers coalesce missing rows
-- back to the defaults).
insert into public.school_settings (school_id)
select s.id from public.schools s
on conflict (school_id) do nothing;

-- Timetable-driven registers: how many minutes after a lesson's scheduled
-- start a register submission is still "on time". Beyond this the session
-- is flagged late. Ad-hoc (manual) registers are never flagged.
alter table public.school_settings
  add column if not exists register_late_minutes int not null default 20;

-- ============================================================================
-- 2. RLS — staff of the school can read (teachers need it to know which
-- buttons to hide). All writes are RPC-only (no write policies).
-- ============================================================================

alter table public.school_settings enable row level security;

drop policy if exists "school_settings_school_read" on public.school_settings;
create policy "school_settings_school_read" on public.school_settings
  for select to authenticated
  using (
    exists (
      select 1 from public.profiles p
       where p.id = auth.uid()
         and p.school_id = school_settings.school_id
         and p.role in ('teacher','school_organiser')
    )
  );

-- ============================================================================
-- 3. PERMISSION HELPERS
-- ============================================================================

-- _school_teacher_perm — the EFFECTIVE permission for the current caller.
--   organiser of the school  → always true
--   teacher of the school    → the flag (missing row coalesces to true)
--   anyone else              → false
-- Unknown permission keys are a coding error: deny.
create or replace function public._school_teacher_perm(
  p_school_id uuid,
  p_perm      text
)
returns boolean
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_row public.school_settings%rowtype;
begin
  if auth.uid() is null then
    return false;
  end if;
  -- Organiser of the school: always allowed.
  if exists (
    select 1 from public.schools
     where id = p_school_id
       and owner_user_id = auth.uid()
  ) then
    return true;
  end if;
  -- Must be a teacher of the school.
  if not exists (
    select 1 from public.profiles
     where id = auth.uid()
       and school_id = p_school_id
       and role = 'teacher'
  ) then
    return false;
  end if;
  select * into v_row from public.school_settings where school_id = p_school_id;
  return case p_perm
    when 'create_classes'     then coalesce(v_row.perm_create_classes, true)
    when 'behaviour_praise'   then coalesce(v_row.perm_behaviour_praise, true)
    when 'register_absences'  then coalesce(v_row.perm_register_absences, true)
    when 'ops_announcements'  then coalesce(v_row.perm_ops_announcements, true)
    else false
  end;
end;
$$;

-- _assert_school_staff_with_perm — guard for gated RPCs.
-- The staff check is inlined (mirrors _assert_school_staff in
-- supabase_classes_and_submissions.sql) so this file depends only on the
-- base tables; the permission check then raises 42501 when the toggle
-- is off for the caller.
create or replace function public._assert_school_staff_with_perm(
  p_school_id uuid,
  p_perm      text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.schools where id = p_school_id
  ) then
    raise exception 'unknown school' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.profiles
     where id = auth.uid()
       and school_id = p_school_id
       and role in ('teacher','school_organiser')
  ) then
    raise exception 'staff of this school required' using errcode = '42501';
  end if;
  if not public._school_teacher_perm(p_school_id, p_perm) then
    raise exception 'permission % required', p_perm using errcode = '42501';
  end if;
end;
$$;

-- ============================================================================
-- 4. SETTINGS RPCs
-- ============================================================================

-- get_school_settings — EFFECTIVE permissions for the current caller
-- (organiser gets all-true; teachers get their flags). Any staff member of
-- the school may call it — the UI uses it to hide gated controls.
create or replace function public.get_school_settings(
  p_school_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_row public.school_settings%rowtype;
  v_is_organiser boolean;
begin
  if auth.uid() is null then
    return jsonb_build_object('ok', false, 'reason', 'not_authenticated');
  end if;
  if not exists (
    select 1 from public.profiles
     where id = auth.uid()
       and school_id = p_school_id
       and role in ('teacher','school_organiser')
  ) then
    return jsonb_build_object('ok', false, 'reason', 'forbidden');
  end if;
  select * into v_row from public.school_settings where school_id = p_school_id;
  v_is_organiser := exists (
    select 1 from public.schools
     where id = p_school_id and owner_user_id = auth.uid()
  );
  return jsonb_build_object(
    'ok', true,
    'is_organiser', v_is_organiser,
    'perms', jsonb_build_object(
      'create_classes',    coalesce(v_row.perm_create_classes, true),
      'behaviour_praise',  coalesce(v_row.perm_behaviour_praise, true),
      'register_absences', coalesce(v_row.perm_register_absences, true),
      'ops_announcements', coalesce(v_row.perm_ops_announcements, true)
    ),
    -- The raw stored flags are included so the settings page can render
    -- the switches even for the organiser (whose effective perms are
    -- always true).
    'stored', jsonb_build_object(
      'create_classes',    coalesce(v_row.perm_create_classes, true),
      'behaviour_praise',  coalesce(v_row.perm_behaviour_praise, true),
      'register_absences', coalesce(v_row.perm_register_absences, true),
      'ops_announcements', coalesce(v_row.perm_ops_announcements, true)
    ),
    'updated_at', v_row.updated_at
  );
end;
$$;
grant execute on function public.get_school_settings(uuid) to authenticated;

-- update_school_settings — organiser-only. Accepts a jsonb object whose
-- keys are validated against the four known flags (unknown keys are
-- rejected so a stale client can't invent permissions).
create or replace function public.update_school_settings(
  p_school_id uuid,
  p_perms     jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_perms jsonb := coalesce(p_perms, '{}'::jsonb);
  v_key   text;
begin
  perform public._assert_school_organiser(p_school_id);

  -- Validate keys first — reject anything unknown.
  for v_key in select jsonb_object_keys(v_perms)
  loop
    if v_key not in (
      'create_classes','behaviour_praise','register_absences','ops_announcements'
    ) then
      return jsonb_build_object('ok', false, 'reason', 'unknown_permission', 'key', v_key);
    end if;
  end loop;

  insert into public.school_settings as ss (
    school_id,
    perm_create_classes,
    perm_behaviour_praise,
    perm_register_absences,
    perm_ops_announcements,
    updated_at,
    updated_by
  ) values (
    p_school_id,
    coalesce((v_perms->>'create_classes')::boolean, true),
    coalesce((v_perms->>'behaviour_praise')::boolean, true),
    coalesce((v_perms->>'register_absences')::boolean, true),
    coalesce((v_perms->>'ops_announcements')::boolean, true),
    now(),
    auth.uid()
  )
  on conflict (school_id) do update
    set perm_create_classes    = excluded.perm_create_classes,
        perm_behaviour_praise  = excluded.perm_behaviour_praise,
        perm_register_absences = excluded.perm_register_absences,
        perm_ops_announcements = excluded.perm_ops_announcements,
        updated_at             = excluded.updated_at,
        updated_by             = excluded.updated_by;

  return jsonb_build_object('ok', true);
end;
$$;
grant execute on function public.update_school_settings(uuid, jsonb) to authenticated;

-- ============================================================================
-- 5. PATCH create_class — respect the "create_classes" toggle.
-- Verbatim from supabase_classes_and_submissions.sql apart from the
-- permission failure path. The staff check still raises; the permission
-- check returns a jsonb reason so the existing UI shows a friendly error.
-- ============================================================================

drop function if exists public.create_class(uuid, text, text, uuid, uuid);

create or replace function public.create_class(
  p_school_id   uuid,
  p_name        text,
  p_description text default null,
  p_tutor_user_id uuid default null,
  p_subject_id    uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_clean text := trim(coalesce(p_name, ''));
  v_id    uuid;
begin
  perform public._assert_school_staff(p_school_id);
  if not public._school_teacher_perm(p_school_id, 'create_classes') then
    return jsonb_build_object('ok', false, 'reason', 'permission_create_classes');
  end if;
  if v_clean = '' then
    return jsonb_build_object('ok', false, 'reason', 'name_required');
  end if;
  insert into public.classes (school_id, name, description, owner_user_id, tutor_user_id, subject_id)
  values (
    p_school_id, v_clean,
    nullif(trim(coalesce(p_description, '')), ''),
    auth.uid(),
    p_tutor_user_id,
    p_subject_id
  )
  returning id into v_id;
  return jsonb_build_object('ok', true, 'class_id', v_id);
end;
$$;
grant execute on function public.create_class(uuid, text, text, uuid, uuid) to authenticated;

-- ============================================================================
-- DONE.
--
-- After running this migration:
--   1. Organisers can visit school-settings.html and toggle teacher
--      permissions.
--   2. classes.html hides the "+ New class" button for teachers whose
--      school has create_classes off, and create_class returns
--      {ok:false, reason:'permission_create_classes'} server-side.
--   3. Schools with no settings row behave exactly as before (all-on).
-- ============================================================================