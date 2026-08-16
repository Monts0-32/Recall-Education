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
    /* The bubble field sits at z-index 1 (above page content) so the
       bubbles are reliably clickable in margins. The page's own nav
       still wins (z-index 50) so the top bar is unaffected. */
    .bubble-field {
      position: fixed;
      inset: 0;
      z-index: 1;
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
      /* Real soap-bubble anatomy, stacked bottom-up:
           1. a deep cool inner shadow on the lower-right (the bubble's
              "underside" curve catches less light)
           2. a soft outer drop shadow on the page
           3. a 1px inner rim that darkens at the edge (thin-film
              thickness)
           4. on top: a sharp pinpoint specular at the top-left, a
              softer secondary highlight just below it, and a thin
              bright crescent at the bottom (the surface reflection).
         The body fill is mostly transparent so the dark page shows
         through, like a real glass sphere. */
      background:
        /* Sharp specular hotspot (top-left, small + bright) */
        radial-gradient(circle at 28% 24%,
          rgba(255,255,255,0.95) 0%,
          rgba(255,255,255,0.55) 3%,
          rgba(255,255,255,0.18) 9%,
          rgba(255,255,255,0.00) 16%),
        /* Softer secondary highlight just under the hotspot */
        radial-gradient(circle at 30% 38%,
          rgba(255,255,255,0.35) 0%,
          rgba(255,255,255,0.10) 14%,
          rgba(255,255,255,0.00) 28%),
        /* Bottom crescent — the surface reflection */
        radial-gradient(ellipse 50% 22% at 50% 92%,
          rgba(255,255,255,0.40) 0%,
          rgba(255,255,255,0.15) 35%,
          rgba(255,255,255,0.00) 70%),
        /* Cool blue-grey tint in the body (the bubble's interior
           colour when light passes through the film) */
        radial-gradient(circle at 50% 50%,
          rgba(190,210,230,0.06) 0%,
          rgba(190,210,230,0.00) 70%);
      box-shadow:
        /* Inner top-left brightening (the lit side) */
        inset  8px 10px 24px rgba(255,255,255,0.18),
        /* Inner lower-right darkening (the shadowed underside) */
        inset -10px -14px 30px rgba(80,110,140,0.32),
        /* Thin dark rim from the film's edge */
        inset  0  0   2px rgba(255,255,255,0.06),
        /* Outer drop shadow on the page */
                0  12px 30px rgba(0,0,0,0.28),
                0  0   44px rgba(180,210,235,0.10);
      border: 1px solid rgba(255,255,255,0.10);
    }
    /* Iridescent — soap-bubble ring (the photo reference). Soft
       pastel hues concentrated at the RIM only (60–90% of the radius)
       via a tight mask, so the centre stays translucent. This is what
       makes a real bubble read: a thin coloured band, not a coloured
       disc. */
    .bubble--iridescent {
      background:
        /* Base sphere layers inherited from .bubble stay because we
           don't redeclare background here — only the iridescent rim
           is added via the ::before pseudo (see below). */
        radial-gradient(circle at 28% 24%,
          rgba(255,255,255,0.95) 0%,
          rgba(255,255,255,0.55) 3%,
          rgba(255,255,255,0.18) 9%,
          rgba(255,255,255,0.00) 16%),
        radial-gradient(circle at 30% 38%,
          rgba(255,255,255,0.35) 0%,
          rgba(255,255,255,0.10) 14%,
          rgba(255,255,255,0.00) 28%),
        radial-gradient(ellipse 50% 22% at 50% 92%,
          rgba(255,255,255,0.40) 0%,
          rgba(255,255,255,0.15) 35%,
          rgba(255,255,255,0.00) 70%);
      /* The iridescent rim is rendered by .bubble--iridescent::before
         (below) so the ring can sit on top of the body without
         fighting its highlights. */
      box-shadow:
        inset  8px 10px 24px rgba(255,255,255,0.18),
        inset -10px -14px 30px rgba(80,110,140,0.32),
        inset  0  0   2px rgba(255,255,255,0.06),
                0  12px 30px rgba(0,0,0,0.28),
                0  0   50px rgba(255,200,220,0.16);
      border: 1px solid rgba(255,255,255,0.10);
    }
    /* The iridescent ring — a child element stacked above the body.
       It's a full-size conic-gradient masked to a thin band at the
       rim (62–92% radius). The conic stops are pastels matching the
       reference photo: pink → lavender → mint → pale yellow → sky →
       pink. */
    .bubble--iridescent::before {
      content: "";
      position: absolute;
      inset: 0;
      border-radius: 50%;
      pointer-events: none;
      background: conic-gradient(from 200deg,
        rgba(255,170,210,0.00)  0deg,
        rgba(255,170,210,0.65)  35deg,
        rgba(195,160,255,0.70)  75deg,
        rgba(255,255,255,0.60) 115deg,
        rgba(170,235,210,0.65) 155deg,
        rgba(255,230,170,0.65) 200deg,
        rgba(255,170,210,0.65) 245deg,
        rgba(170,220,255,0.70) 290deg,
        rgba(195,160,255,0.65) 330deg,
        rgba(255,170,210,0.00) 360deg);
      -webkit-mask: radial-gradient(circle,
        transparent 0%,   transparent 62%,
        #000 72%,         #000 90%,
        transparent 100%);
              mask: radial-gradient(circle,
        transparent 0%,   transparent 62%,
        #000 72%,         #000 90%,
        transparent 100%);
    }
    /* Glass — frosted clear sphere, no chromatic ring. */
    .bubble--glass {
      box-shadow:
        inset  6px  8px 20px rgba(255,255,255,0.22),
        inset -8px -10px 22px rgba(120,150,180,0.22),
        inset  0  0   2px rgba(255,255,255,0.06),
                0  10px 26px rgba(0,0,0,0.24),
                0  0   30px rgba(180,210,235,0.12);
    }
    /* White — clean pearl highlight, no chromatic ring. */
    .bubble--white {
      box-shadow:
        inset  8px 10px 22px rgba(255,255,255,0.32),
        inset -8px -10px 22px rgba(150,170,190,0.20),
        inset  0  0   2px rgba(255,255,255,0.08),
                0  10px 28px rgba(0,0,0,0.24),
                0  0   28px rgba(255,255,255,0.12);
    }
    /* Cyan — translucent sphere with a faint teal tint. */
    .bubble--cyan {
      box-shadow:
        inset  8px 10px 22px rgba(180,235,240,0.26),
        inset -8px -10px 26px rgba(63,140,160,0.30),
        inset  0  0   2px rgba(180,235,240,0.10),
                0  10px 26px rgba(0,0,0,0.24),
                0  0   36px rgba(124,224,232,0.18);
    }
    /* Subtle ambient float — each bubble drifts a few px on its own
       clock so the field never feels frozen between scroll events.
       The jitter is added by the physics loop directly (folded into the
       inline transform every frame), so this keyframe just animates a
       CSS custom property for a soft pulse on the box-shadow — that
       way it never fights the transform written by the loop. */
    .bubble {
      animation: bubble-pulse var(--float-dur, 6s) ease-in-out infinite;
      animation-delay: var(--float-delay, 0s);
    }
    @keyframes bubble-pulse {
      0%, 100% { filter: brightness(1) saturate(1); }
      50%      { filter: brightness(1.06) saturate(1.04); }
    }
    /* While popping we disable the float / pulse animations and let
       the inline transform + opacity transitions drive the pop. After
       the pop's transitionend fires, JS teleports the bubble to its
       next alt position and removes the popping class — the bubble
       fades back in. */
    /* -- Pop phases ---------------------------------------------------------
       A real bubble pop has three visible stages:
         1. WOBBLE (0–110ms)  — surface tension makes the bubble shake
                               briefly before it bursts. CSS keyframe
                               on the body so the iridescent rim shakes
                               with it.
         2. BURST (110–420ms) — body scales up 1×→1.7× and fades. The
                               rim ring expands outward 1×→3.2× and
                               fades. A bright centre flash pulses at
                               the moment of burst.
         3. FRAGMENTS (180–580ms) — three small ring "fragments" scatter
                                  outward at different angles from the
                                  burst point, fading as they go. These
                                  are box-shadows on the ::after so we
                                  don't need extra DOM nodes.
       JS toggles the classes: .bubble--wobbling is added on click,
       removed after ~110ms, then .bubble--popping is added.
    */
    .bubble.bubble--wobbling {
      animation: bubble-wobble 110ms ease-in-out !important;
      pointer-events: none;
    }
    @keyframes bubble-wobble {
      0%   { transform: var(--bubble-tx, translate3d(0,0,0)) scale(1)      rotate(0deg);   filter: brightness(1); }
      20%  { transform: var(--bubble-tx, translate3d(0,0,0)) scale(1.06)   rotate(2deg);   filter: brightness(1.15); }
      45%  { transform: var(--bubble-tx, translate3d(0,0,0)) scale(0.97)   rotate(-3deg);  filter: brightness(1.05); }
      70%  { transform: var(--bubble-tx, translate3d(0,0,0)) scale(1.04)   rotate(1.5deg); filter: brightness(1.10); }
      100% { transform: var(--bubble-tx, translate3d(0,0,0)) scale(1)      rotate(0deg);   filter: brightness(1); }
    }
    .bubble.bubble--popping {
      animation: none !important;
      transition: transform 320ms cubic-bezier(0.22, 1, 0.36, 1),
                  opacity   320ms ease-out;
      pointer-events: none;
    }
    /* Burst ring + fragments + flash. The ::after is a thin border +
       three stacked box-shadow rings that act as fragments scattering
       at 0°, 120°, 240° around the burst. The body element itself
       provides the centre flash (a brief bright inset that pulses at
       the start of the burst). */
    .bubble::after {
      content: "";
      position: absolute;
      inset: 0;
      border-radius: 50%;
      pointer-events: none;
      border: 1.5px solid rgba(255,255,255,0.55);
      box-shadow:
        /* Primary ring — expands 1×→3.2× */
        0 0 8px rgba(255,200,220,0.35),
        inset 0 0 8px rgba(255,255,255,0.20);
      opacity: 0;
      transform: scale(1);
      transform-origin: center;
    }
    /* Centre flash — a brief bright inset on the body when popping. The
       body's own box-shadow can't be animated cleanly (it would lose
       the bubble's resting shadow), so we use a brief CSS filter pulse
       and let the burst ring handle the visual. */
    .bubble.bubble--popping::after {
      animation: bubble-burst 460ms cubic-bezier(0.22, 0.61, 0.36, 1) forwards,
                 bubble-flash 220ms ease-out forwards,
                 bubble-fragments 580ms cubic-bezier(0.22, 0.61, 0.36, 1) forwards;
    }
    @keyframes bubble-burst {
      0%   { opacity: 0;    transform: scale(1);    border-color: rgba(255,255,255,0.75); }
      14%  { opacity: 0.95; transform: scale(1.22); border-color: rgba(255,255,255,0.65); }
      50%  { opacity: 0.45; transform: scale(2.10); border-color: rgba(210,225,255,0.35); }
      100% { opacity: 0;    transform: scale(3.30); border-color: rgba(210,225,255,0.00); }
    }
    @keyframes bubble-flash {
      0%   { box-shadow: 0 0 0 rgba(255,255,255,0.0); }
      18%  { box-shadow:
               0 0 24px rgba(255,255,255,0.85),
               0 0 48px rgba(255,210,225,0.55),
               inset 0 0 18px rgba(255,255,255,0.55); }
      100% { box-shadow:
               0 0 8px rgba(255,200,220,0.35),
               inset 0 0 8px rgba(255,255,255,0.20); }
    }
    /* Three fragments — small filled discs that shoot outward at 0°,
       120°, 240° from the burst point. We implement them as additional
       ::after siblings by stacking on a SECOND pseudo... but ::after
       is already used. So instead we use three inset shadows on the
       ::after that animate outward at different angles. The inset
       radius is animated to "shoot" outward. */
    @keyframes bubble-fragments {
      0%   {
        box-shadow:
          0 0 8px rgba(255,200,220,0.35),
          inset 0 0 0 rgba(255,255,255,0),
          inset 0 0 0 rgba(255,255,255,0),
          inset 0 0 0 rgba(255,255,255,0);
      }
      30%  {
        box-shadow:
          0 0 8px rgba(255,200,220,0.35),
          /* fragment 1 — top, 12px out */
          inset  0  12px 0 rgba(255,180,210,0.85),
          /* fragment 2 — bottom-right, 12px out */
          inset  10px -10px 0 rgba(190,180,255,0.85),
          /* fragment 3 — bottom-left, 12px out */
          inset -10px -10px 0 rgba(180,230,220,0.85);
      }
      100% {
        box-shadow:
          0 0 8px rgba(255,200,220,0.35),
          inset  0  60px 0 rgba(255,180,210,0),
          inset  50px -50px 0 rgba(190,180,255,0),
          inset -50px -50px 0 rgba(180,230,220,0);
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .bubble, .bubble.bubble--wobbling, .bubble.bubble--popping,
      .bubble.bubble--popping::after {
        animation: none !important;
        transition: none !important;
      }
      .bubble.bubble--popping::after { opacity: 0; }
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
      const VARIANTS_RAND = ["iridescent", "iridescent", "glass", "glass", "white", "cyan"];
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
        const variant = VARIANTS_RAND[Math.floor(Math.random() * VARIANTS_RAND.length)];
        // No alts — the pop handler picks a fresh random margin pos
        // on click.
        createBubble(x, y, size, [], variant);
      }
      return;
    }

    // Hand-placed arrangement.
    for (const p of placements) {
      // altsPx is the parsed-alts array (centre coords in viewport px).
      // We pass it to createBubble which converts to top-left coords.
      const altsPx = parseAlts(p.alts, [window.innerWidth, window.innerHeight]);
      const cx = altsPx[0].x;
      const cy = altsPx[0].y;
      createBubble(cx, cy, p.size, altsPx, p.variant);
    }
  }

  // ----- 6. Bubble lifecycle: spawn, pop, resize ------------------------
  // Each bubble has continuous, realistic physics:
  //   - slow horizontal drift in a fixed direction (per-bubble)
  //   - sinusoidal vertical bob (each bubble on its own phase + period)
  //   - tiny lateral sway (so the bubble doesn't travel in a dead-straight
  //     line — bubbles wobble in real fluids)
  //   - wrap-around: bubbles that leave one edge of the viewport re-enter
  //     from the opposite edge, with their drift direction preserved
  //   - a small scroll parallax: scrolling the page nudges the bubbles
  //     vertically by a per-bubble factor so the field "breathes" with
  //     the page
  //
  // The simulation runs in a single requestAnimationFrame loop. We
  // pause it (with a sentinel) when the tab is hidden so it doesn't
  // burn battery in the background.
  //
  // Click → pop & regrow. A CSS class drives the pop keyframe (more
  // reliable cross-browser than inline transitions), then a single
  // `animationend` handler teleports the bubble to its next alt
  // position and clears the class so the bubble fades back in.

  const VARIANT_CLASS = {
    iridescent: "bubble--iridescent",
    glass:      "bubble--glass",
    white:      "bubble--white",
    cyan:       "bubble--cyan",
  };

  function createBubble(x, y, size, altsData, variantName) {
    const el = document.createElement("div");
    const sizeClass = SIZE_CLASS[size] || "bubble--md";
    const variantClass = VARIANT_CLASS[variantName] || "bubble--iridescent";
    el.className = "bubble " + sizeClass + " " + variantClass;
    el.style.opacity = "0";
    overlay.appendChild(el);

    // Each bubble gets its own float-pulse duration (5–9s) and delay
    // (0–4s) so the field doesn't pulse in lockstep. Bigger bubbles get
    // longer periods so they feel heavier.
    const floatDur = 5 + Math.random() * 4 + (size > 80 ? 1.5 : 0);
    const floatDelay = -Math.random() * 4;
    el.style.setProperty("--float-dur", floatDur.toFixed(2) + "s");
    el.style.setProperty("--float-delay", floatDelay.toFixed(2) + "s");

    // Physics state — all in viewport pixels, with a real horizontal
    // drift velocity and a sinusoidal vertical bob. Each bubble has its
    // own period + phase so the field looks alive rather than uniform.
    //   vx: px/sec horizontal velocity (small, biased upward — bubbles
    //       rise in still water). Sign is randomised so the field
    //       doesn't all drift the same way.
    //   vyBase: px/sec baseline vertical rise
    //   bobAmp: px vertical bob amplitude (the bubble weaves up & down
    //           on top of the rise)
    //   bobPeriod: seconds for one full bob cycle
    //   bobPhase: radians offset (so each bubble starts at a different
    //             point in its cycle)
    //   swayAmp / swayPeriod: tiny lateral wobble on top of vx so the
    //         path isn't a dead-straight line
    const dir = Math.random() < 0.5 ? -1 : 1;
    const vx = dir * (4 + Math.random() * 10 + (size > 80 ? -2 : 0));  // px/sec
    const vyBase = -(6 + Math.random() * 8);                           // px/sec (up = neg)
    const bobAmp = 4 + Math.random() * 10 + (size > 80 ? 6 : 0);
    const bobPeriod = 4 + Math.random() * 6;                           // sec
    const bobPhase = Math.random() * Math.PI * 2;
    const swayAmp = 2 + Math.random() * 6;
    const swayPeriod = 3 + Math.random() * 5;
    const swayPhase = Math.random() * Math.PI * 2;
    // parallax depth — bigger bubbles drift more with page scroll so
    // the field has a layered feel
    const factor = 0.10 + Math.random() * 0.45 + (size > 80 ? 0.10 : 0);

    const b = {
      el,
      size,
      // Current rendered position (viewport px, top-left of bubble).
      // Physics writes this; the renderer reads it. (x,y) are CENTRE
      // coords passed in by spawn().
      px: x - size/2,
      py: y - size/2,
      // Which side of the page this bubble belongs to. The physics
      // loop clamps drift to the assigned margin (≤ 20% from the edge)
      // and never lets the bubble enter the centre 60% of the page.
      side: (x < window.innerWidth / 2) ? "left" : "right",
      // Stored alt positions (also viewport px, top-left). Pop picks
      // the next one and writes px/py to it.
      altPositions: (altsData || []).map(a => ({
        x: a.x - size/2,
        y: a.y - size/2,
      })),
      altIndex: 0,
      vx, vyBase, bobAmp, bobPeriod, bobPhase,
      swayAmp, swayPeriod, swayPhase,
      factor,
      popping: false,
      variant: variantName || "iridescent",
      t0: performance.now() / 1000,   // physics clock origin
    };
    bubbles.push(b);
    applyTransform(b, 0, 0, 1, true);  // initial paint

    // Click → pop & regrow. Listen on `click` so the bubble pops on a
    // real mouse-up on the bubble (not on hover or pointerdown while
    // the user is scrolling). `click` works for both mouse and touch.
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      e.preventDefault();
      if (b.popping) return;
      popBubble(b);
    });

    // Fade in (no transform transition here — physics owns transform).
    el.style.transition = "opacity 0.5s ease";
    requestAnimationFrame(() => {
      el.style.opacity = "1";
      setTimeout(() => { el.style.transition = ""; }, 600);
    });
  }

  function applyTransform(b, jitterX, jitterY, scale, skipIfPopping) {
    if (skipIfPopping && b.popping) return;
    const s = scale == null ? 1 : scale;
    const jx = jitterX || 0;
    const jy = jitterY || 0;
    b.el.style.transform =
      `translate3d(${(b.px + jx).toFixed(2)}px, ${(b.py + jy).toFixed(2)}px, 0) scale(${s})`;
  }

  // ---- 6a. Pop & regrow ------------------------------------------------
  // Pop = scale up to 1.7x + fade out, teleport to next alt on
  // transitionend, fade back in at the new spot. The CSS class
  // .bubble--popping sets the transition; we just toggle it and update
  // the transform / opacity targets.
  const POP_MS = 380;

  // The wobble pre-phase runs this long — the surface tension makes the
  // bubble shake briefly before bursting.
  const WOBBLE_MS = 110;

  function popBubble(b) {
    b.popping = true;
    if (reduceMotion.matches) {
      advanceToNextAlt(b);
      applyTransform(b, 0, 0, 1);
      b.popping = false;
      return;
    }

    // 1. WOBBLE — add the wobbling class. The CSS keyframe shakes the
    // bubble (scale + rotate jitter) for WOBBLE_MS. The physics loop
    // is paused (b.popping=true) so it doesn't fight the keyframe.
    b.el.classList.add("bubble--wobbling");
    // Seed the keyframe with the current physics position so the
    // wobble starts where the bubble is, not at the origin. CSS
    // variables carry through the keyframe stops.
    b.el.style.setProperty("--bubble-tx",
      `translate3d(${b.px.toFixed(2)}px, ${b.py.toFixed(2)}px, 0)`);

    setTimeout(() => {
      if (!b.popping) return;   // cancelled / already finished
      // 2. BURST — swap wobbling for popping. The popping class sets
      // the transition, and we write scale(1.7) + opacity 0 in the
      // next frame so the transition runs from current to target.
      b.el.classList.remove("bubble--wobbling");
      b.el.style.removeProperty("--bubble-tx");
      b.el.classList.add("bubble--popping");
      requestAnimationFrame(() => {
        b.el.style.transform =
          `translate3d(${b.px.toFixed(2)}px, ${b.py.toFixed(2)}px, 0) scale(1.7)`;
        b.el.style.opacity = "0";
      });

      // 3. On burst transitionend, teleport to the next alt and regrow.
      const onEnd = (ev) => {
        if (ev.propertyName !== "transform") return;
        b.el.removeEventListener("transitionend", onEnd);
        b.el.style.transition = "";
        b.el.classList.remove("bubble--popping");
        advanceToNextAlt(b);
        b.el.style.transition = `transform ${POP_MS}ms cubic-bezier(0.34, 1.56, 0.64, 1),
                                 opacity   ${POP_MS}ms ease-out`;
        b.el.style.transform =
          `translate3d(${b.px.toFixed(2)}px, ${b.py.toFixed(2)}px, 0) scale(0.6)`;
        b.el.style.opacity = "0";
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            b.el.style.transform =
              `translate3d(${b.px.toFixed(2)}px, ${b.py.toFixed(2)}px, 0) scale(1)`;
            b.el.style.opacity = "1";
            setTimeout(() => {
              b.el.style.transition = "";
              b.popping = false;
              b.t0 = performance.now() / 1000;
            }, POP_MS + 60);
          });
        });
      };
      b.el.addEventListener("transitionend", onEnd);
    }, WOBBLE_MS);

    // Hard-timeout fallback in case transitionend never fires.
    setTimeout(() => {
      if (b.popping) {
        b.el.classList.remove("bubble--wobbling");
        b.el.classList.remove("bubble--popping");
        b.el.style.transition = "";
        b.el.style.removeProperty("--bubble-tx");
        advanceToNextAlt(b);
        b.el.style.transform =
          `translate3d(${b.px.toFixed(2)}px, ${b.py.toFixed(2)}px, 0) scale(1)`;
        b.el.style.opacity = "1";
        b.popping = false;
        b.t0 = performance.now() / 1000;
      }
    }, WOBBLE_MS + POP_MS * 2 + 400);
  }

  function advanceToNextAlt(b) {
    // Hand-placed bubble with pre-computed alt positions: jump to the
    // next alt. After cycling all alts, there's a 50% chance to pick a
    // fresh random margin position so the page doesn't feel like a
    // strict loop.
    if (b.altPositions.length > 0) {
      b.altIndex = (b.altIndex + 1) % b.altPositions.length;
      if (b.altIndex === 0 && Math.random() < 0.5) {
        pickRandomMarginPos(b);
        return;
      }
      const next = b.altPositions[b.altIndex];
      b.px = next.x;
      b.py = next.y;
      return;
    }

    // No alts (random-spawn bubble): always pick a fresh margin pos.
    pickRandomMarginPos(b);
  }

  function pickRandomMarginPos(b) {
    const W = window.innerWidth;
    const H = window.innerHeight;
    const side = Math.random() < 0.5 ? "left" : "right";
    b.side = side;
    b.px = (side === "left"
      ? Math.random() * (W * 0.2)
      : W * 0.8 + Math.random() * (W * 0.2)) - b.size / 2;
    b.py = Math.random() * H - b.size / 2;
  }

  // ---- 6b. Physics loop -------------------------------------------------
  // Continuous, realistic motion. Every frame (rAF) we advance each
  // bubble by its drift velocity, add a sinusoidal vertical bob and a
  // tiny lateral sway, and apply a small scroll parallax.
  //
  // Constraints:
  //   - Bubbles only ever live in the left margin (x ≤ 20% of width)
  //     or the right margin (x ≥ 80% of width). When a bubble would
  //     drift toward the centre, it bounces off the inner edge and
  //     reverses direction; when it reaches the outer edge, it wraps
  //     to the opposite end of the same margin. Bubbles never enter
  //     the centre 60% column where the page content lives.
  //   - Scroll parallax is bounded — the parallax offset is computed
  //     mod the viewport height so long pages never accumulate an
  //     unbounded offset that pushes bubbles off-screen.
  //
  // dt is capped to 50ms so a tab returning from background doesn't
  // teleport every bubble off-screen.
  const SIDE_FRAC = 0.20;   // left margin = 0..20%, right = 80..100%
  let lastFrame = performance.now();
  let physicsRunning = true;

  function physics(now) {
    if (!physicsRunning) return;
    let dt = (now - lastFrame) / 1000;
    if (dt > 0.050) dt = 0.050;
    lastFrame = now;

    const W = window.innerWidth;
    const H = window.innerHeight;
    const scrollY = window.scrollY;
    // Bounded parallax: wrap the offset to [-H/2, H/2] so even a 5000px
    // scroll doesn't push the bubble far off the viewport.
    const parallaxMax = H * 0.5;
    const sideWidth = W * SIDE_FRAC;

    // -- Pass 1: drift, bob, sway, side-clamp -----------------------------
    for (let i = 0; i < bubbles.length; i++) {
      const b = bubbles[i];
      if (b.popping) continue;   // pop owns transform while running

      // Continuous drift
      b.px += b.vx * dt;
      b.py += b.vyBase * dt;

      // Sinusoidal bob (vertical weave on top of drift).
      const t = now / 1000;
      const bobAngle = (t / b.bobPeriod) * Math.PI * 2 + b.bobPhase;
      const bobOffsetY = Math.sin(bobAngle) * b.bobAmp;

      // Lateral sway — tiny oscillation on top of horizontal drift so
      // the path isn't a dead-straight line.
      const swayAngle = (t / b.swayPeriod) * Math.PI * 2 + b.swayPhase;
      const swayOffsetX = Math.sin(swayAngle) * b.swayAmp;

      // Side-restriction: clamp the bubble to its assigned margin and
      // bounce off the inner edge. Each bubble has a side ("left" or
      // "right") and a velocity sign — when vx would push it past the
      // inner edge of its margin, flip vx.
      const innerEdge = b.side === "left" ? sideWidth : W - sideWidth;
      if (b.side === "left") {
        if (b.px > innerEdge - b.size) {
          // Hit the inner edge — flip and clamp
          b.vx = Math.abs(b.vx);
          b.px = innerEdge - b.size;
        }
        // Outer wrap: when the bubble leaves the LEFT edge entirely,
        // wrap to the right end of the same margin so the field stays
        // continuous.
        if (b.px + b.size < 0) {
          b.px = innerEdge - b.size;
        }
      } else {
        if (b.px < innerEdge) {
          b.vx = -Math.abs(b.vx);
          b.px = innerEdge;
        }
        if (b.px > W) {
          b.px = innerEdge;
        }
      }

      // Stash the current bob/sway offsets on the bubble so the
      // collision pass can use them when computing positions.
      b._swayX = swayOffsetX;
      b._bobY  = bobOffsetY;
      // Bounded, CONTINUOUS scroll parallax — sin() so the offset
      // never jumps (modulo wraps would teleport on every wrap). The
      // frequency is low so fast scrolling only nudges the bubble
      // gently, and the amplitude stays within [-parallaxMax, +parallaxMax]
      // so a 5000px scroll can't push it off-screen.
      b._parallaxY = Math.sin(scrollY * 0.0015 + b.bobPhase) * parallaxMax * b.factor;
    }

    // -- Pass 2: collision avoidance --------------------------------------
    // For each pair of non-popping bubbles whose bounding circles
    // overlap, push them apart along the line between their centres
    // (split 50/50) and dampen the closing component of their
    // relative velocity. Bubbles on different sides are skipped — they
    // can never meet because the centre 60% is off-limits to both.
    //
    // Soft separation with a small "personal space" buffer so bubbles
    // don't sit exactly touching — they leave a few px gap.
    for (let i = 0; i < bubbles.length; i++) {
      const a = bubbles[i];
      if (a.popping) continue;
      const acx = a.px + a.size / 2;
      const acy = a.py + a.size / 2 + a._parallaxY;
      const ar  = a.size / 2;
      for (let j = i + 1; j < bubbles.length; j++) {
        const b = bubbles[j];
        if (b.popping) continue;
        // Same-side only — different sides never collide because the
        // centre column is forbidden territory.
        if (a.side !== b.side) continue;
        const bcx = b.px + b.size / 2;
        const bcy = b.py + b.size / 2 + b._parallaxY;
        const br  = b.size / 2;
        const dx = bcx - acx;
        const dy = bcy - acy;
        const dist = Math.hypot(dx, dy);
        const minDist = ar + br + 4;   // 4px personal-space buffer
        if (dist >= minDist || dist === 0) continue;
        // Unit vector from a → b
        const nx = dx / dist;
        const ny = dy / dist;
        const overlap = minDist - dist;
        // Split the push 50/50. If either bubble is at a side boundary
        // and the push would shove it past, the OTHER bubble takes the
        // full push so we respect the side-restriction.
        const aClamped = a.side === "left"
          ? (a.px - overlap / 2 < 0)
          : (a.px + overlap / 2 + a.size > W);
        const bClamped = a.side === "left"
          ? (b.px - overlap / 2 < 0)
          : (b.px + overlap / 2 + b.size > W);
        let aPush = overlap / 2;
        let bPush = overlap / 2;
        if (aClamped && !bClamped) { aPush = 0;        bPush = overlap; }
        else if (bClamped && !aClamped) { aPush = overlap; bPush = 0;   }
        else if (aClamped && bClamped) { aPush = 0;        bPush = 0;   }
        a.px -= nx * aPush;
        a.py -= ny * aPush;
        b.px += nx * bPush;
        b.py += ny * bPush;
        // Dampen the closing component of relative velocity so the
        // bubbles don't keep ramming each other. We project v onto the
        // collision normal and zero out the closing component. Closing
        // = the component that brings them together along the normal.
        const rvx = b.vx - a.vx;
        const rvy = b.vyBase - a.vyBase;
        const vn  = rvx * nx + rvy * ny;   // negative = closing
        if (vn < 0) {
          // Bounce: split the impulse, with restitution 0.6 (gentle,
          // bubbles in real fluids don't fully bounce off each other).
          const j = -(1 + 0.6) * vn / 2;
          a.vx -= j * nx;
          a.vyBase -= j * ny;
          b.vx += j * nx;
          b.vyBase += j * ny;
        }
      }
    }

    // -- Pass 3: write transforms + boundary wrap --------------------------
    for (let i = 0; i < bubbles.length; i++) {
      const b = bubbles[i];
      if (b.popping) continue;
      // After collisions, re-clamp to the side margin in case the push
      // pushed a bubble past it. Use the bubble's stored sway/parallax.
      const innerEdge = b.side === "left" ? sideWidth : W - sideWidth;
      if (b.side === "left") {
        if (b.px > innerEdge - b.size) b.px = innerEdge - b.size;
        if (b.px < 0) b.px = innerEdge - b.size;
      } else {
        if (b.px < innerEdge) b.px = innerEdge;
        if (b.px + b.size > W) b.px = innerEdge;
      }
      // Vertical wrap: if the bubble has drifted fully off the top
      // (vyBase makes bubbles rise), wrap it to the bottom of the
      // viewport; same for bottom → top. This keeps every bubble in
      // view forever, regardless of how long the page is.
      if (b.py + b.size < 0) {
        b.py = H;
      } else if (b.py > H) {
        b.py = -b.size;
      }
      const finalX = b.px + (b._swayX || 0);
      const finalY = b.py + (b._bobY || 0) + (b._parallaxY || 0);
      b.el.style.transform =
        `translate3d(${finalX.toFixed(2)}px, ${finalY.toFixed(2)}px, 0) scale(1)`;
    }

    requestAnimationFrame(physics);
  }

  // Pause when tab is hidden so we don't burn battery offscreen.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      physicsRunning = false;
    } else {
      if (!physicsRunning) {
        physicsRunning = true;
        lastFrame = performance.now();
        requestAnimationFrame(physics);
      }
    }
  });

  // ---- 6c. Initial paint + physics start --------------------------------
  spawn();
  requestAnimationFrame(physics);
})();
