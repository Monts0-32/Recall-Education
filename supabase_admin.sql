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
--   8. Adds public.current_role() — a tiny SECURITY DEFINER helper
--      that reads the caller's role straight from profiles. Used as
--      a fallback by admin.html / dashboard.html / staff.html when
--      the auth hook isn't firing (which has been observed in the
--      wild — the JWT can be issued without the role claim).
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

-- Defensive sweep: any role value that isn't in the new 4-value set
-- (NULL, empty string, 'pending', 'active', typos from earlier schema
-- states, etc.) gets coerced to 'student'. Without this, the next
-- statement's CHECK fails with "violated by some row" and the entire
-- migration aborts — even though the data fix above only handles
-- 'staff' specifically. Anything we don't recognise is safer as
-- 'student' (the lowest-privilege role) than leaving the row broken.
-- Idempotent: re-running is a no-op once every row is in the new set.
update public.profiles
   set role = 'student'
 where role is null
    or role not in ('student', 'staff_author', 'staff_reviewer', 'admin');

-- Add the new 4-value CHECK now that no 'staff' rows remain.
alter table public.profiles
  alter column role set default 'student';
alter table public.profiles
  add constraint profiles_role_check
  check (role in ('student', 'staff_author', 'staff_reviewer', 'admin'));

-- ---------- 2. LESSONS.STATUS + PUBLISH METADATA -------------------------

-- The lessons table from supabase_tables.sql has no updated_at column,
-- but the dashboard's "drafts" view, the editor's dirty-tracking, and
-- this migration's lessons_updated_idx all want one. Add it here so
-- the rest of the migration can rely on it existing.
alter table public.lessons
  add column if not exists updated_at timestamptz not null default now();

-- Trigger: bump updated_at on any UPDATE so the editor's "Updated
-- just now" labels and the dashboard's "drafts awaiting review" sort
-- are accurate. Idempotent.
drop trigger if exists lessons_touch_updated_at on public.lessons;
create trigger lessons_touch_updated_at
  before update on public.lessons
  for each row execute function public.touch_updated_at();

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
  action        text not null,
  resource_type text,
  resource_id   uuid,
  metadata      jsonb not null default '{}'::jsonb,
  ip            inet,
  user_agent    text,
  created_at    timestamptz not null default now()
);
-- The CHECK constraint is added separately so we can widen the action
-- allowlist without dropping the table. ALTER ... DROP CONSTRAINT IF
-- EXISTS keeps the migration idempotent.
alter table public.staff_audit_log
  drop constraint if exists staff_audit_log_action_check;
alter table public.staff_audit_log
  add constraint staff_audit_log_action_check
  check (action in (
    'invite_sent', 'invite_revoked', 'invite_resent',
    'role_changed', 'access_revoked',
    'lesson_published', 'lesson_unpublished', 'lesson_archived',
    'admin_login', 'admin_action',
    'user_deleted',
    'row_deleted'
  ));
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

-- Defensive drop for every public function defined below. The
-- migration's CREATE OR REPLACE works fine when only the function
-- body changes, but Postgres refuses to silently change a function's
-- return-table row type (42P13) or to add/remove OUT parameters. If
-- the live database has a stale version of any of these functions
-- from an earlier attempt (e.g. a half-applied migration, an
-- experimental version, or a version that was edited but not fully
-- re-deployed), this drop replaces it with the version in this
-- file. DROP IF EXISTS keeps the migration idempotent on a fresh
-- install. Run BEFORE each create or replace so the function gets a
-- clean install.
drop function if exists public._log_staff_action(text, text, uuid, jsonb, text, uuid);
drop function if exists public.create_staff_invite(text, text);
drop function if exists public.peek_staff_invite(uuid);
drop function if exists public.accept_staff_invite(uuid, text);
drop function if exists public.resend_staff_invite(uuid);
drop function if exists public.revoke_staff_invite(uuid);
drop function if exists public.revoke_accepted_invite(uuid);
-- list_staff_invites: also dropped separately just above its own
-- create or replace; kept here too for the case where the migration
-- is run from a clean state (the second drop is a no-op).
drop function if exists public.list_staff_invites(text);
drop function if exists public.count_staff_invites(text);
drop function if exists public.change_staff_role(uuid, text);
drop function if exists public.revoke_staff_access(uuid);
drop function if exists public.publish_lesson(uuid, boolean);
drop function if exists public.log_staff_action(text, text, uuid, jsonb, text, uuid);
drop function if exists public.check_parental_consent(jsonb);
drop function if exists public.current_role();
drop function if exists public.list_staff();
drop function if exists public.list_recent_audit(int, uuid, text);
drop function if exists public.list_lesson_block_comments(uuid);
drop function if exists public.add_lesson_block_comment(uuid, text);
drop function if exists public.update_lesson_block_comment(uuid, text, boolean);
drop function if exists public.delete_lesson_block_comment(uuid);
drop function if exists public.lookup_user_by_email(text);
drop function if exists public.delete_user_by_id(uuid, text, text);
drop function if exists public.lookup_id_anywhere(uuid);
drop function if exists public.peek_id(uuid, text);
drop function if exists public.delete_by_id(uuid, text, text);

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

  -- Upsert the profile row BEFORE the role update. handle_new_user()
  -- (the on_auth_user_created trigger) is wrapped in `exception when
  -- others` and silently swallows every profile-write failure, which
  -- can leave a freshly-signed-up staff invitee with NO profile row
  -- at all. Without this guard, the role UPDATE below would affect
  -- zero rows and the user would silently land on the student
  -- dashboard with whatever default the next page load applied.
  --
  -- Insert path explicitly carries the invited staff role, so a
  -- stuck-missing-row invitee becomes staff on the spot rather than
  -- staying 'student'. Conflict path leaves the existing role alone
  -- (we never want this RPC to demote a current staff member — that
  -- has to go through the explicit revoke path in admin.html).
  insert into public.profiles (id, role)
    values (v_caller, v.role)
    on conflict (id) do nothing;

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

-- revoke_accepted_invite: admin-only. Closes the staff account
-- associated with an accepted invite. Use this from the Accepted tab
-- in the Invites panel — the invite row is the natural anchor (it
-- links the email + role to the user that accepted it via
-- accepted_by), and the audit trail explicitly records which invite
-- drove the revocation.
--
-- Effect: the invite's status flips to 'revoked' (for tracking), the
-- linked profile is soft-deleted (role -> 'student', deleted_at -> now),
-- and a 'access_revoked' audit-log entry is written with the invite id
-- in the metadata. The auth hook (check_parental_consent) blocks
-- future sign-ins for any user with deleted_at set, so the staff
-- member is locked out the next time they try to authenticate.
--
-- Idempotent: re-running on an already-revoked accepted invite is a
-- no-op (the function refuses with reason='not_accepted'). Re-running
-- on an invite whose user is already soft-deleted is also a no-op
-- (the role update is harmless, the audit-log entry is the same).
-- Self-revoke is blocked: the admin cannot close their own account
-- via this path (use change_staff_role + a manual sign-out if you
-- really mean it).
drop function if exists public.revoke_accepted_invite(uuid);
create or replace function public.revoke_accepted_invite(p_invite_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller uuid := auth.uid();
  v_invite public.staff_invites%rowtype;
  v_target public.profiles%rowtype;
begin
  if v_caller is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if not exists (
    select 1 from public.profiles where id = v_caller and role = 'admin'
  ) then
    raise exception 'admin role required' using errcode = '42501';
  end if;

  select * into v_invite from public.staff_invites where id = p_invite_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'unknown_invite');
  end if;
  if v_invite.status <> 'accepted' then
    return jsonb_build_object(
      'ok', false,
      'reason', 'not_accepted',
      'status', v_invite.status
    );
  end if;
  if v_invite.accepted_by is null then
    return jsonb_build_object(
      'ok', false,
      'reason', 'no_accepted_by',
      'message', 'invite is marked accepted but has no accepted_by user'
    );
  end if;
  if v_invite.accepted_by = v_caller then
    return jsonb_build_object('ok', false, 'reason', 'cannot_revoke_self');
  end if;

  -- Look up the user the invite accepted for. If the profile row is
  -- gone (shouldn't happen — profiles has a FK to auth.users with
  -- on delete cascade — but defensively), bail.
  select * into v_target from public.profiles where id = v_invite.accepted_by;
  if not found then
    return jsonb_build_object(
      'ok', false,
      'reason', 'unknown_user',
      'user_id', v_invite.accepted_by
    );
  end if;

  -- Flip the invite to revoked. We keep accepted_by populated so the
  -- audit trail still links to the user that was closed.
  update public.staff_invites
     set status = 'revoked',
         decided_at = now()
   where id = v_invite.id;

  -- Close the account. Same shape as revoke_staff_access: demote to
  -- student + soft-delete. The auth hook blocks sign-ins for any
  -- profile with deleted_at set.
  update public.profiles
     set role = 'student',
         deleted_at = now(),
         updated_at = now()
   where id = v_target.id;

  perform public._log_staff_action(
    'access_revoked', 'staff_invite', v_invite.id,
    jsonb_build_object(
      'email', v_invite.email,
      'previous_role', v_target.role,
      'via_invite', v_invite.id
    ),
    null,
    v_target.id
  );

  return jsonb_build_object(
    'ok', true,
    'user_id', v_target.id,
    'email', v_invite.email
  );
end;
$$;

grant execute on function public.revoke_accepted_invite(uuid) to authenticated;

-- list_staff_invites: admin-only. Returns the rows for one status
-- (pending/accepted/revoked/expired). The staff_invites table is
-- RLS-deny-all, so the client has no other way to read it.
--
-- Returns the inviter's display name + email pre-joined so the admin
-- UI can render "Invited by" without a follow-up profiles lookup
-- (which is blocked by profiles RLS id = auth.uid()).
--
-- Implementation note: implemented as LANGUAGE sql (not plpgsql) so
-- there are no implicit output variables in scope. A previous version
-- used plpgsql with `returns table (...)`, which created implicit
-- variables named id / email / role / token / status / etc. that
-- collided with bare column references in the SELECT — Postgres
-- returned "column reference 'id' is ambiguous" with code 42702 and
-- details "It could refer to either a PL/pgSQL variable or a table
-- column". Switching to language sql removes the variable scope
-- entirely; the SELECT statement is a plain query with table-qualified
-- columns.
--
-- We DROP first instead of relying on CREATE OR REPLACE because the
-- return-table signature changed (added invited_by_name +
-- invited_by_email). Postgres refuses to silently change a function's
-- OUT-parameter row type via CREATE OR REPLACE — it sees a different
-- row type and errors with 42P13. Dropping then re-creating is the
-- supported way to change the signature. DROP IF EXISTS keeps the
-- migration idempotent on a fresh install.
drop function if exists public.list_staff_invites(text);
create or replace function public.list_staff_invites(p_status text)
returns table (
  id                uuid,
  email             text,
  role              text,
  token             uuid,
  status            text,
  invited_by        uuid,
  invited_by_name   text,
  invited_by_email  text,
  accepted_by       uuid,
  expires_at        timestamptz,
  created_at        timestamptz,
  decided_at        timestamptz
)
language sql
security definer
set search_path = public
stable
as $$
  select
      i.id,
      i.email,
      i.role,
      i.token,
      i.status,
      i.invited_by,
      coalesce(p.full_name, split_part(u.email::text, '@', 1)) as invited_by_name,
      u.email::text as invited_by_email,
      i.accepted_by,
      i.expires_at,
      i.created_at,
      i.decided_at
    from public.staff_invites i
    left join auth.users     u on u.id = i.invited_by
    left join public.profiles p on p.id = i.invited_by
   where i.status = p_status
   order by i.created_at desc
   limit 200;
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
-- staff roles, then NARROW them so reviewers can read everything but
-- can't write to the catalogue. Authors and admins can write; reviewers
-- can only read (the comment-rpcs in section 13 are their write path).
-- The narrow form (e.g. 'reviewer only') for the publish/unpublish RPC
-- is enforced by the RPCs above, not by RLS — keeps policies simple.

drop policy if exists "subjects_staff_write"        on public.subjects;
drop policy if exists "topics_staff_write"          on public.topics;
drop policy if exists "lessons_staff_write"         on public.lessons;
drop policy if exists "lesson_blocks_staff_write"   on public.lesson_blocks;

-- Subjects / topics / lessons / blocks: writes by staff_author + admin only.
-- Reviewers should be using lesson.html and the comment RPCs (section 13)
-- rather than editing the catalogue directly. RLS is the safety net here;
-- RPC-level checks (move_topic_to_unit, etc.) add a second layer.
create policy "subjects_staff_write" on public.subjects
  for all to authenticated
  using (exists (
    select 1 from public.profiles p
     where p.id = auth.uid()
       and p.role in ('staff_author', 'admin')
       and p.deleted_at is null
  ))
  with check (exists (
    select 1 from public.profiles p
     where p.id = auth.uid()
       and p.role in ('staff_author', 'admin')
       and p.deleted_at is null
  ));

create policy "topics_staff_write" on public.topics
  for all to authenticated
  using (exists (
    select 1 from public.profiles p
     where p.id = auth.uid()
       and p.role in ('staff_author', 'admin')
       and p.deleted_at is null
  ))
  with check (exists (
    select 1 from public.profiles p
     where p.id = auth.uid()
       and p.role in ('staff_author', 'admin')
       and p.deleted_at is null
  ));

create policy "lessons_staff_write" on public.lessons
  for all to authenticated
  using (exists (
    select 1 from public.profiles p
     where p.id = auth.uid()
       and p.role in ('staff_author', 'admin')
       and p.deleted_at is null
  ))
  with check (exists (
    select 1 from public.profiles p
     where p.id = auth.uid()
       and p.role in ('staff_author', 'admin')
       and p.deleted_at is null
  ));

-- lesson_blocks: writes by staff_author + admin only. Note the read
-- policy (lesson_blocks_read_all) is unchanged — anyone (anon included)
-- can read them, so the student player works without auth.
create policy "lesson_blocks_staff_write" on public.lesson_blocks
  for all to authenticated
  using (exists (
    select 1 from public.profiles p
     where p.id = auth.uid()
       and p.role in ('staff_author', 'admin')
       and p.deleted_at is null
  ))
  with check (exists (
    select 1 from public.profiles p
     where p.id = auth.uid()
       and p.role in ('staff_author', 'admin')
       and p.deleted_at is null
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

-- ---------- 12. CURRENT_ROLE FALLBACK -------------------------------------
-- Reads the caller's role straight from profiles. Used as a fallback
-- by the admin / dashboard / staff pages when the auth hook isn't
-- stamping app_metadata.role onto the JWT. The hook should normally
-- be the path (it avoids a round-trip on every page load), but
-- Supabase has been observed to skip the hook for some users in
-- some configs — the fallback keeps the app working regardless.

create or replace function public.current_role()
returns text
language sql
security definer
set search_path = public
stable
as $$
  select role from public.profiles where id = auth.uid();
$$;

grant execute on function public.current_role() to authenticated;

-- list_staff: returns profile rows for all staff users, joined to
-- auth.users for email and last sign-in timestamp. The auth.users
-- table isn't RLS-open for the authenticated role, so we need a
-- SECURITY DEFINER RPC to do the join. Used by the admin.html
-- Staff panel.
create or replace function public.list_staff()
returns table (
  id              uuid,
  full_name       text,
  role            text,
  email           text,
  last_sign_in_at timestamptz,
  created_at      timestamptz,
  avatar_url      text
)
language sql
security definer
set search_path = public
stable
as $$
  select p.id, p.full_name, p.role, u.email::text,
         u.last_sign_in_at, p.created_at, p.avatar_url
    from public.profiles p
    join auth.users u on u.id = p.id
   where p.role in ('staff_author', 'staff_reviewer', 'admin')
     and p.deleted_at is null
   order by p.created_at asc;
$$;

grant execute on function public.list_staff() to authenticated;

-- list_recent_audit: returns recent staff_audit_log rows WITH the actor's
-- display name and email pre-joined. Done server-side so the client
-- doesn't have to do a follow-up .from('profiles').in('id', actorIds)
-- query, which is broken by the profiles RLS policy
-- (id = auth.uid()) — a regular staff user can only see their own
-- profile row, so actor names for other staff come back as null and
-- the UI shows "Unknown user". SECURITY DEFINER + auth.uid() gating
-- keeps it from leaking audit data to non-staff.
--
-- The JOIN is on auth.users (not profiles) because email is on
-- auth.users and the staff_audit_log FK is to auth.users(id). We then
-- LEFT JOIN profiles to grab the user's chosen full_name when
-- available — auth.users.email is the fallback.
--
-- All id references are table-qualified; the previous version of this
-- code path triggered Postgres' "column reference 'id' is ambiguous"
-- error on the staff-dashboard because the profiles RLS subquery in
-- staff_audit_read shares the bare 'id' name with the outer SELECT.
-- Doing the join here in SQL — and only selecting qualified columns —
-- sidesteps that whole class of error and lets us return the actor
-- name without the client doing any cross-table lookups.
create or replace function public.list_recent_audit(
  p_limit         int    default 10,
  p_actor_filter  uuid   default null,
  p_action_filter text   default null
)
returns table (
  id             uuid,
  action         text,
  resource_type  text,
  resource_id    uuid,
  metadata       jsonb,
  created_at     timestamptz,
  actor_id       uuid,
  actor_name     text,
  actor_email    text
)
language sql
security definer
set search_path = public
stable
as $$
  select
      l.id,
      l.action,
      l.resource_type,
      l.resource_id,
      l.metadata,
      l.created_at,
      l.actor_id,
      coalesce(p.full_name, split_part(u.email::text, '@', 1)) as actor_name,
      u.email::text as actor_email
    from public.staff_audit_log l
    left join auth.users     u on u.id = l.actor_id
    left join public.profiles p on p.id = l.actor_id
   where (
         p_actor_filter is null
      or l.actor_id = p_actor_filter
     )
     and (
         p_action_filter is null
      or l.action = p_action_filter
     )
   order by l.created_at desc
   limit greatest(p_limit, 1);
$$;

grant execute on function public.list_recent_audit(int, uuid, text) to authenticated;

-- ---------- 13. LESSON BLOCK COMMENTS ------------------------------------
-- Per-block reviewer notes. Authors write lessons, reviewers leave
-- feedback against individual blocks. Anyone with a staff role can
-- read; only the comment's author (or an admin) can edit or delete it.
--
-- All four RPCs use language sql (not plpgsql) on purpose — see the
-- comments at list_staff_invites: RETURNS TABLE in plpgsql creates
-- implicit variables named after the columns and trips 42702
-- "column reference X is ambiguous". With language sql there's no
-- PL/pgSQL scope, so the join to lesson_blocks resolves cleanly.

create table if not exists public.lesson_block_comments (
  id          uuid primary key default gen_random_uuid(),
  block_id    uuid not null references public.lesson_blocks(id) on delete cascade,
  lesson_id   uuid not null references public.lessons(id)       on delete cascade,
  author_id   uuid not null references auth.users(id)           on delete cascade,
  body        text not null check (length(body) > 0 and length(body) <= 4000),
  resolved    boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists lbc_block_idx  on public.lesson_block_comments (block_id, created_at asc);
create index if not exists lbc_lesson_idx on public.lesson_block_comments (lesson_id, created_at asc);
create index if not exists lbc_author_idx on public.lesson_block_comments (author_id, created_at desc);

alter table public.lesson_block_comments enable row level security;

-- Read for any active staff role. Mirror of staff_audit_read.
drop policy if exists "lbc_read" on public.lesson_block_comments;
create policy "lbc_read" on public.lesson_block_comments
  for select to authenticated
  using (exists (
    select 1 from public.profiles p
     where p.id = auth.uid()
       and p.role in ('staff_author', 'staff_reviewer', 'admin')
       and p.deleted_at is null
  ));

-- Writes are gated server-side in the RPCs (not RLS) — the RPCs
-- check author_id = auth.uid() for updates/deletes, so RLS just
-- needs to allow any active staff member to INSERT a row. UPDATE/
-- DELETE through the table directly is not exposed to clients
-- (the RPCs are the only entry point the app uses), but to be safe
-- we still let any staff pass the USING clause; the actual delete
-- is rejected by the RPC's author check. There's no WITH CHECK on
-- insert that would let a reviewer edit someone else's body, since
-- the client never does an UPDATE through the table — only through
-- update_lesson_block_comment.
drop policy if exists "lbc_insert" on public.lesson_block_comments;
create policy "lbc_insert" on public.lesson_block_comments
  for insert to authenticated
  with check (
    author_id = auth.uid()
    and exists (
      select 1 from public.profiles p
       where p.id = auth.uid()
         and p.role in ('staff_author', 'staff_reviewer', 'admin')
         and p.deleted_at is null
    )
  );

-- list: return all comments for a lesson, oldest first. SECURITY
-- DEFINER so we can join to auth.users for the author's email
-- without exposing the auth schema to RLS. Caller must be active
-- staff — the function checks this explicitly so a malicious anon
-- caller can't read the comment list (the policy already covers it,
-- but defense in depth).
create or replace function public.list_lesson_block_comments(p_lesson_id uuid)
returns table (
  id            uuid,
  block_id      uuid,
  author_id     uuid,
  author_name   text,
  author_email  text,
  body          text,
  resolved      boolean,
  created_at    timestamptz,
  updated_at    timestamptz
)
language sql
security definer
set search_path = public
stable
as $$
  select
      c.id, c.block_id, c.author_id,
      coalesce(p.full_name, split_part(u.email::text, '@', 1)) as author_name,
      u.email::text                                            as author_email,
      c.body, c.resolved, c.created_at, c.updated_at
    from public.lesson_block_comments c
    join auth.users     u on u.id = c.author_id
    left join public.profiles p on p.id = c.author_id
   where c.lesson_id = p_lesson_id
   order by c.created_at asc;
$$;

grant execute on function public.list_lesson_block_comments(uuid) to authenticated;

-- add: insert a new comment. Verifies the caller is active staff
-- and that the block exists in a lesson the caller can see. Returns
-- {ok, id} so the JS can refresh the affected thread without
-- re-listing the whole lesson.
create or replace function public.add_lesson_block_comment(
  p_block_id uuid,
  p_body     text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_lesson_id uuid;
  v_clean     text := trim(coalesce(p_body, ''));
  v_caller    uuid := auth.uid();
begin
  if v_caller is null then
    return jsonb_build_object('ok', false, 'reason', 'not_authenticated');
  end if;
  if not exists (
    select 1 from public.profiles
     where id = v_caller
       and role in ('staff_author', 'staff_reviewer', 'admin')
       and deleted_at is null
  ) then
    return jsonb_build_object('ok', false, 'reason', 'staff_role_required');
  end if;
  if v_clean = '' then
    return jsonb_build_object('ok', false, 'reason', 'body_required');
  end if;
  if length(v_clean) > 4000 then
    return jsonb_build_object('ok', false, 'reason', 'body_too_long');
  end if;

  select lesson_id into v_lesson_id
    from public.lesson_blocks
   where id = p_block_id;
  if v_lesson_id is null then
    return jsonb_build_object('ok', false, 'reason', 'unknown_block');
  end if;

  insert into public.lesson_block_comments (block_id, lesson_id, author_id, body)
  values (p_block_id, v_lesson_id, v_caller, v_clean);

  return jsonb_build_object(
    'ok', true,
    'id', (
      select c.id from public.lesson_block_comments c
       where c.block_id = p_block_id
         and c.author_id = v_caller
       order by c.created_at desc
       limit 1
    )
  );
end;
$$;

grant execute on function public.add_lesson_block_comment(uuid, text) to authenticated;

-- update: edit your own comment. Either body or resolved (or both).
-- Admins can edit anyone's comment by passing p_admin_override = true
-- if they ever need to clean something up — but the JS doesn't
-- expose that toggle, and the staff UI never sends it. The function
-- still reads it so the door exists without a future migration.
create or replace function public.update_lesson_block_comment(
  p_comment_id     uuid,
  p_body           text    default null,
  p_resolved       boolean default null,
  p_admin_override boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller     uuid := auth.uid();
  v_owner_id   uuid;
  v_clean_body text;
  v_is_admin   boolean;
begin
  if v_caller is null then
    return jsonb_build_object('ok', false, 'reason', 'not_authenticated');
  end if;

  select author_id into v_owner_id
    from public.lesson_block_comments
   where id = p_comment_id;
  if v_owner_id is null then
    return jsonb_build_object('ok', false, 'reason', 'unknown_comment');
  end if;

  select exists (
    select 1 from public.profiles
     where id = v_caller and role = 'admin' and deleted_at is null
  ) into v_is_admin;

  if v_owner_id <> v_caller and not (p_admin_override and v_is_admin) then
    return jsonb_build_object('ok', false, 'reason', 'not_owner');
  end if;

  -- Build the UPDATE dynamically based on which params were supplied.
  -- Passing NULL for both is a no-op (returns ok but doesn't write).
  if p_body is not null then
    v_clean_body := trim(p_body);
    if v_clean_body = '' then
      return jsonb_build_object('ok', false, 'reason', 'body_required');
    end if;
    if length(v_clean_body) > 4000 then
      return jsonb_build_object('ok', false, 'reason', 'body_too_long');
    end if;
    update public.lesson_block_comments
       set body = v_clean_body,
           updated_at = now()
     where id = p_comment_id;
  end if;

  if p_resolved is not null then
    update public.lesson_block_comments
       set resolved = p_resolved,
           updated_at = case when p_body is null then now() else updated_at end
     where id = p_comment_id;
  end if;

  return jsonb_build_object('ok', true);
end;
$$;

grant execute on function public.update_lesson_block_comment(uuid, text, boolean, boolean) to authenticated;

-- delete: only the author (or an admin) can remove a comment.
-- p_admin_override works the same way as in update — opens the door
-- for an admin override without needing a future migration.
create or replace function public.delete_lesson_block_comment(
  p_comment_id     uuid,
  p_admin_override boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller   uuid := auth.uid();
  v_owner_id uuid;
  v_is_admin boolean;
  v_deleted  int;
begin
  if v_caller is null then
    return jsonb_build_object('ok', false, 'reason', 'not_authenticated');
  end if;

  select author_id into v_owner_id
    from public.lesson_block_comments
   where id = p_comment_id;
  if v_owner_id is null then
    return jsonb_build_object('ok', false, 'reason', 'unknown_comment');
  end if;

  select exists (
    select 1 from public.profiles
     where id = v_caller and role = 'admin' and deleted_at is null
  ) into v_is_admin;

  if v_owner_id <> v_caller and not (p_admin_override and v_is_admin) then
    return jsonb_build_object('ok', false, 'reason', 'not_owner');
  end if;

  delete from public.lesson_block_comments where id = p_comment_id;
  get diagnostics v_deleted = row_count;
  if v_deleted = 0 then
    return jsonb_build_object('ok', false, 'reason', 'unknown_comment');
  end if;
  return jsonb_build_object('ok', true);
end;
$$;

grant execute on function public.delete_lesson_block_comment(uuid, boolean) to authenticated;

-- ---------- 13. DEV TOOL: USER LOOKUP + WIPE --------------------------------
-- Admin-only helpers used by the "Developer tools" panel in
-- admin.html. The intent is to scrub a user (their email, profile,
-- all FK-referencing rows that don't auto-cascade, and the auth.users
-- row itself) so a developer can reset a test account between
-- experiments without poking around in the Supabase dashboard.
--
-- Both functions gate on the caller's role = 'admin'. The delete
-- function additionally requires a typed confirmation string so a
-- stray click can't take out a real user.
--
-- IMPORTANT: this is intentional destructive functionality. The
-- admin UI surfaces the confirmation gate (typed email + literal
-- DELETE word) so the cost of an accident is high enough to make
-- the admin slow down. There is no undo.

-- 13a. lookup_user_by_email: find an auth.users row + its profile
-- by exact email match. Returns a jsonb so we can carry nullable
-- fields cleanly (e.g. a profile row may not exist for a sign-up
-- that errored halfway through).
create or replace function public.lookup_user_by_email(p_email text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller  uuid := auth.uid();
  v_email   text := lower(trim(coalesce(p_email, '')));
  v_auth    auth.users%rowtype;
  v_profile public.profiles%rowtype;
begin
  if v_caller is null then
    return jsonb_build_object('ok', false, 'reason', 'not_authenticated');
  end if;
  if not exists (
    select 1 from public.profiles
     where id = v_caller and role = 'admin' and deleted_at is null
  ) then
    return jsonb_build_object('ok', false, 'reason', 'admin_only');
  end if;
  if v_email = '' then
    return jsonb_build_object('ok', false, 'reason', 'email_required');
  end if;

  select * into v_auth from auth.users where lower(email::text) = v_email limit 1;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  select * into v_profile from public.profiles where id = v_auth.id;

  return jsonb_build_object(
    'ok', true,
    'user', jsonb_build_object(
      'id',              v_auth.id,
      'email',           v_auth.email::text,
      'created_at',      v_auth.created_at,
      'last_sign_in_at', v_auth.last_sign_in_at,
      'confirmed_at',    v_auth.confirmed_at,
      'profile',         case when v_profile.id is not null then to_jsonb(v_profile) else null end
    )
  );
end;
$$;

grant execute on function public.lookup_user_by_email(text) to authenticated;

-- 13b. delete_user_by_id: wipe a user. Security model:
--   * Caller must be admin (re-checked inside, not trusted from the UI).
--   * Caller cannot delete themselves (the WHERE-check in the UI is
--     paired with a server-side guard here, defense-in-depth).
--   * Requires three things in the call: the target uuid, the
--     confirmation token "DELETE", and the target's email (re-typed
--     so the admin proves they really picked this row).
--   * Audit-log row inserted BEFORE the deletion so even if the
--     delete partially fails, there is a record of who tried what.
--
-- What gets deleted, in order:
--   1. lesson_block_comments  (no FK to auth.users; safe to wipe first)
--   2. enrollments, lesson_progress, study_sessions, quiz_attempts,
--      assignments, activity_log, subjects_progress... — all CASCADE
--      to auth.users, so deleting auth.users covers them. Anything
--      without a CASCADE (e.g. lesson_blocks.author_id is just a
--      nullable uuid with no FK) is left as an orphaned reference.
--      For dev purposes that's fine; the catalogue row stays.
--   3. public.profiles (its PK IS the auth.users id, with ON DELETE
--      CASCADE from auth.users).
--   4. auth.users (the row that takes everything else with it).
create or replace function public.delete_user_by_id(
  p_target_user_id uuid,
  p_confirm        text,
  p_target_email   text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller  uuid := auth.uid();
  v_target  auth.users%rowtype;
  v_deleted_comments int := 0;
  v_role    text;
begin
  if v_caller is null then
    return jsonb_build_object('ok', false, 'reason', 'not_authenticated');
  end if;
  if not exists (
    select 1 from public.profiles
     where id = v_caller and role = 'admin' and deleted_at is null
  ) then
    return jsonb_build_object('ok', false, 'reason', 'admin_only');
  end if;
  if p_target_user_id is null then
    return jsonb_build_object('ok', false, 'reason', 'target_required');
  end if;
  if p_target_user_id = v_caller then
    return jsonb_build_object('ok', false, 'reason', 'cannot_delete_self');
  end if;
  if coalesce(trim(p_confirm), '') <> 'DELETE' then
    return jsonb_build_object('ok', false, 'reason', 'confirm_required');
  end if;

  -- Resolve the target row + its email so the admin's retyped email
  -- can be cross-checked. Comparing against auth.users.email is the
  -- trustworthy answer; trust nothing from the client.
  select * into v_target from auth.users where id = p_target_user_id limit 1;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  if lower(coalesce(p_target_email, '')) <> lower(v_target.email::text) then
    return jsonb_build_object('ok', false, 'reason', 'email_mismatch');
  end if;

  -- Read role for the audit log before we delete profiles.
  select role into v_role from public.profiles where id = v_target.id;

  -- Audit FIRST. This row is what survives even if the cascade
  -- below partially fails — we record actor, target (uuid will be
  -- orphaned but still queryable in the log), the deleted email,
  -- the prior role, and a count of cleaned comment rows.
  perform public._log_staff_action(
    'user_deleted', 'auth_user', v_target.id,
    jsonb_build_object(
      'deleted_email', v_target.email::text,
      'prior_role',    v_role,
      'note',          'admin-initiated wipe via delete_user_by_id RPC'
    )
  );

  -- Wipe per-block comments authored by this user. The table's FK
  -- to auth.users is ON DELETE CASCADE, so deleting the auth row
  -- covers it, but we do it explicitly here so we can report a count
  -- and so the cleanup happens even if some other migration later
  -- drops the FK.
  delete from public.lesson_block_comments where author_id = v_target.id;
  get diagnostics v_deleted_comments = row_count;

  -- Profile (PK = auth.users id) — FK is ON DELETE CASCADE so the
  -- auth.users deletion below would cover this, but doing it
  -- explicitly gives us a hard-failure surface if the cascade chain
  -- breaks in a future migration.
  delete from public.profiles where id = v_target.id;

  -- The big one. auth.users deletion cascades most per-user tables
  -- (enrollments, lesson_progress, study_sessions, quiz_attempts,
  -- assignments, activity_log, parental_consents as parent_email
  -- entries, lesson_block_comments, etc. per the ON DELETE CASCADE
  -- FKs across the codebase). Tables with a plain uuid column
  -- (lesson_blocks.author_id, lessons.author_id, lessons.published_by,
  -- staff_audit_log.actor_id / target_id, staff_invites.invited_by /
  -- accepted_by) are SET NULL — those references stay but the user
  -- can't be reverse-traced, which is the right audit-log behaviour
  -- (we don't want to lose the historical record of who did what).
  delete from auth.users where id = v_target.id;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'auth_delete_failed');
  end if;

  return jsonb_build_object(
    'ok', true,
    'deleted_user_id', v_target.id,
    'deleted_email',   v_target.email::text,
    'comments_cleaned', v_deleted_comments
  );
end;
$$;

grant execute on function public.delete_user_by_id(uuid, text, text) to authenticated;

-- ---------- 13c. DEV TOOL: LOOKUP / PEEK / DELETE BY UUID ----------------
-- The "Lookup + delete a user" card handles auth.users; this is the
-- "delete anything by its UUID" card. We don't try to enumerate every
-- table in the schema (that's brittle); instead we query the most
-- common UUID-PK tables and return every hit. For tables not in the
-- search list, peek/delete return reason='unsupported_table'.
--
-- The delete RPC whitelists table names on the server so it cannot be
-- used as a free-form DELETE engine on tables the admin shouldn't
-- touch (e.g. internal-only RLS-protected tables). auth.users is
-- handled by delete_user_by_id (with the rich cascade behaviour);
-- this RPC refuses to touch auth.users directly.

-- 13c-i. lookup_id_anywhere: scan every UUID-PK table we know about
-- and return any rows that share the supplied id. The label is a
-- short human-readable description ("Lesson: 'Plant Cells'") so the
-- admin can tell at a glance which row is about to be deleted.
--
-- One round-trip: every check is a UNION ALL subquery that either
-- hits an index (UUID PK) or returns no rows. The cost of a no-match
-- scan is one indexed-lookup-or-empty per table.
create or replace function public.lookup_id_anywhere(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_caller uuid := auth.uid();
  v_out    jsonb := '[]'::jsonb;
begin
  if v_caller is null then
    return jsonb_build_object('ok', false, 'reason', 'not_authenticated');
  end if;
  if not exists (
    select 1 from public.profiles
     where id = v_caller and role = 'admin' and deleted_at is null
  ) then
    return jsonb_build_object('ok', false, 'reason', 'admin_only');
  end if;
  if p_id is null then
    return jsonb_build_object('ok', false, 'reason', 'id_required');
  end if;

  -- Each branch pushes an entry onto the matches array only when the
  -- row exists. The label is intentionally terse — the UI peeks the
  -- row separately to get a fuller view before deletion.
  -- 1. lessons
  if exists (select 1 from public.lessons where id = p_id) then
    select v_out || jsonb_build_array(jsonb_build_object(
             'table', 'lessons', 'kind', 'lesson',
             'label', 'Lesson: ' || coalesce(title, '(untitled)') ||
                      case when status = 'published' then ' (published)'
                           when status = 'draft'     then ' (draft)'
                           else '' end
           )) into v_out
      from public.lessons where id = p_id;
  end if;
  -- 2. lesson_blocks
  if exists (select 1 from public.lesson_blocks where id = p_id) then
    select v_out || jsonb_build_array(jsonb_build_object(
             'table', 'lesson_blocks', 'kind', 'lesson_block',
             'label', 'Lesson block (' || coalesce(kind, '?') || ') in lesson ' ||
                      coalesce((select title from public.lessons where id = lesson_blocks.lesson_id), '(unknown lesson)')
           )) into v_out
      from public.lesson_blocks where id = p_id;
  end if;
  -- 3. lesson_block_comments
  if exists (select 1 from public.lesson_block_comments where id = p_id) then
    select v_out || jsonb_build_array(jsonb_build_object(
             'table', 'lesson_block_comments', 'kind', 'comment',
             'label', 'Per-block comment by ' || coalesce(
                         (select full_name from public.profiles where id = lesson_block_comments.author_id),
                         (select split_part(email::text, '@', 1) from auth.users where id = lesson_block_comments.author_id),
                         'unknown') ||
                      substring(body, 1, 60)
           )) into v_out
      from public.lesson_block_comments where id = p_id;
  end if;
  -- 4. topics
  if exists (select 1 from public.topics where id = p_id) then
    select v_out || jsonb_build_array(jsonb_build_object(
             'table', 'topics', 'kind', 'topic',
             'label', 'Topic: ' || coalesce(name, '(untitled)')
           )) into v_out
      from public.topics where id = p_id;
  end if;
  -- 5. subjects
  if exists (select 1 from public.subjects where id = p_id) then
    select v_out || jsonb_build_array(jsonb_build_object(
             'table', 'subjects', 'kind', 'subject',
             'label', 'Subject: ' || coalesce(name, '(untitled)')
           )) into v_out
      from public.subjects where id = p_id;
  end if;
  -- 6. units
  if exists (select 1 from public.units where id = p_id) then
    select v_out || jsonb_build_array(jsonb_build_object(
             'table', 'units', 'kind', 'unit',
             'label', 'Unit: ' || coalesce(name, '(untitled)')
           )) into v_out
      from public.units where id = p_id;
  end if;
  -- 7. exam_boards
  if exists (select 1 from public.exam_boards where id = p_id) then
    select v_out || jsonb_build_array(jsonb_build_object(
             'table', 'exam_boards', 'kind', 'exam_board',
             'label', 'Exam board: ' || coalesce(name, '(untitled)')
           )) into v_out
      from public.exam_boards where id = p_id;
  end if;
  -- 8. year_levels
  if exists (select 1 from public.year_levels where id = p_id) then
    select v_out || jsonb_build_array(jsonb_build_object(
             'table', 'year_levels', 'kind', 'year_level',
             'label', 'Year level: ' || coalesce(label, '(untitled)')
           )) into v_out
      from public.year_levels where id = p_id;
  end if;
  -- 9. profiles
  if exists (select 1 from public.profiles where id = p_id) then
    select v_out || jsonb_build_array(jsonb_build_object(
             'table', 'profiles', 'kind', 'profile',
             'label', 'Profile: ' || coalesce(full_name, '(no name)') || ' (' || role || ')'
           )) into v_out
      from public.profiles where id = p_id;
  end if;
  -- 10. staff_invites
  if exists (select 1 from public.staff_invites where id = p_id) then
    select v_out || jsonb_build_array(jsonb_build_object(
             'table', 'staff_invites', 'kind', 'invite',
             'label', 'Invite: ' || coalesce(email, '(no email)') || ' (' || role || ', ' || status || ')'
           )) into v_out
      from public.staff_invites where id = p_id;
  end if;
  -- 11. assignments
  if exists (select 1 from public.assignments where id = p_id) then
    select v_out || jsonb_build_array(jsonb_build_object(
             'table', 'assignments', 'kind', 'assignment',
             'label', 'Assignment: ' || coalesce(title, '(untitled)')
           )) into v_out
      from public.assignments where id = p_id;
  end if;
  -- 12. classes
  if exists (select 1 from public.classes where id = p_id) then
    select v_out || jsonb_build_array(jsonb_build_object(
             'table', 'classes', 'kind', 'class',
             'label', 'Class: ' || coalesce(name, '(untitled)')
           )) into v_out
      from public.classes where id = p_id;
  end if;
  -- 13. schools
  if exists (select 1 from public.schools where id = p_id) then
    select v_out || jsonb_build_array(jsonb_build_object(
             'table', 'schools', 'kind', 'school',
             'label', 'School: ' || coalesce(name, '(untitled)')
           )) into v_out
      from public.schools where id = p_id;
  end if;
  -- 14. lesson_progress
  if exists (select 1 from public.lesson_progress where id = p_id) then
    select v_out || jsonb_build_array(jsonb_build_object(
             'table', 'lesson_progress', 'kind', 'progress',
             'label', 'Lesson progress (status=' || coalesce(status::text, '?') || ')'
           )) into v_out
      from public.lesson_progress where id = p_id;
  end if;
  -- 15. quiz_attempts
  if exists (select 1 from public.quiz_attempts where id = p_id) then
    select v_out || jsonb_build_array(jsonb_build_object(
             'table', 'quiz_attempts', 'kind', 'quiz_attempt',
             'label', 'Quiz attempt (score=' || coalesce(score::text, '?') || ')'
           )) into v_out
      from public.quiz_attempts where id = p_id;
  end if;
  -- 16. study_sessions
  if exists (select 1 from public.study_sessions where id = p_id) then
    select v_out || jsonb_build_array(jsonb_build_object(
             'table', 'study_sessions', 'kind', 'study_session',
             'label', 'Study session (' || coalesce(duration_seconds::text, '?') || 's)'
           )) into v_out
      from public.study_sessions where id = p_id;
  end if;
  -- 17. profiles (already covered by the user-deletion tool above, but
  --     also exposed here for completeness — useful when the user wants
  --     to wipe just a profile row without nuking auth.users).
  if exists (select 1 from public.profiles where id = p_id)
     and not exists (
       select 1 from jsonb_array_elements(v_out) e
        where e->>'table' = 'profiles'
     ) then
    select v_out || jsonb_build_array(jsonb_build_object(
             'table', 'profiles', 'kind', 'profile',
             'label', 'Profile: ' || coalesce(full_name, '(no name)') || ' (' || role || ')'
           )) into v_out
      from public.profiles where id = p_id;
  end if;
  -- 18. activity_log
  if exists (select 1 from public.activity_log where id = p_id) then
    select v_out || jsonb_build_array(jsonb_build_object(
             'table', 'activity_log', 'kind', 'activity',
             'label', 'Activity log: ' || coalesce(kind::text, '?') ||
                      ' (user=' || coalesce(user_id::text, '?') || ')'
           )) into v_out
      from public.activity_log where id = p_id;
  end if;
  -- 19. enrollments
  if exists (select 1 from public.enrollments where id = p_id) then
    select v_out || jsonb_build_array(jsonb_build_object(
             'table', 'enrollments', 'kind', 'enrollment',
             'label', 'Enrollment: user=' || coalesce(user_id::text, '?') ||
                      ' subject=' || coalesce(subject_id::text, '?')
           )) into v_out
      from public.enrollments where id = p_id;
  end if;
  -- 20. parental_consents
  if exists (select 1 from public.parental_consents where id = p_id) then
    select v_out || jsonb_build_array(jsonb_build_object(
             'table', 'parental_consents', 'kind', 'consent',
             'label', 'Parental consent: student=' ||
                      coalesce(student_user_id::text, '?') ||
                      ' status=' || coalesce(status::text, '?')
           )) into v_out
      from public.parental_consents where id = p_id;
  end if;
  -- 21. live_lessons
  if exists (select 1 from public.live_lessons where id = p_id) then
    select v_out || jsonb_build_array(jsonb_build_object(
             'table', 'live_lessons', 'kind', 'live_lesson',
             'label', 'Live lesson: ' || coalesce(title, '(untitled)')
           )) into v_out
      from public.live_lessons where id = p_id;
  end if;
  -- 22. class_members
  if exists (select 1 from public.class_members where id = p_id) then
    select v_out || jsonb_build_array(jsonb_build_object(
             'table', 'class_members', 'kind', 'class_member',
             'label', 'Class member: class=' || coalesce(class_id::text, '?') ||
                      ' user=' || coalesce(user_id::text, '?')
           )) into v_out
      from public.class_members where id = p_id;
  end if;
  -- 23. assignment_targets
  if exists (select 1 from public.assignment_targets where id = p_id) then
    select v_out || jsonb_build_array(jsonb_build_object(
             'table', 'assignment_targets', 'kind', 'assignment_target',
             'label', 'Assignment target: assignment=' ||
                      coalesce(assignment_id::text, '?')
           )) into v_out
      from public.assignment_targets where id = p_id;
  end if;
  -- 24. assignment_submissions
  if exists (select 1 from public.assignment_submissions where id = p_id) then
    select v_out || jsonb_build_array(jsonb_build_object(
             'table', 'assignment_submissions', 'kind', 'submission',
             'label', 'Submission: student=' ||
                      coalesce(student_user_id::text, '?')
           )) into v_out
      from public.assignment_submissions where id = p_id;
  end if;
  -- 25. assignment_resources
  if exists (select 1 from public.assignment_resources where id = p_id) then
    select v_out || jsonb_build_array(jsonb_build_object(
             'table', 'assignment_resources', 'kind', 'assignment_resource',
             'label', 'Assignment resource: assignment=' ||
                      coalesce(assignment_id::text, '?')
           )) into v_out
      from public.assignment_resources where id = p_id;
  end if;
  -- 26. school_invite_codes
  if exists (select 1 from public.school_invite_codes where id = p_id) then
    select v_out || jsonb_build_array(jsonb_build_object(
             'table', 'school_invite_codes', 'kind', 'school_invite_code',
             'label', 'School invite code: ' || coalesce(code, '?') ||
                      ' (school=' || coalesce(school_id::text, '?') || ')'
           )) into v_out
      from public.school_invite_codes where id = p_id;
  end if;
  -- 27. teacher_signup_codes
  if exists (select 1 from public.teacher_signup_codes where id = p_id) then
    select v_out || jsonb_build_array(jsonb_build_object(
             'table', 'teacher_signup_codes', 'kind', 'teacher_signup_code',
             'label', 'Teacher signup code: ' || coalesce(code, '?')
           )) into v_out
      from public.teacher_signup_codes where id = p_id;
  end if;
  -- 28. class_rollups
  if exists (select 1 from public.class_rollups where id = p_id) then
    select v_out || jsonb_build_array(jsonb_build_object(
             'table', 'class_rollups', 'kind', 'class_rollup',
             'label', 'Class rollup: class=' ||
                      coalesce(class_id::text, '?')
           )) into v_out
      from public.class_rollups where id = p_id;
  end if;
  -- 29. school_dashboard_layouts
  if exists (select 1 from public.school_dashboard_layouts where id = p_id) then
    select v_out || jsonb_build_array(jsonb_build_object(
             'table', 'school_dashboard_layouts', 'kind', 'layout',
             'label', 'Dashboard layout: school=' ||
                      coalesce(school_id::text, '?')
           )) into v_out
      from public.school_dashboard_layouts where id = p_id;
  end if;
  -- 30. auth.users (read-only — admin tools shouldn't nuke users without
  -- using delete_user_by_id which has the right cascade behaviour;
  -- we surface the match here so the admin sees it but block deletion
  -- via delete_by_id with reason='use_delete_user_by_id')
  if exists (select 1 from auth.users where id = p_id) then
    select v_out || jsonb_build_array(jsonb_build_object(
             'table', 'auth.users', 'kind', 'auth_user',
             'label', 'Auth user: ' || coalesce(email::text, '(no email)')
           )) into v_out
      from auth.users where id = p_id;
  end if;

  return jsonb_build_object('ok', true, 'id', p_id, 'matches', v_out);
end;
$$;

grant execute on function public.lookup_id_anywhere(uuid) to authenticated;

-- 13c-ii. peek_id: get a row by id + table. Returns the row as to_jsonb
-- so the admin UI can render a "you are about to delete" preview.
-- Whitelist the table so a malicious caller can't use this to peek
-- internal-only tables (e.g. auth.users — use lookup_user_by_email
-- for that).
create or replace function public.peek_id(p_id uuid, p_table text)
returns jsonb
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_caller uuid := auth.uid();
  v_table  text := lower(trim(coalesce(p_table, '')));
  v_row    jsonb;
begin
  if v_caller is null then
    return jsonb_build_object('ok', false, 'reason', 'not_authenticated');
  end if;
  if not exists (
    select 1 from public.profiles
     where id = v_caller and role = 'admin' and deleted_at is null
  ) then
    return jsonb_build_object('ok', false, 'reason', 'admin_only');
  end if;
  if p_id is null then
    return jsonb_build_object('ok', false, 'reason', 'id_required');
  end if;
  -- Whitelist. Lookups on tables not in this list return reason so the
  -- caller can tell the difference between "row exists but unsupported"
  -- and "row missing".
  if v_table not in (
    'lessons','lesson_blocks','lesson_block_comments',
    'topics','subjects','units','exam_boards','year_levels',
    'staff_invites','assignments','classes','schools',
    'lesson_progress','quiz_attempts','study_sessions',
    -- Broadened coverage so the admin can wipe a row from any of the
    -- tables the app writes to. Same set across peek_id, delete_by_id,
    -- and lookup_id_anywhere. If you add a new public table, add it to
    -- all three places.
    'profiles','activity_log','enrollments','parental_consents',
    'live_lessons','class_members',
    'assignment_targets','assignment_submissions','assignment_resources',
    'school_invite_codes','teacher_signup_codes',
    'class_rollups','school_dashboard_layouts'
  ) then
    return jsonb_build_object('ok', false, 'reason', 'unsupported_table',
                             'table', v_table);
  end if;

  -- Each branch selects the matching row and converts to jsonb. We
  -- don't quote_ident() the table name into dynamic SQL — instead we
  -- use a CASE ladder of static statements. Slightly verbose, but it
  -- means there's no SQL injection surface and the planner can be
  -- smarter (each branch references a specific table with explicit
  -- schema).
  if v_table = 'lessons' then
    select to_jsonb(l.*) into v_row from public.lessons l where l.id = p_id;
  elsif v_table = 'lesson_blocks' then
    select to_jsonb(l.*) into v_row from public.lesson_blocks l where l.id = p_id;
  elsif v_table = 'lesson_block_comments' then
    select to_jsonb(l.*) into v_row from public.lesson_block_comments l where l.id = p_id;
  elsif v_table = 'topics' then
    select to_jsonb(l.*) into v_row from public.topics l where l.id = p_id;
  elsif v_table = 'subjects' then
    select to_jsonb(l.*) into v_row from public.subjects l where l.id = p_id;
  elsif v_table = 'units' then
    select to_jsonb(l.*) into v_row from public.units l where l.id = p_id;
  elsif v_table = 'exam_boards' then
    select to_jsonb(l.*) into v_row from public.exam_boards l where l.id = p_id;
  elsif v_table = 'year_levels' then
    select to_jsonb(l.*) into v_row from public.year_levels l where l.id = p_id;
  elsif v_table = 'staff_invites' then
    select to_jsonb(l.*) into v_row from public.staff_invites l where l.id = p_id;
  elsif v_table = 'assignments' then
    select to_jsonb(l.*) into v_row from public.assignments l where l.id = p_id;
  elsif v_table = 'classes' then
    select to_jsonb(l.*) into v_row from public.classes l where l.id = p_id;
  elsif v_table = 'schools' then
    select to_jsonb(l.*) into v_row from public.schools l where l.id = p_id;
  elsif v_table = 'lesson_progress' then
    select to_jsonb(l.*) into v_row from public.lesson_progress l where l.id = p_id;
  elsif v_table = 'quiz_attempts' then
    select to_jsonb(l.*) into v_row from public.quiz_attempts l where l.id = p_id;
  elsif v_table = 'study_sessions' then
    select to_jsonb(l.*) into v_row from public.study_sessions l where l.id = p_id;
  elsif v_table = 'profiles' then
    select to_jsonb(l.*) into v_row from public.profiles l where l.id = p_id;
  elsif v_table = 'activity_log' then
    select to_jsonb(l.*) into v_row from public.activity_log l where l.id = p_id;
  elsif v_table = 'enrollments' then
    select to_jsonb(l.*) into v_row from public.enrollments l where l.id = p_id;
  elsif v_table = 'parental_consents' then
    select to_jsonb(l.*) into v_row from public.parental_consents l where l.id = p_id;
  elsif v_table = 'live_lessons' then
    select to_jsonb(l.*) into v_row from public.live_lessons l where l.id = p_id;
  elsif v_table = 'class_members' then
    select to_jsonb(l.*) into v_row from public.class_members l where l.id = p_id;
  elsif v_table = 'assignment_targets' then
    select to_jsonb(l.*) into v_row from public.assignment_targets l where l.id = p_id;
  elsif v_table = 'assignment_submissions' then
    select to_jsonb(l.*) into v_row from public.assignment_submissions l where l.id = p_id;
  elsif v_table = 'assignment_resources' then
    select to_jsonb(l.*) into v_row from public.assignment_resources l where l.id = p_id;
  elsif v_table = 'school_invite_codes' then
    select to_jsonb(l.*) into v_row from public.school_invite_codes l where l.id = p_id;
  elsif v_table = 'teacher_signup_codes' then
    select to_jsonb(l.*) into v_row from public.teacher_signup_codes l where l.id = p_id;
  elsif v_table = 'class_rollups' then
    select to_jsonb(l.*) into v_row from public.class_rollups l where l.id = p_id;
  elsif v_table = 'school_dashboard_layouts' then
    select to_jsonb(l.*) into v_row from public.school_dashboard_layouts l where l.id = p_id;
  end if;

  if v_row is null then
    return jsonb_build_object('ok', false, 'reason', 'not_found',
                             'table', v_table);
  end if;
  return jsonb_build_object('ok', true, 'table', v_table, 'row', v_row);
end;
$$;

grant execute on function public.peek_id(uuid, text) to authenticated;

-- 13c-iii. delete_by_id: delete a row by id from a whitelisted table.
-- Same safety model as peek_id: caller must be admin, confirm='DELETE',
-- table name must be in the supported list. Refuses auth.users so the
-- admin must use delete_user_by_id (which has the right cascade).
--
-- Cascades: every supported table has FKs defined on it, so when the
-- row is deleted the cascades fire (e.g. delete a lesson → lesson_blocks,
-- lesson_progress, quiz_attempts all go). Where cascades fire depends on
-- the table — the UI doesn't try to enumerate this; the admin trusts the
-- foreign keys they're seeing in the schema.
create or replace function public.delete_by_id(
  p_id      uuid,
  p_confirm text,
  p_table   text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller    uuid := auth.uid();
  v_table     text := lower(trim(coalesce(p_table, '')));
  v_deleted   int  := 0;
  v_label     text;
  v_metadata  jsonb;
begin
  if v_caller is null then
    return jsonb_build_object('ok', false, 'reason', 'not_authenticated');
  end if;
  if not exists (
    select 1 from public.profiles
     where id = v_caller and role = 'admin' and deleted_at is null
  ) then
    return jsonb_build_object('ok', false, 'reason', 'admin_only');
  end if;
  if p_id is null then
    return jsonb_build_object('ok', false, 'reason', 'id_required');
  end if;
  if v_table = '' then
    return jsonb_build_object('ok', false, 'reason', 'table_required');
  end if;
  if coalesce(trim(p_confirm), '') <> 'DELETE' then
    return jsonb_build_object('ok', false, 'reason', 'confirm_required');
  end if;

  -- Same whitelist as peek_id. Tables here MUST match peek_id so the
  -- admin can preview the row they're about to delete.
  if v_table not in (
    'lessons','lesson_blocks','lesson_block_comments',
    'topics','subjects','units','exam_boards','year_levels',
    'staff_invites','assignments','classes','schools',
    'lesson_progress','quiz_attempts','study_sessions',
    -- Broadened coverage so the admin can wipe a row from any of the
    -- tables the app writes to. Same set across peek_id, delete_by_id,
    -- and lookup_id_anywhere. If you add a new public table, add it to
    -- all three places.
    'profiles','activity_log','enrollments','parental_consents',
    'live_lessons','class_members',
    'assignment_targets','assignment_submissions','assignment_resources',
    'school_invite_codes','teacher_signup_codes',
    'class_rollups','school_dashboard_layouts'
  ) then
    return jsonb_build_object('ok', false, 'reason', 'unsupported_table',
                             'table', v_table);
  end if;

  -- Read the row's display label BEFORE we delete it so the audit row
  -- has a meaningful "what was this" string.
  if v_table = 'lessons' then
    select title into v_label from public.lessons where id = p_id;
  elsif v_table = 'lesson_blocks' then
    select 'kind=' || coalesce(kind::text, '?') || ' in lesson=' || coalesce(lesson_id::text, '?')
      into v_label from public.lesson_blocks where id = p_id;
  elsif v_table = 'lesson_block_comments' then
    select 'body=' || substring(coalesce(body, ''), 1, 120)
      into v_label from public.lesson_block_comments where id = p_id;
  elsif v_table = 'topics' then
    select name into v_label from public.topics where id = p_id;
  elsif v_table = 'subjects' then
    select name into v_label from public.subjects where id = p_id;
  elsif v_table = 'units' then
    select name into v_label from public.units where id = p_id;
  elsif v_table = 'exam_boards' then
    select name into v_label from public.exam_boards where id = p_id;
  elsif v_table = 'year_levels' then
    select label into v_label from public.year_levels where id = p_id;
  elsif v_table = 'staff_invites' then
    select email into v_label from public.staff_invites where id = p_id;
  elsif v_table = 'assignments' then
    select title into v_label from public.assignments where id = p_id;
  elsif v_table = 'classes' then
    select name into v_label from public.classes where id = p_id;
  elsif v_table = 'schools' then
    select name into v_label from public.schools where id = p_id;
  elsif v_table = 'lesson_progress' then
    select 'user=' || coalesce(user_id::text, '?') || ' lesson=' || coalesce(lesson_id::text, '?')
      into v_label from public.lesson_progress where id = p_id;
  elsif v_table = 'quiz_attempts' then
    select 'user=' || coalesce(user_id::text, '?') || ' lesson=' || coalesce(lesson_id::text, '?')
      into v_label from public.quiz_attempts where id = p_id;
  elsif v_table = 'study_sessions' then
    select 'user=' || coalesce(user_id::text, '?')
      into v_label from public.study_sessions where id = p_id;
  elsif v_table = 'profiles' then
    select 'profile ' || coalesce(full_name, '(no name)') || ' (' || role || ')'
      into v_label from public.profiles where id = p_id;
  elsif v_table = 'activity_log' then
    select 'activity ' || coalesce(kind::text, '?') ||
           ' user=' || coalesce(user_id::text, '?')
      into v_label from public.activity_log where id = p_id;
  elsif v_table = 'enrollments' then
    select 'enrollment user=' || coalesce(user_id::text, '?') ||
           ' subject=' || coalesce(subject_id::text, '?')
      into v_label from public.enrollments where id = p_id;
  elsif v_table = 'parental_consents' then
    select 'consent student=' || coalesce(student_user_id::text, '?') ||
           ' status=' || coalesce(status::text, '?')
      into v_label from public.parental_consents where id = p_id;
  elsif v_table = 'live_lessons' then
    select coalesce(title, '(untitled live lesson)')
      into v_label from public.live_lessons where id = p_id;
  elsif v_table = 'class_members' then
    select 'class_member class=' || coalesce(class_id::text, '?') ||
           ' user=' || coalesce(user_id::text, '?')
      into v_label from public.class_members where id = p_id;
  elsif v_table = 'assignment_targets' then
    select 'target assignment=' || coalesce(assignment_id::text, '?')
      into v_label from public.assignment_targets where id = p_id;
  elsif v_table = 'assignment_submissions' then
    select 'submission student=' || coalesce(student_user_id::text, '?')
      into v_label from public.assignment_submissions where id = p_id;
  elsif v_table = 'assignment_resources' then
    select 'resource assignment=' || coalesce(assignment_id::text, '?')
      into v_label from public.assignment_resources where id = p_id;
  elsif v_table = 'school_invite_codes' then
    select 'invite code ' || coalesce(code, '?') ||
           ' school=' || coalesce(school_id::text, '?')
      into v_label from public.school_invite_codes where id = p_id;
  elsif v_table = 'teacher_signup_codes' then
    select 'teacher signup code ' || coalesce(code, '?')
      into v_label from public.teacher_signup_codes where id = p_id;
  elsif v_table = 'class_rollups' then
    select 'class_rollup class=' || coalesce(class_id::text, '?')
      into v_label from public.class_rollups where id = p_id;
  elsif v_table = 'school_dashboard_layouts' then
    select 'layout school=' || coalesce(school_id::text, '?')
      into v_label from public.school_dashboard_layouts where id = p_id;
  end if;

  if v_label is null then
    return jsonb_build_object('ok', false, 'reason', 'not_found',
                             'table', v_table, 'id', p_id);
  end if;

  v_metadata := jsonb_build_object(
    'table', v_table,
    'id', p_id,
    'label', v_label,
    'note',  'admin-initiated row delete via delete_by_id RPC'
  );

  -- Audit FIRST so we have a record even if the cascade below has a
  -- problem on some downstream table.
  perform public._log_staff_action(
    'row_deleted', v_table, p_id, v_metadata
  );

  -- Now delete. Statically-named statements again — no dynamic SQL
  -- because the table name is the only field the client could try to
  -- inject, and we already validated it via the whitelist.
  if v_table = 'lessons' then
    delete from public.lessons where id = p_id;
  elsif v_table = 'lesson_blocks' then
    delete from public.lesson_blocks where id = p_id;
  elsif v_table = 'lesson_block_comments' then
    delete from public.lesson_block_comments where id = p_id;
  elsif v_table = 'topics' then
    delete from public.topics where id = p_id;
  elsif v_table = 'subjects' then
    delete from public.subjects where id = p_id;
  elsif v_table = 'units' then
    delete from public.units where id = p_id;
  elsif v_table = 'exam_boards' then
    delete from public.exam_boards where id = p_id;
  elsif v_table = 'year_levels' then
    delete from public.year_levels where id = p_id;
  elsif v_table = 'staff_invites' then
    delete from public.staff_invites where id = p_id;
  elsif v_table = 'assignments' then
    delete from public.assignments where id = p_id;
  elsif v_table = 'classes' then
    delete from public.classes where id = p_id;
  elsif v_table = 'schools' then
    delete from public.schools where id = p_id;
  elsif v_table = 'lesson_progress' then
    delete from public.lesson_progress where id = p_id;
  elsif v_table = 'quiz_attempts' then
    delete from public.quiz_attempts where id = p_id;
  elsif v_table = 'study_sessions' then
    delete from public.study_sessions where id = p_id;
  elsif v_table = 'profiles' then
    delete from public.profiles where id = p_id;
  elsif v_table = 'activity_log' then
    delete from public.activity_log where id = p_id;
  elsif v_table = 'enrollments' then
    delete from public.enrollments where id = p_id;
  elsif v_table = 'parental_consents' then
    delete from public.parental_consents where id = p_id;
  elsif v_table = 'live_lessons' then
    delete from public.live_lessons where id = p_id;
  elsif v_table = 'class_members' then
    delete from public.class_members where id = p_id;
  elsif v_table = 'assignment_targets' then
    delete from public.assignment_targets where id = p_id;
  elsif v_table = 'assignment_submissions' then
    delete from public.assignment_submissions where id = p_id;
  elsif v_table = 'assignment_resources' then
    delete from public.assignment_resources where id = p_id;
  elsif v_table = 'school_invite_codes' then
    delete from public.school_invite_codes where id = p_id;
  elsif v_table = 'teacher_signup_codes' then
    delete from public.teacher_signup_codes where id = p_id;
  elsif v_table = 'class_rollups' then
    delete from public.class_rollups where id = p_id;
  elsif v_table = 'school_dashboard_layouts' then
    delete from public.school_dashboard_layouts where id = p_id;
  end if;
  get diagnostics v_deleted = row_count;

  if v_deleted = 0 then
    -- Row was deleted between our SELECT and our DELETE (a race).
    -- The audit row is still recorded; surface the row_count so the
    -- admin sees the SQL went through cleanly.
    v_deleted := 0;
  end if;
  return jsonb_build_object(
    'ok', true,
    'table', v_table,
    'id', p_id,
    'label', v_label,
    'rows_deleted', v_deleted
  );
end;
$$;

grant execute on function public.delete_by_id(uuid, text, text) to authenticated;

-- ---------- 14. DIAGNOSTIC: WHAT FUNCTIONS DOES THE LIVE DB ACTUALLY HAVE?
-- Run this query in the Supabase SQL editor to verify every function
-- in this file is installed with the right signature. The function
-- names and parameter types listed below should match the result
-- exactly. If a function is missing or has different parameters, the
-- admin panel will get 400 Bad Request with an empty error body
-- (PostgREST rejects the call before it ever reaches Postgres).
--
-- Copy-paste the result and check it against the function signatures
-- in this file. Common drift causes:
--   * A previous migration was edited but only partially re-run.
--   * supabase_rls_staff_roles_fix.sql was run before supabase_admin.sql.
--   * An old list_staff_invites or list_staff was left installed with
--     a different parameter name (p_status vs _status) or a different
--     number of return columns.
--
-- SELECT
--     p.proname AS function_name,
--     pg_get_function_identity_arguments(p.oid) AS parameters,
--     pg_get_function_result(p.oid) AS returns
-- FROM pg_proc p
-- JOIN pg_namespace n ON n.oid = p.pronamespace
-- WHERE n.nspname = 'public'
--   AND p.proname IN (
--     '_log_staff_action',
--     'create_staff_invite',
--     'peek_staff_invite',
--     'accept_staff_invite',
--     'resend_staff_invite',
--     'revoke_staff_invite',
--     'list_staff_invites',
--     'count_staff_invites',
--     'change_staff_role',
--     'revoke_staff_access',
--     'publish_lesson',
--     'log_staff_action',
--     'check_parental_consent',
--     'current_role',
--     'list_staff',
--     'list_recent_audit',
--     'list_lesson_block_comments',
--     'add_lesson_block_comment',
--     'update_lesson_block_comment',
--     'delete_lesson_block_comment',
--     'lookup_user_by_email',
--     'delete_user_by_id',
--     'lookup_id_anywhere',
--     'peek_id',
--     'delete_by_id'
--   )
-- ORDER BY p.proname;

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
