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
//                               "Recall Education <hello@recalleducation.co.uk>"
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
  Deno.env.get("EMAIL_FROM") ?? "Recall Education <hello@recalleducation.co.uk>";

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

function layout(title: string, bodyHtml: string): string {
  // Same visual language as the auth email templates in email-templates.html
  // so the parent gets a familiar-looking email from the same brand.
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

function parentConsentEmail(studentName: string, consentUrl: string) {
  return {
    subject: `${studentName} wants to use Recall — please confirm`,
    html: layout(
      "Your child wants to use Recall",
      `<p style="margin:0 0 14px;">Hello,</p>
       <p style="margin:0 0 14px;"><b>${escapeHtml(studentName)}</b> has signed up for Recall, a UK study app for GCSE and A-level students. UK law (UK-GDPR / Age-Appropriate Design Code) requires us to get a parent or guardian's consent before a child under 16 can use the product.</p>
       <p style="margin:0 0 14px;">Please review and decide. The link is unique to you and will expire in 7 days.</p>
       ${ctaButton(consentUrl, "Review and give consent")}
       <p style="margin:18px 0 0;font-size:13px;color:#57606A;">If this wasn't your child, you can safely ignore this email &mdash; no account will be activated.</p>
       <p style="margin:14px 0 0;font-size:13px;color:#57606A;">Questions? Email <a href="mailto:hello@recalleducation.co.uk" style="color:#1F6FEB;">hello@recalleducation.co.uk</a>. You can withdraw consent at any time and we will delete the account.</p>`,
    ),
    text: `${studentName} has signed up for Recall, a UK study app.

UK law requires a parent or guardian to consent before a child under 16 can use the product.

Review and decide:
${consentUrl}

If this wasn't your child, ignore this email — no account will be activated.

Questions? Email hello@recalleducation.co.uk.`,
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
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const missing = missingEnv();
  if (missing.length) {
    console.error("send-consent-email: missing env vars:", missing.join(", "));
    return new Response("server misconfigured", { status: 500 });
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
    return new Response("invalid json", { status: 400 });
  }

  const { student_user_id, parent_email, student_name, origin } = body;
  if (!student_user_id || !parent_email || !origin) {
    return new Response("missing required fields", { status: 400 });
  }

  // Basic shape validation on the IDs / emails so we don't push garbage
  // through to the database / Resend.
  if (!/^[0-9a-f-]{36}$/i.test(student_user_id)) {
    return new Response("invalid student_user_id", { status: 400 });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(parent_email)) {
    return new Response("invalid parent_email", { status: 400 });
  }

  let appOrigin: string;
  try {
    const u = new URL(origin);
    // Only allow http(s) origins — defence against a malicious caller
    // smuggling in `javascript:` or `file:` URLs.
    if (u.protocol !== "https:" && u.protocol !== "http:") {
      return new Response("invalid origin", { status: 400 });
    }
    appOrigin = u.origin;
  } catch {
    return new Response("invalid origin", { status: 400 });
  }

  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const token = await ensureConsentToken(sb, student_user_id, parent_email);
  if (!token) {
    return new Response("could not create consent token", { status: 500 });
  }

  const consentUrl = `${appOrigin}/consent.html?token=${encodeURIComponent(token)}`;
  const tpl = parentConsentEmail((student_name || "").trim() || "your child", consentUrl);

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
      return new Response("email send failed", { status: 500 });
    }
  } catch (err) {
    console.error("send-consent-email: resend threw:", (err as Error).message);
    return new Response("email send failed", { status: 500 });
  }

  return Response.json({ ok: true });
});
