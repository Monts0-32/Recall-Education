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

@media (max-width: 720px) {
  .recall-header .nav-links { display: none; }
  .recall-header .row { height: 56px; }
}
    `;
    document.head.appendChild(s);
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
  // bell + avatar slots on the right. Optional `tag` pill next to the brand.
  // Pages that need a sign-out button still get one (hidden until authed)
  // for backwards compatibility with dashboard.html and friends.
  function buildAuth(opts) {
    const right = el('div', { class: 'right' });
    right.appendChild(el('span', { id: 'bellSlot' }));
    right.appendChild(el('span', { id: 'avatarSlot' }));
    if (opts.showSignOut !== false) {
      const btn = el('button', {
        class: 'btn-ghost', id: 'signOutBtn', type: 'button', hidden: '',
      });
      btn.textContent = 'Sign out';
      right.appendChild(btn);
    }
    return right;
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
    const sb = (typeof window !== 'undefined') ? window.supabaseClient : null;
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
        const sb = window.supabaseClient;
        try { if (sb && sb.auth && sb.auth.signOut) await sb.auth.signOut(); } catch (_) {}
        window.location.href = 'login.html';
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
