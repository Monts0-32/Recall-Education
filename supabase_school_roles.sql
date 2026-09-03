-- ============================================================================
-- Recall Education — School Roles (Discord-style) + granular permissions
-- Run AFTER supabase_school_settings.sql AND supabase_school_systems.sql.
-- Idempotent: safe to re-run.
--
-- ⚠ SUPERSEDES FUNCTIONS IN supabase_school_settings.sql:
--   _school_teacher_perm, get_school_settings and update_school_settings
--   are REDEFINED here. If you re-run supabase_school_settings.sql
--   afterwards, you MUST re-run this file again (same supersede pattern
--   as create_class) — otherwise permissions fall back to the old four
--   school-wide toggles.
--
-- What this does:
--   1. Role tables:
--        school_roles         — named roles per school (Discord-style)
--        school_role_perms    — which of the 11 granular keys a role grants
--        school_role_members  — which staff are in which role
--   2. Role-aware _school_teacher_perm:
--        organiser of the school        → always true
--        teacher of the school with NO
--        role memberships in the school → always true (roles only ever
--                                        restrict or grant — a school that
--                                        hasn't set up roles behaves
--                                        exactly as before)
--        teacher with role memberships   → true if ANY of their roles
--                                        grants the key
--        anyone else                     → false
--      The old composite keys are still accepted and map onto the
--      granular sets, so nothing breaks if an older file/page passes
--      'register_absences', 'behaviour_praise' or 'ops_announcements'.
--   3. get_school_settings now returns the 11 granular perms (plus the
--      legacy composites) AND register_late_minutes for the register
--      late window.
--   4. update_school_settings now only manages register_late_minutes
--      (0-240 minutes); permission flags moved into roles.
--   5. Role management RPCs (organiser-only) + list RPCs (staff-wide).
--   6. transfer_organiser — the organiser hands the school to a
--      teacher; the old organiser becomes a teacher. Exactly one
--      organiser per school, enforced by schools.owner_user_id.
--
-- The 11 permission keys:
--   create_classes, register, absences, behaviour, praise, announcements,
--   booking, resources, clubs, timetable, analytics
--
-- NOTE: the admin-only transfer_school_ownership in
-- supabase_school_organisers.sql is untouched; transfer_organiser below
-- is the organiser-initiated path.
-- ============================================================================

-- ============================================================================
-- 1. TABLES
-- ============================================================================

create table if not exists public.school_roles (
  id         uuid primary key default gen_random_uuid(),
  school_id  uuid not null references public.schools(id) on delete cascade,
  name       text not null,
  colour     text,
  position   int  not null default 0,
  created_at timestamptz not null default now(),
  unique (school_id, name)
);

create table if not exists public.school_role_perms (
  role_id uuid not null references public.school_roles(id) on delete cascade,
  perm    text not null check (perm in (
    'create_classes','register','absences','behaviour','praise',
    'announcements','booking','resources','clubs','timetable','analytics'
  )),
  primary key (role_id, perm)
);

create table if not exists public.school_role_members (
  role_id  uuid not null references public.school_roles(id) on delete cascade,
  user_id  uuid not null references auth.users(id) on delete cascade,
  added_by uuid references auth.users(id) on delete set null,
  added_at timestamptz not null default now(),
  primary key (role_id, user_id)
);
create index if not exists school_role_members_user_idx
  on public.school_role_members (user_id);

-- ============================================================================
-- 2. RLS — staff of the school can read (the hub and sub-pages use
-- this to know which tiles to unlock). All writes are RPC-only.
-- ============================================================================

alter table public.school_roles        enable row level security;
alter table public.school_role_perms   enable row level security;
alter table public.school_role_members enable row level security;

drop policy if exists "school_roles_school_read" on public.school_roles;
create policy "school_roles_school_read" on public.school_roles
  for select to authenticated
  using (
    exists (
      select 1 from public.profiles p
       where p.id = auth.uid()
         and p.school_id = school_roles.school_id
         and p.role in ('teacher','school_organiser')
    )
  );

drop policy if exists "school_role_perms_school_read" on public.school_role_perms;
create policy "school_role_perms_school_read" on public.school_role_perms
  for select to authenticated
  using (
    exists (
      select 1 from public.school_roles r
      join public.profiles p on p.id = auth.uid()
       where r.id = school_role_perms.role_id
         and p.school_id = r.school_id
         and p.role in ('teacher','school_organiser')
    )
  );

drop policy if exists "school_role_members_school_read" on public.school_role_members;
create policy "school_role_members_school_read" on public.school_role_members
  for select to authenticated
  using (
    exists (
      select 1 from public.school_roles r
      join public.profiles p on p.id = auth.uid()
       where r.id = school_role_members.role_id
         and p.school_id = r.school_id
         and p.role in ('teacher','school_organiser')
    )
  );

-- ============================================================================
-- 3. ROLE-AWARE PERMISSION RESOLUTION
-- ============================================================================

-- _school_teacher_perm — SUPERSEDES the version in
-- supabase_school_settings.sql. Same signature, so create or replace is
-- enough (no drop needed — return type unchanged).
--
--   organiser of the school          → true (always, every key)
--   not a teacher of the school      → false
--   unknown key                      → false (coding error: deny)
--   teacher with NO role rows here   → true (roles not configured =
--                                       everything enabled)
--   teacher with role rows           → true if any of their roles
--                                       grants the key (or one of the
--                                       legacy composite's keys)
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

-- ============================================================================
-- 4. SETTINGS RPCs (SUPERSEDE supabase_school_settings.sql)
-- ============================================================================

-- get_school_settings — effective permissions for the current caller
-- plus the register late window. Readable by all staff of the school.
-- Same signature as before, so create or replace is enough.
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
      -- Legacy composite keys, kept so older pages keep working.
      'register_absences', public._school_teacher_perm(p_school_id, 'register_absences'),
      'behaviour_praise',  public._school_teacher_perm(p_school_id, 'behaviour_praise'),
      'ops_announcements', public._school_teacher_perm(p_school_id, 'ops_announcements')
    ),
    'register_late_minutes', coalesce(v_row.register_late_minutes, 20),
    'updated_at', v_row.updated_at
  );
end;
$$;
grant execute on function public.get_school_settings(uuid) to authenticated;

-- update_school_settings — SUPERSEDES the (uuid, jsonb) version, which
-- managed the four legacy toggles. Permission flags now live in roles;
-- this only manages the register late window.
drop function if exists public.update_school_settings(uuid, jsonb);

create or replace function public.update_school_settings(
  p_school_id     uuid,
  p_late_minutes  int default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public._assert_school_organiser(p_school_id);

  if p_late_minutes is null then
    return jsonb_build_object('ok', false, 'reason', 'invalid_late_minutes');
  end if;
  if p_late_minutes < 0 or p_late_minutes > 240 then
    return jsonb_build_object('ok', false, 'reason', 'invalid_late_minutes');
  end if;

  insert into public.school_settings as ss (
    school_id, register_late_minutes, updated_at, updated_by
  ) values (
    p_school_id, p_late_minutes, now(), auth.uid()
  )
  on conflict (school_id) do update
    set register_late_minutes = excluded.register_late_minutes,
        updated_at            = excluded.updated_at,
        updated_by            = excluded.updated_by;

  return jsonb_build_object('ok', true, 'register_late_minutes', p_late_minutes);
end;
$$;
grant execute on function public.update_school_settings(uuid, int) to authenticated;

-- ============================================================================
-- 5. ROLE MANAGEMENT RPCs (organiser-only) + LIST RPCs (staff-wide)
-- ============================================================================

-- create_school_role — organiser-only. A role with no perms is a
-- "lock down" role: holding it means permissions are decided by role
-- grants alone (staff with no roles at all keep everything).
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
        'announcements','booking','resources','clubs','timetable','analytics'
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

-- update_school_role — organiser-only. Null params are left unchanged;
-- a non-null p_perms replaces the role's whole permission set.
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
        'announcements','booking','resources','clubs','timetable','analytics'
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

-- delete_school_role — organiser-only. Cascades perms + memberships.
create or replace function public.delete_school_role(
  p_role_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role public.school_roles%rowtype;
begin
  select * into v_role from public.school_roles where id = p_role_id;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'unknown_role');
  end if;
  perform public._assert_school_organiser(v_role.school_id);

  delete from public.school_roles where id = p_role_id;
  return jsonb_build_object('ok', true);
end;
$$;
grant execute on function public.delete_school_role(uuid) to authenticated;

-- assign_school_role — organiser-only. Assignees must be current staff
-- of the role's school. Newly added members get a bell notification.
create or replace function public.assign_school_role(
  p_role_id  uuid,
  p_user_ids uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role public.school_roles%rowtype;
  v_user uuid;
  v_added int := 0;
begin
  select * into v_role from public.school_roles where id = p_role_id;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'unknown_role');
  end if;
  perform public._assert_school_organiser(v_role.school_id);

  if p_user_ids is null or coalesce(array_length(p_user_ids, 1), 0) = 0 then
    return jsonb_build_object('ok', false, 'reason', 'no_users');
  end if;

  -- Validate every assignee up-front so nothing half-applies.
  foreach v_user in array p_user_ids
  loop
    if not exists (
      select 1 from public.profiles
       where id = v_user
         and school_id = v_role.school_id
         and role in ('teacher','school_organiser')
         and removed_from_school_at is null
         and deleted_at is null
    ) then
      return jsonb_build_object('ok', false, 'reason', 'invalid_user');
    end if;
  end loop;

  -- Insert with ON CONFLICT DO NOTHING and notify only the rows this
  -- call actually added (FOR over INSERT ... RETURNING skips dups).
  for v_user in
    insert into public.school_role_members (role_id, user_id, added_by)
    select p_role_id, u, auth.uid() from unnest(p_user_ids) as u
    on conflict do nothing
    returning user_id
  loop
    v_added := v_added + 1;
    perform public.push_notification(
      v_user, 'role', v_role.school_id,
      'You have been given the role "' || v_role.name || '" at your school.'
    );
  end loop;

  return jsonb_build_object('ok', true, 'added', v_added);
end;
$$;
grant execute on function public.assign_school_role(uuid, uuid[]) to authenticated;

-- remove_school_role_member — organiser-only.
create or replace function public.remove_school_role_member(
  p_role_id uuid,
  p_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role public.school_roles%rowtype;
begin
  select * into v_role from public.school_roles where id = p_role_id;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'unknown_role');
  end if;
  perform public._assert_school_organiser(v_role.school_id);

  delete from public.school_role_members
   where role_id = p_role_id and user_id = p_user_id;
  return jsonb_build_object('ok', true);
end;
$$;
grant execute on function public.remove_school_role_member(uuid, uuid) to authenticated;

-- list_school_roles — readable by all staff of the school.
create or replace function public.list_school_roles(
  p_school_id uuid
)
returns table (
  id           uuid,
  name         text,
  colour       text,
  perms        text[],
  member_count int
)
language sql
security definer
set search_path = public
stable
as $$
  select r.id,
         r.name,
         r.colour,
         coalesce(array_agg(rp.perm order by rp.perm)
                    filter (where rp.perm is not null), '{}') as perms,
         (select count(*)::int
            from public.school_role_members m
           where m.role_id = r.id) as member_count
    from public.school_roles r
    left join public.school_role_perms rp on rp.role_id = r.id
   where r.school_id = p_school_id
     and exists (
       select 1 from public.profiles me
        where me.id = auth.uid()
          and me.school_id = p_school_id
          and me.role in ('teacher','school_organiser')
     )
   group by r.id, r.name, r.colour, r.position
   order by r.position asc, r.name asc;
$$;
grant execute on function public.list_school_roles(uuid) to authenticated;

-- list_school_role_members — readable by all staff of the school.
create or replace function public.list_school_role_members(
  p_role_id uuid
)
returns table (
  user_id   uuid,
  full_name text,
  email     text,
  role      text
)
language sql
security definer
set search_path = public
stable
as $$
  select m.user_id,
         coalesce(p.full_name, u.email::text, '') as full_name,
         u.email::text as email,
         p.role
    from public.school_role_members m
    join public.school_roles r  on r.id = m.role_id
    join public.profiles p      on p.id = m.user_id
    join auth.users u           on u.id = m.user_id
   where m.role_id = p_role_id
     and exists (
       select 1 from public.profiles me
        where me.id = auth.uid()
          and me.school_id = r.school_id
          and me.role in ('teacher','school_organiser')
     )
   order by p.full_name asc;
$$;
grant execute on function public.list_school_role_members(uuid) to authenticated;

-- ============================================================================
-- 6. TRANSFER ORGANISER
--
-- The organiser hands the school to one of its teachers. The old
-- organiser is demoted to teacher. One transaction, so a school can
-- never end up with zero or two organisers.
--
-- NOTE: the caller's JWT (app_metadata.role) can stay stale for up to
-- ~1h after this. That's harmless: every write is re-checked
-- server-side against schools.owner_user_id, so the old organiser may
-- see organiser UI briefly but can't use it.
-- ============================================================================

create or replace function public.transfer_organiser(
  p_school_id    uuid,
  p_new_owner_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_school public.schools%rowtype;
  v_old_owner uuid;
begin
  if auth.uid() is null then
    return jsonb_build_object('ok', false, 'reason', 'not_authenticated');
  end if;
  select * into v_school from public.schools where id = p_school_id;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'unknown_school');
  end if;
  -- Caller must be the current organiser. (Raises 42501 — the settings
  -- page is organiser-gated anyway.)
  perform public._assert_school_organiser(p_school_id);

  if p_new_owner_id is null or p_new_owner_id = auth.uid() then
    return jsonb_build_object('ok', false, 'reason', 'invalid_target');
  end if;
  -- Target must be a current teacher of this school.
  if not exists (
    select 1 from public.profiles
     where id = p_new_owner_id
       and school_id = p_school_id
       and role = 'teacher'
       and removed_from_school_at is null
       and deleted_at is null
  ) then
    return jsonb_build_object('ok', false, 'reason', 'invalid_target');
  end if;
  -- A person can only organise one school (partial unique index on
  -- schools.owner_user_id would otherwise throw a raw unique_violation).
  if exists (
    select 1 from public.schools
     where owner_user_id = p_new_owner_id
       and id <> p_school_id
  ) then
    return jsonb_build_object('ok', false, 'reason', 'target_owns_school');
  end if;

  v_old_owner := v_school.owner_user_id;

  update public.schools
     set owner_user_id = p_new_owner_id
   where id = p_school_id;

  update public.profiles
     set role = 'teacher'
   where id = v_old_owner
     and school_id = p_school_id;

  update public.profiles
     set role = 'school_organiser'
   where id = p_new_owner_id
     and school_id = p_school_id;

  perform public.push_notification(
    p_new_owner_id, 'role', p_school_id,
    'You are now the organiser of ' || v_school.name || '.'
  );

  return jsonb_build_object('ok', true);
end;
$$;
grant execute on function public.transfer_organiser(uuid, uuid) to authenticated;

-- ============================================================================
-- DONE.
--
-- After running this migration:
--   1. Every staff member with no role keeps every permission (schools
--      behave exactly as before roles existed).
--   2. Organisers can visit school-settings.html to create roles, pick
--      their permissions and assign staff.
--   3. Direct write RPCs are guarded server-side regardless of what the
--      client UI hides.
--   4. supabase_school_settings.sql must NOT be re-run afterwards
--      without re-running this file (see the warning at the top).
-- ============================================================================