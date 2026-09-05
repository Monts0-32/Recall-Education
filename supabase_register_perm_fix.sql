-- ============================================================================
-- Recall Education — Permission fail-closing + group-aware registers +
-- group timetables
--
-- Run AFTER every other supabase_*.sql migration, including
-- supabase_student_groups.sql (it restates functions from
-- supabase_school_roles.sql and supabase_school_systems.sql). Idempotent.
--
-- What this fixes:
--   1. PERMISSIONS FAIL CLOSED. _school_teacher_perm used to return true for
--      any teacher holding NO role in the school — so once an organiser
--      created roles, a teacher with none still had EVERY permission
--      (timetable editing, class creation, tutor group creation…).
--      New rule: a school with NO roles at all stays fail-open (nothing
--      configured, teachers keep everything); but the moment any role
--      exists in the school, a teacher holding none gets NOTHING.
--   2. GROUP-AWARE REGISTER ROSTERS. get_register / save_register only
--      looked at class_members, so a student who reaches a class through a
--      tutor group / set target (class_group_targets) was missing from the
--      register. The roster is now direct members UNION group-targeted
--      members, and save_register accepts marks for both.
--   3. REGISTERS ARE TODAY-ONLY. save_register rejects dates other than
--      today (Europe/London) with reason 'date_not_today'.
--   4. list_day_lessons falls back to the class's room when the slot has
--      no room of its own (same coalescing as list_timetable_slots).
--   5. NEW list_timetable_slots_for_group — every slot whose class is
--      scheduled for one tutor group / set. This powers the per-group
--      timetable view on timetables.html.
-- ============================================================================

-- ============================================================================
-- 1. _school_teacher_perm — fail closed when roles exist but caller holds none
-- ============================================================================

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
  -- No roles configured in this school at all → nothing has been set up
  -- → fail open (teachers keep everything, as before any roles existed).
  if not exists (
    select 1 from public.school_roles
     where school_id = p_school_id
  ) then
    return true;
  end if;
  -- Roles exist but the caller holds none → they have deliberately not
  -- been granted anything → deny everything.
  if not exists (
    select 1 from public.school_role_members m
    join public.school_roles r on r.id = m.role_id
     where m.user_id = auth.uid()
       and r.school_id = p_school_id
  ) then
    return false;
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
-- 2. REGISTER RPCs (group-aware rosters + today-only saves)
-- ============================================================================

-- save_register — restated from supabase_school_systems.sql with:
--   * today-only saves (reason 'date_not_today')
--   * marks accepted for group-targeted students as well as direct members
create or replace function public.save_register(
  p_class_id           uuid,
  p_date               date,
  p_marks              jsonb,
  p_period             int default 0,
  p_timetable_slot_id  uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_class  public.classes%rowtype;
  v_slot   public.timetable_slots%rowtype;
  v_late_minutes int;
  v_is_late boolean := false;
  v_sid    uuid;
  v_mark   jsonb;
  v_student uuid;
  v_status  text;
  v_note     text;
begin
  if auth.uid() is null then
    return jsonb_build_object('ok', false, 'reason', 'not_authenticated');
  end if;
  select * into v_class from public.classes where classes.id = p_class_id;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'unknown_class');
  end if;
  perform public._assert_school_staff_with_perm(v_class.school_id, 'register');
  if p_date is null then
    return jsonb_build_object('ok', false, 'reason', 'date_required');
  end if;
  -- Registers can only be completed for the current day.
  if p_date <> (now() at time zone 'Europe/London')::date then
    return jsonb_build_object('ok', false, 'reason', 'date_not_today');
  end if;
  if jsonb_typeof(p_marks) is distinct from 'array' or coalesce(jsonb_array_length(p_marks), 0) = 0 then
    return jsonb_build_object('ok', false, 'reason', 'no_marks');
  end if;

  -- A slot was supplied: it must belong to the class's school and be a
  -- slot for this class. The slot's period always wins over p_period.
  if p_timetable_slot_id is not null then
    select * into v_slot from public.timetable_slots
     where id = p_timetable_slot_id and school_id = v_class.school_id;
    if not found then
      return jsonb_build_object('ok', false, 'reason', 'unknown_slot');
    end if;
    if v_slot.class_id <> p_class_id then
      return jsonb_build_object('ok', false, 'reason', 'slot_mismatch');
    end if;
    p_period := v_slot.period;
  end if;

  -- Late window: minutes after the lesson's scheduled start (from
  -- school_settings, default 20). Only timetable-driven registers are
  -- ever flagged; ad-hoc (slotless) ones are not.
  if v_slot.id is not null then
    select coalesce(ss.register_late_minutes, 20)
      into v_late_minutes
      from public.school_settings ss
     where ss.school_id = v_class.school_id;
    if v_late_minutes is null then
      v_late_minutes := 20;
    end if;
    v_is_late := now() > (p_date + v_slot.start_time)::timestamp
                       + make_interval(mins => v_late_minutes);
  end if;

  -- Validate the payload up-front so a bad row can't half-save.
  for v_mark in select * from jsonb_array_elements(p_marks)
  loop
    v_status := v_mark->>'status';
    if v_status not in ('present','late','absent','excused') then
      return jsonb_build_object('ok', false, 'reason', 'invalid_status');
    end if;
  end loop;

  insert into public.register_sessions (
    school_id, class_id, session_date, taken_by,
    period, timetable_slot_id, submitted_at, is_late
  ) values (
    v_class.school_id, p_class_id, p_date, auth.uid(),
    coalesce(p_period, 0), v_slot.id, now(), v_is_late
  )
  on conflict (class_id, session_date, period) do update
    set taken_by          = auth.uid(),
        timetable_slot_id = excluded.timetable_slot_id,
        submitted_at      = now(),
        is_late           = public.register_sessions.is_late  -- sticky
  returning id into v_sid;

  -- Remove marks for students no longer on the roster (direct members OR
  -- group-targeted students).
  delete from public.register_marks m
   where m.session_id = v_sid
     and m.student_user_id not in (
       select (j->>'student_user_id')::uuid
         from jsonb_array_elements(p_marks) j
     );

  for v_mark in select * from jsonb_array_elements(p_marks)
  loop
    v_student := (v_mark->>'student_user_id')::uuid;
    v_status  := v_mark->>'status';
    v_note    := nullif(trim(coalesce(v_mark->>'note', '')), '');
    -- Only mark students actually on the class roster: direct members or
    -- members of a tutor group / set the class is scheduled for.
    if exists (
      select 1 from public.class_members cm
       where cm.class_id = p_class_id and cm.student_user_id = v_student
    ) or exists (
      select 1
        from public.class_group_targets cgt
        join public.student_group_members sgm on sgm.group_id = cgt.group_id
       where cgt.class_id = p_class_id
         and sgm.student_user_id = v_student
    ) then
      insert into public.register_marks (session_id, student_user_id, status, note)
      values (v_sid, v_student, v_status, v_note)
      on conflict (session_id, student_user_id) do update
        set status = excluded.status,
            note   = excluded.note;
    end if;
  end loop;

  select s.is_late into v_is_late from public.register_sessions s where s.id = v_sid;

  return jsonb_build_object('ok', true, 'session_id', v_sid, 'is_late', v_is_late);
end;
$$;
grant execute on function public.save_register(uuid, date, jsonb, int, uuid) to authenticated;

-- get_register — restated: the roster is direct class members UNION
-- students reached through a tutor group / set the class is scheduled for.
-- Same signature and return type as before.
create or replace function public.get_register(
  p_class_id uuid,
  p_date     date,
  p_period   int default 0
)
returns table (
  student_user_id uuid,
  full_name       text,
  year_group      text,
  status          text,
  note            text
)
language sql
security definer
set search_path = public
stable
as $$
  with roster as (
    select cm.student_user_id
      from public.class_members cm
     where cm.class_id = p_class_id
    union
    select sgm.student_user_id
      from public.class_group_targets cgt
      join public.student_group_members sgm on sgm.group_id = cgt.group_id
     where cgt.class_id = p_class_id
  )
  select r.student_user_id,
         coalesce(p.full_name, u.email::text, '') as full_name,
         p.year_group,
         m.status,
         m.note
    from roster r
    join public.profiles p on p.id = r.student_user_id
    join auth.users u on u.id = r.student_user_id
    left join public.register_sessions s
      on s.class_id = p_class_id and s.session_date = p_date
     and s.period = coalesce(p_period, 0)
    left join public.register_marks m
      on m.session_id = s.id and m.student_user_id = r.student_user_id
   where exists (
     select 1 from public.classes c
     join public.profiles me on me.id = auth.uid()
      where c.id = p_class_id
        and me.school_id = c.school_id
        and me.role in ('teacher','school_organiser')
   )
   order by p.full_name asc;
$$;
grant execute on function public.get_register(uuid, date, int) to authenticated;

-- ============================================================================
-- 3. list_day_lessons — slot room falls back to the class's room
-- ============================================================================

create or replace function public.list_day_lessons(
  p_school_id        uuid,
  p_date             date default current_date,
  p_teacher_user_id  uuid default null
)
returns table (
  slot_id         uuid,
  class_id        uuid,
  class_name      text,
  teacher_user_id uuid,
  teacher_name    text,
  period          int,
  start_time      time,
  end_time        time,
  room            text,
  label           text,
  session_id      uuid,
  is_late         boolean,
  submitted_at    timestamptz,
  present         int,
  absent          int,
  excused         int
)
language sql
security definer
set search_path = public
stable
as $$
  select t.id                as slot_id,
         t.class_id,
         c.name              as class_name,
         t.teacher_user_id,
         coalesce(tp.full_name, tu.email::text, '') as teacher_name,
         t.period,
         t.start_time,
         t.end_time,
         coalesce(t.room, r.name) as room,
         t.label,
         s.id                as session_id,
         s.is_late,
         s.submitted_at,
         coalesce(rm.present, 0),
         coalesce(rm.absent, 0),
         coalesce(rm.excused, 0)
    from public.timetable_slots t
    join public.classes c on c.id = t.class_id
    left join public.resources r on r.id = c.room_id
    left join public.profiles tp on tp.id = t.teacher_user_id
    left join auth.users tu on tu.id = t.teacher_user_id
    left join public.register_sessions s
      on s.class_id = t.class_id
     and s.session_date = p_date
     and s.period = t.period
     and s.school_id = t.school_id
    left join (
      select m.session_id,
             count(*) filter (where m.status = 'present')::int as present,
             count(*) filter (where m.status = 'absent')::int  as absent,
             count(*) filter (where m.status = 'excused')::int as excused
        from public.register_marks m
       group by m.session_id
    ) rm on rm.session_id = s.id
   where t.school_id = p_school_id
     and t.day_of_week = (extract(isodow from p_date) - 1)::int
     and (p_teacher_user_id is null or t.teacher_user_id = p_teacher_user_id)
     and exists (
       select 1 from public.profiles me
        where me.id = auth.uid()
          and me.school_id = p_school_id
          and me.role in ('teacher','school_organiser')
     )
   order by t.period asc, t.start_time asc;
$$;
grant execute on function public.list_day_lessons(uuid, date, uuid) to authenticated;

-- ============================================================================
-- 4. list_timetable_slots_for_group — NEW: the timetable of one tutor
-- group / set = every slot whose class is scheduled for that group.
-- Staff of the school can view; editing still goes through
-- upsert_timetable_slot / delete_timetable_slot, which gate on the
-- 'timetable' permission.
-- ============================================================================
create or replace function public.list_timetable_slots_for_group(
  p_school_id uuid,
  p_group_id  uuid
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
    join public.class_group_targets cgt
      on cgt.class_id = t.class_id and cgt.group_id = p_group_id
    left join public.classes c on c.id = t.class_id
    left join public.resources r on r.id = c.room_id
    left join public.profiles tp on tp.id = t.teacher_user_id
    left join auth.users tu on tu.id = t.teacher_user_id
   where t.school_id = p_school_id
     and exists (
       -- The group must belong to this school.
       select 1 from public.student_groups g
        where g.id = p_group_id and g.school_id = p_school_id
     )
     and exists (
       select 1 from public.profiles me
        where me.id = auth.uid()
          and me.school_id = p_school_id
          and me.role in ('teacher','school_organiser')
     )
   order by t.day_of_week asc, t.period asc;
$$;
grant execute on function public.list_timetable_slots_for_group(uuid, uuid) to authenticated;

-- ============================================================================
-- DONE. After running this migration:
--   1. Teachers holding no role in a school that has roles lose every
--      permission (timetable editing, class creation, tutor group
--      creation, …) until an organiser grants them a role. Schools with
--      no roles configured are unaffected.
--   2. Register rosters include students reached via tutor groups / sets.
--   3. Registers can only be saved for today.
--   4. Re-running is safe (create or replace throughout).
-- ============================================================================