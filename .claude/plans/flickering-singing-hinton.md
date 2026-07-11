# Plan: Fix login + personalise dashboard

## Context

You're building a UK exam-revision SaaS called **Recall**. The user-facing
flow is: sign up → confirm email → land on a personalised dashboard → see
their subjects/streak/upcoming work. There's also a staff tool
(`staff.html`) — a lesson creator that authenticates against the same
Supabase project but requires `profiles.role = 'staff'`.

Two real problems stand in the way:

1. **`login.html` does not actually sign anyone in.** Its submit handler
   (lines 398–413) is a fake demo that just toggles button text and
   shows a banner. It never calls `supabaseClient.auth.signInWithPassword`.
   This is why "signing in with the correct details … doesn't take me
   anywhere."
2. **The dashboard is not personalised.** It already has the wiring
   (`setIdentity`, `loadDashboard`) to render the signed-in user's
   name/year group/streak/subjects — but it currently shows
   hardcoded "14 day streak", "Sarah M.", the mock KPI numbers, the
   mock continue row, etc., on first paint, only overwriting them
   after the Supabase call resolves. The right behaviour: if there's
   no session, show a clean signed-out state. If there's a session,
   show their real data (or honest empty states if their DB rows are
   empty).

Email confirmation is working, signup creates a profile row via the
`handle_new_user()` trigger, and the access-token hook blocks under-16s
without parental consent — none of that needs to change.

## Files to modify

- `login.html` — replace the fake submit handler with a real
  `supabaseClient.auth.signInWithPassword` call, handle errors,
  redirect to `dashboard.html` on success.
- `dashboard.html` — make the "no session" branch a real empty state
  (welcome → "Sign in" CTA) and make the "session, no data" branch
  honest (real zeroes from queries, no fake streak / fake KPIs). The
  `setIdentity` / `loadDashboard` code is already correct — the
  problem is the hardcoded bootstrap above it.
- No SQL changes. No new tables.

## Changes

### 1. `login.html` — real sign-in

Mirror the Supabase client setup already in `signup.html`
(lines 415–418) and `dashboard.html` (lines 529–535): load
`@supabase/supabase-js@2` from the same CDN and create a client with the
same URL + anon key.

Replace the submit handler (login.html:400–412) with one that:
- prevents default, reads `email` + `password`
- disables the button and shows a "Signing in…" state
- calls `supabaseClient.auth.signInWithPassword({ email, password })`
- on `error`: re-enables the button, runs the error through a
  `explainAuthError()` (reuse the same translator pattern from
  `signup.html:565–584` — already handles "Invalid login credentials",
  rate limits, "Email not confirmed") and shows the existing error
  banner `#err`.
- on success: `window.location.href = 'dashboard.html'`.

Add the same `redirectTo` consideration: don't set `emailRedirectTo`
on sign-in (it's a sign-in, not a sign-up). The user's already clicked
the confirmation link — `auth.signInWithPassword` will fail with
"Email not confirmed" if they haven't, and the error translator will
turn that into a useful message.

Keep the existing "forgot password" link as a stub `<a href="#">` (out
of scope to wire up `resetPasswordForEmail` here; flag it as a TODO).

### 2. `dashboard.html` — honest empty states + real personalisation

The script already does the right thing once `load()` runs
(dashboard.html:928–957). The problem is what shows **before** and
**around** that:

- `setIdentity(null, null)` (line 925) + `renderEmpty()` (line 926)
  run synchronously on parse, which is correct — but `renderEmpty()`
  shows a "0 day streak" with all 14 bar segments grey, which the user
  reads as "my dashboard."
- The fake `🔥 14 day streak` in the sidebar markup
  (dashboard.html:444) flashes on first paint before JS overwrites it.
- The `<h1>Welcome to Recall</h1>` (line 468) is the same.

Fix:
- **Initial markup**: change the hardcoded streak/avatar/name in the
  HTML to "—" / empty strings / no pill, so first paint is blank
  rather than misleading. (`streakNum`, `userName`, `userAvatar`,
  `dashBarPill`, `navName`, `signOutBtn` are all already overwritten
  by `setIdentity` — just give them neutral starting values.)
- **No session**: instead of `showState('Not signed in. …')` and
  leaving the rest blank, replace the dashboard body with a single
  centred "Sign in to see your dashboard" card with two buttons:
  "Sign in" → `login.html`, "Create account" → `signup.html`. The
  current `#state` info banner is too subtle for a first-time visitor
  who landed on `dashboard.html` by mistake.
- **Session, no data**: `loadDashboard` already calls `renderEmpty()`
  (line 910) when the data fetch fails, and shows the
  "Your dashboard is being set up" state if some tables are missing.
  Tighten `renderEmpty()` to read naturally (e.g. "0 enrolled —
  browse the catalogue to add your first subject" instead of "All
  time" for a delta). Keep the existing `enrollments.length === 0`
  copy in `renderSubjects`.
- **Session, has data**: keep the existing `setIdentity` + KPI /
  continue / subjects / streak renderers as-is. They already read
  from the DB and respect empty states per-card.

## Existing utilities to reuse

- `supabaseClient` setup pattern (`<script src="…@supabase/supabase-js@2">`
  + `window.supabase.createClient(...)`) — `signup.html:405–417`,
  `dashboard.html:529–535`, `staff.html:639–645`. Reuse the same URL
  and anon key (the values are already public in those files).
- `explainAuthError(message)` translator in `signup.html:565–584` —
  copy/adapt the same one in `login.html` so error messages stay
  consistent.
- `escapeHtml`, `initials`, `timeAgo`, `timeUntil`, `dayMonth` —
  already defined in `dashboard.html:540–589` and `staff.html:649–656`.
  No new helpers needed.
- The "show error banner" / "show ok banner" pattern in
  `signup.html:455–466` — apply the same shape in `login.html` for
  the `#err` banner that's already styled (login.html:257–268).

## What stays out of scope

- Wiring the "Forgot password?" link (would need a
  `resetPasswordForEmail` call + a reset-password page).
- Wiring OAuth buttons (Google/Microsoft/Apple) — the markup exists
  but no handlers; flag for a follow-up.
- Personalising the staff dashboard — `staff.html` is already keyed
  off `profile.full_name` and shows "Staff access only" when the
  signed-in user isn't staff, which is the right behaviour.
- Personalising the subject catalogue rows in the student dashboard
  beyond what the existing queries return. The "View all" links and
  sidebar nav (Subjects / Assignments / Progress / Past papers) are
  placeholders — not in scope here.

## Verification

After the changes:

1. **Open `login.html` in a browser**, sign in with valid credentials
   for a user that's already confirmed their email. The button shows
   "Signing in…", then the browser navigates to `dashboard.html`.
2. **Wrong password** → red error banner, button re-enabled, message
   reads "Email or password is incorrect." (or similar).
3. **Unconfirmed email** → red error banner, message reads
   "Confirm your email first — check your inbox for the link."
4. **Open `dashboard.html` while signed out** → centred
   "Sign in to see your dashboard" card, no fake streak, no fake
   name. Sidebar avatar shows "—", streak shows 0, KPIs all read "0".
5. **Open `dashboard.html` while signed in** → header reads
   "Welcome back, <first name>" (or "Welcome to Recall" if
   `full_name` is null), avatar shows the user's initials, streak bar
   reflects their actual study_sessions, KPI cards show real numbers
   from the DB queries.
6. **Open `dashboard.html` while signed in but with no enrollments**
   → "Your subjects" card reads "You're not enrolled in any subjects
   yet. Browse the catalogue to get started." (already handled by
   `renderSubjects` at dashboard.html:634–643).
7. **Sign up a brand-new account** → signup page shows the
   "Account created" success banner for 4s, then redirects to
   `dashboard.html`, which renders the signed-out state with the
   "Sign in to see your dashboard" card (because email isn't
   confirmed yet, no session exists). After clicking the email link
   and signing in, the personalised dashboard appears.
