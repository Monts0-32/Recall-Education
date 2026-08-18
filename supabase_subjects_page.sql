-- supabase_subjects_page.sql
--
-- Drives the new student-facing /subjects.html page that lets a student
-- browse the subject catalogue, pick an exam board, and walk through a
-- Duolingo-style tree of units → topics → lessons with strict linear
-- gating (must complete a lesson to unlock the next).
--
-- Adds:
--   1. public.subject_catalog         — one row per subject with a count
--                                        of published units. Read-only.
--   2. public.get_unit_tree(...)      — one row per (unit, topic, lesson)
--                                        for the chosen (subject, board,
--                                        year) triple, with the caller's
--                                        per-lesson status joined in.
--   3. public.is_lesson_unlocked(...) — boolean gate so the lock check is
--                                        enforced server-side rather than
--                                        only in the UI.
--
-- No new tables. Completion state is read from the existing
-- public.lesson_progress table; the student's "Mark complete" click in
-- lesson.html already writes there via log_lesson_session().
--
-- Run this migration in the Supabase SQL editor. It is idempotent.
-- ----------------------------------------------------------------------------

set search_path = public;

-- ============================================================================
-- 1. subject_catalog view
-- ----------------------------------------------------------------------------
-- One row per (subject.id). The catalogue page reads this directly via
-- Supabase; it lets the grid show a tile per subject with a rough
-- "how much content is there" number without N+1 queries.
--
-- published_unit_count counts the number of units that contain at least
-- one published lesson, so an empty subject doesn't show "0" by accident
-- (it shows 0, which is the correct empty state).
-- ============================================================================

create or replace view public.subject_catalog
with (security_invoker = false) as
select
  s.id            as subject_id,
  s.name,
  s.level,
  s.color_key,
  s.sort_order,
  s.exam_board,
  count(distinct u.id) filter (where exists (
    select 1
      from public.topics  t
      join public.lessons l on l.topic_id = t.id
     where t.unit_id = u.id
       and l.status      = 'published'
       and l.is_general  is false
  )) as published_unit_count
from public.subjects s
left join public.units  u on u.subject_id = s.id
group by s.id, s.name, s.level, s.color_key, s.sort_order, s.exam_board;

-- Public read. The view only exposes publishable counts (no PII).
grant select on public.subject_catalog to anon, authenticated;

comment on view public.subject_catalog is
  'One row per subject. Used by /subjects.html to render the catalogue grid.';


-- ============================================================================
-- 2. get_unit_tree(p_subject, p_board, p_year)
-- ----------------------------------------------------------------------------
-- Returns one row per (unit, topic, lesson) for the chosen triple.
-- The caller is identified by auth.uid(); per-student completion status
-- is left-joined from public.lesson_progress.
--
-- Output is ordered: unit sort_order, unit name, topic order_index,
-- lesson order_index — so the client can render straight down the page
-- in Duolingo order without re-sorting.
--
-- SECURITY DEFINER: the function reads lesson_progress on behalf of the
-- caller; auth.uid() inside the function is the caller, and we filter
-- to that user_id explicitly so the function does not need to be granted
-- table-level access beyond what the caller's RLS already permits.
-- ============================================================================

create or replace function public.get_unit_tree(
  p_subject uuid,
  p_board   uuid,
  p_year    uuid
)
returns table (
  unit_id              uuid,
  unit_name            text,
  unit_sort_order      int,
  unit_description     text,
  topic_id             uuid,
  topic_name           text,
  topic_order_index    int,
  lesson_id            uuid,
  lesson_title         text,
  lesson_order_index   int,
  lesson_duration_min  int,
  lesson_code          text,
  lesson_status        text
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
    u.id            as unit_id,
    u.name          as unit_name,
    u.sort_order    as unit_sort_order,
    u.description   as unit_description,
    t.id            as topic_id,
    t.name          as topic_name,
    t.order_index   as topic_order_index,
    l.id            as lesson_id,
    l.title         as lesson_title,
    l.order_index   as lesson_order_index,
    l.duration_min  as lesson_duration_min,
    l.code          as lesson_code,
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
  'Returns one row per (unit, topic, lesson) for the (subject, board, year) triple, with the caller lesson_progress status joined in. SECURITY DEFINER.';


-- ============================================================================
-- 3. is_lesson_unlocked(p_lesson)
-- ----------------------------------------------------------------------------
-- Strict linear gating:
--   * The first lesson of a topic (no earlier sibling in order_index) is
--     always unlocked.
--   * Every other lesson is unlocked only if the previous lesson in the
--     same topic (the row with the largest order_index < the current's)
--     has lesson_progress.status = 'completed' for the caller.
--   * General lessons (topic_id IS NULL) and any lesson the caller has
--     not yet reached are reported as locked.
--
-- The function runs as SECURITY DEFINER but is read-only-by-construction:
-- it only reads its own arguments and the lesson_progress table for the
-- caller's auth.uid(). It explicitly returns false when no session is
-- attached so it can be safely called from a logged-out page guard.
-- ============================================================================

create or replace function public.is_lesson_unlocked(p_lesson uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid          uuid := auth.uid();
  v_topic_id     uuid;
  v_order_index  int;
  v_prev_id      uuid;
  v_prev_status  text;
begin
  if v_uid is null then
    return false;
  end if;

  -- Resolve the lesson's topic + order. General lessons are never inside
  -- a subject tree, so they are always locked from this control surface.
  select l.topic_id, l.order_index
    into v_topic_id, v_order_index
  from public.lessons l
  where l.id = p_lesson
    and l.is_general is false;

  if v_topic_id is null then
    return false;
  end if;

  -- Find the immediately preceding lesson in the same topic.
  select l2.id
    into v_prev_id
  from public.lessons l2
  where l2.topic_id    = v_topic_id
    and l2.order_index < v_order_index
    and l2.status      = 'published'
  order by l2.order_index desc
  limit 1;

  -- No predecessor → first lesson of the topic is unlocked.
  if v_prev_id is null then
    return true;
  end if;

  -- Predecessor exists; require it to be marked completed.
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
  'Strict linear gate: returns true iff the caller has completed the previous lesson in the same topic. SECURITY DEFINER.';


-- ============================================================================
-- 4. Helper: boards for a subject
-- ----------------------------------------------------------------------------
-- Used by the exam-board picker. Distinct exam boards that have at least
-- one unit on the given subject, with the count of distinct year_levels
-- covered. Defined here so the client can call it via supabase.rpc().
-- ============================================================================

create or replace function public.boards_for_subject(p_subject uuid)
returns table (
  board_id    uuid,
  board_name  text,
  unit_count  bigint,
  year_count  bigint
)
language sql
stable
security definer
set search_path = public
as $$
  select
    b.id                              as board_id,
    b.name                            as board_name,
    count(distinct u.id)::bigint      as unit_count,
    count(distinct u.year_id)::bigint as year_count
  from public.exam_boards b
  join public.units u on u.exam_board_id = b.id
  where u.subject_id = p_subject
  group by b.id, b.name
  order by b.name;
$$;

grant execute on function public.boards_for_subject(uuid) to authenticated;

comment on function public.boards_for_subject(uuid) is
  'Distinct exam boards that have at least one unit on the given subject, with unit and year counts.';


-- ============================================================================
-- 5. Helper: years for (subject, board)
-- ----------------------------------------------------------------------------
-- Used by the tree page to auto-pick the right year_levels row from
-- profiles.year_group. Returns the year_levels rows that have a unit
-- for the given (subject, board) pair, ordered by year_levels.sort_order.
-- ============================================================================

create or replace function public.years_for_subject_board(
  p_subject uuid,
  p_board   uuid
)
returns table (
  year_id   uuid,
  year_label text,
  year_sort_order int
)
language sql
stable
security definer
set search_path = public
as $$
  select
    yl.id          as year_id,
    yl.label       as year_label,
    yl.sort_order  as year_sort_order
  from public.year_levels yl
  join public.units u on u.year_id = yl.id
  where u.subject_id    = p_subject
    and u.exam_board_id = p_board
  group by yl.id, yl.label, yl.sort_order
  order by yl.sort_order;
$$;

grant execute on function public.years_for_subject_board(uuid, uuid) to authenticated;

comment on function public.years_for_subject_board(uuid, uuid) is
  'Distinct year_levels rows that have a unit for the given (subject, board) pair.';
