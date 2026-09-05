-- ============================================================================
-- Recall Education — Student groups (tutor groups + sets), class rooms,
-- and group-targeted timetables
--
-- Run AFTER supabase_school_roles.sql, supabase_classes_and_submissions.sql,
-- supabase_school_settings.sql, supabase_school_systems.sql,
-- supabase_student_access.sql and supabase_booking_day_structure.sql
-- (it restates functions from all of them). Idempotent.
--
-- What this adds:
--   1. A new permission key 'groups' (managing student groups) — added to
--      the school_role_perms CHECK, the _school_teacher_perm case map,
--      get_school_settings' perms object, and the role RPC allowlists.
--   2. Tables:
--        student_groups        — a tutor group (form group, e.g. "8T")
--                                or a set (ability group, e.g. "Set 2
--                                Maths"), one table with kind + name.
--        student_group_members — students in each group.
--        class_group_targets   — classes targeted at one or many groups.
--      Classes gain room_id → public.resources (kind='room'): a class is
--      tied to a room, and timetable slots fall back to the class's room
--      when the slot itself has no room override.
--   3. Group RPCs (list/create/update/delete group, add/remove members,
--      list members) — reads for staff of the school; writes gated on
--      the 'groups' perm (organisers always pass; teachers with no role
--      rows fail open, same as every other perm).
--   4. Class RPCs grown: create_class/update_class accept p_room_id
--      (validated against the school's resources); list_classes returns
--      room_id/room_name + a groups jsonb array; get_class likewise;
--      new set_class_groups replaces a class's target groups.
--   5. Timetable reads: list_timetable_slots + list_student_timetable
--      now coalesce slot.room with the class's room; student timetables
--      include classes targeted at any of the student's groups (in
--      ADDITION to direct class_members rosters, which keep working);
--      new list_student_timetable_for lets timetable-permitted staff
--      preview any student's derived timetable.
-- ============================================================================

-- ============================================================================
-- 0. PERMISSION KEY 'groups'
-- ============================================================================

-- 0.1 Widen the CHECK on school_role_perms.
alter table public.school_role_perms
  drop constraint if exists school_role_perms_perm_check;
alter table public.school_role_perms
  add constraint school_role_perms_perm_check
  check (perm in (
    'create_classes','register','absences','behaviour','praise',
    'announcements','booking','resources','clubs','timetable','analytics',
    'groups'
  ));

-- 0.2 _school_teacher_perm — restated from supabase_school_roles.sql with
-- the 'groups' key added to the case map. Unknown keys still deny.
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
  v_keys text[];
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
  -- Resolve the key. Legacy composite keys (from the old settings
  -- toggles) map onto their granular sets so older callers keep
  -- working. Unknown keys: deny.
  v_keys := case p_perm
    when 'create_classes'    then array['create_classes']
    when 'register'          then array['register']
    when 'absences'          then array['absences']
    when 'behaviour'         then array['behaviour']
    when 'praise'            then array['praise']
    when 'announcements'     then array['announcements']
    when 'booking'           then array['booking']
    when 'resources'         then array['resources']
    when 'clubs'             then array['clubs']
    when 'timetable'         then array['timetable']
    when 'analytics'         then array['analytics']
    when 'groups'            then array['groups']
    when 'register_absences' then array['register','absences']
    when 'behaviour_praise'  then array['behaviour','praise']
    when 'ops_announcements' then array['announcements','booking','resources','clubs']
    else null
  end;
  if v_keys is null then
    return false;
  end if;
  -- No role memberships in this school → nothing configured → allow.
  if not exists (
    select 1 from public.school_role_members m
    join public.school_roles r on r.id = m.role_id
     where m.user_id = auth.uid()
       and r.school_id = p_school_id
  ) then
    return true;
  end if;
  -- OR across every role the caller holds: any granting role unlocks it.
  return exists (
    select 1 from public.school_role_members m
    join public.school_roles r       on r.id = m.role_id
    join public.school_role_perms rp on rp.role_id = r.id
     where m.user_id = auth.uid()
       and r.school_id = p_school_id
       and rp.perm = any(v_keys)
  );
end;
$$;

-- 0.3 get_school_settings — restated from supabase_booking_day_structure.sql
-- with the 'groups' perm added to the perms object.
drop function if exists public.get_school_settings(uuid);

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
  return jsonb_build_object(
    'ok', true,
    'is_organiser', exists (
      select 1 from public.schools
       where id = p_school_id and owner_user_id = auth.uid()
    ),
    'perms', jsonb_build_object(
      'create_classes', public._school_teacher_perm(p_school_id, 'create_classes'),
      'register',       public._school_teacher_perm(p_school_id, 'register'),
      'absences',       public._school_teacher_perm(p_school_id, 'absences'),
      'behaviour',      public._school_teacher_perm(p_school_id, 'behaviour'),
      'praise',         public._school_teacher_perm(p_school_id, 'praise'),
      'announcements',  public._school_teacher_perm(p_school_id, 'announcements'),
      'booking',        public._school_teacher_perm(p_school_id, 'booking'),
      'resources',      public._school_teacher_perm(p_school_id, 'resources'),
      'clubs',          public._school_teacher_perm(p_school_id, 'clubs'),
      'timetable',      public._school_teacher_perm(p_school_id, 'timetable'),
      'analytics',      public._school_teacher_perm(p_school_id, 'analytics'),
      'groups',         public._school_teacher_perm(p_school_id, 'groups'),
      -- Legacy composite keys, kept so older pages keep working.
      'register_absences', public._school_teacher_perm(p_school_id, 'register_absences'),
      'behaviour_praise',  public._school_teacher_perm(p_school_id, 'behaviour_praise'),
      'ops_announcements', public._school_teacher_perm(p_school_id, 'ops_announcements')
    ),
    'register_late_minutes', coalesce(v_row.register_late_minutes, 20),
    'periods_per_day',       coalesce(v_row.periods_per_day, 8),
    'day_start_time',        coalesce(v_row.day_start_time, '08:30'::time),
    'day_end_time',          coalesce(v_row.day_end_time, '15:30'::time),
    'period_length_minutes', coalesce(v_row.period_length_minutes, 50),
    'booking_max_periods',   coalesce(v_row.booking_max_periods, 0),
    'booking_advance_days',  coalesce(v_row.booking_advance_days, 0),
    'updated_at', v_row.updated_at
  );
end;
$$;

grant execute on function public.get_school_settings(uuid) to authenticated;

-- 0.4 create_school_role — restated from supabase_school_roles.sql with
-- 'groups' added to the permission allowlist.
create or replace function public.create_school_role(
  p_school_id uuid,
  p_name      text,
  p_colour    text default null,
  p_perms     text[] default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text := trim(coalesce(p_name, ''));
  v_perm text;
  v_id   uuid;
begin
  perform public._assert_school_organiser(p_school_id);

  if v_name = '' then
    return jsonb_build_object('ok', false, 'reason', 'name_required');
  end if;
  if p_colour is not null and p_colour !~ '^#[0-9A-Fa-f]{6}$' then
    return jsonb_build_object('ok', false, 'reason', 'invalid_colour');
  end if;
  if p_perms is not null then
    foreach v_perm in array p_perms
    loop
      if v_perm not in (
        'create_classes','register','absences','behaviour','praise',
        'announcements','booking','resources','clubs','timetable','analytics',
        'groups'
      ) then
        return jsonb_build_object('ok', false, 'reason', 'invalid_perm', 'perm', v_perm);
      end if;
    end loop;
  end if;

  if exists (
    select 1 from public.school_roles
     where school_id = p_school_id and name = v_name
  ) then
    return jsonb_build_object('ok', false, 'reason', 'name_taken');
  end if;

  insert into public.school_roles (school_id, name, colour)
  values (p_school_id, v_name, p_colour)
  returning id into v_id;

  if p_perms is not null and coalesce(array_length(p_perms, 1), 0) > 0 then
    insert into public.school_role_perms (role_id, perm)
    select v_id, unnest(p_perms)
    on conflict do nothing;
  end if;

  return jsonb_build_object('ok', true, 'role_id', v_id);
end;
$$;
grant execute on function public.create_school_role(uuid, text, text, text[]) to authenticated;

-- 0.5 update_school_role — restated from supabase_school_roles.sql with
-- 'groups' added to the permission allowlist.
create or replace function public.update_school_role(
  p_role_id uuid,
  p_name    text default null,
  p_colour  text default null,
  p_perms   text[] default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role  public.school_roles%rowtype;
  v_name  text;
  v_perm  text;
begin
  select * into v_role from public.school_roles where id = p_role_id;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'unknown_role');
  end if;
  perform public._assert_school_organiser(v_role.school_id);

  v_name := nullif(trim(coalesce(p_name, '')), '');
  if p_name is not null and v_name is null then
    return jsonb_build_object('ok', false, 'reason', 'name_required');
  end if;
  if v_name is not null and v_name <> v_role.name and exists (
    select 1 from public.school_roles
     where school_id = v_role.school_id and name = v_name and id <> v_role.id
  ) then
    return jsonb_build_object('ok', false, 'reason', 'name_taken');
  end if;
  if p_colour is not null and p_colour !~ '^#[0-9A-Fa-f]{6}$' then
    return jsonb_build_object('ok', false, 'reason', 'invalid_colour');
  end if;
  if p_perms is not null then
    foreach v_perm in array p_perms
    loop
      if v_perm not in (
        'create_classes','register','absences','behaviour','praise',
        'announcements','booking','resources','clubs','timetable','analytics',
        'groups'
      ) then
        return jsonb_build_object('ok', false, 'reason', 'invalid_perm', 'perm', v_perm);
      end if;
    end loop;
  end if;

  update public.school_roles
     set name   = coalesce(v_name, name),
         colour = coalesce(p_colour, colour)
   where id = p_role_id;

  if p_perms is not null then
    delete from public.school_role_perms where role_id = p_role_id;
    insert into public.school_role_perms (role_id, perm)
    select p_role_id, unnest(p_perms)
    on conflict do nothing;
  end if;

  return jsonb_build_object('ok', true);
end;
$$;
grant execute on function public.update_school_role(uuid, text, text, text[]) to authenticated;

-- ============================================================================
-- 1. TABLES
-- ============================================================================

-- A tutor group is a form/registration group (e.g. "8T"); a set is an
-- ability group (e.g. "Set 2 Maths"). One table: same shape, same RPCs.
create table if not exists public.student_groups (
  id         uuid primary key default gen_random_uuid(),
  school_id  uuid not null references public.schools(id) on delete cascade,
  kind       text not null check (kind in ('tutor_group','set')),
  name       text not null,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (school_id, kind, name)
);

create table if not exists public.student_group_members (
  group_id        uuid not null references public.student_groups(id) on delete cascade,
  student_user_id uuid not null references auth.users(id) on delete cascade,
  added_at        timestamptz not null default now(),
  primary key (group_id, student_user_id)
);
create index if not exists student_group_members_student_idx
  on public.student_group_members (student_user_id);

-- Classes ↔ groups many-to-many: a class scheduled at 8T is seen by every
-- student in 8T (their timetable derives from these rows).
create table if not exists public.class_group_targets (
  class_id uuid not null references public.classes(id) on delete cascade,
  group_id uuid not null references public.student_groups(id) on delete cascade,
  added_at timestamptz not null default now(),
  primary key (class_id, group_id)
);
create index if not exists class_group_targets_group_idx
  on public.class_group_targets (group_id);

-- A class is tied to a room (bookable resources of kind='room').
alter table public.classes
  add column if not exists room_id uuid references public.resources(id)
  on delete set null;

-- ---------- RLS: staff of the school can read; writes are RPC-only ------
alter table public.student_groups        enable row level security;
alter table public.student_group_members enable row level security;
alter table public.class_group_targets   enable row level security;

drop policy if exists "student_groups_school_read" on public.student_groups;
create policy "student_groups_school_read" on public.student_groups
  for select to authenticated
  using (
    exists (
      select 1 from public.profiles p
       where p.id = auth.uid()
         and p.school_id = student_groups.school_id
         and p.role in ('teacher','school_organiser')
    )
  );

drop policy if exists "student_group_members_school_read" on public.student_group_members;
create policy "student_group_members_school_read" on public.student_group_members
  for select to authenticated
  using (
    exists (
      select 1 from public.student_groups g
      join public.profiles p on p.id = auth.uid()
       where g.id = student_group_members.group_id
         and p.school_id = g.school_id
         and p.role in ('teacher','school_organiser')
    )
  );

drop policy if exists "class_group_targets_school_read" on public.class_group_targets;
create policy "class_group_targets_school_read" on public.class_group_targets
  for select to authenticated
  using (
    exists (
      select 1 from public.classes c
      join public.profiles p on p.id = auth.uid()
       where c.id = class_group_targets.class_id
         and p.school_id = c.school_id
         and p.role in ('teacher','school_organiser')
    )
  );

-- ============================================================================
-- 2. GROUP RPCs
-- ============================================================================

-- list_student_groups — every group at the school (optionally one kind),
-- with a live member count. Staff of the school only (students get their
-- timetables via list_student_timetable, never this).
create or replace function public.list_student_groups(
  p_school_id uuid,
  p_kind      text default null
)
returns table (
  id           uuid,
  kind         text,
  name         text,
  member_count int,
  created_at   timestamptz
)
language sql
security definer
set search_path = public
stable
as $$
  select g.id, g.kind, g.name,
         (select count(*) from public.student_group_members m
           where m.group_id = g.id)::int,
         g.created_at
    from public.student_groups g
   where g.school_id = p_school_id
     and (p_kind is null or g.kind = p_kind)
     and exists (
       select 1 from public.profiles me
        where me.id = auth.uid()
          and me.school_id = p_school_id
          and me.role in ('teacher','school_organiser')
     )
   order by g.kind asc, g.name asc;
$$;
grant execute on function public.list_student_groups(uuid, text) to authenticated;

-- create_student_group — 'groups' perm (organisers always pass).
create or replace function public.create_student_group(
  p_school_id uuid,
  p_kind      text,
  p_name      text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text := trim(coalesce(p_name, ''));
  v_id   uuid;
begin
  perform public._assert_school_staff_with_perm(p_school_id, 'groups');
  if coalesce(p_kind, '') not in ('tutor_group','set') then
    return jsonb_build_object('ok', false, 'reason', 'invalid_kind');
  end if;
  if v_name = '' or length(v_name) > 60 then
    return jsonb_build_object('ok', false, 'reason', 'invalid_name');
  end if;
  if exists (
    select 1 from public.student_groups
     where school_id = p_school_id and kind = p_kind and name = v_name
  ) then
    return jsonb_build_object('ok', false, 'reason', 'name_taken');
  end if;
  insert into public.student_groups (school_id, kind, name, created_by)
  values (p_school_id, p_kind, v_name, auth.uid())
  returning id into v_id;
  return jsonb_build_object('ok', true, 'group_id', v_id);
end;
$$;
grant execute on function public.create_student_group(uuid, text, text) to authenticated;

-- update_student_group — rename. 'groups' perm.
create or replace function public.update_student_group(
  p_group_id uuid,
  p_name     text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_group public.student_groups%rowtype;
  v_name  text := trim(coalesce(p_name, ''));
begin
  if auth.uid() is null then
    return jsonb_build_object('ok', false, 'reason', 'not_authenticated');
  end if;
  select * into v_group from public.student_groups where id = p_group_id;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'unknown_group');
  end if;
  perform public._assert_school_staff_with_perm(v_group.school_id, 'groups');
  if v_name = '' or length(v_name) > 60 then
    return jsonb_build_object('ok', false, 'reason', 'invalid_name');
  end if;
  if v_name <> v_group.name and exists (
    select 1 from public.student_groups
     where school_id = v_group.school_id and kind = v_group.kind and name = v_name
  ) then
    return jsonb_build_object('ok', false, 'reason', 'name_taken');
  end if;
  update public.student_groups set name = v_name where id = p_group_id;
  return jsonb_build_object('ok', true);
end;
$$;
grant execute on function public.update_student_group(uuid, text) to authenticated;

-- delete_student_group — removes the group and its memberships; classes
-- targeting it lose that target (cascade). 'groups' perm.
create or replace function public.delete_student_group(
  p_group_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_group public.student_groups%rowtype;
begin
  if auth.uid() is null then
    return jsonb_build_object('ok', false, 'reason', 'not_authenticated');
  end if;
  select * into v_group from public.student_groups where id = p_group_id;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'unknown_group');
  end if;
  perform public._assert_school_staff_with_perm(v_group.school_id, 'groups');
  delete from public.student_groups where id = p_group_id;
  return jsonb_build_object('ok', true);
end;
$$;
grant execute on function public.delete_student_group(uuid) to authenticated;

-- list_student_group_members — roster of a group. Staff of the school.
create or replace function public.list_student_group_members(
  p_group_id uuid
)
returns table (
  student_user_id uuid,
  full_name       text,
  email           text,
  year_group      text,
  added_at        timestamptz
)
language sql
security definer
set search_path = public
stable
as $$
  select m.student_user_id,
         coalesce(p.full_name, '')::text,
         coalesce(u.email, '')::text,
         p.year_group,
         m.added_at
    from public.student_group_members m
    join public.student_groups g on g.id = m.group_id
    join public.profiles p on p.id = m.student_user_id
    left join auth.users u on u.id = m.student_user_id
   where m.group_id = p_group_id
     and exists (
       select 1 from public.profiles me
        where me.id = auth.uid()
          and me.school_id = g.school_id
          and me.role in ('teacher','school_organiser')
     )
   order by p.full_name asc;
$$;
grant execute on function public.list_student_group_members(uuid) to authenticated;

-- add_student_group_members — only active students of the same school.
-- 'groups' perm.
create or replace function public.add_student_group_members(
  p_group_id          uuid,
  p_student_user_ids  uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_group public.student_groups%rowtype;
  v_added int := 0;
begin
  if auth.uid() is null then
    return jsonb_build_object('ok', false, 'reason', 'not_authenticated');
  end if;
  select * into v_group from public.student_groups where id = p_group_id;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'unknown_group');
  end if;
  perform public._assert_school_staff_with_perm(v_group.school_id, 'groups');
  insert into public.student_group_members (group_id, student_user_id)
  select p_group_id, sid
    from unnest(coalesce(p_student_user_ids, '{}'::uuid[])) sid
    join public.profiles p on p.id = sid
   where p.school_id = v_group.school_id
     and p.role = 'student'
     and p.removed_from_school_at is null
     and p.deleted_at is null
  on conflict (group_id, student_user_id) do nothing;
  get diagnostics v_added = row_count;
  return jsonb_build_object('ok', true, 'added', v_added);
end;
$$;
grant execute on function public.add_student_group_members(uuid, uuid[]) to authenticated;

-- remove_student_group_member — 'groups' perm.
create or replace function public.remove_student_group_member(
  p_group_id         uuid,
  p_student_user_id  uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_group public.student_groups%rowtype;
begin
  if auth.uid() is null then
    return jsonb_build_object('ok', false, 'reason', 'not_authenticated');
  end if;
  select * into v_group from public.student_groups where id = p_group_id;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'unknown_group');
  end if;
  perform public._assert_school_staff_with_perm(v_group.school_id, 'groups');
  delete from public.student_group_members
   where group_id = p_group_id and student_user_id = p_student_user_id;
  return jsonb_build_object('ok', true);
end;
$$;
grant execute on function public.remove_student_group_member(uuid, uuid) to authenticated;

-- ============================================================================
-- 3. CLASS RPCs (grown: room + group targets)
-- ============================================================================

-- create_class — restated from supabase_school_settings.sql (the version
-- with the create_classes perm check) with p_room_id added.
drop function if exists public.create_class(uuid, text, text, uuid, uuid);

create or replace function public.create_class(
  p_school_id     uuid,
  p_name          text,
  p_description   text default null,
  p_tutor_user_id uuid default null,
  p_subject_id    uuid default null,
  p_room_id       uuid default null
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
  if p_room_id is not null and not exists (
    select 1 from public.resources r
     where r.id = p_room_id and r.school_id = p_school_id
  ) then
    return jsonb_build_object('ok', false, 'reason', 'invalid_room');
  end if;
  insert into public.classes
    (school_id, name, description, owner_user_id, tutor_user_id, subject_id, room_id)
  values (
    p_school_id, v_clean,
    nullif(trim(coalesce(p_description, '')), ''),
    auth.uid(),
    p_tutor_user_id,
    p_subject_id,
    p_room_id
  )
  returning id into v_id;
  return jsonb_build_object('ok', true, 'class_id', v_id);
end;
$$;
grant execute on function public.create_class(uuid, text, text, uuid, uuid, uuid) to authenticated;

-- update_class — restated from supabase_classes_and_submissions.sql with
-- p_room_id added (null clears the room; the room must belong to the
-- class's school when set).
drop function if exists public.update_class(uuid, text, text, boolean, uuid, uuid);

create or replace function public.update_class(
  p_class_id      uuid,
  p_name          text,
  p_description   text,
  p_archived      boolean,
  p_tutor_user_id uuid default null,
  p_subject_id    uuid default null,
  p_room_id       uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_class public.classes%rowtype;
begin
  if auth.uid() is null then
    return jsonb_build_object('ok', false, 'reason', 'not_authenticated');
  end if;
  select * into v_class from public.classes where classes.id = p_class_id;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'unknown_class');
  end if;
  -- Caller must be the organiser of the school OR the class owner.
  if not exists (
    select 1 from public.schools s
     where s.id = v_class.school_id
       and s.owner_user_id = auth.uid()
  ) and v_class.owner_user_id is distinct from auth.uid() then
    return jsonb_build_object('ok', false, 'reason', 'forbidden');
  end if;
  if p_room_id is not null and not exists (
    select 1 from public.resources r
     where r.id = p_room_id and r.school_id = v_class.school_id
  ) then
    return jsonb_build_object('ok', false, 'reason', 'invalid_room');
  end if;

  update public.classes
     set name          = coalesce(nullif(trim(p_name), ''), name),
         description   = nullif(trim(coalesce(p_description, '')), description),
         tutor_user_id = p_tutor_user_id,
         subject_id    = p_subject_id,
         room_id       = p_room_id
   where classes.id = p_class_id;
  return jsonb_build_object('ok', true);
end;
$$;
grant execute on function public.update_class(uuid, text, text, boolean, uuid, uuid, uuid) to authenticated;

-- list_classes — restated with room_id/room_name and a groups jsonb array
-- of {id, kind, name} target groups. Same signature, new return columns.
drop function if exists public.list_classes(uuid, boolean);

create or replace function public.list_classes(
  p_school_id         uuid,
  p_include_archived  boolean default false
)
returns table (
  id            uuid,
  name          text,
  description   text,
  owner_user_id uuid,
  owner_name    text,
  tutor_user_id uuid,
  tutor_name    text,
  subject_id    uuid,
  subject_name  text,
  room_id       uuid,
  room_name     text,
  groups        jsonb,
  member_count  int,
  created_at    timestamptz,
  archived_at   timestamptz
)
language sql
security definer
set search_path = public
stable
as $$
  select c.id, c.name, c.description, c.owner_user_id,
         coalesce(p.full_name, u.email, '')::text as owner_name,
         c.tutor_user_id,
         coalesce(pt.full_name, ut.email, '')::text as tutor_name,
         c.subject_id,
         s.name as subject_name,
         c.room_id,
         r.name as room_name,
         coalesce((
           select jsonb_agg(jsonb_build_object('id', g.id, 'kind', g.kind, 'name', g.name)
                            order by g.kind, g.name)
             from public.class_group_targets cgt
             join public.student_groups g on g.id = cgt.group_id
            where cgt.class_id = c.id
         ), '[]'::jsonb) as groups,
         (select count(*) from public.class_members cm where cm.class_id = c.id)::int,
         c.created_at, c.archived_at
    from public.classes c
    left join public.profiles p  on p.id  = c.owner_user_id
    left join auth.users    u  on u.id  = c.owner_user_id
    left join public.profiles pt on pt.id = c.tutor_user_id
    left join auth.users    ut on ut.id = c.tutor_user_id
    left join public.subjects s  on s.id  = c.subject_id
    left join public.resources r on r.id = c.room_id
   where c.school_id = p_school_id
     and (
       p_include_archived
       or c.archived_at is null
     )
   order by c.archived_at nulls first, c.created_at desc;
$$;
grant execute on function public.list_classes(uuid, boolean) to authenticated;

-- get_class — restated with room_id/room_name and a groups jsonb array.
drop function if exists public.get_class(uuid);

create or replace function public.get_class(
  p_class_id uuid
)
returns table (
  id            uuid,
  school_id     uuid,
  name          text,
  description   text,
  owner_user_id uuid,
  owner_name    text,
  tutor_user_id uuid,
  tutor_name    text,
  subject_id    uuid,
  subject_name  text,
  room_id       uuid,
  room_name     text,
  groups        jsonb,
  created_at     timestamptz,
  archived_at    timestamptz,
  members        jsonb
)
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_class public.classes%rowtype;
  v_members jsonb;
  v_groups  jsonb;
  v_owner_name text;
  v_tutor_name text;
  v_subject_name text;
  v_room_name text;
begin
  select * into v_class from public.classes where classes.id = p_class_id;
  if not found then
    return;
  end if;
  -- Caller must be in the school.
  if not exists (
    select 1 from public.profiles
     where id = auth.uid()
       and school_id = v_class.school_id
  ) then
    return;
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'student_user_id', m.student_user_id,
    'full_name',        p.full_name,
    'email',            u.email::text,
    'year_group',       p.year_group,
    'added_at',         m.added_at
  ) order by p.full_name), '[]'::jsonb)
    into v_members
    from public.class_members m
    join public.profiles p on p.id = m.student_user_id
    join auth.users u on u.id = m.student_user_id
   where m.class_id = p_class_id;
  select coalesce(jsonb_agg(jsonb_build_object('id', g.id, 'kind', g.kind, 'name', g.name)
                            order by g.kind, g.name), '[]'::jsonb)
    into v_groups
    from public.class_group_targets cgt
    join public.student_groups g on g.id = cgt.group_id
   where cgt.class_id = p_class_id;
  select coalesce(p.full_name, u.email, '')
    into v_owner_name
    from public.profiles p
    left join auth.users u on u.id = p.id
   where p.id = v_class.owner_user_id;
  if v_class.tutor_user_id is not null then
    select coalesce(p.full_name, u.email, '')
      into v_tutor_name
      from public.profiles p
      left join auth.users u on u.id = p.id
     where p.id = v_class.tutor_user_id;
  else
    v_tutor_name := null;
  end if;
  if v_class.subject_id is not null then
    select s.name into v_subject_name from public.subjects s where s.id = v_class.subject_id;
  else
    v_subject_name := null;
  end if;
  if v_class.room_id is not null then
    select r.name into v_room_name from public.resources r where r.id = v_class.room_id;
  else
    v_room_name := null;
  end if;
  id            := v_class.id;
  school_id     := v_class.school_id;
  name          := v_class.name;
  description   := v_class.description;
  owner_user_id := v_class.owner_user_id;
  owner_name    := coalesce(v_owner_name, '');
  tutor_user_id := v_class.tutor_user_id;
  tutor_name    := v_tutor_name;
  subject_id    := v_class.subject_id;
  subject_name  := v_subject_name;
  room_id       := v_class.room_id;
  room_name     := v_room_name;
  groups        := v_groups;
  created_at    := v_class.created_at;
  archived_at   := v_class.archived_at;
  members       := v_members;
  return next;
end;
$$;
grant execute on function public.get_class(uuid) to authenticated;

-- set_class_groups — replaces a class's whole target-group set. Gate:
-- organiser of the school OR the class owner (same as add_class_members).
-- Every group must belong to the class's school.
create or replace function public.set_class_groups(
  p_class_id  uuid,
  p_group_ids uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_class public.classes%rowtype;
  v_count int;
begin
  if auth.uid() is null then
    return jsonb_build_object('ok', false, 'reason', 'not_authenticated');
  end if;
  select * into v_class from public.classes where classes.id = p_class_id;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'unknown_class');
  end if;
  if not exists (
    select 1 from public.schools s
     where s.id = v_class.school_id
       and s.owner_user_id = auth.uid()
  ) and v_class.owner_user_id is distinct from auth.uid() then
    return jsonb_build_object('ok', false, 'reason', 'forbidden');
  end if;
  v_count := coalesce(array_length(coalesce(p_group_ids, '{}'::uuid[]), 1), 0);
  if v_count > 0 and (
    select count(*) from public.student_groups g
     where g.id = any(p_group_ids) and g.school_id = v_class.school_id
  ) <> v_count then
    return jsonb_build_object('ok', false, 'reason', 'invalid_group');
  end if;
  delete from public.class_group_targets where class_id = p_class_id;
  if v_count > 0 then
    insert into public.class_group_targets (class_id, group_id)
    select p_class_id, unnest(p_group_ids)
    on conflict (class_id, group_id) do nothing;
  end if;
  return jsonb_build_object('ok', true, 'count', v_count);
end;
$$;
grant execute on function public.set_class_groups(uuid, uuid[]) to authenticated;

-- ============================================================================
-- 4. TIMETABLE READS (room falls back to the class's room; students see
-- group-targeted classes)
-- ============================================================================

-- list_timetable_slots — restated: room coalesces with the class's room.
create or replace function public.list_timetable_slots(
  p_school_id       uuid,
  p_class_id        uuid default null,
  p_teacher_user_id uuid default null
)
returns table (
  id              uuid,
  class_id        uuid,
  class_name      text,
  teacher_user_id uuid,
  teacher_name    text,
  day_of_week     int,
  period          int,
  start_time      time,
  end_time        time,
  room            text,
  label           text
)
language sql
security definer
set search_path = public
stable
as $$
  select t.id,
         t.class_id,
         c.name as class_name,
         t.teacher_user_id,
         coalesce(tp.full_name, tu.email::text, '') as teacher_name,
         t.day_of_week,
         t.period,
         t.start_time,
         t.end_time,
         coalesce(t.room, r.name) as room,
         t.label
    from public.timetable_slots t
    left join public.classes c on c.id = t.class_id
    left join public.resources r on r.id = c.room_id
    left join public.profiles tp on tp.id = t.teacher_user_id
    left join auth.users tu on tu.id = t.teacher_user_id
   where t.school_id = p_school_id
     and (p_class_id is null or t.class_id = p_class_id)
     and (p_teacher_user_id is null or t.teacher_user_id = p_teacher_user_id)
     and exists (
       select 1 from public.profiles me
        where me.id = auth.uid()
          and me.school_id = p_school_id
          and me.role in ('teacher','school_organiser')
     )
   order by t.day_of_week asc, t.period asc;
$$;
grant execute on function public.list_timetable_slots(uuid, uuid, uuid) to authenticated;

-- list_student_timetable — restated: a student sees a slot when the class
-- targets ANY group they belong to, in addition to direct class rosters
-- (both keep working). Whole-school slots (class_id null) still show for
-- everyone.
drop function if exists public.list_student_timetable(uuid);

create or replace function public.list_student_timetable(
  p_school_id uuid
)
returns table (
  id              uuid,
  class_id        uuid,
  class_name      text,
  teacher_user_id uuid,
  teacher_name    text,
  day_of_week     int,
  period          int,
  start_time      time,
  end_time        time,
  room            text,
  label           text
)
language sql
security definer
set search_path = public
stable
as $$
  select t.id, t.class_id, c.name as class_name, t.teacher_user_id,
         coalesce(tp.full_name, tu.email::text, '') as teacher_name,
         t.day_of_week, t.period, t.start_time, t.end_time,
         coalesce(t.room, r.name) as room, t.label
    from public.timetable_slots t
    left join public.classes c on c.id = t.class_id
    left join public.resources r on r.id = c.room_id
    left join public.profiles tp on tp.id = t.teacher_user_id
    left join auth.users tu on tu.id = t.teacher_user_id
   where t.school_id = p_school_id
     and (
       t.class_id is null
       or exists (
         select 1
           from public.class_members cm
          where cm.class_id = t.class_id
            and cm.student_user_id = auth.uid()
       )
       or exists (
         select 1
           from public.class_group_targets cgt
           join public.student_group_members sgm on sgm.group_id = cgt.group_id
          where cgt.class_id = t.class_id
            and sgm.student_user_id = auth.uid()
       )
     )
     and public._is_school_student(p_school_id)
   order by t.day_of_week asc, t.period asc;
$$;

grant execute on function public.list_student_timetable(uuid) to authenticated;

-- list_student_timetable_for — NEW: lets timetable-permitted staff preview
-- the derived timetable of any active student in the school (so an
-- organiser can check what 8T sees). Caller must hold the 'timetable'
-- perm (organisers always pass).
create or replace function public.list_student_timetable_for(
  p_school_id        uuid,
  p_student_user_id uuid
)
returns table (
  id              uuid,
  class_id        uuid,
  class_name      text,
  teacher_user_id uuid,
  teacher_name    text,
  day_of_week     int,
  period          int,
  start_time      time,
  end_time        time,
  room            text,
  label           text
)
language sql
security definer
set search_path = public
stable
as $$
  select t.id, t.class_id, c.name as class_name, t.teacher_user_id,
         coalesce(tp.full_name, tu.email::text, '') as teacher_name,
         t.day_of_week, t.period, t.start_time, t.end_time,
         coalesce(t.room, r.name) as room, t.label
    from public.timetable_slots t
    left join public.classes c on c.id = t.class_id
    left join public.resources r on r.id = c.room_id
    left join public.profiles tp on tp.id = t.teacher_user_id
    left join auth.users tu on tu.id = t.teacher_user_id
   where t.school_id = p_school_id
     and (
       t.class_id is null
       or exists (
         select 1
           from public.class_members cm
          where cm.class_id = t.class_id
            and cm.student_user_id = p_student_user_id
       )
       or exists (
         select 1
           from public.class_group_targets cgt
           join public.student_group_members sgm on sgm.group_id = cgt.group_id
          where cgt.class_id = t.class_id
            and sgm.student_user_id = p_student_user_id
       )
     )
     -- The target must be an active student of the school.
     and exists (
       select 1 from public.profiles st
        where st.id = p_student_user_id
          and st.school_id = p_school_id
          and st.role = 'student'
          and st.removed_from_school_at is null
          and st.deleted_at is null
     )
     -- The caller must hold the timetable perm (staff; organisers pass).
     and public._school_teacher_perm(p_school_id, 'timetable')
   order by t.day_of_week asc, t.period asc;
$$;
grant execute on function public.list_student_timetable_for(uuid, uuid) to authenticated;

-- ============================================================================
-- DONE. After running this migration:
--   1. Manage groups from groups.html (tutor groups + sets, tabs).
--   2. classes.html: pick a room and target tutor groups/sets per class.
--   3. timetables.html: teachers without the timetable perm see their own
--      lessons read-only; permitted staff pick any teacher to edit or any
--      student to preview.
--   4. Student timetables derive from rosters AND targeted groups.
--   5. Re-running is safe (create or replace / if not exists throughout).
-- ============================================================================