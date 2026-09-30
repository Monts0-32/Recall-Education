/* global module */
/* ---------------------------------------------------------------------------
 * Recall — Supabase same-origin proxy worker
 *
 * Schools' firewalls commonly block or mangle QUIC/HTTP3 traffic to
 * *.supabase.co (net::ERR_QUIC_PROTOCOL_ERROR in the browser), which kills
 * every API call the site makes. The browser can't be told to downgrade to
 * HTTP/2 from JS, so instead we route all Supabase traffic through this
 * Worker on the site's own origin — a connection that already works behind
 * those firewalls — at the path /db/*.
 *
 *   /db/rest/v1/...    ->  https://<ref>.supabase.co/rest/v1/...
 *   /db/auth/v1/...    ->  .../auth/v1/...
 *   /db/realtime/v1/.. ->  .../realtime/v1/...   (WebSocket upgrade)
 *   /db/storage/v1/.. ->  .../storage/v1/...
 *   /db/functions/v1/ ->  .../functions/v1/...
 *
 * Everything else is served straight from the static assets (wrangler.jsonc
 * routes only /db* to this script via run_worker_first).
 *
 * Behaviour notes:
 *   - redirect: 'manual' — 3xx responses (OAuth /auth/v1/authorize, the
 *     email-link flows) are handed back to the browser untouched instead of
 *     the Worker itself following them to the provider.
 *   - The Request is rebuilt from the original, which preserves method,
 *     headers (including the WebSocket Upgrade handshake) and streams the
 *     body — so storage uploads and realtime sockets pass through as-is.
 *   - apikey injection: some calls carry no apikey at all (historically
 *     navigator.sendBeacon, which can't set headers). When both the header
 *     and the ?apikey= param are absent we inject the header. The key is
 *     the public publishable key — RLS on the DB is the real gate.
 * ------------------------------------------------------------------------- */

// The project the whole site talks to. The anon key next to it is public by
// design (it's embedded in every page's JS already).
const SUPABASE_ORIGIN = 'https://hkjiyibpeqdoqzlyqzwz.supabase.co';
const ANON_KEY = 'sb_publishable_eCBuj0Ab6w5LPNnfnKkQTA_xd2vVImv';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Only /db and /db/* reach the Worker (run_worker_first), but keep the
    // guard so the script stays correct if the routing list ever widens.
    const isDb = url.pathname === '/db' || url.pathname.startsWith('/db/');
    if (!isDb) return env.ASSETS.fetch(request);

    // Strip the '/db' prefix: /db/auth/v1/token -> /auth/v1/token.
    const target = new URL(SUPABASE_ORIGIN);
    target.pathname = url.pathname === '/db' ? '/' : url.pathname.slice(3);
    target.search = url.search;

    // Copying the original request preserves method, headers (incl. the
    // Upgrade handshake for realtime) and streams the body through.
    const upstream = new Request(target.toString(), request);

    // Inject only when the caller supplied no apikey anywhere — never
    // collides with the ?apikey= fallback the pages add themselves.
    if (!upstream.headers.has('apikey') && !target.searchParams.has('apikey')) {
      upstream.headers.set('apikey', ANON_KEY);
    }

    // 'manual' hands 3xx back to the browser; returning the untouched
    // response passes 101/WebSocket and streams response bodies through.
    return fetch(upstream, { redirect: 'manual' });
  },
};