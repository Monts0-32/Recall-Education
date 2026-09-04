-- ============================================================================
-- Recall Education — Student access to school systems
--
-- Run AFTER supabase_school_systems.sql (and every other supabase_*.sql
-- migration). Idempotent: safe to re-run.
--
-- What this does:
--   Gives school-tied students (profiles.role='student', profiles.school_id
--   set) read/member access to the school systems — everything EXCEPT the
--   teacher workflows:
--     * Announcements (view only): school-wide + their own classes' posts.
--     * Timetable (view only): slots for their classes (+ class-less
--       whole-school rows).
--     * Clubs (view + join/leave as a member).
--     * Own attendance (register marks incl. late flags) + own absences.
--
--   Everything else (registers, behaviour, praise, posting announcements,
--   booking, analytics, settings) remains staff-only.
--
-- Design notes:
--   * All access goes through SECURITY DEFINER RPCs (repo convention) —
--     no RLS policy changes, no new tables.
--   * One helper, public._is_school_student(p_school_id), gates every
--     RPC. It fails closed for: unauthenticated callers, non-students
--     (teachers/organisers keep their richer staff RPCs), students of a
--     different school, and soft-removed students
--     (removed_from_school_at / deleted_at set).
--   * Read RPCs fail as empty sets (matching list_announcements /
--     list_timetable_slots precedent); join/leave return {ok:false,reason}.
--   * club_members has no capacity column, so join_club enforces no cap;
--     membership is student-initiated so no push_notification is sent.
--
-- Every function is dropped (full signature) before its create-or-replace
-- so the file stays re-runnable even after return-list edits.
-- ============================================================================

-- ---------- 0. HELPER + INDEXES ---------------------------------------------

drop function if exists public._is_school_student(uuid);

create or replace function public._is_school_student(
  p_school_id uuid
)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.profiles me
     where me.id = auth.uid()
       and me.school_id = p_school_id
       and me.role = 'student'
       and me.removed_from_school_at is null
       and me.deleted_at is null
  );
$$;

-- Both new read queries filter on student_user_id = auth.uid(); neither
-- table had a student-scoped index.
create index if not exists register_marks_student_idx
  on public.register_marks (student_user_id);
create index if not exists absence_records_student_idx
  on public.absence_records (student_user_id, start_date desc);

-- ---------- 1. LIST_STUDENT_ANNOUNCEMENTS -----------------------------------
-- Student announcement feed. Visible: audience 'everyone' / 'students'
-- (school-wide), plus audience 'class' where the class is one the student
-- is a member of. audience 'staff' never matches. Fails closed: a caller
-- who is not an active student of p_school_id gets an empty set.

drop function if exists public.list_student_announcements(uuid, int);

create or replace function public.list_student_announcements(
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
  select a.id, a.class_id, c.name as class_name, a.audience,
         a.title, a.body, a.posted_by,
         coalesce(pp.full_name, pu.email::text, '') as posted_by_name,
         a.created_at
    from public.announcements a
    left join public.classes c on c.id = a.class_id
    left join public.profiles pp on pp.id = a.posted_by
    left join auth.users pu on pu.id = a.posted_by
   where a.school_id = p_school_id
     and (
       a.audience in ('everyone', 'students')
       or (
         a.audience = 'class'
         and a.class_id in (
           select cm.class_id
             from public.class_members cm
            where cm.student_user_id = auth.uid()
         )
       )
     )
     and public._is_school_student(p_school_id)
   order by a.created_at desc
   limit greatest(coalesce(p_limit, 50), 0);
$$;

grant execute on function public.list_student_announcements(uuid, int) to authenticated;

-- ---------- 2. LIST_STUDENT_TIMETABLE --------------------------------------
-- The student's weekly timetable: slots for their classes plus class-less
-- rows (assembly-style whole-school events), matching the staff grid's
-- semantics. Fails closed the same way.

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
         t.day_of_week, t.period, t.start_time, t.end_time, t.room, t.label
    from public.timetable_slots t
    left join public.classes c on c.id = t.class_id
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
     )
     and public._is_school_student(p_school_id)
   order by t.day_of_week asc, t.period asc;
$$;

grant execute on function public.list_student_timetable(uuid) to authenticated;

-- ---------- 3. LIST_STUDENT_CLUBS -------------------------------------------
-- Every club at the school with its member count and whether the caller
-- is a member (drives the Join/Leave button). Fails closed the same way.

drop function if exists public.list_student_clubs(uuid);

create or replace function public.list_student_clubs(
  p_school_id uuid
)
returns table (
  id           uuid,
  name         text,
  description text,
  schedule     text,
  lead_user_id uuid,
  lead_name    text,
  member_count int,
  is_member    boolean
)
language sql
security definer
set search_path = public
stable
as $$
  select c.id, c.name, c.description, c.schedule, c.lead_user_id,
         coalesce(lp.full_name, lu.email::text, '') as lead_name,
         (select count(*)
            from public.club_members cm
           where cm.club_id = c.id)::int as member_count,
         exists (
           select 1
             from public.club_members cm2
            where cm2.club_id = c.id
              and cm2.student_user_id = auth.uid()
         ) as is_member
    from public.clubs c
    left join public.profiles lp on lp.id = c.lead_user_id
    left join auth.users lu on lu.id = c.lead_user_id
   where c.school_id = p_school_id
     and public._is_school_student(p_school_id)
   order by c.name asc;
$$;

grant execute on function public.list_student_clubs(uuid) to authenticated;

-- ---------- 4. JOIN_CLUB / LEAVE_CLUB ---------------------------------------
-- Student-initiated club membership. Both check the caller is an active
-- student of the CLUB's school (this is also what blocks cross-school
-- joins and every non-student). No capacity column exists on clubs, so
-- no cap is enforced. No notification — the student did it themselves.

drop function if exists public.join_club(uuid);

create or replace function public.join_club(
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

  select * into v_club from public.clubs where id = p_club_id;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'unknown_club');
  end if;

  if not public._is_school_student(v_club.school_id) then
    return jsonb_build_object('ok', false, 'reason', 'not_allowed');
  end if;

  if exists (
    select 1 from public.club_members
     where club_id = p_club_id and student_user_id = auth.uid()
  ) then
    return jsonb_build_object('ok', false, 'reason', 'already_member');
  end if;

  insert into public.club_members (club_id, student_user_id, added_by)
  values (p_club_id, auth.uid(), auth.uid())
  on conflict (club_id, student_user_id) do nothing;

  return jsonb_build_object('ok', true);
end;
$$;

grant execute on function public.join_club(uuid) to authenticated;

drop function if exists public.leave_club(uuid);

create or replace function public.leave_club(
  p_club_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_club    public.clubs%rowtype;
  v_removed int;
begin
  if auth.uid() is null then
    return jsonb_build_object('ok', false, 'reason', 'not_authenticated');
  end if;

  select * into v_club from public.clubs where id = p_club_id;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'unknown_club');
  end if;

  if not public._is_school_student(v_club.school_id) then
    return jsonb_build_object('ok', false, 'reason', 'not_allowed');
  end if;

  delete from public.club_members
   where club_id = p_club_id
     and student_user_id = auth.uid();
  get diagnostics v_removed = row_count;

  if v_removed = 0 then
    return jsonb_build_object('ok', false, 'reason', 'not_member');
  end if;

  return jsonb_build_object('ok', true);
end;
$$;

grant execute on function public.leave_club(uuid) to authenticated;

-- ---------- 5. LIST_MY_ATTENDANCE -------------------------------------------
-- The caller's own register marks (status per lesson + the session's
-- sticky late flag), newest first. student_user_id = auth.uid() means a
-- student can never read another student's marks.

drop function if exists public.list_my_attendance(uuid, int);

create or replace function public.list_my_attendance(
  p_school_id uuid,
  p_limit     int default 200
)
returns table (
  session_date date,
  period       int,
  class_name   text,
  status       text,
  note         text,
  is_late      boolean,
  submitted_at timestamptz
)
language sql
security definer
set search_path = public
stable
as $$
  select s.session_date, s.period, c.name as class_name,
         m.status, m.note, s.is_late, s.submitted_at
    from public.register_marks m
    join public.register_sessions s on s.id = m.session_id
    left join public.classes c on c.id = s.class_id
   where m.student_user_id = auth.uid()
     and s.school_id = p_school_id
     and public._is_school_student(p_school_id)
   order by s.session_date desc, s.period asc
   limit greatest(coalesce(p_limit, 200), 0);
$$;

grant execute on function public.list_my_attendance(uuid, int) to authenticated;

-- ---------- 6. LIST_MY_ABSENCES ---------------------------------------------
-- The caller's own recorded absence periods (planned absences entered by
-- staff on absences.html). Fails closed the same way.

drop function if exists public.list_my_absences(uuid);

create or replace function public.list_my_absences(
  p_school_id uuid
)
returns table (
  id               uuid,
  start_date       date,
  end_date         date,
  reason           text,
  note             text,
  reported_by_name text,
  created_at       timestamptz
)
language sql
security definer
set search_path = public
stable
as $$
  select a.id, a.start_date, a.end_date, a.reason, a.note,
         coalesce(rp.full_name, ru.email::text, '') as reported_by_name,
         a.created_at
    from public.absence_records a
    left join public.profiles rp on rp.id = a.reported_by
    left join auth.users ru on ru.id = a.reported_by
   where a.school_id = p_school_id
     and a.student_user_id = auth.uid()
     and public._is_school_student(p_school_id)
   order by a.start_date desc;
$$;

grant execute on function public.list_my_absences(uuid) to authenticated;

-- ============================================================================
-- DONE. After running this migration:
--   * A student attached to a school gets: list_student_announcements,
--     list_student_timetable, list_student_clubs, join_club, leave_club,
--     list_my_attendance, list_my_absences — all student-of-school gated.
--   * Teachers/organisers are unaffected: their RPCs are unchanged and
--     these student RPCs return empty / not_allowed for them.
--   * The student pages (student-announcements.html, student-timetable.html,
--     student-clubs.html, student-attendance.html) and the dashboard's
--     "My school" card consume these RPCs.
-- ============================================================================