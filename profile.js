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
//   * get_profile_learning_state(p_target_id) -> { currently_learning, recent_subjects }
//   * set_my_bio(p_bio, p_format)        -> void
//   * set_my_account_visibility(p_visibility) -> void
//   * toggle_follow(p_target_id)         -> JSONB
//   * toggle_profile_like(p_target_id)   -> JSONB
//   * heartbeat()                         -> void
//   * search_profiles_for_follow(q, lim) -> setof
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

  // Mirrors dashboard.html: "Just now" / "5 mins ago" / "2 days ago".
  function timeAgo(iso) {
    if (!iso) return '';
    const then = new Date(iso);
    if (isNaN(then.getTime())) return '';
    const diffMs = Date.now() - then.getTime();
    const mins = Math.floor(diffMs / 60000);
    if (mins < 1)    return 'Just now';
    if (mins < 60)   return mins + ' min' + (mins === 1 ? '' : 's') + ' ago';
    const hrs = Math.floor(mins / 60);
    if (hrs < 24)    return hrs + ' hour' + (hrs === 1 ? '' : 's') + ' ago';
    const days = Math.floor(hrs / 24);
    if (days === 1)  return 'Yesterday';
    if (days < 7)    return days + ' days ago';
    if (days < 14)   return '1 week ago';
    if (days < 30)   return Math.floor(days / 7) + ' weeks ago';
    return then.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
  }

  // ---------------------------------------------------------------------------
  // HTML sanitiser for rich bios. Runs on save AND render (defence in depth).
  // Allowlist: b, i, u, strong, em, br, span (with safe color), a (https only),
  // img (https only), p, div. Strips everything else, all attributes except
  // the safe ones, all event handlers, all non-https URIs.
  // ---------------------------------------------------------------------------
  function sanitizeBioHtml(input) {
    if (!input) return '';
    const allowed = /^(?:https:\/\/[^\s"]+)$/i;
    const tpl = document.createElement('template');
    tpl.innerHTML = String(input);
    const walk = (node) => {
      const kids = Array.from(node.childNodes);
      for (const child of kids) {
        if (child.nodeType === 1) {
          const tag = child.tagName.toLowerCase();
          if (!['b','i','u','strong','em','br','span','a','img','p','div'].includes(tag)) {
            // Replace disallowed element with its text content.
            const text = document.createTextNode(child.textContent || '');
            child.parentNode.replaceChild(text, child);
            continue;
          }
          // Strip ALL attributes first; re-add the safe ones below.
          const attrs = Array.from(child.attributes);
          for (const a of attrs) child.removeAttribute(a.name);
          if (tag === 'span') {
            const color = (child.style && child.style.color) ? child.style.color : '';
            if (/^#[0-9a-f]{6}$/i.test(color)) {
              child.setAttribute('style', 'color:' + color.toLowerCase());
            } else {
              child.removeAttribute('style');
            }
          }
          if (tag === 'a') {
            const href = child.getAttribute('href') || '';
            if (!child.textContent.trim() || !allowed.test(href)) {
              child.replaceWith(document.createTextNode(child.textContent || ''));
              continue;
            }
            child.setAttribute('href', href);
            child.setAttribute('target', '_blank');
            child.setAttribute('rel', 'noopener noreferrer');
          }
          if (tag === 'img') {
            const src = child.getAttribute('src') || '';
            if (!allowed.test(src)) {
              child.remove();
              continue;
            }
            child.setAttribute('src', src);
            child.setAttribute('alt', child.getAttribute('alt') || '');
          }
          walk(child);
        } else if (child.nodeType !== 3 && child.nodeType !== 8) {
          child.remove();
        }
      }
    };
    walk(tpl.content);
    // Drop empty paragraphs left behind by Quill.
    return tpl.innerHTML.replace(/<p>\s*<\/p>/g, '').trim();
  }

  // ---------------------------------------------------------------------------
  // Page state.
  // ---------------------------------------------------------------------------
  const state = {
    user: null,
    me: null,        // caller's profile row
    targetId: null,
    target: null,    // get_profile_for_view JSON
    learning: null,  // get_profile_learning_state JSON
    isSelf: false,
    channel: null,
    heartbeatTimer: null,
    quill: null,
  };

  // ---------------------------------------------------------------------------
  // Gate / show main.
  // ---------------------------------------------------------------------------
  function showGate(title, msg) {
    $('profileMain').hidden = true;
    $('gate').hidden = false;
    $('gateTitle').textContent = title;
    $('gateMsg').textContent = msg;
  }

  function showMain() {
    $('gate').hidden = true;
    $('profileMain').hidden = false;
  }

  // ---------------------------------------------------------------------------
  // Privacy gate helper.
  // Returns true when the caller has full visibility of the target's content.
  // ---------------------------------------------------------------------------
  function canSeeFull() {
    if (!state.target) return false;
    if (state.isSelf) return true;
    const vis = state.target.account_visibility || 'public';
    if (vis === 'public') return true;
    if (vis === 'friends_only') return !!state.target.is_friend_with_caller;
    return false; // private
  }

  // ---------------------------------------------------------------------------
  // Render — paints every card from state.target / state.learning.
  // ---------------------------------------------------------------------------
  function render() {
    const p = state.target;
    const isSelf = state.isSelf;
    const gated = !canSeeFull();

    // Identity.
    const name = (p.full_name || '').trim() || 'Unnamed';

    $('displayName').textContent = name;
    paintAvatar($('avatarBig'), p, 96);

    const pill = $('rolePill');
    pill.className = 'role-pill ' + (p.role || '');
    pill.textContent = roleLabel(p.role);

    const school = $('schoolLine');
    if (!gated && p.school_name) {
      school.textContent = p.school_name;
      school.hidden = false;
    } else {
      school.textContent = '';
      school.hidden = true;
    }

    // Presence dot. Hidden on self; reflects is_online for others.
    const dot = $('presenceDot');
    if (isSelf) {
      dot.hidden = true;
    } else {
      dot.hidden = false;
      dot.dataset.self = isSelf ? '1' : '0';
      dot.dataset.offline = p.is_online ? '0' : '1';
    }

    $('identityCard').hidden = false;
    $('settingsRow').hidden = !isSelf;

    // Bio.
    const bioText = $('bioText');
    if (gated) {
      bioText.textContent = p.account_visibility === 'private'
        ? 'This profile is private.'
        : 'This profile is set to friends only.';
      bioText.classList.add('empty');
    } else if (p.bio && String(p.bio).trim()) {
      bioText.innerHTML = sanitizeBioHtml(p.bio);
      bioText.classList.remove('empty');
    } else {
      bioText.textContent = isSelf
        ? "You haven't written a bio yet."
        : (name + ' hasn’t written a bio yet.');
      bioText.classList.add('empty');
    }
    $('bioCard').hidden = false;
    $('bioActions').hidden = !isSelf || gated;
    $('editBioBtn').hidden = !isSelf || gated;

    // Actions.
    if (isSelf || gated) {
      $('actionsCard').hidden = true;
    } else {
      $('actionsCard').hidden = false;
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
    if (gated || isSelf) {
      // isSelf still sees their own stats (it's their data).
      $('statsCard').hidden = false;
      $('statFollowers').textContent = String(p.follower_count || 0);
      $('statFollowing').textContent = String(p.following_count || 0);
      $('statMutuals').textContent = String(p.mutual_friend_count_with_caller || 0);
      $('statLikedBy').textContent = String(p.likes_count || 0);
    } else {
      $('statsCard').hidden = true;
    }

    // Currently learning + recent subjects.
    renderLearning();
    renderRecentSubjects();

    // Mutuals grid.
    renderMutuals(gated);

    // Search card is for everyone; the RPC excludes the caller anyway.
    $('searchCard').hidden = false;
  }

  function renderLearning() {
    const card = $('learningCard');
    const wrap = $('learningList');
    wrap.innerHTML = '';
    if (!canSeeFull() || state.isSelf === false && !state.learning) {
      // gated profiles never get learning data.
      card.hidden = true;
      return;
    }
    const items = (state.learning && state.learning.currently_learning) || [];
    if (!items.length) {
      card.hidden = false;
      wrap.appendChild(el('div', { class: 'card-empty', text: 'No lessons in progress right now.' }));
      return;
    }
    card.hidden = false;
    for (const it of items) {
      const a = el('a', {
        class: 'learning-row',
        href: 'lesson.html?lesson=' + encodeURIComponent(it.lesson_id),
        target: '_self',
      });
      a.appendChild(el('span', { class: 'subject-dot ' + (it.subject_color || '') }));
      const body = el('div', { class: 'learning-body' });
      body.appendChild(el('div', { class: 'learning-title', text: it.lesson_title || 'Untitled lesson' }));
      body.appendChild(el('div', { class: 'learning-sub', text:
        [it.subject_name, it.topic_name].filter(Boolean).join(' · ')
      }));
      a.appendChild(body);
      a.appendChild(el('div', { class: 'learning-when', text: timeAgo(it.updated_at) }));
      wrap.appendChild(a);
    }
  }

  function renderRecentSubjects() {
    const card = $('subjectsCard');
    const wrap = $('subjectsList');
    wrap.innerHTML = '';
    if (!canSeeFull()) {
      card.hidden = true;
      return;
    }
    const items = (state.learning && state.learning.recent_subjects) || [];
    if (!items.length) {
      card.hidden = false;
      wrap.appendChild(el('div', { class: 'card-empty', text: 'No subjects yet.' }));
      return;
    }
    card.hidden = false;
    for (const s of items) {
      const tile = el('div', { class: 'subject-tile' });
      const top = el('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } });
      top.appendChild(el('span', { class: 'subject-dot ' + (s.subject_color || '') }));
      top.appendChild(el('div', { class: 'subject-name', text: s.subject_name || 'Subject' }));
      tile.appendChild(top);
      tile.appendChild(el('div', { class: 'subject-meta', text: 'touched ' + timeAgo(s.last_touched_at) }));
      if (s.lessons_touched) {
        tile.appendChild(el('div', { class: 'subject-meta', text:
          s.lessons_touched + ' lesson' + (s.lessons_touched === 1 ? '' : 's')
        }));
      }
      wrap.appendChild(tile);
    }
  }

  function renderMutuals(gated) {
    const grid = $('mutualsGrid');
    grid.innerHTML = '';
    if (state.isSelf || gated) {
      $('mutualsCard').hidden = true;
      return;
    }
    const mutuals = Array.isArray(state.target.recent_mutuals) ? state.target.recent_mutuals : [];
    $('mutualsCard').hidden = false;
    if (mutuals.length === 0) {
      $('mutualsMeta').textContent = '';
      grid.appendChild(el('div', { class: 'card-empty', text:
        'When you and ' + (state.target.full_name || 'this person') + ' follow each other, you’ll see them here.'
      }));
      return;
    }
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

  // ---------------------------------------------------------------------------
  // Fetch + repaint the profile view.
  // ---------------------------------------------------------------------------
  async function refresh() {
    try {
      const mainP = supabaseClient.rpc('get_profile_for_view', {
        p_target_id: state.targetId,
      });
      // Only request learning state when we'd render it. For private profiles
      // the server returns empty arrays anyway; friends_only non-friends get
      // empty. We save a round-trip when we know we'll gate it out.
      const learningP = state.isSelf || !state.target
        ? supabaseClient.rpc('get_profile_learning_state', { p_target_id: state.targetId })
        : Promise.resolve({ data: { currently_learning: [], recent_subjects: [] } });

      const [main, learning] = await Promise.all([mainP, learningP]);
      if (main.error) throw main.error;
      if (!main.data || main.data.found === false) {
        showGate('Profile not found', 'No profile matches that id.');
        return;
      }
      state.target = main.data;
      state.learning = (learning && learning.data) || { currently_learning: [], recent_subjects: [] };
      render();
    } catch (e) {
      console.error('get_profile_for_view failed:', e);
      showGate('Could not load profile', 'Try refreshing.');
    }
  }

  async function refreshLearning() {
    if (state.isSelf) return; // self already keeps its own state fresh via dashboard
    if (!canSeeFull()) return;
    try {
      const { data, error } = await supabaseClient.rpc('get_profile_learning_state', {
        p_target_id: state.targetId,
      });
      if (error) throw error;
      state.learning = data || { currently_learning: [], recent_subjects: [] };
      renderLearning();
      renderRecentSubjects();
    } catch (_) { /* swallow; next refresh() will recover */ }
  }

  // ---------------------------------------------------------------------------
  // Bio rich-text editor (Quill + custom HTML toolbar).
  //   The toolbar in profile.html carries data-cmd="<action>" on each button
  //   plus a row of color swatches with data-color="<#hex>". We translate
  //   clicks into Quill API calls: format() for inline formats, insertEmbed()
  //   for images, removeFormat() for clear. A small floating popup gives the
  //   inserted image resize + delete controls.
  // ---------------------------------------------------------------------------
  function updateBioCounter() {
    if (!state.quill) return;
    const text = state.quill.getText().trim();
    $('bioCounter').textContent = text.length + ' / 8000';
  }

  // Floating image popup — built once, shown on image selection inside the
  // editor. Lets the user resize (Small / Medium / Large / Original) and
  // delete the selected <img>.
  let bioImgPopup = null;     // the popup element
  let bioImgSelected = null;  // the <img> currently being edited

  function buildBioImagePopup() {
    if (bioImgPopup) return bioImgPopup;
    const pop = document.createElement('div');
    pop.className = 'bio-image-popup';
    pop.hidden = true;

    const label = document.createElement('label');
    label.appendChild(document.createTextNode('Size'));
    const range = document.createElement('input');
    range.type = 'range';
    range.min = '15';
    range.max = '100';
    range.value = '100';
    range.step = '5';
    const pct = document.createElement('span');
    pct.className = 'pct';
    pct.textContent = '100%';
    label.appendChild(range);
    label.appendChild(pct);
    pop.appendChild(label);

    function sizeBtn(text, pctVal) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = text;
      b.addEventListener('click', () => applyImgSize(pctVal));
      return b;
    }
    pop.appendChild(sizeBtn('Small', 25));
    pop.appendChild(sizeBtn('Medium', 50));
    pop.appendChild(sizeBtn('Large', 75));
    pop.appendChild(sizeBtn('Fit', 100));

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'danger';
    del.textContent = 'Delete';
    del.addEventListener('click', deleteSelectedImage);
    pop.appendChild(del);

    range.addEventListener('input', () => {
      pct.textContent = range.value + '%';
      applyImgSize(parseInt(range.value, 10));
    });

    document.body.appendChild(pop);
    bioImgPopup = pop;
    return pop;
  }

  function applyImgSize(pctVal) {
    if (!bioImgSelected || !state.quill) return;
    const v = Math.max(15, Math.min(100, parseInt(pctVal, 10) || 100));
    bioImgSelected.style.width = v + '%';
    bioImgSelected.style.height = 'auto';
    bioImgSelected.dataset.bioSize = String(v);
    if (bioImgPopup && bioImgPopup.querySelector('input[type=range]')) {
      const r = bioImgPopup.querySelector('input[type=range]');
      const p = bioImgPopup.querySelector('.pct');
      r.value = String(v);
      p.textContent = v + '%';
    }
  }

  function deleteSelectedImage() {
    if (!bioImgSelected || !state.quill) return;
    // Quill tracks embedded image positions via the DOM; the simplest removal
    // is to walk the editor's children and replace the img node with a blank
    // line, then let Quill pick up the change via input event.
    const img = bioImgSelected;
    const blot = state.quill.findEmbed && state.quill.findEmbed(img);
    if (blot && typeof blot.remove === 'function') {
      blot.remove();
    } else {
      // Fallback: replace the parent paragraph with its remaining children.
      const parent = img.parentNode;
      while (img.firstChild) parent.insertBefore(img.firstChild, img);
      parent.removeChild(img);
    }
    hideBioImagePopup();
    updateBioCounter();
    // Trigger Quill's text-change so the doc state syncs.
    state.quill.update && state.quill.update('user');
  }

  function positionBioImagePopup(img) {
    if (!bioImgPopup) return;
    const editor = state.quill && state.quill.root;
    if (!editor) return;
    const edRect = editor.getBoundingClientRect();
    const imRect = img.getBoundingClientRect();
    const pop = bioImgPopup;
    // Make sure it's visible so width/height are measurable.
    pop.hidden = false;
    pop.style.left = '-9999px';
    pop.style.top = '-9999px';
    const popRect = pop.getBoundingClientRect();
    const left = Math.max(
      edRect.left + 8,
      Math.min(
        window.scrollX + imRect.left,
        window.scrollX + edRect.right - popRect.width - 8
      )
    );
    const top = Math.max(
      window.scrollY + edRect.top + 4,
      window.scrollY + imRect.top - popRect.height - 8
    );
    pop.style.left = left + 'px';
    pop.style.top  = top + 'px';
  }

  function showBioImagePopup(img) {
    bioImgSelected = img;
    document.querySelectorAll('.bio-editor img.bio-img-selected')
      .forEach(n => n.classList.remove('bio-img-selected'));
    img.classList.add('bio-img-selected');
    buildBioImagePopup();
    const pct = parseInt(img.dataset.bioSize || (parseFloat(img.style.width) || 100), 10) || 100;
    const r = bioImgPopup.querySelector('input[type=range]');
    const p = bioImgPopup.querySelector('.pct');
    r.value = String(pct);
    p.textContent = pct + '%';
    positionBioImagePopup(img);
  }

  function hideBioImagePopup() {
    if (bioImgPopup) bioImgPopup.hidden = true;
    if (bioImgSelected) bioImgSelected.classList.remove('bio-img-selected');
    bioImgSelected = null;
  }

  function wireBioEditor() {
    const editBtn = $('editBioBtn');
    const bioForm = $('bioForm');
    const bioCancel = $('bioCancel');
    const bioSave = $('bioSave');
    const bioText = $('bioText');
    const fileInput = $('bioImageInput');
    const toolbar = $('bioToolbar');
    const editorEl = $('bioEditor');

    editBtn.addEventListener('click', () => {
      const current = (state.target && state.target.bio) || '';
      bioForm.hidden = false;
      bioText.hidden = true;
      editBtn.hidden = true;
      if (!state.quill) {
        if (!window.Quill) {
          toast('Editor is still loading…', 'error');
          return;
        }
        // No `modules.toolbar` — we drive Quill via our own buttons in #bioToolbar.
        state.quill = new window.Quill('#bioEditor', {
          theme: 'snow',
          modules: {},
          bounds: '#bioForm',
          placeholder: 'Tell people about yourself…',
        });
        state.quill.on('text-change', () => updateBioCounter());
        // Image popup wiring: click + select on the editor.
        state.quill.root.addEventListener('click', onEditorClick);
        state.quill.on('selection-change', onSelectionChange);
      }
      const clean = sanitizeBioHtml(current);
      state.quill.clipboard.dangerouslyPasteHTML(clean || '');
      updateBioCounter();
      hideBioImagePopup();
      setTimeout(() => state.quill && state.quill.focus(), 0);
    });

    bioCancel.addEventListener('click', () => {
      bioForm.hidden = true;
      bioText.hidden = false;
      editBtn.hidden = false;
      hideBioImagePopup();
    });

    // ----- Custom toolbar wiring -----
    if (toolbar && !toolbar.dataset.recallWired) {
      toolbar.dataset.recallWired = '1';

      toolbar.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-cmd]');
        if (!btn) return;
        e.preventDefault();
        const cmd = btn.dataset.cmd;
        if (cmd === 'color') {
          // Toggle the swatch dropdown.
          const wrap = btn.closest('.rt-color-wrap');
          const menu = wrap && wrap.querySelector('.rt-color-menu');
          if (menu) {
            const open = menu.hidden;
            menu.hidden = !open;
            if (open) state.quill && state.quill.focus();
          }
          return;
        }
        if (cmd === 'link') {
          askLink();
          return;
        }
        if (cmd === 'image') {
          if (fileInput) fileInput.click();
          return;
        }
        if (cmd === 'clear') {
          if (!state.quill) return;
          state.quill.removeFormat(
            state.quill.getSelection() ? state.quill.getSelection().index : 0,
            state.quill.getSelection() ? state.quill.getSelection().length : state.quill.getLength()
          );
          updateBioCounter();
          syncActiveFormats();
          return;
        }
        if (!state.quill) return;
        // bold / italic / underline — toggle the active state.
        const range = state.quill.getSelection();
        if (!range) return;
        const current = state.quill.getFormat(range);
        const next = !current[cmd];
        state.quill.format(cmd, next, 'user');
        syncActiveFormats();
      });

      // Color swatches.
      toolbar.querySelectorAll('.rt-swatch').forEach((sw) => {
        sw.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (!state.quill) return;
          const color = sw.dataset.color || '';
          state.quill.format('color', color, 'user');
          // Update the swatch strip under the colour button.
          const swatch = toolbar.querySelector('.rt-color-swatch');
          if (swatch) swatch.style.background = color || '';
          const menu = sw.closest('.rt-color-menu');
          if (menu) menu.hidden = true;
          syncActiveFormats();
        });
      });

      // Close the colour menu on outside click.
      document.addEventListener('click', (e) => {
        const wrap = toolbar.querySelector('.rt-color-wrap');
        if (!wrap) return;
        if (!wrap.contains(e.target)) {
          const menu = wrap.querySelector('.rt-color-menu');
          if (menu) menu.hidden = true;
        }
      });
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          const menu = toolbar.querySelector('.rt-color-menu');
          if (menu) menu.hidden = true;
        }
      });

      // Dismiss the image popup when clicking elsewhere.
      editorEl && editorEl.addEventListener('blur', () => {
        // Defer — the popup may be the next focused element.
        setTimeout(() => {
          if (!bioImgPopup) return;
          if (document.activeElement && bioImgPopup.contains(document.activeElement)) return;
          hideBioImagePopup();
        }, 120);
      }, true);
    }

    // ----- Link dialog (prompt) -----
    function askLink() {
      if (!state.quill) return;
      const range = state.quill.getSelection();
      if (!range) {
        toast('Select some text first', 'error');
        return;
      }
      const existing = state.quill.getFormat(range).link || '';
      const raw = window.prompt('Link URL (https://…)', existing || 'https://');
      if (raw === null) return;
      const trimmed = String(raw).trim();
      if (!trimmed) {
        state.quill.format('link', false, 'user');
        return;
      }
      let href = trimmed;
      if (!/^https?:\/\//i.test(href)) href = 'https://' + href;
      if (!/^https:\/\//i.test(href)) {
        toast('Only https links are allowed', 'error');
        return;
      }
      state.quill.format('link', href, 'user');
    }

    // ----- Image upload -----
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files && fileInput.files[0];
      fileInput.value = '';
      if (!file || !state.quill) return;
      const okTypes = ['image/jpeg', 'image/png', 'image/webp'];
      if (okTypes.indexOf(file.type) === -1) {
        toast('Image must be JPG, PNG, or WebP', 'error');
        return;
      }
      if (file.size > 2 * 1024 * 1024) {
        toast('Image must be under 2 MB', 'error');
        return;
      }
      const ext = (file.name.match(/\.(jpe?g|png|webp)$/i) || ['.jpg'])[0].toLowerCase();
      const objectPath = state.user.id + '/bio/' + crypto.randomUUID() + ext;
      try {
        const { error } = await supabaseClient.storage.from('avatars')
          .upload(objectPath, file, { upsert: false, contentType: file.type });
        if (error) throw error;
        const { data: pub } = supabaseClient.storage.from('avatars').getPublicUrl(objectPath);
        const url = pub && pub.publicUrl;
        if (!url) throw new Error('no public url');
        const range = state.quill.getSelection(true);
        state.quill.insertEmbed(range ? range.index : state.quill.getLength(), 'image', url, 'user');
        // Move the caret past the new image.
        const after = state.quill.getSelection();
        if (after) state.quill.setSelection(after.index + 1, 0);
        updateBioCounter();
      } catch (e) {
        console.error(e);
        toast('Image upload failed', 'error');
      }
    });

    // ----- Save / submit -----
    bioForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!state.quill) return;
      const html = state.quill.root.innerHTML;
      const clean = sanitizeBioHtml(html);
      bioSave.disabled = true;
      try {
        const { error } = await supabaseClient.rpc('set_my_bio', {
          p_bio: clean, p_format: 'html',
        });
        if (error) throw error;
        state.target.bio = clean || null;
        state.target.bio_format = 'html';
        bioForm.hidden = true;
        bioText.hidden = false;
        editBtn.hidden = false;
        hideBioImagePopup();
        render();
        toast('Bio saved', 'success');
      } catch (err) {
        console.error(err);
        if (err && err.message && err.message.startsWith('moderation:')) {
          toast("Bio contains content that isn't allowed. Please edit and try again.", 'error');
        } else if (err && err.message && err.message.includes('too long')) {
          toast('Bio is too long.', 'error');
        } else {
          toast('Could not save bio. Please try again.', 'error');
        }
      } finally {
        bioSave.disabled = false;
      }
    });

    // ----- Helpers used above -----
    function onEditorClick(e) {
      if (!state.quill) return;
      if (e.target && e.target.tagName === 'IMG' && e.target.closest('#bioEditor')) {
        e.preventDefault();
        showBioImagePopup(e.target);
      } else {
        hideBioImagePopup();
      }
    }
    function onSelectionChange(range) {
      if (!range) { hideBioImagePopup(); return; }
      syncActiveFormats();
    }
  }

  // Mirror active formats onto the toolbar's buttons (bold/italic/underline
  // + the colour swatch strip).
  function syncActiveFormats() {
    const toolbar = $('bioToolbar');
    if (!toolbar || !state.quill) return;
    const sel = state.quill.getSelection();
    const fmt = sel ? state.quill.getFormat(sel) : {};
    ['bold', 'italic', 'underline'].forEach((cmd) => {
      const b = toolbar.querySelector('[data-cmd="' + cmd + '"]');
      if (b) b.classList.toggle('is-active', !!fmt[cmd]);
    });
    const swatch = toolbar.querySelector('.rt-color-swatch');
    if (swatch) swatch.style.background = fmt.color || '';
  }

  // ---------------------------------------------------------------------------
  // Settings modal — account visibility (Public / Friends only / Private).
  // ---------------------------------------------------------------------------
  function wireSettings() {
    const btn = $('openSettingsBtn');
    const modal = $('settingsModal');
    const saveBtn = $('settingsSave');
    if (!btn || !modal || !saveBtn) return;

    btn.addEventListener('click', () => {
      const cur = (state.target && state.target.account_visibility) || 'public';
      const radio = modal.querySelector('input[name="vis"][value="' + cur + '"]');
      if (radio) radio.checked = true;
      modal.hidden = false;
    });

    modal.addEventListener('click', (e) => {
      if (e.target === modal || (e.target && e.target.dataset && e.target.dataset.closeModal === 'settingsModal')) {
        modal.hidden = true;
      }
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !modal.hidden) modal.hidden = true;
    });

    saveBtn.addEventListener('click', async () => {
      const v = (modal.querySelector('input[name="vis"]:checked') || {}).value || 'public';
      saveBtn.disabled = true;
      try {
        const { error } = await supabaseClient.rpc('set_my_account_visibility', { p_visibility: v });
        if (error) throw error;
        state.target.account_visibility = v;
        modal.hidden = true;
        render();
        toast('Profile visibility updated', 'success');
      } catch (err) {
        console.error(err);
        toast(err && err.message ? err.message : 'Could not update settings', 'error');
      } finally {
        saveBtn.disabled = false;
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Online presence — heartbeat fires every 60s on the caller's own session
  // so other viewers can see the green dot.
  // ---------------------------------------------------------------------------
  function wirePresence() {
    if (!state.isSelf) return;
    const beat = async () => {
      try { await supabaseClient.rpc('heartbeat'); } catch (_) { /* ignore */ }
    };
    beat();
    state.heartbeatTimer = setInterval(beat, 60_000);
    window.addEventListener('beforeunload', () => {
      if (state.heartbeatTimer) clearInterval(state.heartbeatTimer);
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
  // below. We also subscribe to profiles (for visibility + presence flips)
  // and lesson_progress (so currently-learning updates live).
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
    ).on('postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'profiles', filter: 'id=eq.' + state.targetId },
      () => refresh()
    ).on('postgres_changes',
      { event: '*', schema: 'public', table: 'lesson_progress', filter: 'user_id=eq.' + state.targetId },
      () => refreshLearning()
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
    function unhideSignOut() {
      const btn = $('signOutBtn');
      if (!btn) { setTimeout(unhideSignOut, 30); return; }
      btn.hidden = false;
    }
    unhideSignOut();
    function wireSignOut() {
      const btn = $('signOutBtn');
      if (!btn) { setTimeout(wireSignOut, 30); return; }
      if (btn.dataset.recallSignOutWired) return;
      btn.dataset.recallSignOutWired = '1';
      btn.addEventListener('click', async () => {
        await supabaseClient.auth.signOut();
        window.location.href = 'login.html';
      });
    }
    wireSignOut();

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
    wireBioEditor();
    wireActions();
    wireSettings();
    wireStats();
    wireSearch();
    wireRealtime();
    wirePresence();
    await refresh();

    // If the URL hash is #settings, open the modal after load (used by the
    // "Profile settings" link in the avatar dropdown).
    if (location.hash === '#settings' && state.isSelf) {
      const btn = $('openSettingsBtn');
      if (btn) btn.click();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
