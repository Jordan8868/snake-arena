import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../server.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EDGE = process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9496;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const server = await startServer({ port: 0, quiet: true });
const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = () => reject(new Error('host ws error'));
});
ws.send(JSON.stringify({ type: 'join', name: 'HOST', color: '#3ff08a' }));
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('host welcome timeout')), 5000);
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.type === 'welcome') {
      clearTimeout(timer);
      resolve();
    }
  };
});

const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'touch-edge-'));
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
const cdp = new WebSocket(info.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { cdp.onopen = resolve; cdp.onerror = reject; });
let seq = 0;
const pending = new Map();
const errors = [];
cdp.onmessage = (event) => {
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
  cdp.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}
async function evaluate(page, expression) {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, page.sessionId);
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result?.value;
}
async function waitFor(page, expression, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await evaluate(page, expression)) return;
    await sleep(120);
  }
  throw new Error('timeout: ' + expression);
}

let page;
try {
  const target = await send('Target.createTarget', { url: 'about:blank' });
  const sessionId = (await send('Target.attachToTarget', { targetId: target.targetId, flatten: true })).sessionId;
  page = { sessionId };
  await send('Page.enable', {}, sessionId);
  await send('Runtime.enable', {}, sessionId);
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }, sessionId);
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 }, sessionId);
  const fileUrl = 'file:///' + path.join(ROOT, 'public', 'index.html').replace(/\\/g, '/');
  await send('Page.navigate', { url: fileUrl }, sessionId);
  await sleep(900);
  await evaluate(page, `
    document.getElementById('nameInput').value = 'PHONE';
    document.getElementById('serverInput').value = ${JSON.stringify('127.0.0.1:' + server.port)};
    document.getElementById('connectBtn').click();
    true;
  `);
  await waitFor(page, "!document.getElementById('lobbyScreen').classList.contains('hidden')");
  console.log('multiplayer mobile lobby joined');
  ws.send(JSON.stringify({ type: 'start' }));
  await waitFor(page, "!document.getElementById('gameScreen').classList.contains('hidden')", 10000);
  await sleep(6000);

  const player = [...server.room.players.values()].find((item) => item.name === 'PHONE');
  console.log('multiplayer phone alive:', player && player.alive, '| angle:', player && player.angle);
  if (!player || !player.alive) throw new Error('phone player is not alive');

  await send('Page.bringToFront', {}, sessionId);
  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 200, y: 500, radiusX: 2, radiusY: 2, force: 1, id: 1 }] }, sessionId);
  await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 320, y: 500, radiusX: 2, radiusY: 2, force: 1, id: 1 }] }, sessionId);
  await sleep(500);
  console.log('multiplayer phone target after touch:', player.targetAngle, '| angle:', player.angle);
  if (Math.abs(player.targetAngle) > 0.01) throw new Error('touch did not reach multiplayer input');
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }, sessionId);

  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: ' ', code: 'Space', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 }, sessionId);
  await sleep(250);
  console.log('multiplayer phone wantBoost after Space:', player.wantBoost);
  if (!player.wantBoost) throw new Error('space boost did not reach multiplayer input');
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 }, sessionId);

  console.log('JS errors:', errors.length ? errors : 'none');
  if (errors.length) throw new Error('JS errors in multiplayer mobile page');
} catch (error) {
  console.error('MOBILE TOUCH CHECK FAILED:', error);
  console.log('JS errors:', errors);
  process.exitCode = 1;
} finally {
  try { await send('Browser.close'); } catch (_) { /* ignore */ }
  cdp.close();
  await sleep(300);
  try { proc.kill(); } catch (_) {}
  ws.close();
  await server.close();
  await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
  await sleep(500);
  process.exit(process.exitCode || 0);
}
