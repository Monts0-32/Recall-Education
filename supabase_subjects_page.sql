-- supabase_subjects_page.sql
--
-- New SQL for the student-facing /subjects.html page. Run in the
-- Supabase SQL editor. Idempotent.
--
-- Adds three RPCs the page calls (no view, no client-side joins):
--   1. public.list_subjects_published()            — one row per (subject,
--                                                    board) pair with at
--                                                    least one published
--                                                    unit. Used by the
--                                                    catalogue grid.
--   2. public.get_unit_tree(subject, board, year)  — one row per (unit,
--                                                    topic, lesson) for
--                                                    the chosen triple,
--                                                    with the caller's
--                                                    per-lesson status
--                                                    joined in. Used by
--                                                    the tree.
--   3. public.is_lesson_unlocked(lesson)          — server-side gate so
--                                                    the linear lock can't
--                                                    be bypassed by
--                                                    hand-crafted URLs.
--                                                    Used by the tree.
--
-- No new tables. Completion state is read from public.lesson_progress,
-- which lesson.html already writes via log_lesson_session.

set search_path = public;

-- ============================================================================
-- 1) list_subjects_published()
-- ----------------------------------------------------------------------------
-- One row per (subject.name, subject.exam_board) pair that has at least
-- one published lesson. The grid renders one tile per pair; the board
-- picker step splits each pair into the per-board picks.
--
-- Sorted by subjects.sort_order, then subjects.name, then the board's
-- name. RLS on the underlying tables still applies to the SECURITY
-- INVOKER function — anon callers only see published rows because the
-- function filters on lessons.status = 'published'.
-- ============================================================================

create or replace function public.list_subjects_published()
returns table (
  subject_id      uuid,
  name            text,
  level           text,
  exam_board      text,
  color_key       text,
  published_count bigint
)
language sql
stable
security invoker
set search_path = public
as $$
  select
    s.id            as subject_id,
    s.name          as name,
    s.level         as level,
    s.exam_board    as exam_board,
    s.color_key     as color_key,
    count(distinct l.id) as published_count
  from public.subjects s
  join public.units  u on u.subject_id = s.id
  join public.topics t on t.unit_id   = u.id
  join public.lessons l on l.topic_id = t.id
  where l.status     = 'published'
    and l.is_general is false
  group by s.id, s.name, s.level, s.exam_board, s.color_key, s.sort_order
  order by s.sort_order, s.name, s.exam_board;
$$;

grant execute on function public.list_subjects_published() to authenticated;

comment on function public.list_subjects_published() is
  'Catalogue of subjects with at least one published lesson. Used by /subjects.html.';

-- ============================================================================
-- 2) get_unit_tree(subject, board, year)
-- ----------------------------------------------------------------------------
-- One row per (unit, topic, lesson) for the chosen triple, joined with
-- the caller's lesson_progress.status. Ordered for direct rendering.
-- ============================================================================

create or replace function public.get_unit_tree(
  p_subject uuid,
  p_board   uuid,
  p_year    uuid
)
returns table (
  unit_id             uuid,
  unit_name           text,
  unit_sort_order     int,
  unit_description    text,
  topic_id            uuid,
  topic_name          text,
  topic_order_index   int,
  lesson_id           uuid,
  lesson_title        text,
  lesson_order_index  int,
  lesson_duration_min int,
  lesson_code         text,
  lesson_status       text
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  return query
  select
    u.id           as unit_id,
    u.name         as unit_name,
    u.sort_order   as unit_sort_order,
    u.description  as unit_description,
    t.id           as topic_id,
    t.name         as topic_name,
    t.order_index  as topic_order_index,
    l.id           as lesson_id,
    l.title        as lesson_title,
    l.order_index  as lesson_order_index,
    l.duration_min as lesson_duration_min,
    l.code         as lesson_code,
    coalesce(lp.status, 'not_started')::text as lesson_status
  from public.units u
  join public.topics  t on t.unit_id = u.id
  join public.lessons l on l.topic_id = t.id
  left join public.lesson_progress lp
         on lp.lesson_id = l.id
        and lp.user_id   = v_uid
  where u.subject_id    = p_subject
    and u.exam_board_id = p_board
    and u.year_id       = p_year
    and l.status        = 'published'
    and l.is_general    is false
  order by
    u.sort_order,
    u.name,
    t.order_index,
    l.order_index;
end;
$$;

grant execute on function public.get_unit_tree(uuid, uuid, uuid) to authenticated;

comment on function public.get_unit_tree(uuid, uuid, uuid) is
  'Tree rows for the (subject, board, year) triple, with caller lesson_progress status joined in.';

-- ============================================================================
-- 3) is_lesson_unlocked(lesson)
-- ----------------------------------------------------------------------------
-- Strict linear gate. Returns true iff the caller has completed the
-- previous lesson in the same topic. Used by the tree to render the
-- lock icon. SECURITY DEFINER so the gate is enforced server-side.
-- ============================================================================

create or replace function public.is_lesson_unlocked(p_lesson uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid         uuid := auth.uid();
  v_topic_id    uuid;
  v_order_index int;
  v_prev_id     uuid;
  v_prev_status text;
begin
  if v_uid is null then
    return false;
  end if;

  select l.topic_id, l.order_index
    into v_topic_id, v_order_index
  from public.lessons l
  where l.id = p_lesson
    and l.is_general is false;

  if v_topic_id is null then
    return false;
  end if;

  select l2.id
    into v_prev_id
  from public.lessons l2
  where l2.topic_id    = v_topic_id
    and l2.order_index < v_order_index
    and l2.status      = 'published'
  order by l2.order_index desc
  limit 1;

  if v_prev_id is null then
    return true;
  end if;

  select lp.status
    into v_prev_status
  from public.lesson_progress lp
  where lp.lesson_id = v_prev_id
    and lp.user_id   = v_uid;

  return v_prev_status = 'completed';
end;
$$;

grant execute on function public.is_lesson_unlocked(uuid) to authenticated;

comment on function public.is_lesson_unlocked(uuid) is
  'Strict linear gate. True iff the caller completed the prior lesson in the topic.';

-- ============================================================================
-- 4) list_boards_for_subject(subject)
-- ----------------------------------------------------------------------------
-- Returns every board attached to a subject (Curriculum base + any custom
-- exam boards + any non-exam-board courses), regardless of whether they
-- have published lessons yet. The student page uses this for the board
-- picker so they always see Curriculum alongside AQA/OCR/etc.
--
-- Sorted: Curriculum first, then exam boards, then courses, then by name.
-- ============================================================================

create or replace function public.list_boards_for_subject(p_subject uuid)
returns table (
  board_id     uuid,
  name         text,
  kind         text,
  lesson_count bigint
)
language sql
stable
security invoker
set search_path = public
as $$
  select
    b.id  as board_id,
    b.name as name,
    b.kind as kind,
    (
      select count(distinct l.id)
        from public.units u
        join public.topics t on t.unit_id = u.id
        join public.lessons l on l.topic_id = t.id
       where u.subject_id    = p_subject
         and u.exam_board_id = b.id
         and l.status        = 'published'
         and l.is_general    is false
    ) as lesson_count
  from public.exam_boards b
  join public.subject_boards sb on sb.exam_board_id = b.id
  where sb.subject_id = p_subject
  order by
    case b.kind when 'curriculum' then 0 when 'exam_board' then 1 else 2 end,
    b.name;
$$;

grant execute on function public.list_boards_for_subject(uuid) to authenticated;

comment on function public.list_boards_for_subject(uuid) is
  'All boards attached to a subject, with kind and lesson_count. Used by /subjects.html board picker.';

-- ============================================================================
-- 5) list_years_for_subject_board(subject, board)
-- ----------------------------------------------------------------------------
-- Returns the years that have units for the (subject, board) pair, sorted
-- by year_levels.sort_order. The Curriculum board returns Year 7/8/9; a
-- GCSE exam board returns Year 10/11; etc. The student page uses this for
-- the year picker after a board is chosen.
-- ============================================================================

create or replace function public.list_years_for_subject_board(
  p_subject uuid,
  p_board   uuid
)
returns table (
  year_id    uuid,
  label      text,
  sort_order int,
  unit_count bigint
)
language sql
stable
security invoker
set search_path = public
as $$
  select
    y.id       as year_id,
    y.label    as label,
    y.sort_order as sort_order,
    (
      select count(*) from public.units u
       where u.subject_id    = p_subject
         and u.exam_board_id = p_board
         and u.year_id       = y.id
    ) as unit_count
  from public.year_levels y
  where exists (
    select 1 from public.units u
     where u.subject_id    = p_subject
       and u.exam_board_id = p_board
       and u.year_id       = y.id
  )
  order by y.sort_order;
$$;

grant execute on function public.list_years_for_subject_board(uuid, uuid) to authenticated;

comment on function public.list_years_for_subject_board(uuid, uuid) is
  'Years that have units for (subject, board). Used by /subjects.html year picker.';

-- ============================================================================
-- 6) create_board_for_subject(subject, name, kind, years[])
-- ----------------------------------------------------------------------------
-- Author/admin RPC used by lesson-creator.html's "+ Board" modal.
-- Atomically:
--   1. upserts the exam_boards row (kind set on conflict);
--   2. links it to the subject via subject_boards;
--   3. computes the year list:
--        - 'curriculum'  → ['Year 7','Year 8','Year 9']
--        - 'exam_board'  → GCSE → ['Year 10','Year 11']; A-level → ['Year 12','Year 13']
--        - 'course'      → uses the caller-supplied p_years (Year 7..13)
--   4. for each year, ensures a year_levels row and a 'Curriculum' anchoring
--      unit for the (subject, board, year) triple.
-- Returns the exam_board.id of the (possibly new) board.
--
-- SECURITY DEFINER so the board/board-link/year writes bypass RLS, but the
-- function still checks the caller is an admin via public.profiles.role.
-- ============================================================================

drop function if exists public.create_board_for_subject(uuid, text, text, text[]);

create or replace function public.create_board_for_subject(
  p_subject uuid,
  p_name    text,
  p_kind    text,
  p_years   text[] default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid       uuid := auth.uid();
  v_is_admin  boolean;
  v_board_id  uuid;
  v_subject_level text;
  v_year_label text;
  v_year_id   uuid;
  v_year_sort int;
begin
  -- Admin gate. Non-admins get a clean 42501.
  select (role = 'admin') into v_is_admin
    from public.profiles
   where id = v_uid;
  if v_uid is null or v_is_admin is null or v_is_admin = false then
    raise exception 'admin only' using errcode = '42501';
  end if;

  if p_kind not in ('exam_board', 'course', 'curriculum') then
    raise exception 'invalid kind: %', p_kind
      using errcode = '22023';
  end if;

  if p_name is null or length(trim(p_name)) = 0 then
    raise exception 'board name is required' using errcode = '22023';
  end if;

  -- 1) Upsert the board row. On conflict, also update kind so an existing
  --    global board (e.g. AQA) can be re-categorised if needed.
  insert into public.exam_boards (name, country, kind)
    values (trim(p_name), 'UK', p_kind)
  on conflict (name) do update set kind = excluded.kind
  returning id into v_board_id;

  -- 2) Link subject <-> board.
  insert into public.subject_boards (subject_id, exam_board_id)
    values (p_subject, v_board_id)
  on conflict do nothing;

  -- 3) Compute year list.
  if p_kind = 'curriculum' then
    p_years := array['Year 7', 'Year 8', 'Year 9'];
  elsif p_kind = 'exam_board' then
    select level into v_subject_level from public.subjects where id = p_subject;
    if v_subject_level = 'gcse' then
      p_years := array['Year 10', 'Year 11'];
    elsif v_subject_level = 'a-level' then
      p_years := array['Year 12', 'Year 13'];
    else
      -- Unknown subject level — fall back to GCSE years; the author can
      -- still create a 'course' if they want a different range.
      p_years := array['Year 10', 'Year 11'];
    end if;
  end if;
  -- 'course' keeps p_years as the caller passed them.

  if p_years is null or array_length(p_years, 1) is null then
    raise exception 'no years resolved for board kind %', p_kind
      using errcode = '22023';
  end if;

  -- 4) For each year: ensure year_levels row + anchoring 'Curriculum' unit.
  foreach v_year_label in array p_years loop
    select id into v_year_id
      from public.year_levels
     where label = v_year_label;

    if v_year_id is null then
      v_year_sort := case v_year_label
        when 'Year 7'  then 7
        when 'Year 8'  then 8
        when 'Year 9'  then 9
        when 'Year 10' then 10
        when 'Year 11' then 11
        when 'Year 12' then 12
        when 'Year 13' then 13
        else 99
      end;
      insert into public.year_levels (label, sort_order)
        values (v_year_label, v_year_sort)
      returning id into v_year_id;
    end if;

    insert into public.units (subject_id, exam_board_id, year_id, name, sort_order)
      values (p_subject, v_board_id, v_year_id, 'Curriculum', 0)
    on conflict (subject_id, exam_board_id, year_id, name) do nothing;
  end loop;

  return v_board_id;
end;
$$;

grant execute on function public.create_board_for_subject(uuid, text, text, text[])
  to authenticated;

comment on function public.create_board_for_subject(uuid, text, text, text[]) is
  'Create a board for a subject with auto-generated years. '
  'kind=curriculum -> Years 7,8,9; kind=exam_board -> GCSE Years 10+11 / A-level Years 12+13; '
  'kind=course -> caller-supplied years (7-13). Admin only.';
