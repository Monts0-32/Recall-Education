// ============================================================================
// school-wheel.js — app-style "school wheel": a slowly rotating carousel of
// app tiles orbiting a central school hub. Loaded with <script defer> on
// every page that mounts one (student/teacher/organiser dashboards and the
// school-systems hub). Self-contained: injects scoped CSS, builds DOM,
// runs its own rAF loop.
//
// Public API:
//   window.recallWheel.mount(container, config)  // -> { destroy() } | null
//     container — DOM element or id string (its content is replaced)
//     config    — {
//       schoolName   : string          — hub label (fallback 'Our school')
//       apps         : [{ href, icon, name,
//                        tone: 'blue'|'green'|'yellow'|'red'|'purple',
//                        locked: boolean, title: string }]
//       onLockedClick: (app) => {}     — click on a locked app
//       maxWidth     : number         — optional wheel px cap (default 460)
//     }
//   window.recallWheel.stop()                  // destroys the single instance
//
// Behaviour:
//   * One rAF loop eases a --rw-angle custom property; each icon sits in a
//     0x0 orbit wrapper with transform
//       rotate(base + angle) translate(radius) rotate(-(base + angle))
//     so the icon travels the circle while chip AND label stay upright.
//   * Hovering the wheel (fine pointers only) or focusing inside it eases
//     the speed to 0; leaving eases back. prefers-reduced-motion never spins.
//   * Hover pops the chip via CSS scale on an inner element (composes with
//     the orbit transform), locked chips dim + show a lock badge and their
//     clicks are intercepted for the page's onLockedClick toast.
//   * ResizeObserver re-measures — also covers wheels mounted inside cards
//     that a dashboard layout later un-hides (clientWidth 0 -> real width).
// ============================================================================

(function () {
  'use strict';

  const STYLE_ID = 'recall-wheel-style';
  const BASE_SPEED = 8; // deg/s -> ~45s per revolution
  const EASE = 5;       // speed-lerp rate (hover pause settles in ~0.5s)

  let instance = null;

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  const CSS = `
.rw-wheel { position: relative; width: 100%; aspect-ratio: 1 / 1; margin: 0 auto; }
.rw-track {
  position: absolute; left: 50%; top: 50%;
  width: calc(var(--rw-radius) * 2); height: calc(var(--rw-radius) * 2);
  transform: translate(-50%, -50%);
  border: 1px dashed var(--line-2); border-radius: 50%;
  pointer-events: none;
}
.rw-orbit {
  position: absolute; left: 50%; top: 50%; width: 0; height: 0;
  transform: rotate(calc(var(--rw-base) + var(--rw-angle)))
             translate(var(--rw-radius))
             rotate(calc(-1 * (var(--rw-base) + var(--rw-angle))));
}
.rw-app {
  position: absolute; left: 0; top: 0;
  transform: translate(-50%, -50%);
  display: flex; flex-direction: column; align-items: center; gap: 6px;
  text-decoration: none; color: var(--text-3);
}
.rw-chip {
  position: relative;
  width: var(--rw-chip); height: var(--rw-chip);
  border-radius: calc(var(--rw-chip) * 0.24);
  display: grid; place-items: center;
  font-size: calc(var(--rw-chip) * 0.46);
  background: var(--blue-dim); border: 1px solid rgba(56,139,253,0.3);
  transition: transform .18s ease, border-color .18s ease, box-shadow .18s ease;
}
.rw-app.rw-tone-green  .rw-chip { background: var(--green-dim);  border-color: rgba(63,185,80,0.3); }
.rw-app.rw-tone-yellow .rw-chip { background: var(--yellow-dim); border-color: rgba(210,153,34,0.3); }
.rw-app.rw-tone-red    .rw-chip { background: var(--red-dim);    border-color: rgba(248,81,73,0.3); }
.rw-app.rw-tone-purple .rw-chip { background: var(--purple-dim); border-color: rgba(163,113,247,0.3); }
.rw-label {
  font-size: 11.5px; font-weight: 500; line-height: 1.25;
  max-width: calc(var(--rw-chip) * 1.8); text-align: center;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
  transition: color .18s ease;
}
.rw-app:hover .rw-chip {
  transform: scale(1.14);
  border-color: var(--line-3);
  box-shadow: 0 6px 18px rgba(0,0,0,0.35);
}
.rw-app:hover .rw-label { color: var(--text); }
.rw-app:focus-visible { outline: 2px solid var(--blue); outline-offset: 3px; border-radius: var(--r-sm); }
.rw-app.rw-locked { cursor: not-allowed; }
.rw-app.rw-locked .rw-chip { opacity: 0.55; }
.rw-app.rw-locked:hover .rw-chip { transform: none; box-shadow: none; border-color: rgba(56,139,253,0.3); }
.rw-app.rw-tone-green.rw-locked:hover  .rw-chip { border-color: rgba(63,185,80,0.3); }
.rw-app.rw-tone-yellow.rw-locked:hover .rw-chip { border-color: rgba(210,153,34,0.3); }
.rw-app.rw-tone-red.rw-locked:hover    .rw-chip { border-color: rgba(248,81,73,0.3); }
.rw-app.rw-tone-purple.rw-locked:hover .rw-chip { border-color: rgba(163,113,247,0.3); }
.rw-lockbadge {
  position: absolute; right: -5px; top: -5px;
  font-size: 11px; line-height: 1;
  background: var(--bg); border: 1px solid var(--line-2);
  border-radius: 999px; padding: 2px 3px;
}
.rw-hub {
  position: absolute; left: 50%; top: 50%;
  width: min(48%, calc(var(--rw-radius) * 1.3));
  transform: translate(-50%, -50%);
  text-align: center; pointer-events: none; user-select: none;
}
.rw-hub .rw-hub-ico { font-size: calc(var(--rw-chip) * 0.62); }
.rw-hub .rw-hub-name {
  margin-top: 2px; font-size: 13px; font-weight: 700; color: var(--text);
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
}
@media (prefers-reduced-motion: reduce) {
  .rw-chip, .rw-label { transition: none; }
  .rw-app:hover .rw-chip { transform: none; box-shadow: none; }
}
`;

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const el = document.createElement('style');
    el.id = STYLE_ID;
    el.textContent = CSS;
    document.head.appendChild(el);
  }

  function mount(container, config) {
    if (instance) instance.destroy();

    const root = typeof container === 'string' ? document.getElementById(container) : container;
    const apps = config && Array.isArray(config.apps)
      ? config.apps.filter(function (a) { return a && a.href && a.name; })
      : [];
    if (!root || !apps.length) return null;

    injectStyle();
    root.innerHTML = '';

    const wheel = document.createElement('div');
    wheel.className = 'rw-wheel';
    if (config.maxWidth) wheel.style.maxWidth = config.maxWidth + 'px';

    // Dashed track circle.
    const track = document.createElement('div');
    track.className = 'rw-track';
    track.setAttribute('aria-hidden', 'true');
    wheel.appendChild(track);

    const step = 360 / apps.length;
    apps.forEach(function (app, i) {
      const orbit = document.createElement('div');
      orbit.className = 'rw-orbit';
      orbit.style.setProperty('--rw-base', (i * step) + 'deg');

      const a = document.createElement('a');
      a.className = 'rw-app'
        + (app.tone && app.tone !== 'blue' ? ' rw-tone-' + app.tone : '')
        + (app.locked ? ' rw-locked' : '');
      a.href = app.href;
      if (app.title) a.title = app.title;
      a.innerHTML =
        '<span class="rw-chip">' + escapeHtml(app.icon || '')
        + (app.locked ? '<span class="rw-lockbadge">\u{1F512}</span>' : '')
        + '</span>'
        + '<span class="rw-label">' + escapeHtml(app.name) + '</span>';
      if (app.locked) {
        a.setAttribute('aria-disabled', 'true');
        a.addEventListener('click', function (e) {
          e.preventDefault();
          if (typeof config.onLockedClick === 'function') config.onLockedClick(app);
        });
      }

      orbit.appendChild(a);
      wheel.appendChild(orbit);
    });

    const hub = document.createElement('div');
    hub.className = 'rw-hub';
    hub.innerHTML = '<div class="rw-hub-ico">\u{1F3EB}</div>'
      + '<div class="rw-hub-name">' + escapeHtml(config.schoolName || 'Our school') + '</div>';
    wheel.appendChild(hub);

    root.appendChild(wheel);

    // ---- responsive sizing (ResizeObserver also fires when a hidden host
    //      card becomes visible, so measure() recovers from width 0) ----
    function measure() {
      const w = wheel.clientWidth || root.clientWidth || 320;
      const chip = Math.round(Math.max(44, Math.min(64, w * 0.14)));
      // The app box (chip + gap + 2-line label) is centred on the orbit
      // point, so its outer half (~chip/2 + 17.5 + pop 4) must fit inside
      // the wheel square.
      const radius = Math.max(chip, Math.round(w / 2 - chip / 2 - 23));
      wheel.style.setProperty('--rw-chip', chip + 'px');
      wheel.style.setProperty('--rw-radius', radius + 'px');
    }
    measure();
    const ro = ('ResizeObserver' in window) ? new ResizeObserver(measure) : null;
    if (ro) ro.observe(wheel);

    // ---- rotation loop ----
    const reduceMq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const hoverMq = window.matchMedia('(hover: hover) and (pointer: fine)');
    let angle = 0, speed = 0, last = 0, rafId = 0, hoverCount = 0, focusCount = 0;

    function targetSpeed() {
      return (hoverCount > 0 || focusCount > 0 || reduceMq.matches) ? 0 : BASE_SPEED;
    }

    function tick(ts) {
      rafId = requestAnimationFrame(tick);
      if (!last) { last = ts; return; }
      const dt = Math.min(0.06, (ts - last) / 1000);
      last = ts;
      const t = targetSpeed();
      speed += (t - speed) * Math.min(1, dt * EASE);
      if (t === 0 && Math.abs(speed) < 0.05) speed = 0;
      if (speed === 0 && t === 0) return; // fully paused: skip the style write
      angle = (angle + speed * dt) % 360;
      wheel.style.setProperty('--rw-angle', angle.toFixed(3) + 'deg');
    }
    function startLoop() {
      if (!rafId && !reduceMq.matches) { last = 0; rafId = requestAnimationFrame(tick); }
    }
    function stopLoop() {
      if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    }
    startLoop();
    function onReduceChange() {
      if (reduceMq.matches) stopLoop(); else startLoop();
    }
    if (reduceMq.addEventListener) reduceMq.addEventListener('change', onReduceChange);

    // Hover pauses — pointerenter fires when the cursor enters the wheel
    // or any descendant. Wired only on fine pointers to avoid sticky
    // hover state after taps on touch devices.
    if (hoverMq.matches) {
      wheel.addEventListener('pointerenter', function () { hoverCount++; });
      wheel.addEventListener('pointerleave', function () { hoverCount = Math.max(0, hoverCount - 1); });
    }
    // Keyboard focus inside the wheel pauses it too (all devices).
    wheel.addEventListener('focusin', function () { focusCount++; });
    wheel.addEventListener('focusout', function () { focusCount = Math.max(0, focusCount - 1); });

    instance = {
      destroy: function () {
        stopLoop();
        if (ro) ro.disconnect();
        if (reduceMq.removeEventListener) reduceMq.removeEventListener('change', onReduceChange);
        root.innerHTML = '';
        instance = null;
      },
    };
    return instance;
  }

  window.recallWheel = {
    mount: mount,
    stop: function () { if (instance) instance.destroy(); },
  };
})();