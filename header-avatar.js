// ============================================================================
// header-avatar.js — topbar avatar chip + dropdown menu.
// Loaded with <script defer> on every authenticated page that has a
// #avatarSlot. Self-contained: injects scoped CSS, builds DOM, wires events.
//
// Public API:
//   window.recallHeaderAvatar.mount(slotId, opts)
//     slotId — DOM id of an empty container (e.g. 'avatarSlot')
//     opts   — { supabaseClient, user, profile }
//       user    : { id, ... }   — required
//       profile : { full_name, role, avatar_url, ... } — required
//                  (callers usually fetch profiles WHERE id = user.id)
// Returns: { open, close, refresh } so callers can re-paint on updates.
// ============================================================================

(function () {
  'use strict';

  const STYLE_ID = 'recall-header-avatar-style';

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function initials(name) {
    if (!name) return '?';
    const parts = String(name).trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return '?';
    if (parts.length === 1) return parts[0].slice(0, 1).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }

  // Stable hue from a UUID — same colour for the same user on every page.
  function hueFromId(id) {
    if (!id) return 200;
    let h = 0;
    const s = String(id).replace(/-/g, '');
    for (let i = 0; i < s.length; i++) {
      h = (h * 31 + s.charCodeAt(i)) >>> 0;
    }
    return h % 360;
  }

  function roleLabel(role) {
    switch (role) {
      case 'staff_author':    return 'Author';
      case 'staff_reviewer':  return 'Reviewer';
      case 'admin':           return 'Admin';
      case 'school_organiser':return 'School';
      case 'teacher':         return 'Teacher';
      case 'student':         return 'Student';
      default:                return role || 'Member';
    }
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

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const css = `
.recall-avatar-wrap { position: relative; display: inline-flex; align-items: center; gap: 0; }
.recall-avatar-btn {
  background: transparent; border: 0; padding: 4px;
  color: var(--text); cursor: pointer; font-family: inherit;
  display: inline-flex; align-items: center; gap: 8px;
  border-radius: var(--r-sm);
}
.recall-avatar-btn:hover { background: var(--bg-3); }
.recall-avatar-btn:focus { outline: 2px solid var(--blue); outline-offset: 1px; }
.recall-avatar-circle {
  width: 30px; height: 30px;
  border-radius: 50%;
  background: var(--bg-3);
  display: inline-flex; align-items: center; justify-content: center;
  font-size: 12px; font-weight: 700;
  color: #fff;
  overflow: hidden;
  flex-shrink: 0;
}
.recall-avatar-circle img {
  width: 100%; height: 100%;
  object-fit: cover;
  display: block;
}
.recall-avatar-name {
  font-size: 13px;
  color: var(--text-2);
  max-width: 140px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.recall-avatar-caret {
  width: 8px; height: 8px;
  border-right: 2px solid var(--text-3);
  border-bottom: 2px solid var(--text-3);
  transform: rotate(45deg);
  margin-top: -3px;
  display: none;
}
@media (min-width: 720px) {
  .recall-avatar-caret { display: inline-block; }
}
.recall-avatar-menu {
  position: absolute;
  top: calc(100% + 8px);
  right: 0;
  min-width: 240px;
  background: var(--bg-2);
  border: 1px solid var(--line-2);
  border-radius: var(--r-md);
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.45);
  padding: 6px 0;
  z-index: 90;
  display: none;
}
.recall-avatar-menu.open { display: block; }
.recall-avatar-menu-head {
  display: flex; align-items: center; gap: 10px;
  padding: 12px 14px 10px;
  border-bottom: 1px solid var(--line-2);
  margin-bottom: 4px;
}
.recall-avatar-menu-head .meta { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.recall-avatar-menu-head .name {
  font-weight: 600; font-size: 13px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.recall-avatar-menu-head .role {
  font-size: 11px; color: var(--text-3);
}
.recall-avatar-menu-item {
  display: flex; align-items: center; gap: 10px;
  padding: 8px 14px;
  background: transparent; border: 0;
  color: var(--text); font-size: 13px;
  text-align: left; width: 100%;
  cursor: pointer; font-family: inherit;
  text-decoration: none;
}
.recall-avatar-menu-item:hover { background: var(--bg-3); }
.recall-avatar-menu-item.danger { color: var(--red); }
.recall-avatar-menu-sep {
  height: 1px;
  background: var(--line-2);
  margin: 4px 0;
}
.recall-avatar-menu-msg {
  padding: 6px 14px;
  font-size: 11px; color: var(--text-3);
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
    const name = (profile && profile.full_name) || 'You';
    if (url) {
      elt.innerHTML = `<img alt="" src="${escapeHtml(url)}">`;
    } else {
      const hue = hueFromId(id);
      elt.style.background = `hsl(${hue} 55% 38%)`;
      elt.textContent = initials(name);
    }
  }

  function mount(slotId, opts) {
    if (!opts || !opts.supabaseClient || !opts.user || !opts.profile) {
      return null;
    }
    const sb = opts.supabaseClient;
    const user = opts.user;
    let profile = opts.profile || {};

    const slot = document.getElementById(slotId);
    if (!slot) return null;
    if (slot.firstChild) {
      // Already mounted — return a no-op handle so callers that store the
      // return value can still guard against double-mounts.
      return { open: function () {}, close: function () {}, refresh: function () {} };
    }

    injectStyle();

    const wrap = document.createElement('div');
    wrap.className = 'recall-avatar-wrap';

    const btn = document.createElement('button');
    btn.className = 'recall-avatar-btn';
    btn.setAttribute('aria-haspopup', 'menu');
    btn.setAttribute('aria-expanded', 'false');

    const circle = document.createElement('span');
    circle.className = 'recall-avatar-circle';
    paintAvatar(circle, profile);

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
    paintAvatar(headCircle, profile);
    const meta = document.createElement('div');
    meta.className = 'meta';
    const headName = document.createElement('div');
    headName.className = 'name';
    headName.textContent = profile.full_name || 'Signed in';
    const headRole = document.createElement('div');
    headRole.className = 'role';
    headRole.textContent = roleLabel(profile.role);
    meta.appendChild(headName);
    meta.appendChild(headRole);
    head.appendChild(headCircle);
    head.appendChild(meta);
    menu.appendChild(head);

    const dashLink = document.createElement('a');
    dashLink.className = 'recall-avatar-menu-item';
    dashLink.href = dashboardUrl(profile.role);
    dashLink.textContent = 'My dashboard';
    menu.appendChild(dashLink);

    const profileLink = document.createElement('a');
    profileLink.className = 'recall-avatar-menu-item';
    profileLink.href = 'profile.html?id=' + encodeURIComponent(user.id);
    profileLink.textContent = 'My profile';
    menu.appendChild(profileLink);

    const uploadLabel = document.createElement('label');
    uploadLabel.className = 'recall-avatar-menu-item';
    uploadLabel.textContent = 'Upload avatar';
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'image/jpeg,image/png,image/webp';
    fileInput.hidden = true;
    uploadLabel.appendChild(fileInput);
    menu.appendChild(uploadLabel);

    const sep1 = document.createElement('div');
    sep1.className = 'recall-avatar-menu-sep';
    menu.appendChild(sep1);

    const signOutBtn = document.createElement('button');
    signOutBtn.className = 'recall-avatar-menu-item danger';
    signOutBtn.type = 'button';
    signOutBtn.textContent = 'Sign out';
    signOutBtn.addEventListener('click', async () => {
      try { await sb.auth.signOut(); } catch (_) { /* ignore */ }
      window.location.href = 'login.html';
    });
    menu.appendChild(signOutBtn);

    wrap.appendChild(btn);
    wrap.appendChild(menu);
    slot.appendChild(wrap);

    function openMenu() {
      menu.classList.add('open');
      btn.setAttribute('aria-expanded', 'true');
      // re-paint head circle in case the avatar updated since mount.
      paintAvatar(headCircle, profile);
    }
    function closeMenu() {
      menu.classList.remove('open');
      btn.setAttribute('aria-expanded', 'false');
    }

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (menu.classList.contains('open')) closeMenu();
      else openMenu();
    });
    document.addEventListener('click', (e) => {
      if (!wrap.contains(e.target)) closeMenu();
    });
    btn.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeMenu();
    });

    // Avatar upload.
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files && fileInput.files[0];
      fileInput.value = '';
      if (!file) return;
      const okTypes = ['image/jpeg', 'image/png', 'image/webp'];
      if (okTypes.indexOf(file.type) === -1) {
        if (typeof window.toast === 'function') window.toast('Image must be JPG, PNG, or WebP', 'error');
        return;
      }
      if (file.size > 2 * 1024 * 1024) {
        if (typeof window.toast === 'function') window.toast('Avatar must be under 2 MB', 'error');
        return;
      }

      const ext = (file.name.match(/\.(jpe?g|png|webp)$/i) || ['.jpg'])[0].toLowerCase();
      const objectPath = user.id + '/' + crypto.randomUUID() + ext;

      // Optimistic preview.
      const blobUrl = URL.createObjectURL(file);
      const prevSrc = circle.querySelector('img');
      circle.innerHTML = `<img alt="" src="${blobUrl}">`;
      headCircle.innerHTML = `<img alt="" src="${blobUrl}">`;

      let uploadErr = null;
      try {
        const { error } = await sb.storage.from('avatars')
          .upload(objectPath, file, { upsert: false, contentType: file.type });
        if (error) { uploadErr = error; }
      } catch (e) { uploadErr = e; }

      if (uploadErr) {
        URL.revokeObjectURL(blobUrl);
        paintAvatar(circle, profile);
        paintAvatar(headCircle, profile);
        if (typeof window.toast === 'function') window.toast('Avatar upload failed', 'error');
        return;
      }

      const { data: pub } = sb.storage.from('avatars').getPublicUrl(objectPath);
      const publicUrl = pub && pub.publicUrl ? pub.publicUrl : null;
      if (!publicUrl) {
        URL.revokeObjectURL(blobUrl);
        paintAvatar(circle, profile);
        paintAvatar(headCircle, profile);
        if (typeof window.toast === 'function') window.toast('Avatar upload failed', 'error');
        return;
      }

      try {
        const { error } = await sb.from('profiles').update({ avatar_url: publicUrl }).eq('id', user.id);
        if (error) throw error;
      } catch (e) {
        URL.revokeObjectURL(blobUrl);
        paintAvatar(circle, profile);
        paintAvatar(headCircle, profile);
        if (typeof window.toast === 'function') window.toast('Could not save avatar', 'error');
        return;
      }

      profile.avatar_url = publicUrl;
      URL.revokeObjectURL(blobUrl);
      paintAvatar(circle, profile);
      paintAvatar(headCircle, profile);
      if (typeof window.toast === 'function') window.toast('Avatar updated', 'success');
    });

    function refresh(nextProfile) {
      if (nextProfile) profile = nextProfile;
      paintAvatar(circle, profile);
      paintAvatar(headCircle, profile);
      nameEl.textContent = profile.full_name || '';
    }

    return { open: openMenu, close: closeMenu, refresh };
  }

  window.recallHeaderAvatar = { mount: mount };

  // Auto-mount: if the page rendered an #avatarSlot and a supabaseClient is
  // available, mount ourselves once we have a user. Avoids races where the
  // page's `getSession().then(mountHeaderAvatar)` fires before this deferred
  // script has loaded — previously the avatar pill would never appear.
  function tryAutoMount() {
    const slot = document.getElementById('avatarSlot');
    if (!slot) return;
    if (slot.firstChild) return; // already mounted
    const sb = (typeof window !== 'undefined') ? window.supabaseClient : null;
    if (!sb || !sb.auth || typeof sb.auth.getSession !== 'function') return;
    sb.auth.getSession().then(function (res) {
      // Re-check inside the callback — the page's own mount may have raced
      // ahead and already populated the slot.
      if (!slot.firstChild && res && res.data && res.data.session && res.data.session.user) {
        mount('avatarSlot', { supabaseClient: sb, user: res.data.session.user });
      }
    }).catch(function () { /* swallow */ });
    sb.auth.onAuthStateChange(function (_event, session) {
      if (session && session.user && !slot.firstChild) {
        mount('avatarSlot', { supabaseClient: sb, user: session.user });
      }
    });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', tryAutoMount);
  } else {
    tryAutoMount();
  }
})();