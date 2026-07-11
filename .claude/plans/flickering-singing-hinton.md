# Plan: Personalise dashboard greeting, fix email-confirm landing, add password reset

## Context

Three things to address on top of the work already done in the previous
turn (real Supabase auth in `login.html`, honest empty states on
`dashboard.html`):

1. **Dashboard greeting is generic.** It currently reads
   "Welcome back, Sarah" regardless of the time of day. You want a
   time-of-day greeting ("Good morning, Sarah!") with a small pool of
   friendly variations so it feels personal.

2. **Email confirmation feels broken.** When a new user clicks the
   confirmation link in the email, Supabase redirects them to
   `dashboard.html` (set in `signup.html:641` as the
   `emailRedirectTo`). The access token is in the URL hash. The
   supabase-js library does set the session on init via
   `detectSessionInUrl: true`, but `dashboard.html` immediately calls
   `supabaseClient.auth.getUser()` and treats "no user yet" as
   "signed out", rendering the "Sign in to see your dashboard" card.
   Net result: the user just confirmed their email, and the page
   tells them to sign in. The fix is to listen for the auth state
   change that comes from the URL hash, instead of one-shot
   `getUser()`.

3. **Password reset is a dead link.** `login.html:356` has
   `<a class="forgot" href="#">Forgot password?</a>`. You want a
   working "request a reset link" flow on the login page, plus a
   landing page where the user picks a new password after clicking
   the link in the email.

The sign-in path itself ("correct details takes you to the dashboard")
is already correct from the previous turn — no change there.

## Files to modify

- `login.html` — wire up "Forgot password?" to a real flow.
- `dashboard.html` — time-of-day greeting; listen for the
  `SIGNED_IN` event so email-link redirects land on the dashboard,
  not the signed-out card.
- `reset-password.html` — **new file**, where the user sets a new
  password after clicking the email link.
- No SQL changes. No new tables.

## Changes

### 1. `dashboard.html` — time-of-day greeting

Replace the static `"Welcome back, ${first}"` text in
`setIdentity()` (dashboard.html:745) with a small greeting picker.

```js
function pickGreeting(name) {
  const h = new Date().getHours();
  const first = (name || '').trim().split(/\s+/)[0] || 'there';
  const pools = {
    morning: [
      `Good morning, ${first}!`,
      `Morning, ${first} — let's get into it.`,
      `Top of the morning, ${first}.`,
    ],
    afternoon: [
      `Good afternoon, ${first}!`,
      `Afternoon, ${first} — ready for a session?`,
      `Hey ${first}, good to see you back.`,
    ],
    evening: [
      `Good evening, ${first}!`,
      `Evening, ${first} — a quick revision before bed?`,
      `Hey ${first}, nice to see you.`,
    ],
    night: [
      `Burning the midnight oil, ${first}?`,
      `Up late, ${first} — keep it short.`,
    ],
  };
  let bucket = 'morning';
  if (h >= 12 && h < 17)      bucket = 'afternoon';
  else if (h >= 17 && h < 24) bucket = 'evening';
  else if (h >= 0 && h < 5)   bucket = 'night';
  const pool = pools[bucket];
  // Deterministic pick keyed on the minute so it doesn't change on
  // every re-render of the same session.
  const idx = new Date().getMinutes() % pool.length;
  return pool[idx];
}
```

`setIdentity` then becomes:

```js
$('welcomeTitle').textContent = name ? pickGreeting(name) : 'Welcome to Recall';
```

`setIdentity` is also called for the signed-out case
(`setIdentity(null, null)` at line 960). When `name` is null the
title falls through to "Welcome to Recall" — fine, that's the
signed-out state which the new `renderSignedOut()` immediately
replaces anyway.

### 2. `dashboard.html` — handle the email-link redirect

The current `load()` (dashboard.html:982–1011) does a one-shot
`supabaseClient.auth.getUser()`. When the user lands on
`dashboard.html` from the email confirmation link, the session is
still being attached from the URL hash. Replace the bootstrap with
`onAuthStateChange`:

```js
let dashboardLoaded = false;
function tryLoad() {
  if (dashboardLoaded) return;
  supabaseClient.auth.getSession().then(({ data }) => {
    const session = data?.session;
    if (session?.user) {
      dashboardLoaded = true;
      loadWithUser(session.user);
    } else {
      renderSignedOut();
    }
  });
}

const { data: sub } = supabaseClient.auth.onAuthStateChange(
  (event, session) => {
    if ((event === 'SIGNED_IN' || event === 'INITIAL_SESSION') && session?.user) {
      dashboardLoaded = true;
      sub?.subscription?.unsubscribe();
      loadWithUser(session.user);
    }
  }
);

tryLoad(); // Initial paint path for users who came in with no hash.
```

Then factor the body of the existing `load()` (after the
`getUser()` early-return) into a `loadWithUser(user)` function, so
both code paths share it.

Edge case: if a user is *not* signed in and lands on
`dashboard.html`, `onAuthStateChange` won't fire and `getSession()`
will resolve with no session, so `renderSignedOut()` shows. Same
result as today.

### 3. `login.html` — "Forgot password?" form

The existing markup (login.html:351–357) is:

```html
<div class="row-between">
  <label class="check">
    <input type="checkbox" name="remember" />
    <span>Keep me signed in</span>
  </label>
  <a class="forgot" href="#">Forgot password?</a>
</div>
```

Replace the `<a>` with a button that toggles a small "Send reset
link" sub-form below the password field. The form has one email
field (prefilled from the email above if non-empty), a "Send reset
link" submit, and an inline status message. Markup shape:

```html
<div id="resetPanel" hidden style="margin: -8px 0 18px;">
  <div class="field">
    <label for="resetEmail">Your email</label>
    <input type="email" id="resetEmail" autocomplete="email" />
  </div>
  <div class="row-between" style="margin: 0;">
    <button type="button" class="btn-ghost" id="resetCancelBtn">Cancel</button>
    <button type="button" class="btn-primary" id="resetSendBtn">Send reset link</button>
  </div>
  <div class="reset-msg" id="resetMsg" hidden></div>
</div>
```

The new `reset-msg` class gets a small style block (similar tone
to the existing error banner) — green for success, red for
failure. Reuse the colour tokens already in the `:root` palette.

Behaviour:
- "Forgot password?" link toggles `resetPanel` visibility. Hides
  the form when cancelled.
- "Send reset link" calls
  `supabaseClient.auth.resetPasswordForEmail(email, { redirectTo: window.location.origin + '/reset-password.html' })`.
- On success: show "Check your inbox — we sent a reset link to
  *email*. It expires in 1 hour." (Same response shape whether
  the email exists or not — Supabase always returns 200 to avoid
  user enumeration. We do the same at the UI layer.)
- On rate-limit: "Too many requests. Wait a minute and try again."
- Disable the send button for 30 seconds after a submit to
  discourage spam.
- Sync the email field with the main login email field when
  the panel opens, so the user doesn't retype it.

### 4. `reset-password.html` — new file

Where the user lands after clicking the reset link. Structure:
- Same top nav + dark-theme CSS as `login.html` (copy the `:root`
  palette, the nav bar block, the form-card block — these are
  shared visual language, no point re-inventing).
- A card with a "Set a new password" heading.
- Two fields: new password + confirm new password. Minimum 12
  characters (matching the signup rule).
- A "Save new password" submit.
- A `#status` slot for inline messages (success → "Password
  updated — taking you to your dashboard…", error → translated
  message).

Behaviour:
- On load, listen for `onAuthStateChange`. Wait for either a
  `PASSWORD_RECOVERY` event or a `SIGNED_IN` event with a session
  (Supabase auth processes the recovery link from the URL hash
  and emits `PASSWORD_RECOVERY`). If neither fires within a few
  seconds, show "This reset link is invalid or has expired.
  [Request a new one](#)" linking back to `login.html#forgot`.
- On submit: call
  `supabaseClient.auth.updateUser({ password: newPwd })`.
- On success: 1.5-second pause showing the green status, then
  `window.location.href = 'dashboard.html'`.
- On error: show translated message, re-enable form.
- Pre-validate length and match client-side before calling
  Supabase, mirroring the signup form's password rules
  (`signup.html:344–346`).

Reuse the same Supabase client setup as the other files
(URL + anon key constants, UMD bundle, `supabaseClient`).

### 5. `signup.html` — confirm the redirect is sensible

`signup.html:641` already points `emailRedirectTo` at
`dashboard.html`, which is what we want now that the dashboard
handles the URL-hash session. No change needed.

## Existing utilities to reuse

- `escapeHtml`, `initials` (dashboard.html:572–582) — not needed
  in `reset-password.html` (it has no dynamic user content to
  render).
- `explainAuthError` translator pattern from
  `signup.html:565–584` and `login.html:409–428` — copy the same
  shape into `reset-password.html` for `updateUser` errors
  ("Password should be at least 12 characters", "Auth session
  missing", "Same password", etc.).
- Supabase client setup (CDN bundle + URL + anon key) — identical
  across `signup.html`, `login.html`, `dashboard.html`, `staff.html`.
  Use the same values.
- Dark-theme CSS — copy the `:root` palette and the form-card /
  nav block from `login.html:11–35, 51–75, 144–157` into
  `reset-password.html`. Roughly 60 lines of CSS.

## What stays out of scope

- **OAuth buttons** on `login.html` (Google / Microsoft / Apple).
  The markup exists but no handlers; flag for a follow-up.
- **Email-template customisation** in the Supabase dashboard. The
  default "Confirm signup" template is fine for now.
- **Resetting from the staff side.** The `staff.html` sign-out
  already works; staff can also use the same forgot-password flow
  if needed (they share the `auth.users` table).
- **Rate-limit handling on the sign-in form** beyond what Supabase
  already enforces. The `explainAuthError` translator surfaces
  the rate-limit message; no client-side throttling added.
- **A "first login → forced reset" path.** Supabase's
  `updateUser` works for any signed-in user; if you later want
  a "set initial password" flow for staff-provisioned accounts,
  that's a separate piece of work.

## Verification

After the changes:

1. **Time-of-day greeting.** Sign in, open `dashboard.html`.
   Between 5am–12pm the heading reads "Good morning, Sarah!" (or
   a sibling from the morning pool). Between 12–5pm it's the
   afternoon pool. Between 5pm–midnight: evening. Between
   midnight–5am: night. Refresh the page — within the same hour
   the heading is stable (deterministic on the minute).
2. **Email confirmation lands on the dashboard.** Sign up a new
   account, click the confirmation link. The browser opens
   `dashboard.html#access_token=...&type=signup`. After
   `onAuthStateChange` fires, the page renders the personalised
   dashboard (name, streak, subjects) — not the "Sign in" card.
3. **Forgot password flow.** On `login.html`, click
   "Forgot password?". A panel expands with the email field.
   Click "Send reset link". A green status reads "Check your
   inbox…". Submit again within 30s — button is disabled. After
   30s, button re-enables.
4. **Reset link works.** Click the link in the reset email.
   `reset-password.html` opens, detects the recovery session,
   shows the "Set a new password" form. Enter matching 12+
   character passwords, click save. Green status: "Password
   updated — taking you to your dashboard…", then redirect.
5. **Invalid reset link.** Open `reset-password.html` directly
   (no URL hash). After the auth-state listener times out,
   the page shows "This reset link is invalid or has expired"
   with a link back to `login.html#forgot`.
6. **Mismatched passwords in reset.** Type two different
   passwords → client-side check blocks the submit and shows
   "Passwords do not match." No Supabase call is made.
7. **Sign-in path unchanged.** Sign in on `login.html` with
   valid credentials → still navigates to `dashboard.html` (no
   regression from the previous turn).
8. **Signed-out dashboard unchanged.** Open `dashboard.html`
   with no session → still shows the "Sign in to see your
   dashboard" card with the two buttons.
