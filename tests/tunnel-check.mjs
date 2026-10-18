import http from 'node:http';
import { startServer } from '../server.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function rawRequest(port, path, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'GET', headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

const server = await startServer({ port: 0, quiet: true });
const base = `http://127.0.0.1:${server.port}`;
let tunnelUrl = null;

try {
  console.log('initial:', await (await fetch(`${base}/api/tunnel`)).json());

  const forbidden = await rawRequest(server.port, '/api/tunnel', { Host: 'example.com' });
  console.log('host restriction:', forbidden.status, forbidden.body.slice(0, 120));

  console.log('starting tunnel...');
  const started = await fetch(`${base}/api/tunnel/start`, { method: 'POST' });
  const data = await started.json();
  console.log('start:', started.status, data);
  if (data.state !== 'running' || !data.url) throw new Error('tunnel did not start');
  tunnelUrl = data.url;

  const info = await fetch(`${tunnelUrl}/api/info`);
  console.log('public http:', info.status, (await info.text()).slice(0, 120));

  const ws = new WebSocket(tunnelUrl.replace(/^https:/, 'wss:') + '/ws');
  const welcome = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('ws timeout')), 10000);
    ws.onopen = () => ws.send(JSON.stringify({ type: 'join', name: 'REMOTE', color: '#5ce1ff' }));
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.type === 'welcome') {
        clearTimeout(timer);
        resolve(msg);
      }
    };
    ws.onerror = () => reject(new Error('ws error'));
  });
  console.log('public ws welcome, players:', welcome.room.players.length);
  ws.close();
  await sleep(200);

  const stopped = await fetch(`${base}/api/tunnel/stop`, { method: 'POST' });
  console.log('stop:', stopped.status, await stopped.json());
  tunnelUrl = null;
  await sleep(1000);
  console.log('after stop status:', await (await fetch(`${base}/api/tunnel`)).json());
} catch (error) {
  console.error('TUNNEL TEST FAILED:', error);
  process.exitCode = 1;
} finally {
  try {
    await fetch(`${base}/api/tunnel/stop`, { method: 'POST' });
  } catch (_) {
    /* ignore */
  }
  await server.close();
  console.log('server closed');
  await sleep(700);
  process.exit(process.exitCode || 0);
}
