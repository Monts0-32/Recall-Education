-- ============================================================================
-- Recall Education — School Systems (register, absences, behaviour,
-- praise, timetables, announcements, resource booking, clubs, analytics)
-- Run AFTER supabase_school_settings.sql (which itself runs after
-- supabase_tables.sql, supabase_school_organisers.sql,
-- supabase_classes_and_submissions.sql and supabase_notifications.sql).
-- Idempotent: safe to re-run.
--
-- What this does:
--   1. Nine systems' tables, each with RLS enabled and a staff-of-school
--      SELECT policy. All writes are RPC-only (no write policies).
--   2. SECURITY DEFINER RPCs guarded by _assert_school_staff /
--      _assert_school_staff_with_perm (from supabase_school_settings.sql).
--   3. Notification hooks: behaviour, praise and announcement RPCs call
--      push_notification (supabase_notifications.sql) so students see
--      activity in their bell without any new student-facing UI.
--   4. get_school_analytics — one round-trip aggregate stats blob.
--
-- Permission keys used (resolved by _school_teacher_perm in
-- supabase_school_settings.sql / supabase_school_roles.sql):
--   register      — save_register, get_register, list_day_lessons
--   absences      — record_absence, delete_absence
--   behaviour     — log/delete behaviour incidents
--   praise        — award praise points
--   announcements — post/delete announcements
--   resources      — create/delete bookable resources
--   booking       — book/cancel resource bookings
--   clubs         — create/update/delete clubs + members
--   timetable      — upsert/delete timetable slots
--   analytics      — get_school_analytics
-- Every RPC here is now granularly gated; organisers always pass.
-- ============================================================================

-- ============================================================================
-- 1. TABLES
-- ============================================================================

-- ---- Register (attendance) ----
create table if not exists public.register_sessions (
  id           uuid primary key default gen_random_uuid(),
  school_id    uuid not null references public.schools(id) on delete cascade,
  class_id     uuid not null references public.classes(id) on delete cascade,
  session_date date not null,
  taken_by     uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  unique (class_id, session_date)
);
create index if not exists register_sessions_school_idx
  on public.register_sessions (school_id, session_date desc);

create table if not exists public.register_marks (
  id              uuid primary key default gen_random_uuid(),
  session_id      uuid not null references public.register_sessions(id) on delete cascade,
  student_user_id uuid not null references auth.users(id) on delete cascade,
  status          text not null check (status in ('present','late','absent','excused')),
  note            text,
  unique (session_id, student_user_id)
);
create index if not exists register_marks_session_idx
  on public.register_marks (session_id);

-- Registers are per-lesson: each timetable slot (class + date + period)
-- gets its own session. period 0 = ad-hoc register (any class + date,
-- no scheduled lesson) — 0 can't collide with slot periods (1-12).
--   timetable_slot_id  which scheduled lesson this register belongs to
--   submitted_at       last time the register was saved
--   is_late            sticky flag: true when the FIRST submission came
--                      more than register_late_minutes (school_settings,
--                      default 20) after the lesson's scheduled start.
--                      Re-saving a register never flips the flag.
alter table public.register_sessions
  add column if not exists timetable_slot_id uuid references public.timetable_slots(id) on delete set null,
  add column if not exists period        int not null default 0,
  add column if not exists submitted_at  timestamptz,
  add column if not exists is_late       boolean not null default false;

-- Swap the uniqueness: one register per class + date + period (was per
-- class + date). Drop-then-add because Postgres has no "add constraint
-- if not exists"; the generated names cover both old and new shapes.
alter table public.register_sessions drop constraint if exists register_sessions_class_id_session_date_key;
alter table public.register_sessions drop constraint if exists register_sessions_class_date_period_key;
alter table public.register_sessions add constraint register_sessions_class_date_period_key
  unique (class_id, session_date, period);

-- ---- Absences ----
create table if not exists public.absence_records (
  id              uuid primary key default gen_random_uuid(),
  school_id       uuid not null references public.schools(id) on delete cascade,
  student_user_id uuid not null references auth.users(id) on delete cascade,
  start_date      date not null,
  end_date        date not null,
  reason          text not null default 'other' check (reason in ('illness','holiday','approved','other')),
  note            text,
  reported_by     uuid references auth.users(id) on delete set null,
  created_at      timestamptz not null default now(),
  check (end_date >= start_date)
);
create index if not exists absence_records_school_idx
  on public.absence_records (school_id, start_date desc);

-- ---- Behaviour ----
create table if not exists public.behaviour_incidents (
  id              uuid primary key default gen_random_uuid(),
  school_id       uuid not null references public.schools(id) on delete cascade,
  student_user_id uuid not null references auth.users(id) on delete cascade,
  class_id        uuid references public.classes(id) on delete set null,
  severity        text not null check (severity in ('low','medium','high')),
  category        text not null default 'other',
  note            text not null,
  logged_by       uuid references auth.users(id) on delete set null,
  created_at      timestamptz not null default now()
);
create index if not exists behaviour_incidents_school_idx
  on public.behaviour_incidents (school_id, created_at desc);
create index if not exists behaviour_incidents_student_idx
  on public.behaviour_incidents (student_user_id, created_at desc);

-- ---- Praise points ----
create table if not exists public.praise_points (
  id              uuid primary key default gen_random_uuid(),
  school_id       uuid not null references public.schools(id) on delete cascade,
  student_user_id uuid not null references auth.users(id) on delete cascade,
  points          int not null check (points between 1 and 10),
  reason          text,
  awarded_by      uuid references auth.users(id) on delete set null,
  created_at      timestamptz not null default now()
);
create index if not exists praise_points_school_idx
  on public.praise_points (school_id, created_at desc);
create index if not exists praise_points_student_idx
  on public.praise_points (student_user_id, created_at desc);

-- ---- Timetables ----
create table if not exists public.timetable_slots (
  id              uuid primary key default gen_random_uuid(),
  school_id       uuid not null references public.schools(id) on delete cascade,
  class_id        uuid references public.classes(id) on delete cascade,
  teacher_user_id uuid references auth.users(id) on delete set null,
  day_of_week     int not null check (day_of_week between 0 and 6),  -- 0=Mon .. 6=Sun
  period          int not null check (period between 1 and 12),
  start_time      time not null,
  end_time        time not null,
  room            text,
  label           text,
  created_by      uuid references auth.users(id) on delete set null,
  created_at      timestamptz not null default now()
);
create index if not exists timetable_slots_school_idx
  on public.timetable_slots (school_id, day_of_week, period);

-- ---- Announcements ----
create table if not exists public.announcements (
  id         uuid primary key default gen_random_uuid(),
  school_id  uuid not null references public.schools(id) on delete cascade,
  class_id   uuid references public.classes(id) on delete cascade,   -- null = school-wide
  audience   text not null default 'everyone' check (audience in ('everyone','staff','students','class')),
  title      text not null,
  body       text not null,
  posted_by  uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists announcements_school_idx
  on public.announcements (school_id, created_at desc);

-- ---- Resource booking ----
create table if not exists public.resources (
  id         uuid primary key default gen_random_uuid(),
  school_id  uuid not null references public.schools(id) on delete cascade,
  name       text not null,
  kind       text not null default 'room' check (kind in ('room','equipment','facility')),
  location   text,
  notes      text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists resources_school_idx on public.resources (school_id);

create table if not exists public.resource_bookings (
  id           uuid primary key default gen_random_uuid(),
  school_id    uuid not null references public.schools(id) on delete cascade,
  resource_id  uuid not null references public.resources(id) on delete cascade,
  booking_date date not null,
  start_time   time not null,
  end_time     time not null,
  purpose      text,
  booked_by    uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  check (end_time > start_time)
);
create index if not exists resource_bookings_lookup_idx
  on public.resource_bookings (resource_id, booking_date, start_time);
create index if not exists resource_bookings_school_idx
  on public.resource_bookings (school_id, booking_date desc);

-- ---- Clubs ----
create table if not exists public.clubs (
  id           uuid primary key default gen_random_uuid(),
  school_id    uuid not null references public.schools(id) on delete cascade,
  name         text not null,
  description  text,
  schedule     text,                     -- free text, e.g. "Mondays 15:30–16:30"
  lead_user_id uuid references auth.users(id) on delete set null,
  created_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now()
);
create index if not exists clubs_school_idx on public.clubs (school_id);

create table if not exists public.club_members (
  club_id         uuid not null references public.clubs(id) on delete cascade,
  student_user_id uuid not null references auth.users(id) on delete cascade,
  added_by        uuid references auth.users(id) on delete set null,
  created_at      timestamptz not null default now(),
  primary key (club_id, student_user_id)
);
create index if not exists club_members_student_idx
  on public.club_members (student_user_id);

-- ============================================================================
-- 2. RLS — staff of the school can read everything; writes are RPC-only.
-- ============================================================================

alter table public.register_sessions      enable row level security;
alter table public.register_marks        enable row level security;
alter table public.absence_records       enable row level security;
alter table public.behaviour_incidents   enable row level security;
alter table public.praise_points         enable row level security;
alter table public.timetable_slots       enable row level security;
alter table public.announcements         enable row level security;
alter table public.resources             enable row level security;
alter table public.resource_bookings      enable row level security;
alter table public.clubs                  enable row level security;
alter table public.club_members           enable row level security;

drop policy if exists "register_sessions_school_read" on public.register_sessions;
create policy "register_sessions_school_read" on public.register_sessions
  for select to authenticated
  using (exists (
    select 1 from public.profiles p
     where p.id = auth.uid()
       and p.school_id = register_sessions.school_id
       and p.role in ('teacher','school_organiser')
  ));

drop policy if exists "register_marks_school_read" on public.register_marks;
create policy "register_marks_school_read" on public.register_marks
  for select to authenticated
  using (exists (
    select 1 from public.register_sessions s
    join public.profiles p on p.id = auth.uid()
     where s.id = register_marks.session_id
       and p.school_id = s.school_id
       and p.role in ('teacher','school_organiser')
  ));

drop policy if exists "absence_records_school_read" on public.absence_records;
create policy "absence_records_school_read" on public.absence_records
  for select to authenticated
  using (exists (
    select 1 from public.profiles p
     where p.id = auth.uid()
       and p.school_id = absence_records.school_id
       and p.role in ('teacher','school_organiser')
  ));

drop policy if exists "behaviour_incidents_school_read" on public.behaviour_incidents;
create policy "behaviour_incidents_school_read" on public.behaviour_incidents
  for select to authenticated
  using (exists (
    select 1 from public.profiles p
     where p.id = auth.uid()
       and p.school_id = behaviour_incidents.school_id
       and p.role in ('teacher','school_organiser')
  ));

drop policy if exists "praise_points_school_read" on public.praise_points;
create policy "praise_points_school_read" on public.praise_points
  for select to authenticated
  using (exists (
    select 1 from public.profiles p
     where p.id = auth.uid()
       and p.school_id = praise_points.school_id
       and p.role in ('teacher','school_organiser')
  ));

drop policy if exists "timetable_slots_school_read" on public.timetable_slots;
create policy "timetable_slots_school_read" on public.timetable_slots
  for select to authenticated
  using (exists (
    select 1 from public.profiles p
     where p.id = auth.uid()
       and p.school_id = timetable_slots.school_id
       and p.role in ('teacher','school_organiser')
  ));

drop policy if exists "announcements_school_read" on public.announcements;
create policy "announcements_school_read" on public.announcements
  for select to authenticated
  using (exists (
    select 1 from public.profiles p
     where p.id = auth.uid()
       and p.school_id = announcements.school_id
       and p.role in ('teacher','school_organiser')
  ));

drop policy if exists "resources_school_read" on public.resources;
create policy "resources_school_read" on public.resources
  for select to authenticated
  using (exists (
    select 1 from public.profiles p
     where p.id = auth.uid()
       and p.school_id = resources.school_id
       and p.role in ('teacher','school_organiser')
  ));

drop policy if exists "resource_bookings_school_read" on public.resource_bookings;
create policy "resource_bookings_school_read" on public.resource_bookings
  for select to authenticated
  using (exists (
    select 1 from public.profiles p
     where p.id = auth.uid()
       and p.school_id = resource_bookings.school_id
       and p.role in ('teacher','school_organiser')
  ));

drop policy if exists "clubs_school_read" on public.clubs;
create policy "clubs_school_read" on public.clubs
  for select to authenticated
  using (exists (
    select 1 from public.profiles p
     where p.id = auth.uid()
       and p.school_id = clubs.school_id
       and p.role in ('teacher','school_organiser')
  ));

drop policy if exists "club_members_school_read" on public.club_members;
create policy "club_members_school_read" on public.club_members
  for select to authenticated
  using (exists (
    select 1 from public.clubs c
    join public.profiles p on p.id = auth.uid()
     where c.id = club_members.club_id
       and p.school_id = c.school_id
       and p.role in ('teacher','school_organiser')
  ));

-- ============================================================================
-- 3. REGISTER RPCs
-- ============================================================================

-- save_register — upsert one class's register for one date + period.
--   p_period              0 = ad-hoc manual register (default)
--   p_timetable_slot_id   when the register belongs to a scheduled lesson;
--                         forces the period and enables the late flag
-- The marks payload replaces whatever was saved before for that
-- (class, date, period).
--
-- STICKY LATE: is_late is computed only on the insert path. Re-saving
-- (a correction) keeps the original flag, so an on-time register never
-- flips to LATE because someone edited a mark after the window closed.
drop function if exists public.save_register(uuid, date, jsonb);

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

  -- Remove marks for students no longer in the payload.
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
    -- Only mark students actually on the class roster.
    if exists (
      select 1 from public.class_members cm
       where cm.class_id = p_class_id and cm.student_user_id = v_student
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

-- get_register — the roster for a class with any saved marks for the
-- date + period merged in (status is null when the student hasn't
-- been marked).
drop function if exists public.get_register(uuid, date);

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
  select cm.student_user_id,
         coalesce(p.full_name, u.email::text, '') as full_name,
         p.year_group,
         m.status,
         m.note
    from public.class_members cm
    join public.profiles p on p.id = cm.student_user_id
    join auth.users u on u.id = cm.student_user_id
    left join public.register_sessions s
      on s.class_id = cm.class_id and s.session_date = p_date
     and s.period = coalesce(p_period, 0)
    left join public.register_marks m
      on m.session_id = s.id and m.student_user_id = cm.student_user_id
   where cm.class_id = p_class_id
     and exists (
       select 1 from public.classes c
       join public.profiles me on me.id = auth.uid()
        where c.id = cm.class_id
          and me.school_id = c.school_id
          and me.role in ('teacher','school_organiser')
     )
   order by p.full_name asc;
$$;
grant execute on function public.get_register(uuid, date, int) to authenticated;

-- list_recent_registers — the last N saved sessions with their counts.
-- Return type changed (period / is_late / submitted_at added), so the
-- old version must be dropped first.
drop function if exists public.list_recent_registers(uuid, int);

create or replace function public.list_recent_registers(
  p_school_id uuid,
  p_limit     int default 20
)
returns table (
  class_id       uuid,
  class_name     text,
  session_date   date,
  period         int,
  is_late        boolean,
  submitted_at   timestamptz,
  present        int,
  late           int,
  absent         int,
  excused        int,
  taken_by_name  text
)
language sql
security definer
set search_path = public
stable
as $$
  select s.class_id,
         c.name as class_name,
         s.session_date,
         s.period,
         s.is_late,
         s.submitted_at,
         count(*) filter (where m.status = 'present')::int,
         count(*) filter (where m.status = 'late')::int,
         count(*) filter (where m.status = 'absent')::int,
         count(*) filter (where m.status = 'excused')::int,
         coalesce(tp.full_name, tu.email::text, '') as taken_by_name
    from public.register_sessions s
    join public.classes c on c.id = s.class_id
    left join public.register_marks m on m.session_id = s.id
    left join public.profiles tp on tp.id = s.taken_by
    left join auth.users tu on tu.id = s.taken_by
   where s.school_id = p_school_id
     and exists (
       select 1 from public.profiles me
        where me.id = auth.uid()
          and me.school_id = p_school_id
          and me.role in ('teacher','school_organiser')
     )
   group by s.class_id, c.name, s.session_date, s.period, s.is_late,
            s.submitted_at, s.taken_by, tp.full_name, tu.email
   order by s.session_date desc, s.period asc, c.name asc
   limit greatest(coalesce(p_limit, 20), 0);
$$;
grant execute on function public.list_recent_registers(uuid, int) to authenticated;

-- list_day_lessons — every timetable slot for a school on p_date,
-- joined to any register already saved for that (class, date, period).
-- p_teacher_user_id narrows to one teacher's timetable (null = whole
-- school — used by the organiser view). Day matching is isodow-based
-- so Monday=1 → 0 matches timetable_slots.day_of_week.
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
         t.room,
         t.label,
         s.id                as session_id,
         s.is_late,
         s.submitted_at,
         coalesce(rm.present, 0),
         coalesce(rm.absent, 0),
         coalesce(rm.excused, 0)
    from public.timetable_slots t
    join public.classes c on c.id = t.class_id
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
-- 4. ABSENCE RPCs
-- ============================================================================

create or replace function public.record_absence(
  p_school_id       uuid,
  p_student_user_id uuid,
  p_start_date      date,
  p_end_date        date,
  p_reason          text default 'other',
  p_note            text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    return jsonb_build_object('ok', false, 'reason', 'not_authenticated');
  end if;
  perform public._assert_school_staff_with_perm(p_school_id, 'absences');
  if p_start_date is null or p_end_date is null then
    return jsonb_build_object('ok', false, 'reason', 'dates_required');
  end if;
  if p_end_date < p_start_date then
    return jsonb_build_object('ok', false, 'reason', 'end_before_start');
  end if;
  if coalesce(p_reason, 'other') not in ('illness','holiday','approved','other') then
    return jsonb_build_object('ok', false, 'reason', 'invalid_reason');
  end if;
  if not exists (
    select 1 from public.profiles
     where id = p_student_user_id
       and school_id = p_school_id
       and role = 'student'
       and removed_from_school_at is null
       and deleted_at is null
  ) then
    return jsonb_build_object('ok', false, 'reason', 'unknown_student');
  end if;
  insert into public.absence_records (
    school_id, student_user_id, start_date, end_date, reason, note, reported_by
  ) values (
    p_school_id, p_student_user_id, p_start_date, p_end_date,
    coalesce(p_reason, 'other'),
    nullif(trim(coalesce(p_note, '')), ''),
    auth.uid()
  );
  return jsonb_build_object('ok', true);
end;
$$;
grant execute on function public.record_absence(uuid, uuid, date, date, text, text) to authenticated;

create or replace function public.delete_absence(
  p_absence_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rec public.absence_records%rowtype;
begin
  if auth.uid() is null then
    return jsonb_build_object('ok', false, 'reason', 'not_authenticated');
  end if;
  select * into v_rec from public.absence_records where absence_records.id = p_absence_id;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'unknown_absence');
  end if;
  if v_rec.reported_by is distinct from auth.uid()
     and not exists (
       select 1 from public.schools s
        where s.id = v_rec.school_id and s.owner_user_id = auth.uid()
     ) then
    return jsonb_build_object('ok', false, 'reason', 'forbidden');
  end if;
  delete from public.absence_records where absence_records.id = p_absence_id;
  return jsonb_build_object('ok', true);
end;
$$;
grant execute on function public.delete_absence(uuid) to authenticated;

create or replace function public.list_absences(
  p_school_id uuid,
  p_from      date default null,
  p_to        date default null
)
returns table (
  id              uuid,
  student_user_id uuid,
  student_name    text,
  start_date      date,
  end_date        date,
  reason          text,
  note            text,
  reported_by     uuid,
  reported_by_name text,
  created_at      timestamptz
)
language sql
security definer
set search_path = public
stable
as $$
  select a.id,
         a.student_user_id,
         coalesce(p.full_name, u.email::text, '') as student_name,
         a.start_date,
         a.end_date,
         a.reason,
         a.note,
         a.reported_by,
         coalesce(rp.full_name, ru.email::text, '') as reported_by_name,
         a.created_at
    from public.absence_records a
    join public.profiles p on p.id = a.student_user_id
    join auth.users u on u.id = a.student_user_id
    left join public.profiles rp on rp.id = a.reported_by
    left join auth.users ru on ru.id = a.reported_by
   where a.school_id = p_school_id
     and (p_from is null or a.end_date >= p_from)
     and (p_to is null or a.start_date <= p_to)
     and exists (
       select 1 from public.profiles me
        where me.id = auth.uid()
          and me.school_id = p_school_id
          and me.role in ('teacher','school_organiser')
     )
   order by a.start_date desc, student_name asc;
$$;
grant execute on function public.list_absences(uuid, date, date) to authenticated;

-- ============================================================================
-- 5. BEHAVIOUR RPCs
-- ============================================================================

create or replace function public.log_behaviour_incident(
  p_school_id       uuid,
  p_student_user_id uuid,
  p_severity        text,
  p_category        text default 'other',
  p_note            text default null,
  p_class_id        uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if auth.uid() is null then
    return jsonb_build_object('ok', false, 'reason', 'not_authenticated');
  end if;
  perform public._assert_school_staff_with_perm(p_school_id, 'behaviour');
  if p_severity not in ('low','medium','high') then
    return jsonb_build_object('ok', false, 'reason', 'invalid_severity');
  end if;
  if nullif(trim(coalesce(p_note, '')), '') is null then
    return jsonb_build_object('ok', false, 'reason', 'note_required');
  end if;
  if not exists (
    select 1 from public.profiles
     where id = p_student_user_id
       and school_id = p_school_id
       and role = 'student'
       and removed_from_school_at is null
       and deleted_at is null
  ) then
    return jsonb_build_object('ok', false, 'reason', 'unknown_student');
  end if;
  if p_class_id is not null and not exists (
    select 1 from public.classes
     where id = p_class_id and school_id = p_school_id
  ) then
    return jsonb_build_object('ok', false, 'reason', 'unknown_class');
  end if;

  insert into public.behaviour_incidents (
    school_id, student_user_id, class_id, severity, category, note, logged_by
  ) values (
    p_school_id, p_student_user_id, p_class_id,
    p_severity, coalesce(nullif(trim(p_category), ''), 'other'),
    trim(p_note), auth.uid()
  )
  returning id into v_id;

  -- Let the student know (their bell — no new student-facing page).
  perform public.push_notification(
    p_student_user_id, 'behaviour', v_id,
    'A teacher logged a ' || p_severity || ' behaviour note about you.'
  );
  return jsonb_build_object('ok', true, 'incident_id', v_id);
end;
$$;
grant execute on function public.log_behaviour_incident(uuid, uuid, text, text, text, uuid) to authenticated;

create or replace function public.list_behaviour_incidents(
  p_school_id       uuid,
  p_student_user_id uuid default null,
  p_limit           int default 50
)
returns table (
  id              uuid,
  student_user_id uuid,
  student_name    text,
  class_name      text,
  severity        text,
  category        text,
  note            text,
  logged_by_name  text,
  created_at      timestamptz
)
language sql
security definer
set search_path = public
stable
as $$
  select i.id,
         i.student_user_id,
         coalesce(p.full_name, u.email::text, '') as student_name,
         c.name as class_name,
         i.severity,
         i.category,
         i.note,
         coalesce(lp.full_name, lu.email::text, '') as logged_by_name,
         i.created_at
    from public.behaviour_incidents i
    join public.profiles p on p.id = i.student_user_id
    join auth.users u on u.id = i.student_user_id
    left join public.classes c on c.id = i.class_id
    left join public.profiles lp on lp.id = i.logged_by
    left join auth.users lu on lu.id = i.logged_by
   where i.school_id = p_school_id
     and (p_student_user_id is null or i.student_user_id = p_student_user_id)
     and exists (
       select 1 from public.profiles me
        where me.id = auth.uid()
          and me.school_id = p_school_id
          and me.role in ('teacher','school_organiser')
     )
   order by i.created_at desc
   limit greatest(coalesce(p_limit, 50), 0);
$$;
grant execute on function public.list_behaviour_incidents(uuid, uuid, int) to authenticated;

create or replace function public.delete_behaviour_incident(
  p_incident_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_inc public.behaviour_incidents%rowtype;
begin
  if auth.uid() is null then
    return jsonb_build_object('ok', false, 'reason', 'not_authenticated');
  end if;
  select * into v_inc from public.behaviour_incidents where behaviour_incidents.id = p_incident_id;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'unknown_incident');
  end if;
  if v_inc.logged_by is distinct from auth.uid()
     and not exists (
       select 1 from public.schools s
        where s.id = v_inc.school_id and s.owner_user_id = auth.uid()
     ) then
    return jsonb_build_object('ok', false, 'reason', 'forbidden');
  end if;
  delete from public.behaviour_incidents where behaviour_incidents.id = p_incident_id;
  return jsonb_build_object('ok', true);
end;
$$;
grant execute on function public.delete_behaviour_incident(uuid) to authenticated;

-- ============================================================================
-- 6. PRAISE RPCs
-- ============================================================================

create or replace function public.award_praise_points(
  p_school_id       uuid,
  p_student_user_id uuid,
  p_points          int,
  p_reason          text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if auth.uid() is null then
    return jsonb_build_object('ok', false, 'reason', 'not_authenticated');
  end if;
  perform public._assert_school_staff_with_perm(p_school_id, 'praise');
  if p_points is null or p_points < 1 or p_points > 10 then
    return jsonb_build_object('ok', false, 'reason', 'invalid_points');
  end if;
  if not exists (
    select 1 from public.profiles
     where id = p_student_user_id
       and school_id = p_school_id
       and role = 'student'
       and removed_from_school_at is null
       and deleted_at is null
  ) then
    return jsonb_build_object('ok', false, 'reason', 'unknown_student');
  end if;

  insert into public.praise_points (school_id, student_user_id, points, reason, awarded_by)
  values (p_school_id, p_student_user_id, p_points,
          nullif(trim(coalesce(p_reason, '')), ''), auth.uid())
  returning id into v_id;

  perform public.push_notification(
    p_student_user_id, 'praise', v_id,
    'You were awarded ' || p_points || ' praise point' || (case when p_points = 1 then '' else 's' end) || '!'
  );
  return jsonb_build_object('ok', true, 'award_id', v_id);
end;
$$;
grant execute on function public.award_praise_points(uuid, uuid, int, text) to authenticated;

create or replace function public.list_praise_leaderboard(
  p_school_id uuid,
  p_days      int default 30
)
returns table (
  student_user_id uuid,
  full_name       text,
  total_points    int,
  awards_count    int
)
language sql
security definer
set search_path = public
stable
as $$
  select pp.student_user_id,
         coalesce(p.full_name, u.email::text, '') as full_name,
         sum(pp.points)::int as total_points,
         count(*)::int as awards_count
    from public.praise_points pp
    join public.profiles p on p.id = pp.student_user_id
    join auth.users u on u.id = pp.student_user_id
   where pp.school_id = p_school_id
     and pp.created_at >= now() - (greatest(coalesce(p_days, 30), 1) || ' days')::interval
     and exists (
       select 1 from public.profiles me
        where me.id = auth.uid()
          and me.school_id = p_school_id
          and me.role in ('teacher','school_organiser')
     )
   group by pp.student_user_id, p.full_name, u.email
   order by total_points desc, awards_count desc
   limit 50;
$$;
grant execute on function public.list_praise_leaderboard(uuid, int) to authenticated;

create or replace function public.list_praise_recent(
  p_school_id uuid,
  p_limit     int default 25
)
returns table (
  id              uuid,
  student_user_id uuid,
  student_name    text,
  points          int,
  reason          text,
  awarded_by_name text,
  created_at     timestamptz
)
language sql
security definer
set search_path = public
stable
as $$
  select pp.id,
         pp.student_user_id,
         coalesce(p.full_name, u.email::text, '') as student_name,
         pp.points,
         pp.reason,
         coalesce(ap.full_name, au.email::text, '') as awarded_by_name,
         pp.created_at
    from public.praise_points pp
    join public.profiles p on p.id = pp.student_user_id
    join auth.users u on u.id = pp.student_user_id
    left join public.profiles ap on ap.id = pp.awarded_by
    left join auth.users au on au.id = pp.awarded_by
   where pp.school_id = p_school_id
     and exists (
       select 1 from public.profiles me
        where me.id = auth.uid()
          and me.school_id = p_school_id
          and me.role in ('teacher','school_organiser')
     )
   order by pp.created_at desc
   limit greatest(coalesce(p_limit, 25), 0);
$$;
grant execute on function public.list_praise_recent(uuid, int) to authenticated;

-- ============================================================================
-- 7. TIMETABLE RPCs (staff-wide — no permission toggle)
-- ============================================================================

create or replace function public.upsert_timetable_slot(
  p_school_id      uuid,
  p_slot_id         uuid default null,
  p_class_id        uuid default null,
  p_teacher_user_id uuid default null,
  p_day_of_week     int default null,
  p_period          int default null,
  p_start_time      time default null,
  p_end_time        time default null,
  p_room            text default null,
  p_label           text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if auth.uid() is null then
    return jsonb_build_object('ok', false, 'reason', 'not_authenticated');
  end if;
  perform public._assert_school_staff_with_perm(p_school_id, 'timetable');
  if p_day_of_week is null or p_day_of_week not between 0 and 6 then
    return jsonb_build_object('ok', false, 'reason', 'invalid_day');
  end if;
  if p_period is null or p_period not between 1 and 12 then
    return jsonb_build_object('ok', false, 'reason', 'invalid_period');
  end if;
  if p_start_time is null or p_end_time is null or p_end_time <= p_start_time then
    return jsonb_build_object('ok', false, 'reason', 'invalid_times');
  end if;
  if p_class_id is not null and not exists (
    select 1 from public.classes where id = p_class_id and school_id = p_school_id
  ) then
    return jsonb_build_object('ok', false, 'reason', 'unknown_class');
  end if;

  if p_slot_id is not null then
    if not exists (
      select 1 from public.timetable_slots
       where id = p_slot_id and school_id = p_school_id
    ) then
      return jsonb_build_object('ok', false, 'reason', 'unknown_slot');
    end if;
  else
    -- A teacher can't be in two places at once.
    if p_teacher_user_id is not null and exists (
      select 1 from public.timetable_slots t
       where t.school_id = p_school_id
         and t.day_of_week = p_day_of_week
         and t.period = p_period
         and t.teacher_user_id = p_teacher_user_id
    ) then
      return jsonb_build_object('ok', false, 'reason', 'teacher_busy');
    end if;
    -- Neither can a class.
    if p_class_id is not null and exists (
      select 1 from public.timetable_slots t
       where t.school_id = p_school_id
         and t.day_of_week = p_day_of_week
         and t.period = p_period
         and t.class_id = p_class_id
    ) then
      return jsonb_build_object('ok', false, 'reason', 'class_busy');
    end if;
  end if;

  insert into public.timetable_slots (
    id, school_id, class_id, teacher_user_id,
    day_of_week, period, start_time, end_time, room, label, created_by
  ) values (
    coalesce(p_slot_id, gen_random_uuid()), p_school_id, p_class_id, p_teacher_user_id,
    p_day_of_week, p_period, p_start_time, p_end_time,
    nullif(trim(coalesce(p_room, '')), ''),
    nullif(trim(coalesce(p_label, '')), ''),
    auth.uid()
  )
  on conflict (id) do update
    set class_id        = excluded.class_id,
        teacher_user_id = excluded.teacher_user_id,
        day_of_week     = excluded.day_of_week,
        period          = excluded.period,
        start_time      = excluded.start_time,
        end_time        = excluded.end_time,
        room            = excluded.room,
        label           = excluded.label
  returning id into v_id;

  return jsonb_build_object('ok', true, 'slot_id', v_id);
end;
$$;
grant execute on function public.upsert_timetable_slot(uuid, uuid, uuid, uuid, int, int, time, time, text, text) to authenticated;

create or replace function public.delete_timetable_slot(
  p_slot_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_slot public.timetable_slots%rowtype;
begin
  if auth.uid() is null then
    return jsonb_build_object('ok', false, 'reason', 'not_authenticated');
  end if;
  select * into v_slot from public.timetable_slots where timetable_slots.id = p_slot_id;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'unknown_slot');
  end if;
  perform public._assert_school_staff_with_perm(v_slot.school_id, 'timetable');
  delete from public.timetable_slots where timetable_slots.id = p_slot_id;
  return jsonb_build_object('ok', true);
end;
$$;
grant execute on function public.delete_timetable_slot(uuid) to authenticated;

create or replace function public.list_timetable_slots(
  p_school_id      uuid,
  p_class_id       uuid default null,
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
         t.room,
         t.label
    from public.timetable_slots t
    left join public.classes c on c.id = t.class_id
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

-- ============================================================================
-- 8. ANNOUNCEMENT RPCs
-- ============================================================================

create or replace function public.post_announcement(
  p_school_id uuid,
  p_class_id   uuid default null,
  p_audience   text default 'everyone',
  p_title      text default null,
  p_body       text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id      uuid;
  v_rec     uuid;
  v_body    text;
begin
  if auth.uid() is null then
    return jsonb_build_object('ok', false, 'reason', 'not_authenticated');
  end if;
  perform public._assert_school_staff_with_perm(p_school_id, 'announcements');
  if coalesce(p_audience, 'everyone') not in ('everyone','staff','students','class') then
    return jsonb_build_object('ok', false, 'reason', 'invalid_audience');
  end if;
  if nullif(trim(coalesce(p_title, '')), '') is null then
    return jsonb_build_object('ok', false, 'reason', 'title_required');
  end if;
  if nullif(trim(coalesce(p_body, '')), '') is null then
    return jsonb_build_object('ok', false, 'reason', 'body_required');
  end if;
  if p_audience = 'class' then
    if p_class_id is null or not exists (
      select 1 from public.classes where id = p_class_id and school_id = p_school_id
    ) then
      return jsonb_build_object('ok', false, 'reason', 'class_required');
    end if;
  end if;

  insert into public.announcements (school_id, class_id, audience, title, body, posted_by)
  values (p_school_id, p_class_id, coalesce(p_audience, 'everyone'),
          trim(p_title), trim(p_body), auth.uid())
  returning id into v_id;

  -- Fan out to the notification bell. Schools are small, so a loop over
  -- profiles is fine. Never notify the poster.
  v_body := left('Announcement: ' || trim(p_title), 280);
  if coalesce(p_audience, 'everyone') = 'class' then
    for v_rec in
      select cm.student_user_id
        from public.class_members cm
        join public.profiles p on p.id = cm.student_user_id
       where cm.class_id = p_class_id
         and p.role = 'student'
         and p.removed_from_school_at is null
         and p.deleted_at is null
         and p.id <> auth.uid()
    loop
      perform public.push_notification(v_rec, 'announcement', v_id, v_body);
    end loop;
  else
    for v_rec in
      select p.id
        from public.profiles p
       where p.school_id = p_school_id
         and p.removed_from_school_at is null
         and p.deleted_at is null
         and p.id <> auth.uid()
         and (
           (coalesce(p_audience, 'everyone') = 'everyone')
           or (coalesce(p_audience, 'everyone') = 'students' and p.role = 'student')
           or (coalesce(p_audience, 'everyone') = 'staff' and p.role in ('teacher','school_organiser'))
         )
    loop
      perform public.push_notification(v_rec, 'announcement', v_id, v_body);
    end loop;
  end if;

  return jsonb_build_object('ok', true, 'announcement_id', v_id);
end;
$$;
grant execute on function public.post_announcement(uuid, uuid, text, text, text) to authenticated;

create or replace function public.list_announcements(
  p_school_id uuid,
  p_limit     int default 50
)
returns table (
  id             uuid,
  class_id       uuid,
  class_name     text,
  audience       text,
  title          text,
  body           text,
  posted_by      uuid,
  posted_by_name text,
  created_at     timestamptz
)
language sql
security definer
set search_path = public
stable
as $$
  select a.id,
         a.class_id,
         c.name as class_name,
         a.audience,
         a.title,
         a.body,
         a.posted_by,
         coalesce(pp.full_name, pu.email::text, '') as posted_by_name,
         a.created_at
    from public.announcements a
    left join public.classes c on c.id = a.class_id
    left join public.profiles pp on pp.id = a.posted_by
    left join auth.users pu on pu.id = a.posted_by
   where a.school_id = p_school_id
     and exists (
       select 1 from public.profiles me
        where me.id = auth.uid()
          and me.school_id = p_school_id
          and me.role in ('teacher','school_organiser')
     )
   order by a.created_at desc
   limit greatest(coalesce(p_limit, 50), 0);
$$;
grant execute on function public.list_announcements(uuid, int) to authenticated;

create or replace function public.delete_announcement(
  p_announcement_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_a public.announcements%rowtype;
begin
  if auth.uid() is null then
    return jsonb_build_object('ok', false, 'reason', 'not_authenticated');
  end if;
  select * into v_a from public.announcements where announcements.id = p_announcement_id;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'unknown_announcement');
  end if;
  if v_a.posted_by is distinct from auth.uid()
     and not exists (
       select 1 from public.schools s
        where s.id = v_a.school_id and s.owner_user_id = auth.uid()
     ) then
    return jsonb_build_object('ok', false, 'reason', 'forbidden');
  end if;
  delete from public.announcements where announcements.id = p_announcement_id;
  return jsonb_build_object('ok', true);
end;
$$;
grant execute on function public.delete_announcement(uuid) to authenticated;

-- ============================================================================
-- 9. RESOURCE BOOKING RPCs
-- ============================================================================

-- The resource catalog is school inventory: organiser-only to add/remove.
create or replace function public.create_resource(
  p_school_id uuid,
  p_name      text,
  p_kind      text default 'room',
  p_location  text default null,
  p_notes     text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if auth.uid() is null then
    return jsonb_build_object('ok', false, 'reason', 'not_authenticated');
  end if;
  perform public._assert_school_staff_with_perm(p_school_id, 'resources');
  if nullif(trim(coalesce(p_name, '')), '') is null then
    return jsonb_build_object('ok', false, 'reason', 'name_required');
  end if;
  if coalesce(p_kind, 'room') not in ('room','equipment','facility') then
    return jsonb_build_object('ok', false, 'reason', 'invalid_kind');
  end if;
  insert into public.resources (school_id, name, kind, location, notes, created_by)
  values (p_school_id, trim(p_name), coalesce(p_kind, 'room'),
          nullif(trim(coalesce(p_location, '')), ''),
          nullif(trim(coalesce(p_notes, '')), ''),
          auth.uid())
  returning id into v_id;
  return jsonb_build_object('ok', true, 'resource_id', v_id);
end;
$$;
grant execute on function public.create_resource(uuid, text, text, text, text) to authenticated;

create or replace function public.delete_resource(
  p_resource_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_r public.resources%rowtype;
begin
  if auth.uid() is null then
    return jsonb_build_object('ok', false, 'reason', 'not_authenticated');
  end if;
  select * into v_r from public.resources where resources.id = p_resource_id;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'unknown_resource');
  end if;
  perform public._assert_school_staff_with_perm(v_r.school_id, 'resources');
  delete from public.resources where resources.id = p_resource_id;
  return jsonb_build_object('ok', true);
end;
$$;
grant execute on function public.delete_resource(uuid) to authenticated;

create or replace function public.book_resource(
  p_school_id  uuid,
  p_resource_id uuid,
  p_date       date,
  p_start_time time,
  p_end_time   time,
  p_purpose    text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if auth.uid() is null then
    return jsonb_build_object('ok', false, 'reason', 'not_authenticated');
  end if;
  perform public._assert_school_staff_with_perm(p_school_id, 'booking');
  if not exists (
    select 1 from public.resources where id = p_resource_id and school_id = p_school_id
  ) then
    return jsonb_build_object('ok', false, 'reason', 'unknown_resource');
  end if;
  if p_date is null then
    return jsonb_build_object('ok', false, 'reason', 'date_required');
  end if;
  if p_start_time is null or p_end_time is null or p_end_time <= p_start_time then
    return jsonb_build_object('ok', false, 'reason', 'invalid_times');
  end if;
  -- Overlap check.
  if exists (
    select 1 from public.resource_bookings b
     where b.resource_id = p_resource_id
       and b.booking_date = p_date
       and b.start_time < p_end_time
       and b.end_time > p_start_time
  ) then
    return jsonb_build_object('ok', false, 'reason', 'slot_taken');
  end if;

  insert into public.resource_bookings (
    school_id, resource_id, booking_date, start_time, end_time, purpose, booked_by
  ) values (
    p_school_id, p_resource_id, p_date, p_start_time, p_end_time,
    nullif(trim(coalesce(p_purpose, '')), ''),
    auth.uid()
  )
  returning id into v_id;
  return jsonb_build_object('ok', true, 'booking_id', v_id);
end;
$$;
grant execute on function public.book_resource(uuid, uuid, date, time, time, text) to authenticated;

create or replace function public.cancel_booking(
  p_booking_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_b public.resource_bookings%rowtype;
begin
  if auth.uid() is null then
    return jsonb_build_object('ok', false, 'reason', 'not_authenticated');
  end if;
  select * into v_b from public.resource_bookings where resource_bookings.id = p_booking_id;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'unknown_booking');
  end if;
  if v_b.booked_by is distinct from auth.uid()
     and not exists (
       select 1 from public.schools s
        where s.id = v_b.school_id and s.owner_user_id = auth.uid()
     ) then
    return jsonb_build_object('ok', false, 'reason', 'forbidden');
  end if;
  delete from public.resource_bookings where resource_bookings.id = p_booking_id;
  return jsonb_build_object('ok', true);
end;
$$;
grant execute on function public.cancel_booking(uuid) to authenticated;

create or replace function public.list_resources(
  p_school_id uuid
)
returns table (
  id             uuid,
  name           text,
  kind           text,
  location       text,
  notes          text,
  bookings_today int
)
language sql
security definer
set search_path = public
stable
as $$
  select r.id,
         r.name,
         r.kind,
         r.location,
         r.notes,
         (
           select count(*)::int
             from public.resource_bookings b
            where b.resource_id = r.id
              and b.booking_date = current_date
         ) as bookings_today
    from public.resources r
   where r.school_id = p_school_id
     and exists (
       select 1 from public.profiles me
        where me.id = auth.uid()
          and me.school_id = p_school_id
          and me.role in ('teacher','school_organiser')
     )
   order by r.name asc;
$$;
grant execute on function public.list_resources(uuid) to authenticated;

create or replace function public.list_resource_bookings(
  p_school_id  uuid,
  p_date       date default null,
  p_resource_id uuid default null
)
returns table (
  id              uuid,
  resource_id     uuid,
  resource_name   text,
  booking_date    date,
  start_time      time,
  end_time        time,
  purpose         text,
  booked_by       uuid,
  booked_by_name  text
)
language sql
security definer
set search_path = public
stable
as $$
  select b.id,
         b.resource_id,
         r.name as resource_name,
         b.booking_date,
         b.start_time,
         b.end_time,
         b.purpose,
         b.booked_by,
         coalesce(bp.full_name, bu.email::text, '') as booked_by_name
    from public.resource_bookings b
    join public.resources r on r.id = b.resource_id
    left join public.profiles bp on bp.id = b.booked_by
    left join auth.users bu on bu.id = b.booked_by
   where b.school_id = p_school_id
     and (p_date is null or b.booking_date = p_date)
     and (p_resource_id is null or b.resource_id = p_resource_id)
     and exists (
       select 1 from public.profiles me
        where me.id = auth.uid()
          and me.school_id = p_school_id
          and me.role in ('teacher','school_organiser')
     )
   order by b.booking_date asc, b.start_time asc;
$$;
grant execute on function public.list_resource_bookings(uuid, date, uuid) to authenticated;

-- ============================================================================
-- 10. CLUB RPCs
-- ============================================================================

create or replace function public.create_club(
  p_school_id   uuid,
  p_name        text,
  p_description text default null,
  p_schedule    text default null,
  p_lead_user_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if auth.uid() is null then
    return jsonb_build_object('ok', false, 'reason', 'not_authenticated');
  end if;
  perform public._assert_school_staff_with_perm(p_school_id, 'clubs');
  if nullif(trim(coalesce(p_name, '')), '') is null then
    return jsonb_build_object('ok', false, 'reason', 'name_required');
  end if;
  insert into public.clubs (school_id, name, description, schedule, lead_user_id, created_by)
  values (p_school_id, trim(p_name),
          nullif(trim(coalesce(p_description, '')), ''),
          nullif(trim(coalesce(p_schedule, '')), ''),
          p_lead_user_id,
          auth.uid())
  returning id into v_id;
  return jsonb_build_object('ok', true, 'club_id', v_id);
end;
$$;
grant execute on function public.create_club(uuid, text, text, text, uuid) to authenticated;

create or replace function public.update_club(
  p_club_id     uuid,
  p_name        text,
  p_description text default null,
  p_schedule    text default null,
  p_lead_user_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_club public.clubs%rowtype;
begin
  if auth.uid() is null then
    return jsonb_build_object('ok', false, 'reason', 'not_authenticated');
  end if;
  select * into v_club from public.clubs where clubs.id = p_club_id;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'unknown_club');
  end if;
  perform public._assert_school_staff_with_perm(v_club.school_id, 'clubs');
  update public.clubs
     set name         = coalesce(nullif(trim(p_name), ''), name),
         description  = nullif(trim(coalesce(p_description, '')), ''),
         schedule     = nullif(trim(coalesce(p_schedule, '')), ''),
         lead_user_id = p_lead_user_id
   where clubs.id = p_club_id;
  return jsonb_build_object('ok', true);
end;
$$;
grant execute on function public.update_club(uuid, text, text, text, uuid) to authenticated;

create or replace function public.delete_club(
  p_club_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_club public.clubs%rowtype;
begin
  if auth.uid() is null then
    return jsonb_build_object('ok', false, 'reason', 'not_authenticated');
  end if;
  select * into v_club from public.clubs where clubs.id = p_club_id;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'unknown_club');
  end if;
  perform public._assert_school_staff_with_perm(v_club.school_id, 'clubs');
  delete from public.clubs where clubs.id = p_club_id;
  return jsonb_build_object('ok', true);
end;
$$;
grant execute on function public.delete_club(uuid) to authenticated;

create or replace function public.add_club_members(
  p_club_id          uuid,
  p_student_user_ids uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_club  public.clubs%rowtype;
  v_added int := 0;
begin
  if auth.uid() is null then
    return jsonb_build_object('ok', false, 'reason', 'not_authenticated');
  end if;
  select * into v_club from public.clubs where clubs.id = p_club_id;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'unknown_club');
  end if;
  perform public._assert_school_staff_with_perm(v_club.school_id, 'clubs');
  insert into public.club_members (club_id, student_user_id, added_by)
  select p_club_id, sid, auth.uid()
    from unnest(p_student_user_ids) sid
    join public.profiles p on p.id = sid
   where p.school_id = v_club.school_id
     and p.role = 'student'
     and p.removed_from_school_at is null
     and p.deleted_at is null
  on conflict (club_id, student_user_id) do nothing;
  get diagnostics v_added = row_count;
  return jsonb_build_object('ok', true, 'added', v_added);
end;
$$;
grant execute on function public.add_club_members(uuid, uuid[]) to authenticated;

create or replace function public.remove_club_member(
  p_club_id         uuid,
  p_student_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_club public.clubs%rowtype;
begin
  if auth.uid() is null then
    return jsonb_build_object('ok', false, 'reason', 'not_authenticated');
  end if;
  select * into v_club from public.clubs where clubs.id = p_club_id;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'unknown_club');
  end if;
  perform public._assert_school_staff_with_perm(v_club.school_id, 'clubs');
  delete from public.club_members
   where club_id = p_club_id and student_user_id = p_student_user_id;
  return jsonb_build_object('ok', true);
end;
$$;
grant execute on function public.remove_club_member(uuid, uuid) to authenticated;

create or replace function public.list_clubs(
  p_school_id uuid
)
returns table (
  id           uuid,
  name         text,
  description  text,
  schedule     text,
  lead_user_id uuid,
  lead_name    text,
  member_count int,
  created_at   timestamptz
)
language sql
security definer
set search_path = public
stable
as $$
  select c.id,
         c.name,
         c.description,
         c.schedule,
         c.lead_user_id,
         coalesce(lp.full_name, lu.email::text, '') as lead_name,
         (select count(*) from public.club_members cm where cm.club_id = c.id)::int as member_count,
         c.created_at
    from public.clubs c
    left join public.profiles lp on lp.id = c.lead_user_id
    left join auth.users lu on lu.id = c.lead_user_id
   where c.school_id = p_school_id
     and exists (
       select 1 from public.profiles me
        where me.id = auth.uid()
          and me.school_id = p_school_id
          and me.role in ('teacher','school_organiser')
     )
   order by c.name asc;
$$;
grant execute on function public.list_clubs(uuid) to authenticated;

create or replace function public.get_club_members(
  p_club_id uuid
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
  select cm.student_user_id,
         coalesce(p.full_name, u.email::text, '') as full_name,
         u.email::text,
         p.year_group,
         cm.created_at
    from public.club_members cm
    join public.profiles p on p.id = cm.student_user_id
    join auth.users u on u.id = cm.student_user_id
   where cm.club_id = p_club_id
     and exists (
       select 1 from public.clubs c
       join public.profiles me on me.id = auth.uid()
        where c.id = cm.club_id
          and me.school_id = c.school_id
          and me.role in ('teacher','school_organiser')
     )
   order by p.full_name asc;
$$;
grant execute on function public.get_club_members(uuid) to authenticated;

-- ============================================================================
-- 11. ANALYTICS RPC
-- get_school_analytics — one round trip with every headline number.
-- Attendance, praise, behaviour, homework completion, and top/bottom
-- students for the window (default 30 days).
-- ============================================================================

create or replace function public.get_school_analytics(
  p_school_id uuid,
  p_days      int default 30
)
returns jsonb
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_days       int := greatest(coalesce(p_days, 30), 1);
  v_since      date := current_date - v_days;
  v_att_present int := 0;
  v_att_late    int := 0;
  v_att_absent  int := 0;
  v_att_excused int := 0;
  v_hw_done     int := 0;
  v_hw_total    int := 0;
  v_att_total   int := 0;
begin
  if auth.uid() is null then
    return jsonb_build_object('ok', false, 'reason', 'not_authenticated');
  end if;
  perform public._assert_school_staff_with_perm(p_school_id, 'analytics');

  select count(*) filter (where m.status = 'present'),
         count(*) filter (where m.status = 'late'),
         count(*) filter (where m.status = 'absent'),
         count(*) filter (where m.status = 'excused')
    into v_att_present, v_att_late, v_att_absent, v_att_excused
    from public.register_marks m
    join public.register_sessions s on s.id = m.session_id
   where s.school_id = p_school_id
     and s.session_date >= v_since;
  v_att_total := v_att_present + v_att_late + v_att_absent + v_att_excused;

  select count(*) filter (
          where t.status in ('done','late','seen')
            or (t.status = 'submitted' and sub.id is not null)
        ),
         count(*)
    into v_hw_done, v_hw_total
    from public.assignment_targets t
    join public.assignments a on a.id = t.assignment_id
    left join public.assignment_submissions sub
      on sub.assignment_id = t.assignment_id and sub.student_user_id = t.student_user_id
   where a.school_id = p_school_id
     and a.is_template = true
     and a.due_at >= now() - (v_days || ' days')::interval;

  return jsonb_build_object(
    'ok', true,
    'days', v_days,
    'since', v_since,
    -- Register submissions in the window: how many registers were
    -- taken, how many were flagged late (submitted past the school's
    -- late window) and how many were ad-hoc (not tied to a timetable
    -- lesson). is_late is sticky — set on first submission only.
    'registers', (
      select jsonb_build_object(
               'submitted', count(*)::int,
               'late',      count(*) filter (where s.is_late)::int,
               'ad_hoc',    count(*) filter (where s.timetable_slot_id is null)::int
             )
        from public.register_sessions s
       where s.school_id = p_school_id
         and s.session_date >= v_since
    ),
    'attendance', jsonb_build_object(
      'present',  v_att_present,
      'late',     v_att_late,
      'absent',   v_att_absent,
      'excused',  v_att_excused,
      'total',    v_att_total,
      'overall_pct', case when v_att_total = 0 then null
                        else round((v_att_present + v_att_late) * 100.0 / v_att_total)::int end,
      'by_class', (
        select coalesce(jsonb_agg(jsonb_build_object(
                 'class_id',   bc.class_id,
                 'class_name', bc.class_name,
                 'marks',      bc.marks,
                 'pct',        bc.pct
               ) order by bc.pct desc nulls last), '[]'::jsonb)
        from (
          select s.class_id,
                 c.name as class_name,
                 count(*)::int as marks,
                 round(
                   count(*) filter (where m.status in ('present','late')) * 100.0
                   / nullif(count(*) filter (where m.status <> 'excused'), 0)
                 )::int as pct
            from public.register_sessions s
            join public.classes c on c.id = s.class_id
            join public.register_marks m on m.session_id = s.id
           where s.school_id = p_school_id
             and s.session_date >= v_since
           group by s.class_id, c.name
        ) bc
      )
    ),
    'praise', jsonb_build_object(
      'total_points', (
        select coalesce(sum(pp.points), 0)::int
          from public.praise_points pp
         where pp.school_id = p_school_id
           and pp.created_at >= now() - (v_days || ' days')::interval
      ),
      'awards', (
        select count(*)::int
          from public.praise_points pp
         where pp.school_id = p_school_id
           and pp.created_at >= now() - (v_days || ' days')::interval
      ),
      'by_week', (
        select coalesce(jsonb_agg(jsonb_build_object(
                 'week',   bw.week,
                 'points', bw.points
               ) order by bw.week), '[]'::jsonb)
        from (
          select date_trunc('week', pp.created_at)::date as week,
                 sum(pp.points)::int as points
            from public.praise_points pp
           where pp.school_id = p_school_id
             and pp.created_at >= now() - (v_days || ' days')::interval
           group by 1
        ) bw
      )
    ),
    'behaviour', jsonb_build_object(
      'total', (
        select count(*)::int
          from public.behaviour_incidents i
         where i.school_id = p_school_id
           and i.created_at >= now() - (v_days || ' days')::interval
      ),
      'by_severity', jsonb_build_object(
        'low',    (select count(*)::int from public.behaviour_incidents i
                    where i.school_id = p_school_id and i.severity = 'low'
                      and i.created_at >= now() - (v_days || ' days')::interval),
        'medium', (select count(*)::int from public.behaviour_incidents i
                    where i.school_id = p_school_id and i.severity = 'medium'
                      and i.created_at >= now() - (v_days || ' days')::interval),
        'high',   (select count(*)::int from public.behaviour_incidents i
                    where i.school_id = p_school_id and i.severity = 'high'
                      and i.created_at >= now() - (v_days || ' days')::interval)
      ),
      'by_week', (
        select coalesce(jsonb_agg(jsonb_build_object(
                 'week',      bw.week,
                 'incidents', bw.incidents
               ) order by bw.week), '[]'::jsonb)
        from (
          select date_trunc('week', i.created_at)::date as week,
                 count(*)::int as incidents
            from public.behaviour_incidents i
           where i.school_id = p_school_id
             and i.created_at >= now() - (v_days || ' days')::interval
           group by 1
        ) bw
      )
    ),
    'homework', jsonb_build_object(
      'done',  v_hw_done,
      'total', v_hw_total,
      'completion_pct', case when v_hw_total = 0 then null
                             else round(v_hw_done * 100.0 / v_hw_total)::int end
    ),
    'students', (
      select jsonb_build_object(
        'top', (
          select coalesce(jsonb_agg(jsonb_build_object(
                   'student_user_id', sc.student_user_id,
                   'full_name',       sc.full_name,
                   'praise',          sc.praise,
                   'behaviour',       sc.behaviour,
                   'score',           sc.score
                 ) order by sc.score desc), '[]'::jsonb)
          from (
            select st.student_user_id, st.full_name, st.praise, st.behaviour,
                   st.praise
                     - 1 * st.low - 2 * st.medium - 4 * st.high as score
              from (
                select p.id as student_user_id,
                       coalesce(p.full_name, u.email, '') as full_name,
                       (select coalesce(sum(pp.points), 0)::int
                          from public.praise_points pp
                         where pp.student_user_id = p.id
                           and pp.created_at >= now() - (v_days || ' days')::interval) as praise,
                       (select count(*)::int
                          from public.behaviour_incidents i
                         where i.student_user_id = p.id
                           and i.created_at >= now() - (v_days || ' days')::interval) as behaviour,
                       (select count(*)::int
                          from public.behaviour_incidents i
                         where i.student_user_id = p.id and i.severity = 'low'
                           and i.created_at >= now() - (v_days || ' days')::interval) as low,
                       (select count(*)::int
                          from public.behaviour_incidents i
                         where i.student_user_id = p.id and i.severity = 'medium'
                           and i.created_at >= now() - (v_days || ' days')::interval) as medium,
                       (select count(*)::int
                          from public.behaviour_incidents i
                         where i.student_user_id = p.id and i.severity = 'high'
                           and i.created_at >= now() - (v_days || ' days')::interval) as high
                  from public.profiles p
                  join auth.users u on u.id = p.id
                 where p.school_id = p_school_id
                   and p.role = 'student'
                   and p.removed_from_school_at is null
                   and p.deleted_at is null
              ) st
             where st.praise > 0 or st.behaviour > 0
             order by st.praise
                     - 1 * st.low - 2 * st.medium - 4 * st.high desc
             limit 10
          ) sc
        ),
        'attention', (
          select coalesce(jsonb_agg(jsonb_build_object(
                   'student_user_id', sc.student_user_id,
                   'full_name',       sc.full_name,
                   'praise',          sc.praise,
                   'behaviour',       sc.behaviour,
                   'score',           sc.score
                 ) order by sc.score asc), '[]'::jsonb)
          from (
            select st.student_user_id, st.full_name, st.praise, st.behaviour,
                   st.praise
                     - 1 * st.low - 2 * st.medium - 4 * st.high as score
              from (
                select p.id as student_user_id,
                       coalesce(p.full_name, u.email, '') as full_name,
                       (select coalesce(sum(pp.points), 0)::int
                          from public.praise_points pp
                         where pp.student_user_id = p.id
                           and pp.created_at >= now() - (v_days || ' days')::interval) as praise,
                       (select count(*)::int
                          from public.behaviour_incidents i
                         where i.student_user_id = p.id
                           and i.created_at >= now() - (v_days || ' days')::interval) as behaviour,
                       (select count(*)::int
                          from public.behaviour_incidents i
                         where i.student_user_id = p.id and i.severity = 'low'
                           and i.created_at >= now() - (v_days || ' days')::interval) as low,
                       (select count(*)::int
                          from public.behaviour_incidents i
                         where i.student_user_id = p.id and i.severity = 'medium'
                           and i.created_at >= now() - (v_days || ' days')::interval) as medium,
                       (select count(*)::int
                          from public.behaviour_incidents i
                         where i.student_user_id = p.id and i.severity = 'high'
                           and i.created_at >= now() - (v_days || ' days')::interval) as high
                  from public.profiles p
                  join auth.users u on u.id = p.id
                 where p.school_id = p_school_id
                   and p.role = 'student'
                   and p.removed_from_school_at is null
                   and p.deleted_at is null
              ) st
             where st.praise > 0 or st.behaviour > 0
             order by st.praise
                     - 1 * st.low - 2 * st.medium - 4 * st.high asc
             limit 10
          ) sc
        )
      )
    )
  );
end;
$$;
grant execute on function public.get_school_analytics(uuid, int) to authenticated;

-- ============================================================================
-- DONE.
--
-- After running this migration (and supabase_school_settings.sql):
--   1. school-systems.html tiles all resolve — register, timetables,
--      behaviour, praise, announcements, booking, clubs, absences,
--      analytics.
--   2. Behaviour / praise / announcement writes push notifications to
--      the affected students' bell (topbar.js) automatically.
--   3. get_school_analytics powers analytics.html.
-- ============================================================================