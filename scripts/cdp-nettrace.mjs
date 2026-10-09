/* Load a page in clean headless Edge, capture every network request with
 * real timing + status, then dump resource timing. Usage:
 * node scripts/cdp-nettrace.mjs <url> [waitSeconds] */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const url = process.argv[2];
const waitS = parseInt(process.argv[3] || '20', 10);
const PORT = 9290 + Math.floor(Math.random() * 50);

const browser = spawn(EDGE, [
  // --headed by default; pass "headless" as 3rd arg for the old behaviour.
  ...(process.argv[4] === 'headless' ? ['--headless=new', '--disable-gpu'] : []),
  '--no-first-run',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${process.env.TEMP}/cdp-trace-${PORT}`,
], { stdio: 'ignore' });
process.on('exit', () => browser.kill());

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
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let id = 0;
const pending = new Map();
function send(method, params = {}) {
  return new Promise((res) => {
    const mid = ++id;
    pending.set(mid, res);
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
}
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
  if (m.method === 'Network.responseReceived') {
    const r = m.params.response;
    console.log(`[+${(Date.now() - t0) / 1000 | 0}s] ${m.params.type} ${r.status} ${r.url.slice(0, 110)}`);
  }
  if (m.method === 'Network.loadingFailed') {
    console.log(`[+${(Date.now() - t0) / 1000 | 0}s] FAILED ${m.params.errorText} ${m.params.blockedReason || ''} ${m.params.requestId}`);
  }
};

await send('Page.enable');
await send('Runtime.enable');
await send('Network.enable');

const t0 = Date.now();
await send('Page.navigate', { url });

for (let s = 1; s <= waitS; s++) {
  await sleep(1000);
  const r = await send('Runtime.evaluate', {
    expression: `document.readyState + '|' + (document.getElementById('gate') ? 'GATE:' + document.getElementById('gate').innerText.slice(0,60) : document.body.innerText.slice(0,60).replace(/\\n/g,' / '))`,
    returnByValue: true,
  });
  console.log(`[${s}s] page: ${r.result ? r.result.value : '?'}`);
}

const r2 = await send('Runtime.evaluate', {
  expression: `JSON.stringify(performance.getEntriesByType('resource').map(e => ({n: e.name.slice(0,90), d: Math.round(e.duration), p: e.nextHopProtocol})))`,
  returnByValue: true,
});
console.log('\n===== RESOURCE TIMING =====');
for (const e of JSON.parse(r2.result.value)) console.log(`${e.d}ms (${e.p}) ${e.n}`);
ws.close();
browser.kill();
process.exit(0);