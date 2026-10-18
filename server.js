'use strict';

/**
 * 蛇域争霸 · 本地联机服务器
 * HTTP 静态服务器 + 原生 WebSocket（无第三方依赖）+ 权威游戏循环。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const {
  Room,
  CONFIG,
  POWERUPS,
  PLAYER_COLORS,
  cleanName,
  cleanColor
} = require('./game');
const { TunnelManager } = require('./tunnel');

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MESSAGE = 256 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8'
};

/* ========================================================================== */
/* 原生 WebSocket                                                             */
/* ========================================================================== */

class WebSocketConnection extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.fragmentOpcode = 0;
    this.closed = false;
    this.closeEmitted = false;
    this._onClose = () => this.emitClose();

    socket.setNoDelay(true);
    socket.setTimeout(0);
    socket.on('data', (chunk) => this.onData(chunk));
    socket.on('close', this._onClose);
    socket.on('end', this._onClose);
    socket.on('error', this._onClose);
  }

  emitClose() {
    this.closed = true;
    if (this.closeEmitted) return;
    this.closeEmitted = true;
    this.emit('close');
  }

  onData(chunk) {
    if (this.closed) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.length > MAX_MESSAGE * 2) {
      this.close(1009, 'message too large');
      return;
    }

    for (;;) {
      const frame = this.readFrame();
      if (!frame) return;
      this.handleFrame(frame);
      if (this.closed) return;
    }
  }

  readFrame() {
    const buffer = this.buffer;
    if (buffer.length < 2) return null;

    const fin = (buffer[0] & 0x80) !== 0;
    const opcode = buffer[0] & 0x0f;
    const masked = (buffer[1] & 0x80) !== 0;
    let length = buffer[1] & 0x7f;
    let offset = 2;

    if (length === 126) {
      if (buffer.length < 4) return null;
      length = buffer.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (buffer.length < 10) return null;
      const high = buffer.readUInt32BE(2);
      const low = buffer.readUInt32BE(6);
      length = high * 2 ** 32 + low;
      offset = 10;
    }

    if (length > MAX_MESSAGE) {
      this.close(1009, 'frame too large');
      return null;
    }

    const maskOffset = offset;
    if (masked) offset += 4;
    if (buffer.length < offset + length) return null;

    const mask = masked ? buffer.subarray(maskOffset, maskOffset + 4) : null;
    const payload = Buffer.from(buffer.subarray(offset, offset + length));
    if (mask) {
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
    }

    this.buffer = buffer.subarray(offset + length);
    return { fin, opcode, payload };
  }

  handleFrame({ fin, opcode, payload }) {
    if (opcode === 0x8) {
      this.close(1000);
      return;
    }
    if (opcode === 0x9) {
      this.sendFrame(0xa, payload);
      return;
    }
    if (opcode === 0xa) {
      this.emit('pong');
      return;
    }

    if (opcode === 0x0) {
      if (!this.fragmentOpcode) return;
      this.fragments.push(payload);
      if (this.fragmentsLength() > MAX_MESSAGE) {
        this.close(1009, 'message too large');
        return;
      }
      if (fin) {
        const full = Buffer.concat(this.fragments);
        const original = this.fragmentOpcode;
        this.fragments = [];
        this.fragmentOpcode = 0;
        this.dispatch(original, full);
      }
      return;
    }

    if (opcode === 0x1 || opcode === 0x2) {
      if (!fin) {
        this.fragmentOpcode = opcode;
        this.fragments = [payload];
        return;
      }
      this.dispatch(opcode, payload);
    }
  }

  fragmentsLength() {
    return this.fragments.reduce((sum, part) => sum + part.length, 0);
  }

  dispatch(opcode, payload) {
    if (opcode === 0x1) this.emit('message', payload.toString('utf8'));
    else this.emit('binary', payload);
  }

  sendFrame(opcode, payload) {
    if (this.closed || !this.socket.writable) return;

    const length = payload.length;
    let header;

    if (length < 126) {
      header = Buffer.alloc(2);
      header[0] = 0x80 | opcode;
      header[1] = length;
    } else if (length < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeUInt32BE(Math.floor(length / 2 ** 32), 2);
      header.writeUInt32BE(length >>> 0, 6);
    }

    try {
      this.socket.write(Buffer.concat([header, payload]));
    } catch (_) {
      this.closed = true;
      this.emitClose();
    }
  }

  send(message) {
    const text = typeof message === 'string' ? message : JSON.stringify(message);
    this.sendFrame(0x1, Buffer.from(text, 'utf8'));
  }

  ping() {
    this.sendFrame(0x9, Buffer.alloc(0));
  }

  close(code = 1000, reason = '') {
    if (this.closed) return;
    const reasonBuffer = Buffer.from(reason, 'utf8');
    const payload = Buffer.alloc(2 + reasonBuffer.length);
    payload.writeUInt16BE(code, 0);
    reasonBuffer.copy(payload, 2);
    this.sendFrame(0x8, payload);
    this.closed = true;
    try {
      this.socket.end();
    } catch (_) {
      /* ignore */
    }
  }
}

/* ========================================================================== */
/* 工具                                                                       */
/* ========================================================================== */

function lanAddresses() {
  const result = [];
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const info of interfaces[name] || []) {
      if (info.family === 'IPv4' && !info.internal) {
        result.push({ address: info.address, name });
      }
    }
  }

  const score = (ip) => {
    if (ip.startsWith('192.168.')) return 0;
    if (ip.startsWith('10.')) return 1;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return 2;
    return 3;
  };

  return result
    .sort((a, b) => score(a.address) - score(b.address) || a.address.localeCompare(b.address))
    .map((item) => item.address);
}

function serveFile(req, res, publicDir, pathname) {
  const root = path.resolve(publicDir);
  let target;

  try {
    target = path.resolve(root, '.' + pathname);
  } catch (_) {
    res.writeHead(400);
    res.end('Bad request');
    return;
  }

  if (target !== root && !target.startsWith(root + path.sep)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.stat(target, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }

    const ext = path.extname(target).toLowerCase();
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff'
    };

    res.writeHead(200, headers);
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    fs.createReadStream(target).pipe(res);
  });
}

/* ========================================================================== */
/* 服务器                                                                     */
/* ========================================================================== */

async function startServer(options = {}) {
  const publicDir = options.publicDir || path.join(__dirname, 'public');
  const host = options.host || '0.0.0.0';
  const quiet = !!options.quiet;
  const autoPort = options.autoPort !== false;
  const requestedPort = Number.isFinite(options.port) ? options.port : 3000;

  const room = new Room();
  const state = { port: 0 };
  const clients = new Set();
  const addresses = lanAddresses();

  let playerSeq = 0;
  let clientSeq = 0;
  let httpServer = null;
  let tickTimer = null;
  let heartbeatTimer = null;
  let lastState = room.state;
  let lastVersion = room.version;
  let lastActivity = Date.now();
  let tunnel = null;

  const publicConfig = {
    map: { w: CONFIG.MAP_W, h: CONFIG.MAP_H },
    maxPlayers: CONFIG.MAX_PLAYERS,
    startLives: CONFIG.START_LIVES,
    maxLives: CONFIG.MAX_LIVES,
    roundMs: CONFIG.ROUND_MS,
    respawnMs: CONFIG.RESPAWN_MS,
    countdownMs: CONFIG.COUNTDOWN_MS,
    foodCount: CONFIG.FOOD_COUNT,
    powerups: Object.entries(POWERUPS).map(([key, value]) => ({
      key,
      name: value.name,
      desc: value.desc,
      color: value.color
    }))
  };

  function serverInfo() {
    const port = state.port;
    return {
      port,
      addresses,
      url: addresses.length
        ? `http://${addresses[0]}:${port}`
        : `http://127.0.0.1:${port}`
    };
  }

  function sendTo(client, message) {
    if (client.conn && !client.conn.closed) client.conn.send(message);
  }

  function broadcast(message) {
    const data = JSON.stringify(message);
    for (const client of clients) {
      if (client.playerId && !client.conn.closed) client.conn.send(data);
    }
  }

  function handleJoin(client, msg) {
    if (client.playerId) return;

    if (room.players.size >= CONFIG.MAX_PLAYERS) {
      sendTo(client, {
        type: 'error',
        code: 'room_full',
        message: '房间已满（最多 5 人），请稍后再试。'
      });
      setTimeout(() => client.conn.close(), 150);
      return;
    }

    const usedColors = new Set([...room.players.values()].map((player) => player.color));
    let color = cleanColor(msg.color);
    if (usedColors.has(color)) {
      color = PLAYER_COLORS.find((candidate) => !usedColors.has(candidate)) || color;
    }

    const player = room.addPlayer({
      id: 'p' + ++playerSeq,
      name: cleanName(msg.name),
      color,
      now: Date.now()
    });

    if (!player) {
      sendTo(client, { type: 'error', code: 'room_full', message: '房间已满，请稍后再试。' });
      return;
    }

    client.playerId = player.id;
    client.name = player.name;
    if (client.joinTimer) clearTimeout(client.joinTimer);

    const now = Date.now();
    sendTo(client, {
      type: 'welcome',
      you: { id: player.id, name: player.name, color: player.color },
      room: room.getLobby(now),
      config: publicConfig,
      server: serverInfo()
    });

    if (room.state === 'playing') {
      sendTo(client, {
        type: 'start',
        room: room.getLobby(now),
        map: publicConfig.map,
        round: room.round,
        spectator: player.spectator
      });
      sendTo(client, room.snapshot(now));
    }

    if (!quiet) {
      console.log(`[join] ${player.name} (${player.id})  ${room.players.size}/${CONFIG.MAX_PLAYERS}`);
    }
  }

  function handleMessage(client, text) {
    client.lastSeen = Date.now();
    lastActivity = client.lastSeen;

    let msg;
    try {
      msg = JSON.parse(text);
    } catch (_) {
      return;
    }
    if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return;

    if (msg.type === 'join') {
      handleJoin(client, msg);
      return;
    }

    if (!client.playerId) return;

    switch (msg.type) {
      case 'input': {
        room.input(client.playerId, Number(msg.angle), !!msg.boost);
        break;
      }
      case 'start': {
        if (client.playerId === room.hostId) {
          room.startRound(client.playerId, Date.now());
        }
        break;
      }
      case 'ping': {
        sendTo(client, { type: 'pong', t: msg.t });
        break;
      }
      case 'leave': {
        client.conn.close();
        break;
      }
      default:
        break;
    }
  }

  function handleConnection(conn, req) {
    const client = {
      id: 'c' + ++clientSeq,
      conn,
      playerId: null,
      name: '',
      lastSeen: Date.now(),
      joinTimer: null,
      messageWindow: 0,
      messageWindowAt: Date.now()
    };
    clients.add(client);
    lastActivity = Date.now();

    client.joinTimer = setTimeout(() => {
      if (!client.playerId) conn.close(1000, 'join timeout');
    }, 20000);

    conn.on('pong', () => {
      client.lastSeen = Date.now();
    });

    conn.on('message', (text) => {
      const now = Date.now();
      if (now - client.messageWindowAt > 1000) {
        client.messageWindowAt = now;
        client.messageWindow = 0;
      }
      client.messageWindow++;
      if (client.messageWindow > 160) {
        conn.close(1008, 'rate limit');
        return;
      }
      handleMessage(client, text);
    });

    conn.on('close', () => {
      if (client.joinTimer) clearTimeout(client.joinTimer);
      clients.delete(client);
      lastActivity = Date.now();

      if (client.playerId) {
        const player = room.players.get(client.playerId);
        room.removePlayer(client.playerId);
        if (!quiet && player) console.log(`[leave] ${player.name}`);
        client.playerId = null;
      }
    });
  }

  function sendJson(res, status, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Length': Buffer.byteLength(body)
    });
    res.end(body);
  }

  function isHostRequest(req) {
    let hostname = String(req.headers.host || '').toLowerCase();
    if (hostname.startsWith('[')) {
      const end = hostname.indexOf(']');
      if (end > 0) hostname = hostname.slice(0, end + 1);
    } else {
      hostname = hostname.split(':')[0];
    }
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]' || hostname === '::1';
  }

  async function handleTunnel(req, res, url) {
    if (!isHostRequest(req)) {
      sendJson(res, 403, { error: '仅房主本机可以管理公网隧道。' });
      return;
    }
    if (!tunnel) {
      sendJson(res, 503, { error: '当前服务器未启用公网隧道。' });
      return;
    }

    if (url.pathname === '/api/tunnel') {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendJson(res, 405, { error: 'Method not allowed' });
        return;
      }
      sendJson(res, 200, tunnel.snapshot());
      return;
    }

    if (url.pathname === '/api/tunnel/start') {
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: 'Method not allowed' });
        return;
      }
      try {
        const snapshot = await tunnel.start();
        if (!quiet) console.log(`[tunnel] ${snapshot.url}`);
        sendJson(res, 200, snapshot);
      } catch (error) {
        sendJson(res, 502, { ...tunnel.snapshot(), error: error.message });
      }
      return;
    }

    if (url.pathname === '/api/tunnel/stop') {
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: 'Method not allowed' });
        return;
      }
      await tunnel.stop();
      if (!quiet) console.log('[tunnel] stopped');
      sendJson(res, 200, tunnel.snapshot());
      return;
    }

    sendJson(res, 404, { error: 'Not found' });
  }

  function handleRequest(req, res) {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch (_) {
      res.writeHead(400);
      res.end('Bad request');
      return;
    }

    if (url.pathname === '/api/tunnel' || url.pathname === '/api/tunnel/start' || url.pathname === '/api/tunnel/stop') {
      handleTunnel(req, res, url).catch((error) => {
        if (!res.headersSent) {
          sendJson(res, 500, { error: error.message });
        } else {
          try {
            res.end();
          } catch (_) {
            /* ignore */
          }
        }
      });
      return;
    }

    if (url.pathname === '/api/info') {
      sendJson(res, 200, { ok: true, ...serverInfo() });
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' });
      res.end();
      return;
    }

    let pathname;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch (_) {
      res.writeHead(400);
      res.end('Bad request');
      return;
    }

    if (pathname === '/' || pathname === '') pathname = '/index.html';
    serveFile(req, res, publicDir, pathname);
  }

  function attach(http) {
    http.on('upgrade', (req, socket, head) => {
      socket.on('error', () => {
        try {
          socket.destroy();
        } catch (_) {
          /* ignore */
        }
      });

      let pathname = '';
      try {
        pathname = new URL(req.url, 'http://localhost').pathname;
      } catch (_) {
        socket.destroy();
        return;
      }

      if (pathname !== '/ws') {
        socket.destroy();
        return;
      }

      const key = req.headers['sec-websocket-key'];
      const version = req.headers['sec-websocket-version'];
      if (!key || version !== '13') {
        socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }

      const accept = crypto
        .createHash('sha1')
        .update(key + WS_GUID)
        .digest('base64');

      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          `Sec-WebSocket-Accept: ${accept}\r\n` +
          '\r\n'
      );

      const conn = new WebSocketConnection(socket);
      if (head && head.length) conn.onData(head);
      handleConnection(conn, req);
    });

    http.on('clientError', (err, socket) => {
      if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    });
  }

  function startTick() {
    tickTimer = setInterval(() => {
      const now = Date.now();
      room.tick(now);

      if (room.state !== lastState) {
        lastState = room.state;
        if (room.state === 'playing') {
          broadcast({
            type: 'start',
            room: room.getLobby(now),
            map: publicConfig.map,
            round: room.round
          });
        } else if (room.state === 'ended') {
          broadcast({
            type: 'end',
            room: room.getLobby(now),
            results: room.results,
            winnerId: room.winnerId,
            nextAt: room.endAt
          });
        } else {
          broadcast({ type: 'room', room: room.getLobby(now) });
        }
      } else if (room.version !== lastVersion && room.state !== 'playing') {
        broadcast({ type: 'room', room: room.getLobby(now) });
      }
      lastVersion = room.version;

      if (room.state === 'playing') {
        broadcast(room.snapshot(now));
      }

      const events = room.drainEvents();
      if (events.length) broadcast({ type: 'events', events });
    }, CONFIG.TICK_MS);

    heartbeatTimer = setInterval(() => {
      const now = Date.now();
      for (const client of [...clients]) {
        if (now - client.lastSeen > 60000) {
          client.conn.close(1000, 'heartbeat timeout');
          continue;
        }
        client.conn.ping();
      }
    }, 20000);
  }

  async function listen(port) {
    for (let attempt = 0; attempt < (autoPort && port !== 0 ? 12 : 1); attempt++) {
      const candidate = port + attempt;
      const candidateServer = http.createServer(handleRequest);
      attach(candidateServer);

      try {
        await new Promise((resolve, reject) => {
          candidateServer.once('error', reject);
          candidateServer.listen(candidate, host, () => resolve());
        });
        httpServer = candidateServer;
        state.port = candidateServer.address().port;
        return;
      } catch (error) {
        try {
          candidateServer.close();
        } catch (_) {
          /* ignore */
        }
        if (error.code !== 'EADDRINUSE' || attempt === 11) throw error;
      }
    }
    throw new Error('unable to bind port');
  }

  await listen(requestedPort);
  if (options.enableTunnel !== false) {
    tunnel = new TunnelManager({ port: state.port });
  }
  startTick();

  if (!quiet) {
    const port = state.port;
    console.log('');
    console.log('  ╔══════════════════════════════════════════╗');
    console.log('  ║        蛇域争霸 · SNAKE ARENA           ║');
    console.log('  ╚══════════════════════════════════════════╝');
    console.log(`  本机访问:   http://127.0.0.1:${port}`);
    for (const address of addresses) {
      console.log(`  局域网访问: http://${address}:${port}`);
    }
    if (!addresses.length) {
      console.log('  未检测到局域网 IPv4 地址，请检查网络连接。');
    }
    console.log('');
    console.log('  同一 Wi-Fi 下的朋友用手机或浏览器打开上面的地址即可。');
    console.log('  外网朋友：在大厅点击「生成公网地址」，会通过免费隧道生成一个 https 链接。');
    console.log('  按 Ctrl+C 关闭服务器。');
    console.log('');
  }

  async function close() {
    if (tunnel) {
      try {
        await tunnel.stop();
      } catch (_) {
        /* ignore */
      }
    }
    return new Promise((resolve) => {
      if (tickTimer) clearInterval(tickTimer);
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      tickTimer = null;
      heartbeatTimer = null;

      for (const client of [...clients]) {
        try {
          client.conn.close(1001, 'server shutting down');
        } catch (_) {
          /* ignore */
        }
      }
      clients.clear();

      if (!httpServer) {
        resolve();
        return;
      }

      const done = () => resolve();
      httpServer.close(done);
      if (typeof httpServer.closeAllConnections === 'function') {
        httpServer.closeAllConnections();
      }
      setTimeout(done, 2000);
      httpServer = null;
    });
  }

  return {
    server: httpServer,
    room,
    port: state.port,
    addresses,
    close,
    tunnel,
    clientCount: () => clients.size,
    lastActivity: () => lastActivity
  };
}

/* ========================================================================== */
/* CLI                                                                        */
/* ========================================================================== */

if (require.main === module) {
  const arg = process.argv.find((item) => item.startsWith('--port='));
  const port = Number(arg ? arg.split('=')[1] : process.env.PORT || 3000) || 3000;
  const noAutoPort = process.argv.includes('--no-auto-port') || process.env.SNAKE_NO_AUTO_PORT === '1';
  const idleArg = process.argv.find((item) => item.startsWith('--idle-exit='));
  const idleExitMs = Number(idleArg ? idleArg.split('=')[1] : 0) || 0;

  startServer({ port, autoPort: !noAutoPort })
    .then((handle) => {
      const shutdown = () => {
        handle.close().then(() => process.exit(0));
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);

      if (idleExitMs > 0) {
        const idleTimer = setInterval(() => {
          if (handle.clientCount() === 0 && Date.now() - handle.lastActivity() > idleExitMs) {
            clearInterval(idleTimer);
            handle.close().then(() => process.exit(0));
          }
        }, 30000);
        if (idleTimer.unref) idleTimer.unref();
      }
    })
    .catch((error) => {
      console.error('服务器启动失败:', error.message);
      process.exit(1);
    });
}

module.exports = {
  startServer,
  WebSocketConnection,
  lanAddresses,
  CONFIG
};
