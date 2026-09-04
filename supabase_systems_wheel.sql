-- ============================================================================
-- Recall Education — School systems wheel (dashboard layout allowlist)
--
-- Run AFTER supabase_school_organisers.sql (and every other supabase_*.sql
-- migration). Idempotent: safe to re-run.
--
-- What this does:
--   The school organiser dashboard publishes the layout of EVERY card with
--   a data-card-id (publishLayout reads them all generically), but
--   upsert_school_dashboard_layout rejected any id outside v_allowed and
--   returned {ok:false, reason:'unknown_card'} — while the client only
--   checks `error`, so publishing silently failed whenever the DOM
--   contained an unlisted card. Two such cards exist now:
--     * 'school-team'   — already on the organiser dashboard (publishing
--                         is silently broken today because of it), and
--     * 'systems-wheel' — the new "School systems" app-wheel card.
--
--   This migration restates the function with both ids added to the
--   allowlist. Nothing else changes (same gating via _assert_school_organiser,
--   same upsert semantics).
--
-- Run order: all prior supabase_*.sql files, then this one.
-- ============================================================================

drop function if exists public.upsert_school_dashboard_layout(uuid, jsonb);

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
  v_allowed text[] := array['kpis','quick-actions','systems-wheel','school','roster','classes','homework','school-team'];
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
-- DONE. After running this migration:
--   * Publishing an organiser dashboard layout that includes the
--     'systems-wheel' card (the new School systems wheel) succeeds.
--   * The pre-existing 'school-team' card no longer breaks publishing.
--   * Card ids are still allowlisted — anything else keeps returning
--     {ok:false, reason:'unknown_card'}.
-- ============================================================================