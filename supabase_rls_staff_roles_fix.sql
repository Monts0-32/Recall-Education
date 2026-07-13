-- ============================================================================
-- supabase_rls_staff_roles_fix.sql
--
-- One-off patch for projects that ran supabase_staff.sql BEFORE
-- supabase_admin.sql, or where supabase_admin.sql was edited/skipped.
--
-- supabase_staff.sql ships these policies with `role = 'staff'`, which
-- was the only staff role at the time. supabase_admin.sql widens the
-- role enum to {student, staff_author, staff_reviewer, admin} and
-- rewrites the same policies to use `role in (...)`. If you set up the
-- project with the staff role names in place from the start, the
-- rewritten policies are what's already in the database. If you set up
-- the project against the old code, the narrow policies are still in
-- place — staff_author accounts then fail the WITH CHECK and writes
-- are silently filtered out by RLS (no error returned, but the row
-- never lands in the table).
--
-- This file is idempotent: re-running it just re-creates the policies.
-- Run it once in the Supabase SQL editor and the staff creator's
-- "Save blocks" button will start persisting again.
-- ============================================================================

drop policy if exists "subjects_staff_write"        on public.subjects;
drop policy if exists "topics_staff_write"          on public.topics;
drop policy if exists "lessons_staff_write"         on public.lessons;
drop policy if exists "lesson_blocks_staff_write"   on public.lesson_blocks;

create policy "subjects_staff_write" on public.subjects
  for all to authenticated
  using (exists (
    select 1 from public.profiles p
     where p.id = auth.uid()
       and p.role in ('staff_author', 'staff_reviewer', 'admin')
  ))
  with check (exists (
    select 1 from public.profiles p
     where p.id = auth.uid()
       and p.role in ('staff_author', 'staff_reviewer', 'admin')
  ));

create policy "topics_staff_write" on public.topics
  for all to authenticated
  using (exists (
    select 1 from public.profiles p
     where p.id = auth.uid()
       and p.role in ('staff_author', 'staff_reviewer', 'admin')
  ))
  with check (exists (
    select 1 from public.profiles p
     where p.id = auth.uid()
       and p.role in ('staff_author', 'staff_reviewer', 'admin')
  ));

create policy "lessons_staff_write" on public.lessons
  for all to authenticated
  using (exists (
    select 1 from public.profiles p
     where p.id = auth.uid()
       and p.role in ('staff_author', 'staff_reviewer', 'admin')
  ))
  with check (exists (
    select 1 from public.profiles p
     where p.id = auth.uid()
       and p.role in ('staff_author', 'staff_reviewer', 'admin')
  ));

create policy "lesson_blocks_staff_write" on public.lesson_blocks
  for all to authenticated
  using (exists (
    select 1 from public.profiles p
     where p.id = auth.uid()
       and p.role in ('staff_author', 'staff_reviewer', 'admin')
  ))
  with check (exists (
    select 1 from public.profiles p
     where p.id = auth.uid()
       and p.role in ('staff_author', 'staff_reviewer', 'admin')
  ));

-- Same fix for the public read on lessons. supabase_staff.sql had
-- "lessons_read_all" (everything public); supabase_admin.sql replaces
-- it with "lessons_read_published" (only published lessons visible to
-- non-staff). If your project is still on the old policy, staff
-- creators see every lesson as published-equivalent in the dashboard,
-- but the editor and student player behave the same. Recreate the
-- published-aware read so the editor and the dashboard agree.
drop policy if exists "lessons_read_all"           on public.lessons;
drop policy if exists "lessons_read_published"     on public.lessons;
drop policy if exists "lessons_staff_read_all"     on public.lessons;
create policy "lessons_read_published" on public.lessons for select
  to anon, authenticated
  using (
    status = 'published'
    or exists (
      select 1 from public.profiles p
       where p.id = auth.uid()
         and p.role in ('staff_author', 'staff_reviewer', 'admin')
    )
  );
