// ============================================================================
// chat.js — floating DM chat for staff, admin, teacher, school-organiser.
// NOT loaded on student pages.
//
// Public API:
//   window.recallChat.mount({ supabaseClient, user, profile })
//     profile : { id, full_name, role, avatar_url }
// Returns: { open, close, toggle, openWithUser }
//   openWithUser(userId) — opens a 1:1 DM with that user
// ============================================================================

(function () {
  'use strict';

  const STYLE_ID = 'recall-chat-style';

  function el(tag, attrs, children) {
    const e = document.createElement(tag);
    if (attrs) {
      for (const k in attrs) {
        if (k === 'class') e.className = attrs[k];
        else if (k === 'html') e.innerHTML = attrs[k];
        else if (k === 'text') e.textContent = attrs[k];
        else if (k === 'style' && typeof attrs[k] === 'object') Object.assign(e.style, attrs[k]);
        else if (k.indexOf('on') === 0) e.addEventListener(k.slice(2).toLowerCase(), attrs[k]);
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

  function fmtTime(iso) {
    if (!iso) return '';
    const t = new Date(iso);
    if (isNaN(t.getTime())) return '';
    const now = new Date();
    const sameDay = t.toDateString() === now.toDateString();
    if (sameDay) return t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const diff = (now - t) / 1000;
    if (diff < 86400 * 6) return t.toLocaleDateString([], { weekday: 'short' }) + ' ' + t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return t.toLocaleDateString([], { day: '2-digit', month: 'short' });
  }

  function fmtShort(iso) {
    if (!iso) return '';
    const t = new Date(iso);
    if (isNaN(t.getTime())) return '';
    const diff = (Date.now() - t.getTime()) / 1000;
    if (diff < 60) return 'now';
    if (diff < 3600) return Math.floor(diff / 60) + 'm';
    if (diff < 86400) return Math.floor(diff / 3600) + 'h';
    if (diff < 86400 * 7) return Math.floor(diff / 86400) + 'd';
    return t.toLocaleDateString([], { day: '2-digit', month: 'short' });
  }

  function roleLabel(role) {
    switch (role) {
      case 'staff_author': return 'Author';
      case 'staff_reviewer': return 'Reviewer';
      case 'admin': return 'Admin';
      case 'school_organiser': return 'School';
      case 'teacher': return 'Teacher';
      default: return role || 'Member';
    }
  }

  function isStaff(role) {
    return role === 'staff_author' || role === 'staff_reviewer' || role === 'admin';
  }
  function isSchool(role) {
    return role === 'teacher' || role === 'school_organiser';
  }
  function directKindFor(role) {
    if (isStaff(role)) return 'staff_direct';
    if (isSchool(role)) return role === 'school_organiser' ? 'school_direct' : 'teacher_direct';
    return 'staff_direct';
  }

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const css = `
.recall-chat-avatar-link {
  display: inline-flex;
  border-radius: 50%;
  text-decoration: none;
  flex-shrink: 0;
}
.recall-chat-avatar-link:hover { opacity: 0.85; }
.recall-chat-fab {
  position: fixed;
  right: 24px; bottom: 24px;
  width: 56px; height: 56px;
  border-radius: 50%;
  background: var(--blue);
  color: #fff;
  border: 0;
  box-shadow: 0 6px 20px rgba(0,0,0,0.45);
  cursor: pointer;
  display: inline-flex; align-items: center; justify-content: center;
  z-index: 70;
  transition: transform 0.18s ease, background 0.18s ease;
}
.recall-chat-fab:hover { transform: translateY(-2px); background: var(--blue-2); }
.recall-chat-fab.has-unread { animation: recall-chat-fab-pulse 1.6s ease-out infinite; }
@keyframes recall-chat-fab-pulse {
  0%   { box-shadow: 0 6px 20px rgba(0,0,0,0.45), 0 0 0 0 rgba(248,81,73,0.55); }
  70%  { box-shadow: 0 6px 20px rgba(0,0,0,0.45), 0 0 0 18px rgba(248,81,73,0); }
  100% { box-shadow: 0 6px 20px rgba(0,0,0,0.45), 0 0 0 0 rgba(248,81,73,0); }
}
.recall-chat-fab-badge {
  position: absolute; top: -2px; right: -2px;
  background: var(--red); color: #fff;
  border-radius: 999px;
  padding: 1px 6px;
  font-size: 11px; font-weight: 700;
  min-width: 18px; text-align: center;
  box-shadow: 0 0 0 2px var(--bg);
}
.recall-chat-panel {
  position: fixed;
  right: 24px; bottom: 92px;
  width: 720px; max-width: calc(100vw - 32px);
  height: 560px; max-height: calc(100vh - 120px);
  background: var(--bg-2);
  border: 1px solid var(--line-2);
  border-radius: var(--r-md);
  box-shadow: 0 18px 50px rgba(0,0,0,0.5);
  display: none;
  z-index: 69;
  overflow: hidden;
}
.recall-chat-panel.open { display: flex; }
@media (max-width: 720px) {
  .recall-chat-panel { right: 8px; bottom: 88px; width: calc(100vw - 16px); height: calc(100vh - 110px); }
  .recall-chat-panel .recall-chat-threads,
  .recall-chat-panel .recall-chat-conv { width: 100%; }
  .recall-chat-panel.threads-hidden .recall-chat-conv { display: none; }
  .recall-chat-panel.conv-hidden .recall-chat-threads { display: none; }
}
.recall-chat-threads {
  width: 280px; flex-shrink: 0;
  border-right: 1px solid var(--line-2);
  display: flex; flex-direction: column;
  background: var(--bg);
}
.recall-chat-threads-head {
  padding: 12px 12px 10px;
  border-bottom: 1px solid var(--line-2);
  display: flex; flex-direction: column; gap: 8px;
}
.recall-chat-threads-head h3 {
  margin: 0;
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0.02em;
  color: var(--text);
}
.recall-chat-search {
  width: 100%;
  background: var(--bg-3);
  border: 1px solid var(--line-2);
  color: var(--text);
  border-radius: var(--r-sm);
  padding: 6px 10px;
  font-size: 12.5px;
  font-family: inherit;
  outline: none;
}
.recall-chat-search:focus { border-color: var(--blue); }
.recall-chat-threads-actions { display: flex; gap: 6px; }
.recall-chat-new-btn {
  background: transparent;
  border: 1px solid var(--line-2);
  color: var(--text-2);
  border-radius: var(--r-sm);
  padding: 4px 8px;
  font-size: 11.5px;
  cursor: pointer;
  font-family: inherit;
}
.recall-chat-new-btn:hover { background: var(--bg-3); color: var(--text); }
.recall-chat-threads-list {
  flex: 1;
  overflow-y: auto;
  padding: 6px 0;
}
.recall-chat-thread {
  padding: 8px 12px;
  display: flex; gap: 10px; align-items: center;
  cursor: pointer;
  border-bottom: 1px solid var(--line);
}
.recall-chat-thread:hover { background: var(--bg-2); }
.recall-chat-thread.active { background: var(--bg-2); }
.recall-chat-thread-info { flex: 1; min-width: 0; }
.recall-chat-thread-name {
  font-size: 13px; font-weight: 600;
  color: var(--text);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  display: flex; align-items: center; gap: 6px;
}
.recall-chat-thread-preview {
  font-size: 11.5px;
  color: var(--text-3);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.recall-chat-thread-meta {
  display: flex; flex-direction: column; align-items: flex-end; gap: 2px;
  flex-shrink: 0;
}
.recall-chat-thread-time {
  font-size: 10.5px;
  color: var(--text-4);
}
.recall-chat-unread {
  background: var(--blue);
  color: #fff;
  font-size: 10.5px;
  font-weight: 700;
  padding: 1px 6px;
  border-radius: 999px;
  min-width: 16px; text-align: center;
}
.recall-chat-search-results {
  border-top: 1px solid var(--line-2);
  max-height: 280px;
  overflow-y: auto;
  background: var(--bg-2);
}
.recall-chat-result {
  display: flex; gap: 10px; align-items: center;
  padding: 8px 12px;
  cursor: pointer;
  border-bottom: 1px solid var(--line);
}
.recall-chat-result:hover { background: var(--bg-3); }
.recall-chat-result-info { display: flex; flex-direction: column; }
.recall-chat-result-name { font-size: 13px; color: var(--text); }
.recall-chat-result-role { font-size: 11px; color: var(--text-3); }
.recall-chat-empty {
  padding: 24px 12px;
  text-align: center;
  color: var(--text-4);
  font-size: 12.5px;
}
.recall-chat-conv {
  flex: 1;
  display: flex; flex-direction: column;
  min-width: 0;
  background: var(--bg-2);
}
.recall-chat-conv-head {
  padding: 12px 14px;
  border-bottom: 1px solid var(--line-2);
  display: flex; align-items: center; gap: 10px;
}
.recall-chat-back {
  background: transparent; border: 0;
  color: var(--text-3);
  cursor: pointer;
  font-size: 18px;
  padding: 0 4px;
  display: none;
}
@media (max-width: 720px) {
  .recall-chat-back { display: inline-block; }
}
.recall-chat-conv-title {
  font-size: 14px; font-weight: 600;
  color: var(--text);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  flex: 1; min-width: 0;
}
.recall-chat-conv-sub {
  font-size: 11px;
  color: var(--text-3);
}
.recall-chat-messages {
  flex: 1;
  overflow-y: auto;
  padding: 12px 14px;
  display: flex; flex-direction: column; gap: 8px;
}
.recall-chat-msg {
  max-width: 70%;
  padding: 8px 12px;
  border-radius: 12px;
  font-size: 13px;
  line-height: 1.45;
  word-break: break-word;
  position: relative;
}
.recall-chat-msg.me {
  align-self: flex-end;
  background: var(--blue);
  color: #fff;
  border-bottom-right-radius: 4px;
}
.recall-chat-msg.them {
  align-self: flex-start;
  background: var(--bg-3);
  color: var(--text);
  border-bottom-left-radius: 4px;
}
.recall-chat-msg.pending {
  opacity: 0.7;
}
.recall-chat-msg.failed {
  border: 1px solid var(--red);
}
.recall-chat-msg .sender-name {
  display: block;
  font-size: 10.5px;
  font-weight: 700;
  margin-bottom: 2px;
  opacity: 0.8;
}
.recall-chat-msg .msg-time {
  display: block;
  font-size: 10px;
  margin-top: 4px;
  opacity: 0.7;
}
.recall-chat-input {
  padding: 10px 12px;
  border-top: 1px solid var(--line-2);
  display: flex; gap: 8px;
  background: var(--bg);
}
.recall-chat-input textarea {
  flex: 1;
  min-height: 36px;
  max-height: 120px;
  resize: none;
  background: var(--bg-3);
  border: 1px solid var(--line-2);
  border-radius: var(--r-sm);
  color: var(--text);
  font-family: inherit;
  font-size: 13px;
  padding: 8px 10px;
  outline: none;
}
.recall-chat-input textarea:focus { border-color: var(--blue); }
.recall-chat-send {
  background: var(--blue);
  color: #fff;
  border: 0;
  border-radius: var(--r-sm);
  padding: 0 14px;
  font-size: 12.5px;
  font-weight: 600;
  cursor: pointer;
  font-family: inherit;
}
.recall-chat-send:disabled { opacity: 0.5; cursor: not-allowed; }
.recall-chat-toast {
  position: fixed;
  right: 24px;
  bottom: 92px;
  z-index: 80;
  max-width: 360px;
  background: var(--bg-2);
  border: 1px solid var(--line-2);
  border-left: 3px solid var(--blue);
  border-radius: var(--r-md);
  box-shadow: 0 12px 30px rgba(0,0,0,0.5);
  padding: 10px 14px;
  display: flex; gap: 10px; align-items: flex-start;
  font-size: 13px;
  color: var(--text);
  animation: recall-chat-toast-in 0.18s ease-out;
}
.recall-chat-toast.fadeout {
  animation: recall-chat-toast-out 0.32s ease forwards;
}
@keyframes recall-chat-toast-in {
  from { opacity: 0; transform: translateY(8px); }
  to   { opacity: 1; transform: translateY(0); }
}
@keyframes recall-chat-toast-out {
  from { opacity: 1; transform: translateY(0); }
  to   { opacity: 0; transform: translateY(8px); }
}
.recall-chat-modal-bg {
  position: fixed; inset: 0;
  background: rgba(0,0,0,0.55);
  z-index: 95;
  display: flex; align-items: center; justify-content: center;
}
.recall-chat-modal {
  background: var(--bg-2);
  border: 1px solid var(--line-2);
  border-radius: var(--r-md);
  width: 480px; max-width: calc(100vw - 32px);
  max-height: 80vh;
  display: flex; flex-direction: column;
  box-shadow: 0 18px 50px rgba(0,0,0,0.5);
}
.recall-chat-modal-head {
  padding: 14px 16px;
  border-bottom: 1px solid var(--line-2);
  font-size: 14px; font-weight: 700;
}
.recall-chat-modal-body {
  padding: 14px 16px;
  overflow-y: auto;
  display: flex; flex-direction: column; gap: 10px;
}
.recall-chat-modal-body input[type="text"] {
  width: 100%;
  background: var(--bg-3);
  border: 1px solid var(--line-2);
  border-radius: var(--r-sm);
  color: var(--text);
  padding: 8px 10px;
  font-family: inherit;
  font-size: 13px;
  outline: none;
}
.recall-chat-modal-body input[type="text"]:focus { border-color: var(--blue); }
.recall-chat-pick-list {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 6px;
  max-height: 280px;
  overflow-y: auto;
}
.recall-chat-pick {
  display: flex; gap: 8px; align-items: center;
  padding: 6px 8px;
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  cursor: pointer;
  user-select: none;
}
.recall-chat-pick.selected { border-color: var(--blue); background: rgba(88,166,255,0.08); }
.recall-chat-modal-foot {
  padding: 12px 16px;
  border-top: 1px solid var(--line-2);
  display: flex; justify-content: flex-end; gap: 8px;
}
.recall-chat-modal-foot button {
  background: var(--bg-3);
  color: var(--text);
  border: 1px solid var(--line-2);
  border-radius: var(--r-sm);
  padding: 6px 14px;
  font-family: inherit;
  font-size: 12.5px;
  cursor: pointer;
}
.recall-chat-modal-foot .primary {
  background: var(--blue);
  color: #fff;
  border-color: var(--blue);
}
.recall-chat-modal-foot button:disabled { opacity: 0.5; cursor: not-allowed; }
.recall-chat-msg-empty {
  padding: 32px 12px;
  text-align: center;
  color: var(--text-4);
  font-size: 12.5px;
}
    `;
    const tag = document.createElement('style');
    tag.id = STYLE_ID;
    tag.textContent = css;
    document.head.appendChild(tag);
  }

  function avatarEl(profile, sizePx) {
    const span = el('span', { class: 'recall-avatar-circle' });
    span.style.width = (sizePx || 30) + 'px';
    span.style.height = (sizePx || 30) + 'px';
    const url = profile && profile.avatar_url;
    if (url) {
      span.innerHTML = `<img alt="" src="${escapeHtml(url)}">`;
    } else {
      span.style.background = `hsl(${hueFromId(profile && profile.id)} 55% 38%)`;
      span.style.color = '#fff';
      span.style.fontSize = Math.max(10, Math.floor((sizePx || 30) * 0.4)) + 'px';
      span.style.fontWeight = '700';
      span.style.display = 'inline-flex';
      span.style.alignItems = 'center';
      span.style.justifyContent = 'center';
      span.style.borderRadius = '50%';
      span.textContent = initials(profile && profile.full_name);
    }
    return span;
  }

  function threadLabel(thread, myId) {
    if (thread.kind === 'staff_group') {
      if (thread.name && thread.name.trim()) return thread.name.trim();
      const others = thread.other_members || [];
      const names = others.map((m) => m.full_name || 'Unknown').slice(0, 3).join(', ');
      return names || 'Group';
    }
    const others = thread.other_members || [];
    if (others.length === 1) return others[0].full_name || 'Direct message';
    return others.map((m) => m.full_name || '?').join(', ') || 'Direct message';
  }

  function showToast(msg, fallback) {
    if (typeof window.toast === 'function') {
      try { window.toast(msg, 'info'); return; } catch (_) { /* fall through */ }
    }
    if (typeof fallback === 'function') { fallback(msg); return; }
  }

  function mount(opts) {
    if (!opts || !opts.supabaseClient || !opts.user || !opts.profile) return null;
    const sb = opts.supabaseClient;
    const user = opts.user;
    const myProfile = opts.profile || {};
    const myId = user.id;

    injectStyle();

    // ---- FAB ----
    const fab = el('button', { class: 'recall-chat-fab', 'aria-label': 'Open chat' });
    fab.innerHTML = `<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">
      <path fill="currentColor" d="M4 4h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-9l-5 4v-4H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z"/>
    </svg>`;
    const fabBadge = el('span', { class: 'recall-chat-fab-badge', hidden: '' , text: '0' });
    fab.appendChild(fabBadge);
    document.body.appendChild(fab);

    // ---- Panel ----
    const panel = el('div', { class: 'recall-chat-panel' });

    const threadsCol = el('div', { class: 'recall-chat-threads' });
    const threadsHead = el('div', { class: 'recall-chat-threads-head' });
    threadsHead.appendChild(el('h3', { text: 'Messages' }));
    const searchInput = el('input', {
      class: 'recall-chat-search',
      type: 'text',
      placeholder: 'Search people...',
      autocomplete: 'off'
    });
    threadsHead.appendChild(searchInput);
    const actionsRow = el('div', { class: 'recall-chat-threads-actions' });
    if (isStaff(myProfile.role)) {
      const newGroupBtn = el('button', {
        class: 'recall-chat-new-btn',
        type: 'button',
        text: '+ New group'
      });
      newGroupBtn.addEventListener('click', () => openGroupModal());
      actionsRow.appendChild(newGroupBtn);
    }
    threadsHead.appendChild(actionsRow);
    threadsCol.appendChild(threadsHead);

    const searchResults = el('div', { class: 'recall-chat-search-results', hidden: '' });
    threadsCol.appendChild(searchResults);

    const threadList = el('div', { class: 'recall-chat-threads-list' });
    threadList.appendChild(el('div', { class: 'recall-chat-empty', text: 'Loading...' }));
    threadsCol.appendChild(threadList);

    panel.appendChild(threadsCol);

    const convCol = el('div', { class: 'recall-chat-conv' });
    const convHead = el('div', { class: 'recall-chat-conv-head' });
    const backBtn = el('button', { class: 'recall-chat-back', type: 'button', text: '‹' });
    backBtn.addEventListener('click', () => panel.classList.add('conv-hidden'));
    convHead.appendChild(backBtn);
    const convTitle = el('div', { class: 'recall-chat-conv-title', text: 'Select a conversation' });
    convHead.appendChild(convTitle);
    const convSub = el('div', { class: 'recall-chat-conv-sub' });
    convHead.appendChild(convSub);
    convCol.appendChild(convHead);

    const messagesEl = el('div', { class: 'recall-chat-messages' });
    messagesEl.appendChild(el('div', { class: 'recall-chat-msg-empty', text: 'Pick a conversation on the left.' }));
    convCol.appendChild(messagesEl);

    const inputBar = el('div', { class: 'recall-chat-input' });
    const textarea = el('textarea', { rows: '1', placeholder: 'Type a message...' });
    const sendBtn = el('button', { class: 'recall-chat-send', type: 'button', text: 'Send' });
    sendBtn.disabled = true;
    inputBar.appendChild(textarea);
    inputBar.appendChild(sendBtn);
    convCol.appendChild(inputBar);
    panel.appendChild(convCol);

    document.body.appendChild(panel);

    // ---- State ----
    let threads = [];
    let activeThreadId = null;
    let activeMessages = [];
    let myThreadIds = new Set();
    let realtimeChannel = null;
    let panelOpen = false;
    let searchDebounce = null;

    function fmtRolePill(r) {
      return roleLabel(r);
    }

    async function refreshUnreadBadge() {
      try {
        const { data, error } = await sb.rpc('count_unread_dms');
        if (error) return;
        const n = Number(data) || 0;
        if (n > 0) {
          fabBadge.textContent = String(n);
          fabBadge.hidden = false;
          fab.classList.add('has-unread');
        } else {
          fabBadge.hidden = true;
          fab.classList.remove('has-unread');
        }
      } catch (_) { /* ignore */ }
    }

    async function refreshThreads() {
      try {
        const { data, error } = await sb.rpc('list_dm_threads');
        if (error) throw error;
        threads = data || [];
        myThreadIds = new Set(threads.map((t) => t.id));
        paintThreadList();
        refreshUnreadBadge();
      } catch (e) {
        threadList.innerHTML = '';
        threadList.appendChild(el('div', {
          class: 'recall-chat-empty',
          text: 'Could not load conversations.'
        }));
      }
    }

    function paintThreadList() {
      threadList.innerHTML = '';
      if (!threads.length) {
        threadList.appendChild(el('div', {
          class: 'recall-chat-empty',
          text: 'No conversations yet. Search above to start one.'
        }));
        return;
      }
      for (const t of threads) {
        const row = el('div', { class: 'recall-chat-thread' });
        if (t.id === activeThreadId) row.classList.add('active');

        // Avatar: stack for group, single for direct. Single-avatar branch wraps
        // the avatar in an anchor to profile.html so clicking it opens the
        // profile in a new tab; the row click handler still opens the thread.
        const av = el('div', { style: { position: 'relative', width: '32px', height: '32px', flexShrink: '0' } });
        if (t.kind === 'staff_group' && t.other_members && t.other_members.length > 1) {
          const a1 = avatarEl(t.other_members[0], 22);
          a1.style.position = 'absolute'; a1.style.top = '0'; a1.style.left = '0';
          const a2 = avatarEl(t.other_members[1], 22);
          a2.style.position = 'absolute'; a2.style.bottom = '0'; a2.style.right = '0';
          a2.style.boxShadow = '0 0 0 2px var(--bg)';
          av.appendChild(a1);
          av.appendChild(a2);
        } else {
          const a = avatarEl((t.other_members && t.other_members[0]) || {}, 32);
          a.style.width = '32px'; a.style.height = '32px';
          const other = (t.other_members && t.other_members[0]) || {};
          if (other && other.id) {
            const link = el('a', {
              class: 'recall-chat-avatar-link',
              href: 'profile.html?id=' + encodeURIComponent(other.id),
              target: '_blank', rel: 'noopener'
            });
            link.appendChild(a);
            av.appendChild(link);
          } else {
            av.appendChild(a);
          }
        }
        row.appendChild(av);

        const info = el('div', { class: 'recall-chat-thread-info' });
        info.appendChild(el('div', {
          class: 'recall-chat-thread-name',
          text: threadLabel(t, myId)
        }));
        info.appendChild(el('div', {
          class: 'recall-chat-thread-preview',
          text: t.last_message_preview || '—'
        }));
        row.appendChild(info);

        const meta = el('div', { class: 'recall-chat-thread-meta' });
        meta.appendChild(el('div', {
          class: 'recall-chat-thread-time',
          text: fmtShort(t.last_message_at || t.created_at)
        }));
        if (t.unread_count && t.unread_count > 0) {
          meta.appendChild(el('div', {
            class: 'recall-chat-unread',
            text: String(t.unread_count)
          }));
        }
        row.appendChild(meta);

        row.addEventListener('click', () => openThread(t.id));
        threadList.appendChild(row);
      }
    }

    async function openThread(threadId) {
      activeThreadId = threadId;
      paintThreadList();
      panel.classList.remove('threads-hidden');
      panel.classList.add('conv-hidden');
      const t = threads.find((x) => x.id === threadId);
      if (t) {
        convTitle.textContent = threadLabel(t, myId);
        const subs = [];
        if (t.kind === 'staff_group') subs.push(`${t.member_count || 0} members`);
        else {
          const o = (t.other_members || [])[0];
          if (o) subs.push(fmtRolePill(o.role));
        }
        convSub.textContent = subs.join(' • ');
      } else {
        convTitle.textContent = 'Loading...';
        convSub.textContent = '';
      }
      messagesEl.innerHTML = '';
      messagesEl.appendChild(el('div', { class: 'recall-chat-msg-empty', text: 'Loading...' }));
      sendBtn.disabled = true;
      textarea.value = '';

      try {
        const { data, error } = await sb.rpc('list_dm_messages', {
          p_thread_id: threadId,
          p_limit: 100,
          p_before: null
        });
        if (error) throw error;
        activeMessages = (data || []).slice().reverse();
        paintMessages();
        sendBtn.disabled = false;
        await sb.rpc('mark_dm_thread_read', { p_thread_id: threadId });
        // Refresh threads (so the unread badge clears).
        refreshThreads();
      } catch (e) {
        messagesEl.innerHTML = '';
        messagesEl.appendChild(el('div', {
          class: 'recall-chat-msg-empty',
          text: 'Could not load messages.'
        }));
      }
    }

    function paintMessages() {
      messagesEl.innerHTML = '';
      if (!activeMessages.length) {
        messagesEl.appendChild(el('div', {
          class: 'recall-chat-msg-empty',
          text: 'No messages yet. Say hi!'
        }));
        return;
      }
      const t = threads.find((x) => x.id === activeThreadId);
      const isGroup = t && t.kind === 'staff_group';
      for (const m of activeMessages) {
        const mine = m.sender_id === myId;
        const msg = el('div', {
          class: 'recall-chat-msg ' + (mine ? 'me' : 'them')
        });
        if (m._pending) msg.classList.add('pending');
        if (m._failed) msg.classList.add('failed');
        if (isGroup && !mine) {
          const sn = el('span', { class: 'sender-name', text: m.sender_name || '' });
          msg.appendChild(sn);
        }
        msg.appendChild(document.createTextNode(m.body));
        msg.appendChild(el('span', {
          class: 'msg-time',
          text: m._pending ? 'sending…' : (m._failed ? 'failed — retry' : fmtTime(m.created_at))
        }));
        messagesEl.appendChild(msg);
      }
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    async function sendCurrent() {
      const body = textarea.value.trim();
      if (!body || !activeThreadId) return;
      textarea.value = '';
      sendBtn.disabled = true;
      const tempId = 'pending-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
      const optimistic = {
        id: tempId,
        sender_id: myId,
        sender_name: myProfile.full_name || 'You',
        body: body,
        created_at: new Date().toISOString(),
        _pending: true
      };
      activeMessages.push(optimistic);
      paintMessages();
      try {
        const { data, error } = await sb.rpc('send_dm_message', {
          p_thread_id: activeThreadId,
          p_body: body
        });
        if (error) throw error;
        // Replace pending with the real row.
        const idx = activeMessages.findIndex((m) => m.id === tempId);
        if (idx >= 0 && data) {
          activeMessages[idx] = {
            id: data.id,
            sender_id: data.sender_id,
            sender_name: myProfile.full_name || 'You',
            body: data.body,
            created_at: data.created_at
          };
        }
        // The realtime subscription will also fire, but our own
        // sender_id === myId, so it's filtered out. We update thread
        // metadata directly here.
        const t = threads.find((x) => x.id === activeThreadId);
        if (t) {
          t.last_message_at = new Date().toISOString();
          t.last_message_preview = body.slice(0, 80);
        }
        paintMessages();
        paintThreadList();
      } catch (e) {
        const idx = activeMessages.findIndex((m) => m.id === tempId);
        if (idx >= 0) {
          activeMessages[idx]._pending = false;
          activeMessages[idx]._failed = true;
        }
        paintMessages();
        showToast('Could not send message');
      } finally {
        sendBtn.disabled = !textarea.value.trim();
        textarea.focus();
      }
    }

    sendBtn.addEventListener('click', sendCurrent);
    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendCurrent();
      }
    });
    textarea.addEventListener('input', () => {
      sendBtn.disabled = !textarea.value.trim();
      autoSize();
    });
    function autoSize() {
      textarea.style.height = 'auto';
      textarea.style.height = Math.min(120, textarea.scrollHeight) + 'px';
    }

    // ---- Predictive search ----
    function paintResults(rows) {
      searchResults.innerHTML = '';
      if (!rows || !rows.length) {
        searchResults.appendChild(el('div', {
          class: 'recall-chat-empty',
          text: 'No matches.'
        }));
        return;
      }
      for (const r of rows) {
        const row = el('div', { class: 'recall-chat-result' });
        // Avatar wrapped in anchor to profile.html — opens in a new tab
        // so the row's own click handler (startDirectDM) still runs.
        const av = avatarEl(r, 28);
        av.style.width = '28px'; av.style.height = '28px';
        if (r && r.id) {
          const link = el('a', {
            class: 'recall-chat-avatar-link',
            href: 'profile.html?id=' + encodeURIComponent(r.id),
            target: '_blank', rel: 'noopener'
          });
          link.appendChild(av);
          row.appendChild(link);
        } else {
          row.appendChild(av);
        }
        const info = el('div', { class: 'recall-chat-result-info' });
        info.appendChild(el('div', { class: 'recall-chat-result-name', text: r.full_name || 'Unknown' }));
        info.appendChild(el('div', { class: 'recall-chat-result-role', text: roleLabel(r.role) }));
        row.appendChild(info);
        row.addEventListener('click', () => startDirectDM(r));
        searchResults.appendChild(row);
      }
    }

    async function runSearch(q) {
      if (!q || q.trim().length < 1) {
        searchResults.hidden = true;
        searchResults.innerHTML = '';
        return;
      }
      try {
        const { data, error } = await sb.rpc('search_dm_recipients', {
          p_query: q,
          p_limit: 8
        });
        if (error) throw error;
        searchResults.hidden = false;
        paintResults(data || []);
      } catch (e) {
        searchResults.hidden = false;
        searchResults.innerHTML = '';
        searchResults.appendChild(el('div', {
          class: 'recall-chat-empty',
          text: 'Search failed.'
        }));
      }
    }

    searchInput.addEventListener('input', () => {
      clearTimeout(searchDebounce);
      searchDebounce = setTimeout(() => runSearch(searchInput.value), 180);
    });

    async function startDirectDM(other) {
      searchInput.value = '';
      searchResults.hidden = true;
      try {
        const kind = directKindFor(myProfile.role);
        let schoolId = null;
        if (kind === 'teacher_direct' || kind === 'school_direct') {
          // Caller's school_id is needed.
          const { data: me, error: meErr } = await sb
            .from('profiles').select('school_id').eq('id', myId).single();
          if (meErr) throw meErr;
          schoolId = me && me.school_id ? me.school_id : null;
        }
        const { data: thread, error } = await sb.rpc('create_dm_thread', {
          p_kind: kind,
          p_member_ids: [other.id],
          p_name: null,
          p_school_id: schoolId
        });
        if (error) throw error;
        await refreshThreads();
        if (thread && thread.id) openThread(thread.id);
      } catch (e) {
        showToast('Could not start conversation');
      }
    }

    async function openWithUser(userId) {
      try {
        const { data: profile, error } = await sb
          .from('profiles')
          .select('id, full_name, role, avatar_url')
          .eq('id', userId)
          .single();
        if (error || !profile) throw error || new Error('Not found');
        open();
        await startDirectDM(profile);
      } catch (e) {
        showToast('Could not open conversation');
      }
    }

    // ---- Group modal ----
    async function openGroupModal() {
      // Fetch all staff members.
      let staff = [];
      try {
        const { data, error } = await sb.rpc('list_staff');
        if (error) throw error;
        staff = (data || []).filter((s) => s.id !== myId);
      } catch (e) {
        showToast('Could not load staff list');
        return;
      }

      const bg = el('div', { class: 'recall-chat-modal-bg' });
      const modal = el('div', { class: 'recall-chat-modal' });
      const mhead = el('div', { class: 'recall-chat-modal-head', text: 'New group' });
      modal.appendChild(mhead);
      const mbody = el('div', { class: 'recall-chat-modal-body' });
      const nameInput = el('input', { type: 'text', placeholder: 'Group name (optional)' });
      mbody.appendChild(nameInput);
      const pickWrap = el('div', { class: 'recall-chat-pick-list' });
      const selected = new Set();
      const renderPicks = () => {
        pickWrap.innerHTML = '';
        for (const s of staff) {
          const pick = el('div', { class: 'recall-chat-pick' });
          if (selected.has(s.id)) pick.classList.add('selected');
          pick.appendChild(avatarEl(s, 24));
          pick.appendChild(el('div', {
            class: 'recall-chat-result-info',
            style: { flex: '1' }
          }, [
            el('div', { class: 'recall-chat-result-name', text: s.full_name || 'Unknown' }),
            el('div', { class: 'recall-chat-result-role', text: roleLabel(s.role) })
          ]));
          pick.addEventListener('click', () => {
            if (selected.has(s.id)) selected.delete(s.id);
            else if (selected.size < 9) selected.add(s.id);
            renderPicks();
          });
          pickWrap.appendChild(pick);
        }
      };
      renderPicks();
      mbody.appendChild(pickWrap);
      modal.appendChild(mbody);
      const mfoot = el('div', { class: 'recall-chat-modal-foot' });
      const cancelBtn = el('button', { type: 'button', text: 'Cancel' });
      cancelBtn.addEventListener('click', () => bg.remove());
      const createBtn = el('button', { type: 'button', class: 'primary', text: 'Create' });
      const updateBtn = () => {
        createBtn.disabled = selected.size < 1;
      };
      updateBtn();
      // Re-render so disabled state can flip on every click.
      const origRender = renderPicks;
      // (wrap picks to refresh btn state)
      const refreshAll = () => { origRender(); updateBtn(); };
      // Replace the inline renderer closure by mutating selected observer.
      // Simpler: just update after every click via a small loop:
      // (renderPicks above already runs on each click)
      // To keep button state current, intercept by reading selected.size on click.
      // Override behavior: re-render picks, then update button.
      // Patch: re-define click handler to call refreshAll.
      // (Done above via the simple closure — but update button not auto-called.)
      // Use a tiny poll: after renderPicks, also call updateBtn.
      // Re-implement by overriding renderPicks once with refresh-all wrapper.
      // (Idempotent, so safe.)
      // Note: this is a small workaround — wrap once.
      // We just patch the original handler to also call updateBtn.
      for (const child of pickWrap.children) {
        // override click
        child.onclick = null;
      }
      // Rebuild picks with refresh-all:
      const renderPicks2 = () => {
        pickWrap.innerHTML = '';
        for (const s of staff) {
          const pick = el('div', { class: 'recall-chat-pick' });
          if (selected.has(s.id)) pick.classList.add('selected');
          pick.appendChild(avatarEl(s, 24));
          pick.appendChild(el('div', {
            class: 'recall-chat-result-info',
            style: { flex: '1' }
          }, [
            el('div', { class: 'recall-chat-result-name', text: s.full_name || 'Unknown' }),
            el('div', { class: 'recall-chat-result-role', text: roleLabel(s.role) })
          ]));
          pick.addEventListener('click', () => {
            if (selected.has(s.id)) selected.delete(s.id);
            else if (selected.size < 9) selected.add(s.id);
            renderPicks2();
          });
          pickWrap.appendChild(pick);
        }
        updateBtn();
      };
      renderPicks2();
      mfoot.appendChild(cancelBtn);
      mfoot.appendChild(createBtn);
      modal.appendChild(mfoot);
      bg.appendChild(modal);
      document.body.appendChild(bg);

      createBtn.addEventListener('click', async () => {
        if (selected.size < 1) return;
        createBtn.disabled = true;
        try {
          const ids = Array.from(selected);
          const { data: thread, error } = await sb.rpc('create_dm_thread', {
            p_kind: 'staff_group',
            p_member_ids: ids,
            p_name: nameInput.value.trim() || null,
            p_school_id: null
          });
          if (error) throw error;
          bg.remove();
          await refreshThreads();
          if (thread && thread.id) openThread(thread.id);
        } catch (e) {
          createBtn.disabled = false;
          showToast('Could not create group');
        }
      });
    }

    // ---- Realtime ----
    function subscribeRealtime() {
      if (realtimeChannel) return;
      realtimeChannel = sb
        .channel('dm_messages:' + myId)
        .on('postgres_changes', {
          event: 'INSERT',
          schema: 'public',
          table: 'dm_messages'
        }, (payload) => {
          const m = payload && payload.new;
          if (!m) return;
          if (m.sender_id === myId) return; // ignore self echoes
          if (!myThreadIds.has(m.thread_id)) return;
          handleIncomingMessage(m);
        })
        .subscribe();
    }

    async function handleIncomingMessage(m) {
      // Optimistic append if this is the active thread.
      const isActive = activeThreadId === m.thread_id;
      // Fetch the sender's display info (1 round-trip).
      let senderName = null;
      let senderAvatar = null;
      try {
        const { data: p } = await sb
          .from('profiles')
          .select('full_name, avatar_url')
          .eq('id', m.sender_id)
          .single();
        if (p) {
          senderName = p.full_name;
          senderAvatar = p.avatar_url;
        }
      } catch (_) { /* ignore */ }

      if (isActive) {
        activeMessages.push({
          id: m.id,
          sender_id: m.sender_id,
          sender_name: senderName,
          sender_avatar: senderAvatar,
          body: m.body,
          created_at: m.created_at
        });
        paintMessages();
        // mark read since the user is viewing it.
        try { await sb.rpc('mark_dm_thread_read', { p_thread_id: m.thread_id }); } catch (_) { /* ignore */ }
      } else {
        // Outside the active thread — show a toast.
        const preview = (senderName || 'Someone') + ': ' + String(m.body).slice(0, 80);
        showToast(preview);
      }
      // Update thread sidebar metadata.
      const t = threads.find((x) => x.id === m.thread_id);
      if (t) {
        t.last_message_at = m.created_at;
        t.last_message_preview = String(m.body).slice(0, 80);
        if (!isActive) t.unread_count = (t.unread_count || 0) + 1;
        paintThreadList();
      } else {
        refreshThreads();
      }
      refreshUnreadBadge();
    }

    // ---- Open / close ----
    function open() {
      panel.classList.add('open');
      panel.classList.remove('threads-hidden', 'conv-hidden');
      panelOpen = true;
      refreshThreads();
    }
    function close() {
      panel.classList.remove('open');
      panelOpen = false;
      // mark active thread read on close (if there's any new content).
      if (activeThreadId) {
        sb.rpc('mark_dm_thread_read', { p_thread_id: activeThreadId }).catch(() => {});
      }
    }
    function toggle() { panelOpen ? close() : open(); }

    fab.addEventListener('click', () => { panelOpen ? close() : open(); });

    // Close on outside click.
    document.addEventListener('click', (e) => {
      if (!panelOpen) return;
      if (panel.contains(e.target)) return;
      if (fab.contains(e.target)) return;
      // close
      close();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && panelOpen) close();
    });
    window.addEventListener('beforeunload', () => {
      if (realtimeChannel) sb.removeChannel(realtimeChannel);
    });

    // ---- Bootstrap ----
    subscribeRealtime();
    refreshUnreadBadge();
    refreshThreads();

    return { open, close, toggle, openWithUser };
  }

  window.recallChat = { mount: mount };
})();