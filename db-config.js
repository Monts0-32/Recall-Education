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

  // ---------- demo school expiry ----------------------------------------
  //
  // Demo schools ("Try the demo" on the sign-up page) self-delete 15
  // minutes after creation — the expire-demo-schools Edge Function is
  // invoked by a pg_cron job every minute, and by this script when a
  // countdown reaches zero. While a signed-in user belongs to one, a
  // slim countdown banner warns on every page; once it expires their
  // accounts are gone, so a full-screen notice takes over and offers
  // the sign-up page instead. Everything here is fire-and-forget: no
  // part of it may block page boot.
  var DEMO_CACHE_KEY = 'recall.demoExpiry';

  function demoCacheRead() {
    try { return JSON.parse(sessionStorage.getItem(DEMO_CACHE_KEY) || 'null'); }
    catch (_) { return null; }
  }
  function demoCacheWrite(v) {
    try { sessionStorage.setItem(DEMO_CACHE_KEY, JSON.stringify(v)); } catch (_) {}
  }

  function findDemoClient(attempts) {
    if (attempts > 80) return; // ~25s — pages that never build a client stop here
    var sb = null;
    try { if (window.supabaseClient && window.supabaseClient.functions) sb = window.supabaseClient; } catch (_) {}
    if (!sb) {
      try { if (typeof supabaseClient !== 'undefined' && supabaseClient && supabaseClient.functions) sb = supabaseClient; } catch (_) {}
    }
    if (!sb || !sb.auth || typeof sb.auth.getSession !== 'function') {
      setTimeout(function () { findDemoClient(attempts + 1); }, 300);
      return;
    }
    sb.auth.getSession().then(function (res) {
      var session = res && res.data && res.data.session;
      if (!session) return; // signed out — nothing to warn about
      demoCheck(sb);
    }).catch(function () { /* never block the page */ });
  }

  function demoCheck(sb) {
    var cached = demoCacheRead();
    if (cached && cached.demo && cached.expires_at) {
      if (new Date(cached.expires_at).getTime() > Date.now()) {
        demoBanner(cached);
      } else {
        demoEnded(sb, cached);
      }
      return;
    }
    // Recently established "not in a demo school" — skip for 10 minutes.
    if (cached && !cached.demo && Date.now() - (cached.checked_at || 0) < 600000) return;
    sb.functions.invoke('expire-demo-schools', { body: {} }).then(function (r) {
      var data = r && r.data;
      if (!data || !data.ok) return;
      if (data.demo && data.demo.expires_at) {
        var entry = { demo: true, expires_at: data.demo.expires_at };
        demoCacheWrite(entry);
        demoBanner(entry);
      } else {
        demoCacheWrite({ demo: false, checked_at: Date.now() });
      }
    }).catch(function () { /* banner is best-effort */ });
  }

  function demoBannerStyle() {
    if (document.getElementById('recallDemoStyle')) return;
    var st = document.createElement('style');
    st.id = 'recallDemoStyle';
    st.textContent = ''
      + '#recallDemoBanner{position:fixed;top:0;left:0;right:0;z-index:2147483000;'
      + 'display:flex;align-items:center;justify-content:center;gap:10px;'
      + 'background:#1f1300;color:#ffd866;font:600 13px/1.4 system-ui,sans-serif;'
      + 'padding:7px 16px;box-shadow:0 2px 10px rgba(0,0,0,.35);text-align:center;}'
      + '#recallDemoBanner .clock{font-variant-numeric:tabular-nums;background:rgba(255,216,102,.15);'
      + 'border:1px solid rgba(255,216,102,.4);border-radius:6px;padding:1px 8px;}'
      + '#recallDemoEnd{position:fixed;inset:0;z-index:2147483100;background:#0d1117f2;'
      + 'display:flex;align-items:center;justify-content:center;color:#e6edf3;'
      + 'font-family:system-ui,sans-serif;padding:24px;}'
      + '#recallDemoEnd .box{max-width:420px;text-align:center;}'
      + '#recallDemoEnd h2{margin:0 0 12px;font-size:20px;}'
      + '#recallDemoEnd p{margin:0 0 20px;font-size:14px;line-height:1.6;color:#9aa4b2;}'
      + '#recallDemoEnd a{display:inline-block;margin:0 6px;padding:10px 18px;border-radius:8px;'
      + 'font-size:14px;font-weight:600;text-decoration:none;}'
      + '#recallDemoEnd .primary{background:#2563eb;color:#fff;}'
      + '#recallDemoEnd .ghost{border:1px solid #30363d;color:#e6edf3;}';
    document.head.appendChild(st);
  }

  function demoBanner(entry) {
    if (document.getElementById('recallDemoBanner')) return;
    demoBannerStyle();
    var bar = document.createElement('div');
    bar.id = 'recallDemoBanner';
    bar.setAttribute('role', 'status');

    var label = document.createElement('span');
    label.textContent = 'Demo school — everything here is throwaway';
    var clock = document.createElement('span');
    clock.className = 'clock';
    bar.appendChild(label);
    bar.appendChild(clock);
    document.body.appendChild(bar);

    function tick() {
      var left = new Date(entry.expires_at).getTime() - Date.now();
      if (left <= 0) {
        bar.remove();
        demoEnded(null, entry);
        return;
      }
      var m = Math.floor(left / 60000);
      var s = Math.floor((left % 60000) / 1000);
      clock.textContent = 'self-deletes in ' + m + ':' + (s < 10 ? '0' : '') + s;
      setTimeout(tick, 1000);
    }
    tick();
  }

  // The banner's timer outlives references to the client — rediscover it.
  var demoSb = null;
  function findDemoClientCached() {
    if (!demoSb) {
      try { if (window.supabaseClient && window.supabaseClient.functions) demoSb = window.supabaseClient; } catch (_) {}
      if (!demoSb) {
        try { if (typeof supabaseClient !== 'undefined' && supabaseClient && supabaseClient.functions) demoSb = supabaseClient; } catch (_) {}
      }
    }
    return demoSb;
  }

  function demoEnded(sb, entry) {
    if (document.getElementById('recallDemoEnd')) return;
    var client = sb || findDemoClientCached();
    // Ask the server to reap the demo now (cron usually beat us to it).
    if (client) {
      try {
        client.functions.invoke('expire-demo-schools', { body: {} }).catch(function () {});
      } catch (_) {}
      try { client.auth.signOut().catch(function () {}); } catch (_) {}
    }
    demoBannerStyle();
    var over = document.createElement('div');
    over.id = 'recallDemoEnd';

    var box = document.createElement('div');
    box.className = 'box';
    var h = document.createElement('h2');
    h.textContent = 'This demo school has ended';
    var p = document.createElement('p');
    p.textContent = 'Demo schools last 15 minutes, and all demo accounts and data have just been deleted automatically. Ready for the real thing?';
    var actions = document.createElement('div');
    var a1 = document.createElement('a');
    a1.className = 'primary';
    a1.href = 'signup-organisation.html';
    a1.textContent = 'Set up your own school';
    var a2 = document.createElement('a');
    a2.className = 'ghost';
    a2.href = 'index.html';
    a2.textContent = 'Back to homepage';
    actions.appendChild(a1);
    actions.appendChild(a2);
    box.appendChild(h);
    box.appendChild(p);
    box.appendChild(actions);
    over.appendChild(box);
    document.body.appendChild(over);
  }

  if (!isFile) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () { findDemoClient(0); });
    } else {
      findDemoClient(0);
    }
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