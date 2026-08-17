// ============================================================================
// profile.js — Profile page module.
// Mirrors the boot / chrome shape used by staff-dashboard.html so the page
// looks and behaves like every other authenticated surface on the site:
//   * top nav (bell + avatar + sign-out) revealed only after auth
//   * gate card for signed-out / error states
//   * main content built from the same .card rhythm as the dashboard
//
// All profile data is loaded via SECURITY DEFINER RPCs:
//   * get_profile_for_view(p_target_id)  -> one JSONB
//   * set_my_bio(p_bio)                   -> void
//   * toggle_follow(p_target_id)          -> JSONB
//   * toggle_profile_like(p_target_id)    -> JSONB
//   * search_profiles_for_follow(q, lim)  -> setof
//   * list_profile_followers / _following / _mutuals_with_me -> setof
// ============================================================================

(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Supabase client — same shape as every other page.
  // ---------------------------------------------------------------------------
  const SUPABASE_URL = 'https://hkjiyibpeqdoqzlyqzwz.supabase.co';
  const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imhraml5aWJwZXFkb3F6bHlxend6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM4MzkxNDgsImV4cCI6MjA5OTQxNTE0OH0.UGVZ0-b9-c7JVtu006mmyfj0NkIbpmmn0wCNNqdi9iU';
  const KEEP_KEY = 'recall.keepSignedIn';
  let keepSignedIn = true;
  try {
    const raw = localStorage.getItem(KEEP_KEY);
    if (raw === '0') keepSignedIn = false;
    else if (raw === '1') keepSignedIn = true;
    else localStorage.setItem(KEEP_KEY, '1');
  } catch (_) { /* private mode etc. */ }
  const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    persistSession: keepSignedIn,
    autoRefreshToken: keepSignedIn,
    detectSessionInUrl: true,
    global: {
      fetch: (url, options = {}) => {
        try {
          const u = new URL(url, window.location.href);
          if (u.host.endsWith('.supabase.co') && !u.searchParams.has('apikey')) {
            u.searchParams.set('apikey', SUPABASE_ANON_KEY);
          }
          return fetch(u.toString(), options);
        } catch (_) {
          return fetch(url, options);
        }
      }
    }
  });
  window.supabaseClient = supabaseClient;

  // ---------------------------------------------------------------------------
  // Tiny helpers (mirror staff-dashboard.html).
  // ---------------------------------------------------------------------------
  const $ = (id) => document.getElementById(id);
  const escapeHtml = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  function toast(msg, kind) {
    const wrap = $('toastWrap');
    if (!wrap) return;
    const t = document.createElement('div');
    t.className = 'toast' + (kind ? ' ' + kind : '');
    t.textContent = msg;
    wrap.appendChild(t);
    setTimeout(() => t.remove(), 3200);
  }

  function initialsOf(name) {
    if (!name) return '?';
    const parts = String(name).trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    if (parts.length === 1) return parts[0].slice(0, 1).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }

  function hueOf(id) {
    if (!id) return 200;
    let h = 0;
    const s = String(id).replace(/-/g, '');
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return h % 360;
  }

  function paintAvatar(elt, p, sizePx) {
    if (!elt) return;
    if (sizePx) { elt.style.width = sizePx + 'px'; elt.style.height = sizePx + 'px'; }
    if (p && p.avatar_url) {
      elt.innerHTML = '<img alt="" src="' + escapeHtml(p.avatar_url) + '">';
    } else {
      const hue = hueOf(p && p.id);
      elt.style.background = 'hsl(' + hue + ' 55% 38%)';
      elt.textContent = initialsOf(p && p.full_name);
    }
  }

  function roleLabel(r) {
    switch (r) {
      case 'staff_author':     return 'Author';
      case 'staff_reviewer':   return 'Reviewer';
      case 'admin':            return 'Admin';
      case 'school_organiser': return 'School';
      case 'teacher':          return 'Teacher';
      case 'student':          return 'Student';
      default:                 return r || 'Member';
    }
  }

  function parseTargetId() {
    const raw = new URLSearchParams(location.search).get('id');
    if (!raw) return null;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)) return null;
    return raw.toLowerCase();
  }

  function el(tag, attrs, children) {
    const e = document.createElement(tag);
    if (attrs) {
      for (const k in attrs) {
        if (k === 'class') e.className = attrs[k];
        else if (k === 'text') e.textContent = attrs[k];
        else if (k === 'html') e.innerHTML = attrs[k];
        else if (k === 'style' && typeof attrs[k] === 'object') Object.assign(e.style, attrs[k]);
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

  // ---------------------------------------------------------------------------
  // Page state.
  // ---------------------------------------------------------------------------
  const state = {
    user: null,
    me: null,        // caller's profile row
    targetId: null,
    target: null,    // get_profile_for_view JSON
    isSelf: false,
    channel: null,
  };

  // ---------------------------------------------------------------------------
  // Gate / show main.
  // ---------------------------------------------------------------------------
  function showGate(title, msg) {
    $('profileNav').hidden = true;
    $('profileMain').hidden = true;
    $('gate').hidden = false;
    $('gateTitle').textContent = title;
    $('gateMsg').textContent = msg;
  }

  function showMain() {
    $('gate').hidden = true;
    $('profileNav').hidden = false;
    $('profileMain').hidden = false;
  }

  // ---------------------------------------------------------------------------
  // Render — paints every card from state.target.
  // ---------------------------------------------------------------------------
  function render() {
    const p = state.target;
    const me = state.me;
    const isSelf = state.isSelf;

    // Identity.
    const name = (p.full_name || '').trim() || 'Unnamed';

    $('displayName').textContent = name;
    paintAvatar($('avatarBig'), p, 64);

    const pill = $('rolePill');
    pill.className = 'role-pill ' + (p.role || '');
    pill.textContent = roleLabel(p.role);

    const school = $('schoolLine');
    if (p.school_name) {
      school.textContent = p.school_name;
      school.hidden = false;
    } else {
      school.hidden = true;
    }

    // Identity card is always visible while we have a target.
    $('identityCard').hidden = false;

    // Bio.
    const bioText = $('bioText');
    if (p.bio && p.bio.trim()) {
      bioText.textContent = p.bio;
      bioText.classList.remove('empty');
    } else {
      bioText.textContent = isSelf
        ? "You haven't written a bio yet."
        : (name + ' hasn’t written a bio yet.');
      bioText.classList.add('empty');
    }
    $('bioCard').hidden = false;
    if (isSelf) {
      $('bioActions').hidden = false;
      $('editBioBtn').hidden = false;
    } else {
      $('bioActions').hidden = true;
      $('editBioBtn').hidden = true;
    }

    // Actions.
    $('actionsCard').hidden = false;
    if (isSelf) {
      $('followBtn').hidden = true;
      $('messageBtn').hidden = true;
      $('likeBtn').hidden = true;
    } else {
      $('followBtn').hidden = false;
      const isFollowing = !!p.caller_follows_target;
      $('followBtn').textContent = isFollowing ? 'Unfollow' : 'Follow';
      $('followBtn').classList.toggle('is-following', isFollowing);
      $('messageBtn').hidden = false;
      $('likeBtn').hidden = false;
      $('likeCount').textContent = String(p.likes_count || 0);
      $('likeBtn').classList.toggle('is-liked', !!p.caller_likes_this_profile);
    }

    // Stats.
    $('statsCard').hidden = false;
    $('statFollowers').textContent = String(p.follower_count || 0);
    $('statFollowing').textContent = String(p.following_count || 0);
    $('statMutuals').textContent = String(p.mutual_friend_count_with_caller || 0);
    $('statLikedBy').textContent = String(p.likes_count || 0);

    // Mutuals grid.
    const mutuals = Array.isArray(p.recent_mutuals) ? p.recent_mutuals : [];
    const grid = $('mutualsGrid');
    grid.innerHTML = '';
    if (isSelf) {
      $('mutualsCard').hidden = true;
    } else if (mutuals.length === 0) {
      $('mutualsCard').hidden = false;
      $('mutualsMeta').textContent = '';
      grid.appendChild(el('div', { class: 'card-empty', text:
        'When you and ' + (p.full_name || 'this person') + ' follow each other, you’ll see them here.'
      }));
    } else {
      $('mutualsCard').hidden = false;
      $('mutualsMeta').textContent = mutuals.length + (mutuals.length === 1 ? ' friend' : ' friends');
      for (const m of mutuals) {
        const tile = el('a', {
          class: 'mutual-tile',
          href: 'profile.html?id=' + encodeURIComponent(m.id),
          target: '_blank', rel: 'noopener',
        });
        const av = el('div', { class: 'av' });
        paintAvatar(av, m);
        tile.appendChild(av);
        tile.appendChild(el('div', { class: 'name', text: m.full_name || 'Unnamed' }));
        tile.appendChild(el('span', { class: 'role-pill ' + (m.role || ''), text: roleLabel(m.role) }));
        grid.appendChild(tile);
      }
    }

    // Search card is for everyone; the RPC excludes the caller anyway.
    $('searchCard').hidden = false;
  }

  // ---------------------------------------------------------------------------
  // Fetch + repaint the profile view.
  // ---------------------------------------------------------------------------
  async function refresh() {
    try {
      const { data, error } = await supabaseClient.rpc('get_profile_for_view', {
        p_target_id: state.targetId,
      });
      if (error) throw error;
      if (!data || data.found === false) {
        showGate('Profile not found', 'No profile matches that id.');
        return;
      }
      state.target = data;
      render();
    } catch (e) {
      console.error('get_profile_for_view failed:', e);
      showGate('Could not load profile', 'Try refreshing.');
    }
  }

  // ---------------------------------------------------------------------------
  // Bio editor.
  // ---------------------------------------------------------------------------
  function wireBio() {
    const bioBtn   = $('editBioBtn');
    const bioForm  = $('bioForm');
    const bioInput = $('bioInput');
    const bioCount = $('bioCounter');
    const bioSave  = $('bioSave');
    const bioCancel= $('bioCancel');
    const bioText  = $('bioText');

    function openForm() {
      const current = (state.target && state.target.bio) || '';
      bioInput.value = current;
      bioCount.textContent = bioInput.value.length + ' / 500';
      bioForm.hidden = false;
      bioBtn.hidden = true;
      bioText.hidden = true;
      bioInput.focus();
      // Caret to end.
      const v = bioInput.value;
      bioInput.setSelectionRange(v.length, v.length);
    }
    function closeForm() {
      bioForm.hidden = true;
      bioBtn.hidden = false;
      bioText.hidden = false;
    }

    bioBtn.addEventListener('click', openForm);
    bioCancel.addEventListener('click', closeForm);
    bioInput.addEventListener('input', () => {
      bioCount.textContent = bioInput.value.length + ' / 500';
    });
    bioForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const value = bioInput.value;
      bioSave.disabled = true;
      try {
        const { error } = await supabaseClient.rpc('set_my_bio', { p_bio: value });
        if (error) throw error;
        state.target.bio = value.trim() || null;
        if (state.target.bio) {
          bioText.textContent = state.target.bio;
          bioText.classList.remove('empty');
        } else {
          bioText.textContent = "You haven't written a bio yet.";
          bioText.classList.add('empty');
        }
        toast('Bio saved', 'success');
        closeForm();
      } catch (err) {
        console.error(err);
        toast('Could not save bio', 'error');
      } finally {
        bioSave.disabled = false;
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Follow / like / message actions.
  // ---------------------------------------------------------------------------
  function wireActions() {
    $('followBtn').addEventListener('click', async () => {
      if (state.isSelf) return;
      const btn = $('followBtn');
      btn.disabled = true;
      try {
        const { data, error } = await supabaseClient.rpc('toggle_follow', {
          p_target_id: state.targetId,
        });
        if (error) throw error;
        if (data) {
          state.target.caller_follows_target = !!data.is_following;
          if (typeof data.is_mutual_now === 'boolean') {
            state.target.is_friend_with_caller = data.is_mutual_now;
          }
        }
        // Refresh numbers from the canonical RPC.
        await refresh();
        toast(state.target.caller_follows_target ? 'Following' : 'Unfollowed', 'success');
      } catch (err) {
        console.error(err);
        toast('Could not update follow', 'error');
      } finally {
        btn.disabled = false;
      }
    });

    $('likeBtn').addEventListener('click', async () => {
      if (state.isSelf) return;
      const btn = $('likeBtn');
      btn.disabled = true;
      try {
        const { data, error } = await supabaseClient.rpc('toggle_profile_like', {
          p_target_id: state.targetId,
        });
        if (error) throw error;
        if (data) {
          state.target.caller_likes_this_profile = !!data.liked;
          state.target.likes_count = data.likes_count;
          $('likeCount').textContent = String(data.likes_count || 0);
          $('likeBtn').classList.toggle('is-liked', !!data.liked);
          $('statLikedBy').textContent = String(data.likes_count || 0);
        }
      } catch (err) {
        console.error(err);
        toast('Could not update like', 'error');
      } finally {
        btn.disabled = false;
      }
    });

    $('messageBtn').addEventListener('click', () => {
      if (state.isSelf) return;
      if (window.recallChat && typeof window.recallChat.openWithUser === 'function') {
        window.recallChat.openWithUser(state.targetId);
      } else if (window.recallChat && typeof window.recallChat.toggle === 'function') {
        window.recallChat.toggle();
        toast('Open the chat to message ' + (state.target.full_name || 'this person'), 'success');
      } else {
        toast('Chat isn’t loaded yet', 'error');
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Stats modal (Followers / Following / Mutual friends).
  // ---------------------------------------------------------------------------
  function wireStats() {
    const modal = $('listModal');
    const title = $('listModalTitle');
    const body  = $('listModalBody');
    $('listClose').addEventListener('click', () => { modal.hidden = true; });
    modal.addEventListener('click', (e) => { if (e.target === modal) modal.hidden = true; });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !modal.hidden) modal.hidden = true;
    });

    document.querySelectorAll('[data-open]').forEach((btn) => {
      const open = () => openList(btn.getAttribute('data-open'));
      btn.addEventListener('click', open);
      btn.addEventListener('keydown', (e) => {
        // Native buttons fire click on Enter/Space; our divs need this wired.
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          open();
        }
      });
    });

    async function openList(kind) {
      title.textContent = kind === 'followers' ? 'Followers'
        : kind === 'following' ? 'Following'
        : 'Mutual friends';
      body.innerHTML = '<div class="list-empty">Loading…</div>';
      modal.hidden = false;
      let rows = [];
      try {
        if (kind === 'followers') {
          ({ data: rows } = await supabaseClient.rpc('list_profile_followers', { p_target: state.targetId, p_limit: 100 }));
        } else if (kind === 'following') {
          ({ data: rows } = await supabaseClient.rpc('list_profile_following', { p_target: state.targetId, p_limit: 100 }));
        } else {
          ({ data: rows } = await supabaseClient.rpc('list_profile_mutuals_with_me', { p_target: state.targetId, p_limit: 100 }));
        }
      } catch (err) {
        console.error(err);
        body.innerHTML = '<div class="list-empty">Could not load.</div>';
        return;
      }
      rows = rows || [];
      if (!rows.length) {
        body.innerHTML = '<div class="list-empty">Nobody here yet.</div>';
        return;
      }
      body.innerHTML = '';
      for (const r of rows) {
        const a = el('a', {
          class: 'list-row',
          href: 'profile.html?id=' + encodeURIComponent(r.id),
          target: '_blank', rel: 'noopener',
        });
        const av = el('div', { class: 'av' });
        paintAvatar(av, r);
        a.appendChild(av);
        a.appendChild(el('div', { class: 'name', text: r.full_name || 'Unnamed' }));
        a.appendChild(el('div', { class: 'role', text: roleLabel(r.role) }));
        body.appendChild(a);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Search (find people to follow).
  // ---------------------------------------------------------------------------
  function wireSearch() {
    const input = $('searchInput');
    const out = $('searchResults');
    if (!input || !out) return;
    let timer = null;
    let lastQuery = null;

    function render(rows) {
      out.innerHTML = '';
      if (!rows.length) {
        out.innerHTML = '<div style="padding:14px;color:var(--text-4);font-size:13px;">No matches.</div>';
        out.hidden = false;
        return;
      }
      for (const r of rows) {
        const a = el('a', {
          class: 'search-hit',
          href: 'profile.html?id=' + encodeURIComponent(r.id),
          target: '_blank', rel: 'noopener',
        });
        const av = el('div', { class: 'av' });
        paintAvatar(av, r);
        a.appendChild(av);
        const who = el('div', { class: 'who', text: r.full_name || 'Unnamed' });
        a.appendChild(who);
        a.appendChild(el('div', { class: 'role', text: roleLabel(r.role) }));
        out.appendChild(a);
      }
      out.hidden = false;
    }

    async function run(q) {
      if (q === lastQuery) return;
      lastQuery = q;
      try {
        const { data, error } = await supabaseClient.rpc('search_profiles_for_follow', {
          p_query: q, p_limit: 8,
        });
        if (q !== lastQuery) return;
        if (error) throw error;
        render(data || []);
      } catch (err) {
        console.error(err);
        out.innerHTML = '<div style="padding:14px;color:var(--red);font-size:13px;">Search failed.</div>';
        out.hidden = false;
      }
    }

    input.addEventListener('input', () => {
      clearTimeout(timer);
      const q = input.value.trim();
      if (!q) { out.hidden = true; out.innerHTML = ''; lastQuery = null; return; }
      timer = setTimeout(() => run(q), 180);
    });
    input.addEventListener('focus', () => {
      if (input.value.trim()) { lastQuery = null; run(input.value.trim()); }
    });
  }

  // ---------------------------------------------------------------------------
  // Realtime: when this is the caller's own profile, repaint on any follow /
  // like change. Other tabs on the same profile also update via the broadcast
  // below.
  // ---------------------------------------------------------------------------
  function wireRealtime() {
    if (state.channel) {
      try { supabaseClient.removeChannel(state.channel); } catch (_) {}
      state.channel = null;
    }
    const ch = supabaseClient.channel('profile:' + state.targetId);
    ch.on('postgres_changes',
      { event: '*', schema: 'public', table: 'profile_follows', filter: 'followee_id=eq.' + state.targetId },
      () => refresh()
    ).on('postgres_changes',
      { event: '*', schema: 'public', table: 'profile_follows', filter: 'follower_id=eq.' + state.targetId },
      () => refresh()
    ).on('postgres_changes',
      { event: '*', schema: 'public', table: 'profile_likes', filter: 'profile_id=eq.' + state.targetId },
      () => refresh()
    ).subscribe();
    state.channel = ch;
    window.addEventListener('beforeunload', () => {
      if (state.channel) {
        try { supabaseClient.removeChannel(state.channel); } catch (_) {}
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Boot — mirrors staff-dashboard.html: getUser → fetch caller profile →
  // wire chrome → load profile view.
  // ---------------------------------------------------------------------------
  async function boot() {
    const { data, error } = await supabaseClient.auth.getUser();
    if (error || !data || !data.user) {
      showGate('Sign-in required', 'Sign in to view profiles.');
      return;
    }
    const user = data.user;
    state.user = user;

    const { data: me } = await supabaseClient
      .from('profiles')
      .select('id, full_name, role, avatar_url')
      .eq('id', user.id)
      .maybeSingle();
    state.me = me || { id: user.id, full_name: '', role: null, avatar_url: null };

    const requested = parseTargetId();
    state.targetId = requested || user.id;
    state.isSelf = (state.targetId === user.id);

    // Top nav.
    // (userName is hidden by CSS — the avatar button + identity card are the
    // canonical display-name surfaces on the profile page.)
    $('signOutBtn').hidden = false;
    $('signOutBtn').addEventListener('click', async () => {
      await supabaseClient.auth.signOut();
      window.location.href = 'login.html';
    });

    // Mount notification bell + header avatar dropdown.
    function mountBell() {
      const slot = document.getElementById('bellSlot');
      if (slot && slot.firstChild) return; // already mounted (auto-mount won the race)
      if (!window.recallTopbar) { setTimeout(mountBell, 50); return; }
      window.recallTopbar.mount('bellSlot', { supabaseClient, user });
    }
    mountBell();
    function mountAvatar() {
      const slot = document.getElementById('avatarSlot');
      if (slot && slot.firstChild) return; // already mounted (auto-mount won the race)
      if (!window.recallHeaderAvatar) { setTimeout(mountAvatar, 50); return; }
      window.recallHeaderAvatar.mount('avatarSlot', {
        supabaseClient, user, profile: state.me,
      });
    }
    mountAvatar();
    if (window.recallChat) {
      window.recallChat.mount({
        supabaseClient, user, profile: state.me,
      });
    }

    showMain();
    wireBio();
    wireActions();
    wireStats();
    wireSearch();
    wireRealtime();
    await refresh();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
