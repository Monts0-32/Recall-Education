-- ============================================================================
-- Recall Education — Skip email confirmation for staff invitees
-- Run AFTER supabase_setup.sql, supabase_staff.sql, and any file that creates
-- the public.staff_invites table (the staff-invite RPCs). Idempotent: safe
-- to re-run.
--
-- Why this exists
-- ---------------
-- When a staff member is invited, they receive a Resend email that contains
-- a "join the team" link to /accept-invite.html. THAT link is the proof
-- they own the email address — clicking it ties the invite token to the
-- account being created. Forcing them to also click a separate Supabase
-- "Confirm your signup" email is redundant friction: by the time they're
-- on /signup-staff.html creating their account, the invite email has
-- already validated the address.
--
-- Before this RPC, the flow was:
--   1. Staff clicks invite link → accept-invite.html
--   2. They click "Create an account" → signup-staff.html
--   3. They submit the form → Supabase creates the user with
--      email_confirmed_at = null
--   4. They get a Supabase "Confirm signup" email AND a Resend welcome
--      email. They have to click one of them to actually use the account.
--   5. After clicking, they land on /auth/confirmed.html which calls
--      accept_staff_invite to apply the role.
--
-- This RPC lets step 3 confirm the email server-side, atomically with
-- the role acceptance, so step 4's Supabase email never gets sent and
-- step 5 runs without waiting for an out-of-band click.
--
-- The gate
-- --------
-- The RPC only confirms the caller's own email if the caller is in the
-- middle of accepting a staff invite for THAT email address. This
-- prevents the RPC from being used to bypass confirmation in any other
-- flow. Concretely:
--   1. auth.uid() must be non-null (caller is signed in — for an invite
--      accepted post-signUp, the staff invite acceptance is done on
--      /auth/confirmed.html which refreshes the session first).
--   2. The caller's email must match an existing, valid, unaccepted
--      staff_invites row (i.e. one whose token has not been used).
--   3. The invite must not be expired.
--
-- We do NOT require the invite to be "ready to accept" — the role
-- itself is granted by accept_staff_invite(), called separately on
-- /auth/confirmed.html. This RPC just confirms the email.
--
-- Security
-- --------
-- SECURITY DEFINER + auth.uid() means only the signed-in caller can
-- confirm their own email. The invite lookup is by email so a caller
-- can only confirm if a matching staff invite exists for the email
-- they used at signUp.
-- ============================================================================

create or replace function public.confirm_staff_invite_email()
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_uid    uuid := auth.uid();
  v_email  text;
  v_invite record;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'reason', 'not_authenticated');
  end if;

  -- Resolve the caller's email from auth.users (we can't trust the
  -- JWT's email claim alone — the RPC is the authoritative source).
  select email into v_email from auth.users where id = v_uid;
  if v_email is null then
    return jsonb_build_object('ok', false, 'reason', 'no_email');
  end if;

  -- Is there a live, unaccepted, unexpired staff invite for this
  -- address? If so, the invite email has already validated the
  -- address; the Supabase confirmation round-trip is redundant.
  select id, expires_at, accepted_at
    into v_invite
    from public.staff_invites
   where lower(email) = lower(v_email)
     and accepted_at is null
   limit 1;

  if not found then
    -- No live invite for this email — refuse. The caller should
    -- continue with the normal Supabase confirmation flow.
    return jsonb_build_object('ok', false, 'reason', 'no_live_invite');
  end if;

  if v_invite.expires_at is not null and v_invite.expires_at <= now() then
    return jsonb_build_object('ok', false, 'reason', 'invite_expired');
  end if;

  -- Mark the email as confirmed. Idempotent: if the user already
  -- confirmed (e.g. by clicking the Supabase email), this is a
  -- no-op write.
  update auth.users
     set email_confirmed_at = coalesce(email_confirmed_at, now()),
         updated_at = now()
   where id = v_uid
     and email_confirmed_at is null;

  return jsonb_build_object('ok', true, 'email_confirmed', true);
end;
$$;

grant execute on function public.confirm_staff_invite_email() to authenticated;

-- ============================================================================
-- TRIGGER: confirm staff-invited users at auth.users INSERT time
-- ============================================================================
--
-- Why this trigger exists (separate from the RPC above):
--   `supabase.auth.signUp()` queues Supabase's built-in "Confirm your
--   signup" email the moment the row is created with
--   email_confirmed_at IS NULL. The branded Resend email from
--   send-signup-email is sent a beat later by the client. Without
--   intervention the user gets BOTH emails.
--
--   The confirm_staff_invite_email() RPC above runs only after the
--   user has a session (via the post-confirm page), which is too late
--   — Supabase's worker has already queued the email.
--
-- Implementation notes:
--   * AFTER INSERT, not BEFORE INSERT. BEFORE-INSERT triggers on
--     auth.users are a Supabase anti-pattern: the GoTrue server has
--     internal logic that runs in parallel and rejects / overwrites
--     NEW-row mutations made by user triggers, which surfaces to the
--     client as a 500 "Database error saving new user". Observed in
--     the wild Aug 2026 when this exact file first shipped with a
--     BEFORE INSERT trigger — every signup broke. AFTER INSERT just
--     observes NEW and modifies the row via a SECURITY DEFINER UPDATE,
--     which is safe.
--   * Wrapped in EXCEPTION WHEN OTHERS. If the lookup-or-update
--     fails for ANY reason (a future migration drops staff_invites,
--     auth.users gets renamed, RLS on staff_invites blocks the
--     SECURITY DEFINER read, etc.), signup still completes. Worst
--     case: the user gets the duplicate Supabase email they would
--     have gotten anyway. Signup is never blocked by this trigger.
--   * The UPDATE runs inside the same transaction as the INSERT, so
--     by the time Supabase's email worker observes the row (which
--     happens via NOTIFY at commit time), email_confirmed_at is
--     already set and the auto-confirmation email is skipped.
-- ============================================================================

create or replace function public._confirm_staff_invite_on_signup()
returns trigger
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_invite_count int;
begin
  -- Already confirmed by some other path — leave it alone.
  if new.email_confirmed_at is not null then
    return new;
  end if;

  begin
    select count(*) into v_invite_count
      from public.staff_invites
     where lower(email) = lower(new.email)
       and status = 'pending'
       and accepted_at is null
       and (expires_at is null or expires_at > now());

    if v_invite_count > 0 then
      update auth.users
         set email_confirmed_at = now(),
             updated_at = now()
       where id = new.id
         and email_confirmed_at is null;
    end if;
  exception when others then
    -- Never block signup on this. Worst case the staff invitee
    -- gets both emails (the original behaviour pre-this-trigger).
    raise warning 'confirm_staff_invite_on_signup skipped for user % (%): %',
      new.id, new.email, sqlerrm;
  end;

  return new;
end;
$$;

drop trigger if exists confirm_staff_invite_on_signup on auth.users;
create trigger confirm_staff_invite_on_signup
  after insert on auth.users
  for each row execute function public._confirm_staff_invite_on_signup();
