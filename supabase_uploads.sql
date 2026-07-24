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
-- one of the staff roles ('staff_author' / 'staff_reviewer' / 'admin') set
-- on profiles.role. The legacy 'staff' literal is no longer valid — the
-- role enum was widened in supabase_admin.sql to four values, so any
-- policy still checking role = 'staff' will silently reject every real
-- user (the WITH CHECK fails, the upload returns
-- "new row violates row-level security policy", and the editor shows
-- "Upload failed" in the toast). Re-run supabase_uploads.sql after pulling
-- these changes to drop and recreate the policies with the right
-- allowlist.
drop policy if exists "lesson_images_staff_write" on storage.objects;
create policy "lesson_images_staff_write" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'lesson-images'
    and (storage.foldername(name))[1] = 'lessons'
    and exists (
      select 1 from public.profiles p
      where p.id = auth.uid()
        and p.role in ('staff_author', 'staff_reviewer', 'admin')
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

-- ---------- 2b. LESSON-AUDIO BUCKET + POLICIES ----------------------------
-- The audio block in the lesson creator (see handleAudioUpload in
-- lesson-creator.html) uploads to the 'lesson-audio' bucket. The bucket
-- wasn't created by the original supabase_uploads.sql — the audio
-- Upload button would fail with "bucket not found" on first click. Same
-- RLS pattern as the image bucket: public read, staff-only writes under
-- the 'lessons/' prefix, owner-scoped update + delete.
insert into storage.buckets (id, name, public)
values ('lesson-audio', 'lesson-audio', true)
on conflict (id) do nothing;

drop policy if exists "lesson_audio_read_all" on storage.objects;
create policy "lesson_audio_read_all" on storage.objects
  for select to anon, authenticated
  using (bucket_id = 'lesson-audio');

drop policy if exists "lesson_audio_staff_write" on storage.objects;
create policy "lesson_audio_staff_write" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'lesson-audio'
    and (storage.foldername(name))[1] = 'lessons'
    and exists (
      select 1 from public.profiles p
      where p.id = auth.uid()
        and p.role in ('staff_author', 'staff_reviewer', 'admin')
    )
  );

drop policy if exists "lesson_audio_staff_update" on storage.objects;
create policy "lesson_audio_staff_update" on storage.objects
  for update to authenticated
  using (
    bucket_id = 'lesson-audio'
    and owner = auth.uid()
  )
  with check (
    bucket_id = 'lesson-audio'
    and owner = auth.uid()
  );

drop policy if exists "lesson_audio_staff_delete" on storage.objects;
create policy "lesson_audio_staff_delete" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'lesson-audio'
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
    'audio','divider','quote','cardset','steps','categorise',
    -- 1 new block kind (2026-07-15) — interactive HTML/JS (sandboxed iframe)
    'html',
    -- 1 new block kind (2026-07-16) — denary → binary conversion (toggleable bits)
    'denary_binary',
    -- 5 new interactive kinds (2026-07-24) — slider, dial, sequence, connect, pile
    'slider','dial','sequence','connect','pile',
    -- 3 new study aids (2026-07-24) — mindmap, flashcard_stack, progress_meter
    'mindmap','flashcard_stack','progress_meter'
  ));

-- ============================================================================
-- DONE.
--
-- After running this, make sure your user has one of the staff roles on
-- profiles.role. The legacy 'staff' literal was retired by supabase_admin.sql
-- — set 'staff_author' for content authors, 'staff_reviewer' for reviewers,
-- or 'admin' for full access. Example:
--
--   update public.profiles
--      set role = 'staff_author'
--    where id = 'PASTE-USER-ID';
--
-- Then sign in, open staff.html, and start authoring. The image block
-- has an "Upload" button that uses the lesson-images bucket, the audio
-- block uses the lesson-audio bucket, and the block picker shows the
-- 15 new kinds.
-- ============================================================================
