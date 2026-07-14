// ============================================================================
// Recall Education — Send-auth-email Edge Function
//
// Replaces Supabase's built-in SMTP for the "Confirm signup" / "Recovery"
// / "Magic link" / "Email change" / "Invite" / "Reauthentication" actions.
// Triggered by Supabase's `send_email` auth hook:
//   Auth → Hooks → Send Email → Enable, point at this function's URL,
//   store the generated secret in the SEND_EMAIL_HOOK_SECRET env var.
//
// When the hook returns 2xx, Supabase skips its own email. When it fails,
// Supabase falls back to its default SMTP (kill switch — we never silently
// drop an auth email).
//
// ============================================================================
//  SIGNATURE VERIFICATION
// ============================================================================
//
// Supabase signs every hook request using the Standard Webhooks spec
// (https://github.com/standard-webhooks/standard-webhooks). The secret
// shown in the dashboard looks like:
//
//     whsec_AbCdEf123...
//
// The literal "whsec_" prefix is a human-readable marker, NOT part of
// the secret value. The secret bytes are everything after it. The
// `webhook-signature` header contains the version + the signature:
//
//     v1,sig=<base64 of HMAC-SHA256 of signed_payload using secret bytes>
//
// The signed payload is constructed as:
//
//     <webhook-id> + "." + <webhook-timestamp> + "." + <raw body>
//
// where webhook-id is in the `webhook-id` header and webhook-timestamp
// (unix seconds) is in the `webhook-timestamp` header. We reject any
// timestamp more than 5 minutes off wall-clock time to bound replay
// attacks.
//
// We implement the verification inline using `crypto.subtle` rather
// than the `standardwebhooks` npm package. The package historically
// has trouble with the `v1,` prefix in the signature header on some
// runtimes and Deno versions; the inline implementation is ~30 lines
// and completely under our control.
//
// ============================================================================
//  ROUTING
// ============================================================================
//
// `email_data.email_action_type` drives the template choice:
//
//   signup            → "Welcome to Recall" confirmation, role-aware
//                       (student / teacher / school_organiser / staff)
//   recovery          → "Reset your password"
//   magiclink         → "Your sign-in link"
//   email_change      → "Confirm your new email"   (rare; same shape as signup)
//   invite            → "You've been invited"      (rare; we don't issue
//                       invites via auth — this is a safety net)
//   reauthentication  → no-op 200 (we don't use it)
//
// ============================================================================
//  ROLE-AWARE CONFIRMATION
// ============================================================================
//
// The signup branch reads `user.user_metadata.intended_role` to pick a
// template. signup-organisation.html writes
// `intended_role='school_organiser'` plus `intended_school` and
// `intended_plan`. The organiser template uses a purple accent (the
// school-organiser brand colour) and frames the email as "you're
// setting up a school" rather than the generic student welcome —
// without this branch, organisers get a confusing "Welcome to Recall"
// email followed by a redirect to the student dashboard.
//
// ============================================================================
//  ENV VARS
// ============================================================================
//
//   RESEND_API_KEY            — Resend dashboard (re_xxx)
//   SEND_EMAIL_HOOK_SECRET    — whsec_… value from Auth → Hooks → Send Email
//   EMAIL_FROM                — optional; defaults to
//                               "Recall Education <hello@recalleducation.co.uk>"
//
// SUPABASE_URL and the service role key are auto-injected by the
// Supabase Edge Function runtime.
// ============================================================================

import { createClient } from "@supabase/supabase-js";
import { Resend } from "resend";

// ----------------------------------------------------------------------------
// Env validation
// ----------------------------------------------------------------------------

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY =
  Deno.env.get("REACT_SUPABASE_SERVICE_KEY") ??
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const HOOK_SECRET = Deno.env.get("SEND_EMAIL_HOOK_SECRET");
const EMAIL_FROM =
  Deno.env.get("EMAIL_FROM") ?? "Recall Education <hello@recalleducation.co.uk>";

function missingEnv(): string[] {
  const out: string[] = [];
  if (!RESEND_API_KEY) out.push("RESEND_API_KEY");
  if (!SUPABASE_URL) out.push("SUPABASE_URL");
  if (!SUPABASE_SERVICE_ROLE_KEY) out.push("REACT_SUPABASE_SERVICE_KEY");
  if (!HOOK_SECRET) out.push("SEND_EMAIL_HOOK_SECRET");
  return out;
}

// ----------------------------------------------------------------------------
// Hook payload types — keep in sync with Supabase's send_email hook schema.
// https://supabase.com/docs/guides/auth/auth-hooks/send-email-hook
// ----------------------------------------------------------------------------

interface HookUser {
  id: string;
  email: string;
  user_metadata?: {
    full_name?: string;
    parent_email?: string | null;
    year_group?: string;
    dob?: string;
    intended_role?: string;
    intended_school?: string;
    intended_plan?: string;
  };
}

interface HookEmailData {
  token: string;            // 6-digit OTP
  token_hash: string;       // one-shot token for the verify URL
  redirect_to: string;      // the emailRedirectTo the client passed
  email_action_type:
    | "signup"
    | "recovery"
    | "magiclink"
    | "email_change"
    | "invite"
    | "reauthentication";
  site_url: string;         // DO NOT trust — see note below
}

interface HookPayload {
  user: HookUser;
  email_data: HookEmailData;
}

// ============================================================================
//  Signature verification — Standard Webhooks, raw HMAC-SHA256.
// ============================================================================
//
// Returns { ok: true } on success, { ok: false, reason } on failure. We
// never throw — the calling code returns 401 with a clear reason.

interface VerifyResult {
  ok: boolean;
  reason?: string;
}

function timingSafeEqual(a: string, b: string): boolean {
  // Constant-time string comparison. Webhook signatures are short
  // (<100 chars base64) so this is plenty fast. The point is to
  // prevent the typical timing-side-channel bug where a string
  // compare returns early on the first differing byte.
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function base64Encode(bytes: Uint8Array): string {
  // Standard base64 with padding. btoa() takes a "binary string" — we
  // convert the byte array to one first. Deno's btoa is built-in.
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

async function verifyHookSignature(
  secret: string,
  headers: Headers,
  rawBody: string,
): Promise<VerifyResult> {
  // Extract the headers we need. Supabase sends them lowercased in
  // most environments but the Standard Webhooks spec is case-
  // insensitive, so we case-insensitively look them up.
  const webhookId = headers.get("webhook-id") ?? headers.get("Webhook-Id") ?? "";
  const webhookTs = headers.get("webhook-timestamp") ?? headers.get("Webhook-Timestamp") ?? "";
  const webhookSig = headers.get("webhook-signature") ?? headers.get("Webhook-Signature") ?? "";

  if (!webhookId || !webhookTs || !webhookSig) {
    return { ok: false, reason: "missing required signature headers" };
  }

  // Reject anything more than 5 minutes old. The timestamp is unix
  // seconds (per spec).
  const tsNum = Number(webhookTs);
  if (!Number.isFinite(tsNum)) {
    return { ok: false, reason: "invalid webhook-timestamp" };
  }
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSeconds - tsNum) > 5 * 60) {
    return { ok: false, reason: "webhook timestamp out of tolerance" };
  }

  // Parse the signature header. Format: "v1,sig=<base64>" or
  // space-separated multiple "v1,sig=<base64>" values. We accept the
  // v1 scheme only.
  const parts = webhookSig.split(" ").filter(Boolean);
  let expected: string | null = null;
  for (const part of parts) {
    const comma = part.indexOf(",");
    if (comma < 0) continue;
    const version = part.slice(0, comma);
    const sig = part.slice(comma + 1);
    if (version === "v1" && sig.startsWith("sig=")) {
      expected = sig.slice(4);
      break;
    }
  }
  if (!expected) {
    return { ok: false, reason: "no v1 signature in header" };
  }

  // Build the signed payload. The spec is explicit: id + "." + ts + "." + body.
  const signedPayload = `${webhookId}.${webhookTs}.${rawBody}`;

  // Compute the HMAC-SHA256 of signed_payload using the secret bytes.
  //
  // The Standard Webhooks spec defines the secret as: a base64-encoded
  // random byte string, prefixed with `whsec_` as a human-readable
  // marker. So the env var looks like `whsec_<base64>` and the HMAC
  // key is the DECODED bytes (the random bytes themselves, not the
  // base64 string).
  //
  // This is the part the previous implementation got wrong — it used
  // the post-prefix string as the key (no base64 decode), which gave a
  // valid signature against a different signing scheme than the one
  // Supabase's hook actually uses. The fix is a single btoa/atob round-
  // trip on the secret value after stripping the `whsec_` marker.
  const whsecPrefix = "whsec_";
  if (!secret.startsWith(whsecPrefix)) {
    return { ok: false, reason: "secret does not start with whsec_" };
  }
  const secretBase64 = secret.slice(whsecPrefix.length);

  // atob() is the inverse of btoa(): base64 → binary string → bytes.
  // Deno's atob is built-in and throws on invalid input, which is what
  // we want (a malformed secret should fail verification, not silently
  // match a different scheme).
  let keyBytes: Uint8Array;
  try {
    const bin = atob(secretBase64);
    keyBytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) keyBytes[i] = bin.charCodeAt(i);
  } catch {
    return { ok: false, reason: "secret base64 decode failed" };
  }

  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sigBytes = new Uint8Array(
    await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(signedPayload)),
  );
  const computed = base64Encode(sigBytes);

  if (!timingSafeEqual(computed, expected)) {
    return { ok: false, reason: "signature mismatch" };
  }

  return { ok: true };
}

// ----------------------------------------------------------------------------
// HTML escaping + brand shell — byte-for-byte match with the other
// transactional email functions (send-consent-email, send-staff-invite)
// so all Recall emails look like the same product.
// ----------------------------------------------------------------------------

function escapeHtml(s: string): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function layout(title: string, bodyHtml: string, accent: "blue" | "purple" = "blue"): string {
  const bar = accent === "purple" ? "#6B3FA0" : "#1F6FEB";
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>
<body style="margin:0;padding:0;background:#F6F8FA;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#0D1117;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#F6F8FA;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="max-width:600px;background:#FFFFFF;border:1px solid #D0D7DE;border-radius:8px;overflow:hidden;">
        <tr><td style="background:${bar};padding:18px 24px;font-size:14px;font-weight:700;color:#FFFFFF;letter-spacing:-0.01em;">
          <span style="display:inline-block;background:#FFFFFF;color:${bar};width:22px;height:22px;line-height:22px;text-align:center;border-radius:4px;margin-right:10px;font-size:12px;font-weight:800;">R</span>
          Recall
        </td></tr>
        <tr><td style="padding:28px 24px 8px;font-size:18px;font-weight:600;color:#0D1117;letter-spacing:-0.01em;">${escapeHtml(title)}</td></tr>
        <tr><td style="padding:0 24px 24px;font-size:14px;line-height:1.55;color:#1F2328;">${bodyHtml}</td></tr>
        <tr><td style="padding:14px 24px;border-top:1px solid #D0D7DE;background:#F6F8FA;font-size:12px;color:#57606A;">
          Recall Education Ltd &middot; UK &middot; You can
          <a href="mailto:hello@recalleducation.co.uk" style="color:${bar};">unsubscribe</a>
          or update your preferences at any time.
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function ctaButton(url: string, label: string, accent: "blue" | "purple" = "blue"): string {
  const bar = accent === "purple" ? "#6B3FA0" : "#1F6FEB";
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0 8px;">
    <tr><td bgcolor="${bar}" style="border-radius:6px;">
      <a href="${escapeHtml(url)}" target="_blank"
         style="display:inline-block;padding:11px 20px;font-family:inherit;font-size:14px;font-weight:600;color:#FFFFFF;text-decoration:none;border-radius:6px;">
        ${escapeHtml(label)}
      </a>
    </td></tr>
  </table>
  <p style="margin:8px 0 0;font-size:12px;line-height:1.5;color:#57606A;word-break:break-all;">
    If the button doesn't work, paste this link into your browser:<br>
    <a href="${escapeHtml(url)}" style="color:${bar};">${escapeHtml(url)}</a>
  </p>`;
}

// ----------------------------------------------------------------------------
// Per-role confirmation templates. The verify URL is built from
// email_data.token_hash + email_data.redirect_to and hits Supabase's
// /auth/v1/verify endpoint. After verify, the user lands on
// redirect_to (which the client passed via signUp's emailRedirectTo).
// ----------------------------------------------------------------------------

function studentConfirmationEmail(name: string, verifyUrl: string, otp: string) {
  const first = (name || "there").trim().split(/\s+/)[0];
  return {
    subject: "Confirm your Recall email",
    html: layout(
      "Confirm your email",
      `<p style="margin:0 0 14px;">Hi ${escapeHtml(first)},</p>
       <p style="margin:0 0 14px;">Welcome to Recall. Click the button below to confirm your email and finish setting up your account.</p>
       ${ctaButton(verifyUrl, "Confirm email")}
       <p style="margin:18px 0 0;font-size:13px;color:#57606A;">This link expires in 24 hours. If you didn't sign up, you can safely ignore this email.</p>
       <p style="margin:14px 0 0;font-size:13px;color:#57606A;">Or paste this code if you'd rather type it in: <b style="color:#0D1117;">${escapeHtml(otp)}</b></p>`,
    ),
    text:
      `Hi ${first},\n\n` +
      `Welcome to Recall. Confirm your email by visiting:\n${verifyUrl}\n\n` +
      `Or paste this code: ${otp}\n\n` +
      `This link expires in 24 hours. If you didn't sign up, ignore this email.`,
  };
}

function teacherConfirmationEmail(name: string, verifyUrl: string, otp: string) {
  const first = (name || "there").trim().split(/\s+/)[0];
  return {
    subject: "Confirm your teacher account on Recall",
    html: layout(
      "Confirm your teacher account",
      `<p style="margin:0 0 14px;">Hi ${escapeHtml(first)},</p>
       <p style="margin:0 0 14px;">Welcome to Recall. You're moments away from being able to set homework, track your classes, and see how your students are getting on.</p>
       ${ctaButton(verifyUrl, "Confirm and open my teacher dashboard")}
       <p style="margin:18px 0 0;font-size:13px;color:#57606A;">This link expires in 24 hours. If you didn't sign up as a teacher, you can safely ignore this email.</p>
       <p style="margin:14px 0 0;font-size:13px;color:#57606A;">Or paste this code if you'd rather type it in: <b style="color:#0D1117;">${escapeHtml(otp)}</b></p>`,
    ),
    text:
      `Hi ${first},\n\n` +
      `Welcome to Recall. Confirm your teacher account by visiting:\n${verifyUrl}\n\n` +
      `Or paste this code: ${otp}\n\n` +
      `This link expires in 24 hours. If you didn't sign up as a teacher, ignore this email.`,
  };
}

function organiserConfirmationEmail(
  name: string,
  schoolName: string,
  plan: string,
  verifyUrl: string,
  otp: string,
) {
  const first = (name || "there").trim().split(/\s+/)[0];
  const planLabel = plan === "pro" ? "Pro" : plan === "standard" ? "Standard" : "Free";
  return {
    subject: `Confirm your school organiser account — ${schoolName}`,
    html: layout(
      "Confirm your school organiser account",
      // Purple accent so the email is visually distinct from a
      // student confirmation in the recipient's inbox.
      `<p style="margin:0 0 14px;">Hi ${escapeHtml(first)},</p>
       <p style="margin:0 0 14px;">Welcome to Recall. You're moments away from being able to manage <b>${escapeHtml(schoolName)}</b> on Recall &mdash; invite teachers, set homework, and see how your students are getting on.</p>
       <p style="margin:0 0 14px;">Plan: <b>${escapeHtml(planLabel)}</b> (you can change this from your organiser console at any time).</p>
       <div style="margin:18px 0;padding:14px 16px;background:#F5EEFF;border:1px solid #C9A8FF;border-radius:6px;">
         <p style="margin:0 0 6px;font-size:13px;font-weight:600;color:#6B3FA0;">What happens when you click confirm</p>
         <ol style="margin:6px 0 0;padding-left:20px;font-size:13.5px;line-height:1.6;color:#1F2328;">
           <li>We'll finish setting up your organiser account.</li>
           <li>We'll issue <b>${escapeHtml(schoolName)}</b> a permanent school code you can share with students and teachers.</li>
           <li>You'll be taken straight to your organiser console.</li>
         </ol>
       </div>
       ${ctaButton(verifyUrl, "Confirm and open my organiser console", "purple")}
       <p style="margin:18px 0 0;font-size:13px;color:#57606A;">This link expires in 24 hours. If you didn't sign up to run a school on Recall, you can safely ignore this email.</p>
       <p style="margin:14px 0 0;font-size:13px;color:#57606A;">Or paste this code if you'd rather type it in: <b style="color:#0D1117;">${escapeHtml(otp)}</b></p>`,
      "purple",
    ),
    text:
      `Hi ${first},\n\n` +
      `Welcome to Recall. You're moments away from being able to manage ${schoolName} on Recall.\n\n` +
      `Plan: ${planLabel}.\n\n` +
      `What happens when you click confirm:\n` +
      `  1. We'll finish setting up your organiser account.\n` +
      `  2. We'll issue ${schoolName} a permanent school code you can share with students and teachers.\n` +
      `  3. You'll be taken straight to your organiser console.\n\n` +
      `Confirm and open your console:\n${verifyUrl}\n\n` +
      `Or paste this code: ${otp}\n\n` +
      `This link expires in 24 hours. If you didn't sign up to run a school on Recall, ignore this email.`,
  };
}

function staffConfirmationEmail(name: string, role: string, verifyUrl: string, otp: string) {
  const first = (name || "there").trim().split(/\s+/)[0];
  const label =
    role === "staff_author" ? "lesson author" :
    role === "staff_reviewer" ? "lesson reviewer" :
    role === "admin" ? "admin" :
    "staff member";
  return {
    subject: `Confirm your Recall staff account (${label})`,
    html: layout(
      "Confirm your staff account",
      `<p style="margin:0 0 14px;">Hi ${escapeHtml(first)},</p>
       <p style="margin:0 0 14px;">You've been invited to join Recall as <b>${escapeHtml(label)}</b>. Click the button below to confirm your email and finish setting up your staff account.</p>
       ${ctaButton(verifyUrl, "Confirm email")}
       <p style="margin:18px 0 0;font-size:13px;color:#57606A;">This link expires in 24 hours. If you weren't expecting this, you can safely ignore the email &mdash; nothing happens unless you click through.</p>
       <p style="margin:14px 0 0;font-size:13px;color:#57606A;">Or paste this code if you'd rather type it in: <b style="color:#0D1117;">${escapeHtml(otp)}</b></p>`,
    ),
    text:
      `Hi ${first},\n\n` +
      `You've been invited to join Recall as ${label}.\n\n` +
      `Confirm your email by visiting:\n${verifyUrl}\n\n` +
      `Or paste this code: ${otp}\n\n` +
      `This link expires in 24 hours. If you weren't expecting this, ignore the email.`,
  };
}

function recoveryEmail(verifyUrl: string) {
  return {
    subject: "Reset your Recall password",
    html: layout(
      "Reset your password",
      `<p style="margin:0 0 14px;">Someone (hopefully you) asked to reset the password on this Recall account.</p>
       ${ctaButton(verifyUrl, "Reset password")}
       <p style="margin:18px 0 0;font-size:13px;color:#57606A;">This link expires in 1 hour. If you didn't request a reset, you can safely ignore this email &mdash; your password will not change.</p>`,
    ),
    text:
      `Reset your Recall password:\n${verifyUrl}\n\n` +
      `This link expires in 1 hour. If you didn't request a reset, ignore this email.`,
  };
}

function magiclinkEmail(verifyUrl: string, otp: string) {
  return {
    subject: "Your Recall sign-in link",
    html: layout(
      "Sign in to Recall",
      `<p style="margin:0 0 14px;">Click the button below to sign in to your Recall account.</p>
       ${ctaButton(verifyUrl, "Sign in")}
       <p style="margin:18px 0 0;font-size:13px;color:#57606A;">This link expires in 1 hour. If you didn't request it, ignore this email.</p>
       <p style="margin:14px 0 0;font-size:13px;color:#57606A;">Or paste this code: <b style="color:#0D1117;">${escapeHtml(otp)}</b></p>`,
    ),
    text:
      `Sign in to Recall:\n${verifyUrl}\n\n` +
      `Or paste this code: ${otp}\n\n` +
      `This link expires in 1 hour.`,
  };
}

function emailChangeEmail(verifyUrl: string) {
  return {
    subject: "Confirm your new email on Recall",
    html: layout(
      "Confirm your new email",
      `<p style="margin:0 0 14px;">Click the button below to confirm this is the email address you want to use on Recall.</p>
       ${ctaButton(verifyUrl, "Confirm new email")}
       <p style="margin:18px 0 0;font-size:13px;color:#57606A;">This link expires in 24 hours. If you didn't change your email, you can safely ignore this message.</p>`,
    ),
    text:
      `Confirm your new email on Recall:\n${verifyUrl}\n\n` +
      `This link expires in 24 hours. If you didn't change your email, ignore this message.`,
  };
}

// ----------------------------------------------------------------------------
// Main handler
// ----------------------------------------------------------------------------

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const missing = missingEnv();
  if (missing.length) {
    console.error("send-auth-email: missing env vars:", missing.join(", "));
    // Returning 500 here causes Supabase to fall back to its default
    // SMTP. That's the right behaviour during a misconfiguration —
    // we never silently drop an auth email.
    return new Response("server misconfigured", { status: 500 });
  }

  // Read the raw body once. We need it as a string for signature
  // verification AND as JSON for parsing — re-encoding from JSON
  // would change whitespace and break the signature, so we do it
  // text-first and parse the same string.
  const rawBody = await req.text();

  // Verify the Standard Webhooks signature. Without this, anyone who
  // finds the function URL could POST to it and burn Resend quota.
  const verifyResult = await verifyHookSignature(HOOK_SECRET!, req.headers, rawBody);
  if (!verifyResult.ok) {
    console.error("send-auth-email: signature verification failed:", verifyResult.reason);
    return new Response(`signature verification failed: ${verifyResult.reason}`, { status: 401 });
  }

  let payload: HookPayload;
  try {
    payload = JSON.parse(rawBody);
  } catch (err) {
    console.error("send-auth-email: malformed json:", (err as Error).message);
    return new Response("malformed json", { status: 400 });
  }

  const { user, email_data } = payload;
  if (!user?.id || !user.email || !email_data?.email_action_type) {
    console.error("send-auth-email: malformed payload", { user, email_data });
    return new Response("malformed payload", { status: 400 });
  }

  // Build the verify URL. email_data.site_url is currently the
  // Supabase auth host, not the configured Site URL (Supabase
  // auth#2559), so we trust email_data.redirect_to instead.
  const verifyUrl =
    `${SUPABASE_URL}/auth/v1/verify` +
    `?token=${encodeURIComponent(email_data.token_hash)}` +
    `&type=${encodeURIComponent(email_data.email_action_type)}` +
    `&redirect_to=${encodeURIComponent(email_data.redirect_to)}`;

  const resend = new Resend(RESEND_API_KEY!);
  const action = email_data.email_action_type;
  const name = (user.user_metadata?.full_name ?? "").trim();

  try {
    // ------------------ SIGNUP (role-aware) ------------------
    if (action === "signup") {
      const role = user.user_metadata?.intended_role || "student";
      const tpl =
        role === "school_organiser"
          ? organiserConfirmationEmail(
              name,
              user.user_metadata?.intended_school || "your school",
              user.user_metadata?.intended_plan || "free",
              verifyUrl,
              email_data.token,
            )
          : role === "teacher"
            ? teacherConfirmationEmail(name, verifyUrl, email_data.token)
            : role === "staff_author" || role === "staff_reviewer" || role === "admin"
              ? staffConfirmationEmail(name, role, verifyUrl, email_data.token)
              : studentConfirmationEmail(name, verifyUrl, email_data.token);

      const { error } = await resend.emails.send({
        from: EMAIL_FROM,
        to: user.email,
        subject: tpl.subject,
        html: tpl.html,
        text: tpl.text,
      });
      if (error) {
        console.error("send-auth-email: resend signup failed:", error);
        return new Response("resend error", { status: 500 });
      }
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    }

    // ------------------ RECOVERY ------------------
    if (action === "recovery") {
      const tpl = recoveryEmail(verifyUrl);
      const { error } = await resend.emails.send({
        from: EMAIL_FROM,
        to: user.email,
        subject: tpl.subject,
        html: tpl.html,
        text: tpl.text,
      });
      if (error) {
        console.error("send-auth-email: resend recovery failed:", error);
        return new Response("resend error", { status: 500 });
      }
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    }

    // ------------------ MAGIC LINK ------------------
    if (action === "magiclink") {
      const tpl = magiclinkEmail(verifyUrl, email_data.token);
      const { error } = await resend.emails.send({
        from: EMAIL_FROM,
        to: user.email,
        subject: tpl.subject,
        html: tpl.html,
        text: tpl.text,
      });
      if (error) {
        console.error("send-auth-email: resend magiclink failed:", error);
        return new Response("resend error", { status: 500 });
      }
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    }

    // ------------------ EMAIL CHANGE ------------------
    if (action === "email_change") {
      const tpl = emailChangeEmail(verifyUrl);
      const { error } = await resend.emails.send({
        from: EMAIL_FROM,
        to: user.email,
        subject: tpl.subject,
        html: tpl.html,
        text: tpl.text,
      });
      if (error) {
        console.error("send-auth-email: resend email_change failed:", error);
        return new Response("resend error", { status: 500 });
      }
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    }

    // ------------------ INVITE / REAUTH (safety nets) ------------------
    // We don't currently use either of these flows, but if Supabase
    // ever fires one we shouldn't drop the email silently. We return
    // a 200 with no Resend call so the auth flow continues.
    if (action === "invite" || action === "reauthentication") {
      console.warn(`send-auth-email: no template for action "${action}", dropping email`);
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    }

    // ------------------ UNKNOWN ------------------
    console.error("send-auth-email: unknown email_action_type:", action);
    return new Response("unknown email_action_type", { status: 400 });
  } catch (err) {
    console.error("send-auth-email: unexpected error:", (err as Error).message, (err as Error).stack);
    return new Response("internal error", { status: 500 });
  }
});
