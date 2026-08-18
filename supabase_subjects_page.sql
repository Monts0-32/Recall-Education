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
