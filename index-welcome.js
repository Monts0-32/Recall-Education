// ============================================================================
// index-welcome.js — homepage welcome bar
// Loaded ONLY on index.html after the Supabase SDK + a global
// `supabaseClient` is in place. If a session exists (and the user opted
// into "keep me signed in"), render a sticky bar above <nav class="top">
// with avatar + name + bell + "Go to dashboard" + sign-out.
// ============================================================================

(function () {
  'use strict';

  const STYLE_ID = 'recall-index-welcome-style';

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function initials(name) {
    if (!name) return '?';
    const parts = String(name).trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    if (parts.length === 1) return parts[0].slice(0, 1).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }

  function hueFromId(id) {
    if (!id) return 200;
    let h = 0;
    const s = String(id).replace(/-/g, '');
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return h % 360;
  }

  function dashboardUrl(role) {
    switch (role) {
      case 'staff_author':
      case 'staff_reviewer':
      case 'admin':
        return 'staff-dashboard.html';
      case 'school_organiser':
        return 'school-organiser-dashboard.html';
      case 'teacher':
        return 'teacher-dashboard.html';
      default:
        return 'dashboard.html';
    }
  }

  function roleLabel(role) {
    switch (role) {
      case 'staff_author': return 'Author';
      case 'staff_reviewer': return 'Reviewer';
      case 'admin': return 'Admin';
      case 'school_organiser': return 'School';
      case 'teacher': return 'Teacher';
      default: return 'Member';
    }
  }

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const css = `
.recall-welcome-bar {
  position: sticky;
  top: 0;
  z-index: 100;
  background: var(--bg-2);
  border-bottom: 1px solid var(--line-2);
  box-shadow: 0 2px 8px rgba(0,0,0,0.18);
}
.recall-welcome-bar-inner {
  max-width: 1200px;
  margin: 0 auto;
  padding: 10px 24px;
  display: flex; align-items: center; gap: 14px;
  font-size: 13px;
  color: var(--text-2);
}
.recall-welcome-bar-avatar {
  width: 30px; height: 30px;
  border-radius: 50%;
  background: var(--bg-3);
  display: inline-flex; align-items: center; justify-content: center;
  font-size: 12px; font-weight: 700; color: #fff;
  overflow: hidden;
  flex-shrink: 0;
}
.recall-welcome-bar-avatar img { width: 100%; height: 100%; object-fit: cover; }
.recall-welcome-bar-text {
  flex: 1; min-width: 0;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.recall-welcome-bar-text strong { color: var(--text); }
.recall-welcome-bar-actions { display: flex; align-items: center; gap: 10px; }
.recall-welcome-bar-actions a, .recall-welcome-bar-actions button {
  background: transparent;
  border: 1px solid var(--line-2);
  color: var(--text-2);
  border-radius: var(--r-sm);
  padding: 4px 10px;
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
  text-decoration: none;
}
.recall-welcome-bar-actions a:hover, .recall-welcome-bar-actions button:hover {
  background: var(--bg-3); color: var(--text);
}
.recall-welcome-bar-actions .signout { color: var(--red); border-color: rgba(248,81,73,0.3); }
.recall-welcome-bar-actions .signout:hover { background: rgba(248,81,73,0.08); }
.recall-welcome-bar-bell {
  display: inline-flex; align-items: center; justify-content: center;
}
@media (max-width: 640px) {
  .recall-welcome-bar-text { display: none; }
}
    `;
    const tag = document.createElement('style');
    tag.id = STYLE_ID;
    tag.textContent = css;
    document.head.appendChild(tag);
  }

  function paintAvatar(elt, profile) {
    const id = profile && profile.id ? profile.id : null;
    const url = profile && profile.avatar_url ? profile.avatar_url : null;
    const name = (profile && profile.full_name) || '';
    if (url) {
      elt.innerHTML = `<img alt="" src="${escapeHtml(url)}">`;
    } else {
      elt.style.background = `hsl(${hueFromId(id)} 55% 38%)`;
      elt.textContent = initials(name);
    }
  }

  async function mount() {
    if (typeof window.supabase === 'undefined' || !window.supabaseClient) return;
    const sb = window.supabaseClient;

    let session = null;
    try {
      const { data } = await sb.auth.getSession();
      session = data && data.session ? data.session : null;
    } catch (_) { return; }
    if (!session || !session.user) return;

    const user = session.user;

    // Fetch profile (with avatar_url).
    let profile = { id: user.id, full_name: '', role: '', avatar_url: null };
    try {
      const { data: p, error } = await sb
        .from('profiles')
        .select('id, full_name, role, avatar_url')
        .eq('id', user.id)
        .single();
      if (error) throw error;
      if (p) {
        profile.id = p.id;
        profile.full_name = p.full_name || '';
        profile.role = p.role || '';
        profile.avatar_url = p.avatar_url || null;
      }
    } catch (_) { /* keep defaults */ }

    // Fallback to JWT metadata if profile row is empty.
    if (!profile.role && user.app_metadata && user.app_metadata.role) {
      profile.role = user.app_metadata.role;
    }

    injectStyle();

    // Insert above <nav class="top">.
    const nav = document.querySelector('nav.top');
    if (!nav) return;
    if (nav.previousElementSibling && nav.previousElementSibling.classList.contains('recall-welcome-bar')) return;

    const bar = document.createElement('div');
    bar.className = 'recall-welcome-bar';
    const inner = document.createElement('div');
    inner.className = 'recall-welcome-bar-inner';

    const av = document.createElement('div');
    av.className = 'recall-welcome-bar-avatar';
    paintAvatar(av, profile);
    inner.appendChild(av);

    const txt = document.createElement('div');
    txt.className = 'recall-welcome-bar-text';
    const greeting = document.createElement('span');
    greeting.innerHTML = 'Welcome back, <strong>' + escapeHtml(profile.full_name || 'there') + '</strong>';
    txt.appendChild(greeting);
    inner.appendChild(txt);

    const actions = document.createElement('div');
    actions.className = 'recall-welcome-bar-actions';

    // Bell slot.
    const bellSlot = document.createElement('div');
    bellSlot.className = 'recall-welcome-bar-bell';
    bellSlot.id = 'welcomeBellSlot';
    actions.appendChild(bellSlot);

    const dashLink = document.createElement('a');
    dashLink.href = dashboardUrl(profile.role);
    dashLink.textContent = 'Go to dashboard';
    actions.appendChild(dashLink);

    const signOutBtn = document.createElement('button');
    signOutBtn.type = 'button';
    signOutBtn.className = 'signout';
    signOutBtn.textContent = 'Sign out';
    signOutBtn.addEventListener('click', async () => {
      try { await sb.auth.signOut(); } catch (_) { /* ignore */ }
      window.location.href = 'login.html';
    });
    actions.appendChild(signOutBtn);

    inner.appendChild(actions);
    bar.appendChild(inner);
    nav.parentNode.insertBefore(bar, nav);

    // Mount bell inside the bar.
    if (typeof window.recallTopbar === 'object' && typeof window.recallTopbar.mount === 'function') {
      try {
        window.recallTopbar.mount('welcomeBellSlot', {
          supabaseClient: sb,
          user: user
        });
      } catch (_) { /* ignore */ }
    }
  }

  window.recallIndexWelcome = { mount: mount };
})();