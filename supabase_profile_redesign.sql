-- ============================================================================
-- supabase_profile_redesign.sql
-- Profile-page redesign migration: rich bio, online status, account visibility,
-- currently-learning / recent-subjects RPC, corrected mutual-friends SQL.
-- Idempotent — safe to re-run.
-- Run after supabase_profile_social.sql in the Supabase SQL editor.
-- ============================================================================

set search_path = public;

-- ============================================================================
-- 1. SCHEMA additions on public.profiles
-- ============================================================================

-- Account visibility: who can see this profile's full content.
alter table public.profiles
  add column if not exists account_visibility text not null default 'public'
    check (account_visibility in ('public','friends_only','private'));

-- Last-seen heartbeat used to compute is_online.
alter table public.profiles
  add column if not exists last_seen_at timestamptz;

-- Distinguishes plain text bio (legacy) from sanitised HTML (new).
alter table public.profiles
  add column if not exists bio_format text not null default 'plain'
    check (bio_format in ('plain','html'));

-- Relax the 500-char bio cap so rich HTML can fit a few images / lines.
-- The server still validates a sensible upper bound (8000 chars) on save.
do $$
begin
  if exists (
    select 1 from pg_constraint where conname = 'profiles_bio_length_chk'
  ) then
    alter table public.profiles drop constraint profiles_bio_length_chk;
  end if;
end$$;

alter table public.profiles
  add constraint profiles_bio_length_chk
  check (bio is null or char_length(bio) <= 8000);

-- ============================================================================
-- 2. Re-publish profiles + lesson_progress on the realtime channel
--    (idempotent — pg_publication_tables guards each insert).
-- ============================================================================

do $rt$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'profiles'
  ) then
    alter publication supabase_realtime add table public.profiles;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'lesson_progress'
  ) then
    alter publication supabase_realtime add table public.lesson_progress;
  end if;
end$rt$;

-- ============================================================================
-- 3. RPCs
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 3.1 heartbeat — caller pings so other viewers see them as online.
-- ---------------------------------------------------------------------------

create or replace function public.heartbeat()
returns void
language sql security definer set search_path = public
as $$
  update public.profiles
    set last_seen_at = now()
    where id = auth.uid();
$$;

grant execute on function public.heartbeat() to authenticated;

-- ---------------------------------------------------------------------------
-- 3.2 set_my_account_visibility — caller updates own visibility.
-- ---------------------------------------------------------------------------

create or replace function public.set_my_account_visibility(p_visibility text)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_clean text;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  v_clean := coalesce(btrim(p_visibility), '');
  if v_clean not in ('public','friends_only','private') then
    raise exception 'invalid visibility';
  end if;
  update public.profiles
    set account_visibility = v_clean,
        updated_at = now()
    where id = v_uid;
end$$;

grant execute on function public.set_my_account_visibility(text) to authenticated;

-- ---------------------------------------------------------------------------
-- 3.3 set_my_bio — caller updates own bio. Accepts sanitised HTML.
--     The client sanitiser is the source of truth, but we also enforce a
--     coarse allowlist server-side as defence in depth.
-- ---------------------------------------------------------------------------

create or replace function public.set_my_bio(p_bio text, p_format text default 'html')
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_uid   uuid := auth.uid();
  v_clean text;
  v_format text;
  v_stripped_len int;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;

  v_clean := nullif(btrim(coalesce(p_bio, '')), '');
  if v_clean is not null and char_length(v_clean) > 8000 then
    raise exception 'bio too long (max 8000 chars)';
  end if;

  v_format := case when coalesce(p_format, 'html') = 'plain' then 'plain' else 'html' end;

  if v_format = 'html' and v_clean is not null then
    -- Coarse allowlist strip. Removes anything that isn't in the safe list.
    -- The rich-text editor on the client already produces only these tags;
    -- this is a backstop in case the client is bypassed.
    v_clean := regexp_replace(v_clean, '<(/?)(script|style|iframe|object|embed|form|input|button|link|meta)[^>]*>', '', 'gi');
    v_clean := regexp_replace(v_clean, ' on[a-z]+\s*=\s*"[^"]*"', '', 'gi');
    v_clean := regexp_replace(v_clean, ' on[a-z]+\s*=\s*''[^'']*''', '', 'gi');
    -- Strip javascript: / data: URIs from href / src attributes.
    v_clean := regexp_replace(v_clean, '(href|src)\s*=\s*"(?:javascript|data|vbscript):[^"]*"', '', 'gi');
    v_clean := regexp_replace(v_clean, '(href|src)\s*=\s*''(?:javascript|data|vbscript):[^'']*''', '', 'gi');
    -- Drop tags we never want (anything not in the allowlist).
    -- b, i, u, strong, em, br, span, a, img, p, div, br are allowed.
    v_clean := regexp_replace(
      v_clean,
      '</?(?!b|i|u|strong|em|br|span|a|img|p|div)\b[^>]*>',
      '',
      'gi'
    );
  end if;

  -- Plain text bio length is the stripped length (matches the old UX).
  if v_format = 'plain' and v_clean is not null then
    v_stripped_len := char_length(regexp_replace(v_clean, '<[^>]+>', '', 'g'));
  end if;

  update public.profiles
    set bio = v_clean,
        bio_format = v_format,
        updated_at = now()
    where id = v_uid;
end$$;

grant execute on function public.set_my_bio(text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 3.4 get_profile_for_view — REPLACES the version in supabase_profile_social.sql
--     * Mutual-friends SQL now requires both directions (caller ↔ X, target ↔ X)
--     * Adds is_online, account_visibility, bio_format to the response
--     * Privacy gate: private + friends_only non-friends receive only the
--       identity card fields, not bio / stats / mutuals / learning.
-- ---------------------------------------------------------------------------

create or replace function public.get_profile_for_view(p_target_id uuid)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_caller     uuid := auth.uid();
  v_row        jsonb;
  v_visibility text;
  v_last_seen  timestamptz;
  v_is_online  boolean;
  v_is_friend  boolean;
  v_visible    boolean := true;
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

  v_visibility := coalesce(v_row->>'account_visibility', 'public');
  v_last_seen  := (v_row->>'last_seen_at')::timestamptz;
  v_is_online  := v_last_seen is not null and now() - v_last_seen < interval '2 minutes';

  -- Relationship flags (we always know these; the follow button needs them).
  v_row := v_row || jsonb_build_object(
    'is_self', v_caller = p_target_id,
    'caller_follows_target',
      (select exists(select 1 from public.profile_follows
        where follower_id = v_caller and followee_id = p_target_id)),
    'target_follows_caller',
      (select exists(select 1 from public.profile_follows
        where follower_id = p_target_id and followee_id = v_caller)),
    'caller_likes_this_profile',
      (select exists(select 1 from public.profile_likes
        where profile_id = p_target_id and liker_id = v_caller))
  );

  v_is_friend := coalesce((v_row->>'caller_follows_target')::bool, false)
                 and coalesce((v_row->>'target_follows_caller')::bool, false);
  v_row := v_row || jsonb_build_object('is_friend_with_caller', v_is_friend);

  -- Privacy gate. Self always sees everything.
  if v_caller = p_target_id then
    v_visible := true;
  elsif v_visibility = 'public' then
    v_visible := true;
  elsif v_visibility = 'friends_only' then
    v_visible := v_is_friend;
  else  -- private
    v_visible := false;
  end if;

  if not v_visible then
    -- Stripped response: only what's safe to expose.
    v_row := v_row - 'bio' - 'school_id' - 'school_name';
    v_row := v_row || jsonb_build_object(
      'account_visibility', v_visibility,
      'is_online', v_is_online,
      'follower_count', 0,
      'following_count', 0,
      'likes_count', 0,
      'mutual_friend_count_with_caller', 0,
      'recent_mutuals', '[]'::jsonb,
      'found', true
    );
    return v_row;
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
      (select count(*)::int from public.profile_likes where profile_id = p_target_id),
    'account_visibility', v_visibility,
    'is_online', v_is_online
  );

  -- Mutual friends: caller ↔ X AND target ↔ X (true mutual definition).
  if v_caller <> p_target_id then
    v_row := v_row || jsonb_build_object(
      'mutual_friend_count_with_caller', (
        select count(*)::int
        from public.profile_follows f1            -- caller → X
        join public.profile_follows f2            -- X → caller
          on f2.follower_id = f1.followee_id
         and f2.followee_id = f1.follower_id
        join public.profile_follows f3            -- target → X
          on f3.follower_id = p_target_id
         and f3.followee_id = f1.followee_id
        join public.profile_follows f4            -- X → target
          on f4.follower_id = f1.followee_id
         and f4.followee_id = p_target_id
        where f1.follower_id = v_caller
          and f1.followee_id not in (v_caller, p_target_id)
      ),
      'recent_mutuals', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', m.id, 'full_name', m.full_name,
          'role', m.role, 'avatar_url', m.avatar_url
        ))
        from (
          select p.id, p.full_name, p.role, p.avatar_url
          from public.profile_follows f1
          join public.profile_follows f2
            on f2.follower_id = f1.followee_id
           and f2.followee_id = f1.follower_id
          join public.profile_follows f3
            on f3.follower_id = p_target_id
           and f3.followee_id = f1.followee_id
          join public.profile_follows f4
            on f4.follower_id = f1.followee_id
           and f4.followee_id = p_target_id
          join public.profiles p on p.id = f1.followee_id
          where f1.follower_id = v_caller
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
-- 3.5 list_profile_mutuals_with_me — REPLACES the version in
--     supabase_profile_social.sql with the corrected 4-way join.
-- ---------------------------------------------------------------------------

create or replace function public.list_profile_mutuals_with_me(
  p_target uuid,
  p_limit  int default 50
)
returns table (id uuid, full_name text, role text, avatar_url text)
language sql security definer set search_path = public stable
as $$
  select p.id, p.full_name, p.role, p.avatar_url
  from public.profile_follows f1            -- caller → X
  join public.profile_follows f2            -- X → caller
    on f2.follower_id = f1.followee_id
   and f2.followee_id = f1.follower_id
  join public.profile_follows f3            -- target → X
    on f3.follower_id = p_target
   and f3.followee_id = f1.followee_id
  join public.profile_follows f4            -- X → target
    on f4.follower_id = f1.followee_id
   and f4.followee_id = p_target
  join public.profiles p on p.id = f1.followee_id
  where f1.follower_id = auth.uid()
    and p.id not in (auth.uid(), p_target)
    and p.deleted_at is null
  order by p.full_name nulls last, p.id
  limit greatest(1, least(coalesce(p_limit, 50), 200));
$$;

-- ---------------------------------------------------------------------------
-- 3.6 get_profile_learning_state — powers "Currently learning" and
--     "Recent subjects" cards on the profile page.
--
--     Bypasses lesson_progress RLS via SECURITY DEFINER so it can return the
--     target user's progress to the caller. The caller-side gating happens
--     in the client (it only requests learning state when the profile is
--     visible), but we also gate server-side: private profiles always
--     return empty arrays; friends_only requires the caller and target to
--     be mutual.
-- ---------------------------------------------------------------------------

create or replace function public.get_profile_learning_state(p_target_id uuid)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_caller     uuid := auth.uid();
  v_visibility text;
  v_is_friend  boolean;
  v_visible    boolean := true;
  v_result     jsonb;
begin
  if v_caller is null then
    return jsonb_build_object('currently_learning', '[]'::jsonb, 'recent_subjects', '[]'::jsonb);
  end if;

  if v_caller = p_target_id then
    v_visible := true;
  else
    select coalesce(account_visibility, 'public')
      into v_visibility
      from public.profiles
      where id = p_target_id;

    if v_visibility = 'private' then
      v_visible := false;
    elsif v_visibility = 'friends_only' then
      select exists(
        select 1 from public.profile_follows
        where follower_id = v_caller and followee_id = p_target_id
      ) and exists(
        select 1 from public.profile_follows
        where follower_id = p_target_id and followee_id = v_caller
      ) into v_is_friend;
      v_visible := v_is_friend;
    end if;
  end if;

  if not v_visible then
    return jsonb_build_object('currently_learning', '[]'::jsonb, 'recent_subjects', '[]'::jsonb);
  end if;

  select jsonb_build_object(
    'currently_learning', coalesce((
      select jsonb_agg(jsonb_build_object(
        'lesson_id',     l.id,
        'lesson_title',  l.title,
        'topic_id',      t.id,
        'topic_name',    t.name,
        'subject_id',    s.id,
        'subject_name',  s.name,
        'subject_color', s.color_key,
        'updated_at',    lp.updated_at
      ))
      from (
        select lesson_id, max(updated_at) as updated_at
        from public.lesson_progress
        where user_id = p_target_id
          and status = 'in_progress'
        group by lesson_id
        order by max(updated_at) desc
        limit 6
      ) latest
      join public.lesson_progress lp
        on lp.lesson_id = latest.lesson_id and lp.user_id = p_target_id
      join public.lessons l on l.id = latest.lesson_id
      join public.topics  t on t.id = l.topic_id
      join public.subjects s on s.id = t.subject_id
      where lp.status = 'in_progress'
    ), '[]'::jsonb),
    'recent_subjects', coalesce((
      select jsonb_agg(jsonb_build_object(
        'subject_id',      s.id,
        'subject_name',    s.name,
        'subject_color',   s.color_key,
        'last_touched_at', touched.max_at,
        'lessons_touched', touched.cnt
      ))
      from (
        select t.subject_id, max(lp.updated_at) as max_at, count(*) as cnt
        from public.lesson_progress lp
        join public.lessons l on l.id = lp.lesson_id
        join public.topics  t on t.id = l.topic_id
        where lp.user_id = p_target_id
        group by t.subject_id
        order by max(lp.updated_at) desc
        limit 4
      ) touched
      join public.subjects s on s.id = touched.subject_id
    ), '[]'::jsonb)
  ) into v_result;

  return v_result;
end$$;

grant execute on function public.get_profile_learning_state(uuid) to authenticated;

-- ============================================================================
-- DONE. Apply in Supabase SQL editor.
-- ============================================================================
