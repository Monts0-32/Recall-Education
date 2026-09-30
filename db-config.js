/* global window, location, localStorage, sessionStorage, document, fetch */
/* ---------------------------------------------------------------------------
 * Recall — shared Supabase connection config
 *
 * Single source of truth for how pages build their Supabase client, so
 * every page routes through the same path. Two modes, switchable from
 * admin.html (site-wide, stored in the DB):
 *
 *   proxy  (default) — all Supabase traffic goes through our own origin at
 *                      /db/* (the Cloudflare Worker proxy). Works behind
 *                      school firewalls that break QUIC/HTTP3 to
 *                      *.supabase.co.
 *   direct           — straight to https://<ref>.supabase.co.
 *
 * Usage (every page, right after the supabase UMD <script>):
 *   <script src="db-config.js"></script>
 *   const SUPABASE_URL = (window.recallDbConfig && window.recallDbConfig.url())
 *     || 'https://hkjiyibpeqdoqzlyqzwz.supabase.co';
 *   const client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY,
 *     (window.recallDbConfig && window.recallDbConfig.options()) || {...});
 *
 * The mode is resolved synchronously from a localStorage cache so client
 * creation is never delayed; a background check (throttled to once a
 * minute) re-reads the server-side setting through the proxy — the one
 * path that works everywhere — and reloads the page once if the admin
 * flipped the switch. Pages opened from file:// always go direct.
 *
 * CRITICAL: supabase-js derives its session-storage key from the client
 * URL's hostname. The key is pinned here to the old direct-mode key
 * (sb-<ref>-auth-token) so switching to /db doesn't silently log out
 * every signed-in user.
 * ------------------------------------------------------------------------- */

(function () {
  'use strict';

  var DIRECT_URL = 'https://hkjiyibpeqdoqzlyqzwz.supabase.co';
  var ANON_KEY = 'sb_publishable_eCBuj0Ab6w5LPNnfnKkQTA_xd2vVImv';
  // Pinned so proxy-mode clients keep reading the sessions stored by
  // direct-mode clients (and vice versa). Never derive from the URL.
  var AUTH_STORAGE_KEY = 'sb-hkjiyibpeqdoqzlyqzwz-auth-token';
  // Matches the recall.* localStorage convention (recall.keepSignedIn).
  var MODE_KEY = 'recall.dbMode';
  var CHECK_KEY = 'recall.dbModeChecked';
  var CHECK_THROTTLE_MS = 60000;

  // Pages opened from file:// have no Worker to proxy through — go direct.
  var isFile = location.protocol === 'file:';

  function cachedMode() {
    try {
      var m = localStorage.getItem(MODE_KEY);
      return m === 'direct' ? 'direct' : 'proxy';
    } catch (_) { return 'proxy'; }
  }

  // The base URL for createClient. Always absolute — supabase-js derives
  // the realtime WebSocket URL from it (https->wss).
  function url() {
    if (isFile || cachedMode() === 'direct') return DIRECT_URL;
    return location.origin + '/db';
  }

  // The fetch wrapper every page used to duplicate: appends ?apikey= as a
  // fallback because privacy-focused browsers/extensions (Brave Shields,
  // uBlock in strict mode, some corporate firewalls) strip non-safelisted
  // headers. Now also covers same-origin /db requests. The key is public
  // by design.
  function wrappedFetch(urlOrReq, options) {
    try {
      var u = new URL(typeof urlOrReq === 'string' ? urlOrReq : urlOrReq.url,
        window.location.href);
      var hostMatch = u.host.endsWith('.supabase.co');
      var pathMatch = !isFile && u.origin === location.origin
        && u.pathname.split('/')[1] === 'db';
      if ((hostMatch || pathMatch) && !u.searchParams.has('apikey')) {
        u.searchParams.set('apikey', ANON_KEY);
      }
      return fetch(typeof urlOrReq === 'string' ? u.toString() : new Request(u.toString(), urlOrReq), options);
    } catch (_) {
      return fetch(urlOrReq, options);
    }
  }

  // Client options shared by every page. `extra` merges page-specific
  // top-level options (and nested auth options) over the pinned base, so
  // existing per-page flags keep working verbatim.
  function options(extra) {
    var base = {
      auth: { storageKey: AUTH_STORAGE_KEY },
      global: { fetch: wrappedFetch }
    };
    if (extra) {
      for (var k in extra) {
        if (k === 'auth' && extra.auth && typeof extra.auth === 'object') {
          for (var a in extra.auth) base.auth[a] = extra.auth[a];
        } else {
          base[k] = extra[k];
        }
      }
    }
    return base;
  }

  // ---------- background mode check -------------------------------------

  // Applies the server-reported mode. Returns true if the mode changed and
  // the page needs a reload.
  function applyMode(mode) {
    if (mode !== 'proxy' && mode !== 'direct') return false;
    if (mode === cachedMode()) return false;
    try {
      localStorage.setItem(MODE_KEY, mode);
    } catch (_) {
      // Storage unavailable (private mode etc.) — don't reload into a
      // state we can't remember, or we'd loop.
      return false;
    }
    // Don't yank the page out from under someone mid-typing; the change
    // is picked up on their next navigation.
    var el = document.activeElement;
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT')) {
      return false;
    }
    location.reload();
    return true;
  }

  function probe(u) {
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var t = ctrl ? setTimeout(function () { ctrl.abort(); }, 5000) : null;
    return fetch(u + '/rest/v1/rpc/get_supabase_mode?apikey=' + ANON_KEY, {
      headers: { Accept: 'application/json' },
      signal: ctrl ? ctrl.signal : undefined
    }).then(function (r) {
      if (!r.ok) throw new Error('status ' + r.status);
      return r.text();
    }).then(function (body) {
      if (t) clearTimeout(t);
      var v = body ? JSON.parse(body) : null;
      if (v === 'proxy' || v === 'direct') return v;
      throw new Error('unexpected: ' + body);
    }, function (e) {
      if (t) clearTimeout(t);
      throw e;
    });
  }

  // Runs after client creation (scheduled at DOMContentLoaded) — never
  // blocks page boot. Throttled to once a minute via sessionStorage.
  function checkMode() {
    if (isFile) return;
    try {
      var last = parseInt(sessionStorage.getItem(CHECK_KEY) || '0', 10);
      if (Date.now() - last < CHECK_THROTTLE_MS) return;
      sessionStorage.setItem(CHECK_KEY, String(Date.now()));
    } catch (_) { /* sessionStorage unavailable — proceed unthrottled */ }

    // Probe A — same-origin through the proxy, works everywhere.
    probe(location.origin + '/db')
      .then(function (serverMode) { applyMode(serverMode); })
      .catch(function () {
        // Probe A failed. If direct works, the proxy path itself is
        // broken (Worker not deployed / plain static server) — force
        // direct so the page self-heals; it'll flip back once the
        // Worker answers again. If direct fails too (the school
        // firewall case), leave everything as-is.
        probe(DIRECT_URL).then(function () { applyMode('direct'); }).catch(function () { /* nothing reachable — keep current mode */ });
      });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(checkMode, 0); });
  } else {
    setTimeout(checkMode, 0);
  }

  window.recallDbConfig = {
    url: url,
    options: options,
    mode: cachedMode,
    checkMode: checkMode,
    DIRECT_URL: DIRECT_URL,
    ANON_KEY: ANON_KEY,
    AUTH_STORAGE_KEY: AUTH_STORAGE_KEY
  };
})();