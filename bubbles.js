/* ----------------------------------------------------------------------
   bubbles.js — shared system for the Recall site.

   Loaded as a deferred script from every page. It:
     1. injects the "bubbley grey" theme overrides (palette, buttons,
        cards, nav, brand mark) into <head> so every page matches
        the index.html landing
     2. injects the bubble CSS
     3. decides which hand-placed bubble arrangement this page gets
        (PLACEMENTS table, picked by pathname)
     4. creates a single <body>-level fixed overlay, spawns the bubbles
     5. click → pop (scale up + fade) → teleport to the next
        position in the bubble's alts list → fade back in

   The script is the single source of truth for both the cross-page
   theme and the bubble behaviour. Touching index.html's style isn't
   needed — the landing already has the same palette inline.
   ---------------------------------------------------------------------- */
(() => {
  "use strict";

  // Bail if the script has already run on this page (defensive — the
  // script is meant to be loaded once, but module loaders / dev
  // re-injection can cause double-runs).
  if (window.__recallBubblesInited) return;
  window.__recallBubblesInited = true;

  // ----- Page detection --------------------------------------------------
  // We need to know which page we're on so we can pick the right
  // arrangement. The pathname is the most reliable signal — every
  // file in the project lives at a known path.
  const path = window.location.pathname;
  const isIndex =
    path === "/" ||
    /\/index\.html$/.test(path) ||
    path.endsWith("/index") ||
    path === "";

  // Per-page override: <body data-bubbles="N">
  const explicitCount = parseInt(document.body.getAttribute("data-bubbles") || "", 10);
  const useExplicit = Number.isFinite(explicitCount) && explicitCount >= 0;

  // ----- 1. Theme override CSS ------------------------------------------
  // These rules are injected into <head> AFTER the page's own <style>
  // block, so they win on cascade order (same specificity, later wins).
  // For rules that need to beat higher-specificity page selectors, we
  // use a `body` ancestor prefix to lift ours above them.
  //
  // Skipped on index.html because index already has the same values
  // inline — re-injecting would just be no-op noise.
  const THEME_CSS = isIndex ? "" : `
    /* ---- :root ---- */
    :root {
      --bg:        #1A1D22;
      --bg-2:      #232629;
      --bg-3:      #2B2F33;
      --bg-4:      #353A3F;
      --line:      #2A2E33;
      --line-2:    #3A3F45;
      --line-3:    #4D535A;
      --text:      #F5F7FA;
      --text-2:    #C9D1D9;
      --text-3:    #9098A4;
      --text-4:    #6B7280;
      --teal:      #56D4DD;
      --teal-2:    #3FB8C4;
      --teal-soft: #7CE0E8;
      --teal-dim:  rgba(86, 212, 221, 0.18);
      --teal-pale: rgba(86, 212, 221, 0.10);
      --teal-glow: rgba(86, 212, 221, 0.30);
      /* --blue is the GitHub-blue alias; remap to teal so the legacy
         var references on auth/dashboard pages pick up the brand colour. */
      --blue:      #56D4DD;
      --blue-2:    #3FB8C4;
      --blue-dim:  rgba(86, 212, 221, 0.18);
      --blue-pale: rgba(86, 212, 221, 0.10);
      --green:     #4FBE6A;
      --yellow:    #D8B14A;
      --purple:    #B388F8;
      --red:       #F26B62;
      --r-xs: 8px;
      --r-sm: 12px;
      --r-md: 18px;
      --r-lg: 24px;
      --r-pill: 999px;
      --maxw: 1240px;
      --shadow-sm: 0 2px 6px rgba(0,0,0,0.18), 0 1px 2px rgba(0,0,0,0.10);
      --shadow-md: 0 8px 24px rgba(0,0,0,0.22), 0 2px 6px rgba(0,0,0,0.12);
      --shadow-glow: 0 0 0 1px var(--teal-dim), 0 8px 24px rgba(0,0,0,0.22);
    }

    /* ---- Body: warm grey + two faint teal radial-gradient glows ---- */
    body {
      background: var(--bg);
      background-image:
        radial-gradient(ellipse 1400px 700px at 0% -10%,
          rgba(86, 212, 221, 0.07), transparent 60%),
        radial-gradient(ellipse 900px 500px at 100% 20%,
          rgba(86, 212, 221, 0.04), transparent 70%);
      background-attachment: fixed;
      color: var(--text);
    }
    ::selection { background: var(--teal); color: #0B0D0F; }

    /* ---- Nav: translucent + blurred ---- */
    body nav.top,
    body .top {
      background: rgba(26, 29, 34, 0.78);
      backdrop-filter: saturate(140%) blur(12px);
      -webkit-backdrop-filter: saturate(140%) blur(12px);
      border-bottom: 1px solid var(--line);
    }
    body nav.top .nav-link,
    body .top .nav-link {
      color: var(--text-2);
    }
    body nav.top .nav-link:hover,
    body .top .nav-link:hover {
      color: var(--text);
      background: var(--bg-3);
    }

    /* ---- Brand mark: round + teal halo ---- */
    body .brand-mark,
    body .logo {
      width: 30px;
      height: 30px;
      object-fit: cover;
      border-radius: 50%;
      box-shadow: 0 0 0 1px rgba(255,255,255,0.04),
                  0 0 16px rgba(86,212,221,0.18);
    }
    /* accept-invite has its .logo at 24px; let it keep that */
    body.accept-invite .logo,
    body .logo.brand-small {
      width: 24px;
      height: 24px;
      border-radius: 5px;     /* keep accept-invite's square logo */
      box-shadow: none;
    }

    /* ---- Links ---- */
    body a { color: var(--teal-soft); }
    body a:hover { text-decoration: underline; }
    body a:focus-visible { outline: 2px solid var(--teal); }

    /* ---- Primary buttons: white + teal halo + pill ---- */
    body .btn-primary,
    body .btn.primary,
    body button.primary,
    body .btn.btn-primary {
      background: #FFFFFF;
      color: #0B0D0F;
      border: 1px solid #FFFFFF;
      border-radius: var(--r-pill);
      padding: 10px 18px;
      font-weight: 600;
      box-shadow: 0 4px 18px rgba(255,255,255,0.10),
                  0 0 32px rgba(86,212,221,0.22);
      transition: background 0.15s ease, box-shadow 0.15s ease,
                  transform 0.15s ease, border-color 0.15s ease;
    }
    body .btn-primary:hover,
    body .btn.primary:hover,
    body button.primary:hover,
    body .btn.btn-primary:hover {
      background: #F0F2F5;
      border-color: #F0F2F5;
      box-shadow: 0 6px 24px rgba(255,255,255,0.16),
                  0 0 40px rgba(86,212,221,0.32);
      text-decoration: none;
      transform: translateY(-1px);
    }
    /* btn-success (lesson) — keep its green intent but bubbley green */
    body .btn-success {
      background: var(--green);
      border: 1px solid var(--green);
      color: #0B0D0F;
      border-radius: var(--r-pill);
    }
    body .btn-success:hover {
      background: #6BD183;
      border-color: #6BD183;
    }
    /* Secondary / ghost buttons — pill, line-2 border */
    body .btn-ghost,
    body .btn.secondary,
    body .btn-secondary,
    body .btn.ghost,
    body .oauth-btn,
    body .role-card,
    body .btn-link {
      background: rgba(255,255,255,0.02);
      color: var(--text);
      border: 1px solid var(--line-2);
      border-radius: var(--r-pill);
      padding: 9px 16px;
      font-weight: 500;
    }
    body .btn-ghost:hover,
    body .btn.secondary:hover,
    body .btn-secondary:hover,
    body .btn.ghost:hover,
    body .btn-link:hover {
      background: var(--bg-2);
      border-color: var(--line-3);
      text-decoration: none;
    }
    body .oauth-btn { background: var(--bg-3); }

    /* Danger button stays the rgba-red recipe but on the bubbley palette */
    body .btn-danger {
      background: rgba(242, 107, 98, 0.12);
      color: #FFB3AC;
      border: 1px solid rgba(242, 107, 98, 0.40);
      border-radius: var(--r-pill);
    }
    body .btn-danger:hover {
      background: rgba(242, 107, 98, 0.20);
      border-color: rgba(242, 107, 98, 0.60);
    }

    /* ---- Cards / form surfaces: gradient + bigger radius ---- */
    body .form-card,
    body .card,
    body .gate,
    body .quote-card,
    body .role-modal,
    body .modal,
    body .role-card,
    body .kpi,
    body .stat,
    body .table-wrap,
    body .removed-card,
    body .consent-card,
    body .template,
    body .summary-card,
    body .toast,
    body .toast-wrap .toast {
      background: linear-gradient(180deg, var(--bg-2) 0%, var(--bg) 100%);
      border: 1px solid var(--line-2);
      border-radius: var(--r-lg);
    }
    /* form-card on login/signup — keep closer to r-md so it doesn't look
       balloon-y in the centered-card layout */
    body .form-card { border-radius: var(--r-lg); }
    body .gate { border-radius: var(--r-lg); }

    /* ---- Card heads (the inner header strip on cards) ---- */
    body .card-head,
    body thead th {
      background: transparent;
      border-bottom: 1px solid var(--line);
      color: var(--text-3);
    }

    /* ---- Inputs, selects, textareas: lift off the card ---- */
    body input[type="text"],
    body input[type="email"],
    body input[type="password"],
    body input[type="search"],
    body input[type="tel"],
    body input[type="url"],
    body input[type="number"],
    body textarea,
    body select,
    body .field input,
    body .field textarea,
    body .form-row input,
    body .form-row select,
    body .form-row textarea {
      background: var(--bg-3);
      color: var(--text);
      border: 1px solid var(--line-2);
      border-radius: var(--r-sm);
    }
    body input:focus,
    body textarea:focus,
    body select:focus,
    body .field input:focus,
    body .form-row input:focus,
    body .form-row select:focus,
    body .form-row textarea:focus {
      border-color: var(--teal);
      box-shadow: 0 0 0 3px var(--teal-pale);
      outline: none;
    }
    body input::placeholder,
    body textarea::placeholder {
      color: var(--text-3);
    }

    /* ---- Status pills: keep the intent, refresh the palette ---- */
    body .ok,
    body .ok-banner,
    body .state.ok,
    body .toast.success,
    body .reset-msg.ok,
    body .check {
      background: rgba(79, 190, 106, 0.12);
      border: 1px solid rgba(79, 190, 106, 0.40);
      color: #A6F0B0;
    }
    body .err,
    body .error,
    body .error-banner,
    body .state.error,
    body .toast.error,
    body .reset-msg.error {
      background: rgba(242, 107, 98, 0.10);
      border: 1px solid rgba(242, 107, 98, 0.40);
      color: #FFB3AC;
    }
    body .state.info,
    body .invite-banner {
      background: var(--teal-pale);
      border: 1px solid var(--teal-dim);
      color: var(--teal);
    }
    body .state.warn,
    body .warn,
    body .pending-review {
      background: rgba(216, 177, 74, 0.12);
      border: 1px solid rgba(216, 177, 74, 0.40);
      color: #F0D78F;
    }
    /* Role pills on signup-staff and admin */
    body .role-pill,
    body .rank-pill,
    body .status-pill,
    body .invite-pill {
      border-radius: var(--r-pill);
      padding: 3px 10px;
      font-weight: 600;
    }
    body .role-pill.staff_author,
    body .rank-pill.staff_author,
    body .role-pill.author,
    body .status-pill.lesson_published,
    body .status-pill.published,
    body .invite-pill.author {
      background: rgba(79, 190, 106, 0.14);
      color: #A6F0B0;
    }
    body .role-pill.staff_reviewer,
    body .rank-pill.staff_reviewer,
    body .role-pill.reviewer,
    body .status-pill.role_changed,
    body .status-pill.draft,
    body .invite-pill.reviewer {
      background: rgba(216, 177, 74, 0.14);
      color: #F0D78F;
    }
    body .role-pill.admin,
    body .admin-pill,
    body .invite-pill.admin {
      background: rgba(242, 107, 98, 0.14);
      color: #FFB3AC;
    }
    body .status-pill.pending {
      background: rgba(216, 177, 74, 0.14);
      color: #F0D78F;
    }
    body .status-pill { background: var(--bg-3); color: var(--text-3); }

    /* ---- Sidebar / side rail on dashboard family ---- */
    body .sidebar { background: transparent; }
    body .user-block,
    body .side-nav,
    body .streak-card,
    body .rail .profile-card,
    body .side nav a,
    body .rail nav a {
      background: linear-gradient(180deg, var(--bg-2) 0%, var(--bg) 100%);
      border: 1px solid var(--line);
      border-radius: var(--r-md);
    }
    body .user-block .avatar {
      background: var(--teal);
      color: #0B0D0F;
    }
    body .side-nav a,
    body .rail nav a {
      color: var(--text-2);
      border-radius: var(--r-sm);
    }
    body .side-nav a:hover,
    body .rail nav a:hover {
      background: var(--bg-3);
      color: var(--text);
      text-decoration: none;
    }
    body .side-nav a.active,
    body .rail nav a.active,
    body .side-nav a.primary,
    body .rail nav a.primary,
    body .side button.active,
    body .rail button.active {
      background: var(--teal-pale);
      color: var(--teal);
    }
    body .side button.active .count,
    body .rail button.active .count {
      background: var(--teal);
      color: #0B0D0F;
    }
    body .side h3,
    body .rail h3,
    body .side-nav .section-label {
      color: var(--text-4);
      text-transform: uppercase;
      font-size: 11px;
      letter-spacing: 0.06em;
    }

    /* ---- Dash-bar / progress / KPI strip ---- */
    body .dash-bar {
      background: linear-gradient(180deg, var(--bg-2) 0%, var(--bg) 100%);
      border: 1px solid var(--line);
      border-radius: var(--r-md);
    }
    body .dash-bar .crumbs a { color: var(--text-3); }
    body .dash-bar .crumbs a:hover { color: var(--text-2); }
    body .dash-bar .right .pill {
      background: var(--bg-3);
      color: var(--text-2);
      border-radius: var(--r-pill);
    }
    body .dash-bar .right .streak { color: var(--yellow); font-weight: 600; }
    body .kpi .delta.up { color: var(--green); }
    body .kpi .delta.down { color: var(--red); }
    body .progress-bar { background: var(--bg-3); border-radius: var(--r-pill); }
    body .progress-bar .fill {
      background: linear-gradient(90deg, var(--teal-2), var(--teal));
      border-radius: var(--r-pill);
    }

    /* ---- Subject dots (dashboard) — bubbley palette ---- */
    body .dot.maths,  body .maths  { background: #56D4DD; }
    body .dot.eng,    body .eng    { background: #B388F8; }
    body .dot.bio,    body .bio    { background: #4FBE6A; }
    body .dot.chem,   body .chem   { background: #D8B14A; }
    body .dot.phys,   body .phys   { background: #F26B62; }
    body .dot.hist,   body .hist   { background: #FF8B82; }
    body .dot.geog,   body .geog   { background: #7CE0E8; }
    body .dot.psych,  body .psych  { background: #C9A6FF; }

    /* ---- Active row, lesson, focus accents ---- */
    body .subj-row.continue,
    body .ch.current,
    body .practice .opt.selected,
    body .summary-card,
    body .step .step-num,
    body .eyebrow,
    body .catalog-card:hover,
    body .tree-lesson.active,
    body .catalog-topics .topic-row.active {
      background: var(--teal-pale);
      color: var(--teal);
      border-color: var(--teal-dim);
    }
    body .practice .opt.correct,
    body .practice .feedback.ok {
      background: rgba(79, 190, 106, 0.12);
      border-color: var(--green);
      color: var(--text);
    }
    body .practice .opt.wrong,
    body .practice .feedback.bad {
      background: rgba(242, 107, 98, 0.12);
      border-color: var(--red);
      color: var(--text);
    }
    body .callout.tip { background: rgba(79, 190, 106, 0.10); border-left: 3px solid var(--green); }
    body .callout.warning { background: rgba(216, 177, 74, 0.10); border-left: 3px solid var(--yellow); }
    body .callout.definition { background: var(--teal-pale); border-left: 3px solid var(--teal); }
    body .worked .q { background: var(--teal-pale); border-left: 3px solid var(--teal); }
    body .worked .ans { background: rgba(79, 190, 106, 0.10); border-left: 3px solid var(--green); }
    body .flashcard-back { background: var(--teal-pale); border-color: var(--teal-dim); }
    body .check-row .check-btn { background: var(--teal); color: #0B0D0F; border-radius: var(--r-pill); }

    /* ---- Modals ---- */
    body .modal-backdrop {
      background: rgba(0, 0, 0, 0.6);
      backdrop-filter: blur(4px);
      -webkit-backdrop-filter: blur(4px);
    }

    /* ---- Accept-invite uses a different var naming scheme ---- */
    body.accept-invite {
      --bg:        #1A1D22;
      --panel:     #232629;
      --border:    #3A3F45;
      --text:      #F5F7FA;
      --muted:     #9098A4;
      --accent:    #56D4DD;
      --accent-hover: #7CE0E8;
      --ok:        #4FBE6A;
      --danger:    #F26B62;
    }
    body.accept-invite .top {
      background: rgba(26, 29, 34, 0.78);
      backdrop-filter: saturate(140%) blur(12px);
      -webkit-backdrop-filter: saturate(140%) blur(12px);
      border-bottom: 1px solid var(--border);
    }
    body.accept-invite .card {
      background: linear-gradient(180deg, var(--panel) 0%, var(--bg) 100%);
      border: 1px solid var(--border);
      border-radius: var(--r-lg);
    }
    body.accept-invite .btn {
      background: var(--panel);
      color: var(--text);
      border: 1px solid var(--border);
      border-radius: var(--r-pill);
    }
    body.accept-invite .btn:hover { background: var(--bg-3); }
    body.accept-invite .btn.primary {
      background: #FFFFFF;
      color: #0B0D0F;
      border: 1px solid #FFFFFF;
    }
    body.accept-invite .btn.primary:hover { background: #F0F2F5; border-color: #F0F2F5; }

    /* ---- Reduce-motion: no pop animation ---- */
    @media (prefers-reduced-motion: reduce) {
      .bubble { transition: none !important; }
    }
  `;

  // ----- 2. Bubble CSS ---------------------------------------------------
  // The visual is the same as the previous build: four variants
  // (glass / cyan / white / iridescent). The overlay z-index is now 5
  // so bubbles sit above content but below sticky nav (z-index 50) and
  // modals (z-index 100). Each bubble is the only thing in the overlay
  // with pointer-events:auto, so it catches its own clicks without
  // blocking form inputs elsewhere.
  const BUBBLE_CSS = `
    .bubble-field {
      position: fixed;
      inset: 0;
      z-index: 5;
      overflow: hidden;
      pointer-events: none;
    }
    .bubble {
      position: absolute;
      top: 0; left: 0;
      width:  var(--bubble-size, 80px);
      height: var(--bubble-size, 80px);
      border-radius: 50%;
      pointer-events: auto;
      cursor: pointer;
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
      transition: transform 0.35s cubic-bezier(0.4, 0, 0.2, 1),
                  opacity 0.35s ease;
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
    .bubble--sm { --bubble-size: 32px; }
    .bubble--md { --bubble-size: 80px; }
    .bubble--lg { --bubble-size: 160px; }
    .bubble--xl { --bubble-size: 280px; }
  `;

  // ----- 3. Inject styles ------------------------------------------------
  // Order: theme first (so it can override), bubble CSS after, but
  // both go after the page's own <style> blocks so they win on cascade.
  const themeEl = document.createElement("style");
  themeEl.setAttribute("data-recall-theme", "");
  themeEl.textContent = THEME_CSS;
  document.head.appendChild(themeEl);

  const bubbleEl = document.createElement("style");
  bubbleEl.setAttribute("data-recall-bubbles", "");
  bubbleEl.textContent = BUBBLE_CSS;
  document.head.appendChild(bubbleEl);

  // ----- 4. Hand-placed per-page arrangements ----------------------------
  // Each placement is an object:
  //   { x, y, size, variant, alts: [{x,y}, ...] }
  // x/y are pixel positions from the top-left of the viewport. The
  // bubble's centre sits at (x, y). size is 32|80|160|280 (px). variant
  // is the visual style. alts is the list of positions the bubble
  // cycles through when popped — first entry is the initial position.
  // Once the alts are exhausted, the bubble picks a random one.

  // Helper to build a placement.
  const P = (x, y, size, variant, alts) => ({ x, y, size, variant, alts });

  // ---- Landing (24 bubbles, distributed across the page) ----
  // The page is roughly 4000-5000 px tall. We pick positions in the
  // outer margins (left < 18% or right > 82%) and corners so they don't
  // sit on top of the main copy columns.
  const LANDING = [
    // HERO (top of page)
    P("6%",  "6%",  280, "iridescent", [
      { x: "6%",  y: "6%"  }, { x: "12%", y: "10%" },
      { x: "4%",  y: "14%" }, { x: "8%",  y: "4%"  },
    ]),
    P("88%", "8%",  160, "cyan", [
      { x: "88%", y: "8%"  }, { x: "82%", y: "14%" },
      { x: "92%", y: "12%" },
    ]),
    P("14%", "16%", 80, "white", [
      { x: "14%", y: "16%" }, { x: "18%", y: "20%" },
    ]),
    P("82%", "22%", 32, "glass", [
      { x: "82%", y: "22%" }, { x: "86%", y: "26%" },
    ]),

    // SUBJECTS section
    P("4%",  "32%", 110, "white", [
      { x: "4%",  y: "32%" }, { x: "8%",  y: "36%" },
    ]),
    P("92%", "34%", 70, "cyan", [
      { x: "92%", y: "34%" }, { x: "88%", y: "38%" },
    ]),
    P("14%", "42%", 30, "glass", [
      { x: "14%", y: "42%" }, { x: "18%", y: "44%" },
    ]),

    // HOW IT WORKS
    P("86%", "50%", 80, "glass", [
      { x: "86%", y: "50%" }, { x: "82%", y: "54%" },
    ]),
    P("6%",  "54%", 32, "white", [
      { x: "6%",  y: "54%" }, { x: "10%", y: "56%" },
    ]),
    P("92%", "60%", 50, "cyan", [
      { x: "92%", y: "60%" }, { x: "88%", y: "64%" },
    ]),

    // FEATURED lesson
    P("12%", "68%", 100, "cyan", [
      { x: "12%", y: "68%" }, { x: "16%", y: "72%" },
    ]),
    P("84%", "70%", 60, "glass", [
      { x: "84%", y: "70%" }, { x: "88%", y: "74%" },
    ]),

    // EVIDENCE
    P("8%",  "80%", 80, "white", [
      { x: "8%",  y: "80%" }, { x: "12%", y: "84%" },
    ]),
    P("90%", "82%", 130, "iridescent", [
      { x: "90%", y: "82%" }, { x: "86%", y: "86%" },
      { x: "92%", y: "78%" },
    ]),
    P("20%", "88%", 40, "cyan", [
      { x: "20%", y: "88%" }, { x: "24%", y: "90%" },
    ]),

    // PRICING
    P("6%",  "94%", 160, "cyan", [
      { x: "6%",  y: "94%" }, { x: "10%", y: "98%" },
    ]),
    P("92%", "96%", 50, "white", [
      { x: "92%", y: "96%" }, { x: "88%", y: "100%" },
    ]),
    P("16%", "102%", 30, "glass", [
      { x: "16%", y: "102%" }, { x: "20%", y: "104%" },
    ]),

    // FAQ
    P("84%", "108%", 80, "white", [
      { x: "84%", y: "108%" }, { x: "88%", y: "112%" },
    ]),
    P("8%",  "114%", 40, "cyan", [
      { x: "8%",  y: "114%" }, { x: "12%", y: "116%" },
    ]),
    P("90%", "118%", 30, "glass", [
      { x: "90%", y: "118%" }, { x: "86%", y: "120%" },
    ]),

    // CTA STRIP (bottom)
    P("14%", "126%", 120, "iridescent", [
      { x: "14%", y: "126%" }, { x: "18%", y: "130%" },
      { x: "10%", y: "128%" },
    ]),
    P("82%", "128%", 70, "white", [
      { x: "82%", y: "128%" }, { x: "86%", y: "132%" },
    ]),
    P("50%", "130%", 50, "cyan", [
      { x: "50%", y: "130%" }, { x: "46%", y: "132%" },
    ]),
  ];

  // ---- Auth pages (8 bubbles) ----
  // Card sits centered, max-width ~520px. Bubbles live in the four
  // corners and four edges of the visible margin.
  const AUTH = [
    P("4%",  "10%", 140, "iridescent", [
      { x: "4%",  y: "10%" }, { x: "8%",  y: "14%" },
      { x: "6%",  y: "6%"  },
    ]),
    P("92%", "12%", 80, "cyan", [
      { x: "92%", y: "12%" }, { x: "88%", y: "16%" },
    ]),
    P("3%",  "55%", 60, "white", [
      { x: "3%",  y: "55%" }, { x: "7%",  y: "58%" },
    ]),
    P("94%", "60%", 100, "white", [
      { x: "94%", y: "60%" }, { x: "90%", y: "64%" },
    ]),
    P("6%",  "85%", 50, "glass", [
      { x: "6%",  y: "85%" }, { x: "10%", y: "88%" },
    ]),
    P("92%", "88%", 70, "cyan", [
      { x: "92%", y: "88%" }, { x: "88%", y: "92%" },
    ]),
    P("22%", "94%", 30, "glass", [
      { x: "22%", y: "94%" }, { x: "26%", y: "96%" },
    ]),
    P("78%", "20%", 40, "white", [
      { x: "78%", y: "20%" }, { x: "74%", y: "24%" },
    ]),
  ];

  // ---- App pages (6 bubbles, sparser) ----
  // Sidebar on the left, dash-bar at the top, main content in the
  // middle. Bubbles live in the right margin and corners, plus a
  // couple hidden behind the sidebar area.
  const APP = [
    P("3%",  "12%", 80, "cyan", [
      { x: "3%",  y: "12%" }, { x: "6%",  y: "16%" },
    ]),
    P("94%", "10%", 100, "iridescent", [
      { x: "94%", y: "10%" }, { x: "90%", y: "14%" },
      { x: "96%", y: "6%"  },
    ]),
    P("96%", "40%", 50, "white", [
      { x: "96%", y: "40%" }, { x: "92%", y: "44%" },
    ]),
    P("4%",  "70%", 60, "glass", [
      { x: "4%",  y: "70%" }, { x: "8%",  y: "74%" },
    ]),
    P("94%", "80%", 30, "cyan", [
      { x: "94%", y: "80%" }, { x: "90%", y: "84%" },
    ]),
    P("50%", "92%", 70, "white", [
      { x: "50%", y: "92%" }, { x: "54%", y: "96%" },
    ]),
  ];

  // ---- Email templates (sparse, 4) ----
  const EMAIL = [
    P("4%",  "10%", 100, "iridescent", [
      { x: "4%",  y: "10%" }, { x: "8%",  y: "14%" },
    ]),
    P("94%", "20%", 60, "cyan", [
      { x: "94%", y: "20%" }, { x: "90%", y: "24%" },
    ]),
    P("6%",  "70%", 50, "white", [
      { x: "6%",  y: "70%" }, { x: "10%", y: "74%" },
    ]),
    P("92%", "85%", 40, "glass", [
      { x: "92%", y: "85%" }, { x: "88%", y: "88%" },
    ]),
  ];

  // ---- Pick the arrangement for this page ----
  const FORM_PAGES = new Set([
    "/login.html", "/signup.html", "/signup-teacher.html",
    "/signup-staff.html", "/signup-school-admin.html", "/consent.html",
    "/reset-password.html", "/accept-invite.html",
    "/auth/confirmed.html", "/auth/consent-confirmed.html",
  ]);
  const APP_PAGES = new Set([
    "/dashboard.html", "/lesson.html", "/lesson-creator.html",
    "/staff-dashboard.html", "/admin.html",
  ]);

  let arrangements;
  let count;
  if (useExplicit) {
    arrangements = null;          // not used when explicit count given
    count = explicitCount;
  } else if (isIndex) {
    arrangements = LANDING;
    count = LANDING.length;
  } else if (FORM_PAGES.has(path)) {
    arrangements = AUTH;
    count = AUTH.length;
  } else if (APP_PAGES.has(path)) {
    arrangements = APP;
    count = APP.length;
  } else if (path === "/email-templates.html") {
    arrangements = EMAIL;
    count = EMAIL.length;
  } else {
    arrangements = APP;
    count = APP.length;
  }

  if (count <= 0) return;

  // ----- 5. Build the overlay + bubbles ----------------------------------
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const overlay = document.createElement("div");
  overlay.className = "bubble-field";
  overlay.setAttribute("aria-hidden", "true");
  document.body.appendChild(overlay);

  // Helper: turn a percentage or numeric string into a pixel value
  // relative to the viewport. Used for the initial position and for
  // recomputing on resize.
  const parseCoord = (v, dim) => {
    if (typeof v === "number") return v;
    if (typeof v === "string" && v.endsWith("%")) {
      return (parseFloat(v) / 100) * dim;
    }
    if (typeof v === "string" && v.endsWith("px")) {
      return parseFloat(v);
    }
    return parseFloat(v) || 0;
  };
  const parseAlts = (alts, dim) => alts.map((p) => ({
    x: parseCoord(p.x, dim[0]),
    y: parseCoord(p.y, dim[1]),
  }));

  // Variant → CSS class. iridescent/cyan/white are explicit; anything
  // else is "glass" (the default).
  const VARIANT_CLASS = {
    glass:      "",
    cyan:       "bubble--cyan",
    white:      "bubble--white",
    iridescent: "bubble--iridescent",
  };
  const SIZE_CLASS = {
    32:  "bubble--sm",
    80:  "bubble--md",
    160: "bubble--lg",
    280: "bubble--xl",
  };

  const bubbles = [];

  function spawn() {
    overlay.innerHTML = "";
    bubbles.length = 0;

    const placements = useExplicit ? null : arrangements;
    if (useExplicit) {
      // Random arrangement when an explicit count was given. Match the
      // size/variant distribution the landing uses (1 large, ~3 medium,
      // many small) but with random positions in the outer margins.
      const SIZES_RAND = [
        { p: 0.50, size: 32 },
        { p: 0.80, size: 80 },
        { p: 0.95, size: 160 },
        { p: 1.00, size: 280 },
      ];
      const VARIANTS_RAND = ["glass", "glass", "glass", "glass", "cyan", "cyan", "white", "iridescent"];
      const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
      const W = window.innerWidth;
      const H = window.innerHeight;
      for (let i = 0; i < count; i++) {
        const r = Math.random();
        let size = 32;
        let acc = 0;
        for (const s of SIZES_RAND) { acc += s.p; if (r < acc) { size = s.size; break; } }
        const variant = pick(VARIANTS_RAND);
        // Stay in the outer 20% margins so we don't sit on the main content
        const side = Math.random() < 0.5 ? "left" : "right";
        const x = side === "left"
          ? Math.random() * (W * 0.2)
          : W * 0.8 + Math.random() * (W * 0.2);
        const y = Math.random() * H;
        const alts = [
          { x, y },
          { x: x + (Math.random() - 0.5) * 80, y: y + (Math.random() - 0.5) * 80 },
        ];
        createBubble(x, y, size, variant, alts);
      }
      return;
    }

    // Hand-placed arrangement.
    for (const p of placements) {
      const alts = parseAlts(p.alts, [window.innerWidth, window.innerHeight]);
      const x = alts[0].x;
      const y = alts[0].y;
      createBubble(x, y, p.size, p.variant, alts);
    }
  }

  function createBubble(x, y, size, variant, alts) {
    const el = document.createElement("div");
    const variantClass = VARIANT_CLASS[variant] || "";
    const sizeClass = SIZE_CLASS[size] || "bubble--md";
    el.className = "bubble " + sizeClass + (variantClass ? " " + variantClass : "");
    el.style.opacity = "0";
    el.style.transform = `translate3d(${x - size/2}px, ${y - size/2}px, 0)`;
    overlay.appendChild(el);

    bubbles.push({
      el,
      size,
      alts,
      altIndex: 0,           // current position is alts[altIndex]
      current: { x, y },     // mirror for fast reads
      popping: false,
    });

    // Fade in
    el.style.transition = "opacity 0.4s ease";
    requestAnimationFrame(() => {
      el.style.opacity = "1";
      setTimeout(() => { el.style.transition = ""; }, 500);
    });
  }

  spawn();

  // ----- 6. Click → pop → regrow at next position ------------------------
  // Bubbles are the only pointer-events:auto elements in the overlay,
  // so a click on the overlay that isn't on empty space must be on a
  // bubble. (Empty space passes through to the page below.)
  const POP_OUT_MS = 350;
  const POP_IN_MS  = 300;

  overlay.addEventListener("click", (e) => {
    const b = bubbles.find((bb) => bb.el === e.target);
    if (!b || b.popping) return;
    popBubble(b);
  });

  function popBubble(b) {
    b.popping = true;
    if (reduceMotion.matches) {
      // Instant teleport.
      advanceToNextAlt(b);
      b.popping = false;
      return;
    }

    // 1. Pop: scale up + fade out at the current position.
    b.el.style.transition = `transform ${POP_OUT_MS}ms cubic-bezier(0.4, 0, 0.2, 1),
                             opacity   ${POP_OUT_MS}ms ease`;
    b.el.style.transform = `translate3d(${b.current.x - b.size/2}px, ${b.current.y - b.size/2}px, 0) scale(1.6)`;
    b.el.style.opacity = "0";

    // 2. When pop is done, teleport to the next position and fade in.
    setTimeout(() => {
      advanceToNextAlt(b);
      b.el.style.transition = `transform ${POP_IN_MS}ms cubic-bezier(0.4, 0, 0.2, 1),
                               opacity   ${POP_IN_MS}ms ease`;
      b.el.style.transform = `translate3d(${b.current.x - b.size/2}px, ${b.current.y - b.size/2}px, 0) scale(1)`;
      b.el.style.opacity = "1";
      setTimeout(() => {
        b.el.style.transition = "";
        b.popping = false;
      }, POP_IN_MS + 50);
    }, POP_OUT_MS);
  }

  function advanceToNextAlt(b) {
    b.altIndex = (b.altIndex + 1) % b.alts.length;
    const next = b.alts[b.altIndex];
    // If we've cycled all alts, occasionally pick a fresh random position
    // so the page doesn't feel static after lots of clicks.
    if (b.altIndex === 0 && Math.random() < 0.5) {
      const W = window.innerWidth;
      const H = window.innerHeight;
      b.current = {
        x: Math.max(b.size/2, Math.min(W - b.size/2, Math.random() * W)),
        y: Math.max(b.size/2, Math.min(H - b.size/2, Math.random() * H)),
      };
    } else {
      b.current = { x: next.x, y: next.y };
    }
  }

  // ----- 7. Resize: reposition bubbles to track the same percentages ----
  // The alts are stored as absolute pixel positions once at spawn time.
  // On resize (e.g. rotating a phone) we recompute them.
  let resizeTimer = 0;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      // Re-parse the placements' alts using the new viewport size.
      // This is the simplest correct behaviour — the bubble's *current*
      // position is whatever it last was; the alts list is refreshed.
      if (useExplicit) return;   // random arrangement, no placements to re-parse
      for (let i = 0; i < bubbles.length; i++) {
        const b = bubbles[i];
        const p = arrangements[i];
        if (!p) continue;
        const alts = parseAlts(p.alts, [window.innerWidth, window.innerHeight]);
        b.alts = alts;
        // Keep the bubble where it currently is — the resize just
        // refreshes the future-position list. (Snapping would be jarring.)
      }
    }, 200);
  });
})();
