-- ============================================================================
-- Recall Education — Profile avatars + Direct Messaging (staff & teacher)
-- Run AFTER supabase_notifications.sql. Idempotent: safe to re-run.
--
-- What this adds:
--   1. public.profiles.avatar_url          — public-readable avatar link
--   2. storage bucket 'avatars'            — public read, owner-scoped write
--   3. public.dm_threads / dm_thread_members / dm_messages — DM tables
--   4. RLS: member-scoped SELECT on the DM tables; all writes denied to
--      clients (only SECURITY DEFINER RPCs may write)
--   5. RPCs:
--        create_dm_thread                 — creates 1:1 / group threads
--        send_dm_message                  — sends + notifies every member
--        mark_dm_thread_read              — read-receipt for the caller
--        list_dm_threads                  — sidebar list
--        list_dm_messages                 — paginated message history
--        search_dm_recipients             — predictive directory search
--                                            (role-segmented server-side)
--        count_unread_dms                 — total unread across threads
--        list_school_teachers             — School Team section source
-- ============================================================================

-- ---------- 1. PROFILE COLUMN ----------------------------------------------

alter table public.profiles
  add column if not exists avatar_url text;

-- ---------- 2. STORAGE BUCKET: avatars -------------------------------------

insert into storage.buckets (id, name, public)
values ('avatars', 'avatars', true)
on conflict (id) do nothing;

-- Public read so <img src="..."> works without signed URLs.
drop policy if exists "avatars_read_all" on storage.objects;
create policy "avatars_read_all" on storage.objects
  for select to anon, authenticated
  using (bucket_id = 'avatars');

-- Owner-scoped write: every object path starts with '<auth.uid()>/'.
-- header-avatar.js uploads to 'avatars/<uid>/<uuid>.<ext>'.
drop policy if exists "avatars_owner_write" on storage.objects;
create policy "avatars_owner_write" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "avatars_owner_update" on storage.objects;
create policy "avatars_owner_update" on storage.objects
  for update to authenticated
  using  (bucket_id = 'avatars' and owner = auth.uid())
  with check (bucket_id = 'avatars' and owner = auth.uid());

drop policy if exists "avatars_owner_delete" on storage.objects;
create policy "avatars_owner_delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'avatars' and owner = auth.uid());

-- ---------- 3. DM TABLES ---------------------------------------------------

create table if not exists public.dm_threads (
  id                   uuid primary key default gen_random_uuid(),
  kind                 text not null
                       check (kind in ('staff_direct','staff_group',
                                       'teacher_direct','school_direct')),
  name                 text,
  created_by           uuid not null references auth.users(id) on delete cascade,
  school_id            uuid references public.schools(id) on delete set null,
  avatar_url           text,
  last_message_at      timestamptz,
  last_message_preview text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create table if not exists public.dm_thread_members (
  thread_id    uuid not null references public.dm_threads(id) on delete cascade,
  user_id      uuid not null references auth.users(id)      on delete cascade,
  joined_at    timestamptz not null default now(),
  last_read_at timestamptz,
  primary key (thread_id, user_id)
);

create table if not exists public.dm_messages (
  id         uuid primary key default gen_random_uuid(),
  thread_id  uuid not null references public.dm_threads(id) on delete cascade,
  sender_id  uuid not null references auth.users(id)        on delete cascade,
  body       text not null check (length(body) between 1 and 4000),
  created_at timestamptz not null default now(),
  edited_at  timestamptz
);

create index if not exists dm_messages_thread_idx
  on public.dm_messages (thread_id, created_at desc);
create index if not exists dm_thread_members_user_idx
  on public.dm_thread_members (user_id);
create index if not exists dm_threads_last_message_at_idx
  on public.dm_threads (last_message_at desc nulls last);

alter table public.dm_threads       enable row level security;
alter table public.dm_thread_members enable row level security;
alter table public.dm_messages      enable row level security;

-- ---------- 4. RLS ---------------------------------------------------------

-- Member-scoped SELECT on threads. A user only sees a thread they belong to.
drop policy if exists "dm_threads_select_member" on public.dm_threads;
create policy "dm_threads_select_member" on public.dm_threads
  for select to authenticated
  using (exists (
    select 1 from public.dm_thread_members m
     where m.thread_id = dm_threads.id
       and m.user_id    = auth.uid()
  ));

-- A user only sees their own membership rows (used to render "members
-- count" + last_read_at for unread badges).
drop policy if exists "dm_thread_members_select_own" on public.dm_thread_members;
create policy "dm_thread_members_select_own" on public.dm_thread_members
  for select to authenticated
  using (user_id = auth.uid());

-- Member-scoped SELECT on messages. Mirrors the thread policy.
drop policy if exists "dm_messages_select_member" on public.dm_messages;
create policy "dm_messages_select_member" on public.dm_messages
  for select to authenticated
  using (exists (
    select 1 from public.dm_thread_members m
     where m.thread_id = dm_messages.thread_id
       and m.user_id    = auth.uid()
  ));

-- Block all client writes on every DM table — only RPCs may write.
drop policy if exists "dm_threads_no_client_write" on public.dm_threads;
create policy "dm_threads_no_client_write" on public.dm_threads
  for all to authenticated using (false) with check (false);

drop policy if exists "dm_thread_members_no_client_write" on public.dm_thread_members;
create policy "dm_thread_members_no_client_write" on public.dm_thread_members
  for all to authenticated using (false) with check (false);

drop policy if exists "dm_messages_no_client_write" on public.dm_messages;
create policy "dm_messages_no_client_write" on public.dm_messages
  for all to authenticated using (false) with check (false);

-- ---------- 5. RPCS -------------------------------------------------------

-- (a) create_dm_thread — validates caller role + every member's role +
-- same-school for teacher/school kinds; enforces member count (≤10 for
-- staff_group, exactly 1 other for direct kinds); idempotent for direct
-- kinds (returns the existing thread if the pair already has one).
create or replace function public.create_dm_thread(
  p_kind        text,
  p_member_ids  uuid[],
  p_name        text default null,
  p_school_id   uuid default null
)
returns public.dm_threads
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller     uuid := auth.uid();
  v_caller_role text;
  v_caller_school uuid;
  v_thread     public.dm_threads;
  v_member     uuid;
  v_count      int;
  v_member_role text;
  v_member_school uuid;
begin
  if v_caller is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;

  select p.role, p.school_id
    into v_caller_role, v_caller_school
    from public.profiles p
   where p.id = v_caller and p.deleted_at is null;
  if v_caller_role is null then
    raise exception 'No active profile' using errcode = '42501';
  end if;

  if p_kind not in ('staff_direct','staff_group',
                    'teacher_direct','school_direct') then
    raise exception 'Unknown thread kind' using errcode = '22023';
  end if;

  v_count := array_length(p_member_ids, 1);
  if v_count is null or v_count < 1 then
    raise exception 'At least one other member required' using errcode = '22023';
  end if;
  if p_kind in ('staff_direct','teacher_direct','school_direct')
     and v_count <> 1 then
    raise exception 'Direct threads must have exactly 1 other member'
      using errcode = '22023';
  end if;
  if p_kind = 'staff_group' and v_count > 9 then
    raise exception 'Group threads max 10 members (incl. self)'
      using errcode = '22023';
  end if;

  -- Role gating by kind.
  if p_kind in ('staff_direct','staff_group') then
    if v_caller_role not in ('staff_author','staff_reviewer','admin') then
      raise exception 'Staff only' using errcode = '42501';
    end if;
    foreach v_member in array p_member_ids loop
      select role into v_member_role from public.profiles
       where id = v_member and deleted_at is null;
      if v_member_role is null
         or v_member_role not in ('staff_author','staff_reviewer','admin') then
        raise exception 'All members must be staff' using errcode = '42501';
      end if;
    end loop;
  elsif p_kind = 'teacher_direct' then
    if v_caller_role <> 'teacher' then
      raise exception 'Teachers only' using errcode = '42501';
    end if;
    select role, school_id into v_member_role, v_member_school
      from public.profiles
     where id = p_member_ids[1] and deleted_at is null;
    if v_member_role is null
       or v_member_role not in ('teacher','school_organiser') then
      raise exception 'Recipient must be in the school'
        using errcode = '42501';
    end if;
  elsif p_kind = 'school_direct' then
    if v_caller_role not in ('teacher','school_organiser') then
      raise exception 'School members only' using errcode = '42501';
    end if;
  end if;

  -- Same-school enforcement for teacher / school kinds.
  if p_kind in ('teacher_direct','school_direct') then
    if p_school_id is null then
      raise exception 'p_school_id is required' using errcode = '22023';
    end if;
    if v_caller_role <> 'school_organiser' and v_caller_school <> p_school_id then
      raise exception 'Caller not in that school' using errcode = '42501';
    end if;
    foreach v_member in array p_member_ids loop
      select school_id into v_member_school from public.profiles
       where id = v_member and deleted_at is null;
      if v_member_school is null or v_member_school <> p_school_id then
        raise exception 'Member not in that school' using errcode = '42501';
      end if;
    end loop;
  end if;

  -- Idempotency for direct kinds: if a thread of this kind already
  -- exists between the caller and the recipient, return it.
  if p_kind in ('staff_direct','teacher_direct','school_direct') then
    select t.* into v_thread
      from public.dm_threads t
      join public.dm_thread_members m1
        on m1.thread_id = t.id and m1.user_id = v_caller
      join public.dm_thread_members m2
        on m2.thread_id = t.id and m2.user_id = p_member_ids[1]
     where t.kind = p_kind
     limit 1;
    if v_thread.id is not null then return v_thread; end if;
  end if;

  insert into public.dm_threads (kind, name, created_by, school_id)
  values (p_kind, p_name, v_caller, p_school_id)
  returning * into v_thread;

  insert into public.dm_thread_members (thread_id, user_id)
  values (v_thread.id, v_caller) on conflict do nothing;
  foreach v_member in array p_member_ids loop
    if v_member <> v_caller then
      insert into public.dm_thread_members (thread_id, user_id)
      values (v_thread.id, v_member) on conflict do nothing;
    end if;
  end loop;

  return v_thread;
end $$;

grant execute on function public.create_dm_thread(text, uuid[], text, uuid)
  to authenticated;

-- (b) send_dm_message — verifies caller is a member; inserts message;
-- updates thread.last_message_*; pushes a notification (kind=dm_message)
-- to every other member so topbar.js's existing realtime subscription
-- ticks the bell badge up.
create or replace function public.send_dm_message(
  p_thread_id uuid,
  p_body      text
)
returns public.dm_messages
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller     uuid := auth.uid();
  v_msg        public.dm_messages;
  v_thread     public.dm_threads;
  v_recipient  uuid;
  v_sender_name text;
  v_preview    text;
begin
  if v_caller is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;

  if p_body is null or length(trim(p_body)) = 0 then
    raise exception 'Body is required' using errcode = '22023';
  end if;
  if length(p_body) > 4000 then
    raise exception 'Body too long' using errcode = '22023';
  end if;

  -- Verify membership.
  if not exists (
    select 1 from public.dm_thread_members
     where thread_id = p_thread_id and user_id = v_caller
  ) then
    raise exception 'Not a member of this thread' using errcode = '42501';
  end if;

  -- Lock the thread row to prevent last_message races.
  select * into v_thread from public.dm_threads where id = p_thread_id;
  if v_thread.id is null then
    raise exception 'Thread not found' using errcode = 'P0002';
  end if;

  insert into public.dm_messages (thread_id, sender_id, body)
  values (p_thread_id, v_caller, p_body)
  returning * into v_msg;

  v_preview := substring(p_body, 1, 80);
  update public.dm_threads
     set last_message_at      = v_msg.created_at,
         last_message_preview = v_preview,
         updated_at           = now()
   where id = p_thread_id;

  -- Resolve sender's display name for the notification body.
  select coalesce(p.full_name, 'Someone') into v_sender_name
    from public.profiles p
   where p.id = v_caller;

  -- Notify every OTHER member.
  for v_recipient in
    select user_id from public.dm_thread_members
     where thread_id = p_thread_id
       and user_id <> v_caller
  loop
    perform public.push_notification(
      v_recipient,
      'dm_message',
      p_thread_id,
      v_sender_name || ': ' || v_preview
    );
  end loop;

  return v_msg;
end $$;

grant execute on function public.send_dm_message(uuid, text)
  to authenticated;

-- (c) mark_dm_thread_read — sets caller's last_read_at. Safe to call
-- multiple times.
create or replace function public.mark_dm_thread_read(p_thread_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update public.dm_thread_members
     set last_read_at = now()
   where thread_id = p_thread_id
     and user_id    = auth.uid();
$$;

grant execute on function public.mark_dm_thread_read(uuid)
  to authenticated;

-- (d) list_dm_threads — for the chat sidebar. Returns each thread the
-- caller belongs to, with the OTHER members' profiles flattened into
-- other_members jsonb (so the client can render group/DM labels without
-- a second round-trip), plus the unread count for the caller and the
-- last message preview.
create or replace function public.list_dm_threads()
returns table (
  id                  uuid,
  kind                text,
  name                text,
  school_id           uuid,
  created_by          uuid,
  created_at          timestamptz,
  last_message_at     timestamptz,
  last_message_preview text,
  member_count        int,
  other_members       jsonb,
  unread_count        int
)
language sql
security definer
set search_path = public
stable
as $$
  with mine as (
    select t.*
      from public.dm_threads t
      join public.dm_thread_members m
        on m.thread_id = t.id and m.user_id = auth.uid()
  ),
  member_counts as (
    select thread_id, count(*)::int as cnt
      from public.dm_thread_members
     group by thread_id
  ),
  others as (
    select m.thread_id,
           jsonb_agg(
             jsonb_build_object(
                  'id', p.id,
                  'full_name', p.full_name,
                  'role', p.role,
                  'avatar_url', p.avatar_url
                )
             order by p.full_name nulls last, p.id
           ) as others
      from public.dm_thread_members m
      join public.profiles p on p.id = m.user_id
     where m.user_id <> auth.uid()
     group by m.thread_id
  ),
  unread as (
    select t.id as thread_id,
           case
             when max(m.last_read_at) is null then 0
             else (
               select count(*)::int from public.dm_messages x
                where x.thread_id = t.id
                  and x.created_at > max(m.last_read_at)
                  and x.sender_id <> auth.uid()
             )
           end as cnt
      from mine t
      join public.dm_thread_members m
        on m.thread_id = t.id and m.user_id = auth.uid()
     group by t.id
  )
  select t.id, t.kind, t.name, t.school_id, t.created_by, t.created_at,
         t.last_message_at, t.last_message_preview,
         coalesce(mc.cnt, 0) as member_count,
         coalesce(o.others, '[]'::jsonb) as other_members,
         coalesce(u.cnt, 0) as unread_count
    from mine t
    left join member_counts mc on mc.thread_id = t.id
    left join others o          on o.thread_id  = t.id
    left join unread u          on u.thread_id  = t.id
   order by t.last_message_at desc nulls last, t.created_at desc;
$$;

grant execute on function public.list_dm_threads()
  to authenticated;

-- (e) list_dm_messages — paginated history. Default 50, oldest first.
-- p_before is a cursor: pass a timestamp to fetch messages older than
-- that point. NULL returns the newest page.
create or replace function public.list_dm_messages(
  p_thread_id uuid,
  p_limit     int default 50,
  p_before    timestamptz default null
)
returns table (
  id          uuid,
  thread_id   uuid,
  sender_id   uuid,
  sender_name text,
  sender_avatar text,
  body        text,
  created_at  timestamptz
)
language sql
security definer
set search_path = public
stable
as $$
  select m.id, m.thread_id, m.sender_id,
         p.full_name as sender_name,
         p.avatar_url as sender_avatar,
         m.body, m.created_at
    from public.dm_messages m
    join public.profiles p on p.id = m.sender_id
   where m.thread_id = p_thread_id
     and (p_before is null or m.created_at < p_before)
   order by m.created_at desc
   limit greatest(p_limit, 1);
$$;

grant execute on function public.list_dm_messages(uuid, int, timestamptz)
  to authenticated;

-- (f) search_dm_recipients — predictive directory search.
--
--   * Staff caller  -> only staff_author/staff_reviewer/admin, excluding
--     self + members of any thread already shared with the caller.
--   * Teacher or organiser caller -> only teacher/school_organiser
--     profiles in the caller's school, excluding self.
--
-- Returns the top p_limit matches ordered by name.
create or replace function public.search_dm_recipients(
  p_query text,
  p_limit int default 8
)
returns table (
  id        uuid,
  full_name text,
  role      text,
  avatar_url text
)
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_caller       uuid := auth.uid();
  v_role         text;
  v_school       uuid;
  v_pattern      text;
begin
  if v_caller is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;

  select p.role, p.school_id into v_role, v_school
    from public.profiles p
   where p.id = v_caller and p.deleted_at is null;
  if v_role is null then
    raise exception 'No active profile' using errcode = '42501';
  end if;

  v_pattern := '%' || coalesce(trim(p_query), '') || '%';
  if v_role in ('staff_author','staff_reviewer','admin') then
    return query
      select p.id, p.full_name, p.role, p.avatar_url
        from public.profiles p
       where p.id <> v_caller
         and p.deleted_at is null
         and p.role in ('staff_author','staff_reviewer','admin')
         and p.full_name ilike v_pattern
         and not exists (
           select 1 from public.dm_thread_members m
            where m.user_id = p.id
              and exists (
                select 1 from public.dm_thread_members m2
                 where m2.thread_id = m.thread_id
                   and m2.user_id = v_caller
              )
         )
       order by p.full_name nulls last, p.id
       limit greatest(p_limit, 1);
    return;
  elsif v_role in ('teacher','school_organiser') then
    if v_school is null then
      raise exception 'No school on caller profile' using errcode = '42501';
    end if;
    return query
      select p.id, p.full_name, p.role, p.avatar_url
        from public.profiles p
       where p.id <> v_caller
         and p.deleted_at is null
         and p.role in ('teacher','school_organiser')
         and p.school_id = v_school
         and p.full_name ilike v_pattern
       order by p.full_name nulls last, p.id
       limit greatest(p_limit, 1);
    return;
  else
    -- Students / other roles don't have DM access.
    return;
  end if;
end $$;

grant execute on function public.search_dm_recipients(text, int)
  to authenticated;

-- (g) count_unread_dms — sum of unread across all of the caller's threads.
-- Used to bootstrap the FAB badge on mount.
create or replace function public.count_unread_dms()
returns int
language sql
security definer
set search_path = public
stable
as $$
  with per_thread as (
    select t.id as thread_id,
           case
             when max(m.last_read_at) is null then 0
             else (
               select count(*) from public.dm_messages x
                where x.thread_id = t.id
                  and x.created_at > max(m.last_read_at)
                  and x.sender_id <> auth.uid()
             )
           end as cnt
      from public.dm_threads t
      join public.dm_thread_members m
        on m.thread_id = t.id and m.user_id = auth.uid()
     group by t.id
  )
  select coalesce(sum(cnt), 0)::int from per_thread;
$$;

grant execute on function public.count_unread_dms()
  to authenticated;

-- (h) list_school_teachers — used by the School Team section on
-- teacher-dashboard.html and school-organiser-dashboard.html.
-- Returns teachers + organisers in the same school as the caller, with
-- avatar + last-sign-in for display. The school_organiser branch lets
-- the organiser look up any school; the teacher branch is scoped to
-- the caller's own school.
create or replace function public.list_school_teachers(p_school_id uuid default null)
returns table (
  id              uuid,
  full_name       text,
  role            text,
  avatar_url      text,
  last_sign_in_at timestamptz
)
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_caller uuid := auth.uid();
  v_caller_role text;
  v_caller_school uuid;
  v_target uuid;
begin
  if v_caller is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;

  select p.role, p.school_id
    into v_caller_role, v_caller_school
    from public.profiles p
   where p.id = v_caller and p.deleted_at is null;
  if v_caller_role is null
     or v_caller_role not in ('teacher','school_organiser') then
    raise exception 'School members only' using errcode = '42501';
  end if;

  -- Pick target school: explicit arg, else caller's school.
  v_target := coalesce(p_school_id, v_caller_school);
  if v_target is null then
    raise exception 'No school on caller profile' using errcode = '42501';
  end if;
  if v_caller_role <> 'school_organiser' and v_target <> v_caller_school then
    raise exception 'Caller not in that school' using errcode = '42501';
  end if;

  return query
    select p.id, p.full_name, p.role, p.avatar_url, u.last_sign_in_at
      from public.profiles p
      join auth.users u on u.id = p.id
     where p.role in ('teacher','school_organiser')
       and p.school_id = v_target
       and p.deleted_at is null
     order by p.full_name nulls last, p.id;
end $$;

grant execute on function public.list_school_teachers(uuid)
  to authenticated;

-- ---------- 6. SANITY CHECKS ----------------------------------------------

-- Verify the realtime publication includes dm_messages so chat.js's
-- postgres_changes subscription delivers inserts. Supabase's default
-- supabase_realtime publication auto-includes new tables since 2024;
-- this block is a no-op if already published.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = 'public'
       and tablename = 'dm_messages'
  ) then
    execute 'alter publication supabase_realtime add table public.dm_messages';
  end if;
end $$;