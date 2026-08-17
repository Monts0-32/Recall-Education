-- ============================================================================
-- Recall Education — Reviewer evaluations + admin lessons RPC
-- Run this AFTER supabase_setup.sql, supabase_tables.sql, supabase_staff.sql,
-- supabase_uploads.sql, supabase_consent_enforcement.sql,
-- supabase_dashboard.sql, and supabase_admin.sql. Idempotent: safe to re-run.
--
-- What this adds:
--   1. public.lesson_reviews — one row per (lesson, reviewer) "active"
--      evaluation. Reviewers rate the lesson 1–5 stars, attach an
--      optional note and tag chips, and submit. Re-submitting marks the
--      prior row 'superseded' so history is preserved.
--   2. RLS: only reviewers may write; authors and admins can read.
--   3. public.submit_lesson_review(lesson_id, rating, note, tags) RPC
--      that upserts the active row and returns it.
--   4. public.list_lessons_for_admin() RPC that joins lessons + latest
--      active review + author + reviewer names. Sorted so that drafts
--      with an active evaluation come first, then drafts without, then
--      everything else by recency. Drives the admin.html Lessons list.
-- ============================================================================

-- ---------- 1. TABLE -------------------------------------------------------

create table if not exists public.lesson_reviews (
  id            uuid primary key default gen_random_uuid(),
  lesson_id     uuid not null references public.lessons(id) on delete cascade,
  reviewer_id   uuid not null references auth.users(id)    on delete cascade,
  rating        smallint not null check (rating between 1 and 5),
  note          text,
  tags          text[] not null default '{}',
  status        text not null default 'submitted'
                check (status in ('submitted','superseded','withdrawn')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- One *active* evaluation per (lesson, reviewer). Older rows live on
-- with status='superseded' for audit history. Partial unique index so
-- withdrawn / superseded rows don't conflict.
create unique index if not exists lesson_reviews_one_active_per_pair
  on public.lesson_reviews (lesson_id, reviewer_id)
  where status = 'submitted';

create index if not exists lesson_reviews_lesson_idx
  on public.lesson_reviews (lesson_id, created_at desc);
create index if not exists lesson_reviews_reviewer_idx
  on public.lesson_reviews (reviewer_id, created_at desc);

alter table public.lesson_reviews enable row level security;

-- ---------- 2. RLS ---------------------------------------------------------

-- Reviewers can write their own rows. We allow UPDATE so the
-- submit_lesson_review RPC's "supersede prior + insert" can run as a
-- single transaction via the function (which is SECURITY DEFINER).
-- Direct UPDATEs from the client are not used by the app.
drop policy if exists "lesson_reviews_reviewer_write" on public.lesson_reviews;
create policy "lesson_reviews_reviewer_write" on public.lesson_reviews
  for all to authenticated
  using  (reviewer_id = auth.uid())
  with check (
    reviewer_id = auth.uid()
    and exists (
      select 1 from public.profiles p
       where p.id = auth.uid()
         and p.role = 'staff_reviewer'
         and p.deleted_at is null
    )
  );

-- Authors and admins can read every evaluation. Reviewers can read
-- their own (covered by the write policy above).
drop policy if exists "lesson_reviews_staff_read" on public.lesson_reviews;
create policy "lesson_reviews_staff_read" on public.lesson_reviews
  for select to authenticated
  using (
    exists (
      select 1 from public.profiles p
       where p.id = auth.uid()
         and p.role in ('staff_author','admin')
         and p.deleted_at is null
    )
  );

-- ---------- 3. SUBMIT RPC ---------------------------------------------------
-- Upsert semantics: any prior 'submitted' row from this reviewer for
-- this lesson is marked 'superseded', and a fresh 'submitted' row is
-- inserted. Returns the new row so the JS can render "Submitted at
-- HH:MM · 4★ · needs-work" without a second round-trip.

create or replace function public.submit_lesson_review(
  p_lesson_id uuid,
  p_rating    smallint,
  p_note      text,
  p_tags      text[]
)
returns public.lesson_reviews
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller   uuid := auth.uid();
  v_role     text;
  rv         public.lesson_reviews;
begin
  -- Caller must be an active reviewer.
  if v_caller is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;

  select p.role into v_role
    from public.profiles p
   where p.id = v_caller
     and p.deleted_at is null;

  if v_role is null or v_role <> 'staff_reviewer' then
    raise exception 'Only reviewers can submit evaluations'
      using errcode = '42501';
  end if;

  -- Rating sanity (defence in depth on top of the table CHECK).
  if p_rating is null or p_rating < 1 or p_rating > 5 then
    raise exception 'Rating must be between 1 and 5'
      using errcode = '22000';
  end if;

  -- Verify the lesson exists.
  if not exists (select 1 from public.lessons where id = p_lesson_id) then
    raise exception 'Lesson not found' using errcode = 'P0002';
  end if;

  -- Supersede any prior active review from this reviewer.
  update public.lesson_reviews
     set status = 'superseded', updated_at = now()
   where lesson_id = p_lesson_id
     and reviewer_id = v_caller
     and status = 'submitted';

  -- Insert the new active review. Empty/null tags collapse to '{}'.
  insert into public.lesson_reviews
         (lesson_id, reviewer_id, rating, note, tags, status)
  values (p_lesson_id, v_caller, p_rating,
          nullif(trim(coalesce(p_note, '')), ''),
          coalesce(p_tags, '{}'::text[]),
          'submitted')
  returning * into rv;

  return rv;
end $$;

grant execute on function public.submit_lesson_review(uuid, smallint, text, text[])
  to authenticated;

-- ---------- 4. ADMIN LESSONS RPC -------------------------------------------
-- Lists every lesson (limit 200) joined with the latest *active*
-- evaluation (if any). Ordered so the admin's publish queue surfaces
-- the most actionable drafts first:
--
--   bucket 0 — drafts WITH an active evaluation (reviewer's call is in)
--   bucket 1 — drafts without an evaluation
--   bucket 2 — everything else (published / archived), newest first
--
-- SECURITY DEFINER so we can join to auth.users for the reviewer's
-- email without exposing the auth schema to RLS. The function explicitly
-- checks the caller is admin; non-admins get an exception.

create or replace function public.list_lessons_for_admin()
returns table (
  lesson_id            uuid,
  title                text,
  code                 text,
  status               text,
  updated_at           timestamptz,
  topic_name           text,
  subject_name         text,
  author_name          text,
  review_rating        smallint,
  review_note          text,
  review_tags          text[],
  review_submitted_at  timestamptz,
  reviewer_name        text
)
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_caller uuid := auth.uid();
  v_role   text;
begin
  if v_caller is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;

  select p.role into v_role
    from public.profiles p
   where p.id = v_caller
     and p.deleted_at is null;

  if v_role is null or v_role <> 'admin' then
    raise exception 'Admins only' using errcode = '42501';
  end if;

  return query
    with latest_review as (
      select distinct on (lr.lesson_id)
             lr.lesson_id, lr.rating, lr.note, lr.tags,
             lr.created_at, lr.reviewer_id
        from public.lesson_reviews lr
       where lr.status = 'submitted'
       order by lr.lesson_id, lr.created_at desc
    )
    select
        l.id, l.title, l.code, l.status, l.updated_at,
        t.name::text                                as topic_name,
        s.name::text                                as subject_name,
        coalesce(pa.full_name,
                 split_part(ua.email::text, '@', 1)) as author_name,
        r.rating,
        r.note,
        r.tags,
        r.created_at                                as review_submitted_at,
        coalesce(pr.full_name,
                 split_part(ur.email::text, '@', 1)) as reviewer_name
      from public.lessons l
      left join public.topics    t  on t.id  = l.topic_id
      left join public.subjects  s  on s.id  = t.subject_id
      left join public.profiles  pa on pa.id = l.author_id
      left join auth.users       ua on ua.id = l.author_id
      left join latest_review    r  on r.lesson_id = l.id
      left join public.profiles  pr on pr.id = r.reviewer_id
      left join auth.users       ur on ur.id = r.reviewer_id
     order by
        case
          when l.status = 'draft' and r.lesson_id is not null then 0
          when l.status = 'draft'                              then 1
          else                                                     2
        end,
        l.updated_at desc
     limit 200;
end $$;

grant execute on function public.list_lessons_for_admin() to authenticated;
