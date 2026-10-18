'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('../server');

function makeClient(url) {
  const ws = new WebSocket(url);
  const messages = [];
  const waiters = [];

  ws.addEventListener('message', (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch (_) {
      return;
    }
    messages.push(msg);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].type === msg.type) {
        const waiter = waiters.splice(i, 1)[0];
        clearTimeout(waiter.timer);
        waiter.resolve(msg);
      }
    }
  });

  return {
    ws,
    messages,
    open() {
      return new Promise((resolve, reject) => {
        ws.addEventListener('open', resolve, { once: true });
        ws.addEventListener('error', () => reject(new Error('websocket error')), { once: true });
      });
    },
    send(message) {
      ws.send(JSON.stringify(message));
    },
    waitFor(type, timeout = 9000) {
      const index = messages.findIndex((msg) => msg.type === type && !msg.__consumed);
      if (index >= 0) {
        messages[index].__consumed = true;
        return Promise.resolve(messages[index]);
      }
      return new Promise((resolve, reject) => {
        const waiter = {
          type,
          resolve,
          timer: setTimeout(() => {
            const pos = waiters.indexOf(waiter);
            if (pos >= 0) waiters.splice(pos, 1);
            reject(new Error(`timeout waiting for ${type}`));
          }, timeout)
        };
        waiters.push(waiter);
      });
    },
    close() {
      try {
        ws.close();
      } catch (_) {
        /* ignore */
      }
    }
  };
}

async function connectPlayer(wsUrl, name, color) {
  const client = makeClient(wsUrl);
  await client.open();
  client.send({ type: 'join', name, color });
  const welcome = await client.waitFor('welcome');
  return { client, welcome };
}

test('HTTP /api/info 返回端口和局域网地址', async () => {
  const server = await startServer({ port: 0, quiet: true });
  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/api/info`);
    assert.equal(response.status, 200);
    const info = await response.json();
    assert.equal(info.ok, true);
    assert.equal(info.port, server.port);
    assert.ok(Array.isArray(info.addresses));
  } finally {
    await server.close();
  }
});

test('两个客户端加入、房主开局并收到对局状态', async () => {
  const server = await startServer({ port: 0, quiet: true });
  const clients = [];

  try {
    const wsUrl = `ws://127.0.0.1:${server.port}/ws`;
    const first = await connectPlayer(wsUrl, '甲', '#3ff08a');
    const second = await connectPlayer(wsUrl, '乙', '#5ce1ff');
    clients.push(first.client, second.client);

    assert.equal(first.welcome.room.players.length, 1);
    assert.equal(first.welcome.you.id, first.welcome.room.hostId);
    assert.equal(second.welcome.room.players.length, 2);
    assert.equal(second.welcome.room.hostId, first.welcome.you.id);

    first.client.messages.length = 0;
    second.client.messages.length = 0;
    first.client.send({ type: 'start' });
    const countdown = await first.client.waitFor('room');
    assert.equal(countdown.room.state, 'countdown');
    assert.ok(countdown.room.countdownLeft > 0);

    const start = await first.client.waitFor('start', 8000);
    assert.equal(start.room.state, 'playing');
    assert.equal(start.room.round, 1);

    const state = await second.client.waitFor('state', 3000);
    assert.equal(state.players.length, 2);
    assert.ok(state.food.length > 0);
    assert.ok(state.players.every((player) => player.alive));

    second.client.send({ type: 'input', angle: 1.2, boost: false });
    await new Promise((resolve) => setTimeout(resolve, 200));
    const latest = second.client.messages.filter((msg) => msg.type === 'state').at(-1);
    assert.ok(latest);
    assert.ok(Array.isArray(latest.players));
  } finally {
    for (const client of clients) client.close();
    await server.close();
  }
});

test('房间最多 5 人，第 6 个连接被拒绝', async () => {
  const server = await startServer({ port: 0, quiet: true });
  const clients = [];

  try {
    const wsUrl = `ws://127.0.0.1:${server.port}/ws`;
    for (let i = 0; i < 5; i++) {
      const { client } = await connectPlayer(wsUrl, '玩家' + i, '#3ff08a');
      clients.push(client);
    }

    const extra = makeClient(wsUrl);
    clients.push(extra);
    await extra.open();
    extra.send({ type: 'join', name: '第六人', color: '#ffd166' });
    const error = await extra.waitFor('error');
    assert.equal(error.code, 'room_full');
  } finally {
    for (const client of clients) client.close();
    await server.close();
  }
});

test('房主退出后房主自动转移', async () => {
  const server = await startServer({ port: 0, quiet: true });
  const clients = [];

  try {
    const wsUrl = `ws://127.0.0.1:${server.port}/ws`;
    const first = await connectPlayer(wsUrl, '房主', '#3ff08a');
    const second = await connectPlayer(wsUrl, '替补', '#5ce1ff');
    clients.push(first.client, second.client);

    first.client.close();
    let updated = null;
    for (let i = 0; i < 40; i++) {
      updated = second.client.messages.filter((msg) => msg.type === 'room').at(-1);
      if (updated && updated.room.players.length === 1) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    assert.ok(updated);
    assert.equal(updated.room.players.length, 1);
    assert.equal(updated.room.hostId, second.welcome.you.id);
  } finally {
    for (const client of clients) client.close();
    await server.close();
  }
});
