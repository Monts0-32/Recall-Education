// ============================================================================
// Recall Education — Create-demo-school Edge Function
//
// One click on "Try the demo instead" (signup-organisation.html) provisions
// a complete throwaway demo school: 1 organiser, 2 teachers, 5 students,
// and enough seeded content (classes, homework, announcements, timetable,
// praise, register, clubs, enrollments) that every dashboard looks alive.
//
// ============================================================================
//  WHY THIS FUNCTION EXISTS
// ============================================================================
//
// Email confirmation is ON, and the demo accounts use fake mailboxes that
// can never receive a confirmation link. The only way to create *usable*
// accounts is therefore the service-role path
// `admin.createUser({ email_confirm: true })` — the same pattern
// send-signup-email uses for staff invites. All the profile/school wiring
// is done by the existing `handle_new_user` trigger, which fires for
// admin.createUser exactly as it does for client signUp:
//
//   organiser: intended_role='school_organiser' + intended_school (name)
//              + intended_plan → creates the schools row (SCH-code) itself
//   teacher:   intended_school_id → role='teacher' + school_id
//   student:   intended_school_code + year_group, NO dob key →
//              requires_parental_consent=false, consent_status='not_required'
//              (passes the check_parental_consent sign-in hook)
//
// No SQL migration is needed. Demo *content* is inserted directly into the
// tables with the service role — the create_assignment-style RPCs gate on
// auth.uid() and return not_authenticated for the service role, but direct
// inserts bypass RLS and are read back fine by the SECURITY DEFINER
// student/teacher RPCs.
//
// ============================================================================
//  REQUEST / RESPONSE
// ============================================================================
//
//   POST, body {} (invoked with the anon key via functions.invoke — the
//   abuse guard below is the only caller validation).
//
//   200 { ok:true,
//         school: { id, name, code },
//         expires_at, expires_in_minutes,  // demo self-deletes after this
//         password,                     // shared by all 8 demo accounts
//         accounts: [ {role,label,name,email,user_id,dashboard} × 8 ] }
//   429 { ok:false, reason:'demo_rate_limited' }
//   500 { ok:false, reason:'<step>: <msg>' }   — after best-effort cleanup
//
// Demo schools live for DEMO_TTL_MINUTES (see _shared/demo-expiry.ts):
// expire-demo-schools reaps them via pg_cron and this function sweeps any
// stragglers before applying its abuse guard.
//
// On any failure partway through, everything created so far is torn down
// (delete the school row — school_id FKs cascade — then deleteUser each
// created auth user) so a retry starts from a clean slate.
//
// ============================================================================
//  ABUSE GUARD
// ============================================================================
//
// Anonymous callers can mint real auth users and table rows, so the first
// thing we do is count demo schools created in the last hour; at >=10 the
// function returns 429 and creates nothing. Each demo school costs ~8
// auth users + ~50 rows, so the ceiling keeps a runaway script from
// filling the project while leaving plenty of headroom for real visitors.
//
// ============================================================================
//  ENV VARS
// ============================================================================
//
// Supabase Edge Functions auto-inject SUPABASE_URL and the service role
// key. The service key secret is deployed under the same name pair that
// send-signup-email reads (REACT_SUPABASE_SERVICE_KEY, with
// SUPABASE_SERVICE_ROLE_KEY as fallback) — no new secrets are needed.
// ============================================================================

import { createClient } from "@supabase/supabase-js";
import { DEMO_SCHOOL_PREFIX, DEMO_TTL_MINUTES, cleanupExpiredDemoSchools } from "../_shared/demo-expiry.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY =
  Deno.env.get("REACT_SUPABASE_SERVICE_KEY") ??
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// ----------------------------------------------------------------------------
// Constants
// ----------------------------------------------------------------------------

// No 0/O/1/I — unambiguous in handwriting and in the demo panel's
// monospace email addresses.
const TAG_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const DEMO_DOMAIN = "recalleducation.co.uk";
const DEMO_WINDOW_MINUTES = 60;
const DEMO_MAX_PER_WINDOW = 10;

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

function randTag(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += TAG_ALPHABET[b % TAG_ALPHABET.length];
  return out;
}

function iso(msFromNow: number): string {
  return new Date(Date.now() + msFromNow).toISOString();
}

const DAY = 24 * 60 * 60 * 1000;
const MIN = 60 * 1000;

/** Await a supabase-js call; throw `<label>: <message>` on error so the
 *  outer catch can clean up and report the failing step. */
async function must<T>(
  p: PromiseLike<{ data: T; error: { message: string } | null }>,
  label: string,
): Promise<T> {
  const { data, error } = await p;
  if (error) throw new Error(`${label}: ${error.message}`);
  return data as T;
}

Deno.serve(async (req) => {
  // CORS preflight — supabase-js's `functions.invoke` sends an OPTIONS
  // request first (same block as send-signup-email).
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

  // Echo CORS on the real response too — without these, the browser
  // accepts the 200 but refuses to let the JS see the body.
  const corsHeaders: Record<string, string> = {
    "Access-Control-Allow-Origin": req.headers.get("origin") ?? "*",
    "Vary": "Origin",
  };

  const jsonHeaders = {
    ...corsHeaders,
    "Content-Type": "application/json",
  };

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error("create-demo-school: missing env vars");
    return new Response(JSON.stringify({ ok: false, reason: "server_misconfigured" }), {
      status: 500,
      headers: jsonHeaders,
    });
  }

  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // ------------------------------------------------------------------
  // Sweep expired demos first. Demo schools live for DEMO_TTL_MINUTES
  // (pg_cron normally reaps them every minute, but self-heal here too)
  // — otherwise the abuse guard below would keep counting long-dead
  // demos until they fell out of the hour window.
  // ------------------------------------------------------------------
  try {
    await cleanupExpiredDemoSchools(sb);
  } catch (err) {
    console.error("create-demo-school: expiry sweep failed (continuing):", err);
  }

  // ------------------------------------------------------------------
  // Abuse guard — count demo schools created in the last hour.
  // ------------------------------------------------------------------
  try {
    const since = new Date(Date.now() - DEMO_WINDOW_MINUTES * MIN).toISOString();
    const { count, error: guardErr } = await sb
      .from("schools")
      .select("id", { count: "exact", head: true })
      .like("name", `${DEMO_SCHOOL_PREFIX}%`)
      .gt("created_at", since);
    if (guardErr) throw new Error(`guard: ${guardErr.message}`);
    if ((count ?? 0) >= DEMO_MAX_PER_WINDOW) {
      return new Response(
        JSON.stringify({ ok: false, reason: "demo_rate_limited" }),
        { status: 429, headers: jsonHeaders },
      );
    }
  } catch (err) {
    return new Response(
      JSON.stringify({ ok: false, reason: err instanceof Error ? err.message : "guard_failed" }),
      { status: 500, headers: jsonHeaders },
    );
  }

  // ------------------------------------------------------------------
  // Identifiers — everything derives from one random tag so each demo
  // school is self-describing and trivially identifiable for cleanup
  // (delete from schools where name like 'Recall Demo School%').
  // ------------------------------------------------------------------
  const tag = randTag();
  const schoolName = `${DEMO_SCHOOL_PREFIX} ${tag}`;
  const password = `Demo-${tag}-2026`;
  const email = (suffix: string) => `demo-${tag}-${suffix}@${DEMO_DOMAIN}`;

  // People. Fixed names so the demo always tells the same story.
  const ORGANISER = { name: "Olivia Reed", suffix: "organiser" };
  const TEACHERS = [
    { name: "Daniel Clarke", suffix: "teacher1" },
    { name: "Priya Sharma", suffix: "teacher2" },
  ];
  const STUDENTS = [
    { name: "Ava Bennett", suffix: "student1", year: "Year 9" },
    { name: "Noah Miller", suffix: "student2", year: "Year 9" },
    { name: "Isla Turner", suffix: "student3", year: "Year 9" },
    { name: "Leo Foster", suffix: "student4", year: "Year 10" },
    { name: "Maya Kaur", suffix: "student5", year: "Year 10" },
  ];

  // Cleanup bookkeeping: every auth user we create, plus the school id.
  const createdUserIds: string[] = [];
  let schoolId: string | null = null;

  /** Create one auth user; the handle_new_user trigger does the rest
   *  (profile row, school row for the organiser, school_id wiring). */
  async function makeUser(
    mail: string,
    meta: Record<string, string>,
    label: string,
  ): Promise<string> {
    const { data, error } = await sb.auth.admin.createUser({
      email: mail,
      password,
      email_confirm: true,
      user_metadata: meta,
    });
    if (error || !data.user) {
      throw new Error(`${label}: ${error?.message ?? "no user returned"}`);
    }
    createdUserIds.push(data.user.id);
    return data.user.id;
  }

  try {
    // ----------------------------------------------------------------
    // 1) Organiser — the trigger creates the schools row (SCH-code)
    //    from intended_school + intended_plan.
    // ----------------------------------------------------------------
    const organiserId = await makeUser(
      email(ORGANISER.suffix),
      {
        full_name: ORGANISER.name,
        intended_role: "school_organiser",
        intended_school: schoolName,
        intended_plan: "standard",
      },
      "create_organiser",
    );

    // ----------------------------------------------------------------
    // 2) Read the school back. The trigger runs inside the same
    //    insert as the auth.users row so the row should already be
    //    there; the retry is belt-and-braces against replication lag.
    // ----------------------------------------------------------------
    let school: { id: string; code: string; name: string } | null = null;
    for (let attempt = 0; attempt < 3 && !school; attempt++) {
      const { data } = await sb
        .from("schools")
        .select("id, code, name")
        .eq("owner_user_id", organiserId)
        .maybeSingle();
      school = data ?? null;
      if (!school) await new Promise((r) => setTimeout(r, 500));
    }
    if (!school) throw new Error("school_not_created: trigger did not create the school row");
    schoolId = school.id;

    // ----------------------------------------------------------------
    // 3) Teachers — wired to the school via intended_school_id.
    // ----------------------------------------------------------------
    const teacherIds: string[] = [];
    for (const t of TEACHERS) {
      teacherIds.push(
        await makeUser(
          email(t.suffix),
          {
            full_name: t.name,
            intended_role: "teacher",
            intended_school_id: school.id,
            intended_school_code: school.code,
          },
          `create_${t.suffix}`,
        ),
      );
    }

    // ----------------------------------------------------------------
    // 4) Students — intended_school_code + year_group, deliberately NO
    //    dob key so the trigger marks parental consent as not_required
    //    and the sign-in hook lets them straight in.
    // ----------------------------------------------------------------
    const studentIds: string[] = [];
    for (const s of STUDENTS) {
      studentIds.push(
        await makeUser(
          email(s.suffix),
          {
            full_name: s.name,
            intended_role: "student",
            intended_school_code: school.code,
            year_group: s.year,
          },
          `create_${s.suffix}`,
        ),
      );
    }

    // ----------------------------------------------------------------
    // 5) Subjects — looked up by (name, board, level), never hardcoded
    //    UUIDs. Both are in the seeded subject list.
    // ----------------------------------------------------------------
    const subjects = await must(
      sb
        .from("subjects")
        .select("id, name")
        .or(
          "and(name.eq.Mathematics,exam_board.eq.AQA,level.eq.gcse),and(name.eq.English Language,exam_board.eq.AQA,level.eq.gcse)",
        ),
      "subjects_lookup",
    );
    const maths = subjects.find((s: { name: string }) => s.name === "Mathematics");
    const eng = subjects.find((s: { name: string }) => s.name === "English Language");
    if (!maths || !eng) throw new Error("subjects_lookup: Mathematics/English Language not found");

    // ----------------------------------------------------------------
    // 6) Content. All direct inserts with the service role — bypasses
    //    RLS; the dashboards read these back via SECURITY DEFINER RPCs.
    //    is_template must be true: every school-scoped assignment read
    //    filters on it (same as the create_assignment RPC sets it).
    // ----------------------------------------------------------------

    // -- Classes -----------------------------------------------------
    const classes = await must(
      sb
        .from("classes")
        .insert([
          {
            school_id: school.id,
            name: "9A Maths",
            description: "Year 9 Mathematics — Set A",
            owner_user_id: teacherIds[0],
            tutor_user_id: teacherIds[0],
            subject_id: maths.id,
          },
          {
            school_id: school.id,
            name: "10A English",
            description: "Year 10 English Language — Set A",
            owner_user_id: teacherIds[0],
            tutor_user_id: teacherIds[1],
            subject_id: eng.id,
          },
        ])
        .select("id, name"),
      "classes_insert",
    );
    const classA = classes.find((c: { name: string }) => c.name === "9A Maths")!;
    const classB = classes.find((c: { name: string }) => c.name === "10A English")!;

    // -- Class members: students 1-3 in 9A Maths, 3-5 in 10A English ---
    await must(
      sb.from("class_members").insert([
        { class_id: classA.id, student_user_id: studentIds[0] },
        { class_id: classA.id, student_user_id: studentIds[1] },
        { class_id: classA.id, student_user_id: studentIds[2] },
        { class_id: classB.id, student_user_id: studentIds[2] },
        { class_id: classB.id, student_user_id: studentIds[3] },
        { class_id: classB.id, student_user_id: studentIds[4] },
      ]),
      "class_members_insert",
    );

    // -- Assignments (homework ×2 + a school-wide notice) -------------
    const assignments = await must(
      sb
        .from("assignments")
        .insert([
          {
            school_id: school.id,
            subject_id: maths.id,
            title: "Quadratic equations worksheet",
            description:
              "Complete questions 1-12 on factorising and the quadratic formula. Show all working.",
            kind: "homework",
            due_at: iso(3 * DAY),
            created_by: teacherIds[0],
            is_template: true,
          },
          {
            school_id: school.id,
            subject_id: eng.id,
            title: "Macbeth Act 1 essay",
            description:
              "How does Shakespeare establish the theme of ambition in Act 1? Around 500 words.",
            kind: "homework",
            due_at: iso(7 * DAY),
            created_by: teacherIds[1],
            is_template: true,
          },
          {
            school_id: school.id,
            title: "Parents' evening Thursday",
            description:
              "Parents' evening runs 16:30-19:00 in the sports hall. Booking slots open Monday.",
            kind: "notice",
            due_at: iso(2 * DAY),
            created_by: teacherIds[0],
            is_template: true,
          },
        ])
        .select("id, title"),
      "assignments_insert",
    );
    const a1 = assignments.find((a: { title: string }) => a.title.startsWith("Quadratic"))!;
    const a2 = assignments.find((a: { title: string }) => a.title.startsWith("Macbeth"))!;
    const a3 = assignments.find((a: { title: string }) => a.title.startsWith("Parents"))!;

    // -- Targets: mixed statuses so dashboards show progress ----------
    await must(
      sb.from("assignment_targets").insert([
        // Worksheet: everyone assigned, first two already done.
        { assignment_id: a1.id, student_user_id: studentIds[0], status: "done", completed_at: iso(-1 * DAY) },
        { assignment_id: a1.id, student_user_id: studentIds[1], status: "done", completed_at: iso(-1 * DAY) },
        { assignment_id: a1.id, student_user_id: studentIds[2], status: "pending" },
        { assignment_id: a1.id, student_user_id: studentIds[3], status: "pending" },
        { assignment_id: a1.id, student_user_id: studentIds[4], status: "pending" },
        // Essay: first two students, one done.
        { assignment_id: a2.id, student_user_id: studentIds[0], status: "done", completed_at: iso(-2 * DAY) },
        { assignment_id: a2.id, student_user_id: studentIds[1], status: "pending" },
        // Notice: everyone, two have read it.
        { assignment_id: a3.id, student_user_id: studentIds[0], status: "seen" },
        { assignment_id: a3.id, student_user_id: studentIds[1], status: "seen" },
        { assignment_id: a3.id, student_user_id: studentIds[2], status: "seen" },
        { assignment_id: a3.id, student_user_id: studentIds[3], status: "pending" },
        { assignment_id: a3.id, student_user_id: studentIds[4], status: "pending" },
      ]),
      "assignment_targets_insert",
    );

    // -- Submissions for the completed targets ------------------------
    await must(
      sb.from("assignment_submissions").insert([
        {
          assignment_id: a1.id,
          student_user_id: studentIds[0],
          text_answer:
            "Finished all 12 questions. Used the quadratic formula for Q12 — please can we go over negative discriminants?",
        },
        {
          assignment_id: a1.id,
          student_user_id: studentIds[1],
          text_answer: "Done up to Q10. Q11 and Q12 are on the back page.",
        },
        {
          assignment_id: a2.id,
          student_user_id: studentIds[0],
          text_answer:
            "Focused on the letter scene (1.5) and how it plants the idea in Macbeth's mind before Lady Macbeth pushes it further.",
        },
      ]),
      "submissions_insert",
    );

    // -- Announcements ------------------------------------------------
    await must(
      sb.from("announcements").insert([
        {
          school_id: school.id,
          audience: "everyone",
          title: "Welcome to the demo school!",
          body:
            "This school was set up so you can explore Recall — everything in it is throwaway. Click around, try the homework, and see how each dashboard feels.",
          posted_by: organiserId,
        },
        {
          school_id: school.id,
          audience: "students",
          title: "Maths homework due Friday",
          body:
            "The quadratic equations worksheet is due Friday. Help session Tuesday lunchtime in Room 12 if you're stuck.",
          posted_by: teacherIds[0],
        },
      ]),
      "announcements_insert",
    );

    // -- Timetable (Mon + Wed) -----------------------------------------
    await must(
      sb.from("timetable_slots").insert([
        {
          school_id: school.id, class_id: classA.id, teacher_user_id: teacherIds[0],
          day_of_week: 0, period: 1, start_time: "09:00:00", end_time: "10:00:00",
          room: "Room 12", label: "9A Maths", created_by: organiserId,
        },
        {
          school_id: school.id, class_id: classB.id, teacher_user_id: teacherIds[1],
          day_of_week: 0, period: 2, start_time: "10:15:00", end_time: "11:15:00",
          room: "Room 8", label: "10A English", created_by: organiserId,
        },
        {
          school_id: school.id, class_id: classA.id, teacher_user_id: teacherIds[0],
          day_of_week: 2, period: 1, start_time: "09:00:00", end_time: "10:00:00",
          room: "Room 12", label: "9A Maths", created_by: organiserId,
        },
        {
          school_id: school.id, class_id: classB.id, teacher_user_id: teacherIds[1],
          day_of_week: 2, period: 3, start_time: "11:30:00", end_time: "12:30:00",
          room: "Room 8", label: "10A English", created_by: organiserId,
        },
      ]),
      "timetable_insert",
    );

    // -- Praise points --------------------------------------------------
    await must(
      sb.from("praise_points").insert([
        {
          school_id: school.id, student_user_id: studentIds[0], points: 3,
          reason: "Consistently excellent homework", awarded_by: teacherIds[0],
        },
        {
          school_id: school.id, student_user_id: studentIds[2], points: 5,
          reason: "Outstanding contribution to the Act 1 discussion", awarded_by: teacherIds[1],
        },
        {
          school_id: school.id, student_user_id: studentIds[3], points: 2,
          reason: "Big improvement in reading this term", awarded_by: teacherIds[1],
        },
      ]),
      "praise_insert",
    );

    // -- Club + members --------------------------------------------------
    const clubs = await must(
      sb
        .from("clubs")
        .insert({
          school_id: school.id,
          name: "Chess Club",
          description: "Friendly games plus the school ladder tournament — all abilities welcome.",
          schedule: "Mondays 15:30-16:30",
          lead_user_id: teacherIds[1],
          created_by: organiserId,
        })
        .select("id"),
      "club_insert",
    );
    await must(
      sb.from("club_members").insert([
        { club_id: clubs[0].id, student_user_id: studentIds[0], added_by: teacherIds[1] },
        { club_id: clubs[0].id, student_user_id: studentIds[3], added_by: teacherIds[1] },
      ]),
      "club_members_insert",
    );

    // -- Register: this morning's 9A Maths register ----------------------
    const sessions = await must(
      sb
        .from("register_sessions")
        .insert({
          school_id: school.id,
          class_id: classA.id,
          session_date: new Date().toISOString().slice(0, 10),
          taken_by: teacherIds[0],
        })
        .select("id"),
      "register_session_insert",
    );
    await must(
      sb.from("register_marks").insert([
        { session_id: sessions[0].id, student_user_id: studentIds[0], status: "present" },
        { session_id: sessions[0].id, student_user_id: studentIds[1], status: "present" },
        { session_id: sessions[0].id, student_user_id: studentIds[2], status: "late", note: "Bus delay" },
      ]),
      "register_marks_insert",
    );

    // -- Enrollments: every student on both subjects ----------------------
    const enrollmentRows = studentIds.flatMap((uid) => [
      { user_id: uid, subject_id: maths.id },
      { user_id: uid, subject_id: eng.id },
    ]);
    await must(sb.from("enrollments").insert(enrollmentRows), "enrollments_insert");

    // -- Personal activity for student 1 (visible study KPIs) ------------
    await must(
      sb.from("study_sessions").insert([
        { user_id: studentIds[0], started_at: iso(-2 * DAY), duration_min: 20 },
        { user_id: studentIds[0], started_at: iso(-4 * DAY), duration_min: 35 },
        { user_id: studentIds[0], started_at: iso(-6 * DAY), duration_min: 15 },
      ]),
      "study_sessions_insert",
    );
    await must(
      sb.from("quiz_attempts").insert([
        { user_id: studentIds[0], score: 7, total: 10, taken_at: iso(-3 * DAY) },
        { user_id: studentIds[0], score: 9, total: 10, taken_at: iso(-5 * DAY) },
      ]),
      "quiz_attempts_insert",
    );
    await must(
      sb.from("activity_log").insert([
        { user_id: studentIds[0], kind: "quiz", summary: "Scored 9/10 on a quiz" },
        { user_id: studentIds[0], kind: "session", summary: "Studied for 35 minutes" },
      ]),
      "activity_log_insert",
    );

    // ----------------------------------------------------------------
    // Done — hand back everything the demo panel needs.
    // ----------------------------------------------------------------
    const accounts = [
      {
        role: "organiser", label: "Organiser", name: ORGANISER.name,
        email: email(ORGANISER.suffix), user_id: organiserId,
        dashboard: "school-organiser-dashboard.html",
      },
      ...TEACHERS.map((t, i) => ({
        role: "teacher", label: "Teacher", name: t.name,
        email: email(t.suffix), user_id: teacherIds[i],
        dashboard: "teacher-dashboard.html",
      })),
      ...STUDENTS.map((s, i) => ({
        role: "student", label: `Student — ${s.year}`, name: s.name,
        email: email(s.suffix), user_id: studentIds[i],
        dashboard: "dashboard.html",
      })),
    ];

    return new Response(
      JSON.stringify({
        ok: true,
        school: { id: school.id, name: school.name, code: school.code },
        // The whole demo self-deletes DEMO_TTL_MINUTES after creation.
        expires_at: new Date(Date.now() + DEMO_TTL_MINUTES * 60 * 1000).toISOString(),
        expires_in_minutes: DEMO_TTL_MINUTES,
        password,
        accounts,
      }),
      { status: 200, headers: jsonHeaders },
    );
  } catch (err) {
    // ----------------------------------------------------------------
    // Best-effort cleanup: delete the school (all school_id FKs cascade
    // — classes, assignments, announcements, timetable, praise, clubs,
    // register, targets) then delete each auth user (profiles cascade
    // from auth.users). A failed cleanup step is logged and skipped so
    // the rest still get torn down.
    // ----------------------------------------------------------------
    const reason = err instanceof Error ? err.message : "unknown_error";
    console.error(`create-demo-school[${tag}] failed: ${reason} — cleaning up`);
    try {
      if (schoolId) await sb.from("schools").delete().eq("id", schoolId);
    } catch (e) {
      console.error(`create-demo-school[${tag}] school cleanup failed:`, e);
    }
    for (const uid of createdUserIds) {
      try {
        await sb.auth.admin.deleteUser(uid);
      } catch (e) {
        console.error(`create-demo-school[${tag}] user cleanup failed for ${uid}:`, e);
      }
    }
    return new Response(JSON.stringify({ ok: false, reason }), {
      status: 500,
      headers: jsonHeaders,
    });
  }
});