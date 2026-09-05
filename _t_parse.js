const fs = require('fs');
const path = require('path');
const files = [
  'groups.html',
  'classes.html',
  'timetables.html',
  'school-organiser-dashboard.html',
  'teacher-dashboard.html',
  'school-systems.html',
  'school-settings.html',
];
let bad = 0;
for (const f of files) {
  const html = fs.readFileSync(path.join(__dirname, f), 'utf8');
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  let m, i = 0;
  while ((m = re.exec(html))) {
    i++;
    try {
      new Function(m[1]);
    } catch (e) {
      bad++;
      console.log(`FAIL ${f} script#${i}: ${e.message}`);
    }
  }
  console.log(`${bad ? '  ' : 'OK  '}${f}: ${i} inline script block(s)`);
}
process.exit(bad ? 1 : 0);