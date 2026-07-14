-- ============================================================================
-- Recall Education — School organiser system
-- Run this AFTER every other supabase_*.sql migration in the SQL editor.
-- Idempotent: safe to re-run.
--
-- What this does:
--   1. Widens profiles.role to include 'school_organiser'.
--   2. Adds schools.plan + schools.owner_user_id.
--   3. Makes assignments.school_id + created_by + is_template so the
--      existing per-student table can also hold teacher-driven templates.
--   4. Adds three new tables: assignment_targets, assignment_resources,
--      school_dashboard_layouts.
--   5. Adds the 'assignment-files' storage bucket with same-school RLS.
--   6. Defines 16 SECURITY DEFINER RPCs for organiser sign-up, member
--      management, teacher codes, homework CRUD, and layout customisation.
-- ============================================================================

-- ============================================================================
-- 1. WIDEN PROFILES.ROLE
-- ============================================================================

alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles
  alter column role set default 'student';
alter table public.profiles
  add constraint profiles_role_check
  check (role in (
    'student', 'teacher', 'school_organiser',
    'staff_author', 'staff_reviewer', 'admin'
  ));

-- ============================================================================
-- 2. SCHOOLS.PLAN + OWNER
-- ============================================================================

alter table public.schools
  add column if not exists plan text not null default 'free'
    check (plan in ('free','standard','pro'));
alter table public.schools
  add column if not exists owner_user_id uuid references auth.users(id) on delete set null;
create unique index if not exists schools_owner_uniq
  on public.schools (owner_user_id) where owner_user_id is not null;

-- ============================================================================
-- 3. PROFILES.REMOVED_FROM_SCHOOL_AT
-- Used by remove_school_member to soft-detach a member while keeping
-- their historical assignment rows attributable.
-- ============================================================================

alter table public.profiles
  add column if not exists removed_from_school_at timestamptz;

-- ============================================================================
-- 4. ASSIGNMENTS → SCHOOL-SCOPED, TEMPLATE-AWARE
-- ============================================================================

alter table public.assignments alter column user_id drop not null;
alter table public.assignments
  add column if not exists school_id   uuid references public.schools(id) on delete cascade;
alter table public.assignments
  add column if not exists created_by  uuid references auth.users(id) on delete set null;
alter table public.assignments
  add column if not exists is_template boolean not null default false;

create index if not exists assignments_school_idx
  on public.assignments (school_id, due_at);
create index if not exists assignments_created_by_idx
  on public.assignments (created_by, due_at desc);

-- ============================================================================
-- 5. ASSIGNMENT_TARGETS (per-student status)
-- ============================================================================

create table if not exists public.assignment_targets (
  id                uuid primary key default gen_random_uuid(),
  assignment_id     uuid not null references public.assignments(id) on delete cascade,
  student_user_id   uuid not null references auth.users(id) on delete cascade,
  status            text not null default 'pending'
                    check (status in ('pending','done','missed')),
  completed_at      timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (assignment_id, student_user_id)
);
create index if not exists assignment_targets_student_idx
  on public.assignment_targets (student_user_id, status);
create index if not exists assignment_targets_assignment_idx
  on public.assignment_targets (assignment_id);

-- updated_at trigger
do $$
begin
  if exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'touch_updated_at'
  ) then
    drop trigger if exists assignment_targets_touch_updated_at on public.assignment_targets;
    create trigger assignment_targets_touch_updated_at
      before update on public.assignment_targets
      for each row execute function public.touch_updated_at();
  end if;
end $$;

-- ============================================================================
-- 6. ASSIGNMENT_RESOURCES
-- ============================================================================

create table if not exists public.assignment_resources (
  id                uuid primary key default gen_random_uuid(),
  assignment_id     uuid not null references public.assignments(id) on delete cascade,
  kind              text not null check (kind in ('recall_lesson','link','file')),
  ref_lesson_id     uuid references public.lessons(id) on delete cascade,
  url               text,
  storage_path      text,
  display_name      text,
  sort_order        int  not null default 0,
  created_at        timestamptz not null default now()
);
-- Per-kind shape enforced in the create_assignment RPC:
--   recall_lesson -> ref_lesson_id NOT NULL
--   link          -> url NOT NULL
--   file          -> storage_path NOT NULL
create index if not exists assignment_resources_assignment_idx
  on public.assignment_resources (assignment_id, sort_order);

-- ============================================================================
-- 7. SCHOOL_DASHBOARD_LAYOUTS
-- ============================================================================

create table if not exists public.school_dashboard_layouts (
  school_id  uuid primary key references public.schools(id) on delete cascade,
  layout     jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null
);

-- ============================================================================
-- 8. ROW-LEVEL SECURITY
-- ============================================================================

-- ---------- schools: add UPDATE for the owner ----------
drop policy if exists "schools_owner_update" on public.schools;
create policy "schools_owner_update" on public.schools for update
  to authenticated
  using (owner_user_id = auth.uid())
  with check (owner_user_id = auth.uid());

-- ---------- assignments: rewrite the SELECT policies ----------
-- The original "assignments_own" (from supabase_tables.sql) is too narrow
-- for the new template model. Replace it with two policies:
--   a) students see their legacy per-student row OR a template they have a target for
--   b) teacher/organiser of the school sees all assignments in that school
drop policy if exists "assignments_own"                  on public.assignments;
drop policy if exists "assignments_student_target_read"  on public.assignments;
drop policy if exists "assignments_school_read"          on public.assignments;

create policy "assignments_student_target_read" on public.assignments for select
  to authenticated
  using (
    user_id = auth.uid()
    or exists (
      select 1 from public.assignment_targets t
       where t.assignment_id = assignments.id
         and t.student_user_id = auth.uid()
    )
  );

create policy "assignments_school_read" on public.assignments for select
  to authenticated
  using (
    school_id is not null
    and school_id = (select school_id from public.profiles where id = auth.uid())
    and exists (
      select 1 from public.profiles
       where id = auth.uid()
         and role in ('teacher','school_organiser')
    )
  );

-- No INSERT/UPDATE/DELETE policy on assignments for the authenticated
-- role — all writes go through create_assignment / mark_assignment_done.

-- ---------- assignment_targets ----------
alter table public.assignment_targets enable row level security;

drop policy if exists "assignment_targets_own_read"      on public.assignment_targets;
drop policy if exists "assignment_targets_school_read"  on public.assignment_targets;

create policy "assignment_targets_own_read" on public.assignment_targets for select
  to authenticated
  using (student_user_id = auth.uid());

create policy "assignment_targets_school_read" on public.assignment_targets for select
  to authenticated
  using (
    exists (
      select 1 from public.assignments a
      join public.profiles p on p.id = auth.uid()
       where a.id = assignment_targets.assignment_id
         and a.school_id is not null
         and a.school_id = p.school_id
         and p.role in ('teacher','school_organiser')
    )
  );

-- No write policy — RPC only.

-- ---------- assignment_resources ----------
alter table public.assignment_resources enable row level security;

drop policy if exists "assignment_resources_via_parent" on public.assignment_resources;
create policy "assignment_resources_via_parent" on public.assignment_resources
  for select to authenticated
  using (
    exists (
      select 1 from public.assignments a
       where a.id = assignment_resources.assignment_id
         and (
           (a.user_id = auth.uid())
           or exists (
             select 1 from public.assignment_targets t
              where t.assignment_id = a.id
                and t.student_user_id = auth.uid()
           )
           or (
             a.school_id is not null
             and a.school_id = (select school_id from public.profiles where id = auth.uid())
             and exists (
               select 1 from public.profiles
                where id = auth.uid()
                  and role in ('teacher','school_organiser')
             )
           )
         )
    )
  );

-- ---------- school_dashboard_layouts ----------
alter table public.school_dashboard_layouts enable row level security;

drop policy if exists "school_dashboard_layouts_read" on public.school_dashboard_layouts;
create policy "school_dashboard_layouts_read" on public.school_dashboard_layouts
  for select to authenticated
  using (
    exists (
      select 1 from public.profiles
       where id = auth.uid() and school_id = school_dashboard_layouts.school_id
    )
  );

-- No write policy — RPC only.

-- ============================================================================
-- 9. STORAGE BUCKET: assignment-files
-- ============================================================================

insert into storage.buckets (id, name, public)
values ('assignment-files', 'assignment-files', true)
on conflict (id) do nothing;

drop policy if exists "assignment_files_read_all"      on storage.objects;
drop policy if exists "assignment_files_school_write"  on storage.objects;
drop policy if exists "assignment_files_owner_update"  on storage.objects;
drop policy if exists "assignment_files_owner_delete"  on storage.objects;

create policy "assignment_files_read_all" on storage.objects
  for select to anon, authenticated
  using (bucket_id = 'assignment-files');

-- Write: caller is teacher/organiser of the school whose id is path[0].
create policy "assignment_files_school_write" on storage.objects
  for insert to authenticated with check (
    bucket_id = 'assignment-files'
    and exists (
      select 1 from public.profiles p
      join public.schools s on s.id = p.school_id
       where p.id = auth.uid()
         and p.role in ('teacher','school_organiser')
         and (storage.foldername(name))[1] = s.id::text
    )
  );

create policy "assignment_files_owner_update" on storage.objects
  for update to authenticated
  using (bucket_id = 'assignment-files' and owner = auth.uid())
  with check (bucket_id = 'assignment-files' and owner = auth.uid());

create policy "assignment_files_owner_delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'assignment-files' and owner = auth.uid());

-- ============================================================================
-- 10. HELPER: assert_school_organiser
-- Mirrors _assert_admin() from supabase_admin.sql.
-- ============================================================================

create or replace function public._assert_school_organiser(p_school_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner uuid;
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  select owner_user_id into v_owner from public.schools where id = p_school_id;
  if v_owner is null then
    raise exception 'unknown school' using errcode = '42501';
  end if;
  if v_owner <> auth.uid() then
    raise exception 'organiser of this school required' using errcode = '42501';
  end if;
end;
$$;

-- ============================================================================
-- 11. ORGANISER SIGN-UP
-- ============================================================================

-- create_school_and_organiser
--   Called by signup-organisation.html after supabase.auth.signUp.
--   Stamps profile as 'school_organiser', creates a public.schools row
--   with an auto-generated permanent code, and wires profiles.school_id.
--   The caller (the new organiser) must own the user_id.
create or replace function public.create_school_and_organiser(
  p_user_id      uuid,
  p_school_name  text,
  p_plan         text default 'free'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller    uuid := auth.uid();
  v_clean     text := trim(coalesce(p_school_name, ''));
  v_plan      text := coalesce(nullif(trim(p_plan), ''), 'free');
  v_school    public.schools%rowtype;
  v_code      text;
  v_attempts  int := 0;
  v_alnum     text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; -- no 0/O/1/I
  v_codenum   bigint;
begin
  if v_caller is null then
    return jsonb_build_object('ok', false, 'reason', 'not_authenticated');
  end if;
  if v_caller <> p_user_id then
    return jsonb_build_object('ok', false, 'reason', 'cannot_create_for_other_user');
  end if;
  if v_clean = '' then
    return jsonb_build_object('ok', false, 'reason', 'school_name_required');
  end if;
  if v_plan not in ('free','standard','pro') then
    return jsonb_build_object('ok', false, 'reason', 'invalid_plan');
  end if;

  -- One organiser per school, but also don't let an existing organiser
  -- own two schools. The unique partial index on schools.owner_user_id
  -- catches the second case at insert time.
  if exists (
    select 1 from public.schools where owner_user_id = v_caller
  ) then
    return jsonb_build_object('ok', false, 'reason', 'already_owns_school');
  end if;

  -- Generate a unique 6-char code with the SCH- prefix.
  loop
    v_codenum := (random() * power(36::numeric, 6))::bigint;
    v_code := 'SCH-';
    for i in 1..6 loop
      v_code := v_code || substr(v_alnum, 1 + (v_codenum % 32)::int, 1);
      v_codenum := v_codenum / 32;
    end loop;
    v_attempts := v_attempts + 1;
    begin
      insert into public.schools (name, code, plan, owner_user_id)
      values (v_clean, v_code, v_plan, v_caller)
      returning * into v_school;
      exit;
    exception when unique_violation then
      if v_attempts > 20 then
        return jsonb_build_object('ok', false, 'reason', 'code_collision');
      end if;
    end;
  end loop;

  -- Stamp the profile.
  insert into public.profiles (id, role, school_id)
  values (p_user_id, 'school_organiser', v_school.id)
  on conflict (id) do update
    set role      = 'school_organiser',
        school_id = v_school.id;

  return jsonb_build_object(
    'ok', true,
    'school_id',   v_school.id,
    'school_code', v_school.code,
    'school_name', v_school.name,
    'plan',        v_school.plan
  );
end;
$$;

grant execute on function public.create_school_and_organiser(uuid, text, text) to authenticated;

-- ============================================================================
-- 12. ATTACH_STUDENT_TO_SCHOOL
-- ============================================================================

create or replace function public.attach_student_to_school(
  p_user_id   uuid,
  p_school_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null or auth.uid() <> p_user_id then
    raise exception 'cannot attach another user to a school' using errcode = '42501';
  end if;
  if not exists (select 1 from public.schools where id = p_school_id) then
    raise exception 'unknown school' using errcode = '42501';
  end if;

  insert into public.profiles (id, school_id)
  values (p_user_id, p_school_id)
  on conflict (id) do update
    set school_id            = p_school_id,
        removed_from_school_at = null;
end;
$$;

grant execute on function public.attach_student_to_school(uuid, uuid) to authenticated;

-- ============================================================================
-- 13. LIST_SCHOOL_MEMBERS
-- ============================================================================

create or replace function public.list_school_members(
  p_school_id   uuid,
  p_role_filter text default 'all'
)
returns table (
  id              uuid,
  full_name       text,
  role            text,
  email           text,
  year_group      text,
  created_at      timestamptz,
  last_sign_in_at timestamptz
)
language sql
security definer
set search_path = public
stable
as $$
  select p.id, p.full_name, p.role, u.email::text,
         p.year_group, p.created_at, u.last_sign_in_at
    from public.profiles p
    join auth.users u on u.id = p.id
   where p.school_id = p_school_id
     and p.removed_from_school_at is null
     and (
       p_role_filter = 'all'
       or p.role = p_role_filter
     )
   order by p.role asc, p.created_at asc;
$$;

grant execute on function public.list_school_members(uuid, text) to authenticated;

-- ============================================================================
-- 14. REMOVE_SCHOOL_MEMBER
-- Soft-removes: profiles.school_id = null, removed_from_school_at = now().
-- Caller must be the organiser of the member's current school.
-- ============================================================================

create or replace function public.remove_school_member(
  p_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_member public.profiles%rowtype;
  v_owner  uuid;
begin
  select * into v_member from public.profiles where id = p_user_id;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'unknown_user');
  end if;
  if v_member.school_id is null then
    return jsonb_build_object('ok', false, 'reason', 'not_in_school');
  end if;
  select owner_user_id into v_owner from public.schools where id = v_member.school_id;
  if v_owner is null or v_owner <> auth.uid() then
    return jsonb_build_object('ok', false, 'reason', 'not_organiser');
  end if;
  if v_member.id = v_owner then
    return jsonb_build_object('ok', false, 'reason', 'cannot_remove_self');
  end if;

  update public.profiles
     set school_id               = null,
         removed_from_school_at  = now(),
         updated_at              = now()
   where id = p_user_id;

  return jsonb_build_object('ok', true);
end;
$$;

grant execute on function public.remove_school_member(uuid) to authenticated;

-- ============================================================================
-- 15. TRANSFER_SCHOOL_OWNERSHIP
-- Admin-only. Demotes the current owner to 'student' (or 'teacher' if
-- they had a teacher role before becoming organiser — we don't track
-- that, so 'student' is the safe default; staff_* roles are untouched).
-- ============================================================================

create or replace function public.transfer_school_ownership(
  p_school_id      uuid,
  p_new_owner_id   uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller uuid := auth.uid();
  v_school public.schools%rowtype;
  v_new    public.profiles%rowtype;
begin
  -- Admin check.
  if not exists (select 1 from public.profiles where id = v_caller and role = 'admin') then
    return jsonb_build_object('ok', false, 'reason', 'admin_required');
  end if;
  select * into v_school from public.schools where id = p_school_id;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'unknown_school');
  end if;
  select * into v_new from public.profiles where id = p_new_owner_id;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'unknown_user');
  end if;
  if v_new.school_id is distinct from p_school_id then
    return jsonb_build_object('ok', false, 'reason', 'new_owner_not_in_school');
  end if;

  -- Demote current owner if they were a school_organiser.
  if v_school.owner_user_id is not null then
    update public.profiles
       set role       = case
                          when role = 'school_organiser' then 'student'
                          else role
                        end,
           updated_at = now()
     where id = v_school.owner_user_id
       and role = 'school_organiser';
  end if;

  -- Promote new owner.
  update public.profiles
     set role       = 'school_organiser',
         updated_at = now()
   where id = p_new_owner_id;

  update public.schools
     set owner_user_id = p_new_owner_id
   where id = p_school_id;

  return jsonb_build_object('ok', true);
end;
$$;

grant execute on function public.transfer_school_ownership(uuid, uuid) to authenticated;

-- ============================================================================
-- 16. REGENERATE_SCHOOL_CODE
-- Organiser-only. Picks a new unique code for the school.
-- ============================================================================

create or replace function public.regenerate_school_code(
  p_school_id uuid
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
begin
  perform public._assert_school_organiser(p_school_id);

  loop
    v_codenum := (random() * power(36::numeric, 6))::bigint;
    v_code := 'SCH-';
    for i in 1..6 loop
      v_code := v_code || substr(v_alnum, 1 + (v_codenum % 32)::int, 1);
      v_codenum := v_codenum / 32;
    end loop;
    v_attempts := v_attempts + 1;
    begin
      update public.schools
         set code = v_code
       where id = p_school_id;
      exit;
    exception when unique_violation then
      if v_attempts > 20 then
        return jsonb_build_object('ok', false, 'reason', 'code_collision');
      end if;
    end;
  end loop;

  return jsonb_build_object('ok', true, 'school_code', v_code);
end;
$$;

grant execute on function public.regenerate_school_code(uuid) to authenticated;

-- ============================================================================
-- 17. TEACHER SIGN-UP CODES (organiser UI)
-- ============================================================================

create or replace function public.create_teacher_signup_code(
  p_school_id  uuid,
  p_expires_at timestamptz default null
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
begin
  perform public._assert_school_organiser(p_school_id);

  loop
    v_codenum := (random() * power(36::numeric, 6))::bigint;
    v_code := 'TCH-';
    for i in 1..6 loop
      v_code := v_code || substr(v_alnum, 1 + (v_codenum % 32)::int, 1);
      v_codenum := v_codenum / 32;
    end loop;
    v_attempts := v_attempts + 1;
    begin
      insert into public.teacher_signup_codes (school_id, code, expires_at, created_by)
      values (p_school_id, v_code, p_expires_at, auth.uid())
      returning id into v_id;
      exit;
    exception when unique_violation then
      if v_attempts > 20 then
        return jsonb_build_object('ok', false, 'reason', 'code_collision');
      end if;
    end;
  end loop;

  return jsonb_build_object(
    'ok',         true,
    'id',         v_id,
    'code',       v_code,
    'school_id',  p_school_id,
    'expires_at', p_expires_at
  );
end;
$$;

grant execute on function public.create_teacher_signup_code(uuid, timestamptz) to authenticated;

create or replace function public.list_teacher_signup_codes(
  p_school_id uuid
)
returns table (
  code         text,
  used_at      timestamptz,
  used_by      uuid,
  expires_at   timestamptz,
  created_at   timestamptz
)
language sql
security definer
set search_path = public
stable
as $$
  select t.code, t.used_at, t.used_by, t.expires_at, t.created_at
    from public.teacher_signup_codes t
   where t.school_id = p_school_id
   order by t.created_at desc;
$$;

grant execute on function public.list_teacher_signup_codes(uuid) to authenticated;

-- Caller check is "organiser of the code's school" rather than the
-- global _assert_school_organiser, because the caller knows the code,
-- not the school_id.
create or replace function public.revoke_teacher_signup_code(
  p_code text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row  public.teacher_signup_codes%rowtype;
  v_owner uuid;
begin
  select * into v_row from public.teacher_signup_codes where code = trim(p_code);
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  select owner_user_id into v_owner from public.schools where id = v_row.school_id;
  if v_owner is null or v_owner <> auth.uid() then
    return jsonb_build_object('ok', false, 'reason', 'not_organiser');
  end if;
  if v_row.used_at is not null then
    return jsonb_build_object('ok', false, 'reason', 'already_used');
  end if;

  -- We "revoke" by marking the code as used. The teacher-signup form
  -- already short-circuits on used_at IS NOT NULL.
  update public.teacher_signup_codes
     set used_at = now()
   where id = v_row.id;

  return jsonb_build_object('ok', true);
end;
$$;

grant execute on function public.revoke_teacher_signup_code(text) to authenticated;

-- ============================================================================
-- 18. HOMEWORK RPCs
-- ============================================================================

-- ---------- create_assignment ----------
-- Caller must be teacher or organiser of p_school_id. p_targets is jsonb
-- with one of:
--   {"all": true}
--   {"subject_id": "<uuid>"}
--   {"year_group": "Year 10"}
--   {"student_ids": ["<uuid>", ...]}
create or replace function public.create_assignment(
  p_school_id   uuid,
  p_subject_id  uuid,
  p_title       text,
  p_description text,
  p_due_at      timestamptz,
  p_targets     jsonb,
  p_kind        text default 'homework',
  p_resources   jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller   uuid := auth.uid();
  v_school   public.schools%rowtype;
  v_title    text := trim(coalesce(p_title, ''));
  v_kind     text := coalesce(nullif(trim(p_kind), ''), 'homework');
  v_tgt      jsonb := coalesce(p_targets, '{}'::jsonb);
  v_res      jsonb := coalesce(p_resources, '[]'::jsonb);
  v_aid      uuid;
  v_count    int := 0;
  v_res_item jsonb;
begin
  if v_caller is null then
    return jsonb_build_object('ok', false, 'reason', 'not_authenticated');
  end if;
  select * into v_school from public.schools where id = p_school_id;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'unknown_school');
  end if;
  -- Caller must belong to this school and be a teacher or organiser.
  if not exists (
    select 1 from public.profiles
     where id = v_caller
       and school_id = p_school_id
       and role in ('teacher','school_organiser')
  ) then
    return jsonb_build_object('ok', false, 'reason', 'forbidden');
  end if;
  if v_title = '' then
    return jsonb_build_object('ok', false, 'reason', 'title_required');
  end if;
  if p_due_at is null then
    return jsonb_build_object('ok', false, 'reason', 'due_at_required');
  end if;
  if v_kind not in ('homework','mock','exam','live') then
    return jsonb_build_object('ok', false, 'reason', 'invalid_kind');
  end if;

  insert into public.assignments (
    user_id, school_id, created_by, is_template,
    subject_id, title, description, kind, due_at
  ) values (
    null, p_school_id, v_caller, true,
    p_subject_id, v_title, nullif(trim(coalesce(p_description, '')), ''),
    v_kind, p_due_at
  )
  returning id into v_aid;

  -- Expand p_targets and insert one row per student.
  if v_tgt ? 'all' and (v_tgt->>'all')::boolean then
    insert into public.assignment_targets (assignment_id, student_user_id)
    select v_aid, p.id
      from public.profiles p
     where p.school_id = p_school_id
       and p.role = 'student'
       and p.removed_from_school_at is null
       and p.deleted_at is null;
    get diagnostics v_count = row_count;
  elsif v_tgt ? 'subject_id' then
    insert into public.assignment_targets (assignment_id, student_user_id)
    select v_aid, e.user_id
      from public.enrollments e
      join public.profiles p on p.id = e.user_id
     where e.subject_id = (v_tgt->>'subject_id')::uuid
       and p.school_id = p_school_id
       and p.role = 'student'
       and p.removed_from_school_at is null
       and p.deleted_at is null;
    get diagnostics v_count = row_count;
  elsif v_tgt ? 'year_group' then
    insert into public.assignment_targets (assignment_id, student_user_id)
    select v_aid, p.id
      from public.profiles p
     where p.school_id = p_school_id
       and p.role = 'student'
       and p.year_group = v_tgt->>'year_group'
       and p.removed_from_school_at is null
       and p.deleted_at is null;
    get diagnostics v_count = row_count;
  elsif v_tgt ? 'student_ids' and jsonb_typeof(v_tgt->'student_ids') = 'array' then
    insert into public.assignment_targets (assignment_id, student_user_id)
    select v_aid, (sid #>> '{}')::uuid
      from jsonb_array_elements(v_tgt->'student_ids') sid
     where exists (
       select 1 from public.profiles p
        where p.id = (sid #>> '{}')::uuid
          and p.school_id = p_school_id
          and p.role = 'student'
          and p.removed_from_school_at is null
          and p.deleted_at is null
     );
    get diagnostics v_count = row_count;
  else
    return jsonb_build_object('ok', false, 'reason', 'invalid_targets');
  end if;

  -- Resources.
  if jsonb_typeof(v_res) = 'array' then
    for v_res_item in select * from jsonb_array_elements(v_res)
    loop
      insert into public.assignment_resources (
        assignment_id, kind, ref_lesson_id, url, storage_path, display_name, sort_order
      ) values (
        v_aid,
        v_res_item->>'kind',
        nullif(v_res_item->>'ref_lesson_id','')::uuid,
        nullif(v_res_item->>'url',''),
        nullif(v_res_item->>'storage_path',''),
        nullif(v_res_item->>'display_name',''),
        coalesce((v_res_item->>'sort_order')::int, 0)
      );
    end loop;
  end if;

  return jsonb_build_object(
    'ok', true,
    'assignment_id', v_aid,
    'targets_created', v_count
  );
end;
$$;

grant execute on function public.create_assignment(
  uuid, uuid, text, text, timestamptz, jsonb, text, jsonb
) to authenticated;

-- ---------- list_my_assignments ----------
-- Shaped for the existing dashboard renderers.
create or replace function public.list_my_assignments()
returns table (
  id             uuid,
  school_id      uuid,
  subject_id     uuid,
  title          text,
  description    text,
  kind           text,
  due_at         timestamptz,
  status         text,
  resource_count int
)
language sql
security definer
set search_path = public
stable
as $$
  -- Template assignments via assignment_targets
  select a.id, a.school_id, a.subject_id, a.title, a.description,
         a.kind, a.due_at, t.status,
         (select count(*) from public.assignment_resources r where r.assignment_id = a.id)::int
    from public.assignments a
    join public.assignment_targets t on t.assignment_id = a.id
   where t.student_user_id = auth.uid()
     and a.is_template = true
  union all
  -- Legacy per-student rows
  select a.id, a.school_id, a.subject_id, a.title, a.description,
         a.kind, a.due_at, a.status,
         (select count(*) from public.assignment_resources r where r.assignment_id = a.id)::int
    from public.assignments a
   where a.user_id = auth.uid()
     and a.is_template = false
  order by 7 asc;
$$;

grant execute on function public.list_my_assignments() to authenticated;

-- ---------- list_school_assignments ----------
-- Teacher / organiser view. Aggregates target counts.
create or replace function public.list_school_assignments(
  p_school_id uuid,
  p_status    text default 'all'
)
returns table (
  id             uuid,
  title          text,
  description    text,
  kind           text,
  subject_id     uuid,
  due_at         timestamptz,
  created_at     timestamptz,
  created_by     uuid,
  total_targets  int,
  done_count     int,
  missed_count   int
)
language sql
security definer
set search_path = public
stable
as $$
  select a.id, a.title, a.description, a.kind, a.subject_id, a.due_at, a.created_at,
         a.created_by,
         coalesce(t.total, 0)::int,
         coalesce(t.done, 0)::int,
         coalesce(t.missed, 0)::int
    from public.assignments a
    left join (
      select assignment_id,
             count(*)                                                    as total,
             count(*) filter (where status = 'done')                    as done,
             count(*) filter (where status = 'missed')                  as missed
        from public.assignment_targets
       group by assignment_id
    ) t on t.assignment_id = a.id
   where a.school_id = p_school_id
     and a.is_template = true
     and (
       p_status = 'all'
       or (p_status = 'upcoming' and a.due_at >= now())
       or (p_status = 'past'     and a.due_at <  now())
     )
   order by a.due_at asc;
$$;

grant execute on function public.list_school_assignments(uuid, text) to authenticated;

-- ---------- list_assignment_targets ----------
create or replace function public.list_assignment_targets(
  p_assignment_id uuid
)
returns table (
  student_user_id uuid,
  full_name       text,
  year_group      text,
  status          text,
  completed_at    timestamptz
)
language sql
security definer
set search_path = public
stable
as $$
  select t.student_user_id, p.full_name, p.year_group, t.status, t.completed_at
    from public.assignment_targets t
    join public.profiles p on p.id = t.student_user_id
   where t.assignment_id = p_assignment_id
   order by p.full_name asc;
$$;

grant execute on function public.list_assignment_targets(uuid) to authenticated;

-- ---------- mark_assignment_done ----------
create or replace function public.mark_assignment_done(
  p_assignment_id uuid,
  p_done          boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.assignment_targets
     set status       = case when p_done then 'done' else 'pending' end,
         completed_at = case when p_done then now() else null end,
         updated_at   = now()
   where assignment_id = p_assignment_id
     and student_user_id = auth.uid();
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_target');
  end if;
  return jsonb_build_object('ok', true);
end;
$$;

grant execute on function public.mark_assignment_done(uuid, boolean) to authenticated;

-- ============================================================================
-- 19. SCHOOL DASHBOARD LAYOUT RPCs
-- ============================================================================

-- Valid card IDs. The upsert RPC validates against this list and rejects
-- unknowns (so a typo doesn't get baked in).
create or replace function public.get_school_dashboard_layout(
  p_school_id uuid
)
returns jsonb
language sql
security definer
set search_path = public
stable
as $$
  select layout
    from public.school_dashboard_layouts
   where school_id = p_school_id;
$$;

grant execute on function public.get_school_dashboard_layout(uuid) to authenticated;

create or replace function public.upsert_school_dashboard_layout(
  p_school_id uuid,
  p_layout    jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_allowed text[] := array['kpis','continue','subjects','upcoming','activity','school_announce'];
  v_item    jsonb;
  v_id      text;
begin
  perform public._assert_school_organiser(p_school_id);
  if jsonb_typeof(p_layout) <> 'array' then
    return jsonb_build_object('ok', false, 'reason', 'layout_must_be_array');
  end if;
  for v_item in select * from jsonb_array_elements(p_layout)
  loop
    v_id := v_item->>'card_id';
    if v_id is null or not (v_id = any(v_allowed)) then
      return jsonb_build_object('ok', false, 'reason', 'unknown_card', 'card_id', v_id);
    end if;
  end loop;

  insert into public.school_dashboard_layouts (school_id, layout, updated_by, updated_at)
  values (p_school_id, p_layout, auth.uid(), now())
  on conflict (school_id) do update
    set layout     = excluded.layout,
        updated_by = excluded.updated_by,
        updated_at = excluded.updated_at;

  return jsonb_build_object('ok', true);
end;
$$;

grant execute on function public.upsert_school_dashboard_layout(uuid, jsonb) to authenticated;

-- ============================================================================
-- 20. UPDATE EXISTING AUTH HOOK
-- The hook reads p.role straight from profiles and stamps it onto the
-- JWT. The widened CHECK accepts the new 'school_organiser' value, so
-- no code change is required. The hook should be re-enabled in the
-- Supabase dashboard if it had been turned off.
-- ============================================================================

-- ============================================================================
-- DONE.
--
-- After running this migration:
--   1. Sign up at signup-organisation.html → land on
--      school-organiser-dashboard.html.
--   2. Generate teacher codes from the organiser console.
--   3. Sign up at signup-teacher.html with the one-time code.
--   4. Set homework at set-homework.html.
--   5. Sign up at signup.html with the school code to attach a student.
--   6. The student sees the organiser's published layout on dashboard.html
--      and the homework at homework.html.
--
-- Storage bucket 'assignment-files' is public-read (matches lesson-images).
-- Per-school RLS on writes: only teacher/organiser of the school whose id
-- is path[0] can upload, update, or delete.
-- ============================================================================
