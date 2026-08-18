// One-shot migration: replace dead legacy JWT anon key with the new
// sb_publishable_* key across all HTML files. Also bumps supabase-js
// to 2.49.4 (the first version with full new-key support) in any file
// that still imports supabase-js.
const fs = require('fs');
const path = require('path');

const ROOT = 'C:/Users/brook/OneDrive/Documents/GitHub/Recall-Education';
const OLD_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imhraml5aWJwZXFkb3Fkb3F6bHlxend6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM4MzkxNDgsImV4cCI6MjA5OTQxNTE0OH0.UGVZ0-b9-c7JVtu006mmyfj0NkIbpmmn0wCNNqdi9iU';
const NEW_KEY = 'sb_publishable_eCBuj0Ab6w5LPNnfnKkQTA_xd2vVImv';

const targets = [
  'accept-invite.html','admin.html','assignment-detail.html','class-summary.html',
  'classes.html','complete-profile.html','consent.html','dashboard.html',
  'diag-school-code.html','email-templates.html','homework.html','index.html',
  'lesson-creator.html','lesson.html','login.html','moderation.html',
  'reset-password.html','school-organiser-dashboard.html','set-homework.html',
  'signup-organisation.html','signup-staff.html','signup-teacher.html',
  'signup.html','staff-dashboard.html','subjects.html','teacher-dashboard.html',
];

let touched = 0, errors = [];

for (const f of targets) {
  const p = path.join(ROOT, f);
  let s;
  try { s = fs.readFileSync(p, 'utf8'); } catch (e) { errors.push(`${f}: ${e.message}`); continue; }
  const before = s;

  // 1. Replace the dead JWT anon key
  s = s.split(OLD_KEY).join(NEW_KEY);

  // 2. Bump pinned supabase-js version. Two patterns used in the codebase:
  //    ESM: https://esm.sh/@supabase/supabase-js@2.45.4  -> @2.49.4
  //    UMD: https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2  -> @2.49.4
  s = s.split('@supabase/supabase-js@2.45.4').join('@supabase/supabase-js@2.49.4');
  s = s.split('@supabase/supabase-js@2"').join('@supabase/supabase-js@2.49.4"');

  if (s !== before) {
    fs.writeFileSync(p, s, 'utf8');
    touched++;
    console.log('updated', f);
  } else {
    console.log('skipped (no change)', f);
  }
}

console.log(`\nDone. ${touched}/${targets.length} files updated.`);
if (errors.length) console.log('Errors:', errors);
