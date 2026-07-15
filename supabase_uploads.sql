-- ============================================================================
-- Recall Education — Uploads + new block kinds
-- Run this AFTER supabase_setup.sql, supabase_tables.sql, and
-- supabase_staff.sql in the Supabase SQL editor. Idempotent: safe to re-run.
--
-- Adds:
--   • storage bucket 'lesson-images' (public read) for inline image uploads
--   • staff-only RLS policies on storage.objects scoped to that bucket
--   • widened lesson_blocks.kind CHECK to include 15 new block kinds:
--       interactive practice: mcq, truefalse, shortanswer, fillblank,
--                             match, ordering, hotspot
--       layout & structure:   accordion, tabs, compare, timeline
--       study aids:           objectives, prerequisites, glossary, summary
-- ============================================================================

-- ---------- 1. STORAGE BUCKET ----------------------------------------------

insert into storage.buckets (id, name, public)
values ('lesson-images', 'lesson-images', true)
on conflict (id) do nothing;

-- ---------- 2. STORAGE RLS -------------------------------------------------

-- Public read so <img src="..."> works without signed URLs.
drop policy if exists "lesson_images_read_all" on storage.objects;
create policy "lesson_images_read_all" on storage.objects
  for select to anon, authenticated
  using (bucket_id = 'lesson-images');

-- Staff write: object path must start with 'lessons/', caller must have
-- profile.role = 'staff'. Update is allowed under the same conditions so
-- staff can swap an uploaded file.
drop policy if exists "lesson_images_staff_write" on storage.objects;
create policy "lesson_images_staff_write" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'lesson-images'
    and (storage.foldername(name))[1] = 'lessons'
    and exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role = 'staff'
    )
  );

drop policy if exists "lesson_images_staff_update" on storage.objects;
create policy "lesson_images_staff_update" on storage.objects
  for update to authenticated
  using (
    bucket_id = 'lesson-images'
    and owner = auth.uid()
  )
  with check (
    bucket_id = 'lesson-images'
    and owner = auth.uid()
  );

-- Staff can delete their own uploads.
drop policy if exists "lesson_images_staff_delete" on storage.objects;
create policy "lesson_images_staff_delete" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'lesson-images'
    and owner = auth.uid()
  );

-- ---------- 3. WIDEN lesson_blocks.kind CHECK ------------------------------
-- The CHECK is anonymous-named by Postgres by default. We drop it by
-- querying pg_constraint so we don't have to hard-code the generated name.

do $$
declare
  cname text;
begin
  select con.conname into cname
  from pg_constraint con
  join pg_class rel on rel.oid = con.conrelid
  where rel.relname = 'lesson_blocks'
    and con.contype = 'c'
    and pg_get_constraintdef(con.oid) ilike '%kind%';
  if cname is not null then
    execute 'alter table public.lesson_blocks drop constraint ' || quote_ident(cname);
  end if;
end $$;

alter table public.lesson_blocks
  add constraint lesson_blocks_kind_check
  check (kind in (
    -- existing 10
    'heading','text','callout','image','video',
    'math','keypoints','worked_example','reveal','flashcard',
    -- interactive practice (7)
    'mcq','truefalse','shortanswer','fillblank','match','ordering','hotspot',
    -- layout & structure (4)
    'accordion','tabs','compare','timeline',
    -- study aids (4)
    'objectives','prerequisites','glossary','summary',
    -- 6 new block kinds (2026-07)
    'audio','divider','quote','cardset','steps','categorise'
  ));

-- ============================================================================
-- DONE.
--
-- After running this, promote a user to staff if you haven't already:
--
--   update public.profiles
--      set role = 'staff'
--    where id = 'PASTE-USER-ID';
--
-- Then sign in, open staff.html, and start authoring. The image block now
-- has an "Upload" button that uses this bucket, and the block picker shows
-- the 15 new kinds.
-- ============================================================================
