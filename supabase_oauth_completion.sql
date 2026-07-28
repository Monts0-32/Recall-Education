-- ============================================================================
-- Recall Education — OAuth profile-completion RPC
-- Run in the Supabase SQL editor. Idempotent: safe to re-run.
--
-- Email/password signups collect year group, DOB and (for under-16s) a
-- parent email BEFORE the account is usable — see signup.html. OAuth
-- signups can't collect any of that at the provider, so the OAuth user
-- lands with year_group = null, dob = null and requires_parental_consent
-- defaulted to false (handle_new_user only derives consent state from a
-- DOB it never received). Without this RPC an under-16 OAuth user would
-- sail straight past the parental-consent gate.
--
-- complete-profile.html is the OAuth redirect target. It shows a small
-- form (full name, year, DOB, parent email if under-16, terms) and calls
-- THIS RPC to write the profile row server-side. The RPC re-derives
-- requires_parental_consent from the DOB so a tampering client can't
-- disable the consent gate by leaving requires_parental_consent = false.
--
-- The RPC only writes public.profiles (which is already client-updatable
-- via the profiles_update_own policy). It is SECURITY DEFINER so the
-- derivation happens in one trusted call and so we can pin the update to
-- auth.uid() regardless of RLS. It does NOT touch parental_consents —
-- that row is created by create_parental_consent(), invoked by the
-- send-consent-email Edge Function exactly as it is for email signups,
-- so the two signup paths stay identical downstream.
-- ============================================================================

create or replace function public.complete_student_profile(
  p_full_name    text,
  p_year_group   text,
  p_dob          date,
  p_parent_email text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  uid          uuid  := auth.uid();
  age_years    int;
  needs_consent boolean := false;
  v_role       text;
  own_email    text;
begin
  if uid is null then
    return jsonb_build_object('ok', false, 'reason', 'not_authenticated');
  end if;

  if p_dob is null then
    return jsonb_build_object('ok', false, 'reason', 'dob_required');
  end if;

  age_years := date_part('year', age(current_date, p_dob))::int;

  -- Mirror signup.html's student age band (11..19). Outside that, refuse —
  -- the completion page validates too, but the RPC is the authoritative
  -- defence so a tampered request can't sneak an out-of-band age through.
  if age_years < 11 or age_years > 19 then
    return jsonb_build_object('ok', false, 'reason', 'age_out_of_range');
  end if;

  if age_years <= 15 then
    needs_consent := true;
    select email into own_email from auth.users where id = uid;
    if p_parent_email is null
       or p_parent_email = ''
       or lower(trim(p_parent_email)) = lower(coalesce(own_email, '')) then
      return jsonb_build_object('ok', false, 'reason', 'parent_email_required');
    end if;
  end if;

  -- Update the caller's own row. SECURITY DEFINER + `where id = uid` means
  -- only the signed-in user can touch their own profile, regardless of RLS.
  update public.profiles
     set full_name                 = coalesce(nullif(trim(p_full_name), ''), public.profiles.full_name),
         year_group                = p_year_group,
         dob                       = p_dob,
         parent_email              = case when needs_consent then p_parent_email else null end,
         requires_parental_consent = needs_consent,
         updated_at                = now()
   where id = uid
   returning role into v_role;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'profile_not_found');
  end if;

  return jsonb_build_object(
    'ok', true,
    'needs_consent', needs_consent,
    'role', v_role
  );
end;
$$;

grant execute on function public.complete_student_profile(text, text, date, text) to authenticated;