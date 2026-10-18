import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../server.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EDGE = process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9450;
const outDir = path.join(ROOT, '.dsh-tmp', 'arena-shots');
await fs.mkdir(outDir, { recursive: true });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const server = await startServer({ port: 0, quiet: true });
const wsUrl = `ws://127.0.0.1:${server.port}/ws`;
const pageUrl = `http://127.0.0.1:${server.port}/`;
console.log('server port', server.port);

const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'arena-edge-'));
const proc = spawn(EDGE, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-gpu',
  '--hide-scrollbars',
  '--window-size=1440,900',
  '--force-device-scale-factor=1',
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
  ws.onerror = () => reject(new Error('devtools websocket error'));
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
    const handlers = listeners.get(message.method) || [];
    for (const handler of handlers) handler(message.params);
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
listeners.set('Runtime.consoleAPICalled', []);
listeners.get('Runtime.consoleAPICalled').push((params) => {
  if (params.type === 'error') {
    errors.push((params.args || []).map((arg) => arg.value || arg.description || '').join(' '));
  }
});

const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
await send('Page.enable', {}, sessionId);
await send('Runtime.enable', {}, sessionId);
await send('Log.enable', {}, sessionId);
await send('Emulation.setDeviceMetricsOverride', {
  width: 1440, height: 900, deviceScaleFactor: 1, mobile: false
}, sessionId);

const loaded = once('Page.loadEventFired');
await send('Page.navigate', { url: pageUrl }, sessionId);
await loaded;
await sleep(900);

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
  if (result.exceptionDetails) {
    throw new Error('evaluate failed: ' + (result.exceptionDetails.exception?.description || result.exceptionDetails.text));
  }
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
  throw new Error('timeout waiting: ' + expression);
}

async function setMobileViewport() {
  await send('Emulation.setDeviceMetricsOverride', {
    width: 390, height: 844, deviceScaleFactor: 2, mobile: true
  }, sessionId);
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 }, sessionId);
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'pointer', value: 'coarse' }] }, sessionId);
}

async function setDesktopViewport() {
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1440, height: 900, deviceScaleFactor: 1, mobile: false
  }, sessionId);
  await send('Emulation.setTouchEmulationEnabled', { enabled: false }, sessionId);
  await send('Emulation.setEmulatedMedia', { features: [] }, sessionId);
}

function makeBody(x, y, angle, mass) {
  const length = 90 + mass * 1.6;
  const points = [];
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  for (let distance = 0; distance <= length; distance += 7) {
    points.push({ x: x - dx * distance, y: y - dy * distance });
  }
  return points;
}

function radiusFor(mass) {
  return 9 + Math.sqrt(Math.max(1, mass)) * 0.8;
}

const bots = [];

async function connectBot(name, color) {
  const socket = new WebSocket(wsUrl);
  const bot = { name, color, socket, timer: null, id: null };
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('bot connect timeout')), 5000);
    socket.onopen = () => socket.send(JSON.stringify({ type: 'join', name, color }));
    socket.onmessage = (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch (_) {
        return;
      }
      if (message.type === 'welcome') {
        bot.id = message.you.id;
        clearTimeout(timer);
        resolve();
      }
    };
    socket.onerror = () => reject(new Error('bot socket error'));
  });

  let angle = Math.random() * Math.PI * 2;
  bot.timer = setInterval(() => {
    if (socket.readyState !== 1) return;
    angle += 0.24;
    socket.send(JSON.stringify({ type: 'input', angle, boost: false }));
  }, 90);

  bots.push(bot);
  return bot;
}

try {
  await screenshot('01-connect.png');

  await setMobileViewport();
  await sleep(600);
  await screenshot('01b-connect-mobile.png');
  await setDesktopViewport();
  await sleep(500);

  await evaluate(`
    document.getElementById('nameInput').value = 'ALPHA';
    document.getElementById('connectBtn').click();
  `);
  await waitUntil("!document.getElementById('lobbyScreen').classList.contains('hidden')", 12000);
  await sleep(400);
  await screenshot('02-lobby-single.png');

  await connectBot('青龙', '#5ce1ff');
  await connectBot('赤焰', '#ff6b7d');
  await connectBot('紫电', '#b388ff');
  await sleep(600);
  const slots = await evaluate("document.querySelectorAll('.slot.filled').length");
  console.log('filled slots:', slots);
  await screenshot('03-lobby-four.png');

  await setMobileViewport();
  await sleep(600);
  await screenshot('03b-lobby-mobile.png');
  await setDesktopViewport();
  await sleep(500);

  await evaluate("document.getElementById('startBtn').click()");
  await waitUntil("!document.getElementById('gameScreen').classList.contains('hidden')", 12000);
  await sleep(700);
  console.log('game visible, state players:', await evaluate("document.getElementById('hudLeaderboard').children.length"));
  await screenshot('04-game-start.png');

  // 把大家挪到镜头附近，做一张有内容的演示截图
  for (const bot of bots) {
    clearInterval(bot.timer);
    bot.timer = null;
  }

  const now = Date.now();
  const room = server.room;
  const alpha = [...room.players.values()].find((player) => player.name === 'ALPHA');
  if (!alpha) throw new Error('alpha player not found');

  alpha.x = 2100;
  alpha.y = 1500;
  alpha.angle = 0;
  alpha.targetAngle = 0;
  alpha.mass = 90;
  alpha.radius = radiusFor(90);
  alpha.score = 560;
  alpha.kills = 3;
  alpha.bestMass = 90;
  alpha.points = makeBody(alpha.x, alpha.y, alpha.angle, alpha.mass);
  alpha.alive = true;
  alpha.eliminated = false;
  alpha.lives = 1;
  alpha.respawnAt = 0;
  alpha.invulnUntil = 0;

  const specs = [
    { name: '青龙', mass: 55, score: 300, kills: 2, x: 1800, y: 1330, angle: Math.PI / 2, shield: true },
    { name: '赤焰', mass: 85, score: 420, kills: 1, x: 1700, y: 1680, angle: -Math.PI / 2, shield: false },
    { name: '紫电', mass: 130, score: 680, kills: 4, x: 1580, y: 1500, angle: 0, shield: false }
  ];

  for (const spec of specs) {
    const player = [...room.players.values()].find((item) => item.name === spec.name);
    if (!player) continue;
    player.x = spec.x;
    player.y = spec.y;
    player.angle = spec.angle;
    player.targetAngle = spec.angle;
    player.mass = spec.mass;
    player.radius = radiusFor(spec.mass);
    player.score = spec.score;
    player.kills = spec.kills;
    player.bestMass = spec.mass;
    player.points = makeBody(spec.x, spec.y, spec.angle, spec.mass);
    player.alive = true;
    player.eliminated = false;
    player.lives = 1;
    player.respawnAt = 0;
    player.invulnUntil = 0;
    player.wantBoost = false;
    player.boosting = false;
    player.buffs.shieldUntil = spec.shield ? now + 8000 : 0;
  }

  room.powerups = room.powerups.slice(0, 2);
  room.powerups.push({ id: 9991, x: 1900, y: 1420, type: 'magnet', spawnedAt: now });
  for (let index = 0; index < 26; index++) {
    room.addFood(2100 + (Math.random() - 0.5) * 900, 1500 + (Math.random() - 0.5) * 520, 1, now);
  }

  // 让页面玩家朝右，避免它立刻转向别处
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1000, y: 450, button: 'none' }, sessionId);
  await sleep(1100);
  await screenshot('05-game-action.png');

  // 死亡与复活
  const deathAt = Date.now();
  room.killPlayer(alpha, deathAt, null, 'wall');
  await sleep(500);
  const deathVisible = await evaluate("!document.getElementById('deathBanner').classList.contains('hidden')");
  const deathText = await evaluate("document.getElementById('deathBanner').innerText.replace(/\\n+/g, ' | ')");
  console.log('death banner:', deathVisible, '/', deathText);
  await screenshot('05b-death.png');

  await sleep(3200);
  const buffsAt = Date.now();
  alpha.buffs.shieldUntil = buffsAt + 9000;
  alpha.buffs.speedUntil = buffsAt + 7500;
  alpha.buffs.magnetUntil = buffsAt + 6000;
  alpha.buffs.doubleUntil = buffsAt + 5000;
  await sleep(600);
  const buffCount = await evaluate("document.querySelectorAll('#hudBuffs .buff').length");
  console.log('buff pills:', buffCount, '| alive:', alpha.alive);
  await screenshot('05c-revived-buffs.png');

  // 手机尺寸（竖屏）
  await setMobileViewport();
  await sleep(800);
  const boostDisplay = await evaluate("getComputedStyle(document.getElementById('boostBtn')).display");
  console.log('mobile boost display:', boostDisplay);
  await screenshot('06-game-mobile.png');

  // 回到桌面并展示结算
  await setDesktopViewport();
  await sleep(600);

  room.endRound(Date.now(), 'test');
  await sleep(900);
  const resultRows = await evaluate("document.querySelectorAll('.result-row').length");
  console.log('result rows:', resultRows);
  await screenshot('07-results.png');

  console.log('final HTML errors:', errors.length ? errors : 'none');
  console.log('page viewport:', await evaluate('window.innerWidth + "x" + window.innerHeight'));
  console.log('canvas size:', await evaluate("document.getElementById('gameCanvas').width + 'x' + document.getElementById('gameCanvas').height"));
} catch (error) {
  console.error('UI CHECK FAILED:', error);
  console.log('errors so far:', errors);
  process.exitCode = 1;
} finally {
  for (const bot of bots) {
    if (bot.timer) clearInterval(bot.timer);
    try {
      bot.socket.close();
    } catch (_) {
      /* ignore */
    }
  }
  try {
    await send('Browser.close');
  } catch (_) {
    /* ignore */
  }
  ws.close();
  await sleep(500);
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
