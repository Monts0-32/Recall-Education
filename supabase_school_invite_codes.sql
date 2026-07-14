-- ============================================================================
-- Recall Education — School invite codes (expiry, max uses, email domain)
-- Run this AFTER supabase_signup_routing.sql and supabase_school_organisers.sql.
-- Idempotent: safe to re-run.
--
-- What this does:
--   1. Adds the public.school_invite_codes table — one row per student
--      invite code. Each code has its own expiry, max_uses, and
--      allowed_email_domain. (The existing schools.code is left in
--      place for the rare direct-attach use.)
--   2. Adds 3 organiser-only RPCs for the codes modal: create, list,
--      revoke.
-- ============================================================================

-- ============================================================================
-- 1. NEW TABLE
-- ============================================================================

create table if not exists public.school_invite_codes (
  id                   uuid primary key default gen_random_uuid(),
  school_id            uuid not null references public.schools(id) on delete cascade,
  code                 text not null unique,
  expires_at           timestamptz,
  max_uses             int,
  uses_count           int not null default 0,
  allowed_email_domain text,
  created_by           uuid references auth.users(id) on delete set null,
  created_at           timestamptz not null default now(),
  -- Only student codes for v1; kept as a column so a future teacher
  -- flow can extend without a migration.
  role                 text not null default 'student'
                       check (role in ('student')),
  constraint school_invite_codes_max_uses_positive
    check (max_uses is null or max_uses > 0),
  constraint school_invite_codes_uses_within_max
    check (max_uses is null or uses_count <= max_uses)
);

create index if not exists school_invite_codes_school_idx
  on public.school_invite_codes (school_id, created_at desc);
create index if not exists school_invite_codes_code_idx
  on public.school_invite_codes (code);

alter table public.school_invite_codes enable row level security;
-- No public read policy. All access via SECURITY DEFINER RPCs.

-- ============================================================================
-- 2. CREATE_SCHOOL_INVITE_CODE
-- Organiser-only. Generates a unique STU-XXXXXX code.
-- ============================================================================

create or replace function public.create_school_invite_code(
  p_school_id           uuid,
  p_expires_at          timestamptz default null,
  p_max_uses            int          default null,
  p_allowed_email_domain text        default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_alnum    text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  v_codenum  bigint;
  v_code     text;
  v_attempts int := 0;
  v_id       uuid;
  v_domain   text := nullif(lower(trim(coalesce(p_allowed_email_domain, ''))), '');
  -- Strip a leading '@' if the organiser typed it.
  v_domain_clean text;
begin
  perform public._assert_school_organiser(p_school_id);

  if p_max_uses is not null and p_max_uses <= 0 then
    return jsonb_build_object('ok', false, 'reason', 'max_uses_must_be_positive');
  end if;

  v_domain_clean := case
    when v_domain is null then null
    when v_domain like '@%' then substr(v_domain, 2)
    else v_domain
  end;

  loop
    v_codenum := (random() * power(36::numeric, 6))::bigint;
    v_code := 'STU-';
    for i in 1..6 loop
      v_code := v_code || substr(v_alnum, 1 + (v_codenum % 32)::int, 1);
      v_codenum := v_codenum / 32;
    end loop;
    v_attempts := v_attempts + 1;
    begin
      insert into public.school_invite_codes (
        school_id, code, expires_at, max_uses, allowed_email_domain, created_by
      ) values (
        p_school_id, v_code, p_expires_at, p_max_uses, v_domain_clean, auth.uid()
      )
      returning id into v_id;
      exit;
    exception when unique_violation then
      if v_attempts > 20 then
        return jsonb_build_object('ok', false, 'reason', 'code_collision');
      end if;
    end;
  end loop;

  return jsonb_build_object(
    'ok',                   true,
    'id',                   v_id,
    'code',                 v_code,
    'school_id',            p_school_id,
    'expires_at',           p_expires_at,
    'max_uses',             p_max_uses,
    'uses_count',           0,
    'allowed_email_domain', v_domain_clean
  );
end;
$$;
grant execute on function public.create_school_invite_code(uuid, timestamptz, int, text) to authenticated;

-- ============================================================================
-- 3. LIST_SCHOOL_INVITE_CODES
-- Organiser-only. Returns the codes with a derived is_active bool.
-- ============================================================================

create or replace function public.list_school_invite_codes(
  p_school_id uuid
)
returns table (
  code                 text,
  expires_at           timestamptz,
  max_uses             int,
  uses_count           int,
  uses_remaining       int,
  allowed_email_domain text,
  created_at           timestamptz,
  created_by_name      text,
  is_active            boolean,
  is_expiring_soon     boolean
)
language sql
security definer
set search_path = public
stable
as $$
  select ic.code,
         ic.expires_at,
         ic.max_uses,
         ic.uses_count,
         case
           when ic.max_uses is null then null
           else greatest(ic.max_uses - ic.uses_count, 0)
         end as uses_remaining,
         ic.allowed_email_domain,
         ic.created_at,
         coalesce(p.full_name, u.email, '')::text as created_by_name,
         (
           (ic.expires_at is null or ic.expires_at > now())
           and (ic.max_uses is null or ic.uses_count < ic.max_uses)
         ) as is_active,
         (
           ic.expires_at is not null
           and ic.expires_at > now()
           and ic.expires_at <= now() + interval '24 hours'
         ) as is_expiring_soon
    from public.school_invite_codes ic
    left join public.profiles p on p.id = ic.created_by
    left join auth.users    u on u.id = ic.created_by
   where ic.school_id = p_school_id
   order by ic.created_at desc;
$$;
grant execute on function public.list_school_invite_codes(uuid) to authenticated;

-- ============================================================================
-- 4. REVOKE_SCHOOL_INVITE_CODE
-- Organiser-only. Soft-revokes by stamping expires_at = now().
-- ============================================================================

create or replace function public.revoke_school_invite_code(
  p_code text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row  public.school_invite_codes%rowtype;
  v_owner uuid;
begin
  select * into v_row from public.school_invite_codes where code = trim(p_code);
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  select owner_user_id into v_owner from public.schools where id = v_row.school_id;
  if v_owner is null or v_owner <> auth.uid() then
    return jsonb_build_object('ok', false, 'reason', 'not_organiser');
  end if;
  if v_row.expires_at is not null and v_row.expires_at <= now() then
    -- Already expired; treat as idempotent success.
    return jsonb_build_object('ok', true, 'already_expired', true);
  end if;

  update public.school_invite_codes
     set expires_at = now()
   where id = v_row.id;

  return jsonb_build_object('ok', true);
end;
$$;
grant execute on function public.revoke_school_invite_code(text) to authenticated;

-- ============================================================================
-- DONE.
--
-- After running this migration:
--   1. supabase_signup_routing.sql's lookup_school_by_code must be
--      updated to consult this new table (see §5 of the plan). Until
--      that change lands, STU-XXXXXX codes won't be discoverable at
--      signup.html.
--   2. school-organiser-dashboard.html gains a "Student codes" modal
--      that calls the three RPCs above.
--   3. signup.html uses the new attach_student_to_school_via_invite
--      RPC on submit.
-- ============================================================================
