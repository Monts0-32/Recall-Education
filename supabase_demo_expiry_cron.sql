-- ============================================================================
-- Recall — demo school auto-expiry (15-minute TTL)
--
-- Demo schools are created by the create-demo-school Edge Function ("Try
-- the demo" on the organiser sign-up page) and identified purely by name
-- pattern: 'Recall Demo School <tag>'. Their lifetime is 15 minutes from
-- schools.created_at — always computed, never stored, so no schema change.
--
-- This job pings the expire-demo-schools Edge Function once a minute; the
-- function deletes every expired demo school (school row — school_id FKs
-- cascade) and its 8 auth users (admin.deleteUser; profiles cascade from
-- auth.users). The same function is also invoked:
--   - by db-config.js's demo banner when a demo user's countdown hits zero
--   - by create-demo-school before its abuse guard, as a self-heal
--
-- The publishable key is public by design (it ships in db-config.js) —
-- the function's own abuse guard is what limits anonymous use.
-- ============================================================================

-- pg_net powers the outbound HTTP call; pg_cron is already installed.
create extension if not exists pg_net with schema extensions;

-- Re-running this file updates the schedule in place.
do $$
begin
  perform cron.unschedule('expire-demo-schools');
exception when others then null; -- job doesn't exist yet
end $$;

select cron.schedule(
  'expire-demo-schools',
  '* * * * *',
  $cron$
  select net.http_post(
    url := 'https://hkjiyibpeqdoqzlyqzwz.supabase.co/functions/v1/expire-demo-schools',
    headers := jsonb_build_object(
      'Authorization', 'Bearer sb_publishable_eCBuj0Ab6w5LPNnfnKkQTA_xd2vVImv',
      'apikey', 'sb_publishable_eCBuj0Ab6w5LPNnfnKkQTA_xd2vVImv',
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  );
  $cron$
);