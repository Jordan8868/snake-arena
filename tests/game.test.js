'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { Room, CONFIG, radiusFor, cleanName, cleanColor } = require('../game');

function seededRng(seed = 42) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function makeRoom(count = 2) {
  const room = new Room({ rng: seededRng(1234) });
  const colors = ['#3ff08a', '#5ce1ff', '#b388ff', '#ffd166', '#ff6b7d'];
  for (let i = 0; i < count; i++) {
    room.addPlayer({
      id: 'p' + (i + 1),
      name: '玩家' + (i + 1),
      color: colors[i],
      now: 1000
    });
  }
  return room;
}

function begin(room, now = 1000) {
  room.startRound(room.hostId, now);
  const startAt = now + CONFIG.COUNTDOWN_MS + 10;
  room.tick(startAt);
  return startAt;
}

function clearProtection(player) {
  player.invulnUntil = 0;
  player.buffs.shieldUntil = 0;
  player.buffs.speedUntil = 0;
  player.buffs.magnetUntil = 0;
  player.buffs.doubleUntil = 0;
}

test('房间从大厅进入倒计时并开始游戏', () => {
  const room = makeRoom(2);
  assert.equal(room.state, 'lobby');
  assert.equal(room.players.size, 2);
  assert.equal(room.hostId, 'p1');

  assert.equal(room.startRound(room.hostId, 1000), true);
  assert.equal(room.state, 'countdown');
  assert.ok(room.countdownEndsAt > 1000);

  room.tick(1000 + CONFIG.COUNTDOWN_MS + 10);
  assert.equal(room.state, 'playing');
  assert.equal(room.participantsAtStart, 2);
  assert.ok(room.food.length >= CONFIG.FOOD_COUNT);

  for (const player of room.players.values()) {
    assert.equal(player.alive, true);
    assert.equal(player.lives, CONFIG.START_LIVES);
    assert.ok(player.points.length > 2);
    assert.equal(player.score, 0);
    const toCenter = Math.atan2(CONFIG.MAP_H / 2 - player.y, CONFIG.MAP_W / 2 - player.x);
    const diff = Math.atan2(Math.sin(player.angle - toCenter), Math.cos(player.angle - toCenter));
    assert.ok(Math.abs(diff) < 1e-9);
  }
});

test('对局中后加入的玩家会立即生成并可以操作', () => {
  const room = makeRoom(2);
  const now = begin(room);

  const late = room.addPlayer({
    id: 'p3',
    name: '后加入',
    color: '#ff6b7d',
    now
  });

  assert.equal(late.spectator, false);
  assert.equal(late.eliminated, false);
  assert.equal(late.alive, true);
  assert.equal(late.lives, CONFIG.START_LIVES);
  assert.ok(late.points.length > 2);
  assert.ok(late.invulnUntil > now);
  const toCenter = Math.atan2(CONFIG.MAP_H / 2 - late.y, CONFIG.MAP_W / 2 - late.x);
  const diff = Math.atan2(Math.sin(late.angle - toCenter), Math.cos(late.angle - toCenter));
  assert.ok(Math.abs(diff) < 1e-9);

  room.input(late.id, 0, false);
  assert.equal(late.targetAngle, 0);

  const state = room.snapshot(now);
  const view = state.players.find((player) => player.id === 'p3');
  assert.ok(view);
  assert.equal(view.spectator, false);
  assert.equal(view.alive, true);
  assert.ok(view.points.length > 0);
});

test('吃豆增加质量、分数并移除豆子', () => {
  const room = makeRoom(1);
  const now = begin(room);
  const player = room.players.get('p1');

  player.points = [{ x: 500, y: 500 }, { x: 490, y: 500 }];
  player.x = 500;
  player.y = 500;
  room.food = [];
  room.addFood(500, 500, 2, now);

  const massBefore = player.mass;
  const scoreBefore = player.score;
  room.eatFood(player, now, 0.033);

  assert.equal(room.food.length, 0);
  assert.equal(player.mass, massBefore + 2);
  assert.equal(player.score, scoreBefore + 20);
});

test('双倍得分道具生效', () => {
  const room = makeRoom(1);
  const now = begin(room);
  const player = room.players.get('p1');

  player.points = [{ x: 500, y: 500 }, { x: 490, y: 500 }];
  player.buffs.doubleUntil = now + 5000;
  room.food = [];
  room.addFood(500, 500, 1, now);

  room.eatFood(player, now, 0.033);
  assert.equal(player.score, 20);
});

test('撞墙死亡会消耗复活次数并自动复活', () => {
  const room = makeRoom(1);
  const now = begin(room);
  const player = room.players.get('p1');

  player.points = [{ x: 3, y: 500 }, { x: 20, y: 500 }];
  player.x = 3;
  player.y = 500;
  player.angle = Math.PI;
  player.targetAngle = Math.PI;
  player.invulnUntil = 0;

  room.tick(now + 33);
  assert.equal(player.alive, false);
  assert.equal(player.lives, 0);
  assert.equal(player.eliminated, false);
  assert.ok(player.respawnAt > now);
  assert.equal(room.state, 'playing');

  const respawnTime = player.respawnAt;
  room.tick(respawnTime + 1);
  assert.equal(player.alive, true);
  assert.ok(player.invulnUntil > respawnTime);
  assert.equal(player.eliminated, false);

  // 第二次死亡：没有复活次数，直接淘汰
  player.points = [{ x: 3, y: 500 }, { x: 20, y: 500 }];
  player.x = 3;
  player.y = 500;
  player.angle = Math.PI;
  player.targetAngle = Math.PI;
  player.invulnUntil = 0;
  room.tick(respawnTime + 100);
  assert.equal(player.alive, false);
  assert.equal(player.eliminated, true);
  assert.equal(player.respawnAt, 0);
});

test('大头对撞可以吞噬小头', () => {
  const room = makeRoom(2);
  const now = begin(room);
  const [big, small] = [...room.players.values()];

  big.points = [{ x: 1000, y: 1000 }, { x: 980, y: 1000 }];
  big.x = 1000;
  big.y = 1000;
  big.mass = 60;
  big.radius = radiusFor(big.mass);
  small.points = [{ x: 1000, y: 1000 }, { x: 1020, y: 1000 }];
  small.x = 1000;
  small.y = 1000;
  small.mass = 20;
  small.radius = radiusFor(small.mass);
  small.lives = 0;
  clearProtection(big);
  clearProtection(small);

  const bigMass = big.mass;
  room.resolveCollisions(now);

  assert.equal(big.alive, true);
  assert.equal(small.alive, false);
  assert.equal(small.eliminated, true);
  assert.equal(big.kills, 1);
  assert.ok(big.score >= 250);
  assert.ok(big.mass > bigMass);
});

test('势均力敌的头对头双方同归于尽', () => {
  const room = makeRoom(2);
  const now = begin(room);
  const [a, b] = [...room.players.values()];

  for (const [player, otherX] of [[a, 980], [b, 1020]]) {
    player.points = [{ x: 1000, y: 1000 }, { x: otherX, y: 1000 }];
    player.x = 1000;
    player.y = 1000;
    player.mass = 20;
    player.radius = radiusFor(20);
    player.lives = 0;
    clearProtection(player);
  }

  room.resolveCollisions(now);
  assert.equal(a.alive, false);
  assert.equal(b.alive, false);
  assert.equal(a.eliminated, true);
  assert.equal(b.eliminated, true);
  assert.equal(a.kills, 0);
  assert.equal(b.kills, 0);
});

test('头撞到其他蛇身体：撞的人死亡，身体主人记击杀', () => {
  const room = makeRoom(2);
  const now = begin(room);
  const [attacker, target] = [...room.players.values()];

  target.points = [];
  for (let i = 0; i < 24; i++) {
    target.points.push({ x: 1400 - i * 7, y: 1200 });
  }
  target.x = 1400;
  target.y = 1200;
  target.radius = radiusFor(target.mass);
  target.lives = 0;

  attacker.points = [
    { x: 1400 - 10 * 7, y: 1200 },
    { x: 1430, y: 1200 }
  ];
  attacker.x = attacker.points[0].x;
  attacker.y = 1200;
  attacker.lives = 0;
  clearProtection(attacker);
  clearProtection(target);

  const targetKills = target.kills;
  room.resolveCollisions(now);

  assert.equal(attacker.alive, false);
  assert.equal(target.alive, true);
  assert.equal(target.kills, targetKills + 1);
  assert.ok(target.score >= 250);
});

test('护盾可以免疫碰撞', () => {
  const room = makeRoom(2);
  const now = begin(room);
  const [attacker, target] = [...room.players.values()];

  target.points = [];
  for (let i = 0; i < 20; i++) {
    target.points.push({ x: 1400 - i * 7, y: 1200 });
  }
  target.x = 1400;
  target.y = 1200;
  attacker.points = [{ x: 1330, y: 1200 }, { x: 1430, y: 1200 }];
  attacker.x = 1330;
  attacker.y = 1200;
  clearProtection(attacker);
  clearProtection(target);
  attacker.buffs.shieldUntil = now + 5000;

  room.resolveCollisions(now);
  assert.equal(attacker.alive, true);
});

test('道具拾取：护盾、磁铁、加速、双倍、复活币', () => {
  const room = makeRoom(1);
  const now = begin(room);
  const player = room.players.get('p1');

  for (const type of ['shield', 'speed', 'magnet', 'double']) {
    room.powerups = [{ id: type, x: player.x, y: player.y, type }];
    room.takePowerups(player, now);
    const key = type + 'Until';
    assert.ok(player.buffs[key] > now, type + ' 没生效');
    assert.equal(room.powerups.length, 0);
  }

  player.lives = 1;
  room.powerups = [{ id: 'life', x: player.x, y: player.y, type: 'life' }];
  room.takePowerups(player, now);
  assert.equal(player.lives, 2);
});

test('加速会消耗质量并留下能量豆', () => {
  const room = makeRoom(1);
  const now = begin(room);
  const player = room.players.get('p1');

  player.mass = 120;
  player.radius = radiusFor(player.mass);
  player.wantBoost = true;
  player.angle = 0;
  player.targetAngle = 0;
  player.x = 2000;
  player.y = 1500;
  player.points = [{ x: 2000, y: 1500 }, { x: 1900, y: 1500 }];
  room.food = [];

  room.movePlayer(player, now, 0.033);
  assert.ok(player.boosting);
  assert.ok(player.mass < 120);

  room.movePlayer(player, now + 400, 0.033);
  assert.ok(room.food.some((food) => food.ownerId === player.id));
});

test('超时结束回合并生成排序后的结果', () => {
  const room = makeRoom(2);
  const now = begin(room);
  const [a, b] = [...room.players.values()];

  a.score = 100;
  a.kills = 2;
  b.score = 300;
  b.kills = 1;
  room.roundEndsAt = now + 1;
  room.tick(now + 20);

  assert.equal(room.state, 'ended');
  assert.equal(room.results.length, 2);
  assert.equal(room.results[0].id, 'p2');
  assert.equal(room.winnerId, 'p2');
  assert.ok(room.endAt > now);
});

test('房主离开自动转移房主', () => {
  const room = makeRoom(3);
  assert.equal(room.hostId, 'p1');
  room.removePlayer('p1');
  assert.equal(room.hostId, 'p2');
  room.removePlayer('p2');
  room.removePlayer('p3');
  assert.equal(room.hostId, null);
  assert.equal(room.state, 'lobby');
});

test('昵称与颜色清理', () => {
  assert.equal(cleanName('<b>  小蛇  </b>'), 'b 小蛇 /b');
  assert.equal(cleanName('   '), '玩家');
  assert.equal(cleanName('a'.repeat(40)).length, 12);
  assert.equal(cleanColor('#3ff08a'), '#3ff08a');
  assert.equal(cleanColor('javascript:alert(1)'), '#3ff08a');
  assert.equal(cleanColor('#ffffff'), '#3ff08a');
});

test('对局快照包含玩家、豆子和道具的紧凑数据', () => {
  const room = makeRoom(2);
  const now = begin(room);
  room.addRandomPowerup(now);

  const snapshot = room.snapshot(now);
  assert.equal(snapshot.type, 'state');
  assert.equal(snapshot.players.length, 2);
  assert.ok(snapshot.food.length > 0);
  assert.ok(snapshot.powerups.length > 0);
  assert.ok(snapshot.timeLeft > 0);
  assert.equal(snapshot.food[0].length, 4);
  assert.equal(snapshot.powerups[0].length, 3);
  assert.ok(Array.isArray(snapshot.players[0].points));
});
