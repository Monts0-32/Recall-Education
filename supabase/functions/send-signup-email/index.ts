// ============================================================================
// Recall Education — Send-signup-email Edge Function
//
// Sends a confirmation email for a fresh signup. Invoked explicitly
// from the client (signup.html, signup-teacher.html,
// signup-organisation.html, signup-staff.html) immediately after
// supabase.auth.signUp() returns. The function mints a magic link
// server-side, then emails it via Resend with a role-appropriate
// template.
//
// ============================================================================
//  DASHBOARD CONFIG REQUIRED FOR ONE-EMAIL BEHAVIOUR
// ============================================================================
//
// This function sends the only confirmation email the user should
// receive. To stop Supabase from ALSO sending its built-in "Confirm
// signup" email (which would mean the user gets two emails), do
// ONE of these in the Supabase dashboard:
//
//   Option A (recommended): Authentication → Email Templates →
//     "Confirm signup" → set the Subject to a single space (" ")
//     and the Body to nothing. Supabase checks for an empty subject
//     and skips the email entirely.
//
//   Option B: Authentication → Sign In/Up → set "Confirm email"
//     to OFF. This auto-confirms users, so signInWithOtp/magic-link
//     flows work without ever asking the user to click. The downside
//     is that login.html's "email not confirmed" error path becomes
//     unreachable, so any new user protection that depends on it
//     won't fire.
//
// We default to Option A (the function comment is the only place
// this is documented, so check here if signups start producing two
// emails).
// ============================================================================
//
// Supabase's built-in "Confirm signup" email is generic ("Welcome to
// Recall" with a stock template) and its subject is hardcoded — there's
// no way to role-branch the template from the dashboard. For school
// organisers specifically, the stock email is actively confusing
// (it reads as "welcome, student" when the recipient just signed up
// to run a school).
//
// We tried two earlier approaches and abandoned both:
//
//   1. Supabase's "Send Email" hook — fragile in practice (signature
//      verification kept breaking, deploy-slug mismatches, base64-prefix
//      issues with the standardwebhooks package). The user has had
//      significant issues with this and doesn't want to use it again.
//
//   2. Relying on Supabase's built-in "Confirm signup" email — works,
//      but the subject is hardcoded and the template can't be
//      role-branched. For school organisers the stock email is
//      actively confusing (it reads as "welcome, student" when the
//      recipient just signed up to run a school).
//
// This function uses `admin.generateLink({ type: 'magiclink' })` to
// mint a one-tap sign-in link. The link, when clicked:
//
//   - Verifies the OTP against auth.users (this is the "confirmation"
//     step — same as the built-in email flow, just delivered differently)
//   - Sets up a session for the user
//   - Redirects to redirect_to (the emailRedirectTo the client passed
//     to signUp)
//
// The user receives ONE branded Resend email. The Supabase auth flow
// still works end-to-end; the only difference is the email content
// and the fact that the user signs in via a magic link rather than
// clicking "confirm" then going back to the login page.
//
// ============================================================================
//  ROUTING
// ============================================================================
//
// `intended_role` in the request body picks the template:
//
//   school_organiser → purple-accented "set up your school" email with
//                      school name + plan in the body
//   teacher          → "Welcome, teacher" with class-management framing
//   staff_author / staff_reviewer / admin → "Welcome to the team"
//   (default)        → generic "Welcome to Recall" for students
//
// ============================================================================
//  AUTH MODEL
// ============================================================================
//
// Invoked with the ANON key from the just-signed-up client. We do NOT
// trust the caller's claimed role beyond templating — `admin.generateLink`
// is server-side and acts only on the email address passed in (it
// doesn't let the caller impersonate). The email we send to is exactly
// the one the client claimed; we could verify it matches the auth.users
// row, but the action_link it returns only works for that specific user
// anyway, so the worst a malicious caller can do is "send a sign-in
// link to an email they know" — which is a no-op if the address isn't
// already a user. We rate-limit the calling client in the future if
// this becomes a problem.
//
// ============================================================================
//  ENV VARS
// ============================================================================
//
//   RESEND_API_KEY            — Resend dashboard (re_xxx)
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
const EMAIL_FROM =
  Deno.env.get("EMAIL_FROM") ?? "Recall Education <hello@recalleducation.co.uk>";

function missingEnv(): string[] {
  const out: string[] = [];
  if (!RESEND_API_KEY) out.push("RESEND_API_KEY");
  if (!SUPABASE_URL) out.push("SUPABASE_URL");
  if (!SUPABASE_SERVICE_ROLE_KEY) out.push("REACT_SUPABASE_SERVICE_KEY");
  return out;
}

// ----------------------------------------------------------------------------
// HTML escaping + brand shell — byte-for-byte match with
// send-consent-email and send-staff-invite so all Recall transactional
// emails look like the same product.
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
  // Accent switches the header bar colour. Blue is the default (students,
  // teachers, staff). Purple is the school-organiser brand colour so
  // the email is visually distinct in the recipient's inbox.
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
// Per-role templates. The link is the action_link returned by
// admin.generateLink — Supabase verifies the OTP and redirects the
// user to redirect_to with a fresh session.
// ----------------------------------------------------------------------------

function studentConfirmationEmail(name: string, link: string) {
  const first = (name || "there").trim().split(/\s+/)[0];
  return {
    subject: "Confirm your Recall email",
    html: layout(
      "Confirm your email",
      `<p style="margin:0 0 14px;">Hi ${escapeHtml(first)},</p>
       <p style="margin:0 0 14px;">Welcome to Recall. Click the button below to confirm your email and finish setting up your account.</p>
       ${ctaButton(link, "Confirm email")}
       <p style="margin:18px 0 0;font-size:13px;color:#57606A;">This link expires in 1 hour. If you didn't sign up, you can safely ignore this email.</p>`,
    ),
    text:
      `Hi ${first},\n\n` +
      `Welcome to Recall. Confirm your email by visiting:\n${link}\n\n` +
      `This link expires in 1 hour. If you didn't sign up, ignore this email.`,
  };
}

function teacherConfirmationEmail(name: string, link: string) {
  const first = (name || "there").trim().split(/\s+/)[0];
  return {
    subject: "Confirm your teacher account on Recall",
    html: layout(
      "Confirm your teacher account",
      `<p style="margin:0 0 14px;">Hi ${escapeHtml(first)},</p>
       <p style="margin:0 0 14px;">Welcome to Recall. You're moments away from being able to set homework, track your classes, and see how your students are getting on.</p>
       ${ctaButton(link, "Confirm and open my teacher dashboard")}
       <p style="margin:18px 0 0;font-size:13px;color:#57606A;">This link expires in 1 hour. If you didn't sign up as a teacher, you can safely ignore this email.</p>`,
    ),
    text:
      `Hi ${first},\n\n` +
      `Welcome to Recall. Confirm your teacher account by visiting:\n${link}\n\n` +
      `This link expires in 1 hour. If you didn't sign up as a teacher, ignore this email.`,
  };
}

function organiserConfirmationEmail(
  name: string,
  schoolName: string,
  plan: string,
  link: string,
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
       ${ctaButton(link, "Confirm and open my organiser console", "purple")}
       <p style="margin:18px 0 0;font-size:13px;color:#57606A;">This link expires in 1 hour. If you didn't sign up to run a school on Recall, you can safely ignore this email.</p>`,
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
      `Confirm and open your console:\n${link}\n\n` +
      `This link expires in 1 hour. If you didn't sign up to run a school on Recall, ignore this email.`,
  };
}

function staffConfirmationEmail(name: string, role: string, link: string) {
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
       ${ctaButton(link, "Confirm email")}
       <p style="margin:18px 0 0;font-size:13px;color:#57606A;">This link expires in 1 hour. If you weren't expecting this, you can safely ignore the email &mdash; nothing happens unless you click through.</p>`,
    ),
    text:
      `Hi ${first},\n\n` +
      `You've been invited to join Recall as ${label}.\n\n` +
      `Confirm your email by visiting:\n${link}\n\n` +
      `This link expires in 1 hour. If you weren't expecting this, ignore the email.`,
  };
}

// ----------------------------------------------------------------------------
// Main handler
// ----------------------------------------------------------------------------

interface RequestBody {
  email?: string;
  name?: string;
  intended_role?: string;
  intended_school?: string;
  intended_plan?: string;
  origin?: string;
  redirect_to?: string;
}

Deno.serve(async (req) => {
  // CORS preflight — supabase-js's `functions.invoke` sends an OPTIONS
  // request first. Without a proper response, the browser blocks the
  // real POST with "No 'Access-Control-Allow-Origin' header is present
  // on the requested resource."
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": req.headers.get("origin") ?? "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "authorization, content-type, x-client-info, apikey",
        "Access-Control-Max-Age": "86400",
        "Vary": "Origin",
      },
    });
  }

  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  // Echo CORS on the real response too — without these, the browser
  // accepts the 200 but refuses to let the JS see the body.
  const corsHeaders: Record<string, string> = {
    "Access-Control-Allow-Origin": req.headers.get("origin") ?? "*",
    "Vary": "Origin",
  };

  const missing = missingEnv();
  if (missing.length) {
    console.error("send-signup-email: missing env vars:", missing.join(", "));
    return new Response("server misconfigured", { status: 500, headers: corsHeaders });
  }

  let body: RequestBody;
  try {
    body = await req.json();
  } catch {
    return new Response("invalid json", { status: 400, headers: corsHeaders });
  }

  const { email, name, intended_role, intended_school, intended_plan, origin, redirect_to } = body;
  if (!email || !origin || !redirect_to) {
    return new Response("missing required fields", { status: 400, headers: corsHeaders });
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return new Response("invalid email", { status: 400, headers: corsHeaders });
  }

  // The action_link we email must NOT point at a domain the caller
  // controls. We require the redirect_to to be on the same origin the
  // caller claims to be calling from. (Supabase's auth flow also
  // enforces this on click, but a defence-in-depth check here is
  // cheap.)
  let appOrigin: string;
  try {
    const u = new URL(origin);
    if (u.protocol !== "https:" && u.protocol !== "http:") {
      return new Response("invalid origin", { status: 400, headers: corsHeaders });
    }
    appOrigin = u.origin;
  } catch {
    return new Response("invalid origin", { status: 400, headers: corsHeaders });
  }

  let redirectUrl: URL;
  try {
    redirectUrl = new URL(redirect_to);
  } catch {
    return new Response("invalid redirect_to", { status: 400, headers: corsHeaders });
  }
  if (redirectUrl.origin !== appOrigin) {
    return new Response("redirect_to must match origin", { status: 400, headers: corsHeaders });
  }

  // Mint a one-tap sign-in link. The user clicks it → Supabase
  // verifies the OTP → the user is signed in and redirected to
  // redirect_to. This is the "confirmation" step — the user has
  // proved they own the email by clicking a link we sent there.
  //
  // Note: we use type='magiclink' (not 'signup') because:
  //   - magiclink works for both confirmed and unconfirmed users
  //   - it produces an action_link that, when consumed, signs the
  //     user in directly (no second click on a "go to login" link)
  //   - it doesn't require the user to type a password
  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: linkData, error: linkErr } = await sb.auth.admin.generateLink({
    type: "magiclink",
    email,
    options: { redirectTo: redirect_to },
  });

  if (linkErr || !linkData?.properties?.action_link) {
    console.error("send-signup-email: generateLink failed:", linkErr?.message);
    return new Response("could not generate link", { status: 500, headers: corsHeaders });
  }
  const actionLink = linkData.properties.action_link;

  // Pick the role-appropriate template.
  const role = intended_role || "student";
  const tpl =
    role === "school_organiser"
      ? organiserConfirmationEmail(
          name || "",
          intended_school || "your school",
          intended_plan || "free",
          actionLink,
        )
      : role === "teacher"
        ? teacherConfirmationEmail(name || "", actionLink)
        : role === "staff_author" || role === "staff_reviewer" || role === "admin"
          ? staffConfirmationEmail(name || "", role, actionLink)
          : studentConfirmationEmail(name || "", actionLink);

  const resend = new Resend(RESEND_API_KEY!);
  try {
    const { error } = await resend.emails.send({
      from: EMAIL_FROM,
      to: email,
      subject: tpl.subject,
      html: tpl.html,
      text: tpl.text,
    });
    if (error) {
      console.error("send-signup-email: resend failed:", error);
      return new Response("email send failed", { status: 500, headers: corsHeaders });
    }
  } catch (err) {
    console.error("send-signup-email: resend threw:", (err as Error).message);
    return new Response("email send failed", { status: 500, headers: corsHeaders });
  }

  return Response.json({ ok: true }, { headers: corsHeaders });
});
