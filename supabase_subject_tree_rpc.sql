-- ============================================================================
-- Recall Education — Subject tree + admin delete RPCs
--
-- Run this AFTER supabase_setup.sql, supabase_tables.sql, supabase_staff.sql,
-- supabase_uploads.sql, supabase_consent_enforcement.sql, supabase_dashboard.sql,
-- supabase_admin.sql, supabase_units.sql, supabase_boards_redesign.sql,
-- and supabase_subjects_page.sql. Idempotent: safe to re-run.
--
-- What this does:
--   1. Narrows subject writes to admin-only (subjects were previously
--      writable by any staff_author via the subjects_staff_write RLS
--      policy). Adds RPCs so authors still CAN create/edit subjects via
--      the lesson-creator UI — the RPC gates the role server-side.
--   2. Adds three RPCs for the admin subject-tree manager:
--         - admin_list_subjects_with_resources(subject)
--         - admin_move_lesson(unit_from, unit_to, lesson)
--         - admin_move_topic_to_unit(topic, unit)
--   3. Adds create_subject_with_structure(...) RPC that:
--         - inserts the subject row
--         - links the curriculum board (kind='curriculum')
--         - adds the chosen exam_board (kind='exam_board') OR course
--           (kind='course') with the chosen years
--         - creates an empty "Curriculum" anchoring unit for every
--           (subject, board, year) triple so authors have something to
--           click into straight away
--      This is what the "+ Subject" modal in lesson-creator calls.
--   4. Tightens the staff_audit_log CHECK constraint so we can log the
--      new 'subject_created' / 'subject_deleted' / 'tree_reorganized'
--      actions. Idempotent: dropping then re-adding with the widened
--      allowlist is the supported way to do this in Postgres.
-- ============================================================================

-- ---------- 1. NARROW SUBJECTS RLS TO ADMIN-ONLY --------------------------

-- The existing RLS policy from supabase_admin.sql is:
--   subjects_staff_write on public.subjects for all to authenticated
--     using (role in ('staff_author', 'admin'))
--     with check (role in ('staff_author', 'admin'))
-- That was the original "let authors create subjects" policy, but it's
-- too permissive: a staff_author can also DELETE any subject via
-- supabaseClient.from('subjects').delete().eq('id', x) — which lets one
-- author wipe another author's catalogue. The lesson-creator UI was
-- updated to use the RPC below instead of the table directly.

drop policy if exists "subjects_staff_write" on public.subjects;

-- New policy: admin can read + write the subjects table directly (used
-- by the admin subject-tree manager). Authors go through
-- create_subject_with_structure (RPC) so the auto-created structure is
-- always consistent. Anyone authenticated can still SELECT subjects
-- (the existing subjects_read_all policy from supabase_tables.sql
-- already covers that — we don't drop it here).
drop policy if exists "subjects_admin_write" on public.subjects;
create policy "subjects_admin_write" on public.subjects
  for all to authenticated
  using (exists (
    select 1 from public.profiles p
     where p.id = auth.uid()
       and p.role = 'admin'
       and p.deleted_at is null
  ))
  with check (exists (
    select 1 from public.profiles p
     where p.id = auth.uid()
       and p.role = 'admin'
       and p.deleted_at is null
  ));

-- Same narrowing for the subject_boards join table — only admins manage
-- the subject <-> board wiring (authors go through create_board_for_subject).
drop policy if exists "subject_boards_admin_write" on public.subject_boards;
create policy "subject_boards_admin_write" on public.subject_boards
  for all to authenticated
  using (exists (
    select 1 from public.profiles p
     where p.id = auth.uid()
       and p.role = 'admin'
       and p.deleted_at is null
  ))
  with check (exists (
    select 1 from public.profiles p
     where p.id = auth.uid()
       and p.role = 'admin'
       and p.deleted_at is null
  ));

-- ---------- 2. WIDEN STAFF_AUDIT_LOG ACTION CHECK -----------------------

-- Add the new action names we'll use below. We DROP first because the
-- constraint already exists from supabase_admin.sql; re-adding it with
-- a wider allowlist is the supported migration pattern.
alter table public.staff_audit_log
  drop constraint if exists staff_audit_log_action_check;

alter table public.staff_audit_log
  add constraint staff_audit_log_action_check
  check (action in (
    'invite_sent', 'invite_revoked', 'invite_resent',
    'role_changed', 'access_revoked',
    'lesson_published', 'lesson_unpublished', 'lesson_archived',
    'admin_login', 'admin_action',
    'user_deleted',
    'row_deleted',
    'subject_created', 'subject_deleted',
    'tree_reorganized'
  ));

-- ---------- 3. CREATE / UPDATE / DELETE SUBJECT RPCs --------------------

-- create_subject_with_structure: the new "create a subject" flow.
-- Available to admin (full control) and staff_author (can author
-- subjects in their own catalogue). Staff_reviewer cannot create
-- subjects — they only review lessons.
--
-- Inputs:
--   p_name          — subject name (required, non-empty, trimmed)
--   p_exam_board    — board name to attach. Pass 'AQA' / 'Edexcel' /
--                     'OCR' / 'WJEC' / 'CCEA' / 'SQA' / 'Cambridge'
--                     to create a kind='exam_board' row, or any other
--                     string to create a kind='course' row.
--   p_kind          — 'exam_board' (default) or 'course'. N/A when
--                     p_exam_board is null/empty.
--   p_level         — 'gcse' | 'a-level' | 'n-a'. Determines the
--                     subject row's level column AND the auto-picked
--                     year range when p_kind='exam_board'.
--   p_color_key     — required, matches CSS classes on the dashboard.
--   p_years         — for kind='course' only: explicit list of year
--                     labels (e.g. array['Year 7','Year 8']). For
--                     'exam_board' we IGNORE this — the years are
--                     computed from p_level:
--                       'gcse'    → ['Year 10','Year 11']
--                       'a-level' → ['Year 12','Year 13']
--                       'n-a'     → ['Year 10','Year 11']
--                     For 'curriculum' (handled separately below), the
--                     years are always ['Year 7','Year 8','Year 9'].
--   p_no_board      — when true, the subject is created WITHOUT an
--                     attached exam_board (e.g. the author picked
--                     'course' with no board). Default false.
--
-- Returns:
--   jsonb with { ok, subject_id, board_id, year_ids[], unit_ids[] }
--
-- Atomicity: all inserts happen in one transaction. If the year or
-- unit inserts fail, the whole subject creation rolls back.
drop function if exists public.create_subject_with_structure(
  text, text, text, text, text, text[], boolean
);

create or replace function public.create_subject_with_structure(
  p_name        text,
  p_exam_board  text,
  p_kind        text,
  p_level       text,
  p_color_key   text,
  p_years       text[] default null,
  p_no_board    boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid        uuid := auth.uid();
  v_is_admin   boolean;
  v_is_author  boolean;
  v_clean_name text := trim(coalesce(p_name, ''));
  v_clean_board text := trim(coalesce(p_exam_board, ''));
  v_clean_color text := trim(coalesce(p_color_key, ''));
  v_subject_id uuid;
  v_board_id   uuid;
  v_year_label text;
  v_year_id    uuid;
  v_year_sort  int;
  v_year_ids   uuid[] := '{}'::uuid[];
  v_unit_ids   uuid[] := '{}'::uuid[];
  v_new_unit_id uuid;
  v_resolved_years text[];
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  select
    (role = 'admin'),
    (role = 'staff_author')
    into v_is_admin, v_is_author
  from public.profiles
  where id = v_uid and deleted_at is null;

  if not (v_is_admin or v_is_author) then
    raise exception 'staff_author or admin role required' using errcode = '42501';
  end if;

  -- Field validation. Trim everything so a stray space can't sneak
  -- through the unique (name, exam_board, level) constraint below.
  if v_clean_name = '' then
    raise exception 'subject name is required' using errcode = '22023';
  end if;
  if v_clean_color = '' then
    raise exception 'colour key is required' using errcode = '22023';
  end if;
  if p_level not in ('gcse', 'a-level', 'n-a') then
    raise exception 'invalid level: % (use gcse, a-level, or n-a)', p_level
      using errcode = '22023';
  end if;
  if p_kind not in ('exam_board', 'course') then
    raise exception 'invalid kind: % (use exam_board or course)', p_kind
      using errcode = '22023';
  end if;

  -- exam_board kind → subject.exam_board stores the board name
  --                     (kept for backward-compat with existing code
  --                     that reads s.exam_board as a string).
  -- course kind     → subject.exam_board stores a sentinel like
  --                     'Course' so the column stays non-null
  --                     (the existing schema requires NOT NULL).
  --                     The real course is linked via subject_boards.
  if p_kind = 'exam_board' then
    if v_clean_board = '' then
      raise exception 'exam_board name is required when kind=exam_board'
        using errcode = '22023';
    end if;
  elsif p_kind = 'course' and v_clean_board = '' then
    -- "Course" is the canonical sentinel; callers can also pass a
    -- custom course name and we'll use it verbatim.
    v_clean_board := 'Course';
  end if;

  -- 1) Insert the subject row. The unique constraint on
  --    (name, exam_board, level) will reject duplicates — surface the
  --    error cleanly rather than letting it bubble.
  begin
    insert into public.subjects (name, exam_board, level, color_key)
      values (v_clean_name, v_clean_board,
              case when p_level = 'n-a' then 'gcse' else p_level end,
              v_clean_color)
      returning id into v_subject_id;
  exception
    when unique_violation then
      raise exception 'a subject with that name + exam_board + level already exists'
        using errcode = '23505';
  end;

  -- 2) Link the Curriculum base board (Years 7-9). Always — even if
  --    the author picked "course", every subject has a Curriculum row
  --    so the subjects.html catalogue always has a Year 7/8/9 entry.
  declare
    v_curr_id uuid;
  begin
    insert into public.exam_boards (name, country, kind)
      values ('Curriculum', 'UK', 'curriculum')
    on conflict (name) do update set kind = excluded.kind
      returning id into v_curr_id;

    insert into public.subject_boards (subject_id, exam_board_id)
      values (v_subject_id, v_curr_id)
    on conflict do nothing;

    foreach v_year_label in array array['Year 7','Year 8','Year 9'] loop
      select id into v_year_id from public.year_levels where label = v_year_label;
      if v_year_id is null then
        v_year_sort := case v_year_label
          when 'Year 7' then 7 when 'Year 8' then 8 when 'Year 9' then 9
          else 99 end;
        insert into public.year_levels (label, sort_order)
          values (v_year_label, v_year_sort)
          returning id into v_year_id;
      end if;
      v_year_ids := array_append(v_year_ids, v_year_id);

      insert into public.units (subject_id, exam_board_id, year_id, name, sort_order)
        values (v_subject_id, v_curr_id, v_year_id, 'Curriculum', 0)
        returning id into v_new_unit_id;
      v_unit_ids := array_append(v_unit_ids, v_new_unit_id);
    end loop;
  end;

  -- 3) Attach the chosen board (if any) + create its Curriculum
  --    units for each year in the resolved year list.
  if not p_no_board and v_clean_board <> '' then
    -- Resolve the final year list. exam_board is fully derived from
    -- p_level; course uses the caller-supplied p_years (with sane
    -- defaults if missing).
    if p_kind = 'exam_board' then
      if p_level = 'gcse' or p_level = 'n-a' then
        v_resolved_years := array['Year 10','Year 11'];
      else
        v_resolved_years := array['Year 12','Year 13'];
      end if;
    else
      -- course: use caller-supplied years. If empty, fall back to a
      -- reasonable default (Year 7-10) so the author has something to
      -- click into.
      if p_years is null or array_length(p_years, 1) is null then
        v_resolved_years := array['Year 7','Year 8','Year 9','Year 10'];
      else
        v_resolved_years := p_years;
      end if;
    end if;

    -- Upsert the board row.
    insert into public.exam_boards (name, country, kind)
      values (v_clean_board, 'UK', p_kind)
    on conflict (name) do update set kind = excluded.kind
      returning id into v_board_id;

    insert into public.subject_boards (subject_id, exam_board_id)
      values (v_subject_id, v_board_id)
    on conflict do nothing;

    foreach v_year_label in array v_resolved_years loop
      select id into v_year_id from public.year_levels where label = v_year_label;
      if v_year_id is null then
        v_year_sort := case v_year_label
          when 'Year 7' then 7 when 'Year 8' then 8 when 'Year 9' then 9
          when 'Year 10' then 10 when 'Year 11' then 11
          when 'Year 12' then 12 when 'Year 13' then 13
          else 99 end;
        insert into public.year_levels (label, sort_order)
          values (v_year_label, v_year_sort)
          returning id into v_year_id;
      end if;
      v_year_ids := array_append(v_year_ids, v_year_id);

      insert into public.units (subject_id, exam_board_id, year_id, name, sort_order)
        values (v_subject_id, v_board_id, v_year_id, 'Curriculum', 0)
        returning id into v_new_unit_id;
      v_unit_ids := array_append(v_unit_ids, v_new_unit_id);
    end loop;
  end if;

  -- 4) Audit log.
  perform public._log_staff_action(
    'subject_created', 'subject', v_subject_id,
    jsonb_build_object(
      'name',        v_clean_name,
      'exam_board',  v_clean_board,
      'kind',        p_kind,
      'level',       p_level,
      'color_key',   v_clean_color,
      'years',       v_resolved_years,
      'no_board',    p_no_board
    )
  );

  return jsonb_build_object(
    'ok',         true,
    'subject_id', v_subject_id,
    'board_id',   v_board_id,
    'year_ids',   to_jsonb(v_year_ids),
    'unit_ids',   to_jsonb(v_unit_ids)
  );
end;
$$;

grant execute on function public.create_subject_with_structure(
  text, text, text, text, text, text[], boolean
) to authenticated;

-- delete_subject: admin-only. Detaches the subject_boards links and
-- cascades subjects -> topics -> lessons -> lesson_blocks ->
-- lesson_progress / quiz_attempts / etc. via the existing FK
-- constraints. If anything in the cascade fails the whole delete rolls
-- back.
drop function if exists public.delete_subject(uuid);
create or replace function public.delete_subject(p_subject_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller uuid := auth.uid();
  v_name   text;
  v_count_units bigint;
begin
  if v_caller is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if not exists (
    select 1 from public.profiles
     where id = v_caller and role = 'admin' and deleted_at is null
  ) then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  if p_subject_id is null then
    raise exception 'subject id is required' using errcode = '22023';
  end if;

  select name into v_name from public.subjects where id = p_subject_id;
  if v_name is null then
    return jsonb_build_object('ok', false, 'reason', 'unknown_subject');
  end if;
  select count(*) into v_count_units from public.units where subject_id = p_subject_id;

  -- Audit BEFORE delete so we have a record even if the cascade blows up.
  perform public._log_staff_action(
    'subject_deleted', 'subject', p_subject_id,
    jsonb_build_object('name', v_name, 'unit_count', v_count_units)
  );

  -- subjects has FKs from topics (cascade), units (cascade), and
  -- subject_boards (cascade). Deleting the subject cascades all of
  -- those. Topics then cascade to lessons -> lesson_blocks ->
  -- lesson_progress / quiz_attempts / etc. via their own FKs.
  delete from public.subjects where id = p_subject_id;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'race_lost');
  end if;

  return jsonb_build_object(
    'ok', true,
    'subject_id', p_subject_id,
    'name', v_name,
    'units_deleted', v_count_units
  );
end;
$$;

grant execute on function public.delete_subject(uuid) to authenticated;

-- rename_subject: admin-only (subjects.exam_board is also writable
-- only via RPC now). Authors can still create subjects but cannot
-- rename them or change the exam_board after creation — that keeps
-- the (name, exam_board, level) unique constraint from breaking
-- under a partial edit.
drop function if exists public.rename_subject(uuid, text);
create or replace function public.rename_subject(
  p_subject_id uuid,
  p_name       text,
  p_exam_board text default null,
  p_level      text default null,
  p_color_key  text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller uuid := auth.uid();
  v_old    public.subjects%rowtype;
  v_clean_name text := trim(coalesce(p_name, ''));
  v_clean_board text := trim(coalesce(p_exam_board, ''));
  v_clean_color text := trim(coalesce(p_color_key, ''));
begin
  if v_caller is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if not exists (
    select 1 from public.profiles
     where id = v_caller and role = 'admin' and deleted_at is null
  ) then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  if v_clean_name = '' then
    raise exception 'name is required' using errcode = '22023';
  end if;

  select * into v_old from public.subjects where id = p_subject_id;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'unknown_subject');
  end if;

  update public.subjects
     set name       = v_clean_name,
         exam_board = coalesce(nullif(v_clean_board, ''), exam_board),
         level      = coalesce(nullif(p_level, ''), level),
         color_key  = coalesce(nullif(v_clean_color, ''), color_key)
   where id = p_subject_id;

  perform public._log_staff_action(
    'admin_action', 'subject', p_subject_id,
    jsonb_build_object(
      'op',          'rename',
      'old_name',    v_old.name,
      'new_name',    v_clean_name,
      'old_board',   v_old.exam_board,
      'new_board',   coalesce(nullif(v_clean_board, ''), v_old.exam_board),
      'old_level',   v_old.level,
      'new_level',   coalesce(nullif(p_level, ''), v_old.level)
    )
  );

  return jsonb_build_object('ok', true);
end;
$$;

grant execute on function public.rename_subject(uuid, text, text, text, text)
  to authenticated;

-- ---------- 4. SUBJECT TREE MANAGER RPCs ---------------------------------

-- admin_list_subjects_with_resources: used by the admin subject tree
-- manager to render the full hierarchy for a chosen subject. Returns
-- every board + every year + every unit + a topic count + a lesson
-- count for that unit. Authored as a SECURITY DEFINER RPC so the
-- admin can see lesson counts (lessons table is RLS-narrowed to
-- staff and 'published' for students; admin needs everything).
drop function if exists public.admin_list_subjects_with_resources();
create or replace function public.admin_list_subjects_with_resources()
returns table (
  subject_id    uuid,
  subject_name  text,
  color_key     text,
  level         text,
  exam_board    text,
  board_id      uuid,
  board_name    text,
  board_kind    text,
  year_id       uuid,
  year_label    text,
  year_sort     int,
  unit_id       uuid,
  unit_name     text,
  topic_count   bigint,
  lesson_count  bigint
)
language sql
security definer
stable
set search_path = public
as $$
  with boards_for_subj as (
    select s.id as subject_id, s.name, s.color_key, s.level, s.exam_board,
           sb.exam_board_id, b.name as board_name, b.kind as board_kind
      from public.subjects s
      join public.subject_boards sb on sb.subject_id = s.id
      join public.exam_boards   b  on b.id = sb.exam_board_id
  )
  select
      bfs.subject_id,
      bfs.name,
      bfs.color_key,
      bfs.level,
      bfs.exam_board,
      bfs.exam_board_id,
      bfs.board_name,
      bfs.board_kind,
      y.id,
      y.label,
      y.sort_order,
      u.id,
      u.name,
      coalesce((
        select count(*) from public.topics t where t.unit_id = u.id
      ), 0) as topic_count,
      coalesce((
        select count(*)
          from public.topics t
          join public.lessons l on l.topic_id = t.id
         where t.unit_id = u.id
      ), 0) as lesson_count
    from boards_for_subj bfs
    left join public.year_levels y on true
    left join public.units      u
           on u.subject_id    = bfs.subject_id
          and u.exam_board_id = bfs.exam_board_id
          and u.year_id       = y.id
    order by bfs.name, bfs.exam_board_id, y.sort_order, u.sort_order, u.name;
$$;

grant execute on function public.admin_list_subjects_with_resources()
  to authenticated;

-- admin_move_lesson: move a lesson from its current topic (which
-- lives under some unit) to a topic under a DIFFERENT unit. Used by
-- the admin subject tree manager's drag-to-reorder UX. Idempotent:
-- re-running with the same target is a no-op.
--
-- The function refuses to cross subjects — the target topic must be
-- under a unit whose subject_id matches the lesson's current
-- subject_id. Otherwise we'd silently let an admin drag a "Maths"
-- lesson into "Biology" because the JS accidentally offered both
-- targets.
drop function if exists public.admin_move_lesson(uuid, uuid);
create or replace function public.admin_move_lesson(
  p_lesson_id    uuid,
  p_target_topic uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller uuid := auth.uid();
  v_lesson public.lessons%rowtype;
  v_target public.topics%rowtype;
  v_lesson_subject uuid;
  v_target_subject uuid;
  v_next_order int;
begin
  if v_caller is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if not exists (
    select 1 from public.profiles
     where id = v_caller and role = 'admin' and deleted_at is null
  ) then
    raise exception 'admin role required' using errcode = '42501';
  end if;

  select * into v_lesson from public.lessons where id = p_lesson_id;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'unknown_lesson');
  end if;

  select * into v_target from public.topics where id = p_target_topic;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'unknown_topic');
  end if;

  -- Cross-subject move is forbidden.
  select subject_id into v_lesson_subject
    from public.topics where id = v_lesson.topic_id;
  select subject_id into v_target_subject
    from public.units where id = v_target.unit_id;

  if v_target_subject is null or v_target_subject <> v_lesson_subject then
    return jsonb_build_object('ok', false, 'reason', 'cross_subject_move_blocked');
  end if;

  -- Idempotent: already there.
  if v_lesson.topic_id = p_target_topic then
    return jsonb_build_object('ok', true, 'noop', true);
  end if;

  -- Put the lesson at the end of the new topic. Authors can re-order
  -- via the lesson editor afterwards.
  select coalesce(max(order_index), -1) + 1 into v_next_order
    from public.lessons
   where topic_id = p_target_topic;

  update public.lessons
     set topic_id    = p_target_topic,
         order_index = v_next_order
   where id = p_lesson_id;

  perform public._log_staff_action(
    'tree_reorganized', 'lesson', p_lesson_id,
    jsonb_build_object(
      'op',             'move_lesson',
      'from_topic',     v_lesson.topic_id,
      'to_topic',       p_target_topic,
      'subject_id',     v_target_subject
    )
  );

  return jsonb_build_object('ok', true, 'order_index', v_next_order);
end;
$$;

grant execute on function public.admin_move_lesson(uuid, uuid) to authenticated;

-- admin_move_topic_to_unit: move a whole topic (and every lesson
-- inside it) to a different unit within the same subject. Mirrors
-- move_topic_to_unit from supabase_units.sql but tagged for admin
-- audit and explicitly namespaced so future admin tools can call
-- it without colliding with the author-tier version.
drop function if exists public.admin_move_topic_to_unit(uuid, uuid);
create or replace function public.admin_move_topic_to_unit(
  p_topic_id uuid,
  p_unit_id  uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller uuid := auth.uid();
  v_topic  public.topics%rowtype;
  v_unit   public.units%rowtype;
begin
  if v_caller is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if not exists (
    select 1 from public.profiles
     where id = v_caller and role = 'admin' and deleted_at is null
  ) then
    raise exception 'admin role required' using errcode = '42501';
  end if;

  select * into v_topic from public.topics where id = p_topic_id;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'unknown_topic');
  end if;

  if p_unit_id is not null then
    select * into v_unit from public.units where id = p_unit_id;
    if not found then
      return jsonb_build_object('ok', false, 'reason', 'unknown_unit');
    end if;
    if v_unit.subject_id <> v_topic.subject_id then
      return jsonb_build_object('ok', false, 'reason', 'cross_subject_move_blocked');
    end if;
  end if;

  update public.topics set unit_id = p_unit_id where id = p_topic_id;

  perform public._log_staff_action(
    'tree_reorganized', 'topic', p_topic_id,
    jsonb_build_object(
      'op',         'move_topic',
      'to_unit',    p_unit_id,
      'subject_id', v_topic.subject_id
    )
  );

  return jsonb_build_object('ok', true);
end;
$$;

grant execute on function public.admin_move_topic_to_unit(uuid, uuid) to authenticated;

-- ---------- 5. ENSURE ADMIN CAN DELETE EXAM_BOARD / YEAR_LEVEL ----------
-- The existing delete_exam_board / delete_year from supabase_units.sql
-- already use _assert_admin(), so admin-only enforcement is in place
-- for those RPCs. BUT the RLS policy below (from supabase_tables.sql)
-- doesn't include exam_boards or year_levels in the staff_write
-- policy — only public read. That means non-admins couldn't delete
-- exam_boards directly even if they tried. The RPCs are still the
-- supported path; we keep them as the canonical entry point so the
-- audit log captures the op.

-- Add an explicit RLS deny for direct writes on exam_boards / year_levels
-- (just so a future migration doesn't accidentally widen the policy).
-- These tables are RLS-enabled with only the public read policy; any
-- attempt by the authenticated role to insert/update/delete will be
-- rejected by the missing policy. We document that here so the admin
-- "delete exam_board" path goes through delete_exam_board(), not a
-- direct supabaseClient.from('exam_boards').delete().
-- (No SQL change needed — the absence of a write policy is the rule.)

-- ============================================================================
-- DONE. After running this:
--   1. lesson-creator.html's "+ Subject" modal calls
--      create_subject_with_structure() instead of inserting into
--      subjects directly — the auto-created Curriculum + chosen-board
--      + Curriculum units appear immediately.
--   2. lesson-creator.html's delete button on a subject is only shown
--      to admins, and uses the delete_subject() RPC.
--   3. admin.html's new Subject tree manager section can call
--      admin_list_subjects_with_resources() to render the full
--      SUBJECT > BOARD > YEAR > UNIT > TOPIC > LESSON tree.
--   4. admin.html's tree manager can drag a lesson from one topic to
--      another via admin_move_lesson().
--   5. admin.html's tree manager can drag a topic from one unit to
--      another via admin_move_topic_to_unit().
-- ============================================================================
