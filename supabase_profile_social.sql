-- supabase_profile_social.sql
-- Profile page: bio column, follows, likes, view/profile/toggle/search/list RPCs.
-- Idempotent — safe to re-run.

set search_path = public;

-- ============================================================================
-- 1. bio column on profiles
-- ============================================================================

alter table public.profiles
  add column if not exists bio text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'profiles_bio_length_chk'
  ) then
    alter table public.profiles
      add constraint profiles_bio_length_chk
      check (bio is null or char_length(bio) <= 500);
  end if;
end$$;

-- ============================================================================
-- 2. profile_follows
-- ============================================================================

create table if not exists public.profile_follows (
  follower_id uuid not null references auth.users(id) on delete cascade,
  followee_id uuid not null references auth.users(id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (follower_id, followee_id),
  check (follower_id <> followee_id)
);

create index if not exists profile_follows_followee_idx
  on public.profile_follows (followee_id);
create index if not exists profile_follows_follower_idx
  on public.profile_follows (follower_id);

-- ============================================================================
-- 3. profile_likes
-- ============================================================================

create table if not exists public.profile_likes (
  profile_id uuid not null references public.profiles(id) on delete cascade,
  liker_id   uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (profile_id, liker_id)
);

create index if not exists profile_likes_profile_idx
  on public.profile_likes (profile_id);

-- ============================================================================
-- 4. RLS — read for authenticated; deny all client writes
-- ============================================================================

alter table public.profile_follows enable row level security;
alter table public.profile_likes   enable row level security;

drop policy if exists profile_follows_select on public.profile_follows;
create policy profile_follows_select on public.profile_follows
  for select to authenticated using (true);

drop policy if exists profile_follows_no_client_write on public.profile_follows;
create policy profile_follows_no_client_write on public.profile_follows
  for all to authenticated using (false) with check (false);

drop policy if exists profile_likes_select on public.profile_likes;
create policy profile_likes_select on public.profile_likes
  for select to authenticated using (true);

drop policy if exists profile_likes_no_client_write on public.profile_likes;
create policy profile_likes_no_client_write on public.profile_likes
  for all to authenticated using (false) with check (false);

-- ============================================================================
-- 5. Realtime publication (idempotent — Supabase auto-includes since 2024
--    but explicit add is a no-op when already present).
-- ============================================================================

do $rt$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'profile_follows'
  ) then
    alter publication supabase_realtime add table public.profile_follows;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'profile_likes'
  ) then
    alter publication supabase_realtime add table public.profile_likes;
  end if;
end$rt$;

-- ============================================================================
-- 6. RPCs (SECURITY DEFINER, set search_path = public)
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 6.1 get_profile_for_view — single JSONB returning all the page needs
-- ---------------------------------------------------------------------------

create or replace function public.get_profile_for_view(p_target_id uuid)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_caller uuid := auth.uid();
  v_row    jsonb;
begin
  if v_caller is null then
    return jsonb_build_object('found', false, 'reason', 'not_authenticated');
  end if;

  select to_jsonb(p) into v_row
  from public.profiles p
  where p.id = p_target_id and p.deleted_at is null;

  if v_row is null then
    return jsonb_build_object('found', false, 'reason', 'not_found');
  end if;

  -- school_name (best-effort).
  v_row := v_row || jsonb_build_object(
    'school_name', (
      select s.name from public.schools s
      where s.id::text = (v_row->>'school_id')
    )
  );

  -- counts.
  v_row := v_row || jsonb_build_object(
    'follower_count',
      (select count(*)::int from public.profile_follows where followee_id = p_target_id),
    'following_count',
      (select count(*)::int from public.profile_follows where follower_id = p_target_id),
    'likes_count',
      (select count(*)::int from public.profile_likes where profile_id = p_target_id)
  );

  -- relationship flags for the viewer.
  v_row := v_row || jsonb_build_object(
    'is_self', v_caller = p_target_id,
    'caller_follows_target',
      (select exists(
        select 1 from public.profile_follows
        where follower_id = v_caller and followee_id = p_target_id
      )),
    'target_follows_caller',
      (select exists(
        select 1 from public.profile_follows
        where follower_id = p_target_id and followee_id = v_caller
      )),
    'caller_likes_this_profile',
      (select exists(
        select 1 from public.profile_likes
        where profile_id = p_target_id and liker_id = v_caller
      ))
  );

  v_row := v_row || jsonb_build_object(
    'is_friend_with_caller',
      coalesce((v_row->>'caller_follows_target')::bool, false)
      and coalesce((v_row->>'target_follows_caller')::bool, false)
  );

  -- mutual_friend_count_with_caller: people who are friend-with-both.
  if v_caller <> p_target_id then
    v_row := v_row || jsonb_build_object(
      'mutual_friend_count_with_caller', (
        select count(*)::int
        from public.profile_follows f1
        join public.profile_follows f2
          on f1.follower_id = f2.followee_id
         and f1.followee_id = f2.follower_id
        where f1.follower_id = v_caller
          and f2.follower_id = p_target_id
      )
    );

    -- recent_mutuals: up to 8 mini-cards (id, full_name, role, avatar_url).
    v_row := v_row || jsonb_build_object(
      'recent_mutuals', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', m.id, 'full_name', m.full_name,
          'role', m.role, 'avatar_url', m.avatar_url
        ))
        from (
          select p.id, p.full_name, p.role, p.avatar_url
          from public.profile_follows f1
          join public.profile_follows f2
            on f1.follower_id = f2.followee_id
           and f1.followee_id = f2.follower_id
          join public.profiles p on p.id = f1.followee_id
          where f1.follower_id = v_caller
            and f2.follower_id = p_target_id
            and p.id not in (v_caller, p_target_id)
            and p.deleted_at is null
          order by p.full_name nulls last, p.id
          limit 8
        ) m
      ), '[]'::jsonb)
    );
  else
    v_row := v_row || jsonb_build_object(
      'mutual_friend_count_with_caller', 0,
      'recent_mutuals', '[]'::jsonb
    );
  end if;

  v_row := v_row || jsonb_build_object('found', true);
  return v_row;
end$$;

-- ---------------------------------------------------------------------------
-- 6.2 set_my_bio — caller updates own bio
-- ---------------------------------------------------------------------------

create or replace function public.set_my_bio(p_bio text)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_clean text;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  v_clean := nullif(btrim(coalesce(p_bio, '')), '');
  if v_clean is not null and char_length(v_clean) > 500 then
    raise exception 'bio too long (max 500 chars)';
  end if;
  update public.profiles
    set bio = v_clean,
        updated_at = now()
    where id = v_uid;
end$$;

-- ---------------------------------------------------------------------------
-- 6.3 toggle_follow — idempotent follow/unfollow, fires notification
-- ---------------------------------------------------------------------------

create or replace function public.toggle_follow(p_target_id uuid)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_caller uuid := auth.uid();
  v_existed boolean;
  v_now_following boolean;
  v_target_alive boolean;
  v_mutual boolean;
  v_caller_name text;
begin
  if v_caller is null then raise exception 'not authenticated'; end if;
  if p_target_id is null then raise exception 'target required'; end if;
  if p_target_id = v_caller then raise exception 'cannot follow self'; end if;

  select exists(
    select 1 from public.profiles
    where id = p_target_id and deleted_at is null
  ) into v_target_alive;
  if not v_target_alive then raise exception 'target not available'; end if;

  select exists(
    select 1 from public.profile_follows
    where follower_id = v_caller and followee_id = p_target_id
  ) into v_existed;

  if v_existed then
    delete from public.profile_follows
      where follower_id = v_caller and followee_id = p_target_id;
    v_now_following := false;
  else
    insert into public.profile_follows (follower_id, followee_id)
      values (v_caller, p_target_id);
    v_now_following := true;

    -- Fire-and-forget notification; ignore any errors (push_notification may
    -- evolve independently).
    select full_name into v_caller_name from public.profiles where id = v_caller;
    begin
      perform public.push_notification(
        p_target_id,
        'profile_follow',
        v_caller,
        coalesce(v_caller_name, 'Someone') || ' started following you'
      );
    exception when others then null;
    end;
  end if;

  select exists(
    select 1 from public.profile_follows
    where follower_id = p_target_id and followee_id = v_caller
  ) into v_mutual;

  return jsonb_build_object(
    'is_following', v_now_following,
    'is_mutual_now', v_now_following and v_mutual
  );
end$$;

-- ---------------------------------------------------------------------------
-- 6.4 toggle_profile_like — idempotent like/unlike, fires notification
-- ---------------------------------------------------------------------------

create or replace function public.toggle_profile_like(p_target_id uuid)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_caller uuid := auth.uid();
  v_existed boolean;
  v_now_liked boolean;
  v_target_alive boolean;
  v_count int;
  v_caller_name text;
begin
  if v_caller is null then raise exception 'not authenticated'; end if;
  if p_target_id is null then raise exception 'target required'; end if;
  if p_target_id = v_caller then raise exception 'cannot like self'; end if;

  select exists(
    select 1 from public.profiles
    where id = p_target_id and deleted_at is null
  ) into v_target_alive;
  if not v_target_alive then raise exception 'target not available'; end if;

  select exists(
    select 1 from public.profile_likes
    where profile_id = p_target_id and liker_id = v_caller
  ) into v_existed;

  if v_existed then
    delete from public.profile_likes
      where profile_id = p_target_id and liker_id = v_caller;
    v_now_liked := false;
  else
    insert into public.profile_likes (profile_id, liker_id)
      values (p_target_id, v_caller);
    v_now_liked := true;

    select full_name into v_caller_name from public.profiles where id = v_caller;
    begin
      perform public.push_notification(
        p_target_id,
        'profile_like',
        v_caller,
        coalesce(v_caller_name, 'Someone') || ' liked your profile'
      );
    exception when others then null;
    end;
  end if;

  select count(*)::int into v_count
    from public.profile_likes where profile_id = p_target_id;

  return jsonb_build_object(
    'liked', v_now_liked,
    'likes_count', v_count
  );
end$$;

-- ---------------------------------------------------------------------------
-- 6.5 search_profiles_for_follow — wide-open search across all signed-in users
-- ---------------------------------------------------------------------------

create or replace function public.search_profiles_for_follow(
  p_query text,
  p_limit int default 8
)
returns table (
  id uuid,
  full_name text,
  role text,
  avatar_url text
)
language plpgsql security definer set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_q   text := coalesce(btrim(p_query), '');
begin
  if v_uid is null then raise exception 'not authenticated'; end if;

  return query
    select p.id, p.full_name, p.role, p.avatar_url
    from public.profiles p
    where p.deleted_at is null
      and p.id <> v_uid
      and (
        v_q = ''
        or coalesce(p.full_name, '') ilike '%' || v_q || '%'
      )
    order by p.full_name nulls last, p.id
    limit greatest(1, least(coalesce(p_limit, 8), 50));
end$$;

-- ---------------------------------------------------------------------------
-- 6.6 list_profile_followers / following / mutuals — for stats modal
-- ---------------------------------------------------------------------------

create or replace function public.list_profile_followers(
  p_target uuid,
  p_limit  int default 50
)
returns table (id uuid, full_name text, role text, avatar_url text)
language sql security definer set search_path = public stable
as $$
  select p.id, p.full_name, p.role, p.avatar_url
  from public.profile_follows f
  join public.profiles p on p.id = f.follower_id
  where f.followee_id = p_target and p.deleted_at is null
  order by f.created_at desc
  limit greatest(1, least(coalesce(p_limit, 50), 200));
$$;

create or replace function public.list_profile_following(
  p_target uuid,
  p_limit  int default 50
)
returns table (id uuid, full_name text, role text, avatar_url text)
language sql security definer set search_path = public stable
as $$
  select p.id, p.full_name, p.role, p.avatar_url
  from public.profile_follows f
  join public.profiles p on p.id = f.followee_id
  where f.follower_id = p_target and p.deleted_at is null
  order by f.created_at desc
  limit greatest(1, least(coalesce(p_limit, 50), 200));
$$;

create or replace function public.list_profile_mutuals_with_me(
  p_target uuid,
  p_limit  int default 50
)
returns table (id uuid, full_name text, role text, avatar_url text)
language sql security definer set search_path = public stable
as $$
  select p.id, p.full_name, p.role, p.avatar_url
  from public.profile_follows f1
  join public.profile_follows f2
    on f1.follower_id = f2.followee_id
   and f1.followee_id = f2.follower_id
  join public.profiles p on p.id = f1.followee_id
  where f1.follower_id = auth.uid()
    and f2.follower_id = p_target
    and p.deleted_at is null
    and p.id not in (auth.uid(), p_target)
  order by p.full_name nulls last, p.id
  limit greatest(1, least(coalesce(p_limit, 50), 200));
$$;
