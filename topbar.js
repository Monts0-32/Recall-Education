/* global supabaseClient, window */
/* ---------------------------------------------------------------------------
 * Recall — topbar notification bell
 *
 * Tiny self-contained loader used by dashboard.html, lesson-creator.html,
 * staff-dashboard.html, and admin.html. Skips itself silently on lesson.html
 * (student players stay distraction-free) and on any page where
 * #bellSlot is absent.
 *
 * Usage:
 *   <div id="bellSlot"></div>
 *   <script src="https://cdn.jsdelivr.net/npm/@supabase/[email protected]/dist/umd/supabase.min.js"></script>
 *   <script src="topbar.js" defer></script>
 *
 * The page should set up `supabaseClient` before this script runs and call
 *   window.recallTopbar.mount('bellSlot', { supabaseClient, user, onItemClick })
 * once the user session is resolved. If the page just leaves the slot and
 * the globals, the script auto-mounts on DOMContentLoaded.
 *
 * onItemClick(notification) — return a URL to navigate to when the user
 * clicks a notification; return null to do nothing.
 * ------------------------------------------------------------------------- */

(function () {
  'use strict';

  // ---------- CSS (scoped to .bell-*) -------------------------------------
  const STYLE_ID = 'recall-topbar-style';
  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = `
.bell-wrap { position: relative; display: inline-block; }
.bell-btn {
  position: relative;
  background: transparent; border: 0; padding: 6px;
  color: var(--text-2); cursor: pointer; font-family: inherit;
  border-radius: var(--r-sm);
  display: inline-flex; align-items: center; justify-content: center;
  transition: background 0.12s ease, color 0.12s ease, transform 0.12s ease;
}
.bell-btn:hover { background: var(--bg-3); color: var(--text); }
.bell-btn.bump { animation: bell-bump 0.32s ease-out; }
@keyframes bell-bump {
  0%   { transform: rotate(0); }
  35%  { transform: rotate(-12deg); }
  70%  { transform: rotate(8deg); }
  100% { transform: rotate(0); }
}
.bell-badge {
  position: absolute; top: -2px; right: -2px;
  background: var(--red); color: #fff;
  border-radius: 999px; padding: 1px 5px;
  font-size: 10.5px; font-weight: 700; line-height: 1.2;
  min-width: 16px; text-align: center;
  box-shadow: 0 0 0 2px var(--bg);
  border: 0;
}
.bell-ripples {
  position: absolute; inset: 0; pointer-events: none;
  overflow: visible;
}
.bell-ripple {
  position: absolute; top: 50%; left: 50%;
  width: 24px; height: 24px;
  margin: -12px 0 0 -12px;
  border-radius: 50%;
  background: var(--red);
  opacity: 0.5;
  animation: bell-ripple-out 1.4s ease-out forwards;
}
@keyframes bell-ripple-out {
  0%   { transform: scale(0.6); opacity: 0.55; }
  80%  { opacity: 0.08; }
  100% { transform: scale(2.6); opacity: 0; }
}
.bell-panel {
  position: absolute; top: calc(100% + 8px); right: 0;
  width: 360px; max-width: calc(100vw - 24px);
  background: var(--bg-2);
  border: 1px solid var(--line-2);
  border-radius: var(--r-md);
  box-shadow: 0 12px 40px rgba(0,0,0,0.45);
  z-index: 80;
  display: flex; flex-direction: column;
  max-height: 70vh;
}
.bell-panel[hidden] { display: none; }
.bell-panel-head {
  display: flex; align-items: center; justify-content: space-between;
  padding: 10px 14px; border-bottom: 1px solid var(--line-2);
}
.bell-panel-title { font-weight: 700; font-size: 13px; color: var(--text); }
.bell-mark-all {
  background: transparent; border: 0; color: var(--blue);
  cursor: pointer; font-family: inherit; font-size: 12px;
  padding: 4px 6px; border-radius: var(--r-sm);
}
.bell-mark-all:hover { background: var(--bg-3); }
.bell-list { list-style: none; margin: 0; padding: 0; overflow-y: auto; flex: 1; }
.bell-item {
  padding: 10px 14px; border-bottom: 1px solid var(--line);
  cursor: pointer;
  display: flex; flex-direction: column; gap: 2px;
}
.bell-item:hover { background: var(--bg-3); }
.bell-item.unread { background: rgba(248,81,73,0.06); }
.bell-item-body { font-size: 13px; color: var(--text); line-height: 1.4; }
.bell-item-meta { font-size: 11px; color: var(--text-3); }
.bell-panel-empty {
  padding: 32px 14px; text-align: center;
  color: var(--text-4); font-size: 12.5px;
}
`.trim();
    document.head.appendChild(s);
  }

  // ---------- helpers ------------------------------------------------------
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

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function fmtRelative(iso) {
    if (!iso) return '';
    const then = new Date(iso).getTime();
    if (isNaN(then)) return '';
    const diffSec = Math.max(0, (Date.now() - then) / 1000);
    if (diffSec < 60)        return 'just now';
    if (diffSec < 3600)      return Math.floor(diffSec / 60) + 'm ago';
    if (diffSec < 86400)     return Math.floor(diffSec / 3600) + 'h ago';
    if (diffSec < 86400 * 7) return Math.floor(diffSec / 86400) + 'd ago';
    return new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
  }

  // ---------- the bell widget ---------------------------------------------
  function mount(slotId, opts) {
    opts = opts || {};
    const slot = document.getElementById(slotId);
    if (!slot) return null;
    if (slot.firstChild) {
      // Already mounted — return a no-op handle so callers that store the
      // return value can still guard against double-mounts.
      return { wrap: slot.firstChild, open: function () {}, close: function () {}, refresh: function () {} };
    }
    if (!opts.supabaseClient) {
      if (typeof window.supabaseClient !== 'undefined') {
        opts.supabaseClient = window.supabaseClient;
      } else {
        // No client — bail silently. Pages without Supabase don't get a bell.
        return null;
      }
    }
    if (!opts.user) {
      if (opts.supabaseClient.auth && typeof opts.supabaseClient.auth.getUser === 'function') {
        // We need a user, but the page hasn't passed one — caller should
        // re-mount after auth resolves. Bail for now.
        return null;
      }
      return null;
    }

    ensureStyle();

    const sb = opts.supabaseClient;
    const userId = opts.user.id;
    const onItemClick = typeof opts.onItemClick === 'function'
      ? opts.onItemClick : function () { return null; };

    let unreadCount = 0;
    let panelOpen = false;
    let realtimeChannel = null;

    // ---- DOM ----
    const wrap = el('div', { class: 'bell-wrap' });

    const btn = el('button', {
      class: 'bell-btn',
      type: 'button',
      'aria-label': 'Notifications',
      'aria-haspopup': 'dialog',
      'aria-expanded': 'false',
    });
    btn.innerHTML =
      '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">' +
      '<path fill="currentColor" d="M12 2a1 1 0 0 0-1 1v1.07A7 7 0 0 0 5 11v3.59l-1.7 1.7A1 1 0 0 0 4 18h16a1 1 0 0 0 .7-1.71L19 14.59V11a7 7 0 0 0-6-6.93V3a1 1 0 0 0-1-1zm0 20a3 3 0 0 0 3-3H9a3 3 0 0 0 3 3z"/>' +
      '</svg>';

    const badge = el('span', { class: 'bell-badge', 'aria-live': 'polite' });
    badge.hidden = true;

    const ripples = el('span', { class: 'bell-ripples', 'aria-hidden': 'true' });

    btn.appendChild(badge);
    btn.appendChild(ripples);

    const panel = el('div', {
      class: 'bell-panel',
      role: 'dialog',
      'aria-label': 'Notifications',
      hidden: '',
    });

    const head = el('div', { class: 'bell-panel-head' }, [
      el('span', { class: 'bell-panel-title', text: 'Notifications' }),
      el('button', {
        class: 'bell-mark-all',
        type: 'button',
        text: 'Mark all read',
        onclick: markAllRead,
      }),
    ]);

    const list = el('ul', { class: 'bell-list' });
    const empty = el('div', {
      class: 'bell-panel-empty',
      text: 'Nothing new.',
      hidden: '',
    });

    panel.appendChild(head);
    panel.appendChild(list);
    panel.appendChild(empty);

    wrap.appendChild(btn);
    wrap.appendChild(panel);
    slot.appendChild(wrap);

    // ---- badge + ripple paint ----
    function paintBadge() {
      if (unreadCount > 0) {
        badge.textContent = unreadCount > 99 ? '99+' : String(unreadCount);
        badge.hidden = false;
      } else {
        badge.hidden = true;
      }
    }

    function bump() {
      btn.classList.remove('bump');
      // Force reflow so the animation restarts.
      // eslint-disable-next-line no-unused-expressions
      btn.offsetWidth;
      btn.classList.add('bump');
    }

    function spawnRipple() {
      const r = el('span', { class: 'bell-ripple' });
      ripples.appendChild(r);
      setTimeout(() => { if (r.parentNode) r.parentNode.removeChild(r); }, 1600);
    }

    // ---- list rendering ----
    function renderItem(n) {
      const li = el('li', {
        class: 'bell-item' + (n.read_at ? '' : ' unread'),
        'data-id': n.id,
      }, [
        el('div', { class: 'bell-item-body', text: n.body }),
        el('div', { class: 'bell-item-meta', text: fmtRelative(n.created_at) }),
      ]);
      li.addEventListener('click', () => {
        // Mark read.
        if (!n.read_at) {
          sb.rpc('mark_notification_read', { p_id: n.id }).then(() => {
            n.read_at = new Date().toISOString();
            unreadCount = Math.max(0, unreadCount - 1);
            paintBadge();
            li.classList.remove('unread');
          }).catch(() => {});
        }
        const url = onItemClick(n);
        if (url) window.location.href = url;
      });
      return li;
    }

    function prependItem(n) {
      empty.hidden = true;
      const li = renderItem(n);
      list.insertBefore(li, list.firstChild);
    }

    function renderList(rows) {
      list.innerHTML = '';
      if (!rows || !rows.length) {
        empty.hidden = false;
        return;
      }
      empty.hidden = true;
      rows.forEach((n) => list.appendChild(renderItem(n)));
    }

    // ---- data ----
    async function refreshList() {
      try {
        const { data, error } = await sb.rpc('list_recent_notifications', { p_limit: 50 });
        if (error) throw error;
        renderList(data || []);
        unreadCount = (data || []).filter((n) => !n.read_at).length;
        paintBadge();
      } catch (e) {
        console.warn('[topbar] list_recent_notifications failed:', e);
      }
    }

    async function markAllRead() {
      try {
        const { data, error } = await sb.rpc('mark_all_notifications_read');
        if (error) throw error;
        unreadCount = 0;
        paintBadge();
        // Mark every rendered item as read in-place.
        list.querySelectorAll('.bell-item.unread').forEach((li) => li.classList.remove('unread'));
      } catch (e) {
        console.warn('[topbar] mark_all_notifications_read failed:', e);
      }
    }

    // ---- panel toggle ----
    function openPanel() {
      panelOpen = true;
      panel.hidden = false;
      btn.setAttribute('aria-expanded', 'true');
      refreshList();
    }
    function closePanel() {
      panelOpen = false;
      panel.hidden = true;
      btn.setAttribute('aria-expanded', 'false');
    }
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (panel.hidden) openPanel(); else closePanel();
    });
    document.addEventListener('click', (ev) => {
      if (!panelOpen) return;
      if (!wrap.contains(ev.target)) closePanel();
    });

    // ---- realtime ----
    function subscribe() {
      try {
        realtimeChannel = sb
          .channel('notifications:' + userId)
          .on('postgres_changes', {
            event: 'INSERT',
            schema: 'public',
            table: 'notifications',
            filter: 'recipient_id=eq.' + userId,
          }, (payload) => {
            const n = payload.new;
            unreadCount++;
            paintBadge();
            bump();
            spawnRipple();
            if (panelOpen) {
              prependItem({
                id: n.id, kind: n.kind, ref_id: n.ref_id,
                body: n.body, created_at: n.created_at,
                read_at: null,
              });
            }
          })
          .subscribe();
      } catch (e) {
        console.warn('[topbar] realtime subscribe failed:', e);
      }
    }

    // ---- bootstrap ----
    refreshList().then(subscribe);

    // Cleanup on page unload.
    window.addEventListener('beforeunload', () => {
      if (realtimeChannel) sb.removeChannel(realtimeChannel);
    });

    return { wrap, open: openPanel, close: closePanel, refresh: refreshList };
  }

  // Expose.
  window.recallTopbar = { mount: mount };

  // Auto-mount: if the page rendered a #bellSlot and a supabaseClient with a
  // session becomes available, mount ourselves. This avoids race conditions
  // where the page's `getSession().then(mountBell)` fires before this deferred
  // script has loaded — previously the bell would never appear.
  function tryAutoMount() {
    const slot = document.getElementById('bellSlot');
    if (!slot) return;
    if (slot.firstChild) return; // already mounted
    const sb = (typeof window !== 'undefined') ? window.supabaseClient : null;
    if (!sb || !sb.auth || typeof sb.auth.getSession !== 'function') return;
    sb.auth.getSession().then(function (res) {
      // Re-check inside the callback — the page's own mount may have raced
      // ahead and already populated the slot.
      if (!slot.firstChild && res && res.data && res.data.session && res.data.session.user) {
        mount('bellSlot', { supabaseClient: sb, user: res.data.session.user });
      }
    }).catch(function () { /* swallow */ });
    sb.auth.onAuthStateChange(function (_event, session) {
      if (session && session.user && !slot.firstChild) {
        mount('bellSlot', { supabaseClient: sb, user: session.user });
      }
    });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', tryAutoMount);
  } else {
    tryAutoMount();
  }
})();
