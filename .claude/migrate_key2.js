// Corrected migration: use the actual 208-char dead JWT that's still in
// the codebase. Old script used a 212-char version that didn't match.
const fs = require('fs');
const path = require('path');

const ROOT = 'C:/Users/brook/OneDrive/Documents/GitHub/Recall-Education';
const OLD_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imhraml5aWJwZXFkb3Fkb3F6bHlxend6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM4MzkxNDgsImV4cCI6MjA5OTQxNTE0OH0.UGVZ0-b9-c7JVtu006mmyfj0NkIbpmmn0wCNNqdi9iU';
const NEW_KEY = 'sb_publishable_eCBuj0Ab6w5LPNnfnKkQTA_xd2vVImv';

const targets = [
  'accept-invite.html','admin.html','assignment-detail.html','class-summary.html',
  'classes.html','complete-profile.html','consent.html','dashboard.html',
  'diag-school-code.html','homework.html','index.html','lesson-creator.html',
  'lesson.html','login.html','moderation.html','reset-password.html',
  'school-organiser-dashboard.html','set-homework.html','signup-organisation.html',
  'signup-staff.html','signup-teacher.html','signup.html','staff-dashboard.html',
  'subjects.html','teacher-dashboard.html',
];

let touched = 0;
for (const f of targets) {
  const p = path.join(ROOT, f);
  let s = fs.readFileSync(p, 'utf8');
  const before = s;
  s = s.split(OLD_KEY).join(NEW_KEY);
  if (s !== before) {
    fs.writeFileSync(p, s, 'utf8');
    touched++;
    console.log('updated', f);
  } else {
    console.log('no change', f);
  }
}
console.log(`\n${touched}/${targets.length} files updated.`);
