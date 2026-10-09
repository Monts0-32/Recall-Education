// ============================================================================
// Shared demo-school expiry helpers.
//
// Demo schools are identifiable purely by name pattern ("Recall Demo School
// <tag>", minted by create-demo-school) and live for DEMO_TTL_MINUTES from
// their created_at. No schema changes are needed — expiry is always
// computed, never stored.
//
// Used by:
//   - create-demo-school: clears expired demos before applying its abuse
//     guard, so the guard only counts still-live demos.
//   - expire-demo-schools: the cleanup function proper — invoked every
//     minute by pg_cron, and by the site's banner script when a demo
//     user's countdown hits zero.
// ============================================================================

import type { SupabaseClient } from "@supabase/supabase-js";

export const DEMO_SCHOOL_PREFIX = "Recall Demo School";
export const DEMO_TTL_MINUTES = 15;

type SchoolRow = {
  id: string;
  name: string;
  owner_user_id: string | null;
  created_at: string;
};

/**
 * Delete every demo school older than DEMO_TTL_MINUTES, along with all of
 * its auth users (owner + members). Mirrors create-demo-school's proven
 * failure-path teardown: delete the school row first — school_id FKs
 * cascade — then admin.deleteUser each member (profiles cascade from
 * auth.users). Individual failures are logged and skipped so one bad row
 * can't block the rest.
 */
export async function cleanupExpiredDemoSchools(
  sb: SupabaseClient,
): Promise<{ schools: number; users: number }> {
  const cutoff = new Date(Date.now() - DEMO_TTL_MINUTES * 60 * 1000).toISOString();
  const { data: expired, error } = await sb
    .from("schools")
    .select("id, name, owner_user_id, created_at")
    .like("name", `${DEMO_SCHOOL_PREFIX}%`)
    .lt("created_at", cutoff);
  if (error) throw new Error(`expired_lookup: ${error.message}`);

  let schools = 0;
  let users = 0;
  for (const school of (expired ?? []) as SchoolRow[]) {
    // Collect every auth user attached to the school before deleting it.
    const userIds = new Set<string>();
    if (school.owner_user_id) userIds.add(school.owner_user_id);
    const { data: members } = await sb
      .from("profiles")
      .select("id")
      .eq("school_id", school.id);
    for (const m of (members ?? []) as { id: string }[]) userIds.add(m.id);

    try {
      await sb.from("schools").delete().eq("id", school.id);
      schools++;
    } catch (e) {
      console.error(`expire-demo-schools: school delete failed for ${school.id}:`, e);
      continue;
    }
    for (const uid of userIds) {
      try {
        await sb.auth.admin.deleteUser(uid);
        users++;
      } catch (e) {
        console.error(`expire-demo-schools: user delete failed for ${uid}:`, e);
      }
    }
    console.log(`expire-demo-schools: deleted "${school.name}" (+${userIds.size} users)`);
  }
  return { schools, users };
}

/**
 * Is this user (auth uid) attached to a still-live demo school? Used by
 * expire-demo-schools to answer the banner script's status question for any
 * demo member — organiser (owner), teacher or student.
 */
export async function callerDemoSchool(
  sb: SupabaseClient,
  uid: string,
): Promise<{ school_name: string; expires_at: string } | null> {
  const { data: profile } = await sb
    .from("profiles")
    .select("school_id")
    .eq("id", uid)
    .maybeSingle();

  let school: SchoolRow | null = null;
  if (profile?.school_id) {
    const { data } = await sb
      .from("schools")
      .select("id, name, owner_user_id, created_at")
      .eq("id", profile.school_id)
      .maybeSingle();
    school = data ?? null;
  }
  if (!school) {
    // Organisers own the school but their profile may not carry school_id.
    const { data } = await sb
      .from("schools")
      .select("id, name, owner_user_id, created_at")
      .eq("owner_user_id", uid)
      .maybeSingle();
    school = data ?? null;
  }
  if (!school || !school.name.startsWith(DEMO_SCHOOL_PREFIX)) return null;

  const expires = new Date(
    new Date(school.created_at).getTime() + DEMO_TTL_MINUTES * 60 * 1000,
  );
  return { school_name: school.name, expires_at: expires.toISOString() };
}