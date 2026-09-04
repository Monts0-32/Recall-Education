-- ============================================================================
-- Recall Education — Student school-attach fix
--
-- Run AFTER supabase_teacher_role_fix.sql (and every other supabase_*.sql
-- migration). Idempotent. Order-independent: this file widens
-- profiles.role_check itself.
--
-- Bug being fixed:
--   When a student signs up with a school code, they end up as a plain
--   "normal" student with profiles.school_id = NULL — not tied to the
--   school at all.
--
--   Root cause (identical to the teacher bug fixed in
--   supabase_teacher_role_fix.sql): signup.html calls
--   attach_student_to_school (or attach_student_to_school_via_invite for
--   student invite codes) immediately after supabaseClient.auth.signUp().
--   Both RPCs gate on
--     if auth.uid() is null or auth.uid() <> p_user_id
--       raise exception 'cannot attach another user to a school'
--   Email confirmation is required, so the user has NO session at that
--   point, auth.uid() is null, the RPC raises 42501, and the form's
--   error handler only console.warn's it. The profile row (created by
--   handle_new_user with role='student', school_id=null) is never
--   updated, and the student is silently left unattached.
--
-- This migration:
--   1. Extends handle_new_user with a student branch: when
--      user_metadata carries a school code (intended_school_code), the
--      trigger resolves the school at auth.users INSERT time — no
--      session required — and stamps profiles.school_id inline. The
--      role stays 'student'; only the school tie is added.
--      Two code kinds are honoured, mirroring lookup_school_by_code:
--        a) student invite codes (school_invite_codes) — expiry,
--           max_uses and allowed_email_domain are enforced against
--           the signup email, and uses_count is bumped atomically at
--           insert time (the claim).
--        b) permanent schools.code (the SCH-XXXXXX organiser code).
--   2. Makes attach_student_to_school_via_invite idempotent: if the
--      profile is already attached to the invite's school (i.e. the
--      trigger already stamped + claimed it), the RPC no longer burns
--      a second use of the code.
--   3. Backfills any student whose user_metadata carries a resolvable
--      school code but whose profile has no school_id (covers the gap
--      between deploying the signup.html change and running this SQL).
--   4. Re-states check_parental_consent so app_metadata.role keeps
--      being stamped onto the JWT (defensive — the organiser/teacher
--      fix migrations already do this).
--
-- Companion client change (signup.html):
--   The signUp options.data block gains
--     intended_role: 'student',
--     intended_school_code: resolvedSchool ? resolvedSchool.original_code : null
--   so the trigger has the code to resolve. The existing post-signUp RPC
--   calls stay as a harmless fallback (they still require a session,
--   which only exists if email confirmation is ever disabled).
-- ============================================================================

-- ---------- 0. ENSURE profiles.role_check ACCEPTS every role --------------
-- Same defensive re-stamp as the organiser/teacher fix files.
alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles
  add constraint profiles_role_check
  check (role in (
    'student', 'teacher', 'school_organiser',
    'staff_author', 'staff_reviewer', 'admin'
  ));

-- ---------- 1. EXTEND handle_new_user FOR STUDENTS ------------------------
-- Branches 1 (organiser) and 2 (teacher) are carried over unchanged from
-- supabase_teacher_role_fix.sql. Branch 3 (student) is new: resolve the
-- school by invite code or permanent code and stamp school_id on the
-- profile inline. Role is NEVER changed by the student branch — the
-- student stays a student, they just get tied to the school.

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
  intended_plan   text  := coalesce(nullif(trim(meta->>'intended_plan'), ''), 'free');
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

  -- Student invite-code locals (student flow).
  v_invite       public.school_invite_codes%rowtype;
  v_email_domain text;

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
        raise warning 'handle_new_user: teacher % has no resolvable school (code=%, id=%)',
          new.email, intended_code, intended_school_id;
      end if;
    exception when others then
      raise warning 'handle_new_user: teacher school resolution failed for % (%): %',
        new.email, new.id, sqlerrm;
      v_school_id := null;
    end;
  -- Branch 3: student with a school code. Resolve the school and stamp
  -- profiles.school_id — role stays 'student'. No session is needed
  -- (this runs at auth.users insert time), which is the whole point:
  -- the attach_student_to_school RPC can't run pre-confirmation.
  -- Accept a missing intended_role so older form versions that send
  -- only the code still work.
  elsif intended_code <> '' and coalesce(intended_role, 'student') = 'student' then
    begin
      -- 3a. Student invite code? Enforce expiry / max_uses / email
      --     domain against the signup email, then claim (bump uses_count).
      select * into v_invite
        from public.school_invite_codes
       where code = intended_code
         and (expires_at is null or expires_at > now())
         and (max_uses is null or uses_count < max_uses)
       limit 1;

      if found then
        if v_invite.allowed_email_domain is not null then
          v_email_domain := lower(split_part(lower(coalesce(new.email, '')), '@', 2));
          if v_email_domain <> lower(v_invite.allowed_email_domain) then
            raise warning 'handle_new_user: student % domain % does not match invite domain % — not attached',
              new.email, v_email_domain, v_invite.allowed_email_domain;
          else
            update public.school_invite_codes
               set uses_count = uses_count + 1
             where id = v_invite.id;
            v_final_school := v_invite.school_id;
          end if;
        else
          update public.school_invite_codes
             set uses_count = uses_count + 1
           where id = v_invite.id;
          v_final_school := v_invite.school_id;
        end if;
      else
        -- 3b. Permanent schools.code (e.g. SCH-XXXXXX).
        select id into v_school_id
          from public.schools
         where code = intended_code and active = true;
        if v_school_id is not null then
          v_final_school := v_school_id;
        else
          raise warning 'handle_new_user: student % has no resolvable school (code=%)',
            new.email, intended_code;
        end if;
      end if;
    exception when others then
      raise warning 'handle_new_user: student school resolution failed for % (%): %',
        new.email, new.id, sqlerrm;
      v_final_school := null;
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

-- ---------- 2. MAKE attach_student_to_school_via_invite IDEMPOTENT ---------
-- The trigger now claims the invite code at insert time. If the RPC is
-- ever re-run for the same user (e.g. email confirmation disabled so the
-- signup form's fallback call carries a session), don't burn a second
-- use of the code — attach is a no-op when the profile is already tied
-- to this school. Supersedes the version in supabase_signup_routing.sql
-- (same signature — create or replace is safe; no drop needed).

create or replace function public.attach_student_to_school_via_invite(
  p_code     text,
  p_user_id  uuid,
  p_email    text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller  uuid := auth.uid();
  v_clean   text := trim(coalesce(p_code, ''));
  v_email   text := lower(trim(coalesce(p_email, '')));
  v_domain  text;
  v_ic      public.school_invite_codes%rowtype;
  v_school  public.schools%rowtype;
begin
  if v_caller is null or v_caller <> p_user_id then
    return jsonb_build_object('ok', false, 'reason', 'cannot_attach_other_user');
  end if;
  if v_clean = '' or v_email = '' or position('@' in v_email) < 2 then
    return jsonb_build_object('ok', false, 'reason', 'invalid_input');
  end if;

  -- Lock + load the invite row.
  select * into v_ic
    from public.school_invite_codes
   where code = v_clean
    for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  -- Idempotency: handle_new_user may already have claimed the code and
  -- stamped the school at signup time. If so, report success WITHOUT
  -- bumping uses_count again.
  if exists (
    select 1 from public.profiles
     where id = p_user_id and school_id = v_ic.school_id
  ) then
    select * into v_school from public.schools where id = v_ic.school_id;
    return jsonb_build_object(
      'ok', true, 'already_attached', true,
      'school_id', v_ic.school_id, 'school_name', v_school.name
    );
  end if;

  -- Email-domain check. Strict: the student's email's domain must
  -- equal the code's allowed_email_domain (case-insensitive).
  if v_ic.allowed_email_domain is not null then
    v_domain := lower(split_part(v_email, '@', 2));
    if v_domain <> lower(v_ic.allowed_email_domain) then
      return jsonb_build_object('ok', false, 'reason', 'email_domain_mismatch',
                                'expected_domain', v_ic.allowed_email_domain,
                                'actual_domain',   v_domain);
    end if;
  end if;

  -- Expiry + max_uses + active.
  if v_ic.expires_at is not null and v_ic.expires_at <= now() then
    return jsonb_build_object('ok', false, 'reason', 'expired');
  end if;
  if v_ic.max_uses is not null and v_ic.uses_count >= v_ic.max_uses then
    return jsonb_build_object('ok', false, 'reason', 'used_up');
  end if;
  select * into v_school from public.schools where id = v_ic.school_id;
  if not found or v_school.active = false then
    return jsonb_build_object('ok', false, 'reason', 'school_inactive');
  end if;

  -- Bump the counter (claim).
  update public.school_invite_codes
     set uses_count = uses_count + 1
   where id = v_ic.id;

  -- Delegate to the existing attach RPC. If it throws, roll back the
  -- counter so the seat isn't burned.
  begin
    perform public.attach_student_to_school(p_user_id, v_school.id);
  exception when others then
    update public.school_invite_codes
       set uses_count = greatest(uses_count - 1, 0)
     where id = v_ic.id;
    return jsonb_build_object('ok', false, 'reason', 'attach_failed',
                              'detail', sqlerrm);
  end;

  return jsonb_build_object(
    'ok',          true,
    'school_id',   v_school.id,
    'school_name', v_school.name
  );
end;
$$;
grant execute on function public.attach_student_to_school_via_invite(text, uuid, text) to authenticated;

-- ---------- 3. BACKFILL STUDENTS WITH A RESOLVABLE CODE --------------------
-- Covers the window between the signup.html deploy (which starts
-- sending intended_school_code) and this SQL run, plus any transient
-- trigger failure. A student whose user_metadata carries a school code
-- that still resolves gets their profile tied to that school. Only
-- touches rows where school_id is currently null, so re-runs are safe.
--
-- NOTE: students who signed up BEFORE the signup.html change have no
-- code in their metadata (the typed code was never persisted), so they
-- cannot be auto-recovered — they need to be attached manually (e.g.
-- by re-entering the code once a signed-in join flow exists, or by the
-- organiser from the school members UI).

do $$
declare
  v_user_id    uuid;
  v_meta       jsonb;
  v_code       text;
  v_school_id  uuid;
  v_ic         public.school_invite_codes%rowtype;
begin
  for v_user_id, v_meta in
    select u.id, u.raw_user_meta_data
      from auth.users u
      join public.profiles p on p.id = u.id
     where p.school_id is null
       and p.role = 'student'
       and trim(coalesce(u.raw_user_meta_data->>'intended_school_code', '')) <> ''
       and coalesce(u.raw_user_meta_data->>'intended_role', 'student') = 'student'
  loop
    v_code := trim(coalesce(v_meta->>'intended_school_code', ''));
    v_school_id := null;

    -- Invite code first (only if still valid — expired/exhausted codes
    -- are NOT claimed retroactively).
    select * into v_ic
      from public.school_invite_codes
     where code = v_code
       and (expires_at is null or expires_at > now())
       and (max_uses is null or uses_count < max_uses)
     limit 1;
    if found then
      update public.school_invite_codes
         set uses_count = uses_count + 1
       where id = v_ic.id;
      v_school_id := v_ic.school_id;
    else
      select id into v_school_id
        from public.schools
       where code = v_code and active = true;
    end if;

    if v_school_id is not null then
      update public.profiles
         set school_id = v_school_id,
             removed_from_school_at = null
       where id = v_user_id and school_id is null;
      raise notice 'backfill_students: attached % to school %', v_user_id, v_school_id;
    else
      raise notice 'backfill_students: no resolvable school for % (code=%)',
        v_user_id, v_code;
    end if;
  end loop;
end;
$$;

-- ---------- 4. ENSURE check_parental_consent STAMPS app_metadata.role ------
-- Defensive re-statement (the organiser/teacher fix files already ship
-- this). Keeps routing working even if only this migration is applied.
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
--   1. A student signing up with a school code (permanent SCH-XXXXXX or a
--      student invite code) gets profiles.school_id stamped at signup
--      time by the trigger — no session required, no silent failure.
--   2. The role stays 'student'; only the school tie is added.
--   3. Invite-code claims happen exactly once (the RPC fallback no
--      longer double-claims).
--   4. Students already in the deploy-window gap are backfilled from
--      their metadata. Pre-deploy unattached students have no stored
--      code and must be attached manually.
--
-- Action required on the client: signup.html's signUp options.data must
-- include intended_role: 'student' and intended_school_code — see the
-- companion edit to signup.html.
-- ============================================================================