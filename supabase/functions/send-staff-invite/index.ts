// ============================================================================
// Recall Education — Send-staff-invite Edge Function
//
// Sends a staff-invitation email to a future staff member (author,
// reviewer, or admin). Called by admin.html after the admin has created
// a pending invite via the create_staff_invite RPC.
//
// The function does NOT itself mint the token — the create_staff_invite
// RPC (SECURITY DEFINER) does that. This separation matters:
//   * The RPC is the source of truth for "who can invite whom". The
//     function is just the email-sender.
//   * If Resend is down or the function crashes, the invite is still
//     minted and the admin can re-send from the Invites panel (the
//     resend_staff_invite RPC refreshes the token and this function
//     re-invokes with the new token).
//
// Routing logic is trivial: the function takes an invite_id (returned
// by create_staff_invite), looks up the email + role + token, builds a
// link to /accept-invite.html?token=<uuid>, and emails the invitee via
// Resend. Idempotent: re-running it for the same invite reuses the
// same token (it does NOT call the RPC to refresh — that's what
// resend_staff_invite is for).
//
// Auth model: invoked with the anon key from the admin's browser. We do
// NOT trust the caller's claimed invite_id blindly — anyone with the
// function URL could call it. We only look up invites that exist
// (RLS on staff_invites blocks direct reads, but the service-role
// client bypasses RLS as it should here). The email we send to is
// exactly the one on the invite row; the caller cannot redirect it.
//
// Env vars (set with `supabase secrets set`):
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
// send-consent-email so the two emails feel like the same product.
// ----------------------------------------------------------------------------

function escapeHtml(s: string): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function layout(title: string, bodyHtml: string): string {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>
<body style="margin:0;padding:0;background:#F6F8FA;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#0D1117;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#F6F8FA;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="max-width:600px;background:#FFFFFF;border:1px solid #D0D7DE;border-radius:8px;overflow:hidden;">
        <tr><td style="background:#1F6FEB;padding:18px 24px;font-size:14px;font-weight:700;color:#FFFFFF;letter-spacing:-0.01em;">
          <span style="display:inline-block;background:#FFFFFF;color:#1F6FEB;width:22px;height:22px;line-height:22px;text-align:center;border-radius:4px;margin-right:10px;font-size:12px;font-weight:800;">R</span>
          Recall
        </td></tr>
        <tr><td style="padding:28px 24px 8px;font-size:18px;font-weight:600;color:#0D1117;letter-spacing:-0.01em;">${escapeHtml(title)}</td></tr>
        <tr><td style="padding:0 24px 24px;font-size:14px;line-height:1.55;color:#1F2328;">${bodyHtml}</td></tr>
        <tr><td style="padding:14px 24px;border-top:1px solid #D0D7DE;background:#F6F8FA;font-size:12px;color:#57606A;">
          Recall Education Ltd &middot; UK &middot; You can
          <a href="mailto:hello@recalleducation.co.uk" style="color:#1F6FEB;">unsubscribe</a>
          or update your preferences at any time.
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function ctaButton(url: string, label: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0 8px;">
    <tr><td bgcolor="#1F6FEB" style="border-radius:6px;">
      <a href="${escapeHtml(url)}" target="_blank"
         style="display:inline-block;padding:11px 20px;font-family:inherit;font-size:14px;font-weight:600;color:#FFFFFF;text-decoration:none;border-radius:6px;">
        ${escapeHtml(label)}
      </a>
    </td></tr>
  </table>
  <p style="margin:8px 0 0;font-size:12px;line-height:1.5;color:#57606A;word-break:break-all;">
    If the button doesn't work, paste this link into your browser:<br>
    <a href="${escapeHtml(url)}" style="color:#1F6FEB;">${escapeHtml(url)}</a>
  </p>`;
}

// ----------------------------------------------------------------------------
// Role-specific copy. The labels are written so the email body reads
// naturally — "join Recall as a lesson author" rather than "with role
// staff_author".
// ----------------------------------------------------------------------------

function roleLabel(role: string): string {
  switch (role) {
    case "staff_author":   return "a lesson author";
    case "staff_reviewer": return "a lesson reviewer";
    case "admin":          return "an admin";
    default:               return "a staff member";
  }
}

function roleHeading(role: string): string {
  switch (role) {
    case "staff_author":   return "You're invited to write lessons on Recall";
    case "staff_reviewer": return "You're invited to review lessons on Recall";
    case "admin":          return "You're invited to help run Recall";
    default:               return "You're invited to join Recall as staff";
  }
}

function roleBlurb(role: string): string {
  switch (role) {
    case "staff_author":
      return "As an author, you'll be able to create and edit lessons, build interactive blocks (quizzes, flashcards, free-text), and submit them for review.";
    case "staff_reviewer":
      return "As a reviewer, you'll see drafts submitted by authors and decide what gets published to students.";
    case "admin":
      return "As an admin, you'll be able to invite other staff, change roles, publish lessons, and view the audit log.";
    default:
      return "You'll get access to the Recall staff tools.";
  }
}

function staffInviteEmail(role: string, acceptUrl: string, expiresInDays: number) {
  const label = roleLabel(role);
  const heading = roleHeading(role);
  const blurb = roleBlurb(role);
  return {
    subject: `You're invited to join Recall as ${label}`,
    html: layout(
      heading,
      `<p style="margin:0 0 14px;">Hello,</p>
       <p style="margin:0 0 14px;">You've been invited to join <b>Recall</b>, a UK study app for GCSE and A-level students, as <b>${escapeHtml(label)}</b>.</p>
       <p style="margin:0 0 14px;">${escapeHtml(blurb)}</p>
       <p style="margin:0 0 14px;">This invite is personal to you and will expire in ${expiresInDays} days. After that, ask whoever sent it to resend.</p>
       ${ctaButton(acceptUrl, "Accept the invitation")}
       <p style="margin:18px 0 0;font-size:13px;color:#57606A;">If you weren't expecting this, you can safely ignore the email &mdash; nothing happens unless you click through and create an account.</p>
       <p style="margin:14px 0 0;font-size:13px;color:#57606A;">Questions? Email <a href="mailto:hello@recalleducation.co.uk" style="color:#1F6FEB;">hello@recalleducation.co.uk</a>.</p>`,
    ),
    text: `You've been invited to join Recall (a UK study app for GCSE and A-level students) as ${label}.

${blurb}

This invite is personal to you and expires in ${expiresInDays} days.

Accept the invitation:
${acceptUrl}

If you weren't expecting this, ignore the email — nothing happens unless you click through.

Questions? Email hello@recalleducation.co.uk.`,
  };
}

// ----------------------------------------------------------------------------
// Main handler
// ----------------------------------------------------------------------------

Deno.serve(async (req) => {
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

  const corsHeaders: Record<string, string> = {
    "Access-Control-Allow-Origin": req.headers.get("origin") ?? "*",
    "Vary": "Origin",
  };

  const missing = missingEnv();
  if (missing.length) {
    console.error("send-staff-invite: missing env vars:", missing.join(", "));
    return new Response("server misconfigured", { status: 500, headers: corsHeaders });
  }

  let body: { invite_id?: string; origin?: string };
  try {
    body = await req.json();
  } catch {
    return new Response("invalid json", { status: 400, headers: corsHeaders });
  }

  const { invite_id, origin } = body;
  if (!invite_id || !origin) {
    return new Response("missing required fields", { status: 400, headers: corsHeaders });
  }

  if (!/^[0-9a-f-]{36}$/i.test(invite_id)) {
    return new Response("invalid invite_id", { status: 400, headers: corsHeaders });
  }

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

  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Look up the invite. The service-role client bypasses RLS — we
  // intentionally do that here because the table is RLS-locked for
  // anon/authenticated and the only legitimate path to read an
  // invite is through this function. We do NOT verify the caller is
  // an admin (the RPC that created the invite already did), but we
  // DO gate on the invite being in 'pending' state to avoid mailing
  // a stale or already-accepted link.
  const { data: invite, error: lookupErr } = await sb
    .from("staff_invites")
    .select("id, email, role, token, status, expires_at")
    .eq("id", invite_id)
    .maybeSingle();

  if (lookupErr) {
    console.error("send-staff-invite: lookup failed:", lookupErr.message);
    return new Response("lookup failed", { status: 500, headers: corsHeaders });
  }
  if (!invite) {
    return new Response("invite not found", { status: 404, headers: corsHeaders });
  }
  if (invite.status !== "pending") {
    return new Response("invite is not pending", { status: 409, headers: corsHeaders });
  }
  if (new Date(invite.expires_at).getTime() < Date.now()) {
    return new Response("invite has expired", { status: 410, headers: corsHeaders });
  }

  const acceptUrl = `${appOrigin}/accept-invite.html?token=${encodeURIComponent(invite.token)}`;
  const tpl = staffInviteEmail(invite.role, acceptUrl, 14);

  const resend = new Resend(RESEND_API_KEY!);
  try {
    const { error } = await resend.emails.send({
      from: EMAIL_FROM,
      to: invite.email,
      subject: tpl.subject,
      html: tpl.html,
      text: tpl.text,
    });
    if (error) {
      console.error("send-staff-invite: resend failed:", error);
      return new Response("email send failed", { status: 500, headers: corsHeaders });
    }
  } catch (err) {
    console.error("send-staff-invite: resend threw:", (err as Error).message);
    return new Response("email send failed", { status: 500, headers: corsHeaders });
  }

  return Response.json({ ok: true, invite_id: invite.id }, { headers: corsHeaders });
});
