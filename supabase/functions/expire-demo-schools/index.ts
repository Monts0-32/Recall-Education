// ============================================================================
// Recall Education — Expire-demo-schools Edge Function
//
// Demo schools (created by create-demo-school on the "Try the demo" button)
// live for 15 minutes. This function:
//
//   1. ALWAYS: deletes every demo school past its TTL — the school row
//      (school_id FKs cascade: classes, assignments, announcements,
//      timetable, praise, clubs, register…) and every attached auth user
//      (organiser, teachers, students; profiles cascade from auth.users).
//      Invoked every minute by pg_cron so deletion happens even when
//      nobody is visiting, and by the banner script at countdown zero.
//
//   2. If the caller is signed in: reports whether THEIR school is a demo
//      school and when it expires, so every page can show the countdown
//      banner (db-config.js). The caller's uid is read from the JWT
//      supabase-js `functions.invoke` attaches automatically; the lookup
//      itself runs with the service role.
//
// REQUEST: POST, body {}. Callable anonymously (cron / signed-out users).
//
// RESPONSE:
//   200 { ok:true, expired:{schools,users},
//         demo: { school_name, expires_at } | null }   // demo = caller's school
//   500 { ok:false, reason }
// ============================================================================

import { createClient } from "@supabase/supabase-js";
import { cleanupExpiredDemoSchools, callerDemoSchool } from "../_shared/demo-expiry.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY =
  Deno.env.get("REACT_SUPABASE_SERVICE_KEY") ??
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

/** Best-effort JWT payload decode — no signature verification, which is
 *  fine here: the extracted uid is only used for a read-only lookup that
 *  the service role could do for anyone anyway. */
function jwtSub(auth: string | null): string | null {
  if (!auth || !auth.startsWith("Bearer ")) return null;
  const token = auth.slice(7);
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const payload = JSON.parse(atob(b64));
    return typeof payload?.sub === "string" ? payload.sub : null;
  } catch {
    return null;
  }
}

Deno.serve(async (req) => {
  // CORS preflight — same block as create-demo-school.
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": req.headers.get("origin") ?? "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers":
          "authorization, content-type, x-client-info, apikey",
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
  const jsonHeaders = { ...corsHeaders, "Content-Type": "application/json" };

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error("expire-demo-schools: missing env vars");
    return new Response(JSON.stringify({ ok: false, reason: "server_misconfigured" }), {
      status: 500,
      headers: jsonHeaders,
    });
  }

  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // 1) Cleanup — always runs, errors here are the only failure mode.
  let expired: { schools: number; users: number };
  try {
    expired = await cleanupExpiredDemoSchools(sb);
  } catch (err) {
    const reason = err instanceof Error ? err.message : "cleanup_failed";
    console.error("expire-demo-schools: cleanup failed:", reason);
    return new Response(JSON.stringify({ ok: false, reason }), {
      status: 500,
      headers: jsonHeaders,
    });
  }

  // 2) Status for the caller, if they're signed in. Failures here degrade
  //    to demo:null — cleanup must never fail because the status lookup
  //    hiccuped.
  let demo: { school_name: string; expires_at: string } | null = null;
  const uid = jwtSub(req.headers.get("authorization"));
  if (uid) {
    try {
      demo = await callerDemoSchool(sb, uid);
    } catch (err) {
      console.error("expire-demo-schools: status lookup failed:", err);
    }
  }

  return new Response(JSON.stringify({ ok: true, expired, demo }), {
    status: 200,
    headers: jsonHeaders,
  });
});