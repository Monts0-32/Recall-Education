-- ============================================================================
-- Recall Education — Admin area + staff invitation migration
-- Run this AFTER supabase_setup.sql, supabase_tables.sql, supabase_staff.sql,
-- supabase_uploads.sql, supabase_consent_enforcement.sql, and
-- supabase_dashboard.sql. Idempotent: safe to re-run.
--
-- What this does:
--   1. Widens profiles.role to 4 values: student / staff_author /
--      staff_reviewer / admin. Migrates any existing 'staff' users to
--      'staff_author' (preserves their access).
--   2. Adds lessons.status (draft/published/archived), published_at,
--      published_by, and author_id; narrows the public read so
--      students can't see drafts.
--   3. Adds the staff_invites table — mirror of parental_consents.
--   4. Adds the staff_audit_log table — append-only, RPC-only writes.
--   5. Defines 9 SECURITY DEFINER RPCs for invites, role management,
--      publishing, and generic audit logging.
--   6. Updates check_parental_consent to stamp app_metadata.role onto
--      the JWT so client code can read role from session.user.app_metadata
--      and RLS policies can read it from auth.jwt() — no DB round-trip.
--   7. Updates existing RLS policies to accept the new role values.
-- ============================================================================

-- ---------- 1. WIDEN PROFILES.ROLE ---------------------------------------

-- Drop the old 2-value CHECK if present. After this, the column has
-- NO CHECK — any value is temporarily allowed, which is what we want
-- for the data migration below.
alter table public.profiles drop constraint if exists profiles_role_check;

-- One-time data fix: any pre-existing 'staff' user becomes 'staff_author'.
-- This must run BEFORE the new 4-value CHECK is added, otherwise the
-- 'staff' rows would violate the constraint. Idempotent — re-running
-- does nothing once the rows are updated.
update public.profiles
   set role = 'staff_author'
 where role = 'staff';

-- Add the new 4-value CHECK now that no 'staff' rows remain.
alter table public.profiles
  alter column role set default 'student';
alter table public.profiles
  add constraint profiles_role_check
  check (role in ('student', 'staff_author', 'staff_reviewer', 'admin'));

-- ---------- 2. LESSONS.STATUS + PUBLISH METADATA -------------------------

alter table public.lessons
  add column if not exists status text not null default 'draft'
  check (status in ('draft', 'published', 'archived'));
alter table public.lessons
  add column if not exists published_at timestamptz;
alter table public.lessons
  add column if not exists published_by uuid references auth.users(id) on delete set null;
alter table public.lessons
  add column if not exists author_id    uuid references auth.users(id) on delete set null;
create index if not exists lessons_status_idx    on public.lessons (status);
create index if not exists lessons_author_idx   on public.lessons (author_id);
create index if not exists lessons_updated_idx  on public.lessons (updated_at desc)
  where status = 'draft';

-- Rewrite the public read on lessons: students only see published.
-- Staff can see everything (for the editor preview). Anon still sees
-- everything (used by the marketing pages / SEO).
drop policy if exists "lessons_read_all" on public.lessons;
drop policy if exists "lessons_read_published" on public.lessons;
drop policy if exists "lessons_staff_read_all" on public.lessons;
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

-- ---------- 3. STAFF_INVITES TABLE ---------------------------------------
-- Mirror of parental_consents. RLS deny-all; all access is through RPCs.

create table if not exists public.staff_invites (
  id            uuid primary key default gen_random_uuid(),
  email         text not null,
  role          text not null
                check (role in ('staff_author', 'staff_reviewer', 'admin')),
  token         uuid not null default gen_random_uuid() unique,
  status        text not null default 'pending'
                check (status in ('pending', 'accepted', 'revoked', 'expired')),
  invited_by    uuid references auth.users(id) on delete set null,
  accepted_by   uuid references auth.users(id) on delete set null,
  expires_at    timestamptz not null default (now() + interval '14 days'),
  created_at    timestamptz not null default now(),
  decided_at    timestamptz
);
create index if not exists staff_invites_email_idx  on public.staff_invites (email);
create index if not exists staff_invites_status_idx on public.staff_invites (status);
create index if not exists staff_invites_token_idx  on public.staff_invites (token);

alter table public.staff_invites enable row level security;
drop policy if exists "staff_invites_no_client_access" on public.staff_invites;
create policy "staff_invites_no_client_access" on public.staff_invites
  for all to anon, authenticated
  using (false) with check (false);

-- ---------- 4. STAFF_AUDIT_LOG TABLE -------------------------------------
-- Append-only. Reads are allowed for staff (so admin.html can show the
-- log). Writes are RPC-only — there is no INSERT policy for the
-- authenticated role; the SECURITY DEFINER RPCs below are the only way
-- to add rows.

create table if not exists public.staff_audit_log (
  id            uuid primary key default gen_random_uuid(),
  actor_id      uuid references auth.users(id) on delete set null,
  target_id     uuid references auth.users(id) on delete set null,
  action        text not null
                check (action in (
                  'invite_sent', 'invite_revoked', 'invite_resent',
                  'role_changed', 'access_revoked',
                  'lesson_published', 'lesson_unpublished', 'lesson_archived',
                  'admin_login', 'admin_action'
                )),
  resource_type text,
  resource_id   uuid,
  metadata      jsonb not null default '{}'::jsonb,
  ip            inet,
  user_agent    text,
  created_at    timestamptz not null default now()
);
create index if not exists staff_audit_actor_idx  on public.staff_audit_log (actor_id, created_at desc);
create index if not exists staff_audit_target_idx on public.staff_audit_log (target_id, created_at desc);
create index if not exists staff_audit_action_idx on public.staff_audit_log (action, created_at desc);

alter table public.staff_audit_log enable row level security;
drop policy if exists "staff_audit_read" on public.staff_audit_log;
create policy "staff_audit_read" on public.staff_audit_log
  for select to authenticated
  using (
    exists (
      select 1 from public.profiles p
       where p.id = auth.uid()
         and p.role in ('staff_author', 'staff_reviewer', 'admin')
    )
  );
-- No insert/update/delete policy for authenticated; writes only via RPC.

-- ---------- 5. INTERNAL AUDIT HELPER -------------------------------------
-- Centralised writer used by every other RPC. SECURITY DEFINER so it can
-- insert into staff_audit_log (which is RLS-locked for the authenticated
-- role). Reads inet_client_addr() for the IP. The caller passes the
-- user_agent explicitly (RPC parameter) since there's no standard way
-- for an RPC to see the caller's UA.

create or replace function public._log_staff_action(
  p_action        text,
  p_resource_type text default null,
  p_resource_id   uuid default null,
  p_metadata      jsonb default '{}'::jsonb,
  p_user_agent    text default null,
  p_target_id     uuid default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.staff_audit_log
    (actor_id, target_id, action, resource_type, resource_id, metadata, ip, user_agent)
  values
    (auth.uid(), p_target_id, p_action, p_resource_type, p_resource_id,
     coalesce(p_metadata, '{}'::jsonb), inet_client_addr(), p_user_agent);
end;
$$;

grant execute on function public._log_staff_action(
  text, text, uuid, jsonb, text, uuid
) to authenticated;

-- ---------- 6. STAFF_INVITES RPCs ----------------------------------------

-- create_staff_invite: admin-only. Mints (or refreshes) a pending invite
-- for a (email, role) pair. Reuse-any-pending logic so re-sending an
-- invite for the same email+role doesn't orphan the old token — the
-- caller wants ONE active invite per person.
create or replace function public.create_staff_invite(
  p_email text,
  p_role  text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller uuid := auth.uid();
  v_email  text := lower(trim(p_email));
  v_role   text := p_role;
  v_existing public.staff_invites%rowtype;
  v_invite  public.staff_invites%rowtype;
begin
  if v_caller is null then
    raise exception 'not authenticated';
  end if;
  if not exists (
    select 1 from public.profiles
     where id = v_caller and role = 'admin'
  ) then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  if v_role not in ('staff_author', 'staff_reviewer', 'admin') then
    raise exception 'invalid role: %', v_role;
  end if;
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'invalid email';
  end if;

  -- Idempotency: reuse a pending invite for the same (email, role).
  select * into v_existing
    from public.staff_invites
   where email = v_email
     and role  = v_role
     and status = 'pending'
     and expires_at > now()
   limit 1;

  if found then
    update public.staff_invites
       set token      = gen_random_uuid(),
           expires_at = now() + interval '14 days',
           created_at = now(),
           invited_by = v_caller
     where id = v_existing.id
     returning * into v_invite;
  else
    insert into public.staff_invites (email, role, invited_by)
    values (v_email, v_role, v_caller)
    returning * into v_invite;
  end if;

  perform public._log_staff_action(
    'invite_sent', 'staff_invite', v_invite.id,
    jsonb_build_object('email', v_email, 'role', v_role)
  );

  return jsonb_build_object(
    'ok', true,
    'invite_id', v_invite.id,
    'token',     v_invite.token,
    'expires_at', v_invite.expires_at,
    'email',     v_invite.email,
    'role',      v_invite.role
  );
end;
$$;

grant execute on function public.create_staff_invite(text, text) to authenticated;

-- peek_staff_invite: anon-callable. Returns enough to render the
-- accept-invite landing page without leaking the token.
create or replace function public.peek_staff_invite(p_token uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v public.staff_invites%rowtype;
begin
  select * into v from public.staff_invites where token = p_token;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'unknown_token');
  end if;
  if v.status = 'accepted' then
    return jsonb_build_object('ok', false, 'reason', 'already_accepted',
                              'role', v.role, 'email', v.email);
  end if;
  if v.status = 'revoked' then
    return jsonb_build_object('ok', false, 'reason', 'revoked');
  end if;
  if v.expires_at < now() or v.status = 'expired' then
    return jsonb_build_object('ok', false, 'reason', 'expired',
                              'role', v.role, 'email', v.email);
  end if;
  return jsonb_build_object(
    'ok', true,
    'role', v.role,
    'email', v.email,
    'expires_at', v.expires_at,
    'invited_by', v.invited_by
  );
end;
$$;

grant execute on function public.peek_staff_invite(uuid) to anon, authenticated;

-- accept_staff_invite: auth-required. The caller must be signed in and
-- their auth email must match the invite. On accept, sets the user's
-- role to the invite's role and writes the audit log.
create or replace function public.accept_staff_invite(
  p_token    uuid,
  p_decision text default 'accepted'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller uuid := auth.uid();
  v_caller_email text;
  v public.staff_invites%rowtype;
begin
  if v_caller is null then
    raise exception 'not authenticated';
  end if;
  if p_decision <> 'accepted' then
    raise exception 'decision must be "accepted"';
  end if;

  select * into v from public.staff_invites where token = p_token for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'unknown_token');
  end if;
  if v.status = 'accepted' then
    return jsonb_build_object('ok', false, 'reason', 'already_accepted');
  end if;
  if v.status = 'revoked' then
    return jsonb_build_object('ok', false, 'reason', 'revoked');
  end if;
  if v.expires_at < now() then
    update public.staff_invites
       set status = 'expired', decided_at = now()
     where id = v.id;
    return jsonb_build_object('ok', false, 'reason', 'expired');
  end if;

  -- Email must match — staff invites are personal, not transferable.
  select lower(email) into v_caller_email from auth.users where id = v_caller;
  if v_caller_email is null or v_caller_email <> lower(v.email) then
    return jsonb_build_object('ok', false, 'reason', 'email_mismatch',
                              'invited_email', v.email);
  end if;

  update public.profiles
     set role = v.role,
         updated_at = now()
   where id = v_caller;

  update public.staff_invites
     set status = 'accepted',
         decided_at = now(),
         accepted_by = v_caller
   where id = v.id;

  perform public._log_staff_action(
    'role_changed', 'profile', v_caller,
    jsonb_build_object('via_invite', true, 'role', v.role)
  );

  return jsonb_build_object('ok', true, 'role', v.role);
end;
$$;

grant execute on function public.accept_staff_invite(uuid, text) to authenticated;

-- resend_staff_invite: admin-only. Bumps the token and expiry.
create or replace function public.resend_staff_invite(p_invite_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v public.staff_invites%rowtype;
begin
  if not exists (
    select 1 from public.profiles where id = auth.uid() and role = 'admin'
  ) then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  select * into v from public.staff_invites where id = p_invite_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'unknown_invite');
  end if;
  if v.status <> 'pending' then
    return jsonb_build_object('ok', false, 'reason', 'not_pending', 'status', v.status);
  end if;
  update public.staff_invites
     set token = gen_random_uuid(),
         expires_at = now() + interval '14 days',
         created_at = now()
   where id = v.id
   returning * into v;

  perform public._log_staff_action(
    'invite_resent', 'staff_invite', v.id,
    jsonb_build_object('email', v.email, 'role', v.role)
  );

  return jsonb_build_object('ok', true, 'invite_id', v.id,
                            'token', v.token, 'expires_at', v.expires_at);
end;
$$;

grant execute on function public.resend_staff_invite(uuid) to authenticated;

-- revoke_staff_invite: admin-only. Marks an invite revoked.
create or replace function public.revoke_staff_invite(p_invite_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v public.staff_invites%rowtype;
begin
  if not exists (
    select 1 from public.profiles where id = auth.uid() and role = 'admin'
  ) then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  select * into v from public.staff_invites where id = p_invite_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'unknown_invite');
  end if;
  if v.status <> 'pending' then
    return jsonb_build_object('ok', false, 'reason', 'not_pending', 'status', v.status);
  end if;
  update public.staff_invites
     set status = 'revoked', decided_at = now()
   where id = v.id;

  perform public._log_staff_action(
    'invite_revoked', 'staff_invite', v.id,
    jsonb_build_object('email', v.email, 'role', v.role)
  );

  return jsonb_build_object('ok', true);
end;
$$;

grant execute on function public.revoke_staff_invite(uuid) to authenticated;

-- list_staff_invites: admin-only. Returns the rows for one status
-- (pending/accepted/revoked/expired). The staff_invites table is
-- RLS-deny-all, so the client has no other way to read it.
create or replace function public.list_staff_invites(p_status text)
returns table (
  id          uuid,
  email       text,
  role        text,
  token       uuid,
  status      text,
  invited_by  uuid,
  accepted_by uuid,
  expires_at  timestamptz,
  created_at  timestamptz,
  decided_at  timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1 from public.profiles where id = auth.uid() and role = 'admin'
  ) then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  return query
    select i.id, i.email, i.role, i.token, i.status, i.invited_by,
           i.accepted_by, i.expires_at, i.created_at, i.decided_at
      from public.staff_invites i
     where i.status = p_status
     order by i.created_at desc
     limit 200;
end;
$$;

grant execute on function public.list_staff_invites(text) to authenticated;

-- count_staff_invites: returns the count of pending invites. Used
-- by the dashboard's KPI tile. Tiny SECURITY DEFINER function so we
-- don't have to RLS-open staff_invites.
create or replace function public.count_staff_invites(p_status text default 'pending')
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count int;
begin
  if not exists (
    select 1 from public.profiles
     where id = auth.uid()
       and role in ('staff_author', 'staff_reviewer', 'admin')
  ) then
    raise exception 'staff role required' using errcode = '42501';
  end if;
  select count(*) into v_count from public.staff_invites where status = p_status;
  return v_count;
end;
$$;

grant execute on function public.count_staff_invites(text) to authenticated;

-- ---------- 7. ROLE MANAGEMENT RPCs --------------------------------------

-- change_staff_role: admin-only. Updates a profile's role. Refuses to
-- demote yourself (a safety check so you don't lock the owner out).
create or replace function public.change_staff_role(
  p_target_user_id uuid,
  p_new_role       text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller  uuid := auth.uid();
  v_target  public.profiles%rowtype;
  v_old_role text;
begin
  if v_caller is null then
    raise exception 'not authenticated';
  end if;
  if not exists (
    select 1 from public.profiles where id = v_caller and role = 'admin'
  ) then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  if p_new_role not in ('student', 'staff_author', 'staff_reviewer', 'admin') then
    raise exception 'invalid role: %', p_new_role;
  end if;
  if p_target_user_id = v_caller and p_new_role <> 'admin' then
    return jsonb_build_object('ok', false, 'reason', 'cannot_demote_self');
  end if;

  select * into v_target from public.profiles where id = p_target_user_id;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'unknown_user');
  end if;
  v_old_role := v_target.role;

  update public.profiles
     set role = p_new_role, updated_at = now()
   where id = p_target_user_id;

  perform public._log_staff_action(
    'role_changed', 'profile', p_target_user_id,
    jsonb_build_object('from', v_old_role, 'to', p_new_role),
    null,
    p_target_user_id
  );

  return jsonb_build_object('ok', true, 'from', v_old_role, 'to', p_new_role);
end;
$$;

grant execute on function public.change_staff_role(uuid, text) to authenticated;

-- revoke_staff_access: admin-only. Demotes the user to 'student' and
-- soft-deletes (deleted_at = now()). The auth hook will then block
-- future sign-ins with account_removed.
create or replace function public.revoke_staff_access(p_target_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller uuid := auth.uid();
  v_target public.profiles%rowtype;
begin
  if v_caller is null then
    raise exception 'not authenticated';
  end if;
  if not exists (
    select 1 from public.profiles where id = v_caller and role = 'admin'
  ) then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  if p_target_user_id = v_caller then
    return jsonb_build_object('ok', false, 'reason', 'cannot_revoke_self');
  end if;
  select * into v_target from public.profiles where id = p_target_user_id;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'unknown_user');
  end if;

  update public.profiles
     set role = 'student',
         deleted_at = now(),
         updated_at = now()
   where id = p_target_user_id;

  perform public._log_staff_action(
    'access_revoked', 'profile', p_target_user_id,
    jsonb_build_object('previous_role', v_target.role),
    null,
    p_target_user_id
  );

  return jsonb_build_object('ok', true);
end;
$$;

grant execute on function public.revoke_staff_access(uuid) to authenticated;

-- ---------- 8. PUBLISH-LESSON RPC ----------------------------------------

-- publish_lesson: reviewer-or-admin. Flips status between draft and
-- published. Archiving is not exposed in the admin UI yet but the
-- function accepts it.
create or replace function public.publish_lesson(
  p_lesson_id uuid,
  p_publish   boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller uuid := auth.uid();
  v_lesson public.lessons%rowtype;
  v_new_status text;
begin
  if v_caller is null then
    raise exception 'not authenticated';
  end if;
  if not exists (
    select 1 from public.profiles
     where id = v_caller
       and role in ('staff_reviewer', 'admin')
  ) then
    raise exception 'reviewer or admin role required' using errcode = '42501';
  end if;
  select * into v_lesson from public.lessons where id = p_lesson_id;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'unknown_lesson');
  end if;

  if p_publish then
    v_new_status := 'published';
    update public.lessons
       set status = v_new_status,
           published_at = now(),
           published_by = v_caller
     where id = p_lesson_id;
    perform public._log_staff_action(
      'lesson_published', 'lesson', p_lesson_id,
      jsonb_build_object('title', v_lesson.title)
    );
  else
    v_new_status := 'draft';
    update public.lessons
       set status = v_new_status,
           published_at = null,
           published_by = null
     where id = p_lesson_id;
    perform public._log_staff_action(
      'lesson_unpublished', 'lesson', p_lesson_id,
      jsonb_build_object('title', v_lesson.title)
    );
  end if;

  return jsonb_build_object(
    'ok', true,
    'status', v_new_status,
    'published_at', case when p_publish then now() else null end
  );
end;
$$;

grant execute on function public.publish_lesson(uuid, boolean) to authenticated;

-- ---------- 9. GENERIC AUDIT LOG ----------------------------------------
-- Public escape hatch for any other admin action. The Edge Function or
-- admin.html calls this for things not worth their own RPC.

create or replace function public.log_staff_action(
  p_action        text,
  p_resource_type text default null,
  p_resource_id   uuid default null,
  p_metadata      jsonb default '{}'::jsonb,
  p_user_agent    text default null,
  p_target_id     uuid default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1 from public.profiles
     where id = auth.uid()
       and role in ('staff_author', 'staff_reviewer', 'admin')
  ) then
    raise exception 'staff role required' using errcode = '42501';
  end if;
  perform public._log_staff_action(
    p_action, p_resource_type, p_resource_id, p_metadata, p_user_agent, p_target_id
  );
end;
$$;

grant execute on function public.log_staff_action(
  text, text, uuid, jsonb, text, uuid
) to authenticated;

-- ---------- 10. UPDATE EXISTING STAFF RLS POLICIES ----------------------
-- The policies added by supabase_staff.sql checked role = 'staff'.
-- They've been left in place, but they won't match the new role
-- values. Replace them with versions that accept any of the three
-- staff roles. The narrow form (e.g. 'reviewer only') is enforced by
-- the RPCs above, not by RLS — keeps policies simple.

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

-- ---------- 11. UPDATE AUTH HOOK -----------------------------------------
-- Extend check_parental_consent to also stamp app_metadata.role onto the
-- JWT. After this change:
--   * auth.jwt() -> 'app_metadata' ->> 'role' returns the user's role
--   * session.user.app_metadata.role returns the role in JS
--   * RLS policies can use (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
--
-- The existing soft-delete + email/signup exceptions are preserved.

create or replace function public.check_parental_consent(event jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  user_id      uuid := (event->>'user_id')::uuid;
  p            public.profiles%rowtype;
  auth_method  text := event->>'authentication_method';
  claims       jsonb;
begin
  select * into p from public.profiles where id = user_id;

  if not found then
    return event; -- profile row not yet written; allow through
  end if;

  -- Soft-deleted accounts are blocked from signing in entirely.
  if p.deleted_at is not null then
    raise exception 'account_removed' using errcode = '42501';
  end if;

  -- Under-16s need parental consent before they can do anything.
  if p.requires_parental_consent and p.consent_status <> 'granted' then
    if auth_method = 'email/signup' then
      return event; -- let the confirmation token through
    end if;
    raise exception 'parental_consent_required' using errcode = '42501';
  end if;

  -- Stamp role onto the JWT so RLS + client code can read it.
  claims := coalesce(event->'app_metadata', '{}'::jsonb);
  claims := jsonb_set(claims, '{role}', to_jsonb(p.role));
  event  := jsonb_set(event, '{app_metadata}', claims);

  return event;
end;
$$;

grant execute on function public.check_parental_consent(jsonb) to supabase_auth_admin;

-- ============================================================================
-- DONE. After running this:
--   1. Re-enable the Custom Access Token hook in the Supabase dashboard
--      (Auth → Hooks → Custom Access Token → public.check_parental_consent)
--      so the role claim flows into every new JWT.
--   2. Deploy the new Edge Function: supabase functions deploy send-staff-invite
--   3. Set the RESEND_API_KEY secret (same one used by send-consent-email).
--   4. Sign out and back in (to refresh your JWT with the new role claim).
--   5. The very first owner (you) — run this one-liner to promote yourself
--      to admin so admin.html will load:
--         update public.profiles set role = 'admin' where id = '<your-user-id>';
--      After that, use admin.html → Staff → Invites to bring on teammates.
-- ============================================================================
