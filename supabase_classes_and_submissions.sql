-- ============================================================================
-- Recall Education — Classes, homework types, submissions & stats
-- Run AFTER supabase_school_organisers.sql.
-- Idempotent: safe to re-run.
--
-- What this does:
--   1. Widens assignments.kind to include the six new types: assignment,
--      classwork, notice, quiz, class_test, spelling_test.
--   2. Widens assignment_targets.status to include late, submitted, seen.
--   3. Adds the quiz_data column on assignments for inline quizzes.
--   4. Creates four new tables: classes, class_members, assignment_submissions,
--      class_rollups.
--   5. Adds a storage policy so students can write their submission files
--      to assignment-files/{school_id}/submissions/{assignment_id}/{user_id}/...
--   6. Defines ~15 new SECURITY DEFINER RPCs for class CRUD, submission
--      tracking, quiz grading, and per-class stats.
--   7. Updates create_assignment so its p_targets may also be {class_id: ...}.
-- ============================================================================

-- ============================================================================
-- 1. WIDEN ASSIGNMENTS.KIND
-- ============================================================================

alter table public.assignments drop constraint if exists assignments_kind_check;
alter table public.assignments add constraint assignments_kind_check
  check (kind in ('homework','mock','exam','live',
                  'assignment','classwork','notice','quiz',
                  'class_test','spelling_test'));
-- The four old values stay for back-compat. The six new values map to
-- the user-facing labels the user asked for: Assignment, Classwork,
-- Notice, Quiz, Class test, Spelling test.

-- ============================================================================
-- 2. WIDEN ASSIGNMENT_TARGETS.STATUS
-- ============================================================================

alter table public.assignment_targets drop constraint if exists assignment_targets_status_check;
alter table public.assignment_targets add constraint assignment_targets_status_check
  check (status in ('pending','done','missed','late','submitted','seen'));
-- pending   = no work handed in
-- done      = student marked done on time (completed_at <= due_at)
-- late      = student handed in after due_at
-- missed    = past due, no submission (set by sweep)
-- submitted = there's a submission row but not yet marked done/late
-- seen      = student acknowledged a notice (no submission expected)

-- ============================================================================
-- 3. ASSIGNMENTS.QUIZ_DATA (inline MCQ quiz payload)
-- Same shape as the lesson_blocks mcq kind so the renderer can be shared.
-- ============================================================================

alter table public.assignments
  add column if not exists quiz_data jsonb;
-- Shape:
--   {
--     "questions": [
--       {
--         "prompt": "...",
--         "options": [{"text": "...", "correct": true, "feedback": "..."}, ...],
--         "explanation": "..."
--       }, ...
--     ]
--   }

-- ============================================================================
-- 4. CLASSES + MEMBERSHIP
-- ============================================================================

create table if not exists public.classes (
  id              uuid primary key default gen_random_uuid(),
  school_id       uuid not null references public.schools(id) on delete cascade,
  name            text not null,
  description     text,
  owner_user_id   uuid references auth.users(id) on delete set null,
  -- Optional tag: which teacher owns/tutors this class, and which subject it
  -- is for. Both nullable — a class can be just a roster, or be tagged for
  -- one teacher / one subject, or both.
  tutor_user_id   uuid references auth.users(id) on delete set null,
  subject_id      uuid references public.subjects(id) on delete set null,
  created_at      timestamptz not null default now(),
  archived_at     timestamptz
);
create index if not exists classes_school_idx
  on public.classes (school_id) where archived_at is null;
create index if not exists classes_owner_idx
  on public.classes (owner_user_id);

-- Idempotent add for existing deployments.
alter table public.classes
  add column if not exists tutor_user_id uuid references auth.users(id) on delete set null;
alter table public.classes
  add column if not exists subject_id    uuid references public.subjects(id) on delete set null;

create table if not exists public.class_members (
  class_id        uuid not null references public.classes(id) on delete cascade,
  student_user_id uuid not null references auth.users(id) on delete cascade,
  added_at        timestamptz not null default now(),
  primary key (class_id, student_user_id)
);
create index if not exists class_members_student_idx
  on public.class_members (student_user_id);

-- ============================================================================
-- 5. SUBMISSIONS
-- Single table for text / file / quiz answers. Holds the per-(assignment,
-- student) submission payload. Stats are computed from this table.
-- ============================================================================

create table if not exists public.assignment_submissions (
  assignment_id   uuid not null references public.assignments(id) on delete cascade,
  student_user_id uuid not null references auth.users(id) on delete cascade,
  text_answer     text,
  file_path       text,         -- path inside the 'assignment-files' bucket
  file_name       text,
  quiz_score      int,          -- 0-100
  quiz_answers    jsonb,        -- per-question correctness for the teacher
  submitted_at    timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  primary key (assignment_id, student_user_id)
);
create index if not exists submissions_assignment_idx
  on public.assignment_submissions (assignment_id);

do $$
begin
  if exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'touch_updated_at'
  ) then
    drop trigger if exists assignment_submissions_touch_updated_at on public.assignment_submissions;
    create trigger assignment_submissions_touch_updated_at
      before update on public.assignment_submissions
      for each row execute function public.touch_updated_at();
  end if;
end $$;

-- ============================================================================
-- 6. CLASS ROLLUPS (nightly-pre-computed class stats)
-- Refreshed by refresh_class_rollups(p_class_id). Read by get_class_summary.
-- ============================================================================

create table if not exists public.class_rollups (
  class_id              uuid primary key references public.classes(id) on delete cascade,
  total_assignments     int not null default 0,
  total_targets         int not null default 0,
  on_time_count         int not null default 0,
  late_count            int not null default 0,
  not_submitted_count   int not null default 0,
  subject_breakdown     jsonb not null default '{}'::jsonb, -- {subject_id: {on_time, late, not_submitted}}
  quiz_wrong_questions  jsonb not null default '{}'::jsonb, -- {assignment_id: {question_index: wrong_count}}
  not_handed_in         jsonb not null default '[]'::jsonb,  -- [{student_id, assignment_id, due_at}]
  refreshed_at          timestamptz not null default now()
);

-- ============================================================================
-- 7. RLS — keep it consistent with the rest of the school system.
-- ============================================================================

alter table public.classes enable row level security;
alter table public.class_members enable row level security;
alter table public.assignment_submissions enable row level security;
alter table public.class_rollups enable row level security;

-- classes: members of the school can read; organiser of the school or
-- the class owner can write. All writes go through RPCs anyway.
drop policy if exists "classes_school_read" on public.classes;
create policy "classes_school_read" on public.classes for select
  to authenticated
  using (
    school_id is not null
    and school_id = (select school_id from public.profiles where id = auth.uid())
  );

-- class_members: students see their own row; staff of the school see all.
drop policy if exists "class_members_own_read" on public.class_members;
create policy "class_members_own_read" on public.class_members for select
  to authenticated
  using (student_user_id = auth.uid());

drop policy if exists "class_members_school_read" on public.class_members;
create policy "class_members_school_read" on public.class_members for select
  to authenticated
  using (
    exists (
      select 1 from public.classes c
      join public.profiles p on p.id = auth.uid()
       where c.id = class_members.class_id
         and c.school_id is not null
         and c.school_id = p.school_id
         and p.role in ('teacher','school_organiser')
    )
  );

-- assignment_submissions: student sees their own; staff of the school sees all.
drop policy if exists "submissions_own_read" on public.assignment_submissions;
create policy "submissions_own_read" on public.assignment_submissions for select
  to authenticated
  using (student_user_id = auth.uid());

drop policy if exists "submissions_school_read" on public.assignment_submissions;
create policy "submissions_school_read" on public.assignment_submissions for select
  to authenticated
  using (
    exists (
      select 1 from public.assignments a
      join public.profiles p on p.id = auth.uid()
       where a.id = assignment_submissions.assignment_id
         and a.school_id is not null
         and a.school_id = p.school_id
         and p.role in ('teacher','school_organiser')
    )
  );

-- class_rollups: staff of the school only.
drop policy if exists "class_rollups_school_read" on public.class_rollups;
create policy "class_rollups_school_read" on public.class_rollups for select
  to authenticated
  using (
    exists (
      select 1 from public.classes c
      join public.profiles p on p.id = auth.uid()
       where c.id = class_rollups.class_id
         and c.school_id is not null
         and c.school_id = p.school_id
         and p.role in ('teacher','school_organiser')
    )
  );

-- All writes are RPC-only (no INSERT/UPDATE/DELETE policies).

-- ============================================================================
-- 8. STORAGE POLICY — student writes
-- Students can upload to ${school_id}/submissions/.../.../${user_id}/...
-- ============================================================================

drop policy if exists "assignment_files_student_write" on storage.objects;
create policy "assignment_files_student_write" on storage.objects
  for insert to authenticated with check (
    bucket_id = 'assignment-files'
    and exists (
      select 1 from public.profiles p
       where p.id = auth.uid()
         and p.role = 'student'
         and p.school_id is not null
         and p.school_id::text = (storage.foldername(name))[1]
         -- path[3] must be the student's own user id
         and (storage.foldername(name))[3] = auth.uid()::text
    )
  );

-- ============================================================================
-- 9. CREATE_ASSIGNMENT — add a {class_id} branch
-- Idempotent: re-creates the function with the new branch in place.
-- ============================================================================

create or replace function public.create_assignment(
  p_school_id   uuid,
  p_subject_id  uuid,
  p_title       text,
  p_description text,
  p_due_at      timestamptz,
  p_targets     jsonb,
  p_kind        text default 'homework',
  p_resources   jsonb default '[]'::jsonb,
  p_quiz_data   jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller   uuid := auth.uid();
  v_school   public.schools%rowtype;
  v_title    text := trim(coalesce(p_title, ''));
  v_kind     text := coalesce(nullif(trim(p_kind), ''), 'homework');
  v_tgt      jsonb := coalesce(p_targets, '{}'::jsonb);
  v_res      jsonb := coalesce(p_resources, '[]'::jsonb);
  v_aid      uuid;
  v_count    int := 0;
  v_res_item jsonb;
begin
  if v_caller is null then
    return jsonb_build_object('ok', false, 'reason', 'not_authenticated');
  end if;
  select * into v_school from public.schools where id = p_school_id;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'unknown_school');
  end if;
  if not exists (
    select 1 from public.profiles
     where id = v_caller
       and school_id = p_school_id
       and role in ('teacher','school_organiser')
  ) then
    return jsonb_build_object('ok', false, 'reason', 'forbidden');
  end if;
  if v_title = '' then
    return jsonb_build_object('ok', false, 'reason', 'title_required');
  end if;
  if p_due_at is null then
    return jsonb_build_object('ok', false, 'reason', 'due_at_required');
  end if;
  if v_kind not in (
    'homework','mock','exam','live',
    'assignment','classwork','notice','quiz','class_test','spelling_test'
  ) then
    return jsonb_build_object('ok', false, 'reason', 'invalid_kind');
  end if;

  insert into public.assignments (
    user_id, school_id, created_by, is_template,
    subject_id, title, description, kind, due_at, quiz_data
  ) values (
    null, p_school_id, v_caller, true,
    p_subject_id, v_title, nullif(trim(coalesce(p_description, '')), ''),
    v_kind, p_due_at, p_quiz_data
  )
  returning id into v_aid;

  -- Expand p_targets and insert one row per student.
  if v_tgt ? 'all' and (v_tgt->>'all')::boolean then
    insert into public.assignment_targets (assignment_id, student_user_id)
    select v_aid, p.id
      from public.profiles p
     where p.school_id = p_school_id
       and p.role = 'student'
       and p.removed_from_school_at is null
       and p.deleted_at is null;
    get diagnostics v_count = row_count;
  elsif v_tgt ? 'subject_id' then
    insert into public.assignment_targets (assignment_id, student_user_id)
    select v_aid, e.user_id
      from public.enrollments e
      join public.profiles p on p.id = e.user_id
     where e.subject_id = (v_tgt->>'subject_id')::uuid
       and p.school_id = p_school_id
       and p.role = 'student'
       and p.removed_from_school_at is null
       and p.deleted_at is null;
    get diagnostics v_count = row_count;
  elsif v_tgt ? 'year_group' then
    insert into public.assignment_targets (assignment_id, student_user_id)
    select v_aid, p.id
      from public.profiles p
     where p.school_id = p_school_id
       and p.role = 'student'
       and p.year_group = v_tgt->>'year_group'
       and p.removed_from_school_at is null
       and p.deleted_at is null;
    get diagnostics v_count = row_count;
  elsif v_tgt ? 'student_ids' and jsonb_typeof(v_tgt->'student_ids') = 'array' then
    insert into public.assignment_targets (assignment_id, student_user_id)
    select v_aid, (sid #>> '{}')::uuid
      from jsonb_array_elements(v_tgt->'student_ids') sid
     where exists (
       select 1 from public.profiles p
        where p.id = (sid #>> '{}')::uuid
          and p.school_id = p_school_id
          and p.role = 'student'
          and p.removed_from_school_at is null
          and p.deleted_at is null
     );
    get diagnostics v_count = row_count;
  elsif v_tgt ? 'class_id' then
    insert into public.assignment_targets (assignment_id, student_user_id)
    select v_aid, cm.student_user_id
      from public.class_members cm
      join public.classes c on c.id = cm.class_id
      join public.profiles p on p.id = cm.student_user_id
     where c.id = (v_tgt->>'class_id')::uuid
       and c.school_id = p_school_id
       and c.archived_at is null
       and p.role = 'student'
       and p.removed_from_school_at is null
       and p.deleted_at is null;
    get diagnostics v_count = row_count;
  else
    return jsonb_build_object('ok', false, 'reason', 'invalid_targets');
  end if;

  -- Resources.
  if jsonb_typeof(v_res) = 'array' then
    for v_res_item in select * from jsonb_array_elements(v_res)
    loop
      insert into public.assignment_resources (
        assignment_id, kind, ref_lesson_id, url, storage_path, display_name, sort_order
      ) values (
        v_aid,
        v_res_item->>'kind',
        nullif(v_res_item->>'ref_lesson_id','')::uuid,
        nullif(v_res_item->>'url',''),
        nullif(v_res_item->>'storage_path',''),
        nullif(v_res_item->>'display_name',''),
        coalesce((v_res_item->>'sort_order')::int, 0)
      );
    end loop;
  end if;

  return jsonb_build_object(
    'ok', true,
    'assignment_id', v_aid,
    'targets_created', v_count
  );
end;
$$;

grant execute on function public.create_assignment(
  uuid, uuid, text, text, timestamptz, jsonb, text, jsonb, jsonb
) to authenticated;

-- ============================================================================
-- 10. CLASS RPCs
-- ============================================================================

-- Caller check: must belong to p_school_id and be teacher/organiser.
create or replace function public._assert_school_staff(p_school_id uuid)
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
end;
$$;

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

create or replace function public.update_class(
  p_class_id    uuid,
  p_name        text,
  p_description text,
  p_archived    boolean,
  p_tutor_user_id uuid default null,
  p_subject_id    uuid default null
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

  update public.classes
     set name          = coalesce(nullif(trim(p_name), ''), name),
         description   = nullif(trim(coalesce(p_description, '')), description),
         tutor_user_id = p_tutor_user_id,
         subject_id    = p_subject_id
   where classes.id = p_class_id;
  return jsonb_build_object('ok', true);
end;
$$;
grant execute on function public.update_class(uuid, text, text, boolean, uuid, uuid) to authenticated;

-- delete_class — hard-delete a class. Cascades to class_members via FK.
-- Caller must be the organiser of the school OR the class owner.
create or replace function public.delete_class(
  p_class_id uuid
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
  if not exists (
    select 1 from public.schools s
     where s.id = v_class.school_id
       and s.owner_user_id = auth.uid()
  ) and v_class.owner_user_id is distinct from auth.uid() then
    return jsonb_build_object('ok', false, 'reason', 'forbidden');
  end if;
  delete from public.classes where classes.id = p_class_id;
  return jsonb_build_object('ok', true);
end;
$$;
grant execute on function public.delete_class(uuid) to authenticated;

-- Caller must be in the school (student sees the class list, staff sees too).
create or replace function public.list_classes(
  p_school_id          uuid,
  p_include_archived   boolean default false
)
returns table (
  id           uuid,
  name         text,
  description  text,
  owner_user_id uuid,
  owner_name   text,
  tutor_user_id uuid,
  tutor_name   text,
  subject_id   uuid,
  subject_name text,
  member_count int,
  created_at   timestamptz,
  archived_at  timestamptz
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
         (select count(*) from public.class_members cm where cm.class_id = c.id)::int,
         c.created_at, c.archived_at
    from public.classes c
    left join public.profiles p  on p.id  = c.owner_user_id
    left join auth.users    u  on u.id  = c.owner_user_id
    left join public.profiles pt on pt.id = c.tutor_user_id
    left join auth.users    ut on ut.id = c.tutor_user_id
    left join public.subjects s  on s.id  = c.subject_id
   where c.school_id = p_school_id
     and (
       p_include_archived
       or c.archived_at is null
     )
   order by c.archived_at nulls first, c.created_at desc;
$$;
grant execute on function public.list_classes(uuid, boolean) to authenticated;

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
  created_at    timestamptz,
  archived_at   timestamptz,
  members       jsonb
)
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_class public.classes%rowtype;
  v_members jsonb;
  v_owner_name text;
  v_tutor_name text;
  v_subject_name text;
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
  created_at    := v_class.created_at;
  archived_at   := v_class.archived_at;
  members       := v_members;
  return next;
end;
$$;
grant execute on function public.get_class(uuid) to authenticated;

create or replace function public.add_class_members(
  p_class_id         uuid,
  p_student_user_ids uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_class public.classes%rowtype;
  v_added int := 0;
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
  insert into public.class_members (class_id, student_user_id)
  select p_class_id, sid
    from unnest(p_student_user_ids) sid
    join public.profiles p on p.id = sid
   where p.school_id = v_class.school_id
     and p.role = 'student'
     and p.removed_from_school_at is null
     and p.deleted_at is null
  on conflict (class_id, student_user_id) do nothing;
  get diagnostics v_added = row_count;
  return jsonb_build_object('ok', true, 'added', v_added);
end;
$$;
grant execute on function public.add_class_members(uuid, uuid[]) to authenticated;

create or replace function public.remove_class_member(
  p_class_id        uuid,
  p_student_user_id uuid
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
  if not exists (
    select 1 from public.schools s
     where s.id = v_class.school_id
       and s.owner_user_id = auth.uid()
  ) and v_class.owner_user_id is distinct from auth.uid() then
    return jsonb_build_object('ok', false, 'reason', 'forbidden');
  end if;
  delete from public.class_members
   where class_id = p_class_id and student_user_id = p_student_user_id;
  return jsonb_build_object('ok', true);
end;
$$;
grant execute on function public.remove_class_member(uuid, uuid) to authenticated;

-- ============================================================================
-- 11. SUBMISSION RPCs
-- ============================================================================

-- submit_assignment — student submits text / file / quiz answers.
-- quiz answers/score are sent in the same call so the data is
-- captured alongside the submission.
create or replace function public.submit_assignment(
  p_assignment_id uuid,
  p_text_answer   text default null,
  p_file_path     text default null,
  p_file_name     text default null,
  p_quiz_score    int  default null,
  p_quiz_answers  jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_target public.assignment_targets%rowtype;
  v_kind   text;
begin
  if auth.uid() is null then
    return jsonb_build_object('ok', false, 'reason', 'not_authenticated');
  end if;
  select * into v_target
    from public.assignment_targets
   where assignment_id = p_assignment_id
     and student_user_id = auth.uid();
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_target');
  end if;
  select kind into v_kind from public.assignments where id = p_assignment_id;
  if v_kind = 'notice' then
    return jsonb_build_object('ok', false, 'reason', 'notice_no_submission');
  end if;

  -- Upsert the submission row.
  insert into public.assignment_submissions (
    assignment_id, student_user_id,
    text_answer, file_path, file_name,
    quiz_score, quiz_answers,
    submitted_at, updated_at
  ) values (
    p_assignment_id, auth.uid(),
    nullif(trim(coalesce(p_text_answer, '')), ''),
    nullif(trim(coalesce(p_file_path, '')), ''),
    nullif(trim(coalesce(p_file_name, '')), ''),
    p_quiz_score, p_quiz_answers,
    now(), now()
  )
  on conflict (assignment_id, student_user_id) do update
    set text_answer  = excluded.text_answer,
        file_path    = excluded.file_path,
        file_name    = excluded.file_name,
        quiz_score   = excluded.quiz_score,
        quiz_answers = excluded.quiz_answers,
        submitted_at = now(),
        updated_at   = now();

  -- Set the target status. For quizzes, mark done automatically.
  if v_kind = 'quiz' then
    update public.assignment_targets
       set status       = 'done',
           completed_at = now(),
           updated_at   = now()
     where assignment_id = p_assignment_id
       and student_user_id = auth.uid();
  else
    update public.assignment_targets
       set status       = 'submitted',
           updated_at   = now()
     where assignment_id = p_assignment_id
       and student_user_id = auth.uid();
  end if;
  return jsonb_build_object('ok', true);
end;
$$;
grant execute on function public.submit_assignment(uuid, text, text, text, int, jsonb) to authenticated;

-- acknowledge_notice — student taps "I've read this" on a notice.
create or replace function public.acknowledge_notice(
  p_assignment_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_kind text;
begin
  if auth.uid() is null then
    return jsonb_build_object('ok', false, 'reason', 'not_authenticated');
  end if;
  select kind into v_kind from public.assignments where id = p_assignment_id;
  if v_kind is null then
    return jsonb_build_object('ok', false, 'reason', 'unknown_assignment');
  end if;
  if v_kind <> 'notice' then
    return jsonb_build_object('ok', false, 'reason', 'not_a_notice');
  end if;
  update public.assignment_targets
     set status       = 'seen',
         completed_at = now(),
         updated_at   = now()
   where assignment_id = p_assignment_id
     and student_user_id = auth.uid();
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_target');
  end if;
  return jsonb_build_object('ok', true);
end;
$$;
grant execute on function public.acknowledge_notice(uuid) to authenticated;

-- mark_submission_done — teacher/organiser marks a target as done/late/missed/pending.
-- If p_status='done' but the submission is past due_at, force to 'late'.
create or replace function public.mark_submission_done(
  p_assignment_id   uuid,
  p_student_user_id uuid,
  p_status          text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_a        public.assignments%rowtype;
  v_target   public.assignment_targets%rowtype;
  v_final    text;
  v_completed timestamptz;
begin
  if auth.uid() is null then
    return jsonb_build_object('ok', false, 'reason', 'not_authenticated');
  end if;
  select * into v_a from public.assignments where id = p_assignment_id;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'unknown_assignment');
  end if;
  -- Caller must be staff of the school.
  if not exists (
    select 1 from public.profiles
     where id = auth.uid()
       and school_id = v_a.school_id
       and role in ('teacher','school_organiser')
  ) then
    return jsonb_build_object('ok', false, 'reason', 'forbidden');
  end if;
  if p_status not in ('pending','done','late','missed','seen','submitted') then
    return jsonb_build_object('ok', false, 'reason', 'invalid_status');
  end if;

  select * into v_target
    from public.assignment_targets
   where assignment_id = p_assignment_id
     and student_user_id = p_student_user_id;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_target');
  end if;

  v_final := p_status;
  if p_status = 'done' then
    -- If the student's submission came in after due_at, force to 'late'.
    if exists (
      select 1 from public.assignment_submissions s
       where s.assignment_id = p_assignment_id
         and s.student_user_id = p_student_user_id
         and s.submitted_at > v_a.due_at
    ) then
      v_final := 'late';
    elsif v_target.completed_at is not null and v_target.completed_at > v_a.due_at then
      v_final := 'late';
    end if;
  end if;

  v_completed := case
    when v_final in ('done','late','seen','missed') and v_target.completed_at is not null
      then v_target.completed_at
    when v_final in ('done','late','seen','missed')
      then now()
    else null
  end;

  update public.assignment_targets
     set status       = v_final,
         completed_at = v_completed,
         updated_at   = now()
   where assignment_id = p_assignment_id
     and student_user_id = p_student_user_id;
  return jsonb_build_object('ok', true, 'status', v_final);
end;
$$;
grant execute on function public.mark_submission_done(uuid, uuid, text) to authenticated;

-- get_quiz_questions — student fetches the questions for a quiz assignment.
-- Returns inline quiz_data OR pulls mcq blocks from the linked Recall lesson.
create or replace function public.get_quiz_questions(
  p_assignment_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_a       public.assignments%rowtype;
  v_kind    text;
  v_lesson  uuid;
  v_questions jsonb;
begin
  if auth.uid() is null then
    return jsonb_build_object('ok', false, 'reason', 'not_authenticated');
  end if;
  select * into v_a from public.assignments where id = p_assignment_id;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'unknown_assignment');
  end if;
  v_kind := v_a.kind;
  if v_kind <> 'quiz' then
    return jsonb_build_object('ok', false, 'reason', 'not_a_quiz');
  end if;

  -- 1. Inline quiz data on the assignment.
  if v_a.quiz_data is not null and jsonb_typeof(v_a.quiz_data->'questions') = 'array' then
    return jsonb_build_object(
      'ok', true,
      'source', 'inline',
      'questions', v_a.quiz_data->'questions'
    );
  end if;

  -- 2. Look for a recall_lesson resource. If exactly one such resource
  --    exists, pull its mcq blocks.
  select r.ref_lesson_id into v_lesson
    from public.assignment_resources r
   where r.assignment_id = p_assignment_id
     and r.kind = 'recall_lesson'
   limit 1;
  if v_lesson is null then
    return jsonb_build_object('ok', false, 'reason', 'no_questions');
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'prompt',      b.data->>'prompt',
    'options',     b.data->'options',
    'explanation', b.data->>'explanation'
  ) order by b.order_index), '[]'::jsonb)
    into v_questions
    from public.lesson_blocks b
   where b.lesson_id = v_lesson
     and b.kind = 'mcq';
  if v_questions is null or jsonb_array_length(v_questions) = 0 then
    return jsonb_build_object('ok', false, 'reason', 'no_questions');
  end if;
  return jsonb_build_object(
    'ok', true,
    'source', 'lesson',
    'lesson_id', v_lesson,
    'questions', v_questions
  );
end;
$$;
grant execute on function public.get_quiz_questions(uuid) to authenticated;

-- grade_quiz — student submits answers, RPC scores them.
create or replace function public.grade_quiz(
  p_assignment_id uuid,
  p_answers       jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_a         public.assignments%rowtype;
  v_questions jsonb;
  v_total     int := 0;
  v_correct   int := 0;
  v_per_q     jsonb := '[]'::jsonb;
  v_idx       int;
  v_q         jsonb;
  v_ans_idx   int;
  v_ans       jsonb;
  v_picked_idx int;
  v_picked_correct boolean;
  v_score     int;
  v_result    jsonb;
begin
  if auth.uid() is null then
    return jsonb_build_object('ok', false, 'reason', 'not_authenticated');
  end if;
  select * into v_a from public.assignments where id = p_assignment_id;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'unknown_assignment');
  end if;
  if v_a.kind <> 'quiz' then
    return jsonb_build_object('ok', false, 'reason', 'not_a_quiz');
  end if;
  -- Reuse get_quiz_questions to load + validate.
  v_result := public.get_quiz_questions(p_assignment_id);
  if (v_result->>'ok')::boolean is distinct from true then
    return v_result;
  end if;
  v_questions := v_result->'questions';
  v_total := jsonb_array_length(v_questions);
  if v_total = 0 then
    return jsonb_build_object('ok', false, 'reason', 'no_questions');
  end if;

  -- Score: for each question, find the matching answer in p_answers by
  -- question index. The client sends {"0": <chosen_option_index>, ...}.
  for v_idx in 0..v_total-1 loop
    v_q := v_questions->v_idx;
    v_ans := p_answers->(v_idx::text);
    v_picked_idx := case when v_ans is null then -1 else (v_ans #>> '{}')::int end;
    v_picked_correct := false;
    if v_picked_idx >= 0 then
      select coalesce((opt->>'correct')::boolean, false) into v_picked_correct
        from jsonb_array_elements(v_q->'options') with ordinality o(opt, i)
       where i - 1 = v_picked_idx
       limit 1;
    end if;
    if v_picked_correct then
      v_correct := v_correct + 1;
    end if;
    v_per_q := v_per_q || jsonb_build_object(
      'question_index', v_idx,
      'picked',         v_picked_idx,
      'correct',        v_picked_correct
    );
  end loop;

  v_score := round((v_correct::numeric / v_total::numeric) * 100)::int;

  -- Persist the submission + mark done.
  insert into public.assignment_submissions (
    assignment_id, student_user_id, quiz_score, quiz_answers, submitted_at, updated_at
  ) values (
    p_assignment_id, auth.uid(), v_score, v_per_q, now(), now()
  )
  on conflict (assignment_id, student_user_id) do update
    set quiz_score   = excluded.quiz_score,
        quiz_answers = excluded.quiz_answers,
        submitted_at = now(),
        updated_at   = now();
  update public.assignment_targets
     set status       = 'done',
         completed_at = now(),
         updated_at   = now()
   where assignment_id = p_assignment_id
     and student_user_id = auth.uid();
  return jsonb_build_object(
    'ok', true,
    'score', v_score,
    'correct', v_correct,
    'total', v_total,
    'per_question', v_per_q
  );
end;
$$;
grant execute on function public.grade_quiz(uuid, jsonb) to authenticated;

-- ============================================================================
-- 12. STATS RPCs
-- ============================================================================

-- list_assignment_targets_with_submissions — teacher/organiser per-student view.
create or replace function public.list_assignment_targets_with_submissions(
  p_assignment_id uuid
)
returns table (
  student_user_id uuid,
  full_name       text,
  year_group      text,
  status          text,
  completed_at    timestamptz,
  submitted_at    timestamptz,
  quiz_score      int,
  has_text        boolean,
  has_file        boolean,
  is_late         boolean
)
language sql
security definer
set search_path = public
stable
as $$
  select
    t.student_user_id,
    p.full_name,
    p.year_group,
    t.status,
    t.completed_at,
    s.submitted_at,
    s.quiz_score,
    (s.text_answer is not null) as has_text,
    (s.file_path is not null)   as has_file,
    (t.status = 'late' or (t.status = 'done' and t.completed_at > a.due_at)) as is_late
  from public.assignment_targets t
  join public.assignments a on a.id = t.assignment_id
  join public.profiles p on p.id = t.student_user_id
  left join public.assignment_submissions s
    on s.assignment_id = t.assignment_id
   and s.student_user_id = t.student_user_id
  where t.assignment_id = p_assignment_id
  order by p.full_name asc;
$$;
grant execute on function public.list_assignment_targets_with_submissions(uuid) to authenticated;

-- list_quiz_wrong_questions — for the per-question stats table on a quiz.
-- Aggregates per-question wrong counts from all student submissions.
create or replace function public.list_quiz_wrong_questions(
  p_assignment_id uuid
)
returns table (
  question_index int,
  total_count    int,
  wrong_count    int
)
language sql
security definer
set search_path = public
stable
as $$
  with qs as (
    select s.quiz_answers
      from public.assignment_submissions s
     where s.assignment_id = p_assignment_id
       and s.quiz_answers is not null
  ),
  expanded as (
    select (q->>'question_index')::int as q_index,
           (q->>'correct')::boolean as is_correct
      from qs, jsonb_array_elements(qs.quiz_answers) q
  )
  select q_index as question_index,
         count(*)::int as total_count,
         count(*) filter (where not is_correct)::int as wrong_count
    from expanded
   group by q_index
   order by q_index asc;
$$;
grant execute on function public.list_quiz_wrong_questions(uuid) to authenticated;

-- get_class_summary — live per-class summary (not from rollup).
create or replace function public.get_class_summary(
  p_class_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_class   public.classes%rowtype;
  v_targets int;
  v_done    int;
  v_late    int;
  v_missed  int;
  v_pend    int;
begin
  if auth.uid() is null then
    return jsonb_build_object('ok', false, 'reason', 'not_authenticated');
  end if;
  select * into v_class from public.classes where classes.id = p_class_id;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'unknown_class');
  end if;
  if not exists (
    select 1 from public.profiles
     where id = auth.uid()
       and school_id = v_class.school_id
       and role in ('teacher','school_organiser')
  ) then
    return jsonb_build_object('ok', false, 'reason', 'forbidden');
  end if;

  select count(*) into v_targets
    from public.assignment_targets t
    join public.assignments a on a.id = t.assignment_id
    join public.class_members cm on cm.student_user_id = t.student_user_id
   where cm.class_id = p_class_id
     and a.is_template = true;
  select count(*) into v_done
    from public.assignment_targets t
    join public.assignments a on a.id = t.assignment_id
    join public.class_members cm on cm.student_user_id = t.student_user_id
   where cm.class_id = p_class_id
     and a.is_template = true
     and t.status = 'done';
  select count(*) into v_late
    from public.assignment_targets t
    join public.assignments a on a.id = t.assignment_id
    join public.class_members cm on cm.student_user_id = t.student_user_id
   where cm.class_id = p_class_id
     and a.is_template = true
     and (t.status = 'late' or (t.status = 'done' and t.completed_at > a.due_at));
  select count(*) into v_missed
    from public.assignment_targets t
    join public.assignments a on a.id = t.assignment_id
    join public.class_members cm on cm.student_user_id = t.student_user_id
   where cm.class_id = p_class_id
     and a.is_template = true
     and t.status = 'missed';
  v_pend := v_targets - v_done - v_late - v_missed;

  return jsonb_build_object(
    'ok', true,
    'class_id', p_class_id,
    'total_targets', v_targets,
    'on_time', v_done,
    'late', v_late,
    'missed', v_missed,
    'pending', v_pend
  );
end;
$$;
grant execute on function public.get_class_summary(uuid) to authenticated;

-- refresh_class_rollups — recompute the rollup row for one class.
create or replace function public.refresh_class_rollups(
  p_class_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_class   public.classes%rowtype;
  v_total_a int;
  v_total_t int;
  v_on_time int;
  v_late    int;
  v_not_sub int;
  v_subject jsonb;
  v_quiz    jsonb;
  v_not     jsonb;
begin
  if auth.uid() is null then
    return jsonb_build_object('ok', false, 'reason', 'not_authenticated');
  end if;
  select * into v_class from public.classes where classes.id = p_class_id;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'unknown_class');
  end if;
  if not exists (
    select 1 from public.profiles
     where id = auth.uid()
       and school_id = v_class.school_id
       and role in ('teacher','school_organiser')
  ) then
    return jsonb_build_object('ok', false, 'reason', 'forbidden');
  end if;

  select count(distinct a.id) into v_total_a
    from public.assignments a
    join public.assignment_targets t on t.assignment_id = a.id
    join public.class_members cm on cm.student_user_id = t.student_user_id
   where cm.class_id = p_class_id and a.is_template = true;

  select count(*) into v_total_t
    from public.assignment_targets t
    join public.assignments a on a.id = t.assignment_id
    join public.class_members cm on cm.student_user_id = t.student_user_id
   where cm.class_id = p_class_id and a.is_template = true;

  select count(*) into v_on_time
    from public.assignment_targets t
    join public.assignments a on a.id = t.assignment_id
    join public.class_members cm on cm.student_user_id = t.student_user_id
   where cm.class_id = p_class_id and a.is_template = true
     and t.status = 'done'
     and (t.completed_at is null or t.completed_at <= a.due_at);

  select count(*) into v_late
    from public.assignment_targets t
    join public.assignments a on a.id = t.assignment_id
    join public.class_members cm on cm.student_user_id = t.student_user_id
   where cm.class_id = p_class_id and a.is_template = true
     and (t.status = 'late' or (t.status = 'done' and t.completed_at > a.due_at));

  v_not_sub := v_total_t - v_on_time - v_late;

  -- Subject breakdown.
  select coalesce(jsonb_object_agg(subject_id, row_to_json(sb)), '{}'::jsonb)
    into v_subject
    from (
      select coalesce(a.subject_id::text, '_none') as subject_id,
             count(*) filter (where t.status = 'done' and (t.completed_at is null or t.completed_at <= a.due_at))::int as on_time,
             count(*) filter (where t.status = 'late' or (t.status = 'done' and t.completed_at > a.due_at))::int as late,
             count(*) filter (where t.status in ('pending','submitted'))::int as not_submitted
        from public.assignments a
        join public.assignment_targets t on t.assignment_id = a.id
        join public.class_members cm on cm.student_user_id = t.student_user_id
       where cm.class_id = p_class_id and a.is_template = true
       group by a.subject_id
    ) sb;

  -- Quiz wrong-question counts.
  select coalesce(jsonb_object_agg(assignment_id, wrong_per_q), '{}'::jsonb)
    into v_quiz
    from (
      select q.aid as assignment_id,
             jsonb_object_agg(q.q_index::text, q.wrong_count) as wrong_per_q
        from (
          select s.assignment_id as aid,
                 (qq->>'question_index')::int as q_index,
                 count(*) filter (where not ((qq->>'correct')::boolean)) as wrong_count
            from public.assignment_submissions s,
                 jsonb_array_elements(s.quiz_answers) qq
           where s.quiz_answers is not null
             and s.assignment_id in (
               select a.id from public.assignments a
                 join public.assignment_targets t on t.assignment_id = a.id
                 join public.class_members cm on cm.student_user_id = t.student_user_id
                where cm.class_id = p_class_id and a.is_template = true and a.kind = 'quiz'
             )
           group by s.assignment_id, q_index
        ) q
       group by q.aid
    ) z;

  -- Not-handed-in list.
  select coalesce(jsonb_agg(jsonb_build_object(
    'student_id',    t.student_user_id,
    'assignment_id', t.assignment_id,
    'due_at',        a.due_at,
    'title',         a.title
  ) order by a.due_at asc), '[]'::jsonb)
    into v_not
    from public.assignment_targets t
    join public.assignments a on a.id = t.assignment_id
    join public.class_members cm on cm.student_user_id = t.student_user_id
   where cm.class_id = p_class_id
     and a.is_template = true
     and t.status in ('pending','submitted');

  insert into public.class_rollups (
    class_id, total_assignments, total_targets,
    on_time_count, late_count, not_submitted_count,
    subject_breakdown, quiz_wrong_questions, not_handed_in,
    refreshed_at
  ) values (
    p_class_id, v_total_a, v_total_t,
    v_on_time, v_late, v_not_sub,
    v_subject, v_quiz, v_not,
    now()
  )
  on conflict (class_id) do update
    set total_assignments   = excluded.total_assignments,
        total_targets       = excluded.total_targets,
        on_time_count       = excluded.on_time_count,
        late_count          = excluded.late_count,
        not_submitted_count = excluded.not_submitted_count,
        subject_breakdown   = excluded.subject_breakdown,
        quiz_wrong_questions= excluded.quiz_wrong_questions,
        not_handed_in       = excluded.not_handed_in,
        refreshed_at        = now();

  return jsonb_build_object('ok', true, 'refreshed_at', now());
end;
$$;
grant execute on function public.refresh_class_rollups(uuid) to authenticated;

-- read_class_rollup — convenience for the class summary page.
create or replace function public.read_class_rollup(
  p_class_id uuid
)
returns jsonb
language sql
security definer
set search_path = public
stable
as $$
  select row_to_json(r) from public.class_rollups r where class_id = p_class_id;
$$;
grant execute on function public.read_class_rollup(uuid) to authenticated;

-- ============================================================================
-- 13. LATENESS SWEEP
-- Sets status='missed' for any target whose due_at is past the grace
-- period and is still pending or submitted. Safe to run hourly; the
-- call is a no-op if there are no rows to update.
-- ============================================================================

create or replace function public.sweep_missed_assignments()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_n int;
begin
  update public.assignment_targets
     set status     = 'missed',
         updated_at = now()
   where status in ('pending','submitted')
     and assignment_id in (
       select id from public.assignments
        where due_at < now() - interval '1 hour'
     );
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;
grant execute on function public.sweep_missed_assignments() to authenticated;

-- ============================================================================
-- 14. SCHEDULED REFRESH
-- Try to register a pg_cron job. If pg_cron isn't enabled, the call
-- silently no-ops and the next manual sweep picks up the slack.
-- ============================================================================

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    -- Sweep missed assignments every hour.
    perform cron.schedule(
      'recall-sweep-missed',
      '7 * * * *',
      $cmd$ select public.sweep_missed_assignments(); $cmd$
    );
  end if;
exception when others then
  -- pg_cron.schedule can throw if the job already exists. Swallow.
  null;
end $$;

-- ============================================================================
-- DONE.
--
-- After running this migration:
--   1. Organisers can create classes at classes.html.
--   2. Teachers/organisers can target a class in set-homework.html.
--   3. Quiz-type assignments support inline MCQs (assignments.quiz_data)
--      or pulling questions from a linked Recall lesson.
--   4. Students see type-aware action buttons in homework.html
--      (notice, quiz, text/file).
--   5. Stats are available per-assignment in assignment-detail.html
--      and per-class in class-summary.html.
--   6. The hourly sweep flips pending/submitted → missed once due_at
--      passes, if pg_cron is enabled.
-- ============================================================================
