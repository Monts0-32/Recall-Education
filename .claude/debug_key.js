const fs = require('fs');
const OLD = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imhraml5aWJwZXFkb3Fkb3F6bHlxend6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM4MzkxNDgsImV4cCI6MjA5OTQxNTE0OH0.UGVZ0-b9-c7JVtu006mmyfj0NkIbpmmn0wCNNqdi9iU';
const s = fs.readFileSync('C:/Users/brook/OneDrive/Documents/GitHub/Recall-Education/dashboard.html', 'utf8');
const start = s.indexOf('UGVZ0-b9');
const candidate = s.substring(start - 145, start + 44);
console.log('Candidate length:', candidate.length, 'OLD length:', OLD.length);
console.log('Equal?', candidate === OLD);
if (candidate !== OLD) {
  for (let i = 0; i < Math.min(candidate.length, OLD.length); i++) {
    if (candidate[i] !== OLD[i]) {
      console.log('First diff at index', i);
      console.log('  candidate:', JSON.stringify(candidate.slice(Math.max(0,i-3), i+10)));
      console.log('  OLD:      ', JSON.stringify(OLD.slice(Math.max(0,i-3), i+10)));
      console.log('  candidate codes:', [...candidate.slice(i,i+5)].map(c=>c.charCodeAt(0)));
      console.log('  OLD codes:      ', [...OLD.slice(i,i+5)].map(c=>c.charCodeAt(0)));
      break;
    }
  }
}
