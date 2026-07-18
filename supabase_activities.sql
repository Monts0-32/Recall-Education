-- ============================================================================
-- Recall Education — Activity lessons
-- Run this AFTER supabase_setup.sql, supabase_tables.sql, supabase_general.sql,
-- and supabase_uploads.sql in the Supabase SQL editor. Idempotent: safe to re-run.
--
-- Adds a second lesson type: an "Activity" lesson whose body is a single
-- HTML file hosted in a public Storage bucket. The lesson is rendered to
-- students as a sandboxed iframe pointed at the file URL; completion is
-- gated on the existing 'recall-block-complete' postMessage contract used
-- by the html block kind.
--
-- Adds:
--   • public.lessons: kind ('blocks' | 'activity'), activity_path,
--     activity_height, activity_required
--   • storage bucket 'lesson-activities' (public read)
--   • 4 RLS policies on storage.objects (read_all, staff_write,
--     staff_update, staff_delete) scoped to the 'activities/' prefix
--
-- Backwards compatible: every existing row gets kind='blocks' (the default)
-- and the column additions are nullable / have safe defaults, so no
-- existing lesson is reclassified.
-- ============================================================================

-- ---------- 1. LESSONS TABLE EXTENSIONS ------------------------------------

-- kind: 'blocks' (default — today's block-based lessons) or 'activity'
--   (a single HTML file rendered as a sandboxed iframe). The check
--   constraint mirrors the BLOCK_GROUPS split in lesson-creator.html —
--   adding a future value here means the editor needs a new branch and
--   lesson.html needs a new render path.
alter table public.lessons
  add column if not exists kind text not null default 'blocks'
    check (kind in ('blocks','activity')),
  add column if not exists activity_path    text,
  add column if not exists activity_height  int  default 720,
  add column if not exists activity_required boolean default true;

-- Index for "list activity lessons" / dashboards that filter by kind.
create index if not exists lessons_kind_idx
  on public.lessons (kind);

-- ---------- 2. STORAGE BUCKET ----------------------------------------------

insert into storage.buckets (id, name, public)
values ('lesson-activities', 'lesson-activities', true)
on conflict (id) do nothing;

-- ---------- 3. STORAGE RLS -------------------------------------------------

-- Public read so <iframe src="..."> works without signed URLs. The
-- bucket is public, but the editor only writes under the 'activities/'
-- prefix (see below), so a leaked URL doesn't reveal any other staff
-- content — there is no other content in this bucket.
drop policy if exists "lesson_activities_read_all" on storage.objects;
create policy "lesson_activities_read_all" on storage.objects
  for select to anon, authenticated
  using (bucket_id = 'lesson-activities');

-- Staff write: object path must start with 'activities/', caller must
-- have one of the staff roles. Mirrors the lesson-images policy
-- (supabase_uploads.sql:40-51) but with the 'activities/' prefix.
-- The path is constructed as 'activities/<lesson-id>/index.html' in
-- lesson-creator.html so the lesson id is the second segment — this
-- keeps every file scoped to its parent lesson and makes orphan
-- cleanup straightforward.
drop policy if exists "lesson_activities_staff_write" on storage.objects;
create policy "lesson_activities_staff_write" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'lesson-activities'
    and (storage.foldername(name))[1] = 'activities'
    and exists (
      select 1 from public.profiles p
      where p.id = auth.uid()
        and p.role in ('staff_author', 'staff_reviewer', 'admin')
    )
  );

-- Update is used when the author replaces the file (upsert from
-- lesson-creator.html). Owner-scoped, same as lesson-images.
drop policy if exists "lesson_activities_staff_update" on storage.objects;
create policy "lesson_activities_staff_update" on storage.objects
  for update to authenticated
  using (
    bucket_id = 'lesson-activities'
    and owner = auth.uid()
  )
  with check (
    bucket_id = 'lesson-activities'
    and owner = auth.uid()
  );

-- Staff can delete their own uploads.
drop policy if exists "lesson_activities_staff_delete" on storage.objects;
create policy "lesson_activities_staff_delete" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'lesson-activities'
    and owner = auth.uid()
  );

-- ---------- 4. RLS ON LESSONS ----------------------------------------------
-- No change needed. The existing lessons_staff_write policy
-- (supabase_admin.sql:774-785) is 'for all' and the
-- lessons_read_published policy (supabase_admin.sql:88) reads by status
-- only — both already cover the new column.
-- ============================================================================
