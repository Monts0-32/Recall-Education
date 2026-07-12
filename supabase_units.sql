-- ============================================================================
-- Recall Education — Units, exam boards, and year levels migration
-- Run this AFTER supabase_setup.sql, supabase_tables.sql, supabase_staff.sql,
-- supabase_uploads.sql, supabase_consent_enforcement.sql, supabase_dashboard.sql,
-- and supabase_admin.sql. Idempotent: safe to re-run.
--
-- What this does:
--   1. Adds three new catalogue tables: exam_boards, year_levels, units.
--   2. Adds topics.unit_id so topics can be grouped into units.
--   3. Seeds the 7 UK exam boards and 7 year levels.
--   4. Backfills a "Curriculum" unit for every (subject, board, year) triple
--      and points any pre-existing topics at their matching unit.
--   5. Defines 11 SECURITY DEFINER RPCs for CRUD + a "list with boards"
--      helper used by staff.html's card grid.
--   6. Updates the subject_progress view to include unit context.
--   7. RLS: public read on the new tables, staff writes through RPCs only.
-- ============================================================================

-- ---------- 1. EXAM_BOARDS TABLE ------------------------------------------

create table if not exists public.exam_boards (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique,
  country     text not null default 'UK'
              check (country in ('UK', 'IE', 'INT')),
  created_at  timestamptz not null default now()
);
create index if not exists exam_boards_name_idx on public.exam_boards (name);

-- ---------- 2. YEAR_LEVELS TABLE ------------------------------------------
-- One row per year group. UK uses Year 7..13; we expose GCSE + A-level as
-- their own rows too so a unit can be marked "GCSE Biology" without
-- committing to a specific year.

create table if not exists public.year_levels (
  id          uuid primary key default gen_random_uuid(),
  label       text not null unique,   -- e.g. 'Year 10', 'GCSE', 'A-level'
  sort_order  int  not null default 0,
  created_at  timestamptz not null default now()
);

-- ---------- 3. UNITS TABLE ------------------------------------------------

create table if not exists public.units (
  id            uuid primary key default gen_random_uuid(),
  subject_id    uuid not null references public.subjects(id) on delete cascade,
  exam_board_id uuid not null references public.exam_boards(id) on delete cascade,
  year_id       uuid not null references public.year_levels(id) on delete cascade,
  name          text not null,
  description   text,
  sort_order    int  not null default 0,
  created_at    timestamptz not null default now(),
  unique (subject_id, exam_board_id, year_id, name)
);
create index if not exists units_subject_idx on public.units (subject_id);
create index if not exists units_subject_board_year_idx
  on public.units (subject_id, exam_board_id, year_id);

-- ---------- 4. TOPICS.UNIT_ID ---------------------------------------------
-- Nullable so existing topics (which were created before units existed)
-- keep working. They get backfilled to a real unit below.

alter table public.topics
  add column if not exists unit_id uuid references public.units(id) on delete set null;
create index if not exists topics_unit_idx on public.topics (unit_id);

-- ---------- 5. SEED BOARDS + YEARS ----------------------------------------

insert into public.exam_boards (name, country) values
  ('AQA',       'UK'),
  ('OCR',       'UK'),
  ('Edexcel',   'UK'),
  ('WJEC',      'UK'),
  ('CCEA',      'UK'),
  ('SQA',       'UK'),
  ('Cambridge', 'INT')
on conflict (name) do nothing;

insert into public.year_levels (label, sort_order) values
  ('Year 7',   7),
  ('Year 8',   8),
  ('Year 9',   9),
  ('Year 10', 10),
  ('Year 11', 11),  -- GCSE year
  ('Year 12', 12),  -- A-level year 1
  ('Year 13', 13),  -- A-level year 2
  ('GCSE',     20),
  ('A-level',  21)
on conflict (label) do nothing;

-- ---------- 6. BACKFILL UNITS FOR SEEDED SUBJECTS --------------------------
-- The seed in supabase_tables.sql creates 8 subjects, each with a single
-- exam_board and level. For every (subject, board, year) triple we want
-- a unit, we create a default "Curriculum" unit. Then we point any
-- pre-existing topics at the matching unit by looking up
-- (subject.name, subject.exam_board) and using Year 10/Year 12 depending
-- on level (GCSE -> Year 10, A-level -> Year 12).
--
-- Idempotent: re-running inserts nothing because the unique constraint
-- blocks duplicate (subject, board, year, name) triples.

do $$
declare
  v_unit_id uuid;
  v_subject record;
  v_year_id uuid;
  v_board_id uuid;
  v_topic record;
begin
  for v_subject in
    select s.id, s.name, s.exam_board, s.level
      from public.subjects s
  loop
    select id into v_board_id
      from public.exam_boards
     where name = v_subject.exam_board;
    continue when v_board_id is null;

    -- Pick Year 10 for GCSE, Year 12 for A-level.
    select id into v_year_id
      from public.year_levels
     where label = case when v_subject.level = 'gcse' then 'Year 10' else 'Year 12' end;
    continue when v_year_id is null;

    insert into public.units (subject_id, exam_board_id, year_id, name, sort_order)
    values (v_subject.id, v_board_id, v_year_id, 'Curriculum', 0)
    on conflict (subject_id, exam_board_id, year_id, name) do nothing
    returning id into v_unit_id;

    if v_unit_id is null then
      select id into v_unit_id
        from public.units
       where subject_id = v_subject.id
         and exam_board_id = v_board_id
         and year_id = v_year_id
         and name = 'Curriculum';
    end if;

    -- Point any orphan topics for this subject at the new unit.
    if v_unit_id is not null then
      update public.topics
         set unit_id = v_unit_id
       where subject_id = v_subject.id
         and unit_id is null;
    end if;
  end loop;
end $$;

-- ---------- 7. SUBJECT_PROGRESS VIEW UPDATE -------------------------------
-- Add unit_id / unit_name so future student-side views can group
-- progress by unit. (The student player is out of scope for this
-- migration, but having the data in the view means we don't need
-- another migration when we wire it up.)

drop view if exists public.subject_progress;
create view public.subject_progress as
select
  e.user_id,
  e.subject_id,
  s.name          as subject_name,
  s.exam_board,
  s.level,
  s.color_key,
  t.unit_id,
  u.name          as unit_name,
  count(l.id)                                         as total_lessons,
  count(lp.id) filter (where lp.status = 'completed')  as completed_lessons,
  case
    when count(l.id) = 0 then 0
    else round(
      100.0 * count(lp.id) filter (where lp.status = 'completed')::numeric
            / count(l.id)::numeric
    )::int
  end as pct
from public.enrollments e
join public.subjects   s  on s.id = e.subject_id
left join public.topics     t  on t.subject_id = s.id
left join public.units      u  on u.id = t.unit_id
left join public.lessons    l  on l.topic_id  = t.id
left join public.lesson_progress lp
       on lp.lesson_id = l.id and lp.user_id = e.user_id
group by e.user_id, e.subject_id, s.name, s.exam_board, s.level, s.color_key,
         t.unit_id, u.name;

grant select on public.subject_progress to anon, authenticated;

-- ============================================================================
-- 8. RLS
-- ============================================================================

alter table public.exam_boards enable row level security;
alter table public.year_levels enable row level security;
alter table public.units       enable row level security;

-- Public read on all three (the catalogue is not sensitive).
drop policy if exists "exam_boards_read_all" on public.exam_boards;
create policy "exam_boards_read_all" on public.exam_boards for select
  to anon, authenticated using (true);

drop policy if exists "year_levels_read_all" on public.year_levels;
create policy "year_levels_read_all" on public.year_levels for select
  to anon, authenticated using (true);

drop policy if exists "units_read_all" on public.units;
create policy "units_read_all" on public.units for select
  to anon, authenticated using (true);

-- Writes happen through SECURITY DEFINER RPCs. There are no client-side
-- write policies on these tables, so a malicious anon / authenticated
-- user cannot insert or modify rows directly.

-- ============================================================================
-- 9. RPCs
-- ============================================================================
-- All SECURITY DEFINER, all set search_path = public, all granted to
-- authenticated. Mutations write a staff_audit_log row through the
-- existing _log_staff_action helper from supabase_admin.sql.

-- ---------- 9a. Helper: assert caller is staff ----------------------------

create or replace function public._assert_staff_any()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1 from public.profiles
     where id = auth.uid()
       and role in ('staff_author', 'staff_reviewer', 'admin')
  ) then
    raise exception 'staff role required' using errcode = '42501';
  end if;
end;
$$;

create or replace function public._assert_admin()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1 from public.profiles
     where id = auth.uid() and role = 'admin'
  ) then
    raise exception 'admin role required' using errcode = '42501';
  end if;
end;
$$;

grant execute on function public._assert_staff_any() to authenticated;
grant execute on function public._assert_admin()     to authenticated;

-- ---------- 9b. Exam-board CRUD (admin only) -----------------------------

create or replace function public.create_exam_board(p_name text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_clean text := trim(coalesce(p_name, ''));
begin
  perform public._assert_admin();
  if v_clean = '' then
    raise exception 'name is required';
  end if;
  insert into public.exam_boards (name) values (v_clean)
    on conflict (name) do update set name = excluded.name
    returning id into v_id;
  perform public._log_staff_action(
    'admin_action', 'exam_board', v_id,
    jsonb_build_object('op', 'create', 'name', v_clean)
  );
  return v_id;
end;
$$;

create or replace function public.rename_exam_board(p_id uuid, p_name text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare v_clean text := trim(coalesce(p_name, ''));
begin
  perform public._assert_admin();
  if v_clean = '' then raise exception 'name is required'; end if;
  update public.exam_boards set name = v_clean where id = p_id;
  if not found then raise exception 'exam_board not found'; end if;
  perform public._log_staff_action(
    'admin_action', 'exam_board', p_id,
    jsonb_build_object('op', 'rename', 'name', v_clean)
  );
end;
$$;

create or replace function public.delete_exam_board(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public._assert_admin();
  delete from public.exam_boards where id = p_id;
  if not found then raise exception 'exam_board not found'; end if;
  perform public._log_staff_action(
    'admin_action', 'exam_board', p_id,
    jsonb_build_object('op', 'delete')
  );
end;
$$;

grant execute on function public.create_exam_board(text)            to authenticated;
grant execute on function public.rename_exam_board(uuid, text)      to authenticated;
grant execute on function public.delete_exam_board(uuid)            to authenticated;

-- ---------- 9c. Year-level CRUD (admin only) -----------------------------

create or replace function public.create_year(p_label text, p_sort_order int default null)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_clean text := trim(coalesce(p_label, ''));
  v_order int;
begin
  perform public._assert_admin();
  if v_clean = '' then raise exception 'label is required'; end if;
  v_order := coalesce(p_sort_order,
    (select coalesce(max(sort_order), 0) + 1 from public.year_levels));
  insert into public.year_levels (label, sort_order) values (v_clean, v_order)
    on conflict (label) do update set sort_order = excluded.sort_order
    returning id into v_id;
  perform public._log_staff_action(
    'admin_action', 'year_level', v_id,
    jsonb_build_object('op', 'create', 'label', v_clean, 'sort_order', v_order)
  );
  return v_id;
end;
$$;

create or replace function public.rename_year(p_id uuid, p_label text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare v_clean text := trim(coalesce(p_label, ''));
begin
  perform public._assert_admin();
  if v_clean = '' then raise exception 'label is required'; end if;
  update public.year_levels set label = v_clean where id = p_id;
  if not found then raise exception 'year_level not found'; end if;
  perform public._log_staff_action(
    'admin_action', 'year_level', p_id,
    jsonb_build_object('op', 'rename', 'label', v_clean)
  );
end;
$$;

create or replace function public.delete_year(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public._assert_admin();
  delete from public.year_levels where id = p_id;
  if not found then raise exception 'year_level not found'; end if;
  perform public._log_staff_action(
    'admin_action', 'year_level', p_id,
    jsonb_build_object('op', 'delete')
  );
end;
$$;

grant execute on function public.create_year(text, int)      to authenticated;
grant execute on function public.rename_year(uuid, text)     to authenticated;
grant execute on function public.delete_year(uuid)           to authenticated;

-- ---------- 9d. Unit CRUD (any staff role) -------------------------------

create or replace function public.create_unit(
  p_subject_id    uuid,
  p_exam_board_id uuid,
  p_year_id       uuid,
  p_name          text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_clean text := trim(coalesce(p_name, ''));
begin
  perform public._assert_staff_any();
  if v_clean = '' then raise exception 'name is required'; end if;
  insert into public.units (subject_id, exam_board_id, year_id, name)
  values (p_subject_id, p_exam_board_id, p_year_id, v_clean)
  on conflict (subject_id, exam_board_id, year_id, name) do nothing
  returning id into v_id;
  if v_id is null then
    select id into v_id from public.units
     where subject_id = p_subject_id
       and exam_board_id = p_exam_board_id
       and year_id = p_year_id
       and name = v_clean;
  end if;
  perform public._log_staff_action(
    'admin_action', 'unit', v_id,
    jsonb_build_object('op', 'create', 'name', v_clean,
                       'subject_id', p_subject_id,
                       'exam_board_id', p_exam_board_id,
                       'year_id', p_year_id)
  );
  return v_id;
end;
$$;

create or replace function public.rename_unit(p_id uuid, p_name text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare v_clean text := trim(coalesce(p_name, ''));
begin
  perform public._assert_staff_any();
  if v_clean = '' then raise exception 'name is required'; end if;
  update public.units set name = v_clean where id = p_id;
  if not found then raise exception 'unit not found'; end if;
  perform public._log_staff_action(
    'admin_action', 'unit', p_id,
    jsonb_build_object('op', 'rename', 'name', v_clean)
  );
end;
$$;

create or replace function public.delete_unit(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public._assert_staff_any();
  -- Detach topics first so they don't cascade-delete. They become
  -- orphans (unit_id = null) and remain visible at the year level
  -- for the author to re-attach.
  update public.topics set unit_id = null where unit_id = p_id;
  delete from public.units where id = p_id;
  if not found then raise exception 'unit not found'; end if;
  perform public._log_staff_action(
    'admin_action', 'unit', p_id,
    jsonb_build_object('op', 'delete')
  );
end;
$$;

create or replace function public.move_topic_to_unit(p_topic_id uuid, p_unit_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_topic record;
  v_unit  record;
begin
  perform public._assert_staff_any();
  select id, subject_id into v_topic from public.topics where id = p_topic_id;
  if not found then raise exception 'topic not found'; end if;
  if p_unit_id is not null then
    select id, subject_id into v_unit from public.units where id = p_unit_id;
    if not found then raise exception 'unit not found'; end if;
    if v_unit.subject_id <> v_topic.subject_id then
      raise exception 'unit and topic must be in the same subject';
    end if;
  end if;
  update public.topics set unit_id = p_unit_id where id = p_topic_id;
  perform public._log_staff_action(
    'admin_action', 'topic', p_topic_id,
    jsonb_build_object('op', 'move_topic_to_unit', 'unit_id', p_unit_id)
  );
end;
$$;

grant execute on function public.create_unit(uuid, uuid, uuid, text)  to authenticated;
grant execute on function public.rename_unit(uuid, text)             to authenticated;
grant execute on function public.delete_unit(uuid)                   to authenticated;
grant execute on function public.move_topic_to_unit(uuid, uuid)      to authenticated;

-- ---------- 9e. List helper for the staff.html card grid ----------------

-- Returns subject rows plus a denormalised list of (board, year) pairs
-- that have at least one unit for the subject. Used by staff.html to
-- know which board/year cards to show.
create or replace function public.list_subjects_with_boards()
returns table (
  subject_id    uuid,
  subject_name  text,
  color_key     text,
  exam_board    text,
  level         text,
  exam_board_id uuid,
  year_id       uuid,
  year_label    text,
  unit_count    bigint
)
language sql
security definer
set search_path = public
stable
as $$
  select
    s.id, s.name, s.color_key, s.exam_board, s.level,
    eb.id, yl.id, yl.label,
    count(u.id) as unit_count
  from public.subjects s
  join public.exam_boards eb on eb.name = s.exam_board
  join public.units u on u.subject_id = s.id and u.exam_board_id = eb.id
  join public.year_levels yl on yl.id = u.year_id
  group by s.id, s.name, s.color_key, s.exam_board, s.level,
           eb.id, yl.id, yl.label
  order by s.sort_order, s.name, yl.sort_order;
$$;

grant execute on function public.list_subjects_with_boards() to authenticated;

-- A second helper used at the year level: list the units for one
-- (subject, board, year) triple. Comes back with topic_count +
-- lesson_count for the card metadata line.
create or replace function public.list_units(
  p_subject_id    uuid,
  p_exam_board_id uuid,
  p_year_id       uuid
)
returns table (
  id            uuid,
  name          text,
  description   text,
  sort_order    int,
  topic_count   bigint,
  lesson_count  bigint
)
language sql
security definer
set search_path = public
stable
as $$
  select
    u.id, u.name, u.description, u.sort_order,
    count(distinct t.id) as topic_count,
    count(distinct l.id) as lesson_count
  from public.units u
  left join public.topics  t on t.unit_id = u.id
  left join public.lessons l on l.topic_id = t.id
  where u.subject_id    = p_subject_id
    and u.exam_board_id = p_exam_board_id
    and u.year_id       = p_year_id
  group by u.id, u.name, u.description, u.sort_order
  order by u.sort_order, u.name;
$$;

grant execute on function public.list_units(uuid, uuid, uuid) to authenticated;

-- Years that have at least one unit for a given (subject, board).
create or replace function public.list_years_for_board(
  p_subject_id    uuid,
  p_exam_board_id uuid
)
returns table (
  year_id        uuid,
  year_label     text,
  sort_order     int,
  unit_count     bigint
)
language sql
security definer
set search_path = public
stable
as $$
  select yl.id, yl.label, yl.sort_order, count(u.id)
  from public.year_levels yl
  join public.units u on u.year_id = yl.id
  where u.subject_id    = p_subject_id
    and u.exam_board_id = p_exam_board_id
  group by yl.id, yl.label, yl.sort_order
  order by yl.sort_order;
$$;

grant execute on function public.list_years_for_board(uuid, uuid) to authenticated;

-- ============================================================================
-- DONE. After running this:
--   1. staff.html can switch from the old collapsible tree to the new
--      card grid (Subject → Board → Year → Unit).
--   2. All existing topics are attached to a "Curriculum" unit under
--      the right (subject, board, year) so nothing is orphaned.
--   3. The admin console's audit log shows every unit/board/year
--      change as an 'admin_action' row with op metadata.
-- ============================================================================
