import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EDGE = process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9495;
const outDir = path.join(ROOT, '.dsh-tmp', 'solo-shots');
await fs.mkdir(outDir, { recursive: true });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'solo-edge-'));
const proc = spawn(EDGE, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check',
  '--disable-gpu', '--hide-scrollbars',
  '--allow-file-access-from-files',
  '--window-size=390,844',
  'about:blank'
], { stdio: ['ignore', 'pipe', 'pipe'] });

async function waitDevtools() {
  for (let index = 0; index < 100; index++) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (response.ok) return response.json();
    } catch (_) {
      /* ignore */
    }
    await sleep(200);
  }
  throw new Error('devtools timeout');
}

const info = await waitDevtools();
const ws = new WebSocket(info.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});
let seq = 0;
const pending = new Map();
const errors = [];
ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(JSON.stringify(message.error)));
    else resolve(message.result);
    return;
  }
  if (message.method === 'Runtime.exceptionThrown') {
    errors.push(message.params.exceptionDetails?.exception?.description || message.params.exceptionDetails?.text || 'exception');
  }
};
function send(method, params = {}, sessionId) {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}
async function evaluate(page, expression) {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, page.sessionId);
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result?.value;
}
async function waitFor(page, expression, timeout = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await evaluate(page, expression)) return;
    await sleep(120);
  }
  throw new Error('timeout: ' + expression);
}
async function shot(page, name) {
  const { data } = await send('Page.captureScreenshot', { format: 'png' }, page.sessionId);
  await fs.writeFile(path.join(outDir, name), Buffer.from(data, 'base64'));
  console.log('shot', name);
}

const page = { sessionId: null };
const target = await send('Target.createTarget', { url: 'about:blank' });
page.sessionId = (await send('Target.attachToTarget', { targetId: target.targetId, flatten: true })).sessionId;
await send('Page.enable', {}, page.sessionId);
await send('Runtime.enable', {}, page.sessionId);
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }, page.sessionId);
await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 }, page.sessionId);
const fileUrl = 'file:///' + path.join(ROOT, 'public', 'index.html').replace(/\\/g, '/') + '?debug=1';
await send('Page.navigate', { url: fileUrl }, page.sessionId);
await sleep(900);

try {
  await evaluate(page, "document.getElementById('soloBtn').click(); true;");
  await waitFor(page, "!document.getElementById('gameScreen').classList.contains('hidden')");
  const ui = await evaluate(page, `({
    solo: document.getElementById('gameScreen').classList.contains('solo-mode'),
    meta: !document.getElementById('soloMeta').classList.contains('hidden'),
    timer: document.getElementById('hudTimer').textContent,
    best: document.getElementById('soloBest').textContent,
    exitVisible: !!document.getElementById('soloExitBtn'),
    overHidden: document.getElementById('soloOver').classList.contains('hidden')
  })`);
  console.log('solo ui:', ui);

  const before = await evaluate(page, `(() => { const s = window.__arenaDebug.solo; return { alive: s.alive, x: s.x, y: s.y, angle: s.angle, mass: s.mass, score: s.score, points: s.points.length }; })()`);
  console.log('solo before:', before);
  await shot(page, '01-solo-start.png');

  await send('Page.bringToFront', {}, page.sessionId);
  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 200, y: 500, radiusX: 2, radiusY: 2, force: 1, id: 1 }] }, page.sessionId);
  await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 320, y: 500, radiusX: 2, radiusY: 2, force: 1, id: 1 }] }, page.sessionId);
  await sleep(700);
  const after = await evaluate(page, `(() => { const s = window.__arenaDebug.solo; return { alive: s.alive, x: s.x, y: s.y, angle: s.angle, mass: s.mass, score: s.score, points: s.points.length }; })()`);
  console.log('solo after touch:', after);
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }, page.sessionId);
  await shot(page, '02-solo-touch.png');

  const moved = after.x > before.x + 5 || Math.abs(after.angle - before.angle) > 0.2;
  if (!moved) throw new Error('solo touch did not change movement/angle');

  // Force a wall death using the debug hook, then verify overlay / restart / exit.
  await evaluate(page, `(() => {
    const s = window.__arenaDebug.solo;
    s.points[0] = { x: 5, y: 1500 };
    s.x = 5;
    s.y = 1500;
    s.angle = Math.PI;
    window.__arenaDebug.app.angle = Math.PI;
    return true;
  })()`);
  await waitFor(page, "!document.getElementById('soloOver').classList.contains('hidden')");
  const over = await evaluate(page, `({
    visible: !document.getElementById('soloOver').classList.contains('hidden'),
    reason: document.getElementById('soloReason').textContent,
    score: document.getElementById('soloScore').textContent,
    best: document.getElementById('soloBestScore').textContent
  })`);
  console.log('solo over:', over);
  await shot(page, '03-solo-over.png');

  await evaluate(page, "document.getElementById('soloRestartBtn').click(); true;");
  await waitFor(page, "document.getElementById('soloOver').classList.contains('hidden')");
  const restarted = await evaluate(page, `(() => { const s = window.__arenaDebug.solo; return { alive: s.alive, x: s.x, y: s.y, points: s.points.length }; })()`);
  console.log('solo restart:', restarted);
  if (!restarted.alive) throw new Error('solo restart failed');

  await evaluate(page, "document.getElementById('soloExitBtn').click(); true;");
  await waitFor(page, "!document.getElementById('connectScreen').classList.contains('hidden')");
  const exited = await evaluate(page, `({
    connect: !document.getElementById('connectScreen').classList.contains('hidden'),
    solo: document.getElementById('gameScreen').classList.contains('solo-mode'),
    metaHidden: document.getElementById('soloMeta').classList.contains('hidden')
  })`);
  console.log('solo exit:', exited);
  console.log('JS errors:', errors.length ? errors : 'none');
} catch (error) {
  console.error('SOLO CHECK FAILED:', error);
  console.log('JS errors:', errors);
  process.exitCode = 1;
} finally {
  try { await send('Browser.close'); } catch (_) { /* ignore */ }
  ws.close();
  await sleep(400);
  try { proc.kill(); } catch (_) { /* ignore */ }
  await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
  await sleep(500);
  process.exit(process.exitCode || 0);
}
