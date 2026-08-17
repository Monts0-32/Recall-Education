-- ============================================================================
-- Recall Education — Notifications + comment-resolve workflow
-- Run this AFTER supabase_review_evaluations.sql. Idempotent: safe to re-run.
--
-- What this adds:
--   1. public.notifications — one row per user-facing event (resolve
--      request, resolve confirmation, admin action, etc.). Realtime-
--      enabled for live bell updates.
--   2. RLS: recipient reads + updates own rows; client inserts denied
--      (writes only via SECURITY DEFINER RPCs).
--   3. public.push_notification() / list_unread_notifications() /
--      mark_notification_read() / mark_all_notifications_read() RPCs.
--   4. Adds pending_resolve boolean to public.lesson_block_comments.
--   5. request_resolve_comment() — author requests the reviewer
--      confirm.
--   6. confirm_resolve_comment() — the original reviewer confirms.
--   7. admin_resolve_comment() — admin bypasses the two-step flow.
-- ============================================================================

-- ---------- 1. TABLE -------------------------------------------------------

create table if not exists public.notifications (
  id            uuid primary key default gen_random_uuid(),
  recipient_id  uuid not null references auth.users(id) on delete cascade,
  kind          text not null,
  ref_id        uuid,
  body          text not null,
  read_at       timestamptz,
  created_at    timestamptz not null default now()
);

create index if not exists notifications_recipient_idx
  on public.notifications (recipient_id, created_at desc);
create index if not exists notifications_unread_idx
  on public.notifications (recipient_id)
  where read_at is null;

alter table public.notifications enable row level security;

-- ---------- 2. RLS ---------------------------------------------------------

-- Recipient reads their own notifications.
drop policy if exists "notifications_own_read" on public.notifications;
create policy "notifications_own_read" on public.notifications
  for select to authenticated
  using (recipient_id = auth.uid());

-- Recipient marks their own notifications read.
drop policy if exists "notifications_own_update" on public.notifications;
create policy "notifications_own_update" on public.notifications
  for update to authenticated
  using  (recipient_id = auth.uid())
  with check (recipient_id = auth.uid());

-- Block direct client inserts — only RPCs may write.
drop policy if exists "notifications_no_client_insert" on public.notifications;
create policy "notifications_no_client_insert" on public.notifications
  for insert to authenticated
  with check (false);

-- Block client deletes — read+update only.
drop policy if exists "notifications_no_client_delete" on public.notifications;
create policy "notifications_no_client_delete" on public.notifications
  for delete to authenticated
  using (false);

-- ---------- 3. NOTIFICATION RPCS ------------------------------------------

-- Push a notification row. SECURITY DEFINER so any caller can write to
-- any recipient — but in practice we always call it from within other
-- SECURITY DEFINER RPCs that have already verified the caller.
create or replace function public.push_notification(
  p_recipient_id uuid,
  p_kind         text,
  p_ref_id       uuid,
  p_body         text
)
returns public.notifications
language plpgsql
security definer
set search_path = public
as $$
declare
  n public.notifications;
begin
  if p_recipient_id is null then
    raise exception 'recipient_id is required' using errcode = '22023';
  end if;
  if p_kind is null or length(trim(p_kind)) = 0 then
    raise exception 'kind is required' using errcode = '22023';
  end if;
  if p_body is null or length(trim(p_body)) = 0 then
    raise exception 'body is required' using errcode = '22023';
  end if;
  insert into public.notifications
         (recipient_id, kind, ref_id, body)
  values (p_recipient_id, p_kind, p_ref_id, p_body)
  returning * into n;
  return n;
end $$;

grant execute on function public.push_notification(uuid, text, uuid, text)
  to authenticated;

-- Read up to p_limit unread notifications for the caller.
create or replace function public.list_unread_notifications(p_limit int default 30)
returns table (
  id          uuid,
  kind        text,
  ref_id      uuid,
  body        text,
  created_at  timestamptz
)
language sql
security definer
set search_path = public
stable
as $$
  select id, kind, ref_id, body, created_at
    from public.notifications
   where recipient_id = auth.uid()
     and read_at is null
   order by created_at desc
   limit greatest(p_limit, 1);
$$;

grant execute on function public.list_unread_notifications(int)
  to authenticated;

-- Read up to p_limit recent notifications (read + unread), used for the
-- dropdown panel when the user wants to see history.
create or replace function public.list_recent_notifications(p_limit int default 50)
returns table (
  id          uuid,
  kind        text,
  ref_id      uuid,
  body        text,
  created_at  timestamptz,
  read_at     timestamptz
)
language sql
security definer
set search_path = public
stable
as $$
  select id, kind, ref_id, body, created_at, read_at
    from public.notifications
   where recipient_id = auth.uid()
   order by created_at desc
   limit greatest(p_limit, 1);
$$;

grant execute on function public.list_recent_notifications(int)
  to authenticated;

-- Mark a single notification read.
create or replace function public.mark_notification_read(p_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update public.notifications
     set read_at = now()
   where id = p_id
     and recipient_id = auth.uid()
     and read_at is null;
$$;

grant execute on function public.mark_notification_read(uuid)
  to authenticated;

-- Mark all of the caller's unread notifications read.
create or replace function public.mark_all_notifications_read()
returns int
language sql
security definer
set search_path = public
as $$
  with upd as (
    update public.notifications
       set read_at = now()
     where recipient_id = auth.uid()
       and read_at is null
     returning 1 as x
  )
  select count(*)::int from upd;
$$;

grant execute on function public.mark_all_notifications_read()
  to authenticated;

-- ---------- 4. RESOLVE-WORKFLOW COLUMN ------------------------------------

alter table public.lesson_block_comments
  add column if not exists pending_resolve boolean not null default false;

-- ---------- 5. RESOLVE RPCS ------------------------------------------------
--
-- Two-step resolve workflow:
--   (a) Author clicks "Mark resolved"  -> request_resolve_comment()
--       flips pending_resolve=true and notifies the original reviewer.
--   (b) Reviewer clicks "Confirm resolved" -> confirm_resolve_comment()
--       flips resolved=true and notifies the lesson author.
--
-- Admin bypass: admin_resolve_comment() flips resolved=true directly
-- and notifies both parties.

-- (a) Author requests resolve.
create or replace function public.request_resolve_comment(p_comment_id uuid)
returns public.lesson_block_comments
language plpgsql
security definer
set search_path = public
as $$
declare
  c              public.lesson_block_comments;
  v_caller       uuid := auth.uid();
  v_lesson_id    uuid;
  v_lesson_author uuid;
begin
  if v_caller is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;

  -- Look up the comment + lesson author.
  select c2.id, c2.author_id, c2.lesson_id
    into c.id, c.author_id, v_lesson_id
    from public.lesson_block_comments c2
   where c2.id = p_comment_id;
  if c.id is null then
    raise exception 'Comment not found' using errcode = 'P0002';
  end if;

  select l.author_id into v_lesson_author
    from public.lessons l where l.id = v_lesson_id;
  if v_lesson_author is null then
    raise exception 'Lesson not found' using errcode = 'P0002';
  end if;

  -- Caller must be the lesson author.
  if v_caller <> v_lesson_author then
    raise exception 'Only the lesson author can request resolve'
      using errcode = '42501';
  end if;

  -- Don't re-request if already resolved.
  if c.resolved then
    raise exception 'Comment is already resolved'
      using errcode = 'P0001';
  end if;

  update public.lesson_block_comments
     set pending_resolve = true,
         resolved        = false,
         updated_at      = now()
   where id = p_comment_id
   returning * into c;

  -- Notify the reviewer who left the comment.
  perform public.push_notification(
    c.author_id,
    'comment_resolve_requested',
    c.id,
    'Author requested resolve on a comment you left.'
  );

  return c;
end $$;

grant execute on function public.request_resolve_comment(uuid)
  to authenticated;

-- (b) Reviewer confirms resolve.
create or replace function public.confirm_resolve_comment(p_comment_id uuid)
returns public.lesson_block_comments
language plpgsql
security definer
set search_path = public
as $$
declare
  c                public.lesson_block_comments;
  v_caller         uuid := auth.uid();
  v_lesson_id      uuid;
  v_lesson_author  uuid;
begin
  if v_caller is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;

  -- Look up the comment.
  select c2.id, c2.author_id, c2.lesson_id, c2.pending_resolve
    into c.id, c.author_id, v_lesson_id, c.pending_resolve
    from public.lesson_block_comments c2
   where c2.id = p_comment_id;
  if c.id is null then
    raise exception 'Comment not found' using errcode = 'P0002';
  end if;

  -- Caller must be the original reviewer.
  if v_caller <> c.author_id then
    raise exception 'Only the original reviewer can confirm resolve'
      using errcode = '42501';
  end if;

  -- Must currently be pending.
  if not c.pending_resolve then
    raise exception 'No pending resolve on this comment'
      using errcode = 'P0001';
  end if;

  update public.lesson_block_comments
     set resolved        = true,
         pending_resolve = false,
         updated_at      = now()
   where id = p_comment_id
   returning * into c;

  -- Notify the lesson author.
  select l.author_id into v_lesson_author
    from public.lessons l where l.id = v_lesson_id;
  if v_lesson_author is not null then
    perform public.push_notification(
      v_lesson_author,
      'comment_resolved',
      c.id,
      'A reviewer confirmed one of your resolve requests.'
    );
  end if;

  return c;
end $$;

grant execute on function public.confirm_resolve_comment(uuid)
  to authenticated;

-- (c) Admin bypass — resolve directly.
create or replace function public.admin_resolve_comment(p_comment_id uuid)
returns public.lesson_block_comments
language plpgsql
security definer
set search_path = public
as $$
declare
  c                public.lesson_block_comments;
  v_caller         uuid := auth.uid();
  v_lesson_id      uuid;
  v_lesson_author  uuid;
begin
  if v_caller is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;

  -- Caller must be an active admin.
  if not exists (
    select 1 from public.profiles p
     where p.id = v_caller
       and p.role = 'admin'
       and p.deleted_at is null
  ) then
    raise exception 'Admins only' using errcode = '42501';
  end if;

  -- Look up the comment + lesson.
  select c2.id, c2.author_id, c2.lesson_id
    into c.id, c.author_id, v_lesson_id
    from public.lesson_block_comments c2
   where c2.id = p_comment_id;
  if c.id is null then
    raise exception 'Comment not found' using errcode = 'P0002';
  end if;

  update public.lesson_block_comments
     set resolved        = true,
         pending_resolve = false,
         updated_at      = now()
   where id = p_comment_id
   returning * into c;

  select l.author_id into v_lesson_author
    from public.lessons l where l.id = v_lesson_id;

  -- Notify both parties.
  if v_lesson_author is not null then
    perform public.push_notification(
      v_lesson_author,
      'comment_resolved_by_admin',
      c.id,
      'An admin resolved a reviewer comment on your lesson.'
    );
  end if;
  perform public.push_notification(
    c.author_id,
    'comment_resolved_by_admin',
    c.id,
    'An admin resolved one of your comments.'
  );

  return c;
end $$;

grant execute on function public.admin_resolve_comment(uuid)
  to authenticated;
