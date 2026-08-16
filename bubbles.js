/* ----------------------------------------------------------------------
   bubbles.js — shared system for the Recall site.

   Loaded as a deferred script from every page. It:
     1. injects the "bubbley grey" theme overrides (palette, buttons,
        cards, nav, brand mark) into <head> so every page matches
        the index.html landing
     2. injects the bubble CSS
     3. decides which hand-placed bubble arrangement this page gets
        (PLACEMENTS table, picked by pathname)
     4. creates a single <body>-level fixed overlay and spawns the
        bubbles at their deliberate positions
     5. on scroll, drifts each bubble downward at a per-bubble
        parallax speed and wraps it back to the top when it leaves
        the viewport
     6. on click, pops the bubble (scale up + fade), then teleports
        it to the next "alt" position and fades it back in

   The bubbles are decorative but interactive:
     - all of them use the iridescent (rainbow) variant
     - they sit at z-index 0; body children are lifted above them via
       a :where() rule with zero specificity, so any pre-existing
       z-index still wins
     - where a card covers a bubble, the card catches the click
       (because pointer-events: auto on the bubble + the card's own
       stacking context = UI wins). Bubbles are clickable in margins.
     - scroll-driven drift, not per-frame motion — zero idle CPU.

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

    /* ---- Buttons: always white at rest, lift on hover ----
       Every button variant on the site — primary, secondary, ghost,
       oauth, success, danger, raw <button> elements — uses a white
       base background. Hover/active shift to a soft off-white with a
       brighter teal halo and a 1px lift so the click feels tactile.
       Success keeps a green border and danger keeps a red border so
       their intent is still readable at a glance. */
    body .btn-primary,
    body .btn.primary,
    body button.primary,
    body .btn.btn-primary,
    body .btn-ghost,
    body .btn.secondary,
    body .btn-secondary,
    body .btn.ghost,
    body .btn-link,
    body .btn,
    body .oauth-btn,
    body button:not(.bubble):not(.nav-link):not(.role-pill):not(.check-btn):not(.check):not(.close):not(.icon-btn):not(.oauth-google):not(.oauth-microsoft) {
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
    body .btn.btn-primary:hover,
    body .btn-ghost:hover,
    body .btn.secondary:hover,
    body .btn-secondary:hover,
    body .btn.ghost:hover,
    body .btn-link:hover,
    body .btn:hover,
    body .oauth-btn:hover,
    body button:not(.bubble):not(.nav-link):not(.role-pill):not(.check-btn):not(.check):not(.close):not(.icon-btn):hover {
      background: #F0F2F5;
      border-color: #F0F2F5;
      box-shadow: 0 6px 24px rgba(255,255,255,0.16),
                  0 0 40px rgba(86,212,221,0.32);
      text-decoration: none;
      transform: translateY(-1px);
    }
    body .btn-primary:active,
    body .btn.primary:active,
    body button.primary:active,
    body .btn.btn-primary:active,
    body .btn-ghost:active,
    body .btn.secondary:active,
    body .btn-secondary:active,
    body .btn.ghost:active,
    body .btn-link:active,
    body .btn:active,
    body .oauth-btn:active,
    body button:not(.bubble):not(.nav-link):not(.role-pill):not(.check-btn):not(.check):not(.close):not(.icon-btn):not(.oauth-google):not(.oauth-microsoft):active {
      background: #E5E8EC;
      border-color: #E5E8EC;
      box-shadow: 0 2px 8px rgba(255,255,255,0.08),
                  0 0 24px rgba(86,212,221,0.20);
      transform: translateY(0);
    }
    /* Success — white fill, green border so the action reads as a
       positive outcome without colouring the whole button. */
    body .btn-success {
      background: #FFFFFF;
      color: #0B0D0F;
      border: 1px solid #4FBE6A;
      border-radius: var(--r-pill);
      padding: 10px 18px;
      font-weight: 600;
      box-shadow: 0 4px 18px rgba(255,255,255,0.10),
                  0 0 24px rgba(79,190,106,0.22);
      transition: background 0.15s ease, box-shadow 0.15s ease,
                  transform 0.15s ease, border-color 0.15s ease;
    }
    body .btn-success:hover {
      background: #F0F2F5;
      border-color: #6BD183;
      box-shadow: 0 6px 24px rgba(255,255,255,0.16),
                  0 0 32px rgba(79,190,106,0.32);
      transform: translateY(-1px);
    }
    body .btn-success:active {
      background: #E5E8EC;
      border-color: #5BCB76;
      transform: translateY(0);
    }
    /* Danger — white fill, red border so destructive actions read
       as destructive without darkening the whole button. */
    body .btn-danger {
      background: #FFFFFF;
      color: #C24A42;
      border: 1px solid rgba(242, 107, 98, 0.60);
      border-radius: var(--r-pill);
      padding: 10px 18px;
      font-weight: 600;
      box-shadow: 0 4px 18px rgba(255,255,255,0.10),
                  0 0 24px rgba(242,107,98,0.22);
      transition: background 0.15s ease, box-shadow 0.15s ease,
                  transform 0.15s ease, border-color 0.15s ease;
    }
    body .btn-danger:hover {
      background: #FFF5F4;
      border-color: rgba(242, 107, 98, 0.85);
      color: #A03A33;
      box-shadow: 0 6px 24px rgba(255,255,255,0.16),
                  0 0 32px rgba(242,107,98,0.32);
      transform: translateY(-1px);
    }
    body .btn-danger:active {
      background: #FFE6E3;
      border-color: rgba(242, 107, 98, 1);
      transform: translateY(0);
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
    body.accept-invite .btn:hover {
      background: #F0F2F5;
      border-color: #F0F2F5;
      transform: translateY(-1px);
    }
    body.accept-invite .btn:active {
      background: #E5E8EC;
      border-color: #E5E8EC;
      transform: translateY(0);
    }
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
  // The visual is the same as the previous build: the iridescent
  // (rainbow) variant for every bubble. The overlay z-index is 0 so
  // bubbles sit BEHIND all page content — every page's UI paints
  // over them. The host page's content is lifted above via a :where()
  // rule at the bottom of this block. Bubbles are clickable (they
  // catch clicks in the margins), but where a card sits on top of a
  // bubble the card wins the click because the card's own stacking
  // context (from the :where() lift) is above the bubble field.
  const BUBBLE_CSS = `
    .bubble-field {
      position: fixed;
      inset: 0;
      z-index: 0;
      overflow: hidden;
      pointer-events: none;
    }
    .bubble {
      position: absolute;
      top: 0; left: 0;
      width:  var(--bubble-size, 80px);
      height: var(--bubble-size, 80px);
      border-radius: 50%;
      /* pointer-events: auto so the bubble catches clicks; the field
         below stays pointer-events: none so empty space passes through.
         Where a card covers a bubble, the card's own stacking context
         (from the :where() lift) wins, so the click still hits the UI. */
      pointer-events: auto;
      cursor: pointer;
      will-change: transform, opacity;
      transform: translate3d(0, 0, 0);
      /* No base transition — the scroll handler needs transforms
         to be instant (otherwise the bubble would lag 350ms behind
         every scroll). The pop function sets its own transition
         inline for the duration of the pop animation. */
      background:
        radial-gradient(circle at 30% 28%,
          rgba(255,255,255,0.22) 0%,
          rgba(255,255,255,0.08) 18%,
          rgba(255,255,255,0.02) 40%,
          transparent 70%);
      box-shadow:
        inset 6px 10px 24px rgba(255,255,255,0.10),
        inset -8px -10px 30px rgba(232,181,98,0.06),
        0 0 32px rgba(232,181,98,0.10),
        0 8px 28px rgba(0,0,0,0.20);
      border: 1px solid rgba(255,255,255,0.06);
    }
    .bubble--iridescent {
      background:
        radial-gradient(circle at 50% 50%, transparent 38%, transparent 100%),
        conic-gradient(from 200deg,
          rgba(232,181,98,0.0)   0deg,
          rgba(212,154,69,0.55)  40deg,
          rgba(240,201,122,0.60) 80deg,
          rgba(255,255,255,0.40) 130deg,
          rgba(216,177,74,0.50)  180deg,
          rgba(242,107,98,0.50)  230deg,
          rgba(232,181,98,0.50)  280deg,
          rgba(212,154,69,0.50)  340deg,
          rgba(232,181,98,0.0)   360deg);
      -webkit-mask: radial-gradient(circle, transparent 0%, transparent 50%, #000 70%, #000 100%);
              mask: radial-gradient(circle, transparent 0%, transparent 50%, #000 70%, #000 100%);
      box-shadow:
        inset 6px 10px 24px rgba(255,255,255,0.12),
        0 0 50px rgba(232,181,98,0.20),
        0 8px 28px rgba(0,0,0,0.20);
      border: 1px solid rgba(255,255,255,0.06);
    }
    .bubble--xs { --bubble-size: 16px; }
    .bubble--sm { --bubble-size: 32px; }
    .bubble--md { --bubble-size: 80px; }
    .bubble--lg { --bubble-size: 160px; }
    .bubble--xl { --bubble-size: 280px; }
    .bubble--xxl { --bubble-size: 380px; }
    /* Lift the host page's content above the overlay so the bubble
       never sits on top of any UI. Uses :where() so the rule has
       zero specificity and can't clobber any pre-existing z-index
       (e.g. nav.top's z-index: 50 still wins). */
    body > :where(:not(.bubble-field):not(script):not(style):not(link):not(meta)) {
      position: relative;
      z-index: 1;
    }
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
  // is the visual style (all bubbles are forced to iridescent on
  // render, but the field is kept in the data for readability and so
  // future variants can be re-introduced without a data migration).
  // alts is the list of candidate positions — we use the first entry
  // as the bubble's fixed position. (Earlier versions cycled through
  // alts on click, but bubbles no longer move.)

  // Helper to build a placement. `variant` is retained in the data
  // shape so we don't have to rewrite the PLACEMENTS tables, but it
  // isn't read at render time — every bubble is rendered as iridescent.
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
  // corners and four edges of the visible margin. Sizes are spread
  // from xs (16px) up to xl (280px) so the visual rhythm is clearly
  // varied — not the same medium/small pattern on every page.
  const AUTH = [
    // Hero corners — one big iridescent anchor on each side
    P("2%",  "8%",   280, "iridescent", [
      { x: "2%",  y: "8%"  }, { x: "6%",  y: "12%" },
      { x: "4%",  y: "4%"  },
    ]),
    P("88%", "10%",  160, "cyan", [
      { x: "88%", y: "10%" }, { x: "84%", y: "14%" },
    ]),
    // Mid-page accents — small + medium on opposite sides
    P("3%",  "50%",  80, "white", [
      { x: "3%",  y: "50%" }, { x: "7%",  y: "54%" },
    ]),
    P("92%", "55%",  100, "white", [
      { x: "92%", y: "55%" }, { x: "88%", y: "59%" },
    ]),
    // Lower margin — a tiny dot and a medium orb
    P("6%",  "85%",  32, "glass", [
      { x: "6%",  y: "85%" }, { x: "10%", y: "88%" },
    ]),
    P("90%", "88%",  70, "cyan", [
      { x: "90%", y: "88%" }, { x: "86%", y: "92%" },
    ]),
    // Two extra-small sprinkles for texture
    P("22%", "94%",  16, "glass", [
      { x: "22%", y: "94%" }, { x: "26%", y: "96%" },
    ]),
    P("78%", "20%",  40, "white", [
      { x: "78%", y: "20%" }, { x: "74%", y: "24%" },
    ]),
  ];

  // ---- App pages (8 bubbles) ----
  // Sidebar on the left, dash-bar at the top, main content in the
  // middle. Bubbles live in the right margin, corners, and a couple
  // behind the sidebar area. Sizes run the full range so the page
  // reads as deliberately varied rather than uniform.
  const APP = [
    // Top-right hero anchor
    P("92%", "8%",   280, "iridescent", [
      { x: "92%", y: "8%"  }, { x: "88%", y: "12%" },
      { x: "94%", y: "4%"  },
    ]),
    // Top-left medium counterweight (sits over the sidebar)
    P("3%",  "12%",  80, "cyan", [
      { x: "3%",  y: "12%" }, { x: "6%",  y: "16%" },
    ]),
    // Right margin — a small + a tiny dot
    P("96%", "38%",  32, "white", [
      { x: "96%", y: "38%" }, { x: "92%", y: "42%" },
    ]),
    P("94%", "62%",  16, "glass", [
      { x: "94%", y: "62%" }, { x: "90%", y: "66%" },
    ]),
    // Left margin — medium glass + small white
    P("4%",  "50%",  100, "glass", [
      { x: "4%",  y: "50%" }, { x: "8%",  y: "54%" },
    ]),
    P("2%",  "82%",  40, "white", [
      { x: "2%",  y: "82%" }, { x: "6%",  y: "86%" },
    ]),
    // Bottom-right large anchor
    P("90%", "86%",  160, "white", [
      { x: "90%", y: "86%" }, { x: "86%", y: "90%" },
    ]),
    // Bottom-centre tiny dot
    P("50%", "94%",  16, "cyan", [
      { x: "50%", y: "94%" }, { x: "46%", y: "96%" },
    ]),
  ];

  // ---- Email templates (sparse, 4) ----
  // Even with only 4 bubbles, run the full size range so the page
  // doesn't look like a uniform row of same-size dots.
  const EMAIL = [
    P("3%",  "10%",  280, "iridescent", [
      { x: "3%",  y: "10%" }, { x: "7%",  y: "14%" },
    ]),
    P("92%", "18%",  80, "cyan", [
      { x: "92%", y: "18%" }, { x: "88%", y: "22%" },
    ]),
    P("6%",  "72%",  32, "white", [
      { x: "6%",  y: "72%" }, { x: "10%", y: "76%" },
    ]),
    P("94%", "86%",  16, "glass", [
      { x: "94%", y: "86%" }, { x: "90%", y: "90%" },
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

  // Size → CSS class.
  const SIZE_CLASS = {
    16:  "bubble--xs",
    32:  "bubble--sm",
    80:  "bubble--md",
    160: "bubble--lg",
    280: "bubble--xl",
    380: "bubble--xxl",
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
      const W = window.innerWidth;
      const H = window.innerHeight;
      for (let i = 0; i < count; i++) {
        const r = Math.random();
        let size = 32;
        let acc = 0;
        for (const s of SIZES_RAND) { acc += s.p; if (r < acc) { size = s.size; break; } }
        // Stay in the outer 20% margins so we don't sit on the main content
        const side = Math.random() < 0.5 ? "left" : "right";
        const x = side === "left"
          ? Math.random() * (W * 0.2)
          : W * 0.8 + Math.random() * (W * 0.2);
        const y = Math.random() * H;
        // No alts — the pop handler picks a fresh random margin pos
        // on click.
        createBubble(x, y, size, []);
      }
      return;
    }

    // Hand-placed arrangement.
    for (const p of placements) {
      const alts = parseAlts(p.alts, [window.innerWidth, window.innerHeight]);
      const x = alts[0].x;
      const y = alts[0].y;
      createBubble(x, y, p.size, p.alts);
    }
  }

  // ----- 6. Bubble lifecycle: spawn, pop, resize ------------------------
  // Each bubble has a base position (in viewport px). The bubbles are
  // fixed — they don't drift on scroll and they don't wrap around. The
  // scroll listener is still installed (so resize can re-clamp
  // positions) but the per-bubble `factor` is 0, so `y_drawn = baseY`
  // and no parallax is applied.
  //
  // Click → pop. The pop function animates scale(1.6) + opacity 0,
  // teleports to the next alt position, then fades back. While the pop
  // is running, `b.popping` is true and the scroll handler skips the
  // bubble so the animation isn't clobbered.

  function createBubble(x, y, size, altsData) {
    const el = document.createElement("div");
    // Every bubble is the iridescent (rainbow) variant.
    const sizeClass = SIZE_CLASS[size] || "bubble--md";
    el.className = "bubble " + sizeClass + " bubble--iridescent";
    el.style.opacity = "0";
    el.style.transform = `translate3d(${x - size/2}px, ${y - size/2}px, 0)`;
    overlay.appendChild(el);

    // Alts is the raw placement data — viewport-relative percentages.
    // We re-parse on pop (against the current viewport) so positions
    // stay correct after rotation. Random-spawn bubbles get an empty
    // alts list; their pop picks a fresh random margin position.
    const b = {
      el,
      size,
      baseX: x,
      baseY: y,
      factor: 0,   // fixed: no scroll-driven drift (was 0.15..0.65 parallax depth)
      alts: altsData || [],
      altIndex: 0,
      popping: false,
    };
    bubbles.push(b);

    // Click → pop. stopPropagation is defensive: the field has
    // pointer-events: none, so the click can't have come from empty
    // space, but if any future page wires a click on the bubble
    // field's parent this prevents it firing too.
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      if (b.popping) return;
      popBubble(b);
    });

    // Fade in.
    el.style.transition = "opacity 0.4s ease";
    requestAnimationFrame(() => {
      el.style.opacity = "1";
      setTimeout(() => { el.style.transition = ""; }, 500);
    });
  }

  function applyTransform(b, x, y, scale) {
    const s = scale == null ? 1 : scale;
    b.el.style.transform = `translate3d(${x - b.size/2}px, ${y - b.size/2}px, 0) scale(${s})`;
  }

  // ---- 6a. Pop & regrow ------------------------------------------------
  const POP_OUT_MS = 350;
  const POP_IN_MS  = 300;

  function popBubble(b) {
    b.popping = true;
    if (reduceMotion.matches) {
      // Instant teleport — no animation for users who opted out.
      advanceToNextAlt(b);
      applyTransform(b, b.baseX, b.baseY, 1);
      b.popping = false;
      return;
    }

    // 1. Pop: scale up + fade out at the current drawn position.
    const yDrawn = b.baseY + window.scrollY * b.factor;
    b.el.style.transition = `transform ${POP_OUT_MS}ms cubic-bezier(0.4, 0, 0.2, 1),
                             opacity   ${POP_OUT_MS}ms ease`;
    applyTransform(b, b.baseX, yDrawn, 1.6);
    b.el.style.opacity = "0";

    // 2. When the pop is done, teleport to the next position and fade
    // back in. The scroll handler is blocked while `popping` is true,
    // so this transform write sticks.
    setTimeout(() => {
      advanceToNextAlt(b);
      const yDrawn2 = b.baseY + window.scrollY * b.factor;
      b.el.style.transition = `transform ${POP_IN_MS}ms cubic-bezier(0.4, 0, 0.2, 1),
                               opacity   ${POP_IN_MS}ms ease`;
      applyTransform(b, b.baseX, yDrawn2, 1);
      b.el.style.opacity = "1";
      setTimeout(() => {
        b.el.style.transition = "";
        b.popping = false;
      }, POP_IN_MS + 50);
    }, POP_OUT_MS);
  }

  function advanceToNextAlt(b) {
    b.altIndex = (b.altIndex + 1) % Math.max(1, b.alts.length);

    // Hand-placed bubble with alts: re-parse the next alt against the
    // current viewport and write it as the new base position. After
    // cycling all alts, there's a 50% chance to pick a fresh random
    // margin position so the page doesn't feel like a strict loop.
    if (b.alts.length > 0) {
      const useRandom = b.altIndex === 0 && Math.random() < 0.5;
      if (useRandom) {
        pickRandomMarginPos(b);
        return;
      }
      const next = b.alts[b.altIndex];
      const W = window.innerWidth;
      const H = window.innerHeight;
      b.baseX = parseCoord(next.x, W);
      b.baseY = parseCoord(next.y, H);
      return;
    }

    // No alts (random-spawn bubble): always pick a fresh margin pos.
    pickRandomMarginPos(b);
  }

  function pickRandomMarginPos(b) {
    const W = window.innerWidth;
    const H = window.innerHeight;
    const side = Math.random() < 0.5 ? "left" : "right";
    b.baseX = side === "left"
      ? Math.random() * (W * 0.2)
      : W * 0.8 + Math.random() * (W * 0.2);
    b.baseY = Math.random() * H;
  }

  // ---- 6b. Scroll handler (now a no-op) ---------------------------------
  // Bubbles are fixed in the viewport — they do not drift on scroll and
  // they do not wrap. The handler remains so the pop animation's exit/
  // entry transforms (which are set in the pop path, not here) aren't
  // clobbered if a scroll happens mid-pop, but with factor=0 it does
  // nothing on its own.
  function onScroll() {
    for (let i = 0; i < bubbles.length; i++) {
      const b = bubbles[i];
      if (b.popping) continue;   // don't clobber the pop animation
      applyTransform(b, b.baseX, b.baseY, 1);
    }
  }

  // Re-parse alts + reposition under the new viewport. We keep each
  // bubble's current conceptual position (the alt at altIndex, or the
  // bubble's current baseX/baseY if it has no alts).
  let resizeTimer = 0;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      const W = window.innerWidth;
      const H = window.innerHeight;
      for (const b of bubbles) {
        if (b.alts.length > 0) {
          const cur = b.alts[b.altIndex];
          b.baseX = parseCoord(cur.x, W);
          b.baseY = parseCoord(cur.y, H);
        }
        // else: random-spawn bubble — baseX/baseY are already px,
        // just leave them.
      }
      onScroll();   // re-apply transforms at the new viewport
    }, 200);
  });

  // ---- 6c. Initial paint -----------------------------------------------
  // No scroll listener: bubbles are fixed in the viewport, so scroll
  // is irrelevant. The transforms are set once in spawn() and again on
  // resize.
  spawn();
  onScroll();   // apply initial transforms at the current viewport
})();
