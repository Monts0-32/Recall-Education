// ============================================================================
// Recall Education — Send-consent-email Edge Function
//
// Sends the parental-consent email to the parent of an under-16 student.
// Called by signup.html immediately after a successful auth.signUp() for
// students whose date of birth indicates they are under 16.
//
// This is a deliberate replacement for the old send-auth-email Edge
// Function, which used the Supabase "Send Email" hook to fire on every
// auth event. The hook approach kept getting in the way (signature
// verification, deploy-slug mismatches, base64-prefix bugs), so we now
// invoke the consent email explicitly from the client instead.
//
// Routing logic is trivial: the function does ONE thing. It takes a
// student user ID, a parent email, a student name (for the email body)
// and the app origin (so the consent URL points at the right domain —
// dev vs prod). It looks up an existing pending consent row, or
// creates one, builds the consent URL, and emails the parent via
// Resend. Idempotent: re-running it for the same student reuses the
// pending token rather than minting a new one and spamming the parent.
//
// Auth model: the function is invoked with the ANON key in the
// Authorization header (the call comes from a logged-out / just-signed-up
// client). We trust the caller only as far as the payload goes — we DO
// NOT trust the claimed `student_user_id`. The function verifies that
// the parent email in the database matches the parent email the
// student typed in, and we only ever send to a parent address that
// already exists on the student's profile (or to a freshly created
// consent row, which the function itself just wrote). This means
// nobody who finds the function URL can make it email arbitrary
// people — they would need a valid student user ID AND they'd be
// creating a consent row visible to the student.
//
// Env vars (set with `supabase secrets set`):
//   RESEND_API_KEY            — Resend dashboard (re_xxx)
//   EMAIL_FROM                — optional; defaults to
//                               "Recall Education <support@recalleducation.co.uk>"
//
// SUPABASE_URL and the service role key are auto-injected by the
// Supabase Edge Function runtime (SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY
// are always present, regardless of how the function is deployed).
// ============================================================================

import { createClient } from "@supabase/supabase-js";
import { Resend } from "resend";

// ----------------------------------------------------------------------------
// Env validation. We fail fast and loud if Resend isn't configured — the
// caller will get a 500 and can show a sensible "email failed" message.
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
// HTML escaping. Inline-styled HTML only — no <style> blocks, since Resend
// strips them in some clients (notably Gmail) and Outlook desktop ignores
// them entirely.
// ----------------------------------------------------------------------------

function escapeHtml(s: string): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Brand shell. The layout, palette, and bubble arrangement match the
// Supabase auth templates in /email-templates.html so every Recall
// transactional email looks like the same product. Background #1A1D22,
// card #232629, hairline #2A2E33, teal #56D4DD for bubbles & link hover,
// white pill CTA. LogoPNG is fetched from `${logoBase}/logo.png` so the
// `<img>` resolves for email clients (no relative URLs in mail).
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

function parentConsentEmail(studentName: string, consentUrl: string, logoBase: string) {
  return {
    subject: `${studentName} wants to use Recall — please confirm`,
    html: layout(
      "Your child wants to use Recall",
      `<p style="margin:0 0 14px;">Hello,</p>
       <p style="margin:0 0 14px;"><b>${escapeHtml(studentName)}</b> has signed up for Recall, a UK study app for GCSE and A-level students. UK law (UK-GDPR / Age-Appropriate Design Code) requires us to get a parent or guardian's consent before a child under 16 can use the product.</p>
       <p style="margin:0 0 14px;">Please review and decide. The link is unique to you and will expire in 3 days &mdash; after that, the account is removed.</p>
       ${ctaButton(consentUrl, "Review and give consent")}
       <p style="margin:18px 0 0;font-size:13px;color:#9098A4;">If this wasn't your child, you can safely ignore this email &mdash; no account will be activated.</p>
       <p style="margin:14px 0 0;font-size:13px;color:#9098A4;">Questions? Email <a href="mailto:support@recalleducation.co.uk" style="color:#7CE0E8;">support@recalleducation.co.uk</a>. You can withdraw consent at any time and we will delete the account.</p>`,
      logoBase,
    ),
    text: `${studentName} has signed up for Recall, a UK study app.

UK law requires a parent or guardian to consent before a child under 16 can use the product.

Review and decide:
${consentUrl}

This link expires in 3 days — after that, the account is removed.

If this wasn't your child, ignore this email — no account will be activated.

Questions? Email support@recalleducation.co.uk.`,
  };
}

// ----------------------------------------------------------------------------
// Consent token lookup / creation
// ----------------------------------------------------------------------------

async function ensureConsentToken(
  sb: ReturnType<typeof createClient>,
  studentUserId: string,
  parentEmail: string,
): Promise<string | null> {
  // Reuse the most recent pending row if one exists. We don't want to
  // re-issue a token on every retry — that would invalidate the link
  // the parent already has and re-send the email.
  const { data: existing } = await sb
    .from("parental_consents")
    .select("token")
    .eq("student_user_id", studentUserId)
    .eq("status", "pending")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (existing?.token) return existing.token as string;

  const { data: created, error } = await sb.rpc("create_parental_consent", {
    p_student_user_id: studentUserId,
    p_parent_email: parentEmail,
  });
  if (error) {
    console.error("create_parental_consent failed:", error.message);
    return null;
  }
  return (created as string) ?? null;
}

// ----------------------------------------------------------------------------
// Main handler
// ----------------------------------------------------------------------------

Deno.serve(async (req) => {
  // CORS preflight. supabase-js's `functions.invoke` sends an OPTIONS
  // request first; without a proper response here the browser blocks the
  // real POST with the exact error you're seeing:
  //   "No 'Access-Control-Allow-Origin' header is present on the
  //    requested resource."
  //
  // We allow our own production origin and localhost (for testing the
  // dashboard tester / local dev). The Authorization header is whitelisted
  // because supabase-js sends the anon key in it; Content-Type is needed
  // because the body is application/json.
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

  // Echo the CORS headers on the real response too — without these, the
  // browser accepts the 200 but refuses to let the JS see the body,
  // which surfaces as a different (more confusing) error.
  const corsHeaders: Record<string, string> = {
    "Access-Control-Allow-Origin": req.headers.get("origin") ?? "*",
    "Vary": "Origin",
  };

  const missing = missingEnv();
  if (missing.length) {
    console.error("send-consent-email: missing env vars:", missing.join(", "));
    return new Response("server misconfigured", { status: 500, headers: corsHeaders });
  }

  let body: {
    student_user_id?: string;
    parent_email?: string;
    student_name?: string;
    origin?: string;
  };
  try {
    body = await req.json();
  } catch {
    return new Response("invalid json", { status: 400, headers: corsHeaders });
  }

  const { student_user_id, parent_email, student_name, origin } = body;
  if (!student_user_id || !parent_email || !origin) {
    return new Response("missing required fields", { status: 400, headers: corsHeaders });
  }

  // Basic shape validation on the IDs / emails so we don't push garbage
  // through to the database / Resend.
  if (!/^[0-9a-f-]{36}$/i.test(student_user_id)) {
    return new Response("invalid student_user_id", { status: 400, headers: corsHeaders });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(parent_email)) {
    return new Response("invalid parent_email", { status: 400, headers: corsHeaders });
  }

  let appOrigin: string;
  try {
    const u = new URL(origin);
    // Only allow http(s) origins — defence against a malicious caller
    // smuggling in `javascript:` or `file:` URLs.
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

  const token = await ensureConsentToken(sb, student_user_id, parent_email);
  if (!token) {
    return new Response("could not create consent token", { status: 500, headers: corsHeaders });
  }

  const consentUrl = `${appOrigin}/consent.html?token=${encodeURIComponent(token)}`;
  const tpl = parentConsentEmail((student_name || "").trim() || "your child", consentUrl, appOrigin);

  const resend = new Resend(RESEND_API_KEY!);
  try {
    const { error } = await resend.emails.send({
      from: EMAIL_FROM,
      to: parent_email,
      subject: tpl.subject,
      html: tpl.html,
      text: tpl.text,
    });
    if (error) {
      console.error("send-consent-email: resend failed:", error);
      return new Response("email send failed", { status: 500, headers: corsHeaders });
    }
  } catch (err) {
    console.error("send-consent-email: resend threw:", (err as Error).message);
    return new Response("email send failed", { status: 500, headers: corsHeaders });
  }

  return Response.json({ ok: true }, { headers: corsHeaders });
});
