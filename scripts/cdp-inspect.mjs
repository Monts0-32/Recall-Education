/* Navigate headless Edge to a URL and dump document state + network
 * timings. Usage: node scripts/cdp-inspect.mjs <url> [waitSeconds] */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const url = process.argv[2];
const waitS = parseInt(process.argv[3] || '20', 10);
const PORT = 9240 + Math.floor(Math.random() * 40);

const browser = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-first-run',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${process.env.TEMP}/cdp-inspect-${PORT}`,
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
};

await send('Page.enable');
await send('Runtime.enable');
await send('Network.enable');
await send('Page.navigate', { url });

const t0 = Date.now();
for (let s = 1; s <= waitS; s++) {
  await sleep(1000);
  const r = await send('Runtime.evaluate', {
    expression: `JSON.stringify({
      readyState: document.readyState,
      title: document.title,
      url: location.href,
      htmlLen: document.documentElement ? document.documentElement.outerHTML.length : 0,
      bodyStart: document.body ? document.body.innerText.slice(0, 200) : '(no body)',
      res: performance.getEntriesByType('resource').length,
      nav: (performance.getEntriesByType('navigation')[0]||{}).responseEnd
    })`,
    returnByValue: true,
  });
  console.log(`[${s}s] ` + (r.result ? r.result.value : JSON.stringify(r)));
  const v = r.result && JSON.parse(r.result.value);
  if (v && v.readyState === 'complete' && v.htmlLen > 500) break;
}
const r2 = await send('Runtime.evaluate', {
  expression: `document.documentElement ? document.documentElement.outerHTML.slice(0, 1500) : '(no document)'`,
  returnByValue: true,
});
console.log('\n===== DOCUMENT SNAPSHOT =====');
console.log(r2.result ? r2.result.value : '(none)');
ws.close();
browser.kill();
process.exit(0);