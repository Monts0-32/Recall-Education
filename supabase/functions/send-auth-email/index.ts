// ============================================================================
// Recall Education — Send-auth-email Edge Function
//
// Replaces Supabase's built-in SMTP for the "Confirm email", "Recovery",
// and "Magic link" actions. Triggered by Supabase's `send_email` auth hook:
//   Auth → Hooks → Send Email → Enable, point at this function's URL,
//   store the generated secret in the SEND_EMAIL_HOOK_SECRET env var.
//
// When the hook returns 2xx, Supabase skips its own email. When it fails,
// Supabase falls back to its default SMTP (kill switch).
//
// Routing is by `email_data.email_action_type`:
//   signup     → student confirmation (and parent consent request, if under 16)
//   recovery   → password reset
//   magiclink  → sign-in link
//   others     → 200 no-op (we don't use email_change / invite / reauthentication)
//
// The `email_data.token_hash` is the one-shot token Supabase generated; the
// URL the user clicks is the Supabase /auth/v1/verify endpoint with
// redirect_to pointing at /auth/confirmed.html (or /reset-password.html for
// recovery). The Edge Function does NOT construct the URL from
// `email_data.site_url` — that field is currently populated from the Supabase
// auth host, not the configured Site URL (Supabase auth#2559).
//
// Env vars (set with `supabase secrets set`):
//   RESEND_API_KEY         — Resend dashboard
//   SUPABASE_URL           — https://hkjiyibpeqdoqzlyqzwz.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY — needed to read/write parental_consents
//   SEND_EMAIL_HOOK_SECRET — the v1,whsec_… secret the hook dashboard gives you
//   EMAIL_FROM             — optional override; defaults to
//                            "Recall Education <hello@recalleducation.co.uk>"
// ============================================================================

import { Webhook } from "standardwebhooks";
import { createClient } from "@supabase/supabase-js";
import { Resend } from "resend";

// ----------------------------------------------------------------------------
// Types — keep in sync with Supabase's send_email hook payload schema.
// ----------------------------------------------------------------------------

interface HookUser {
  id: string;
  email: string;
  user_metadata?: {
    full_name?: string;
    parent_email?: string | null;
    year_group?: string;
    dob?: string;
  };
}

interface HookEmailData {
  token: string;            // 6-digit OTP, used as a text fallback
  token_hash: string;       // for the verify URL
  redirect_to: string;      // the emailRedirectTo the client passed
  email_action_type:
    | "signup"
    | "recovery"
    | "magiclink"
    | "email_change"
    | "invite"
    | "reauthentication";
  site_url: string;         // DO NOT trust — see file header
}

interface HookPayload {
  user: HookUser;
  email_data: HookEmailData;
}

// ----------------------------------------------------------------------------
// Env validation
// ----------------------------------------------------------------------------

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const HOOK_SECRET = Deno.env.get("SEND_EMAIL_HOOK_SECRET");
const EMAIL_FROM =
  Deno.env.get("EMAIL_FROM") ?? "Recall Education <hello@recalleducation.co.uk>";

function missingEnv(): string[] {
  const out: string[] = [];
  if (!RESEND_API_KEY) out.push("RESEND_API_KEY");
  if (!SUPABASE_URL) out.push("SUPABASE_URL");
  if (!SUPABASE_SERVICE_ROLE_KEY) out.push("SUPABASE_SERVICE_ROLE_KEY");
  if (!HOOK_SECRET) out.push("SEND_EMAIL_HOOK_SECRET");
  return out;
}

// ----------------------------------------------------------------------------
// Email templates — inline-styled HTML, no <style> blocks. Resend strips
// them in some clients, and Outlook desktop ignores them entirely.
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
  // Single-column, 600px, dark-on-light (most email clients render better
  // when the body is white and the brand colour is in a top bar). We use the
  // same palette as the website so the email looks like it came from us.
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
          Recall Education Ltd · UK · You can
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
// Per-template builders
// ----------------------------------------------------------------------------

function confirmationEmail(name: string, verifyUrl: string, otp: string) {
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
    text: `Hi ${first},\n\nWelcome to Recall. Confirm your email by visiting:\n${verifyUrl}\n\nOr paste this code: ${otp}\n\nThis link expires in 24 hours. If you didn't sign up, ignore this email.`,
  };
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
       <p style="margin:18px 0 0;font-size:13px;color:#57606A;">If this wasn't your child, you can safely ignore this email — no account will be activated.</p>
       <p style="margin:14px 0 0;font-size:13px;color:#57606A;">Questions? Email <a href="mailto:hello@recalleducation.co.uk" style="color:#1F6FEB;">hello@recalleducation.co.uk</a>. You can withdraw consent at any time and we will delete the account.</p>`,
    ),
    text: `${studentName} has signed up for Recall, a UK study app.\n\nUK law requires a parent or guardian to consent before a child under 16 can use the product.\n\nReview and decide:\n${consentUrl}\n\nIf this wasn't your child, ignore this email — no account will be activated.\n\nQuestions? Email hello@recalleducation.co.uk.`,
  };
}

function recoveryEmail(verifyUrl: string) {
  return {
    subject: "Reset your Recall password",
    html: layout(
      "Reset your password",
      `<p style="margin:0 0 14px;">Someone (hopefully you) asked to reset the password on this Recall account.</p>
       ${ctaButton(verifyUrl, "Reset password")}
       <p style="margin:18px 0 0;font-size:13px;color:#57606A;">This link expires in 1 hour. If you didn't request a reset, you can safely ignore this email — your password will not change.</p>`,
    ),
    text: `Reset your Recall password:\n${verifyUrl}\n\nThis link expires in 1 hour. If you didn't request a reset, ignore this email.`,
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
    text: `Sign in to Recall:\n${verifyUrl}\n\nOr paste this code: ${otp}\n\nThis link expires in 1 hour.`,
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
  // Reuse an existing pending row if one exists, otherwise create one.
  // The Edge Function uses the service role so RLS is bypassed.
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
    console.error("send-auth-email: missing env vars:", missing.join(", "));
    // Returning 500 here will cause Supabase to fall back to its default SMTP.
    // That's the right behaviour during a misconfiguration.
    return new Response("server misconfigured", { status: 500 });
  }

  // 1. Verify the Standard Webhooks signature. Without this, anyone who
  //    finds the function URL could POST to it and burn Resend quota.
  let payload: HookPayload;
  try {
    const wh = new Webhook(HOOK_SECRET!);
    const raw = await req.text();
    const headers: Record<string, string> = {};
    req.headers.forEach((v, k) => { headers[k] = v; });
    payload = wh.verify(raw, headers) as HookPayload;
  } catch (err) {
    console.error("send-auth-email: signature verification failed:", (err as Error).message);
    return new Response("invalid signature", { status: 401 });
  }

  const { user, email_data } = payload;
  if (!user?.id || !user.email || !email_data?.email_action_type) {
    console.error("send-auth-email: malformed payload", { user, email_data });
    return new Response("malformed payload", { status: 400 });
  }

  // 2. Build the verify URL. email_data.site_url is currently the Supabase
  //    auth host, not the configured Site URL (Supabase auth#2559), so we
  //    prepend the auth host ourselves and trust email_data.redirect_to.
  const verifyUrl =
    `${SUPABASE_URL}/auth/v1/verify` +
    `?token=${encodeURIComponent(email_data.token_hash)}` +
    `&type=${encodeURIComponent(email_data.email_action_type)}` +
    `&redirect_to=${encodeURIComponent(email_data.redirect_to)}`;

  const resend = new Resend(RESEND_API_KEY!);
  const sb = createClient(SUPABASE_URL!, SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const action = email_data.email_action_type;
  const studentName = (user.user_metadata?.full_name ?? "").trim() || "there";

  try {
    // ------------------ SIGNUP ------------------
    if (action === "signup") {
      const tpl = confirmationEmail(studentName, verifyUrl, email_data.token);
      const { error } = await resend.emails.send({
        from: EMAIL_FROM,
        to: user.email,
        subject: tpl.subject,
        html: tpl.html,
        text: tpl.text,
      });
      if (error) {
        console.error("send-auth-email: resend signup failed:", error);
        // Return 500 → Supabase falls back to its SMTP, so the user still
        // gets the confirmation email.
        return new Response("resend error", { status: 500 });
      }

      // For under-16s, also email the parent a consent request.
      const parentEmail = (user.user_metadata?.parent_email ?? "").trim();
      if (parentEmail) {
        const token = await ensureConsentToken(sb, user.id, parentEmail);
        if (token) {
          // Build the consent URL relative to the app origin. The redirect_to
          // for signup is the app's auth/confirmed.html — derive the app
          // origin from it so the consent URL matches the site the parent
          // saw during signup.
          let appOrigin: string;
          try {
            appOrigin = new URL(email_data.redirect_to).origin;
          } catch {
            appOrigin = new URL(verifyUrl).origin; // last-resort fallback
          }
          const consentUrl = `${appOrigin}/consent.html?token=${encodeURIComponent(token)}`;

          const ptpl = parentConsentEmail(studentName, consentUrl);
          const { error: perr } = await resend.emails.send({
            from: EMAIL_FROM,
            to: parentEmail,
            subject: ptpl.subject,
            html: ptpl.html,
            text: ptpl.text,
          });
          if (perr) {
            // Non-fatal: student confirmation went out. The student can
            // re-trigger a parent email later (future "Resend consent"
            // feature). Log and continue.
            console.error("send-auth-email: resend parent failed:", perr);
          }
        } else {
          console.error("send-auth-email: could not create/find consent token for", user.id);
        }
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

    // ------------------ OTHER ACTIONS (no-op) ------------------
    // We don't use email_change / invite / reauthentication, so do nothing.
    return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
  } catch (err) {
    console.error("send-auth-email: unexpected error:", (err as Error).message, (err as Error).stack);
    return new Response("internal error", { status: 500 });
  }
});
