// profile.js
//
// Profile page. Self-view when URL has no `?id=` (or matches the caller);
// otherwise views another user's profile. Follows / likes are mutual-edge /
// single-like respectively; helpers from header-avatar.js are duplicated
// here because modules are intentionally IIFE-isolated.
//
// Public surface:
//   window.recallProfile = { mount }
//
(function () {
  'use strict';

  // -------------------------------------------------------------------
  // helpers (intentional duplicates from header-avatar.js — modules are
  // IIFE-isolated and that file is bootstrap-only)
  // -------------------------------------------------------------------

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

  function uuidValidate(s) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(s || ''));
  }

  function parseTargetId() {
    const q = new URLSearchParams(location.search).get('id');
    return q && uuidValidate(q) ? q : null;
  }

  function paintAvatarBig(box, profile) {
    box.innerHTML = '';
    if (profile && profile.avatar_url) {
      const img = document.createElement('img');
      img.alt = '';
      img.src = profile.avatar_url;
      box.appendChild(img);
    } else {
      box.style.background = 'hsl(' + hueFromId((profile && profile.id) || '00000000') + ' 55% 38%)';
      box.textContent = initials((profile && profile.full_name) || '?');
    }
  }

  function paintAvatarSmall(box, r) {
    box.innerHTML = '';
    if (r && r.avatar_url) {
      const img = document.createElement('img');
      img.alt = '';
      img.src = r.avatar_url;
      box.appendChild(img);
    } else {
      box.style.background = 'hsl(' + hueFromId((r && r.id) || '00000000') + ' 55% 38%)';
      box.textContent = initials((r && r.full_name) || '?');
    }
  }

  // -------------------------------------------------------------------
  // load() — runs once on DOMContentLoaded
  // -------------------------------------------------------------------

  async function load() {
    const sb = window.supabaseClient;
    if (!sb) {
      showError('Sign-in required — redirecting.');
      window.location.href = 'login.html';
      return;
    }

    let session = null;
    try {
      const { data } = await sb.auth.getSession();
      session = data && data.session ? data.session : null;
    } catch (_) {}
    if (!session || !session.user) {
      window.location.href = 'login.html';
      return;
    }
    const user = session.user;

    let me = null;
    try {
      const { data: meRow } = await sb
        .from('profiles')
        .select('id, full_name, role, avatar_url, school_id')
        .eq('id', user.id)
        .maybeSingle();
      me = meRow || { id: user.id, full_name: user.user_metadata?.full_name || '', role: '', avatar_url: null, school_id: null };
    } catch (_) {
      me = { id: user.id, full_name: user.user_metadata?.full_name || '', role: '', avatar_url: null, school_id: null };
    }

    if (window.recallTopbar && typeof window.recallTopbar.mount === 'function') {
      try {
        window.recallTopbar.mount('bellSlot', { supabaseClient: sb, user: user });
      } catch (e) { console.error('topbar mount failed:', e); }
    }
    if (window.recallHeaderAvatar && typeof window.recallHeaderAvatar.mount === 'function') {
      try {
        window.recallHeaderAvatar.mount('avatarSlot', {
          supabaseClient: sb,
          user: user,
          profile: me
        });
      } catch (e) { console.error('headerAvatar mount failed:', e); }
    }

    const signOutBtn = document.getElementById('signOutBtn');
    if (signOutBtn) {
      signOutBtn.hidden = false;
      signOutBtn.addEventListener('click', async () => {
        try { await sb.auth.signOut(); } catch (_) { /* ignore */ }
        window.location.href = 'login.html';
      });
    }

    const targetId = parseTargetId() || user.id;
    mount({ supabaseClient: sb, user: user, profile: me, targetId: targetId });
  }

  // -------------------------------------------------------------------
  // mount — wires the page
  // -------------------------------------------------------------------

  function mount(opts) {
    const sb = opts.supabaseClient;
    const user = opts.user;
    const me = opts.profile;
    const targetId = opts.targetId;
    const isSelf = targetId === user.id;
    let realtimeChannel = null;

    function showError(msg) {
      const el = document.getElementById('errorLine');
      if (!el) return;
      el.textContent = msg;
      el.hidden = false;
    }

    async function refresh() {
      try {
        const { data, error } = await sb.rpc('get_profile_for_view', { p_target_id: targetId });
        if (error) throw error;
        if (!data || data.found === false) {
          showError('Profile not found.');
          document.getElementById('profileCard').hidden = true;
          return;
        }
        render(data);
      } catch (e) {
        showError('Could not load profile.');
        console.error('get_profile_for_view failed:', e);
      }
    }

    function render(p) {
      document.getElementById('profileCard').hidden = false;

      // header
      paintAvatarBig(document.getElementById('avatarBig'), p);
      document.getElementById('displayName').textContent = p.full_name || 'Unnamed';

      const pill = document.getElementById('rolePill');
      pill.textContent = roleLabel(p.role);
      pill.className = 'role-pill role-' + (p.role || '');

      const schoolLine = document.getElementById('schoolLine');
      const schoolName = p.school_name || '';
      schoolLine.textContent = schoolName ? ('At ' + schoolName) : '';

      // bio
      const bioText = document.getElementById('bioText');
      const bioBtn = document.getElementById('editBioBtn');
      if (p.bio && String(p.bio).trim()) {
        bioText.textContent = p.bio;
        bioText.classList.remove('empty');
      } else {
        bioText.textContent = isSelf ? "You haven't written a bio yet." : "This user hasn't written a bio.";
        bioText.classList.add('empty');
      }
      bioBtn.hidden = !isSelf;

      // action buttons
      const followBtn = document.getElementById('followBtn');
      const likeBtn = document.getElementById('likeBtn');
      const messageBtn = document.getElementById('messageBtn');
      followBtn.hidden = isSelf;
      likeBtn.hidden = isSelf;
      messageBtn.hidden = isSelf;

      if (!isSelf) {
        const callerFollows = !!p.caller_follows_target;
        followBtn.textContent = callerFollows ? 'Unfollow' : 'Follow';
        followBtn.classList.toggle('is-following', callerFollows);
        likeBtn.classList.toggle('is-liked', !!p.caller_likes_this_profile);
        document.getElementById('likeCount').textContent = String(p.likes_count || 0);
      }

      // stats
      document.getElementById('statFollowers').textContent = String(p.follower_count || 0);
      document.getElementById('statFollowing').textContent = String(p.following_count || 0);
      document.getElementById('statMutuals').textContent = String(p.mutual_friend_count_with_caller || 0);
      document.getElementById('statLikedBy').textContent = String(p.likes_count || 0);

      // mutuals grid
      const grid = document.getElementById('mutualsGrid');
      grid.innerHTML = '';
      const ms = Array.isArray(p.recent_mutuals) ? p.recent_mutuals : [];
      if (!ms.length) {
        const empty = document.createElement('div');
        empty.style.color = 'var(--text-3)';
        empty.style.fontSize = '13px';
        empty.style.padding = '16px 0';
        empty.textContent = isSelf
          ? 'When you and another user follow each other, you\'ll see them here.'
          : 'No mutual friends yet.';
        grid.appendChild(empty);
      } else {
        ms.forEach((m) => grid.appendChild(mutualCard(m)));
      }
    }

    function mutualCard(m) {
      const a = document.createElement('a');
      a.className = 'mutual-card';
      a.href = 'profile.html?id=' + encodeURIComponent(m.id);
      a.target = '_blank';
      a.rel = 'noopener';

      const av = document.createElement('div');
      av.className = 'mutual-avatar';
      paintAvatarSmall(av, m);
      a.appendChild(av);

      const nm = document.createElement('div');
      nm.className = 'mutual-name';
      nm.textContent = m.full_name || 'Unknown';
      a.appendChild(nm);

      const ro = document.createElement('div');
      ro.className = 'mutual-role';
      ro.textContent = roleLabel(m.role);
      a.appendChild(ro);

      return a;
    }

    // ----- Follow -----
    const followBtn = document.getElementById('followBtn');
    followBtn.addEventListener('click', async () => {
      if (followBtn.disabled) return;
      followBtn.disabled = true;
      try {
        const { data, error } = await sb.rpc('toggle_follow', { p_target_id: targetId });
        if (error) throw error;
        if (data) {
          followBtn.textContent = data.is_following ? 'Unfollow' : 'Follow';
          followBtn.classList.toggle('is-following', !!data.is_following);
        }
        await refresh();
      } catch (e) {
        showError('Could not update follow. Try again.');
        console.error('toggle_follow failed:', e);
      } finally {
        followBtn.disabled = false;
      }
    });

    // ----- Like -----
    const likeBtn = document.getElementById('likeBtn');
    likeBtn.addEventListener('click', async () => {
      if (likeBtn.disabled) return;
      likeBtn.disabled = true;
      try {
        const { data, error } = await sb.rpc('toggle_profile_like', { p_target_id: targetId });
        if (error) throw error;
        if (data) {
          document.getElementById('likeCount').textContent = String(data.likes_count || 0);
          document.getElementById('statLikedBy').textContent = String(data.likes_count || 0);
          likeBtn.classList.toggle('is-liked', !!data.liked);
        }
      } catch (e) {
        showError('Could not update like. Try again.');
        console.error('toggle_profile_like failed:', e);
      } finally {
        likeBtn.disabled = false;
      }
    });

    // ----- Message -----
    const messageBtn = document.getElementById('messageBtn');
    messageBtn.addEventListener('click', () => {
      if (window.recallChat && typeof window.recallChat.openWithUser === 'function') {
        try {
          window.recallChat.openWithUser(targetId);
          return;
        } catch (_) { /* fall through */ }
      }
      // Fallback — no chat module mounted (e.g. students); bounce to the
      // chat-incapable profile reload of self. Avoids a dead button.
      showError('Chat isn\'t available on this account.');
    });

    // ----- Bio edit (self only) -----
    if (isSelf) {
      const bioBtn = document.getElementById('editBioBtn');
      const bioForm = document.getElementById('bioForm');
      const bioInput = document.getElementById('bioInput');
      const bioTextEl = document.getElementById('bioText');
      const bioCounter = document.getElementById('bioCounter');
      const bioSave = document.getElementById('bioSave');
      const bioCancel = document.getElementById('bioCancel');

      function updateCounter() {
        const len = (bioInput.value || '').length;
        bioCounter.textContent = len + ' / 500';
      }

      bioBtn.addEventListener('click', () => {
        bioInput.value = (bioTextEl.textContent && !bioTextEl.classList.contains('empty')) ? bioTextEl.textContent : '';
        bioInput.value = bioInput.value === "You haven't written a bio yet." ? '' : bioInput.value;
        updateCounter();
        bioTextEl.hidden = true;
        document.querySelector('#profileCard .profile-bio-actions').hidden = true;
        bioForm.hidden = false;
        bioInput.focus();
        // Move caret to end.
        const v = bioInput.value;
        bioInput.value = '';
        bioInput.value = v;
      });

      bioCancel.addEventListener('click', () => {
        bioForm.hidden = true;
        bioTextEl.hidden = false;
        document.querySelector('#profileCard .profile-bio-actions').hidden = false;
      });

      bioInput.addEventListener('input', updateCounter);

      bioForm.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        bioSave.disabled = true;
        try {
          const { error } = await sb.rpc('set_my_bio', { p_bio: bioInput.value });
          if (error) throw error;
          const newBio = (bioInput.value || '').trim();
          if (newBio) {
            bioTextEl.textContent = newBio;
            bioTextEl.classList.remove('empty');
          } else {
            bioTextEl.textContent = "You haven't written a bio yet.";
            bioTextEl.classList.add('empty');
          }
          bioForm.hidden = true;
          bioTextEl.hidden = false;
          document.querySelector('#profileCard .profile-bio-actions').hidden = false;
        } catch (e) {
          showError('Could not save bio.');
          console.error('set_my_bio failed:', e);
        } finally {
          bioSave.disabled = false;
        }
      });
    }

    // ----- Search -----
    const searchInput = document.getElementById('searchInput');
    const searchResults = document.getElementById('searchResults');
    let searchDebounce = null;
    function clearSearch() {
      searchResults.hidden = true;
      searchResults.innerHTML = '';
    }
    searchInput.addEventListener('input', () => {
      clearTimeout(searchDebounce);
      const q = searchInput.value.trim();
      if (!q) { clearSearch(); return; }
      searchDebounce = setTimeout(async () => {
        try {
          const { data, error } = await sb.rpc('search_profiles_for_follow', {
            p_query: q,
            p_limit: 8
          });
          if (error) throw error;
          searchResults.innerHTML = '';
          const rows = Array.isArray(data) ? data : [];
          if (!rows.length) {
            const empty = document.createElement('div');
            empty.style.padding = '14px';
            empty.style.color = 'var(--text-3)';
            empty.style.fontSize = '13px';
            empty.textContent = 'No matches.';
            searchResults.appendChild(empty);
          } else {
            rows.forEach((r) => {
              const a = document.createElement('a');
              a.className = 'search-hit';
              a.href = 'profile.html?id=' + encodeURIComponent(r.id);
              a.target = '_blank';
              a.rel = 'noopener';

              const av = document.createElement('div');
              av.className = 'mutual-avatar';
              paintAvatarSmall(av, r);
              a.appendChild(av);

              const nm = document.createElement('span');
              nm.className = 'search-hit-name';
              nm.textContent = r.full_name || 'Unknown';
              a.appendChild(nm);

              const ro = document.createElement('span');
              ro.className = 'search-hit-role';
              ro.textContent = roleLabel(r.role);
              a.appendChild(ro);

              searchResults.appendChild(a);
            });
          }
          searchResults.hidden = false;
        } catch (e) {
          console.error('search_profiles_for_follow failed:', e);
        }
      }, 180);
    });
    document.addEventListener('click', (ev) => {
      if (!document.querySelector('.profile-search').contains(ev.target)) {
        clearSearch();
      }
    });

    // ----- Stats modal -----
    const listModal = document.getElementById('listModal');
    const listTitle = document.getElementById('listModalTitle');
    const listBody = document.getElementById('listModalBody');
    const listClose = document.getElementById('listClose');
    listClose.addEventListener('click', () => { listModal.hidden = true; });
    listModal.addEventListener('click', (ev) => {
      if (ev.target === listModal) listModal.hidden = true;
    });
    document.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape' && !listModal.hidden) listModal.hidden = true;
    });

    function openList(kind) {
      listTitle.textContent = ({
        followers: 'Followers',
        following: 'Following',
        mutuals:   'Mutual friends'
      })[kind] || 'List';
      listBody.innerHTML = '';
      const loading = document.createElement('div');
      loading.className = 'modal-list-empty';
      loading.textContent = 'Loading…';
      listBody.appendChild(loading);
      listModal.hidden = false;

      const rpcName = ({
        followers: 'list_profile_followers',
        following: 'list_profile_following',
        mutuals:   'list_profile_mutuals_with_me'
      })[kind];
      if (!rpcName) return;
      sb.rpc(rpcName, { p_target: targetId, p_limit: 50 })
        .then(({ data, error }) => {
          if (error) throw error;
          const rows = Array.isArray(data) ? data : [];
          listBody.innerHTML = '';
          if (!rows.length) {
            const empty = document.createElement('div');
            empty.className = 'modal-list-empty';
            empty.textContent = 'Nothing here yet.';
            listBody.appendChild(empty);
            return;
          }
          rows.forEach((r) => {
            const a = document.createElement('a');
            a.className = 'modal-list-item';
            a.href = 'profile.html?id=' + encodeURIComponent(r.id);
            a.target = '_blank';
            a.rel = 'noopener';

            const av = document.createElement('div');
            av.className = 'mutual-avatar';
            paintAvatarSmall(av, r);
            a.appendChild(av);

            const nm = document.createElement('span');
            nm.className = 'search-hit-name';
            nm.textContent = r.full_name || 'Unknown';
            a.appendChild(nm);

            const ro = document.createElement('span');
            ro.className = 'search-hit-role';
            ro.textContent = roleLabel(r.role);
            a.appendChild(ro);

            listBody.appendChild(a);
          });
        })
        .catch((e) => {
          console.error(rpcName + ' failed:', e);
          listBody.innerHTML = '';
          const empty = document.createElement('div');
          empty.className = 'modal-list-empty';
          empty.textContent = 'Could not load list.';
          listBody.appendChild(empty);
        });
    }

    document.querySelectorAll('.profile-stats .stat[data-open]').forEach((btn) => {
      btn.addEventListener('click', () => openList(btn.dataset.open));
    });

    // ----- Realtime (self-view only) -----
    if (isSelf) {
      try {
        realtimeChannel = sb
          .channel('profile-self:' + user.id)
          .on('postgres_changes', {
            event: '*', schema: 'public', table: 'profile_follows',
            filter: 'followee_id=eq.' + user.id
          }, () => refresh())
          .on('postgres_changes', {
            event: '*', schema: 'public', table: 'profile_follows',
            filter: 'follower_id=eq.' + user.id
          }, () => refresh())
          .on('postgres_changes', {
            event: '*', schema: 'public', table: 'profile_likes',
            filter: 'profile_id=eq.' + user.id
          }, () => refresh())
          .subscribe();
      } catch (e) { console.error('realtime subscribe failed:', e); }
    }
    window.addEventListener('beforeunload', () => {
      if (realtimeChannel && sb && typeof sb.removeChannel === 'function') {
        try { sb.removeChannel(realtimeChannel); } catch (_) { /* ignore */ }
      }
    });

    refresh();
  }

  window.recallProfile = { mount: mount };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', load);
  } else {
    load();
  }
})();
