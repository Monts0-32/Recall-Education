-- supabase_boards_redesign.sql
--
-- Run in the Supabase SQL editor. Idempotent — safe to re-run.
--
-- What this migration does:
--   1. Adds an exam_boards.kind column ('exam_board' | 'course' | 'curriculum')
--      so the system can distinguish GCSE/A-level exam boards from custom
--      non-exam-board courses from the new explicit Curriculum base board.
--
--   2. Adds a subject_boards many-to-many join table so a subject can have
--      any number of boards attached, instead of being pinned to a single
--      board name by subjects.exam_board (which stays as legacy text).
--
--   3. Inserts the 'Curriculum' base board row (kind='curriculum').
--
--   4. Backfills subject_boards: every existing subject is linked to the
--      new Curriculum board so it shows up in subjects.html automatically.
--
--   5. PREVIEW (read-only): shows which existing units would be moved to
--      the new Curriculum board. Inspect the output before continuing.
--
--   6. APPLY (writes): reassigns units.name='Curriculum' from their old
--      (subject, board=subject.exam_board, year=Year 10/12) location to
--      the new (subject, Curriculum board, same year) location. Topics
--      follow automatically because they point at units by FK.
--
--   7. Idempotency: every step uses if not exists / on conflict so a
--      second run is a no-op.
--
-- ============================================================================

set search_path = public;

-- ---------- 1. exam_boards.kind -------------------------------------------

alter table public.exam_boards
  add column if not exists kind text not null default 'exam_board'
    check (kind in ('exam_board', 'course', 'curriculum'));

comment on column public.exam_boards.kind is
  'exam_board = GCSE/A-level board (auto Years 10+11 or 12+13); '
  'course = author-defined non-exam-board (auto picked years 7-13); '
  'curriculum = the base Curriculum board (auto Years 7+8+9).';

-- ---------- 2. subject_boards join table ----------------------------------

create table if not exists public.subject_boards (
  subject_id    uuid not null references public.subjects(id)   on delete cascade,
  exam_board_id uuid not null references public.exam_boards(id) on delete cascade,
  added_by      uuid references auth.users(id),
  added_at      timestamptz not null default now(),
  primary key (subject_id, exam_board_id)
);

create index if not exists subject_boards_board_idx
  on public.subject_boards (exam_board_id);

alter table public.subject_boards enable row level security;

drop policy if exists subject_boards_read_all on public.subject_boards;
create policy subject_boards_read_all on public.subject_boards
  for select to anon, authenticated using (true);

comment on table public.subject_boards is
  'Per-subject board assignment. Every subject must be linked to the Curriculum board; '
  'additional boards (exam_board or course) are linked when an author creates them.';

-- ---------- 3. Seed the Curriculum base board -----------------------------

insert into public.exam_boards (name, country, kind)
values ('Curriculum', 'UK', 'curriculum')
on conflict (name) do update set kind = excluded.kind;

-- ---------- 4. Backfill subject_boards for every existing subject --------

insert into public.subject_boards (subject_id, exam_board_id)
select s.id, b.id
  from public.subjects s
  cross join public.exam_boards b
 where b.kind = 'curriculum'
   and b.name = 'Curriculum'
on conflict do nothing;

-- ---------- 5. PREVIEW: which units will move -----------------------------
-- Run this read-only query FIRST. It shows every unit currently named
-- 'Curriculum' that lives under one of the old per-subject boards. Those
-- rows are the ones the APPLY step below will reassign. If the list looks
-- wrong (e.g. your real Curriculum unit is named something else), STOP
-- here and either rename the unit or edit this migration before running.

/*
select
  s.name         as subject,
  b_old.name     as current_board,
  y.label        as year,
  u.name         as unit_name,
  u.id           as unit_id,
  (select b_new.name from public.exam_boards b_new
    where b_new.kind = 'curriculum' limit 1) as will_move_to
from public.units u
join public.subjects   s     on s.id = u.subject_id
join public.exam_boards b_old on b_old.id = u.exam_board_id
join public.year_levels y     on y.id  = u.year_id
where u.name = 'Curriculum'
  and b_old.kind <> 'curriculum'
order by s.name, b_old.name, y.sort_order;
*/

-- ---------- 6. APPLY: move existing Curriculum-named units ---------------
-- The APPLY block is COMMENTED OUT by default. After running section 5
-- above and confirming the preview matches what you expect, uncomment
-- this block (or paste it into the SQL editor) and execute it once.
--
-- The CTE updates units.name='Curriculum' rows whose exam_board_id points
-- at an old per-subject board to point at the new Curriculum board
-- instead. Topics.unit_id follows automatically because of the FK.

/*
with curriculum_board as (
  select id from public.exam_boards where kind = 'curriculum' limit 1
),
moved as (
  update public.units u
     set exam_board_id = (select id from curriculum_board)
   where u.name = 'Curriculum'
     and u.exam_board_id in (
       select b.id from public.exam_boards b where b.kind <> 'curriculum'
     )
  returning u.id
)
select count(*) as units_moved from moved;
*/

-- ---------- 7. Diagnostic: see the new board layout ----------------------
-- Run after the APPLY step. Every subject should show a Curriculum row
-- with the auto-created Year 7/8/9 (and Year 10/12 if you had lessons
-- there previously).

/*
select
  s.name         as subject,
  b.name         as board,
  b.kind         as board_kind,
  y.label        as year,
  count(u.id)    as unit_count,
  count(l.id)    as lesson_count
from public.subjects s
left join public.subject_boards sb on sb.subject_id = s.id
left join public.exam_boards   b  on b.id = sb.exam_board_id
left join public.units         u  on u.subject_id = s.id
                                 and u.exam_board_id = b.id
left join public.year_levels   y  on y.id = u.year_id
left join public.topics        t  on t.unit_id = u.id
left join public.lessons       l  on l.topic_id = t.id
                               and l.status = 'published'
                               and l.is_general is false
group by s.name, b.name, b.kind, y.label
order by s.name,
         case b.kind when 'curriculum' then 0 when 'exam_board' then 1 else 2 end,
         b.name, y.sort_order;
*/
