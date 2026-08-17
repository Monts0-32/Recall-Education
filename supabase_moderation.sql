-- ============================================================================
-- supabase_moderation.sql
--
-- Bio / Name / DM moderation system.
--
-- Run AFTER: supabase_setup.sql, supabase_notifications.sql,
--           supabase_profile_social.sql, supabase_profile_and_dm.sql,
--           supabase_oauth_completion.sql.
--
-- The functions defined here use `create or replace` so they override any
-- previous versions of `set_my_bio` and `send_dm_message` from the social /
-- DM migrations. The fresh triggers and grants are also idempotent.
--
-- Layers, in order of how often they fire:
--
--   1. RPC-level moderation (set_my_bio, set_my_full_name, send_dm_message)
--      => rejects the write and inserts a moderation_flags row.
--   2. Column-level grants on public.profiles => blocks direct .update() on
--      bio / full_name (the closing of the RLS bypass).
--   3. BEFORE INSERT OR UPDATE trigger on public.profiles => catches any
--      future RPC that writes bio / full_name without moderating first,
--      including INSERTs from handle_new_user and complete_student_profile.
--   4. BEFORE INSERT trigger on public.dm_messages => belt-and-braces on DM
--      bodies (the only existing writer is send_dm_message, which is
--      already moderated; this is a safety net for future RPCs).
-- ============================================================================

set search_path = public;

-- ---------------------------------------------------------------------------
-- 1. moderation_blocklist — curated list of banned terms
-- ---------------------------------------------------------------------------

create table if not exists public.moderation_blocklist (
  term        text primary key,
  severity    text not null default 'block'
              check (severity in ('block','review')),
  created_at  timestamptz not null default now(),
  created_by  uuid references auth.users(id) on delete set null
);

alter table public.moderation_blocklist enable row level security;

-- Clients cannot read or write the blocklist directly. All access is via
-- SECURITY DEFINER RPCs (contains_banned_terms, plus future admin tooling).
drop policy if exists moderation_blocklist_no_client_access
  on public.moderation_blocklist;
create policy moderation_blocklist_no_client_access
  on public.moderation_blocklist
  for all to anon, authenticated
  using (false) with check (false);

-- ---------------------------------------------------------------------------
-- 2. moderation_flags — every rejected write is recorded for staff review
-- ---------------------------------------------------------------------------

create table if not exists public.moderation_flags (
  id               uuid primary key default gen_random_uuid(),
  kind             text not null
                   check (kind in ('bio','name','dm')),
  target_kind      text not null
                   check (target_kind in ('profile','dm_message')),
  target_id        uuid not null,
  flagged_terms    text[] not null,
  submitted_text   text not null,
  submitter_id     uuid not null references auth.users(id) on delete cascade,
  status           text not null default 'pending'
                   check (status in ('pending','approved','rejected')),
  created_at       timestamptz not null default now(),
  resolved_at      timestamptz,
  resolved_by      uuid references auth.users(id) on delete set null,
  resolution_notes text
);

create index if not exists moderation_flags_status_idx
  on public.moderation_flags (status, created_at desc);
create index if not exists moderation_flags_target_idx
  on public.moderation_flags (target_kind, target_id);
create index if not exists moderation_flags_submitter_idx
  on public.moderation_flags (submitter_id);

alter table public.moderation_flags enable row level security;

drop policy if exists moderation_flags_no_client_access
  on public.moderation_flags;
create policy moderation_flags_no_client_access
  on public.moderation_flags
  for all to anon, authenticated
  using (false) with check (false);

-- ---------------------------------------------------------------------------
-- 3. contains_banned_terms — shared matcher (case-insensitive, leet-aware)
-- ---------------------------------------------------------------------------

create or replace function public.contains_banned_terms(p_text text)
returns text[]
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_norm text;
  v_term text;
  v_hits text[] := '{}';
begin
  if p_text is null or length(trim(p_text)) = 0 then
    return '{}';
  end if;

  -- Lowercase, then collapse common leet-speak symbols/digits back to their
  -- letter equivalents so "f@gg0t" still matches "faggot".
  v_norm := lower(p_text);
  v_norm := translate(v_norm, '@$1037l8', 'asitoebl8');

  for v_term in select term from public.moderation_blocklist loop
    if v_norm like '%' || lower(v_term) || '%' then
      v_hits := array_append(v_hits, v_term);
    end if;
  end loop;

  return v_hits;
end$$;

grant execute on function public.contains_banned_terms(text) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. notify_admins — staff fanout helper
-- ---------------------------------------------------------------------------
-- Notifies every user with role admin / staff_reviewer / staff_author.
-- Single function so the staff list is changed in one place.

create or replace function public.notify_admins(
  p_kind   text,
  p_ref_id uuid,
  p_body   text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_admin_id uuid;
begin
  for v_admin_id in
    select id from public.profiles
     where role in ('admin','staff_reviewer','staff_author')
       and deleted_at is null
  loop
    begin
      perform public.push_notification(v_admin_id, p_kind, p_ref_id, p_body);
    exception when others then null;
    end;
  end loop;
end$$;

grant execute on function public.notify_admins(text, uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. moderate_text — primary daily path
-- ---------------------------------------------------------------------------
-- Called by every RPC that writes user text. Returns '{}' on the clean path.
-- On a match: inserts a moderation_flags row, fires a staff notification,
-- and raises so the caller's write is rejected.

create or replace function public.moderate_text(
  p_text text,
  p_kind text
)
returns text[]
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid        uuid := auth.uid();
  v_target_id  uuid;
  v_target_kind text;
  v_hits       text[];
begin
  if p_kind not in ('bio','name','dm') then
    raise exception 'unknown moderation kind: %', p_kind
      using errcode = '22023';
  end if;

  if p_kind in ('bio','name') then
    v_target_kind := 'profile';
    v_target_id   := v_uid;
  end if;

  v_hits := public.contains_banned_terms(p_text);
  if array_length(v_hits, 1) is null then
    return '{}';
  end if;

  -- Record the flag BEFORE we raise so staff can see what the user tried
  -- to send even though the write was rejected.
  begin
    insert into public.moderation_flags
      (kind, target_kind, target_id, flagged_terms, submitted_text, submitter_id)
    values
      (p_kind, v_target_kind, v_target_id, v_hits, coalesce(p_text, ''), v_uid);
  exception when others then null;
  end;

  -- Notify staff. Never let a notification failure mask the rejection.
  begin
    perform public.notify_admins(
      p_kind || '_flagged',
      null,
      'New ' || p_kind || ' flagged for review'
    );
  exception when others then null;
  end;

  raise exception 'moderation: content contains terms that are not allowed'
    using errcode = 'P0001';
end$$;

grant execute on function public.moderate_text(text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. Seed blocklist
-- ---------------------------------------------------------------------------
-- Lowercase. on conflict do nothing makes re-runs safe.

insert into public.moderation_blocklist (term, severity) values
  ('kys',            'block'),
  ('kill yourself',  'block'),
  ('die in a fire',  'block'),
  ('faggot',         'block'),
  ('fag',            'block'),
  ('tranny',         'block'),
  ('retard',         'block'),
  ('retarded',       'block'),
  ('spic',           'block'),
  ('chink',          'block'),
  ('nigger',         'block'),
  ('nigga',          'block'),
  ('coon',           'block'),
  ('kike',           'block'),
  ('wetback',        'block'),
  ('towelhead',      'block'),
  ('raghead',        'block'),
  ('gook',           'block'),
  ('beaner',         'block'),
  ('darkie',         'block'),
  ('jiggerboo',      'block'),
  ('paki',           'block'),
  ('slope',          'block'),
  ('zipperhead',     'block'),
  ('cunt',           'block'),
  ('twat',           'block'),
  ('whore',          'block'),
  ('slut',           'block'),
  ('motherfucker',   'block'),
  ('motherfucking',  'block'),
  ('shitlord',       'block'),
  ('cumslut',        'block'),
  ('throatcutter',   'block'),
  ('rape',           'block'),
  ('rapist',         'block'),
  ('pedo',           'block'),
  ('paedophile',     'block')
on conflict (term) do nothing;

-- ---------------------------------------------------------------------------
-- 7. set_my_bio (replacement) — moderated bio write
-- ---------------------------------------------------------------------------

create or replace function public.set_my_bio(p_bio text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid   uuid := auth.uid();
  v_clean text;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  v_clean := nullif(btrim(coalesce(p_bio, '')), '');
  if v_clean is not null and char_length(v_clean) > 500 then
    raise exception 'bio too long (max 500 chars)' using errcode = '22023';
  end if;

  -- moderate_text raises if banned terms are present. The flag row is
  -- inserted before the raise, so staff can see what the user tried.
  perform public.moderate_text(coalesce(v_clean, ''), 'bio');

  update public.profiles
    set bio = v_clean,
        updated_at = now()
    where id = v_uid;
end$$;

-- ---------------------------------------------------------------------------
-- 8. set_my_full_name — moderated full_name write
-- ---------------------------------------------------------------------------

create or replace function public.set_my_full_name(p_full_name text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid   uuid := auth.uid();
  v_clean text;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  v_clean := nullif(btrim(coalesce(p_full_name, '')), '');
  if v_clean is not null and char_length(v_clean) > 100 then
    raise exception 'full_name too long (max 100 chars)' using errcode = '22023';
  end if;

  perform public.moderate_text(coalesce(v_clean, ''), 'name');

  update public.profiles
    set full_name = v_clean,
        updated_at = now()
    where id = v_uid;
end$$;

grant execute on function public.set_my_full_name(text) to authenticated;

-- ---------------------------------------------------------------------------
-- 9. send_dm_message (replacement) — moderated DM write
-- ---------------------------------------------------------------------------
-- Same body as the original, but moderate_text is called immediately before
-- the INSERT. If the body contains banned terms, the message is rejected
-- and a flag is recorded. Permissions and membership checks are unchanged.

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
  v_caller      uuid := auth.uid();
  v_msg         public.dm_messages;
  v_thread      public.dm_threads;
  v_recipient   uuid;
  v_sender_name text;
  v_preview     text;
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

  -- Lock the thread row.
  select * into v_thread from public.dm_threads where id = p_thread_id;
  if v_thread.id is null then
    raise exception 'Thread not found' using errcode = 'P0002';
  end if;

  -- MODERATION. Raises on match; clean path falls through.
  perform public.moderate_text(p_body, 'dm');

  insert into public.dm_messages (thread_id, sender_id, body)
  values (p_thread_id, v_caller, p_body)
  returning * into v_msg;

  v_preview := substring(p_body, 1, 80);
  update public.dm_threads
     set last_message_at      = v_msg.created_at,
         last_message_preview = v_preview,
         updated_at           = now()
   where id = p_thread_id;

  select coalesce(p.full_name, 'Someone') into v_sender_name
    from public.profiles p
   where p.id = v_caller;

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
end$$;

grant execute on function public.send_dm_message(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 10. resolve_moderation_flag — staff approve / reject
-- ---------------------------------------------------------------------------
-- Caller must be admin or staff_reviewer. Reject clears bio, replaces full_name
-- with '(redacted)', or deletes the offending DM. Approve leaves the content
-- untouched. DM rejections also clear the thread's last_message_preview if it
-- still points at the deleted message.

create or replace function public.resolve_moderation_flag(
  p_flag_id uuid,
  p_action  text,
  p_notes   text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller uuid := auth.uid();
  v_flag   public.moderation_flags;
  v_thread_id uuid;
begin
  if v_caller is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.profiles
     where id = v_caller
       and role in ('admin','staff_reviewer')
       and deleted_at is null
  ) then
    raise exception 'staff only' using errcode = '42501';
  end if;

  if p_action not in ('approve','reject') then
    raise exception 'action must be approve or reject' using errcode = '22023';
  end if;

  select * into v_flag from public.moderation_flags where id = p_flag_id;
  if v_flag.id is null then
    raise exception 'flag not found' using errcode = 'P0002';
  end if;
  if v_flag.status <> 'pending' then
    raise exception 'flag already resolved' using errcode = 'P0001';
  end if;

  if p_action = 'reject' then
    if v_flag.kind = 'bio' then
      update public.profiles
        set bio = null, updated_at = now()
        where id = v_flag.target_id;
    elsif v_flag.kind = 'name' then
      update public.profiles
        set full_name = '(redacted)', updated_at = now()
        where id = v_flag.target_id;
    elsif v_flag.kind = 'dm' then
      -- Capture the thread id BEFORE deleting the message so we can
      -- update the thread's last_message_preview correctly.
      select thread_id into v_thread_id
        from public.dm_messages where id = v_flag.target_id;

      delete from public.dm_messages where id = v_flag.target_id;

      if v_thread_id is not null then
        update public.dm_threads t
          set last_message_preview = null
          where t.id = v_thread_id
            and t.last_message_preview is not null
            and not exists (
              select 1 from public.dm_messages m
              where m.thread_id = v_thread_id
            );
      end if;
    end if;
  end if;

  update public.moderation_flags
    set status           = p_action,
        resolved_at      = now(),
        resolved_by      = v_caller,
        resolution_notes = p_notes
    where id = p_flag_id
    returning * into v_flag;

  return jsonb_build_object(
    'ok', true,
    'flag_id', v_flag.id,
    'status', v_flag.status,
    'kind', v_flag.kind
  );
end$$;

grant execute on function public.resolve_moderation_flag(uuid, text, text)
  to authenticated;

-- ---------------------------------------------------------------------------
-- 11. list_pending_moderation_flags — queue for the staff UI
-- ---------------------------------------------------------------------------

create or replace function public.list_pending_moderation_flags(
  p_kind   text default null,
  p_limit  int  default 50
)
returns table (
  id              uuid,
  kind            text,
  target_kind     text,
  target_id       uuid,
  flagged_terms   text[],
  submitted_text  text,
  submitter_id    uuid,
  submitter_name  text,
  created_at      timestamptz
)
language sql
security definer
set search_path = public
stable
as $$
  select f.id, f.kind, f.target_kind, f.target_id,
         f.flagged_terms, f.submitted_text,
         f.submitter_id, p.full_name as submitter_name,
         f.created_at
    from public.moderation_flags f
    left join public.profiles p on p.id = f.submitter_id
   where f.status = 'pending'
     and (p_kind is null or f.kind = p_kind)
   order by f.created_at desc
   limit greatest(1, least(p_limit, 200));
$$;

grant execute on function public.list_pending_moderation_flags(text, int)
  to authenticated;

-- ---------------------------------------------------------------------------
-- 12. Column-level grants — close the RLS bypass on bio / full_name
-- ---------------------------------------------------------------------------
-- profiles_update_own (supabase_setup.sql) keeps row-scoping. The actual
-- lockdown is the column grant: authenticated role can no longer UPDATE
-- bio or full_name directly. SECURITY DEFINER RPCs (set_my_bio, set_my_full_name)
-- run as the function owner and write those columns freely.

revoke update on public.profiles from authenticated;

grant update (
  year_group,
  dob,
  parent_email,
  requires_parental_consent,
  consent_status,
  avatar_url,
  role,
  school_id
) on public.profiles to authenticated;

-- ---------------------------------------------------------------------------
-- 13. BEFORE INSERT OR UPDATE trigger on profiles — defense in depth
-- ---------------------------------------------------------------------------
-- Fires on every write path including handle_new_user and complete_student_profile.
-- Catches any future RPC that writes bio / full_name without calling moderate_text.

create or replace function public.profiles_moderate_text()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_hits text[];
begin
  -- On INSERT, old.bio / old.full_name are NULL, so the distinct check
  -- correctly fires whenever the new value is non-NULL.
  if new.bio is distinct from old.bio then
    v_hits := public.contains_banned_terms(new.bio);
    if array_length(v_hits, 1) is not null then
      begin
        insert into public.moderation_flags
          (kind, target_kind, target_id, flagged_terms, submitted_text, submitter_id)
        values
          ('bio', 'profile', new.id, v_hits, coalesce(new.bio, ''), auth.uid());
      exception when others then null;
      end;
      raise exception 'moderation: bio contains terms that are not allowed'
        using errcode = 'P0001';
    end if;
  end if;

  if new.full_name is distinct from old.full_name then
    v_hits := public.contains_banned_terms(new.full_name);
    if array_length(v_hits, 1) is not null then
      begin
        insert into public.moderation_flags
          (kind, target_kind, target_id, flagged_terms, submitted_text, submitter_id)
        values
          ('name', 'profile', new.id, v_hits, coalesce(new.full_name, ''), auth.uid());
      exception when others then null;
      end;
      raise exception 'moderation: full_name contains terms that are not allowed'
        using errcode = 'P0001';
    end if;
  end if;

  return new;
end$$;

drop trigger if exists profiles_moderate_text on public.profiles;
create trigger profiles_moderate_text
  before insert or update of bio, full_name on public.profiles
  for each row execute function public.profiles_moderate_text();

-- ---------------------------------------------------------------------------
-- 14. BEFORE INSERT trigger on dm_messages — defense in depth
-- ---------------------------------------------------------------------------
-- send_dm_message is the only existing writer and RLS already denies direct
-- client writes. This trigger is a safety net for any future RPC.

create or replace function public.dm_messages_moderate_body()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_hits text[];
begin
  v_hits := public.contains_banned_terms(new.body);
  if array_length(v_hits, 1) is not null then
    begin
      insert into public.moderation_flags
        (kind, target_kind, target_id, flagged_terms, submitted_text, submitter_id)
      values
        ('dm', 'dm_message', new.id, v_hits, coalesce(new.body, ''), new.sender_id);
    exception when others then null;
    end;
    raise exception 'moderation: dm message contains terms that are not allowed'
      using errcode = 'P0001';
  end if;
  return new;
end$$;

drop trigger if exists dm_messages_moderate_body on public.dm_messages;
create trigger dm_messages_moderate_body
  before insert on public.dm_messages
  for each row execute function public.dm_messages_moderate_body();
