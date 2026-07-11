-- ============================================================================
-- Recall Education — Staff lesson-creator tables
-- Run this AFTER supabase_setup.sql AND supabase_tables.sql in the
-- Supabase SQL editor. Idempotent: safe to re-run.
--
-- Adds:
--   • public.profiles.role   ('student' default, 'staff' for the team)
--   • public.lesson_blocks   (ordered, typed, jsonb-data blocks per lesson)
--   • staff write policies on subjects / topics / lessons / lesson_blocks
--   • public.reorder_lesson_blocks(jsonb) RPC
--   • seed data: the 22 subjects from index.html
-- ============================================================================

-- ---------- 1. ROLE ON PROFILES --------------------------------------------

alter table public.profiles
  add column if not exists role text not null default 'student'
  check (role in ('student','staff'));

-- ---------- 2. LESSON BLOCKS TABLE -----------------------------------------
-- A lesson is a sequence of typed blocks. Each block stores its data as jsonb
-- so new block types can be added without a migration — just extend the check
-- and add an editor / renderer.

create table if not exists public.lesson_blocks (
  id            uuid primary key default gen_random_uuid(),
  lesson_id     uuid not null references public.lessons(id) on delete cascade,
  kind          text not null check (kind in (
                  'heading','text','callout','image','video',
                  'math','keypoints','worked_example','reveal','flashcard'
                )),
  data          jsonb not null default '{}'::jsonb,
  order_index   int  not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists lesson_blocks_lesson_idx
  on public.lesson_blocks (lesson_id, order_index);

-- updated_at trigger (reuses touch_updated_at from supabase_setup.sql).
do $$
begin
  if exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'touch_updated_at'
  ) then
    drop trigger if exists lesson_blocks_touch_updated_at on public.lesson_blocks;
    create trigger lesson_blocks_touch_updated_at
      before update on public.lesson_blocks
      for each row execute function public.touch_updated_at();
  else
    raise notice 'public.touch_updated_at() not found — skipping lesson_blocks trigger. Run supabase_setup.sql first, then re-run this file.';
  end if;
end $$;

-- ---------- 3. ROW-LEVEL SECURITY -----------------------------------------

alter table public.lesson_blocks enable row level security;

-- Catalogue (subjects / topics / lessons) is already public-read with
-- "subjects_read_all" / "topics_read_all" / "lessons_read_all". We add staff
-- write policies. Read stays public.

-- subjects
drop policy if exists "subjects_staff_write" on public.subjects;
create policy "subjects_staff_write" on public.subjects
  for all to authenticated
  using (
    exists (select 1 from public.profiles p
             where p.id = auth.uid() and p.role = 'staff')
  )
  with check (
    exists (select 1 from public.profiles p
             where p.id = auth.uid() and p.role = 'staff')
  );

-- topics
drop policy if exists "topics_staff_write" on public.topics;
create policy "topics_staff_write" on public.topics
  for all to authenticated
  using (
    exists (select 1 from public.profiles p
             where p.id = auth.uid() and p.role = 'staff')
  )
  with check (
    exists (select 1 from public.profiles p
             where p.id = auth.uid() and p.role = 'staff')
  );

-- lessons
drop policy if exists "lessons_staff_write" on public.lessons;
create policy "lessons_staff_write" on public.lessons
  for all to authenticated
  using (
    exists (select 1 from public.profiles p
             where p.id = auth.uid() and p.role = 'staff')
  )
  with check (
    exists (select 1 from public.profiles p
             where p.id = auth.uid() and p.role = 'staff')
  );

-- lesson_blocks: public read (so the future student viewer can fetch them
-- without auth) and staff write.
drop policy if exists "lesson_blocks_read_all" on public.lesson_blocks;
create policy "lesson_blocks_read_all" on public.lesson_blocks
  for select to anon, authenticated
  using (true);

drop policy if exists "lesson_blocks_staff_write" on public.lesson_blocks;
create policy "lesson_blocks_staff_write" on public.lesson_blocks
  for all to authenticated
  using (
    exists (select 1 from public.profiles p
             where p.id = auth.uid() and p.role = 'staff')
  )
  with check (
    exists (select 1 from public.profiles p
             where p.id = auth.uid() and p.role = 'staff')
  );

-- ---------- 4. REORDER RPC -------------------------------------------------
-- Accepts a jsonb array of {id, order_index} and updates them in one round
-- trip. Caller must be staff. Blocks must all belong to the same lesson
-- (we don't enforce that server-side here, but the staff page always calls
-- it with blocks from a single lesson).

create or replace function public.reorder_lesson_blocks(updates jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  item jsonb;
  caller_role text;
begin
  select role into caller_role from public.profiles where id = auth.uid();
  if caller_role is distinct from 'staff' then
    raise exception 'staff role required';
  end if;

  if jsonb_typeof(updates) <> 'array' then
    raise exception 'updates must be a jsonb array';
  end if;

  for item in select * from jsonb_array_elements(updates)
  loop
    update public.lesson_blocks
       set order_index = (item->>'order_index')::int
     where id = (item->>'id')::uuid;
  end loop;
end;
$$;

grant execute on function public.reorder_lesson_blocks(jsonb) to authenticated;

-- ---------- 5. SEED THE 22 SUBJECTS FROM index.html -----------------------
-- Idempotent: re-runs don't duplicate.
--
-- (name, exam_board, level, color_key) — color_key matches the CSS classes
-- already used on dashboard.html so the staff page can reuse them.

insert into public.subjects (name, exam_board, level, color_key, sort_order) values
  ('Mathematics',         'AQA',     'gcse',    'maths',  1),
  ('Mathematics',         'Edexcel', 'gcse',    'maths',  2),
  ('Mathematics',         'OCR',     'gcse',    'maths',  3),
  ('Further Mathematics', 'AQA',     'a-level', 'maths',  4),
  ('English Language',    'AQA',     'gcse',    'eng',    5),
  ('English Literature',  'AQA',     'gcse',    'eng',    6),
  ('Biology',             'AQA',     'gcse',    'bio',    7),
  ('Biology',             'AQA',     'a-level', 'bio',    8),
  ('Chemistry',           'AQA',     'gcse',    'chem',   9),
  ('Chemistry',           'OCR',     'a-level', 'chem',  10),
  ('Physics',             'AQA',     'gcse',    'phys',  11),
  ('Physics',             'AQA',     'a-level', 'phys',  12),
  ('Combined Science',    'AQA',     'gcse',    'bio',   13),
  ('History',             'AQA',     'gcse',    'hist',  14),
  ('History',             'Edexcel', 'gcse',    'hist',  15),
  ('Geography',           'AQA',     'gcse',    'geog',  16),
  ('Psychology',          'AQA',     'a-level', 'psych', 17),
  ('Sociology',           'AQA',     'a-level', 'psych', 18),
  ('Religious Studies',   'AQA',     'gcse',    'chem',  19),
  ('Computer Science',    'AQA',     'gcse',    'geog',  20),
  ('French',              'AQA',     'gcse',    'eng',   21),
  ('Spanish',             'AQA',     'gcse',    'eng',   22),
  ('German',              'AQA',     'gcse',    'eng',   23),
  ('Business',            'Edexcel', 'gcse',    'phys',  24),
  ('Economics',           'AQA',     'a-level', 'chem',  25),
  ('Media Studies',       'AQA',     'gcse',    'psych', 26),
  ('PE',                  'AQA',     'gcse',    'bio',   27),
  ('Latin',               'OCR',     'gcse',    'maths', 28)
on conflict (name, exam_board, level) do nothing;

-- ============================================================================
-- DONE. To promote a user to staff (run once per teammate):
--
--   update public.profiles
--      set role = 'staff'
--    where id = 'PASTE-THEIR-USER-ID-HERE';
--
-- (Find a user id in Supabase dashboard → Authentication → Users. Or run
--   select id, email from auth.users;  to find it.)
--
-- Then sign in as that user, open staff.html, and start authoring.
-- ============================================================================
