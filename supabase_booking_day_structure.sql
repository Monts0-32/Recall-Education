-- ============================================================================
-- Recall Education — School day structure + period-based resource booking
--
-- Run AFTER supabase_school_systems.sql, supabase_school_settings.sql,
-- supabase_school_roles.sql and supabase_student_access.sql (and every
-- other supabase_*.sql migration). Idempotent: safe to re-run.
--
-- What this does:
--   * Adds a configurable day structure to public.school_settings:
--       periods_per_day, day_start_time, day_end_time,
--       period_length_minutes, booking_max_periods, booking_advance_days.
--     Period p occupies [day_start + (p-1)*length, day_start + p*length);
--     day_end_time is informational (client-side warning only).
--   * get_school_day_structure(uuid) — the day structure readable by any
--     ACTIVE member of the school (staff AND students — the timetable and
--     booking grids need it, and get_school_settings denies students).
--   * get_school_settings(uuid) — restated to include the new fields.
--   * update_school_settings — grown signature, every param optional
--     (null = leave unchanged), so each settings card saves only its own
--     fields. Supersedes the (uuid, int) version.
--   * book_resource — REDEFINED to be period-based: staff book a period
--     RANGE (p_start_period..p_end_period); start/end times are derived
--     from the day structure and stored exactly as before (so existing
--     bookings and every other RPC keep working unchanged). New rules:
--     bookings can't be made in the past, can't be made beyond
--     booking_advance_days (0 = no limit), and can't span more than
--     booking_max_periods (0 = no limit).
--
-- Every function is dropped (full signature) before its create-or-replace
-- so the file stays re-runnable even after signature changes.
-- ============================================================================

-- ---------- 0. COLUMNS -------------------------------------------------------

alter table public.school_settings
  add column if not exists periods_per_day int not null default 8;
alter table public.school_settings
  add column if not exists day_start_time time not null default '08:30';
alter table public.school_settings
  add column if not exists day_end_time time not null default '15:30';
alter table public.school_settings
  add column if not exists period_length_minutes int not null default 50;
alter table public.school_settings
  add column if not exists booking_max_periods int not null default 0;
alter table public.school_settings
  add column if not exists booking_advance_days int not null default 0;

-- ---------- 1. GET_SCHOOL_DAY_STRUCTURE --------------------------------------
-- The day structure for the grids (booking, timetables). Readable by any
-- ACTIVE member of the school — teachers, organisers AND students
-- (get_school_settings is staff-only, but the timetable grids students
-- see must reflect the configured period count too). Fails open to the
-- defaults below when the school has no settings row yet.

drop function if exists public.get_school_day_structure(uuid);

create or replace function public.get_school_day_structure(
  p_school_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_row public.school_settings%rowtype;
begin
  if auth.uid() is null then
    return jsonb_build_object('ok', false, 'reason', 'not_authenticated');
  end if;
  if not exists (
    select 1 from public.profiles me
     where me.id = auth.uid()
       and me.school_id = p_school_id
       and me.role in ('teacher','school_organiser','student')
       and me.removed_from_school_at is null
       and me.deleted_at is null
  ) then
    return jsonb_build_object('ok', false, 'reason', 'forbidden');
  end if;
  select * into v_row from public.school_settings where school_id = p_school_id;
  return jsonb_build_object(
    'ok', true,
    'periods_per_day',       coalesce(v_row.periods_per_day, 8),
    'day_start_time',        coalesce(v_row.day_start_time, '08:30'::time),
    'day_end_time',          coalesce(v_row.day_end_time, '15:30'::time),
    'period_length_minutes', coalesce(v_row.period_length_minutes, 50),
    'booking_max_periods',   coalesce(v_row.booking_max_periods, 0),
    'booking_advance_days',  coalesce(v_row.booking_advance_days, 0)
  );
end;
$$;

grant execute on function public.get_school_day_structure(uuid) to authenticated;

-- ---------- 2. GET_SCHOOL_SETTINGS (restated) --------------------------------
-- Same function as supabase_school_roles.sql, extended with the day
-- structure fields so staff pages get everything in the one call they
-- already make.

drop function if exists public.get_school_settings(uuid);

create or replace function public.get_school_settings(
  p_school_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_row public.school_settings%rowtype;
begin
  if auth.uid() is null then
    return jsonb_build_object('ok', false, 'reason', 'not_authenticated');
  end if;
  if not exists (
    select 1 from public.profiles
     where id = auth.uid()
       and school_id = p_school_id
       and role in ('teacher','school_organiser')
  ) then
    return jsonb_build_object('ok', false, 'reason', 'forbidden');
  end if;
  select * into v_row from public.school_settings where school_id = p_school_id;
  return jsonb_build_object(
    'ok', true,
    'is_organiser', exists (
      select 1 from public.schools
       where id = p_school_id and owner_user_id = auth.uid()
    ),
    'perms', jsonb_build_object(
      'create_classes', public._school_teacher_perm(p_school_id, 'create_classes'),
      'register',       public._school_teacher_perm(p_school_id, 'register'),
      'absences',       public._school_teacher_perm(p_school_id, 'absences'),
      'behaviour',      public._school_teacher_perm(p_school_id, 'behaviour'),
      'praise',         public._school_teacher_perm(p_school_id, 'praise'),
      'announcements',  public._school_teacher_perm(p_school_id, 'announcements'),
      'booking',        public._school_teacher_perm(p_school_id, 'booking'),
      'resources',      public._school_teacher_perm(p_school_id, 'resources'),
      'clubs',          public._school_teacher_perm(p_school_id, 'clubs'),
      'timetable',      public._school_teacher_perm(p_school_id, 'timetable'),
      'analytics',      public._school_teacher_perm(p_school_id, 'analytics'),
      -- Legacy composite keys, kept so older pages keep working.
      'register_absences', public._school_teacher_perm(p_school_id, 'register_absences'),
      'behaviour_praise',  public._school_teacher_perm(p_school_id, 'behaviour_praise'),
      'ops_announcements', public._school_teacher_perm(p_school_id, 'ops_announcements')
    ),
    'register_late_minutes', coalesce(v_row.register_late_minutes, 20),
    'periods_per_day',       coalesce(v_row.periods_per_day, 8),
    'day_start_time',        coalesce(v_row.day_start_time, '08:30'::time),
    'day_end_time',          coalesce(v_row.day_end_time, '15:30'::time),
    'period_length_minutes', coalesce(v_row.period_length_minutes, 50),
    'booking_max_periods',   coalesce(v_row.booking_max_periods, 0),
    'booking_advance_days',  coalesce(v_row.booking_advance_days, 0),
    'updated_at', v_row.updated_at
  );
end;
$$;

grant execute on function public.get_school_settings(uuid) to authenticated;

-- ---------- 3. UPDATE_SCHOOL_SETTINGS (grown signature) ----------------------
-- SUPERSEDES the (uuid, int) version. Every parameter is optional:
-- null = leave that setting unchanged. Organiser-only. day_end must be
-- after day_start (checked against the EFFECTIVE values, so saving only
-- one of the two still validates); periods x length running past day_end
-- is NOT an error (breaks/lunch aren't modelled) — the settings page shows
-- a soft warning for that.

drop function if exists public.update_school_settings(uuid, int);
drop function if exists public.update_school_settings(uuid, jsonb);

create or replace function public.update_school_settings(
  p_school_id             uuid,
  p_late_minutes          int  default null,
  p_periods_per_day       int  default null,
  p_day_start_time        time default null,
  p_day_end_time          time default null,
  p_period_length_minutes int  default null,
  p_booking_max_periods   int  default null,
  p_booking_advance_days  int  default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row       public.school_settings%rowtype;
  v_day_start time;
  v_day_end   time;
begin
  perform public._assert_school_organiser(p_school_id);
  select * into v_row from public.school_settings where school_id = p_school_id;

  -- Validate only what was provided; null = leave unchanged.
  if p_late_minutes is not null and (p_late_minutes < 0 or p_late_minutes > 240) then
    return jsonb_build_object('ok', false, 'reason', 'invalid_late_minutes');
  end if;
  if p_periods_per_day is not null and (p_periods_per_day < 1 or p_periods_per_day > 12) then
    return jsonb_build_object('ok', false, 'reason', 'invalid_periods_per_day');
  end if;
  if p_period_length_minutes is not null
     and (p_period_length_minutes < 10 or p_period_length_minutes > 240) then
    return jsonb_build_object('ok', false, 'reason', 'invalid_period_length');
  end if;
  if p_booking_max_periods is not null and (p_booking_max_periods < 0 or p_booking_max_periods > 12) then
    return jsonb_build_object('ok', false, 'reason', 'invalid_booking_max_periods');
  end if;
  if p_booking_advance_days is not null and (p_booking_advance_days < 0 or p_booking_advance_days > 365) then
    return jsonb_build_object('ok', false, 'reason', 'invalid_booking_advance_days');
  end if;
  v_day_start := coalesce(p_day_start_time, v_row.day_start_time, '08:30'::time);
  v_day_end   := coalesce(p_day_end_time,   v_row.day_end_time,   '15:30'::time);
  if v_day_end <= v_day_start then
    return jsonb_build_object('ok', false, 'reason', 'invalid_day_times');
  end if;

  insert into public.school_settings as ss (
    school_id, register_late_minutes, periods_per_day, day_start_time,
    day_end_time, period_length_minutes, booking_max_periods,
    booking_advance_days, updated_at, updated_by
  ) values (
    p_school_id,
    coalesce(p_late_minutes, 20),
    coalesce(p_periods_per_day, 8),
    coalesce(p_day_start_time, '08:30'::time),
    coalesce(p_day_end_time, '15:30'::time),
    coalesce(p_period_length_minutes, 50),
    coalesce(p_booking_max_periods, 0),
    coalesce(p_booking_advance_days, 0),
    now(), auth.uid()
  )
  on conflict (school_id) do update
    set register_late_minutes   = coalesce(p_late_minutes, ss.register_late_minutes),
        periods_per_day         = coalesce(p_periods_per_day, ss.periods_per_day),
        day_start_time          = coalesce(p_day_start_time, ss.day_start_time),
        day_end_time            = coalesce(p_day_end_time, ss.day_end_time),
        period_length_minutes   = coalesce(p_period_length_minutes, ss.period_length_minutes),
        booking_max_periods     = coalesce(p_booking_max_periods, ss.booking_max_periods),
        booking_advance_days    = coalesce(p_booking_advance_days, ss.booking_advance_days),
        updated_at              = excluded.updated_at,
        updated_by              = excluded.updated_by;

  return jsonb_build_object(
    'ok', true,
    'register_late_minutes', coalesce(p_late_minutes, v_row.register_late_minutes, 20)
  );
end;
$$;

grant execute on function public.update_school_settings(uuid, int, int, time, time, int, int, int) to authenticated;

-- ---------- 4. BOOK_RESOURCE (redefined, period-based) ------------------------
-- Staff now book a period RANGE; the times are derived from the school's
-- day structure (period p occupies [day_start + (p-1)*len, day_start +
-- p*len)) and stored exactly as before, so existing bookings and every
-- other booking RPC keep working unchanged. New rules:
--   * p_start_period..p_end_period must fit within periods_per_day,
--   * a booking can't span more than booking_max_periods (0 = no limit),
--   * bookings can't be in the past, and can't be made more than
--     booking_advance_days ahead (0 = no limit).
-- Supersedes the time-based (uuid, uuid, date, time, time, text) version.

drop function if exists public.book_resource(uuid, uuid, date, time, time, text);

create or replace function public.book_resource(
  p_school_id    uuid,
  p_resource_id  uuid,
  p_date         date,
  p_start_period int,
  p_end_period   int,
  p_purpose      text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row        public.school_settings%rowtype;
  v_id         uuid;
  v_periods    int;
  v_len        int;
  v_day_start  time;
  v_max        int;
  v_adv        int;
  v_start_time time;
  v_end_time   time;
begin
  if auth.uid() is null then
    return jsonb_build_object('ok', false, 'reason', 'not_authenticated');
  end if;
  perform public._assert_school_staff_with_perm(p_school_id, 'booking');

  if not exists (
    select 1 from public.resources
     where id = p_resource_id and school_id = p_school_id
  ) then
    return jsonb_build_object('ok', false, 'reason', 'unknown_resource');
  end if;
  if p_date is null then
    return jsonb_build_object('ok', false, 'reason', 'date_required');
  end if;

  -- Day structure (fail-open to defaults when no settings row exists).
  select * into v_row from public.school_settings where school_id = p_school_id;
  v_periods   := coalesce(v_row.periods_per_day, 8);
  v_len       := coalesce(v_row.period_length_minutes, 50);
  v_day_start := coalesce(v_row.day_start_time, '08:30'::time);
  v_max       := coalesce(v_row.booking_max_periods, 0);
  v_adv       := coalesce(v_row.booking_advance_days, 0);

  if p_start_period is null or p_end_period is null
     or p_start_period < 1 or p_end_period < p_start_period
     or p_end_period > v_periods then
    return jsonb_build_object('ok', false, 'reason', 'invalid_periods');
  end if;
  if v_max > 0 and (p_end_period - p_start_period + 1) > v_max then
    return jsonb_build_object('ok', false, 'reason', 'too_many_periods');
  end if;
  if p_date < current_date then
    return jsonb_build_object('ok', false, 'reason', 'date_in_past');
  end if;
  if v_adv > 0 and p_date > (current_date + v_adv) then
    return jsonb_build_object('ok', false, 'reason', 'date_too_far');
  end if;

  -- Derive the stored times from the period range.
  v_start_time := v_day_start + make_interval(mins => (p_start_period - 1) * v_len);
  v_end_time   := v_day_start + make_interval(mins => p_end_period * v_len);

  -- Overlap check, unchanged semantics on the derived times.
  if exists (
    select 1 from public.resource_bookings b
     where b.resource_id = p_resource_id
       and b.booking_date = p_date
       and b.start_time < v_end_time
       and b.end_time > v_start_time
  ) then
    return jsonb_build_object('ok', false, 'reason', 'slot_taken');
  end if;

  insert into public.resource_bookings (
    school_id, resource_id, booking_date, start_time, end_time, purpose, booked_by
  ) values (
    p_school_id, p_resource_id, p_date, v_start_time, v_end_time,
    nullif(trim(coalesce(p_purpose, '')), ''),
    auth.uid()
  )
  returning id into v_id;

  return jsonb_build_object('ok', true, 'booking_id', v_id,
    'start_time', v_start_time, 'end_time', v_end_time);
end;
$$;

grant execute on function public.book_resource(uuid, uuid, date, int, int, text) to authenticated;

-- ============================================================================
-- DONE. After running this migration:
--   * get_school_day_structure / get_school_settings expose the day
--     structure (defaults: 8 periods, 08:30 start, 15:30 end, 50-minute
--     periods, no booking limits).
--   * update_school_settings accepts any subset of the settings — each
--     card on school-settings.html saves only its own fields.
--   * book_resource takes p_start_period/p_end_period and enforces the
--     booking rules; list/cancel/resource RPCs are unchanged.
-- ============================================================================