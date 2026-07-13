/* ----------------------------------------------------------------------
   bubbles.js — shared ambient bubble system for the Recall site.

   Loaded as a deferred script from every page. It:
     1. injects the bubble CSS into <head> (so we don't ship a second file)
     2. decides how many bubbles this page should show, based on
        <body data-bubbles="N"> or the page's role
     3. creates a single <body>-level fixed overlay, spawns the bubbles
     4. animates them with a requestAnimationFrame loop — drift + soft
        wall bounce, gentle repulsion from the cursor, click to pop and
        regrow somewhere new
     5. respects prefers-reduced-motion: bubbles are static
     6. pauses the loop when the tab is hidden

   The overlay is position:fixed;inset:0;z-index:0 so it ignores every
   page's own layout (works on the marketing landing, the centered-card
   auth pages, and the sidebar dashboard alike). The CSS raises the rest
   of the page above it with one selector.
   ---------------------------------------------------------------------- */
(() => {
  "use strict";

  // ----- 1. CSS injection -------------------------------------------------
  // Same visual system that lived in index.html. Lifted verbatim so the
  // look is identical to the previous hand-placed decoration. The
  // overlay-level z-index rule replaces the old .bubble-field > :not(.bubble)
  // selector since the overlay is now the only bubble container.
  const CSS = `
    .bubble-field {
      position: fixed;
      inset: 0;
      z-index: 0;
      overflow: hidden;
      pointer-events: none;     /* the container is invisible to clicks;
                                   each individual bubble opts back in */
    }
    .bubble {
      position: absolute;
      top: 0; left: 0;
      width:  var(--bubble-size, 80px);
      height: var(--bubble-size, 80px);
      border-radius: 50%;
      pointer-events: auto;     /* only the bubble itself catches clicks */
      will-change: transform, opacity;
      transform: translate3d(0, 0, 0);
      background:
        radial-gradient(circle at 30% 28%,
          rgba(255,255,255,0.22) 0%,
          rgba(255,255,255,0.08) 18%,
          rgba(255,255,255,0.02) 40%,
          transparent 70%);
      box-shadow:
        inset 6px 10px 24px rgba(255,255,255,0.10),
        inset -8px -10px 30px rgba(86,212,221,0.06),
        0 0 32px rgba(86,212,221,0.10),
        0 8px 28px rgba(0,0,0,0.20);
      border: 1px solid rgba(255,255,255,0.06);
      transition: opacity 0.25s ease;
    }
    .bubble--cyan {
      background:
        radial-gradient(circle at 30% 28%,
          rgba(124,224,232,0.32) 0%,
          rgba(86,212,221,0.18) 22%,
          rgba(86,212,221,0.06) 50%,
          transparent 75%);
      box-shadow:
        inset 6px 10px 24px rgba(124,224,232,0.18),
        inset -8px -10px 30px rgba(86,212,221,0.10),
        0 0 50px rgba(86,212,221,0.28),
        0 8px 28px rgba(0,0,0,0.20);
      border-color: rgba(124,224,232,0.18);
    }
    .bubble--white {
      background:
        radial-gradient(circle at 30% 28%,
          rgba(255,255,255,0.40) 0%,
          rgba(255,255,255,0.16) 25%,
          rgba(255,255,255,0.04) 55%,
          transparent 80%);
      box-shadow:
        inset 6px 10px 28px rgba(255,255,255,0.28),
        inset -8px -10px 30px rgba(86,212,221,0.10),
        0 0 60px rgba(255,255,255,0.10),
        0 8px 32px rgba(0,0,0,0.22);
      border-color: rgba(255,255,255,0.10);
    }
    .bubble--iridescent {
      background:
        radial-gradient(circle at 50% 50%, transparent 38%, transparent 100%),
        conic-gradient(from 200deg,
          rgba(86,212,221,0.0)  0deg,
          rgba(86,212,221,0.5)  40deg,
          rgba(124,224,232,0.6) 80deg,
          rgba(255,255,255,0.4) 130deg,
          rgba(216,177,74,0.5)  180deg,
          rgba(242,107,98,0.5)  230deg,
          rgba(179,136,248,0.5) 280deg,
          rgba(86,212,221,0.5)  340deg,
          rgba(86,212,221,0.0)  360deg);
      -webkit-mask: radial-gradient(circle, transparent 0%, transparent 50%, #000 70%, #000 100%);
              mask: radial-gradient(circle, transparent 0%, transparent 50%, #000 70%, #000 100%);
      box-shadow:
        inset 6px 10px 24px rgba(255,255,255,0.12),
        0 0 50px rgba(86,212,221,0.20),
        0 8px 28px rgba(0,0,0,0.20);
      border: 1px solid rgba(255,255,255,0.06);
    }
    /* The overlay sits at the body level with z-index: 0. The JS loop
       (section 4) lifts the host page's content above it after the
       overlay is appended — we can't do it in pure CSS without
       clobbering any z-index the host page already set on its nav,
       sidebar, etc. */
    /* Reduced-motion: the JS skips the rAF loop, but we also neutralise
       any inline transitions so the pop doesn't get a flash. */
    @media (prefers-reduced-motion: reduce) {
      .bubble { transition: none; }
    }
  `;
  const styleEl = document.createElement("style");
  styleEl.setAttribute("data-bubbles", "");
  styleEl.textContent = CSS;
  document.head.appendChild(styleEl);

  // ----- 2. Configuration ------------------------------------------------
  // Per-page override: <body data-bubbles="N">
  // Otherwise we pick a count by page role. "Marketing" gets the full
  // set; "form" pages (auth, signup, etc.) get a sparser set so the card
  // stays the focal point; "app" pages (dashboard, lesson) get the
  // sparsest set so content stays readable.
  const FORM_PAGES = new Set([
    "/login.html", "/signup.html", "/signup-teacher.html",
    "/signup-staff.html", "/signup-school-admin.html", "/consent.html",
    "/reset-password.html", "/accept-invite.html",
    "/email-templates.html", "/auth/confirmed.html", "/auth/consent-confirmed.html",
  ]);
  // app = anything not in form set AND not the root. dashboard, lesson,
  // staff-dashboard, admin, lesson-creator.
  const path = window.location.pathname;
  const isIndex = path === "/" || /\/index\.html$/.test(path);
  const explicit = parseInt(document.body.getAttribute("data-bubbles") || "", 10);
  let count;
  if (Number.isFinite(explicit) && explicit >= 0) {
    count = explicit;
  } else if (isIndex) {
    count = 24;
  } else if (FORM_PAGES.has(path)) {
    count = 8;
  } else {
    count = 6;
  }

  // Bail out cleanly if the page asks for zero bubbles (e.g. some
  // future page that wants no decoration).
  if (count <= 0) return;

  // ----- 3. Reduced-motion -----------------------------------------------
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  // ----- 4. Build the overlay + bubbles ----------------------------------
  const overlay = document.createElement("div");
  overlay.className = "bubble-field";
  overlay.setAttribute("aria-hidden", "true");
  document.body.appendChild(overlay);

  // Lift the host page's content above the overlay. We do this in JS
  // (not CSS) so we can preserve any z-index the page already set on
  // nav, sidebar, modals, etc. — only elements whose computed z-index
  // is still `auto` get lifted to 1. Same for position: only elements
  // that are currently `static` become `relative`, so we don't break
  // any layout that already uses sticky/fixed/absolute.
  for (const child of document.body.children) {
    if (child === overlay) continue;
    const tag = child.tagName;
    if (tag === "SCRIPT" || tag === "STYLE" || tag === "LINK" || tag === "META") continue;
    const cs = window.getComputedStyle(child);
    if (cs.position === "static") child.style.position = "relative";
    if (cs.zIndex === "auto")      child.style.zIndex    = "1";
  }

  // Bubble data model. Each entry holds its own position, velocity,
  // size, and variant. The render step writes transform/opacity only —
  // never layout, so it stays cheap.
  const VARIANTS = ["bubble--glass", "bubble--cyan", "bubble--white", "bubble--iridescent"];
  // Weight toward glass (most neutral) and away from iridescent (loudest).
  const VARIANT_WEIGHTS = [0.50, 0.25, 0.18, 0.07];
  // Weighted pick helper
  const pickVariant = () => {
    const r = Math.random();
    let acc = 0;
    for (let i = 0; i < VARIANTS.length; i++) {
      acc += VARIANT_WEIGHTS[i];
      if (r < acc) return VARIANTS[i];
    }
    return VARIANTS[0];
  };
  // Size distribution: most bubbles are small, a few are big.
  // 50% sm, 30% md, 15% lg, 5% xl.
  const SIZES = [
    { p: 0.50, size: 32,  cssClass: "bubble--sm" },
    { p: 0.80, size: 80,  cssClass: "bubble--md" },
    { p: 0.95, size: 160, cssClass: "bubble--lg" },
    { p: 1.00, size: 280, cssClass: "bubble--xl" },
  ];
  const pickSize = () => {
    const r = Math.random();
    let acc = 0;
    for (const s of SIZES) { acc += s.p; if (r < acc) return s; }
    return SIZES[0];
  };

  const bubbles = [];
  // Place bubble at a random point, offsetting by half its size so the
  // centre (which is the position we track) sits inside the viewport.
  const rand = (a, b) => a + Math.random() * (b - a);

  for (let i = 0; i < count; i++) {
    const sz = pickSize();
    const el = document.createElement("div");
    el.className = "bubble " + pickVariant() + " " + sz.cssClass;
    el.style.opacity = "0";                    // fade in
    overlay.appendChild(el);

    const angle = rand(0, Math.PI * 2);
    const speed = rand(6, 18);                 // px/sec
    bubbles.push({
      el,
      size: sz.size,
      x: rand(sz.size / 2, window.innerWidth  - sz.size / 2),
      y: rand(sz.size / 2, window.innerHeight - sz.size / 2),
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      popping: false,
    });
    // Fade-in
    requestAnimationFrame(() => { el.style.opacity = ""; });
  }

  // ----- 5. Cursor tracking ----------------------------------------------
  // We use the cursor position for the repulsion force. It only matters
  // when it's inside the viewport, so we track it loosely.
  const cursor = { x: -9999, y: -9999, active: false };
  window.addEventListener("pointermove", (e) => {
    cursor.x = e.clientX;
    cursor.y = e.clientY;
    cursor.active = true;
  }, { passive: true });
  window.addEventListener("pointerleave", () => { cursor.active = false; cursor.x = -9999; cursor.y = -9999; }, { passive: true });

  // ----- 6. Click → pop --------------------------------------------------
  // Bubbles are the only things in the overlay with pointer-events:auto,
  // so a click that reaches the overlay must have landed on a bubble.
  overlay.addEventListener("click", (e) => {
    const b = bubbles.find((b) => b.el === e.target);
    if (!b) return;
    startPop(b);
  });

  // Pop = scale up + fade out, then respawn at a fresh spot and fade in.
  // The rAF loop drives the pop animation; this function just kicks it off.
  const POP_OUT_MS = 350;
  const POP_IN_MS  = 250;
  function startPop(b) {
    if (b.popping) return;
    b.popping = true;
    b.popStart = performance.now();
    b.popPhase = "out";
  }

  // ----- 7. Animation loop ----------------------------------------------
  // Calibrated for a calm drift:
  //   - velocity 6–18 px/sec → a bubble takes ~30–80s to cross a screen
  //   - cursor repel radius 150 px, capped at 120 px displacement/frame
  //   - wall bounce with 0.95 energy retention (energy bleeds slowly)
  let lastT = performance.now();
  let rafId = 0;

  function tick(now) {
    rafId = requestAnimationFrame(tick);
    const dt = Math.min(0.05, (now - lastT) / 1000); // clamp to 50ms (e.g. tab return)
    lastT = now;

    const W = window.innerWidth;
    const H = window.innerHeight;
    const REPEL_R   = 150;  // px
    const REPEL_R2  = REPEL_R * REPEL_R;
    const REPEL_MAX = 120;  // max displacement contribution per frame

    for (const b of bubbles) {
      if (b.popping) {
        const elapsed = now - b.popStart;
        if (b.popPhase === "out") {
          const t = Math.min(1, elapsed / POP_OUT_MS);
          // ease-out cubic for the grow
          const e = 1 - Math.pow(1 - t, 3);
          const scale = 1 + 0.6 * e;
          const opacity = 1 - t;
          b.el.style.transform = `translate3d(${b.x - b.size/2}px, ${b.y - b.size/2}px, 0) scale(${scale})`;
          b.el.style.opacity = String(opacity);
          if (t >= 1) {
            b.popPhase = "in";
            b.popStart = now;
            // Place at the new position immediately; the fade-in is
            // just opacity. We keep the pop scale briefly so it
            // doesn't snap from 1.6 to 1.0 visually.
            b.x = rand(b.size / 2, W - b.size / 2);
            b.y = rand(b.size / 2, H - b.size / 2);
            const angle = rand(0, Math.PI * 2);
            const speed = rand(6, 18);
            b.vx = Math.cos(angle) * speed;
            b.vy = Math.sin(angle) * speed;
            b.el.style.transition = `opacity ${POP_IN_MS}ms ease, transform ${POP_IN_MS}ms ease`;
            b.el.style.opacity = "0";
            b.el.style.transform = `translate3d(${b.x - b.size/2}px, ${b.y - b.size/2}px, 0) scale(1.0)`;
            setTimeout(() => {
              b.el.style.transition = "";
              b.popping = false;
              b.popPhase = null;
            }, POP_IN_MS + 30);
          }
        }
        continue; // skip drift while popping
      }

      // Cursor repel — soft inverse-square falloff within REPEL_R.
      if (cursor.active) {
        const dx = b.x - cursor.x;
        const dy = b.y - cursor.y;
        const d2 = dx * dx + dy * dy;
        if (d2 < REPEL_R2 && d2 > 1) {
          const d = Math.sqrt(d2);
          // strength falls off as (1 - d/R)^2 inside the radius
          const t = 1 - d / REPEL_R;
          const force = (t * t) * REPEL_MAX;  // px "kick" this frame
          b.vx += (dx / d) * force * dt * 60; // scale by dt (60 = normalize)
          b.vy += (dy / d) * force * dt * 60;
        }
      }

      // Apply velocity, scaled by dt.
      b.x += b.vx * dt;
      b.y += b.vy * dt;

      // Damping so the repel force doesn't compound forever.
      b.vx *= 0.985;
      b.vy *= 0.985;

      // Wall bounce — reflect, damp slightly, clamp to viewport so
      // a freshly spawned bubble doesn't start half off-screen.
      const r = b.size / 2;
      if (b.x < r)        { b.x = r;        b.vx = Math.abs(b.vx) * 0.95; }
      if (b.x > W - r)    { b.x = W - r;    b.vx = -Math.abs(b.vx) * 0.95; }
      if (b.y < r)        { b.y = r;        b.vy = Math.abs(b.vy) * 0.95; }
      if (b.y > H - r)    { b.y = H - r;    b.vy = -Math.abs(b.vy) * 0.95; }

      // Render
      b.el.style.transform = `translate3d(${b.x - r}px, ${b.y - r}px, 0)`;
    }
  }

  // ----- 8. Visibility + resize handling ---------------------------------
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = 0;
    } else if (!rafId) {
      lastT = performance.now();
      rafId = requestAnimationFrame(tick);
    }
  });

  let resizeTimer = 0;
  window.addEventListener("resize", () => {
    // Debounce — no need to recompute anything per-frame; the loop
    // already reads innerWidth/innerHeight each tick. We just need
    // to make sure the overlay itself doesn't fall out of sync.
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { /* nothing to do; covered */ }, 100);
  });

  // ----- 9. Start --------------------------------------------------------
  if (reduceMotion.matches) {
    // No animation. The bubbles are already placed; just sit still.
    // (They still render, with their fade-in opacity transition.)
    return;
  }
  // Respect the user's preference if they toggle it on mid-session.
  const onMotionChange = () => {
    if (reduceMotion.matches) {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = 0;
    } else if (!rafId && !document.hidden) {
      lastT = performance.now();
      rafId = requestAnimationFrame(tick);
    }
  };
  if (typeof reduceMotion.addEventListener === "function") {
    reduceMotion.addEventListener("change", onMotionChange);
  } else if (typeof reduceMotion.addListener === "function") {
    // Safari < 14
    reduceMotion.addListener(onMotionChange);
  }

  rafId = requestAnimationFrame(tick);
})();
