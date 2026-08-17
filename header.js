// ============================================================================
// header.js — Canonical Recall top navigation.
//
// One self-contained module used by every page so the nav looks and behaves
// the same everywhere. Each page mounts it into an empty container:
//
//   <div id="headerSlot"></div>
//   <script src="header.js" defer></script>
//
// The module auto-mounts on DOMContentLoaded by looking for the first element
// with [data-mount="recall-header"] or, failing that, #headerSlot.
//
// Public surface:
//   window.recallHeader.mount(slotEl, opts) — opts: {
//     mode: 'auth' | 'marketing' | 'minimal',     // default 'auth'
//     brandHref: string,                           // default 'index.html'
//     logoSrc: string,                             // default 'logo.png'
//     links: Array<{ href, label }>,               // for marketing mode
//     cta: { href, label },                        // for marketing mode
//     signOutUrl: string,                          // for auth mode
//     showSignOut: boolean,                        // for auth mode (default true)
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
.recall-header {
  border-bottom: 1px solid var(--line);
  background: var(--bg);
  position: sticky; top: 0; z-index: 50;
}
.recall-header .row {
  max-width: 100%; margin: 0 auto;
  padding: 0 24px;
  display: flex; align-items: center; justify-content: space-between;
  height: 56px;
  gap: 18px;
}
.recall-header .brand {
  display: flex; align-items: center; gap: 10px;
  font-weight: 700; font-size: 15px;
  color: var(--text);
}
.recall-header .brand:hover { text-decoration: none; }
.recall-header .brand-mark {
  width: 26px; height: 26px;
  display: block;
  object-fit: cover;
  border-radius: var(--r-sm);
  flex-shrink: 0;
}
.recall-header .right {
  display: flex; align-items: center; gap: 12px;
  font-size: 13px; color: var(--text-3);
}
.recall-header .nav-links {
  display: flex; align-items: center; gap: 22px;
  list-style: none; padding: 0; margin: 0;
  flex: 1; justify-content: center;
}
.recall-header .nav-links a {
  color: var(--text-3); font-size: 13px; font-weight: 500;
}
.recall-header .nav-links a:hover { color: var(--text); text-decoration: none; }
.recall-header .nav-cta {
  background: var(--blue); color: #fff !important;
  padding: 8px 14px; border-radius: var(--r-sm);
  font-size: 13px; font-weight: 600;
  display: inline-flex; align-items: center;
}
.recall-header .nav-cta:hover { background: var(--blue-2); text-decoration: none; }
.recall-header .nav-link { font-size: 13px; color: var(--text-3); }
.recall-header .nav-link:hover { color: var(--text); text-decoration: none; }
.recall-header .btn-ghost {
  background: transparent;
  color: var(--text-2);
  border: 1px solid var(--line-2);
  padding: 6px 12px;
  border-radius: var(--r-sm);
  font-family: inherit; font-size: 12.5px; font-weight: 500;
  cursor: pointer;
}
.recall-header .btn-ghost:hover { background: var(--bg-2); color: var(--text); }

/* Pages can drop an extra-right element next to #headerSlot; when picked up
   by the header, the placeholder's display:none is reversed so it shows. */
.recall-header .recall-header-extra-lifted { display: block !important; font-size: 13px; color: var(--text-3); }
@media (max-width: 720px) {
  .recall-header .nav-links { display: none; }
}
    `;
    document.head.appendChild(s);
  }

  function el(tag, attrs, children) {
    const e = document.createElement(tag);
    if (attrs) {
      for (const k in attrs) {
        if (k === 'class') e.className = attrs[k];
        else if (k === 'text') e.textContent = attrs[k];
        else e.setAttribute(k, attrs[k]);
      }
    }
    if (children) {
      for (const c of (Array.isArray(children) ? children : [children])) {
        if (c == null) continue;
        if (typeof c === 'string') e.appendChild(document.createTextNode(c));
        else e.appendChild(c);
      }
    }
    return e;
  }

  function buildAuth(opts) {
    const right = el('div', { class: 'right' });
    // Pages can drop their own elements (userName, avatarSlot, bellSlot, signOutBtn)
    // into the right cluster via these slots. We render containers the page can fill.
    right.appendChild(el('span', { id: 'userName' }));
    right.appendChild(el('div', { id: 'avatarSlot', style: 'display: inline-flex;' }));
    right.appendChild(el('div', { id: 'bellSlot' }));
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
    // Pick up an optional sibling element next to #headerSlot so individual
    // pages can drop their own right-side content (e.g. login.html's "Don't
    // have an account? Sign up") without forking the header.
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
    // If a sibling .recall-header-extra element exists, lift it into the
    // minimal-mode right cluster so individual pages can keep their own
    // right-side prompts without forking the header.
    let extraRightEl = null;
    if (mode === 'minimal') {
      const extra = slot.parentNode && slot.parentNode.querySelector('.recall-header-extra');
      if (extra) {
        extra.classList.add('recall-header-extra-lifted');
        extraRightEl = extra;
      }
    }
    mount(slot, { mode, extraRightEl });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', autoMount);
  } else {
    autoMount();
  }
})();
