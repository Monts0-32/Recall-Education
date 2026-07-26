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
//  WHY THIS FUNCTION EXISTS
// ============================================================================
//
// Supabase's built-in "Confirm signup" email is generic ("Welcome to
// Recall" with a stock template) and its subject is hardcoded — there's
// no way to role-branch the template from the dashboard. For school
// organisers specifically, the stock email is actively confusing
// (it reads as "welcome, student" when the recipient just signed up
// to run a school).
//
// This function sends a SECOND, branded email. The user will receive
// two emails per signup — Supabase's stock one and this one. That's
// intentional: the user wants Supabase's confirmation flow to stay
// active (it gates password sign-in via email_confirmed_at), and the
// Resend email is the one that visually communicates "you signed up
// to do X" rather than a generic "confirm your email".
//
// ============================================================================
//  EARLIER APPROACHES THAT DIDN'T STICK
// ============================================================================
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
// ============================================================================
//  HOW THE LINK WORKS
// ============================================================================
//
// The link this function sends is a magic link minted by
// `admin.generateLink({ type: 'magiclink' })`. When clicked:
//
//   - Verifies the OTP against auth.users (this is the "confirmation"
//     step — same as the built-in email flow, just delivered differently)
//   - Sets up a session for the user
//   - Redirects to redirect_to (the emailRedirectTo the client passed
//     to signUp)
//
// Magic links sign the user in but DON'T set email_confirmed_at. To
// make sure the user can also sign in with their password later, the
// /auth/confirmed*.html pages call a confirm_my_email() RPC after the
// session is established.
//
// ============================================================================
//  ROUTING
// ============================================================================
//
// `intended_role` in the request body picks the template:
//
//   school_organiser → "set up your school" email with school name +
//                      plan in the body
//   teacher          → "Welcome, teacher" with class-management framing
//   staff_author / staff_reviewer / admin → "Welcome to the team"
//   (default)        → generic "Welcome to Recall" for students
//
// All four templates share the same brand shell — see `layout()` below.
// The role is communicated in the subject and body, not by varying the
// shell colours.
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
//                               "Recall Education <support@recalleducation.co.uk>"
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
  Deno.env.get("EMAIL_FROM") ?? "Recall Education <support@recalleducation.co.uk>";

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

// Brand shell. Mirrors /email-templates.html: dark #1A1D22 background,
// #232629 card, #2A2E33 hairline, teal #56D4DD for bubbles + accent,
// white pill CTA with a teal halo. Logo is fetched from
// `${logoBase}/logo.png` so the `<img>` resolves for email clients.
// The earlier "purple-accent for school organisers" branch is dropped
// — the role is communicated in the subject and body, and the unified
// dark shell is the brief.
function layout(title: string, bodyHtml: string, logoBase: string): string {
  const logoUrl = `${logoBase}/logo.png`;
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>
<body style="margin:0;padding:0;background:#1A1D22;font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#F5F7FA;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#1A1D22;">
    <tr><td align="center" style="padding:32px 12px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center">
        <tr>
          <td valign="top" align="center" style="width:90px;padding:0 6px;">
            <div style="width:120px;height:120px;border-radius:50%;background:radial-gradient(circle at 30% 28%, rgba(86,212,221,0.55), rgba(86,212,221,0.10));margin-bottom:30px;font-size:1px;line-height:1px;">&nbsp;</div>
            <div style="width:50px;height:50px;border-radius:50%;background:radial-gradient(circle at 30% 28%, rgba(124,224,232,0.50), rgba(86,212,221,0.12));font-size:1px;line-height:1px;">&nbsp;</div>
          </td>
          <td valign="top" align="center">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="max-width:600px;background:#232629;border:1px solid #2A2E33;border-radius:18px;overflow:hidden;box-shadow:0 8px 24px rgba(0,0,0,0.22);">
              <tr><td style="padding:16px 20px;background:#FFFFFF;border-bottom:1px solid #2A2E33;">
                <img src="${escapeHtml(logoUrl)}" alt="Recall" width="28" height="28" style="display:inline-block;width:28px;height:28px;border-radius:6px;margin-right:10px;vertical-align:middle;background:#56D4DD;">
                <span style="font-family:'Inter',sans-serif;font-size:14px;font-weight:700;color:#0B0D0F;letter-spacing:-0.01em;vertical-align:middle;">Recall</span>
              </td></tr>
              <tr><td style="padding:28px 24px 8px;font-family:'Inter',sans-serif;font-size:18px;font-weight:600;color:#F5F7FA;letter-spacing:-0.01em;">${escapeHtml(title)}</td></tr>
              <tr><td style="padding:0 24px 24px;font-family:'Inter',sans-serif;font-size:14px;line-height:1.55;color:#C9D1D9;">${bodyHtml}</td></tr>
              <tr><td style="padding:14px 24px;border-top:1px solid #2A2E33;background:#1A1D22;font-family:'Inter',sans-serif;font-size:12px;color:#6B7280;">
                Recall Education Ltd &middot; UK &middot;
                <a href="mailto:support@recalleducation.co.uk" style="color:#7CE0E8;">Contact us</a>
              </td></tr>
            </table>
          </td>
          <td valign="top" align="center" style="width:90px;padding:0 6px;">
            <div style="width:60px;height:60px;border-radius:50%;background:radial-gradient(circle at 30% 28%, rgba(86,212,221,0.55), rgba(86,212,221,0.12));margin-bottom:24px;font-size:1px;line-height:1px;">&nbsp;</div>
            <div style="width:80px;height:80px;border-radius:50%;background:radial-gradient(circle at 30% 28%, rgba(216,177,74,0.45), rgba(216,177,74,0.10));font-size:1px;line-height:1px;">&nbsp;</div>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

// White pill CTA with a soft teal halo. Same look as the auth templates
// — dark card + bright button so the link catches the eye first.
function ctaButton(url: string, label: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0 8px;">
    <tr><td style="border-radius:999px;background:#FFFFFF;box-shadow:0 4px 18px rgba(255,255,255,0.06),0 0 32px rgba(86,212,221,0.22);">
      <a href="${escapeHtml(url)}" target="_blank"
         style="display:inline-block;padding:11px 22px;font-family:'Inter',sans-serif;font-size:14px;font-weight:600;color:#0B0D0F;text-decoration:none;border-radius:999px;">
        ${escapeHtml(label)}
      </a>
    </td></tr>
  </table>
  <p style="margin:8px 0 0;font-size:12px;line-height:1.5;color:#9098A4;word-break:break-all;">
    If the button doesn't work, paste this link into your browser:<br>
    <a href="${escapeHtml(url)}" style="color:#7CE0E8;">${escapeHtml(url)}</a>
  </p>`;
}

// ----------------------------------------------------------------------------
// Per-role templates. The link is the action_link returned by
// admin.generateLink — Supabase verifies the OTP and redirects the
// user to redirect_to with a fresh session.
// ----------------------------------------------------------------------------

function studentConfirmationEmail(name: string, link: string, logoBase: string) {
  const first = (name || "there").trim().split(/\s+/)[0];
  return {
    subject: "Confirm your Recall email",
    html: layout(
      "Confirm your email",
      `<p style="margin:0 0 14px;">Hi ${escapeHtml(first)},</p>
       <p style="margin:0 0 14px;">Welcome to Recall. Click the button below to confirm your email and finish setting up your account.</p>
       ${ctaButton(link, "Confirm email")}
       <p style="margin:18px 0 0;font-size:13px;color:#9098A4;">This link expires in 1 hour. If you didn't sign up, you can safely ignore this email.</p>`,
      logoBase,
    ),
    text:
      `Hi ${first},\n\n` +
      `Welcome to Recall. Confirm your email by visiting:\n${link}\n\n` +
      `This link expires in 1 hour. If you didn't sign up, ignore this email.`,
  };
}

function teacherConfirmationEmail(name: string, link: string, logoBase: string) {
  const first = (name || "there").trim().split(/\s+/)[0];
  return {
    subject: "Confirm your teacher account on Recall",
    html: layout(
      "Confirm your teacher account",
      `<p style="margin:0 0 14px;">Hi ${escapeHtml(first)},</p>
       <p style="margin:0 0 14px;">Welcome to Recall. You're moments away from being able to set homework, track your classes, and see how your students are getting on.</p>
       ${ctaButton(link, "Confirm and open my teacher dashboard")}
       <p style="margin:18px 0 0;font-size:13px;color:#9098A4;">This link expires in 1 hour. If you didn't sign up as a teacher, you can safely ignore this email.</p>`,
      logoBase,
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
  logoBase: string,
) {
  const first = (name || "there").trim().split(/\s+/)[0];
  const planLabel = plan === "pro" ? "Pro" : plan === "standard" ? "Standard" : "Free";
  return {
    subject: `Confirm your school organiser account — ${schoolName}`,
    html: layout(
      "Confirm your school organiser account",
      `<p style="margin:0 0 14px;">Hi ${escapeHtml(first)},</p>
       <p style="margin:0 0 14px;">Welcome to Recall. You're moments away from being able to manage <b>${escapeHtml(schoolName)}</b> on Recall &mdash; invite teachers, set homework, and see how your students are getting on.</p>
       <p style="margin:0 0 14px;">Plan: <b>${escapeHtml(planLabel)}</b> (you can change this from your organiser console at any time).</p>
       <div style="margin:18px 0;padding:14px 16px;background:rgba(86,212,221,0.10);border:1px solid rgba(86,212,221,0.40);border-radius:8px;">
         <p style="margin:0 0 6px;font-family:'Inter',sans-serif;font-size:13px;font-weight:600;color:#7CE0E8;">What happens when you click confirm</p>
         <ol style="margin:6px 0 0;padding-left:20px;font-size:13.5px;line-height:1.6;color:#C9D1D9;">
           <li>We'll finish setting up your organiser account.</li>
           <li>We'll issue <b>${escapeHtml(schoolName)}</b> a permanent school code you can share with students and teachers.</li>
           <li>You'll be taken straight to your organiser console.</li>
         </ol>
       </div>
       ${ctaButton(link, "Confirm and open my organiser console")}
       <p style="margin:18px 0 0;font-size:13px;color:#9098A4;">This link expires in 1 hour. If you didn't sign up to run a school on Recall, you can safely ignore this email.</p>`,
      logoBase,
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

function staffConfirmationEmail(name: string, role: string, link: string, logoBase: string) {
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
       <p style="margin:18px 0 0;font-size:13px;color:#9098A4;">This link expires in 1 hour. If you weren't expecting this, you can safely ignore the email &mdash; nothing happens unless you click through.</p>`,
      logoBase,
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
          appOrigin,
        )
      : role === "teacher"
        ? teacherConfirmationEmail(name || "", actionLink, appOrigin)
        : role === "staff_author" || role === "staff_reviewer" || role === "admin"
          ? staffConfirmationEmail(name || "", role, actionLink, appOrigin)
          : studentConfirmationEmail(name || "", actionLink, appOrigin);

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
