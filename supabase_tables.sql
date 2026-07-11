-- ============================================================================
-- Recall Education — Learning-app tables
-- Run this AFTER supabase_setup.sql in the Supabase SQL editor.
-- Idempotent: safe to re-run.
--
-- This file assumes the schema from supabase_setup.sql already exists:
--   public.profiles
--   public.parental_consents
--   public.handle_new_user()  (trigger on auth.users)
--   public.check_parental_consent()  (custom access token hook)
-- ============================================================================

-- ---------- 1. CATALOGUE TABLES (public read, no client writes) -----------

create table if not exists public.subjects (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  exam_board    text not null,                -- e.g. 'AQA', 'Edexcel', 'OCR'
  level         text not null check (level in ('gcse','a-level')),
  color_key     text not null,                -- matches CSS classes on the dashboard
  sort_order    int  not null default 0,
  created_at    timestamptz not null default now(),
  unique (name, exam_board, level)
);

create table if not exists public.topics (
  id            uuid primary key default gen_random_uuid(),
  subject_id    uuid not null references public.subjects(id) on delete cascade,
  name          text not null,
  order_index   int  not null default 0,
  created_at    timestamptz not null default now()
);
create index if not exists topics_subject_idx on public.topics (subject_id, order_index);

create table if not exists public.lessons (
  id            uuid primary key default gen_random_uuid(),
  topic_id      uuid not null references public.topics(id) on delete cascade,
  title         text not null,
  order_index   int  not null default 0,
  duration_min  int  not null default 20,
  created_at    timestamptz not null default now()
);
create index if not exists lessons_topic_idx on public.lessons (topic_id, order_index);

create table if not exists public.live_lessons (
  id            uuid primary key default gen_random_uuid(),
  subject_id    uuid not null references public.subjects(id) on delete cascade,
  title         text not null,
  teacher       text,
  starts_at     timestamptz not null,
  created_at    timestamptz not null default now()
);
create index if not exists live_lessons_starts_idx on public.live_lessons (starts_at);

-- ---------- 2. PER-USER TABLES (RLS locks to auth.uid()) -------------------

create table if not exists public.enrollments (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  subject_id    uuid not null references public.subjects(id) on delete cascade,
  started_at    timestamptz not null default now(),
  unique (user_id, subject_id)
);
create index if not exists enrollments_user_idx on public.enrollments (user_id);

create table if not exists public.lesson_progress (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  lesson_id     uuid not null references public.lessons(id) on delete cascade,
  status        text not null default 'not_started'
                check (status in ('not_started','in_progress','completed')),
  started_at    timestamptz,
  completed_at  timestamptz,
  updated_at    timestamptz not null default now(),
  unique (user_id, lesson_id)
);
create index if not exists lesson_progress_user_idx on public.lesson_progress (user_id);
create index if not exists lesson_progress_updated_idx on public.lesson_progress (user_id, updated_at desc);

create table if not exists public.quiz_attempts (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  lesson_id     uuid references public.lessons(id) on delete set null,
  score         int  not null,
  total         int  not null,
  taken_at      timestamptz not null default now()
);
create index if not exists quiz_attempts_user_idx on public.quiz_attempts (user_id, taken_at desc);

create table if not exists public.assignments (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  subject_id    uuid references public.subjects(id) on delete set null,
  title         text not null,
  description   text,
  kind          text not null default 'homework'
                check (kind in ('homework','mock','exam','live')),
  due_at        timestamptz not null,
  status        text not null default 'pending'
                check (status in ('pending','done','missed')),
  created_at    timestamptz not null default now()
);
create index if not exists assignments_user_due_idx on public.assignments (user_id, due_at);

create table if not exists public.study_sessions (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  started_at    timestamptz not null default now(),
  duration_min  int  not null,
  lesson_id     uuid references public.lessons(id) on delete set null
);
create index if not exists study_sessions_user_idx on public.study_sessions (user_id, started_at desc);

create table if not exists public.activity_log (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  kind          text not null check (kind in ('lesson','quiz','session','assignment')),
  ref_id        uuid,                        -- points to the related row, if any
  summary       text not null,                -- pre-formatted display string
  created_at    timestamptz not null default now()
);
create index if not exists activity_log_user_idx on public.activity_log (user_id, created_at desc);

-- ---------- 3. SUBJECT_PROGRESS VIEW ---------------------------------------
-- For each (user, subject), the total lessons, completed lessons, and pct.
-- One row per enrollment, used by the dashboard to render progress bars.

create or replace view public.subject_progress as
select
  e.user_id,
  e.subject_id,
  s.name          as subject_name,
  s.exam_board,
  s.level,
  s.color_key,
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
left join public.topics    t  on t.subject_id = s.id
left join public.lessons   l  on l.topic_id  = t.id
left join public.lesson_progress lp
       on lp.lesson_id = l.id and lp.user_id = e.user_id
group by e.user_id, e.subject_id, s.name, s.exam_board, s.level, s.color_key;

grant select on public.subject_progress to anon, authenticated;

-- ---------- 4. CREATE_PARENTAL_CONSENT RPC --------------------------------
-- Called by signup.html after auth.signUp() for under-16s. Returns the new
-- token so the student can show / forward the consent link.
-- This was missing from supabase_setup.sql — adding it here fixes the
-- under-16 signup flow (otherwise the form fails silently after account create).

create or replace function public.create_parental_consent(
  p_student_user_id uuid,
  p_parent_email    text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  new_token uuid;
begin
  if p_parent_email is null or p_parent_email = '' then
    raise exception 'parent_email is required';
  end if;

  insert into public.parental_consents (student_user_id, parent_email)
  values (p_student_user_id, p_parent_email)
  returning token into new_token;

  return new_token;
end;
$$;

grant execute on function public.create_parental_consent(uuid, text) to anon, authenticated;

-- ---------- 5. ROW-LEVEL SECURITY -----------------------------------------

-- Catalogue: public read, no client write.
alter table public.subjects     enable row level security;
alter table public.topics       enable row level security;
alter table public.lessons      enable row level security;
alter table public.live_lessons enable row level security;

drop policy if exists "subjects_read_all"     on public.subjects;
create policy "subjects_read_all" on public.subjects for select
  to anon, authenticated using (true);

drop policy if exists "topics_read_all"       on public.topics;
create policy "topics_read_all" on public.topics for select
  to anon, authenticated using (true);

drop policy if exists "lessons_read_all"      on public.lessons;
create policy "lessons_read_all" on public.lessons for select
  to anon, authenticated using (true);

drop policy if exists "live_lessons_read_all" on public.live_lessons;
create policy "live_lessons_read_all" on public.live_lessons for select
  to anon, authenticated using (true);

-- Per-user tables: own read/write only. Service role bypasses RLS.
alter table public.enrollments     enable row level security;
alter table public.lesson_progress enable row level security;
alter table public.quiz_attempts   enable row level security;
alter table public.assignments     enable row level security;
alter table public.study_sessions  enable row level security;
alter table public.activity_log    enable row level security;

-- enrollments: full CRUD on own rows
drop policy if exists "enrollments_own" on public.enrollments;
create policy "enrollments_own" on public.enrollments for all
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- lesson_progress: full CRUD on own rows
drop policy if exists "lesson_progress_own" on public.lesson_progress;
create policy "lesson_progress_own" on public.lesson_progress for all
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- quiz_attempts: read own + insert own (no update/delete — they're a record)
drop policy if exists "quiz_attempts_select_own" on public.quiz_attempts;
create policy "quiz_attempts_select_own" on public.quiz_attempts for select
  to authenticated using (user_id = auth.uid());

drop policy if exists "quiz_attempts_insert_own" on public.quiz_attempts;
create policy "quiz_attempts_insert_own" on public.quiz_attempts for insert
  to authenticated with check (user_id = auth.uid());

-- assignments: full CRUD on own rows
drop policy if exists "assignments_own" on public.assignments;
create policy "assignments_own" on public.assignments for all
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- study_sessions: read own + insert own
drop policy if exists "study_sessions_select_own" on public.study_sessions;
create policy "study_sessions_select_own" on public.study_sessions for select
  to authenticated using (user_id = auth.uid());

drop policy if exists "study_sessions_insert_own" on public.study_sessions;
create policy "study_sessions_insert_own" on public.study_sessions for insert
  to authenticated with check (user_id = auth.uid());

-- activity_log: read own + insert own
drop policy if exists "activity_log_select_own" on public.activity_log;
create policy "activity_log_select_own" on public.activity_log for select
  to authenticated using (user_id = auth.uid());

drop policy if exists "activity_log_insert_own" on public.activity_log;
create policy "activity_log_insert_own" on public.activity_log for insert
  to authenticated with check (user_id = auth.uid());

-- ---------- 6. UPDATED_AT TRIGGER -----------------------------------------
-- Depends on public.touch_updated_at() from supabase_setup.sql. If that
-- file hasn't been run yet, skip the trigger and warn — you can re-run
-- this file after supabase_setup.sql to install the trigger.

do $$
begin
  if exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'touch_updated_at'
  ) then
    drop trigger if exists lesson_progress_touch_updated_at on public.lesson_progress;
    create trigger lesson_progress_touch_updated_at
      before update on public.lesson_progress
      for each row execute function public.touch_updated_at();
  else
    raise notice 'public.touch_updated_at() not found — skipping lesson_progress trigger. Run supabase_setup.sql first, then re-run this file.';
  end if;
end $$;

-- ---------- 7. SEED DATA --------------------------------------------------
-- The 8 subjects the dashboard was mocked with, plus a few topics and lessons
-- per subject so "Continue learning" and "Your subjects" aren't empty.
-- Real per-user data (enrollments, progress, activity) is NOT seeded here —
-- see section 8 for a snippet to run after your first sign-up.

insert into public.subjects (name, exam_board, level, color_key, sort_order) values
  ('Maths',         'Edexcel', 'gcse',    'maths', 1),
  ('English Lit.',  'AQA',     'gcse',    'eng',   2),
  ('Biology',       'AQA',     'a-level', 'bio',   3),
  ('Chemistry',     'OCR',     'a-level', 'chem',  4),
  ('Physics',       'AQA',     'gcse',    'phys',  5),
  ('History',       'Edexcel', 'gcse',    'hist',  6),
  ('Geography',     'AQA',     'gcse',    'geog',  7),
  ('Psychology',    'OCR',     'a-level', 'psych', 8)
on conflict (name, exam_board, level) do nothing;

-- A handful of topics per subject. One topic is enough for the dashboard to
-- render "Continue" — the rest of the catalogue can be filled in later.
-- Topics are keyed on (subject_id, name) via the unique index below.
create unique index if not exists topics_subject_name_uniq
  on public.topics (subject_id, name);

insert into public.topics (subject_id, name, order_index)
select s.id, m.topic, m.ord
from public.subjects s
join (values
  ('Maths',        'Algebra · quadratics', 1),
  ('English Lit.', 'Macbeth',              1),
  ('Biology',      'Cell structure',       1),
  ('Chemistry',    'Bonding',              1),
  ('Physics',      'Forces and motion',    1),
  ('History',      'Weimar Germany',       1),
  ('Geography',    'Tectonic hazards',     1),
  ('Psychology',   'Memory',               1)
) as m(subj, topic, ord) on s.name = m.subj
on conflict (subject_id, name) do nothing;

-- A few lessons per topic. Just enough to make progress bars non-zero.
create unique index if not exists lessons_topic_title_uniq
  on public.lessons (topic_id, title);

insert into public.lessons (topic_id, title, order_index)
select t.id, l.title, l.ord
from public.topics t
join public.subjects s on s.id = t.subject_id
join (values
  ('Biology',  'Cell structure', 'Mitochondria',            1),
  ('Biology',  'Cell structure', 'Cell membrane',           2),
  ('Biology',  'Cell structure', 'Ribosomes',               3),
  ('Maths',    'Algebra · quadratics', 'Factoring',         1),
  ('Maths',    'Algebra · quadratics', 'The quadratic formula', 2),
  ('Chemistry','Bonding',         'Ionic bonding',          1),
  ('Physics',  'Forces and motion', 'Newton''s second law', 1)
) as l(subj, topic, title, ord)
  on s.name = l.subj and t.name = l.topic
on conflict (topic_id, title) do nothing;

-- ---------- 8. ENROLL YOURSELF (run once you've signed up) -----------------
-- After signing up via the UI, your auth.users row will exist. Find your
-- id in the Supabase dashboard (Authentication → Users) and paste it into
-- the @enroll_user variable below, then run this block in the SQL editor
-- with role = service_role (or the dashboard's default if you have a
-- bypass-RLS session). This enrolls you in every seeded subject and writes
-- a welcome activity log row so the dashboard isn't empty.
--
--   set local role service_role;
--   do $$
--   declare enroll_user uuid := 'PASTE-YOUR-USER-ID-HERE';
--   begin
--     insert into public.enrollments (user_id, subject_id)
--     select enroll_user, s.id from public.subjects s
--     on conflict (user_id, subject_id) do nothing;
--
--     insert into public.activity_log (user_id, kind, summary)
--     values (enroll_user, 'session',
--             'Welcome to Recall — pick a subject to get started.');
--   end $$;
--
-- For a quick visual test of progress bars, also run:
--   insert into public.lesson_progress (user_id, lesson_id, status, completed_at)
--   select 'PASTE-YOUR-USER-ID-HERE', l.id, 'completed', now()
--   from public.lessons l limit 3;

-- ============================================================================
-- DONE. Optional follow-ups:
--   • Add a `seed_for_user(uuid)` RPC that, given a new user's id, copies
--     the catalogue enrollments and writes a welcome activity log row.
--   • Add a SQL function that fires on first study_session insert and writes
--     a "Studied for X minutes" row to activity_log automatically.
--   • Add an assignments auto-generator for upcoming mocks.
-- ============================================================================
