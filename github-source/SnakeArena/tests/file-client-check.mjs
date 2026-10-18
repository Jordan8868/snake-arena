import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../server.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EDGE = process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9485;
const outDir = path.join(ROOT, '.dsh-tmp', 'apk-shots');
await fs.mkdir(outDir, { recursive: true });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const server = await startServer({ port: 0, quiet: true });
const fileUrl = 'file:///' + path.join(ROOT, 'public', 'index.html').replace(/\\/g, '/');
console.log('server', server.port);
console.log('file', fileUrl);

const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'apk-edge-'));
const proc = spawn(EDGE, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check',
  '--disable-gpu', '--hide-scrollbars',
  '--allow-file-access-from-files',
  '--window-size=1000,1200',
  'about:blank'
], { stdio: ['ignore', 'pipe', 'pipe'] });

async function waitForDevtools(timeout = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (response.ok) return response.json();
    } catch (_) {
      /* ignore */
    }
    await sleep(200);
  }
  throw new Error('devtools not ready');
}

const info = await waitForDevtools();
const ws = new WebSocket(info.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = () => reject(new Error('ws error'));
});

let seq = 0;
const pending = new Map();
const listeners = new Map();
ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(JSON.stringify(message.error)));
    else resolve(message.result);
    return;
  }
  if (message.method) {
    for (const handler of listeners.get(message.method) || []) handler(message.params);
  }
};

function send(method, params = {}, sessionId) {
  const id = ++seq;
  const payload = { id, method, params };
  if (sessionId) payload.sessionId = sessionId;
  ws.send(JSON.stringify(payload));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

function once(method, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const handlers = listeners.get(method) || [];
    if (!listeners.has(method)) listeners.set(method, handlers);
    const handler = (params) => {
      clearTimeout(timer);
      handlers.splice(handlers.indexOf(handler), 1);
      resolve(params);
    };
    handlers.push(handler);
    const timer = setTimeout(() => {
      handlers.splice(handlers.indexOf(handler), 1);
      reject(new Error('timeout ' + method));
    }, timeout);
  });
}

const errors = [];
listeners.set('Runtime.exceptionThrown', []);
listeners.get('Runtime.exceptionThrown').push((params) => {
  errors.push(params.exceptionDetails?.exception?.description || params.exceptionDetails?.text || 'exception');
});

const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
await send('Page.enable', {}, sessionId);
await send('Runtime.enable', {}, sessionId);
await send('Emulation.setDeviceMetricsOverride', {
  width: 390, height: 844, deviceScaleFactor: 2, mobile: true
}, sessionId);
await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 }, sessionId);
await send('Emulation.setEmulatedMedia', { features: [{ name: 'pointer', value: 'coarse' }] }, sessionId);

const loaded = once('Page.loadEventFired');
await send('Page.navigate', { url: fileUrl }, sessionId);
await loaded;
await sleep(800);

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true }, sessionId);
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result?.value;
}

async function screenshot(name) {
  const { data } = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
  await fs.writeFile(path.join(outDir, name), Buffer.from(data, 'base64'));
  console.log('shot', name);
}

async function waitUntil(expression, timeout = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await evaluate(expression)) return true;
    await sleep(100);
  }
  throw new Error('timeout: ' + expression);
}

try {
  console.log('protocol:', await evaluate('location.protocol'));
  console.log('server field visible:', await evaluate("getComputedStyle(document.getElementById('serverField')).display !== 'none'"));
  await screenshot('01-file-connect.png');

  await evaluate(`
    document.getElementById('nameInput').value = 'PHONE';
    document.getElementById('serverInput').value = '127.0.0.1:${server.port}';
    document.getElementById('connectBtn').click();
    true;
  `);
  await waitUntil("!document.getElementById('lobbyScreen').classList.contains('hidden')", 12000);
  console.log('lobby slots:', await evaluate("document.querySelectorAll('.slot.filled').length"));
  await screenshot('02-file-lobby.png');

  await evaluate("document.getElementById('startBtn').click()");
  await waitUntil("!document.getElementById('gameScreen').classList.contains('hidden')", 12000);
  await sleep(900);
  console.log('game canvas:', await evaluate("document.getElementById('gameCanvas').width + 'x' + document.getElementById('gameCanvas').height"));
  console.log('boost visible:', await evaluate("getComputedStyle(document.getElementById('boostBtn')).display"));
  console.log('dom info:', await evaluate(`JSON.stringify({
    hudCount: document.querySelectorAll('.hud').length,
    screenCount: document.querySelectorAll('#gameScreen').length,
    scrollY: window.scrollY,
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    docHeight: document.documentElement.scrollHeight,
    hudRect: (() => { const r = document.querySelector('.hud').getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; })(),
    gameRect: (() => { const r = document.getElementById('gameScreen').getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; })(),
    visual: window.visualViewport ? [window.visualViewport.offsetTop, window.visualViewport.height, window.visualViewport.scale] : null
  })`));
  await screenshot('03-file-game.png');

  console.log('JS errors:', errors.length ? errors : 'none');
} catch (error) {
  console.error('FILE CHECK FAILED:', error);
  console.log('errors:', errors);
  process.exitCode = 1;
} finally {
  try {
    await send('Browser.close');
  } catch (_) {
    /* ignore */
  }
  ws.close();
  await sleep(400);
  try {
    proc.kill();
  } catch (_) {
    /* ignore */
  }
  await server.close();
  await sleep(300);
  try {
    await fs.rm(profile, { recursive: true, force: true });
  } catch (_) {
    /* ignore */
  }
  process.exit(process.exitCode || 0);
}
