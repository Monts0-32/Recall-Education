-- ============================================================================
-- Recall Education — Teacher role fix
--
-- Run AFTER supabase_organiser_role_fix.sql (and every other
-- supabase_*.sql migration). Idempotent. Order-independent: this file
-- widens profiles.role_check itself so it works whether or not
-- supabase_signup_routing.sql / supabase_school_organisers.sql have
-- been run yet.
--
-- Bug being fixed:
--   The handle_new_user trigger (supabase_setup.sql, patched in
--   supabase_organiser_role_fix.sql) only recognises
--   intended_role='school_organiser' in user_metadata. For teacher
--   sign-ups the form stashes only `{ full_name }` — no intended_role,
--   no school_id. The trigger therefore writes the column default
--   'student' and leaves school_id null.
--
--   signup-teacher.html then calls attach_teacher_to_school RPC to
--   promote the profile to role='teacher'. But that RPC has the gate
--     if auth.uid() is null or auth.uid() <> p_user_id
--       raise exception 'cannot attach another user to a school'
--   and the teacher form never signs the user in (no
--   signInWithPassword call) — email confirmation is required. So
--   auth.uid() is null at the time the RPC runs, the RPC raises
--   42501, and the form's submit handler only console.warns the
--   error. The teacher is silently demoted to 'student' and on
--   re-sign-in routes to the student dashboard.
--
-- This migration:
--   1. Extends handle_new_user to also handle intended_role='teacher':
--      if user_metadata carries a school code OR school_id, the trigger
--      resolves the school and stamps role='teacher' + school_id on the
--      profile inline. Falls back to 'student' (not NULL) so the
--      column is always populated.
--   2. Backfills any orphaned teacher account: profile exists with
--      role != 'teacher' but the auth user has user_metadata.intended_role
--      = 'teacher' AND that metadata carries a school code.
--   3. Updates check_parental_consent to keep stamping app_metadata.role
--      onto the JWT (defensive — the organiser-fix migration already
--      does this; this is a no-op if it's already in place).
-- ============================================================================

-- ---------- 0. ENSURE profiles.role_check ACCEPTS teacher ----------------
-- Defensive: supabase_signup_routing.sql and supabase_school_organisers.sql
-- both widen the constraint, but if neither has run yet (e.g. the
-- organiser-fix migration was the only one applied), the constraint
-- will reject role='teacher' with 23514 and break every teacher signup.
alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles
  add constraint profiles_role_check
  check (role in (
    'student', 'teacher', 'school_organiser',
    'staff_author', 'staff_reviewer', 'admin'
  ));

-- ---------- 1. EXTEND handle_new_user FOR TEACHERS ------------------------
-- Reads user_metadata.intended_role. For 'school_organiser' the
-- existing flow runs (create a school + stamping organiser role).
-- For 'teacher' we resolve the school by code (or by id if the form
-- already passed one) and stamp role='teacher' + school_id on the
-- profile inline. The role column is always populated — never NULL.

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  meta            jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  intended_role   text  := meta->>'intended_role';
  intended_school text  := trim(coalesce(meta->>'intended_school', ''));
  intended_plan   text  := coalesce(nullif(trim(meta->>'intended_plan')), 'free');
  intended_code   text  := trim(coalesce(meta->>'intended_school_code', ''));
  intended_school_id uuid := nullif(meta->>'intended_school_id', '')::uuid;
  dob_text        text  := meta->>'dob';
  dob_date        date  := null;
  age_years       int   := null;

  -- School-creation locals (organiser flow).
  v_school_id   uuid;
  v_alnum       text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  v_codenum     bigint;
  v_code        text;
  v_attempts    int := 0;

  -- Final values written into profiles.
  v_final_role     text := 'student';
  v_final_school   uuid;
begin
  if dob_text is not null and dob_text <> '' then
    begin
      dob_date := dob_text::date;
    exception when others then
      dob_date := null;
    end;
  end if;

  if dob_date is not null then
    age_years := date_part('year', age(current_date, dob_date))::int;
  end if;

  -- Branch 1: organiser. Generate a school code, create a school row.
  if intended_role = 'school_organiser' and intended_school <> '' then
    begin
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
          values (intended_school, v_code, intended_plan, new.id)
          returning id into v_school_id;
          v_final_role   := 'school_organiser';
          v_final_school := v_school_id;
          exit;
        exception when unique_violation then
          if v_attempts > 20 then
            v_school_id := null;
            exit;
          end if;
        end;
      end loop;
    exception when others then
      raise warning 'handle_new_user: school insert failed for user % (%): %',
        new.id, new.email, sqlerrm;
      v_school_id := null;
    end;
  -- Branch 2: teacher. Resolve the school by id (preferred) or by
  -- code (fallback). We do NOT create a new school — the organiser
  -- already owns it; the teacher is just attaching.
  elsif intended_role = 'teacher' then
    begin
      if intended_school_id is not null then
        select id into v_school_id from public.schools where id = intended_school_id;
      elsif intended_code <> '' then
        select id into v_school_id from public.schools where code = intended_code;
      end if;
      if v_school_id is not null then
        v_final_role   := 'teacher';
        v_final_school := v_school_id;
      else
        -- Code missing or unknown: leave role='student'. The form's
        -- attach_teacher_to_school RPC may still recover this on
        -- the confirmation page (it requires a session, which the
        -- teacher gets via the magic link).
        raise warning 'handle_new_user: teacher % has no resolvable school (code=%, id=%)',
          new.email, intended_code, intended_school_id;
      end if;
    exception when others then
      raise warning 'handle_new_user: teacher school resolution failed for % (%): %',
        new.email, new.id, sqlerrm;
      v_school_id := null;
    end;
  end if;

  -- Profile row. role must NEVER be NULL — the column is NOT NULL.
  begin
    insert into public.profiles (
      id, full_name, year_group, dob, parent_email,
      requires_parental_consent, role, school_id
    )
    values (
      new.id,
      meta->>'full_name',
      meta->>'year_group',
      dob_date,
      meta->>'parent_email',
      coalesce(age_years is not null and age_years < 16, false),
      v_final_role,
      v_final_school
    )
    on conflict (id) do update set
      role      = case
                    when excluded.role = 'school_organiser' then 'school_organiser'
                    when excluded.role = 'teacher'         then 'teacher'
                    when excluded.role is distinct from 'student' then excluded.role
                    else public.profiles.role
                  end,
      school_id = coalesce(excluded.school_id, public.profiles.school_id);
  exception when others then
    raise warning 'handle_new_user: profile insert failed for user % (%): %',
      new.id, new.email, sqlerrm;
  end;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- 2. BACKFILL ORPHANED TEACHER ACCOUNTS -------------------------
-- A teacher that signed up before this fix landed has:
--   - profile.role = 'student' (column default, no intended_role wired in)
--   - profile.school_id = null (the trigger didn't know to look)
--   - user_metadata.intended_role = 'teacher' (the form stashed it
--     for the send-signup-email call, even though signup-teacher.html
--     today only passes `full_name`)
--   - user_metadata.intended_school_code OR user_metadata.intended_school_id
--     (depending on form version)
--
-- Promote any such user to role='teacher' with the resolved school_id.
-- Wrapped in DO/EXCEPTION so a transient resolution failure on one
-- user doesn't abort the whole backfill.

do $$
declare
  v_user_id    uuid;
  v_meta       jsonb;
  v_role       text;
  v_code       text;
  v_school_id  uuid;
  v_school_id_arg uuid;
begin
  for v_user_id, v_meta in
    select u.id, u.raw_user_meta_data
      from auth.users u
      left join public.profiles p on p.id = u.id
     where coalesce(p.role, 'student') is distinct from 'teacher'
       and (u.raw_user_meta_data->>'intended_role') = 'teacher'
  loop
    v_code := trim(coalesce(v_meta->>'intended_school_code', ''));
    begin
      v_school_id_arg := nullif(v_meta->>'intended_school_id', '')::uuid;
    exception when others then
      v_school_id_arg := null;
    end;
    v_school_id := null;
    begin
      if v_school_id_arg is not null then
        select id into v_school_id from public.schools where id = v_school_id_arg;
      elsif v_code <> '' then
        select id into v_school_id from public.schools where code = v_code;
      end if;
    exception when others then
      v_school_id := null;
    end;
    if v_school_id is not null then
      insert into public.profiles (id, role, school_id)
        values (v_user_id, 'teacher', v_school_id)
        on conflict (id) do update
          set role      = 'teacher',
              school_id = v_school_id;
      raise notice 'backfill_teachers: promoted % to teacher (school=%)', v_user_id, v_school_id;
    else
      raise notice 'backfill_teachers: no resolvable school for % (code=%, id=%) — left as student',
        v_user_id, v_code, v_school_id_arg;
    end if;
  end loop;
end;
$$;

-- ---------- 3. ENSURE check_parental_consent STAMPS app_metadata.role ----
-- The organiser-fix migration already extends the hook to stamp
-- app_metadata.role. This block is defensive: if that migration was
-- not run, the teacher still won't be routed correctly. Re-stating
-- the hook here with the same logic makes the teacher fix standalone.
create or replace function public.check_parental_consent(event jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  user_id  uuid := (event->>'user_id')::uuid;
  p        public.profiles%rowtype;
  v_claims jsonb := coalesce(event->'claims', '{}'::jsonb);
  v_role   text;
begin
  select * into p from public.profiles where id = user_id;
  if not found then
    return event;
  end if;

  if p.requires_parental_consent and p.consent_status <> 'granted' then
    raise exception 'parental_consent_required'
      using errcode = '42501';
  end if;

  v_role := coalesce(p.role, 'student');
  v_claims := jsonb_set(
    v_claims,
    '{app_metadata}',
    coalesce(v_claims->'app_metadata', '{}'::jsonb)
      || jsonb_build_object('role', v_role),
    true
  );
  return jsonb_set(event, '{claims}', v_claims, false);
end;
$$;

grant execute on function public.check_parental_consent(jsonb) to supabase_auth_admin;

-- ============================================================================
-- DONE. After running this migration:
--   1. Future teacher sign-ups (with intended_role='teacher' + school
--      code/id in user_metadata) get profile.role='teacher' inline at
--      auth.users insert time. No race with attach_teacher_to_school.
--   2. Existing teachers that were demoted to 'student' (and whose
--      user_metadata still carries the school code) are promoted by
--      the backfill in section 2.
--   3. The custom_access_token_hook stamps app_metadata.role on every
--      JWT, so on re-sign-in the teacher is routed to
--      teacher-dashboard.html instead of dashboard.html.
--
-- Action required on the client:
--   signup-teacher.html must now pass
--     data: { full_name: name, intended_role: 'teacher',
--             intended_school_code: resolvedSchool.school_code }
--   so the trigger has the school code to resolve. The school_code is
--   already on the form (resolvedSchool.school_code), so this is a
--   one-line addition. See the companion edit to signup-teacher.html.
-- ============================================================================
