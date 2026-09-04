// ============================================================================
// brand-dashboard.js — Point custom-header brand logos at the user's
// dashboard when they're signed in.
//
// header.js already does this for pages that mount the shared header
// (#headerSlot). But some pages (index.html, admin.html, subjects.html,
// class-summary.html, the legal pages, …) render their own <nav class="top">
// with their own <a class="brand"> logo link. Load this on those pages:
//
//   <script src="brand-dashboard.js" defer></script>
//
// Behaviour:
//   * Finds brand links inside nav/header bars (NOT footer brand blocks —
//     those keep pointing at the homepage).
//   * Signed in  → href becomes the user's dashboard (role, from the
//     profiles table, wins over the JWT copy).
//   * Signed out → href is left exactly as the page authored it.
//   * No Supabase client on the page → does nothing (static pages).
//
// ============================================================================

(function () {
  'use strict';

  // Same role → dashboard map as header.js's dashboardUrlFor. Path prefix
  // derived from this script's own src so it works from subfolders too.
  var PATH_PREFIX = (function () {
    var s = document.querySelector('script[src$="brand-dashboard.js"]');
    if (!s) return '';
    var m = /^((?:.*\/)?)brand-dashboard\.js$/.exec(s.getAttribute('src') || '');
    return m ? m[1] : '';
  })();

  function dashboardUrlFor(role) {
    switch (role) {
      case 'staff_author':
      case 'staff_reviewer':
      case 'admin':
        return PATH_PREFIX + 'staff-dashboard.html';
      case 'school_organiser':
        return PATH_PREFIX + 'school-organiser-dashboard.html';
      case 'teacher':
        return PATH_PREFIX + 'teacher-dashboard.html';
      default:
        return PATH_PREFIX + 'dashboard.html';
    }
  }

  // Find the page's client. Pages declare either window.supabaseClient or a
  // top-level `const supabaseClient` (global lexical scope, not on window).
  // `typeof` guards the undeclared case. NOTE: a bare `supabase` identifier
  // is the supabase-js UMD bundle itself — never a client — so it's not
  // consulted here.
  function getSupabase() {
    if (typeof window !== 'undefined' && window.supabaseClient) return window.supabaseClient;
    try {
      if (typeof supabaseClient !== 'undefined' && supabaseClient) return supabaseClient;
    } catch (_) { /* undeclared — fall through */ }
    return null;
  }

  function applyHref(href) {
    document.querySelectorAll('nav a.brand, header a.brand, .top a.brand').forEach(function (a) {
      a.setAttribute('href', href);
    });
  }

  function resolve(sb) {
    sb.auth.getSession().then(async function (res) {
      const user = res && res.data && res.data.session && res.data.session.user;
      if (!user) return; // signed out — leave the authored href alone
      let role = (user.app_metadata && user.app_metadata.role) || null;
      try {
        const { data: p } = await sb
          .from('profiles').select('role').eq('id', user.id).maybeSingle();
        if (p && p.role) role = p.role;
      } catch (_) { /* fall back to the JWT role */ }
      applyHref(dashboardUrlFor(role));
    }).catch(function () { /* keep the authored href */ });
  }

  // Static pages (legal pages, email-templates, …) load no Supabase SDK at
  // all. Supabase persists the session in localStorage as
  // `sb-<project-ref>-auth-token`, so read the cached session for the role.
  // Sign-out removes the key, so a stale entry can't outlive its session.
  // The role comes from the cached JWT (may lag a just-changed profile) —
  // acceptable for pages that can't query the database.
  function resolveFromLocalSession() {
    try {
      var user = null;
      for (var i = 0; i < localStorage.length; i++) {
        var key = localStorage.key(i);
        if (!/^sb-.*-auth-token$/.test(key)) continue;
        var parsed = JSON.parse(localStorage.getItem(key));
        if (parsed && parsed.user) { user = parsed.user; break; }
      }
      if (!user) return; // signed out (or unknown storage) — authored href stays
      var role = (user.app_metadata && user.app_metadata.role)
        || (user.user_metadata && user.user_metadata.role) || null;
      applyHref(dashboardUrlFor(role));
    } catch (_) { /* keep the authored href */ }
  }

  function start(attempts) {
    var sb = getSupabase();
    if (sb && sb.auth && typeof sb.auth.getSession === 'function') {
      resolve(sb);
      if (typeof sb.auth.onAuthStateChange === 'function') {
        sb.auth.onAuthStateChange(function (_event, session) {
          // Re-resolve so a fresh sign-in updates the logo without a reload.
          if (session && session.user) resolve(sb);
        });
      }
      return;
    }
    // SDK bundle loaded but the page hasn't built its client yet — it may
    // still appear, so retry for a few seconds.
    var sdkLoaded = typeof window !== 'undefined'
      && window.supabase && typeof window.supabase.createClient === 'function';
    if (sdkLoaded && (attempts || 0) < 100) {
      setTimeout(function () { start((attempts || 0) + 1); }, 50);
      return;
    }
    // No SDK on the page — fall back to the cached session.
    resolveFromLocalSession();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { start(0); });
  } else {
    start(0);
  }
})();