/* Drive headless Edge over CDP, load a URL, wait for #out to contain
 * 'total:', print its text with a wall-clock timestamp per poll.
 * Usage: node scripts/cdp-diag.mjs <url> [timeoutSeconds] */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const url = process.argv[2] || 'https://recall-education.brooksmonty87-61d.workers.dev/diag-net';
const timeoutS = parseInt(process.argv[3] || '40', 10);
const PORT = 9223 + Math.floor(Math.random() * 20);

const browser = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-first-run',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${process.env.TEMP}/cdp-profile-${PORT}`,
], { stdio: 'ignore' });
process.on('exit', () => browser.kill());

// Wait for the DevTools endpoint to come up.
let targets;
for (let i = 0; i < 40; i++) {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
    targets = await r.json();
    if (targets.length) break;
  } catch { /* not up yet */ }
  await sleep(250);
}
const page = targets.find(t => t.type === 'page');
if (!page) { console.error('no page target'); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let id = 0;
const pending = new Map();
function send(method, params = {}) {
  return new Promise((res, rej) => {
    const mid = ++id;
    pending.set(mid, { res, rej });
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
}
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id).res(m.result);
    pending.delete(m.id);
  }
};

await send('Page.enable');
await send('Runtime.enable');
await send('Page.navigate', { url });

const t0 = Date.now();
let text = '';
while (Date.now() - t0 < timeoutS * 1000) {
  await sleep(1000);
  const r = await send('Runtime.evaluate', {
    expression: `document.getElementById('out') ? document.getElementById('out').textContent : '(no #out yet)'`,
    returnByValue: true,
  });
  text = r.result.value;
  console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${text.split('\n').length} lines`);
  if (text.includes('total:')) break;
}
console.log('\n===== FINAL DIAG OUTPUT =====');
console.log(`wall clock to finish: ${Date.now() - t0}ms`);
console.log(text);
ws.close();
browser.kill();
process.exit(0);