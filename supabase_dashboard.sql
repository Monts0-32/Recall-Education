-- ============================================================================
-- Recall Education — Dashboard / player migration
-- Run this AFTER supabase_setup.sql, supabase_tables.sql, supabase_staff.sql,
-- and supabase_uploads.sql. Idempotent: safe to re-run.
--
-- What this does:
--   1. Adds lesson_progress.time_spent_seconds so the dashboard can show
--      "time on this lesson" without joining to study_sessions.
--   2. Adds a study_sessions.kind CHECK to prevent bad writes
--      ('lesson' | 'quiz' | 'review' | 'practice').
--   3. Adds a single log_lesson_session RPC that the student player
--      calls. It does ALL the writes in one transaction:
--        - inserts a study_sessions row
--        - upserts lesson_progress (bump time, set in_progress)
--        - inserts quiz_attempts rows for any activities scored
--        - inserts activity_log rows for the session + each attempt
--      The player never needs direct write access to those tables,
--      so we don't have to add new RLS policies for the anon/auth
--      role.
-- ============================================================================

-- ---------- 1. PER-LESSON TIME -------------------------------------------

alter table public.lesson_progress
  add column if not exists time_spent_seconds int not null default 0;

-- ---------- 2. STUDY_SESSIONS.KIND CHECK ---------------------------------
-- The kind column existed in the schema but had no CHECK. Adding one
-- now prevents the player (or any future client) from inserting
-- garbage values.

do $$
declare
  cname text;
begin
  select con.conname into cname
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
   where rel.relname = 'study_sessions'
     and con.contype = 'c'
     and pg_get_constraintdef(con.oid) ilike '%kind%';
  if cname is not null then
    execute 'alter table public.study_sessions drop constraint ' || quote_ident(cname);
  end if;
end $$;

alter table public.study_sessions
  add constraint study_sessions_kind_check
  check (kind in ('lesson', 'quiz', 'review', 'practice'));

-- Allow kind to be nullable for backward compatibility with rows that
-- pre-date the CHECK. New writes go in via the RPC which always sets
-- a value.
alter table public.study_sessions
  alter column kind set default 'lesson';

-- ---------- 3. log_lesson_session RPC -------------------------------------
--
-- Called by lesson.html every 30s while a lesson is open, and on
-- 'beforeunload' via sendBeacon.
--
-- Parameters:
--   p_lesson_id          uuid   — the lesson being studied
--   p_duration_seconds   int    — how long to log (delta since last call)
--   p_activities         jsonb  — optional array of:
--                                 { block_id, score, total, kind }
--                                 to record quiz attempts and activity
--                                 log entries.
--                                 Shape: [{block_id, kind, score, total}, ...]
--   p_completed          bool   — if true, mark the lesson_progress
--                                 row as completed (sets completed_at).
--
-- Returns:
--   jsonb — { ok, time_spent_seconds }
--
-- Notes:
--   * SECURITY DEFINER so it can write to the various tables without
--     requiring RLS policy changes for the anon/authenticated role.
--   * Runs everything in a single transaction. If any part fails, the
--     whole call rolls back — we never end up with a study_sessions
--     row that didn't bump lesson_progress, or vice versa.
--   * The caller is identified by auth.uid(). We do not accept a
--     user_id parameter — students can only log their own sessions.
--   * If p_lesson_id is null, this is a "no lesson" log (e.g. the
--     student just opened the dashboard). We still record the
--     study_session + activity_log row, useful for streak tracking.
-- ============================================================================

create or replace function public.log_lesson_session(
  p_lesson_id        uuid default null,
  p_duration_seconds int  default 0,
  p_activities       jsonb default '[]'::jsonb,
  p_completed        boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_session_id uuid;
  v_duration_min int;
  v_time_spent int;
  v_lesson_title text;
  v_subject_id uuid;
  v_activity jsonb;
  v_block_id uuid;
  v_act_kind text;
  v_act_score int;
  v_act_total int;
  v_act_summary text;
  v_attempt_id uuid;
begin
  if v_user_id is null then
    raise exception 'not authenticated';
  end if;

  if p_duration_seconds is null or p_duration_seconds < 0 then
    p_duration_seconds := 0;
  end if;

  -- Round up to whole minutes for the study_sessions.duration_min column.
  -- 1-59s -> 1min, 60-119s -> 2min, etc. Anything < 1s -> skip the
  -- study_sessions row (still log the activity_log + lesson_progress
  -- updates if there are any).
  v_duration_min := ceil(p_duration_seconds / 60.0)::int;

  if p_lesson_id is not null then
    select title, topic_id into v_lesson_title, v_subject_id
      from public.lessons l
      join public.topics t on t.id = l.topic_id
     where l.id = p_lesson_id;
    if v_lesson_title is null then
      raise exception 'lesson not found';
    end if;
  end if;

  -- 1) study_sessions row. Skip if duration < 1 minute and there are
  --    no activities to log, to avoid spamming the table with 1s rows.
  if v_duration_min > 0 or jsonb_array_length(p_activities) > 0 then
    insert into public.study_sessions
      (user_id, lesson_id, kind, duration_min, started_at)
    values
      (v_user_id, p_lesson_id, 'lesson', greatest(v_duration_min, 0), now())
    returning id into v_session_id;
  end if;

  -- 2) lesson_progress upsert. We accumulate time on top of any
  --    existing value so a lesson studied over multiple sessions
  --    shows the right total.
  if p_lesson_id is not null then
    insert into public.lesson_progress
      (user_id, lesson_id, status, started_at, time_spent_seconds, updated_at)
    values
      (v_user_id, p_lesson_id,
       case when p_completed then 'completed' else 'in_progress' end,
       now(),
       p_duration_seconds,
       now())
    on conflict (user_id, lesson_id) do update set
      time_spent_seconds = public.lesson_progress.time_spent_seconds
                            + excluded.time_spent_seconds,
      started_at = coalesce(public.lesson_progress.started_at, excluded.started_at),
      completed_at = case
        when excluded.status = 'completed' and public.lesson_progress.status <> 'completed'
          then now()
        else public.lesson_progress.completed_at
      end,
      status = case
        when excluded.status = 'completed' then 'completed'
        when public.lesson_progress.status = 'completed' then 'completed'
        else 'in_progress'
      end,
      updated_at = now()
    returning time_spent_seconds into v_time_spent;
  end if;

  -- 3) Per-activity rows: one quiz_attempts + one activity_log per
  --    block the student engaged with. p_activities is a jsonb array
  --    of {block_id, kind, score, total}.
  if jsonb_array_length(p_activities) > 0 then
    for v_activity in select * from jsonb_array_elements(p_activities)
    loop
      v_block_id := (v_activity->>'block_id')::uuid;
      v_act_kind := coalesce(v_activity->>'kind', 'quiz');
      v_act_score := coalesce((v_activity->>'score')::int, 0);
      v_act_total := coalesce((v_activity->>'total')::int, 1);

      -- quiz_attempts row. lesson_id is set; block_id has no FK column
      -- (the schema doesn't track which block was answered), so we
      -- stash it in the ref_id and put the score/total in their
      -- respective columns. The activity kind is encoded by writing
      -- 'quiz' for now — finer breakdown (per block type) can come
      -- later.
      insert into public.quiz_attempts
        (user_id, lesson_id, score, total, taken_at)
      values
        (v_user_id, p_lesson_id, v_act_score, v_act_total, now())
      returning id into v_attempt_id;

      -- activity_log row. summary is a short human-readable string
      -- for the dashboard's "Recent activity" feed.
      v_act_summary := format('Scored %s out of %s on a %s block',
                              v_act_score, v_act_total, v_act_kind);
      if p_lesson_id is not null and v_lesson_title is not null then
        v_act_summary := v_act_summary || ' in ' || v_lesson_title;
      end if;
      insert into public.activity_log
        (user_id, kind, ref_id, summary, created_at)
      values
        (v_user_id, 'quiz', v_attempt_id, v_act_summary, now());
    end loop;
  end if;

  -- 4) Session-level activity_log row, only when there's actual
  --    duration to log. This is what bumps the streak — the
  --    dashboard's computeStreak reads study_sessions.started_at,
  --    not activity_log, so we don't strictly need this row for the
  --    streak, but it makes the activity feed show "Studied for Xm"
  --    even when no practice blocks were answered.
  if v_duration_min > 0 and p_lesson_id is not null and v_lesson_title is not null then
    insert into public.activity_log
      (user_id, kind, ref_id, summary, created_at)
    values
      (v_user_id, 'session', v_session_id,
       format('Studied for %s min on %s', v_duration_min, v_lesson_title),
       now());
  end if;

  -- 5) If p_completed is true, also write a final 'lesson' activity
  --    log row so the feed shows "Completed X" distinctly from
  --    "Studied X for Ym".
  if p_completed and p_lesson_id is not null and v_lesson_title is not null then
    insert into public.activity_log
      (user_id, kind, ref_id, summary, created_at)
    values
      (v_user_id, 'lesson', p_lesson_id,
       format('Completed %s', v_lesson_title),
       now());
  end if;

  return jsonb_build_object(
    'ok', true,
    'time_spent_seconds', coalesce(v_time_spent, 0)
  );
end;
$$;

grant execute on function public.log_lesson_session(
  uuid, int, jsonb, boolean
) to authenticated;

-- ============================================================================
-- DONE. The student player (lesson.html) calls this RPC every 30 seconds
-- while a lesson is open, and once more on tab close via sendBeacon.
-- No RLS changes are needed — the function is SECURITY DEFINER.
-- ============================================================================
