/* Load test: mimics staff-dashboard's boot request pattern through the
 * /db proxy, repeatedly, flagging any request that stalls or fails.
 * Usage: node scripts/proxy-loadtest.mjs [iterations] */
const SITE = 'https://recall-education.brooksmonty87-61d.workers.dev';
const KEY = 'sb_publishable_eCBuj0Ab6w5LPNnfnKkQTA_xd2vVImv';
const BASE = SITE + '/db';
const ITER = parseInt(process.argv[2] || '25', 10);

const H = { apikey: KEY, Accept: 'application/json' };

// The requests staff-dashboard fires on boot (unauthenticated equivalents).
const CALLS = [
  ['mode', () => fetch(`${BASE}/rest/v1/rpc/get_supabase_mode?apikey=${KEY}`, { headers: H })],
  ['c-subjects', () => fetch(`${BASE}/rest/v1/subjects?select=id&limit=1`, { method: 'HEAD', headers: { ...H, Prefer: 'count=exact' } })],
  ['c-units', () => fetch(`${BASE}/rest/v1/units?select=id&limit=1`, { method: 'HEAD', headers: { ...H, Prefer: 'count=exact' } })],
  ['c-topics', () => fetch(`${BASE}/rest/v1/topics?select=id&limit=1`, { method: 'HEAD', headers: { ...H, Prefer: 'count=exact' } })],
  ['c-lessons', () => fetch(`${BASE}/rest/v1/lessons?select=id&limit=1`, { method: 'HEAD', headers: { ...H, Prefer: 'count=exact' } })],
  ['list_staff', () => fetch(`${BASE}/rest/v1/rpc/list_staff`, { method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: '{}' })],
  ['audit', () => fetch(`${BASE}/rest/v1/rpc/list_recent_audit?apikey=${KEY}`, { method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify({ p_limit: 10, p_actor_filter: null, p_action_filter: null }) })],
  // auth token endpoint with a bogus refresh token — the POST path the
  // browser exercises on session refresh (expects a 400, quickly).
  ['auth-post', () => fetch(`${BASE}/auth/v1/token?grant_type=refresh_token`, { method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify({ refresh_token: 'bogus-token-for-path-testing' }) })],
];

async function timed(name, fn) {
  const t0 = Date.now();
  try {
    const r = await fn();
    await r.arrayBuffer().catch(() => {}); // drain
    return { name, ms: Date.now() - t0, status: r.status };
  } catch (e) {
    return { name, ms: Date.now() - t0, status: 'ERR:' + (e.cause ? e.cause.code : e.message) };
  }
}

const slow = [];
const errs = [];
const all = [];
for (let i = 0; i < ITER; i++) {
  const t0 = Date.now();
  const results = await Promise.all(CALLS.map(([n, f]) => timed(n, f)));
  const batchMs = Date.now() - t0;
  all.push(batchMs);
  for (const r of results) {
    if (r.ms > 1500) { slow.push(`iter ${i} ${r.name}: ${r.ms}ms (status ${r.status})`); }
    if (typeof r.status === 'string') { errs.push(`iter ${i} ${r.name}: ${r.status} after ${r.ms}ms`); }
  }
  if (batchMs > 2000) console.log(`iter ${i}: batch took ${batchMs}ms`);
  await new Promise(res => setTimeout(res, 400)); // small gap like a user reading
}
console.log(`\n${ITER} iterations. batch ms: min=${Math.min(...all)} max=${Math.max(...all)} avg=${Math.round(all.reduce((a, b) => a + b) / all.length)}`);
console.log(`slow (>1.5s): ${slow.length}`, slow);
console.log(`errors: ${errs.length}`, errs);