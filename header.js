// ============================================================================
// header.js — Canonical Recall top navigation.
//
// One self-contained module used by every page so the nav looks and behaves
// the same everywhere. Each page mounts it into an empty container:
//
//   <div id="headerSlot" data-mode="auth" data-tag="Moderation"></div>
//   <script src="header.js" defer></script>
//
// The module auto-mounts on DOMContentLoaded by looking for the first element
// with [data-mount="recall-header"] or, failing that, #headerSlot.
//
// Public surface:
//   window.recallHeader.mount(slotEl, opts) — opts: {
//     mode: 'auth' | 'marketing' | 'minimal',     // default 'auth'
//     tag:  string,                               // pill text next to brand (auth mode)
//     brandHref: string,                          // default 'index.html'
//     logoSrc: string,                            // default 'logo.png'
//     links: Array<{ href, label }>,              // for marketing mode
//     cta: { href, label },                       // for marketing / minimal modes
//     signOutUrl: string,                         // for auth mode
//     showSignOut: boolean,                       // for auth mode (default true)
//   }
//
// ============================================================================

(function () {
  'use strict';

  const STYLE_ID = 'recall-header-style';

  // Pages in subfolders load this module as "../header.js" — derive the path
  // prefix from the script's own src so dashboard/profile/login links
  // resolve correctly from any depth.
  var PATH_PREFIX = (function () {
    var s = document.querySelector('script[src$="header.js"]');
    if (!s) return '';
    var m = /^((?:.*\/)?)header\.js$/.exec(s.getAttribute('src') || '');
    return m ? m[1] : '';
  })();

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = `
/* ---------- Auth / rich header (homepage-style: frosted, pill, full nav) ---------- */
.recall-header {
  position: sticky; top: 0; z-index: 50;
  background: rgba(26, 29, 34, 0.78);
  backdrop-filter: saturate(140%) blur(12px);
  -webkit-backdrop-filter: saturate(140%) blur(12px);
  border-bottom: 1px solid var(--line);
}
.recall-header .row {
  max-width: var(--maxw, 1240px); margin: 0 auto;
  padding: 0 24px;
  display: flex; align-items: center; justify-content: space-between;
  height: 64px;
  gap: 18px;
}
.recall-header .brand {
  display: flex; align-items: center; gap: 10px;
  font-weight: 700; font-size: 16px;
  color: var(--text);
  text-decoration: none;
}
.recall-header .brand:hover { text-decoration: none; }
.recall-header .brand-mark {
  width: 30px; height: 30px;
  display: block;
  object-fit: cover;
  border-radius: 50%;
  box-shadow: 0 0 0 1px rgba(255,255,255,0.04),
              0 0 16px rgba(86,212,221,0.18);
  flex-shrink: 0;
}
.recall-header .brand .tag {
  font-size: 11px; font-weight: 600;
  background: var(--teal-pale, rgba(86, 212, 221, 0.10));
  color: var(--teal, #56D4DD);
  padding: 3px 10px; border-radius: var(--r-pill, 999px);
  margin-left: 6px;
  letter-spacing: 0.02em;
}
.recall-header .right {
  display: flex; align-items: center; gap: 8px;
  font-size: 13px; color: var(--text-3);
}
.recall-header #bellSlot,
.recall-header #avatarSlot {
  display: inline-flex;
  align-items: center;
}
.recall-header .nav-links {
  display: flex; align-items: center; gap: 4px;
  list-style: none; padding: 0; margin: 0;
}
.recall-header .nav-links a.nav-link {
  color: var(--text-2); font-size: 14px; font-weight: 500;
  padding: 7px 12px; border-radius: var(--r-pill, 999px);
  text-decoration: none;
}
.recall-header .nav-links a.nav-link:hover {
  color: var(--text); background: var(--bg-3, rgba(0,0,0,0.2));
  text-decoration: none;
}
.recall-header .nav-cta {
  background: #FFFFFF; color: #0B0D0F !important;
  padding: 7px 16px; border-radius: var(--r-pill, 999px);
  font-size: 14px; font-weight: 600;
  display: inline-flex; align-items: center;
  box-shadow: 0 2px 10px rgba(255,255,255,0.10), 0 0 24px rgba(86,212,221,0.18);
  transition: background 0.15s ease, box-shadow 0.15s ease, transform 0.15s ease;
  text-decoration: none;
}
.recall-header .nav-cta:hover {
  background: #F0F2F5;
  box-shadow: 0 4px 16px rgba(255,255,255,0.16), 0 0 32px rgba(86,212,221,0.28);
  transform: translateY(-1px);
  text-decoration: none;
}
.recall-header .btn-ghost {
  background: transparent;
  color: var(--text-2);
  border: 1px solid var(--line-2);
  padding: 6px 12px;
  border-radius: var(--r-sm, 12px);
  font-family: inherit; font-size: 12.5px; font-weight: 500;
  cursor: pointer;
}
.recall-header .btn-ghost:hover { background: var(--bg-2); color: var(--text); }

/* ---------- Avatar pill (specific to header.js — NOT btn-primary) ----------
   These styles are intentionally distinct from .btn-primary / .btn-ghost so
   the pill never inherits a solid-white primary look. The trigger is a
   translucent dark pill with a thin border; menu items are transparent with
   a darker hover. */
.recall-header .avatar-slot { display: inline-flex; align-items: center; }
.recall-header .recall-avatar-wrap { position: relative; display: inline-flex; align-items: center; }
.recall-header .recall-avatar-btn {
  background: rgba(0, 0, 0, 0.28) !important;
  background-color: rgba(0, 0, 0, 0.28) !important;
  border: 1px solid var(--line-2) !important;
  color: var(--text-2) !important;
  cursor: pointer;
  font-family: inherit;
  display: inline-flex; align-items: center; gap: 8px;
  padding: 4px 10px 4px 4px !important;
  border-radius: var(--r-pill, 999px);
  transition: background 0.12s ease, border-color 0.12s ease;
}
.recall-header .recall-avatar-btn:hover {
  background: rgba(0, 0, 0, 0.45) !important;
  background-color: rgba(0, 0, 0, 0.45) !important;
  border-color: var(--line-3) !important;
  color: var(--text) !important;
}
.recall-header .recall-avatar-circle {
  width: 30px; height: 30px;
  border-radius: 50%;
  background: var(--bg-3);
  display: inline-flex; align-items: center; justify-content: center;
  font-size: 12px; font-weight: 700;
  color: #fff;
  overflow: hidden;
  flex-shrink: 0;
}
.recall-header .recall-avatar-circle img { width: 100%; height: 100%; object-fit: cover; display: block; }
.recall-header .recall-avatar-name {
  font-size: 13px;
  color: var(--text-2);
  max-width: 140px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-weight: 500;
}
.recall-header .recall-avatar-caret {
  width: 8px; height: 8px;
  border-right: 2px solid var(--text-3);
  border-bottom: 2px solid var(--text-3);
  transform: rotate(45deg);
  margin-top: -3px;
  display: none;
}
@media (min-width: 720px) {
  .recall-header .recall-avatar-caret { display: inline-block; }
}
.recall-header .recall-avatar-menu {
  position: absolute;
  top: calc(100% + 8px);
  right: 0;
  min-width: 240px;
  background: var(--bg-2);
  border: 1px solid var(--line-2);
  border-radius: var(--r-md, 18px);
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.45);
  padding: 6px 0;
  z-index: 90;
  display: none;
}
.recall-header .recall-avatar-menu.open { display: block; }
.recall-header .recall-avatar-menu-head {
  display: flex; align-items: center; gap: 10px;
  padding: 12px 14px 10px;
  border-bottom: 1px solid var(--line-2);
  margin-bottom: 4px;
}
.recall-header .recall-avatar-menu-head .meta { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.recall-header .recall-avatar-menu-head .name {
  font-weight: 600; font-size: 13px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  color: var(--text);
}
.recall-header .recall-avatar-menu-head .role {
  font-size: 11px; color: var(--text-3);
}
.recall-header .recall-avatar-menu-item {
  display: flex; align-items: center; gap: 10px;
  padding: 8px 14px;
  background: transparent !important;
  background-color: transparent !important;
  border: 0;
  color: var(--text) !important;
  font-size: 13px;
  text-align: left; width: 100%;
  cursor: pointer; font-family: inherit;
  text-decoration: none;
}
.recall-header .recall-avatar-menu-item:hover {
  background: var(--bg-3) !important;
  background-color: var(--bg-3) !important;
  color: var(--text) !important;
  text-decoration: none;
}
.recall-header .recall-avatar-menu-item.danger { color: var(--red, #F26B62) !important; }
.recall-header .recall-avatar-menu-sep {
  height: 1px;
  background: var(--line-2);
  margin: 4px 0;
}

@media (max-width: 720px) {
  .recall-header .nav-links { display: none; }
  .recall-header .row { height: 56px; }
}
    `;
    document.head.appendChild(s);
  }

  // Find the page's Supabase client. Most pages declare it as a top-level
  // `const supabaseClient` in an inline script — that lives in the shared
  // global lexical scope but NOT on `window`, so `window.supabaseClient`
  // alone misses them (only index.html and moderation.html set the window
  // property). `typeof` guards the undeclared case; deferred header.js runs
  // after the page's inline scripts, so the binding is initialised by then.
  function getSupabase() {
    if (typeof window !== 'undefined' && window.supabaseClient) return window.supabaseClient;
    try {
      if (typeof supabaseClient !== 'undefined' && supabaseClient) return supabaseClient;
    } catch (_) { /* undeclared — fall through */ }
    return null;
  }

  function el(tag, attrs, children) {
    const e = document.createElement(tag);
    if (attrs) {
      for (const k in attrs) {
        if (k === 'class') e.className = attrs[k];
        else if (k === 'html') e.innerHTML = attrs[k];
        else if (k === 'text') e.textContent = attrs[k];
        else if (k.startsWith('on') && typeof attrs[k] === 'function') {
          e.addEventListener(k.slice(2).toLowerCase(), attrs[k]);
        } else if (attrs[k] !== null && attrs[k] !== undefined && attrs[k] !== false) {
          e.setAttribute(k, attrs[k]);
        }
      }
    }
    if (children) {
      (Array.isArray(children) ? children : [children]).forEach((c) => {
        if (c == null || c === false) return;
        if (typeof c === 'string') e.appendChild(document.createTextNode(c));
        else e.appendChild(c);
      });
    }
    return e;
  }

  // Auth mode: homepage-style sticky frosted nav. Brand on the left,
  // bell + avatar pill on the right. Optional `tag` pill next to the brand.
  // The avatar pill is rendered directly here (was previously a separate
  // header-avatar.js module) so the entire signed-in header is self-contained.
  function buildAuth(opts) {
    const right = el('div', { class: 'right' });
    right.appendChild(el('span', { id: 'bellSlot' }));
    right.appendChild(buildAvatarPill());
    if (opts.showSignOut !== false) {
      const btn = el('button', {
        class: 'btn-ghost', id: 'signOutBtn', type: 'button', hidden: '',
      });
      btn.textContent = 'Sign out';
      right.appendChild(btn);
    }
    return right;
  }

  // ---------- Avatar pill (was header-avatar.js) ----------
  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function initialsOf(name) {
    if (!name) return '?';
    const parts = String(name).trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return '?';
    if (parts.length === 1) return parts[0].slice(0, 1).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }
  function hueFromId(id) {
    if (!id) return 200;
    let h = 0;
    const s = String(id).replace(/-/g, '');
    for (let i = 0; i < s.length; i++) {
      h = (h * 31 + s.charCodeAt(i)) >>> 0;
    }
    return h % 360;
  }
  function roleLabelOf(role) {
    switch (role) {
      case 'staff_author':     return 'Author';
      case 'staff_reviewer':   return 'Reviewer';
      case 'admin':            return 'Admin';
      case 'school_organiser': return 'School';
      case 'teacher':          return 'Teacher';
      case 'student':          return 'Student';
      default:                 return role || 'Member';
    }
  }
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

  function paintAvatarAvatar(elt, profile) {
    const id = profile && profile.id ? profile.id : null;
    const url = profile && profile.avatar_url ? profile.avatar_url : null;
    const name = (profile && profile.full_name) || 'You';
    if (url) {
      elt.innerHTML = '<img alt="" src="' + escapeHtml(url) + '">';
    } else {
      const hue = hueFromId(id);
      elt.style.background = 'hsl(' + hue + ' 55% 38%)';
      elt.textContent = initialsOf(name);
    }
  }

  function buildAvatarPill() {
    // Wrap in a span so it slots into the right cluster; the actual pill
    // gets rendered once we know the user/profile. Until then, place a
    // placeholder slot so the layout doesn't shift.
    const wrap = el('span', { id: 'avatarSlot', class: 'avatar-slot' });
    return wrap;
  }

  function mountAvatarPill() {
    const slot = document.getElementById('avatarSlot');
    if (!slot || slot.firstChild) return; // already mounted, or no slot
    const sb = getSupabase();
    if (!sb || !sb.auth || typeof sb.auth.getSession !== 'function') {
      // Supabase isn't ready yet — try again next tick. Pages that initialise
      // the client after header.js has loaded will get the pill shortly after.
      setTimeout(mountAvatarPill, 50);
      return;
    }

    sb.auth.getSession().then(async function (res) {
      const session = res && res.data && res.data.session;
      const user = session && session.user;
      if (!user) return;
      // Fetch the profile row so we can render the name + role + avatar.
      let profile = { id: user.id, full_name: '', role: 'student', avatar_url: null };
      try {
        const { data: p } = await sb
          .from('profiles').select('id, full_name, avatar_url, role').eq('id', user.id).maybeSingle();
        if (p) {
          profile = Object.assign({}, profile, p);
        }
      } catch (_) { /* fall through with defaults */ }
      if (slot.firstChild) return; // re-check after async fetch
      renderAvatarPillInto(slot, user, profile);
    }).catch(function () { /* swallow */ });

    if (typeof sb.auth.onAuthStateChange === 'function') {
      sb.auth.onAuthStateChange(async function (_event, session) {
        if (session && session.user && !slot.firstChild) {
          let profile = { id: session.user.id, full_name: '', role: 'student', avatar_url: null };
          try {
            const { data: p } = await sb
              .from('profiles').select('id, full_name, avatar_url, role').eq('id', session.user.id).maybeSingle();
            if (p) profile = Object.assign({}, profile, p);
          } catch (_) {}
          if (slot.firstChild) return;
          renderAvatarPillInto(slot, session.user, profile);
        }
      });
    }
  }

  function renderAvatarPillInto(slot, user, profile) {
    const wrap = document.createElement('div');
    wrap.className = 'recall-avatar-wrap';

    const btn = document.createElement('button');
    btn.className = 'recall-avatar-btn';
    btn.setAttribute('aria-haspopup', 'menu');
    btn.setAttribute('aria-expanded', 'false');

    const circle = document.createElement('span');
    circle.className = 'recall-avatar-circle';
    paintAvatarAvatar(circle, profile);

    const nameEl = document.createElement('span');
    nameEl.className = 'recall-avatar-name';
    nameEl.textContent = profile.full_name || '';

    const caret = document.createElement('span');
    caret.className = 'recall-avatar-caret';

    btn.appendChild(circle);
    btn.appendChild(nameEl);
    btn.appendChild(caret);

    const menu = document.createElement('div');
    menu.className = 'recall-avatar-menu';
    menu.setAttribute('role', 'menu');

    const head = document.createElement('div');
    head.className = 'recall-avatar-menu-head';
    const headCircle = document.createElement('span');
    headCircle.className = 'recall-avatar-circle';
    headCircle.style.width = '36px';
    headCircle.style.height = '36px';
    paintAvatarAvatar(headCircle, profile);
    const meta = document.createElement('div');
    meta.className = 'meta';
    const headName = document.createElement('div');
    headName.className = 'name';
    headName.textContent = profile.full_name || 'Signed in';
    const headRole = document.createElement('div');
    headRole.className = 'role';
    headRole.textContent = roleLabelOf(profile.role);
    meta.appendChild(headName);
    meta.appendChild(headRole);
    head.appendChild(headCircle);
    head.appendChild(meta);
    menu.appendChild(head);

    const dashLink = document.createElement('a');
    dashLink.className = 'recall-avatar-menu-item';
    dashLink.href = dashboardUrlFor(profile.role);
    dashLink.textContent = 'My dashboard';
    menu.appendChild(dashLink);

    const profileLink = document.createElement('a');
    profileLink.className = 'recall-avatar-menu-item';
    profileLink.href = PATH_PREFIX + 'profile.html?id=' + encodeURIComponent(user.id);
    profileLink.textContent = 'My profile';
    menu.appendChild(profileLink);

    const sep1 = document.createElement('div');
    sep1.className = 'recall-avatar-menu-sep';
    menu.appendChild(sep1);

    const signOutBtn = document.createElement('button');
    signOutBtn.className = 'recall-avatar-menu-item danger';
    signOutBtn.type = 'button';
    signOutBtn.textContent = 'Sign out';
    signOutBtn.addEventListener('click', async function () {
      const client = getSupabase();
      try {
        if (client && client.auth && client.auth.signOut) await client.auth.signOut();
      } catch (_) { /* ignore */ }
      window.location.href = PATH_PREFIX + 'login.html';
    });
    menu.appendChild(signOutBtn);

    wrap.appendChild(btn);
    wrap.appendChild(menu);
    slot.appendChild(wrap);

    function openMenu() {
      menu.classList.add('open');
      btn.setAttribute('aria-expanded', 'true');
      paintAvatarAvatar(headCircle, profile);
    }
    function closeMenu() {
      menu.classList.remove('open');
      btn.setAttribute('aria-expanded', 'false');
    }
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      if (menu.classList.contains('open')) closeMenu();
      else openMenu();
    });
    document.addEventListener('click', function (e) {
      if (!wrap.contains(e.target)) closeMenu();
    });
    btn.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeMenu();
    });
  }

  function buildMarketing(opts) {
    const links = Array.isArray(opts.links) ? opts.links : [];
    const ul = el('ul', { class: 'nav-links' });
    for (const l of links) {
      ul.appendChild(el('li', null, [
        el('a', { class: 'nav-link', href: l.href, text: l.label })
      ]));
    }
    const right = el('div', { class: 'right' });
    if (opts.cta) {
      right.appendChild(el('a', {
        class: 'nav-cta', href: opts.cta.href, text: opts.cta.label,
      }));
    }
    return [ul, right];
  }

  function buildMinimal(opts) {
    const right = el('div', { class: 'right' });
    if (opts.cta) {
      right.appendChild(el('a', {
        class: 'nav-link', href: opts.cta.href, text: opts.cta.label,
      }));
    }
    if (opts.extraRightEl) {
      right.appendChild(opts.extraRightEl);
    }
    return right;
  }

  // Point the brand link at the signed-in user's dashboard. The href keeps
  // its page default (index.html) until a session resolves, so signed-out
  // visitors and no-JS fallbacks still land on the homepage. The profile
  // row's role wins over the JWT copy (which can go stale). Re-resolves on
  // auth state changes so sign-in/sign-out from another tab stays in sync.
  function pointBrandAtDashboard(brand, attempts) {
    const fallback = PATH_PREFIX + (brand.getAttribute('href') || 'index.html');
    const sb = getSupabase();
    if (!sb || !sb.auth || typeof sb.auth.getSession !== 'function') {
      // Supabase isn't ready yet — retry while the page initialises; give up
      // quietly (keeping the homepage href) on pages with no client at all.
      if ((attempts || 0) > 100) return;
      setTimeout(function () { pointBrandAtDashboard(brand, (attempts || 0) + 1); }, 50);
      return;
    }
    function resolve() {
      sb.auth.getSession().then(async function (res) {
        const user = res && res.data && res.data.session && res.data.session.user;
        if (!user) { brand.setAttribute('href', fallback); return; }
        let role = (user.app_metadata && user.app_metadata.role) || null;
        try {
          const { data: p } = await sb
            .from('profiles').select('role').eq('id', user.id).maybeSingle();
          if (p && p.role) role = p.role;
        } catch (_) { /* fall back to the JWT role */ }
        brand.setAttribute('href', dashboardUrlFor(role));
      }).catch(function () { /* keep the current href */ });
    }
    resolve();
    if (typeof sb.auth.onAuthStateChange === 'function') {
      sb.auth.onAuthStateChange(function (_event, session) {
        if (session && session.user) resolve();
        else brand.setAttribute('href', fallback);
      });
    }
  }

  function mount(slotEl, opts) {
    if (!slotEl) return null;
    opts = opts || {};
    injectStyle();

    const nav = el('nav', { class: 'recall-header' });
    const row = el('div', { class: 'row' });
    const brand = el('a', {
      class: 'brand', href: opts.brandHref || 'index.html',
    });
    brand.appendChild(el('img', {
      class: 'brand-mark', src: opts.logoSrc || 'logo.png', alt: 'Recall',
    }));
    brand.appendChild(document.createTextNode(' Recall'));
    if (opts.tag) {
      brand.appendChild(el('span', { class: 'tag', text: opts.tag }));
    }
    row.appendChild(brand);
    // Signed-in users: the logo goes to their dashboard, not the homepage.
    pointBrandAtDashboard(brand);

    const mode = opts.mode || 'auth';
    if (mode === 'marketing') {
      const parts = buildMarketing(opts);
      parts.forEach(p => row.appendChild(p));
    } else if (mode === 'minimal') {
      row.appendChild(buildMinimal(opts));
    } else {
      row.appendChild(buildAuth(opts));
    }

    nav.appendChild(row);
    slotEl.replaceWith(nav);
    return nav;
  }

  window.recallHeader = { mount };

  function autoMount() {
    const slot = document.querySelector('[data-mount="recall-header"]') || document.getElementById('headerSlot');
    if (!slot) return;
    const mode = slot.getAttribute('data-mode') || 'auth';
    const tag = slot.getAttribute('data-tag') || null;
    const brandHref = slot.getAttribute('data-brand-href') || null;
    let extraRightEl = null;
    if (mode === 'minimal') {
      const extra = slot.parentNode && slot.parentNode.querySelector('.recall-header-extra');
      if (extra) {
        extra.classList.add('recall-header-extra-lifted');
        extraRightEl = extra;
      }
    }
    mount(slot, { mode, tag, brandHref, extraRightEl });
    // In auth mode, render the avatar pill (fetches profile then paints).
    // Only attempt once Supabase has had a chance to initialize — pages that
    // create the client later will see the pill appear via onAuthStateChange.
    if ((slot.getAttribute('data-mode') || 'auth') === 'auth') {
      // Defer one tick so any page that initialises Supabase during its own
      // script execution finishes first.
      setTimeout(mountAvatarPill, 0);
    }
  }

  // Mount synchronously if the slot exists in the parsed HTML. This is the
  // common case when header.js is loaded with `defer` after the body is
  // parsed. If the slot doesn't exist yet (rare), wait for DOMContentLoaded.
  if (document.getElementById('headerSlot') || document.querySelector('[data-mount="recall-header"]')) {
    autoMount();
  } else if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', autoMount);
  } else {
    autoMount();
  }

  // Once the header is mounted, look for a Supabase session and unhide the
  // sign-out button when a user is signed in. This means every page gets a
  // working sign-out button without each page having to remember to unhide
  // it. Re-checks on auth state changes so sign-in/sign-out from another tab
  // keeps the button in sync.
  function tryUnhideSignOut() {
    const btn = document.getElementById('signOutBtn');
    if (!btn) return; // minimal / marketing modes don't have one
    const sb = getSupabase();
    if (!sb || !sb.auth) return;
    if (typeof sb.auth.getSession === 'function') {
      sb.auth.getSession().then(function (res) {
        const u = res && res.data && res.data.session && res.data.session.user;
        btn.hidden = !u;
      }).catch(function () { /* swallow */ });
    }
    if (typeof sb.auth.onAuthStateChange === 'function') {
      sb.auth.onAuthStateChange(function (_event, session) {
        btn.hidden = !(session && session.user);
      });
    }
  }
  function wireSignOut() {
    const btn = document.getElementById('signOutBtn');
    if (!btn) return;
    // Skip the click handler if a page already wired one up. Existing pages
    // like dashboard.html attach their own listener before this deferred
    // script runs; double-firing would race the two redirects.
    if (!btn.dataset.recallSignOutWired) {
      btn.dataset.recallSignOutWired = '1';
      btn.addEventListener('click', async function () {
        const sb = getSupabase();
        try { if (sb && sb.auth && sb.auth.signOut) await sb.auth.signOut(); } catch (_) {}
        window.location.href = PATH_PREFIX + 'login.html';
      });
    }
    tryUnhideSignOut();
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wireSignOut);
  } else {
    wireSignOut();
  }
})();
