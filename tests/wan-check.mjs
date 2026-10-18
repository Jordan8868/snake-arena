import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../server.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EDGE = process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9490;
const outDir = path.join(ROOT, '.dsh-tmp', 'wan-shots');
await fs.mkdir(outDir, { recursive: true });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const server = await startServer({ port: 0, quiet: true });
const hostUrl = `http://127.0.0.1:${server.port}/`;
const fileUrl = 'file:///' + path.join(ROOT, 'public', 'index.html').replace(/\\/g, '/');
console.log('server', server.port);

const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'wan-edge-'));
const proc = spawn(EDGE, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check',
  '--disable-gpu', '--hide-scrollbars',
  '--allow-file-access-from-files',
  '--window-size=1440,900',
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
  ws.onerror = () => reject(new Error('devtools ws error'));
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
  const payload = { id, method, params };
  if (sessionId) payload.sessionId = sessionId;
  ws.send(JSON.stringify(payload));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

async function newPage(url, metrics) {
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Page.enable', {}, sessionId);
  await send('Runtime.enable', {}, sessionId);
  if (metrics) {
    await send('Emulation.setDeviceMetricsOverride', metrics, sessionId);
    if (metrics.mobile) {
      await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 }, sessionId);
      await send('Emulation.setEmulatedMedia', { features: [{ name: 'pointer', value: 'coarse' }] }, sessionId);
    }
  }
  await send('Page.navigate', { url }, sessionId);
  await sleep(900);
  return { sessionId, targetId };
}

async function evaluate(page, expression) {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, page.sessionId);
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  }
  return result.result?.value;
}

async function waitUntil(page, expression, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await evaluate(page, expression)) return true;
    await sleep(150);
  }
  throw new Error('timeout: ' + expression);
}

async function screenshot(page, name) {
  const { data } = await send('Page.captureScreenshot', { format: 'png' }, page.sessionId);
  await fs.writeFile(path.join(outDir, name), Buffer.from(data, 'base64'));
  console.log('shot', name);
}

let tunnelUrl = null;

try {
  const host = await newPage(hostUrl, { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await evaluate(host, `
    document.getElementById('nameInput').value = 'HOST';
    document.getElementById('connectBtn').click();
    true;
  `);
  await waitUntil(host, "!document.getElementById('lobbyScreen').classList.contains('hidden')", 12000);
  const wanPanelHidden = await evaluate(host, "document.getElementById('wanPanel').classList.contains('hidden')");
  console.log('host lobby, WAN panel hidden?', wanPanelHidden);
  if (wanPanelHidden) throw new Error('WAN panel should be visible on host localhost page');
  await screenshot(host, '01-host-wan-idle.png');

  await evaluate(host, "document.getElementById('wanStartBtn').click(); true;");
  await waitUntil(host, "document.getElementById('wanState').textContent === '已开启'", 45000);
  tunnelUrl = await evaluate(host, "document.getElementById('wanUrl').textContent");
  console.log('tunnel url:', tunnelUrl);
  await screenshot(host, '02-host-wan-running.png');

  const remoteUrl = tunnelUrl.replace(/\/$/, '') + '/?auto=1&name=REMOTE';
  const remote = await newPage(remoteUrl, { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await waitUntil(remote, "!document.getElementById('lobbyScreen').classList.contains('hidden')", 15000);
  console.log('remote page WAN panel hidden?', await evaluate(remote, "document.getElementById('wanPanel').classList.contains('hidden')"));
  console.log('remote slots:', await evaluate(remote, "document.querySelectorAll('.slot.filled').length"));
  await screenshot(remote, '03-remote-lobby.png');

  const phone = await newPage(fileUrl, { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  console.log('phone server field visible?', await evaluate(phone, "getComputedStyle(document.getElementById('serverField')).display !== 'none'"));
  await evaluate(phone, `
    document.getElementById('nameInput').value = 'PHONE';
    document.getElementById('serverInput').value = ${JSON.stringify(tunnelUrl)};
    document.getElementById('connectBtn').click();
    true;
  `);
  await waitUntil(phone, "!document.getElementById('lobbyScreen').classList.contains('hidden')", 15000);
  console.log('phone slots:', await evaluate(phone, "document.querySelectorAll('.slot.filled').length"));
  await screenshot(phone, '04-phone-via-public-url.png');

  await sleep(600);
  console.log('host slots:', await evaluate(host, "document.querySelectorAll('.slot.filled').length"));
  await screenshot(host, '05-host-three-players.png');

  await evaluate(host, "document.getElementById('startBtn').click(); true;");
  await waitUntil(remote, "!document.getElementById('gameScreen').classList.contains('hidden')", 15000);
  await send('Page.bringToFront', {}, remote.sessionId);
  await sleep(1000);
  console.log('remote game HUD leaderboard:', await evaluate(remote, "document.getElementById('hudLeaderboard').children.length"));
  console.log('remote game timer:', await evaluate(remote, "document.getElementById('hudTimer').textContent"));
  console.log('remote canvas:', await evaluate(remote, "document.getElementById('gameCanvas').width + 'x' + document.getElementById('gameCanvas').height"));
  await screenshot(remote, '06-remote-game.png');

  const stopResponse = await fetch(`${hostUrl}api/tunnel/stop`, { method: 'POST' });
  console.log('stop status:', stopResponse.status);
  const afterStop = await fetch(`${hostUrl}api/tunnel`).then((r) => r.json()).catch(() => null);
  console.log('API after stop:', afterStop);
  console.log('JS errors:', errors.length ? errors : 'none');
} catch (error) {
  console.error('WAN CHECK FAILED:', error);
  console.log('tunnelUrl:', tunnelUrl);
  console.log('JS errors:', errors);
  process.exitCode = 1;
} finally {
  try {
    await fetch(`http://127.0.0.1:${server.port}/api/tunnel/stop`, { method: 'POST' });
  } catch (_) {
    /* ignore */
  }
  try {
    await send('Browser.close');
  } catch (_) {
    /* ignore */
  }
  ws.close();
  await sleep(600);
  try {
    proc.kill();
  } catch (_) {
    /* ignore */
  }
  await server.close();
  await sleep(800);
  try {
    await fs.rm(profile, { recursive: true, force: true });
  } catch (_) {
    /* ignore */
  }
  process.exit(process.exitCode || 0);
}
