import fs from 'node:fs/promises';
import path from 'node:path';

const DEBUG = `http://127.0.0.1:${process.env.DESKTOP_DEBUG_PORT || 9479}`;
const outDir = path.resolve('.dsh-tmp', 'desktop-shots');
await fs.mkdir(outDir, { recursive: true });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function targets() {
  const response = await fetch(`${DEBUG}/json/list`);
  return response.json();
}

let target = null;
for (let index = 0; index < 60; index++) {
  const list = await targets();
  target = list.find((item) => item.type === 'page' && item.url === 'http://127.0.0.1:31888/');
  if (target) break;
  await sleep(250);
}
if (!target) {
  console.log('targets:', (await targets()).map((item) => `${item.type} ${item.url}`));
  throw new Error('desktop page target not found');
}

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = () => reject(new Error('ws error'));
});

let seq = 0;
const pending = new Map();
const events = new Map();
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
    for (const handler of events.get(message.method) || []) handler(message.params);
  }
};

function send(method, params = {}) {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result?.value;
}

async function screenshot(name) {
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  await fs.writeFile(path.join(outDir, name), Buffer.from(data, 'base64'));
  console.log('shot', name);
}

await send('Page.enable');
await send('Runtime.enable');
await sleep(800);
console.log('url:', target.url);
console.log('title:', await evaluate('document.title'));
console.log('viewport:', await evaluate('window.innerWidth + "x" + window.innerHeight'));
await screenshot('01-desktop-connect.png');

await evaluate(`
  document.getElementById('nameInput').value = 'DESKTOP';
  document.getElementById('connectBtn').click();
  true;
`);
for (let index = 0; index < 40; index++) {
  if (await evaluate("!document.getElementById('lobbyScreen').classList.contains('hidden')")) break;
  await sleep(200);
}
console.log('lobby players:', await evaluate("document.querySelectorAll('.slot.filled').length"));
await screenshot('02-desktop-lobby.png');

// 关闭这个 Edge 实例
const version = await (await fetch(`${DEBUG}/json/version`)).json();
const browserWs = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  browserWs.onopen = resolve;
  browserWs.onerror = () => reject(new Error('browser ws error'));
});
browserWs.send(JSON.stringify({ id: 1, method: 'Browser.close', params: {} }));
await sleep(700);
console.log('desktop check complete');
process.exit(0);
