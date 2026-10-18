'use strict';

/**
 * 蛇域争霸 · 服务端权威模拟
 * 纯 Node 实现，不依赖任何第三方库。
 */

const TAU = Math.PI * 2;

const CONFIG = Object.freeze({
  MAP_W: 4200,
  MAP_H: 3000,
  MAX_PLAYERS: 5,
  TICK_MS: 33,
  ROUND_MS: 4 * 60 * 1000,
  COUNTDOWN_MS: 5000,
  RESULT_MS: 12000,
  START_LIVES: 1,
  MAX_LIVES: 2,
  BASE_MASS: 20,
  MIN_MASS: 10,
  BOOST_MIN_MASS: 26,
  BASE_SPEED: 168,
  BOOST_MULT: 1.55,
  SPEED_BUFF_MULT: 1.45,
  TURN_RATE: 4.6,
  BOOST_DRAIN: 7,
  BOOST_ORB_MS: 320,
  FOOD_COUNT: 430,
  MAX_FOOD: 900,
  POWERUP_MAX: 4,
  POWERUP_EVERY_MS: 9000,
  SPAWN_SHIELD_MS: 2600,
  RESPAWN_MS: 3000
});

const FOOD_COLORS = ['#ff6b7d', '#ffd166', '#5ce1ff', '#b388ff', '#7dffb0'];

const PLAYER_COLORS = [
  '#3ff08a', '#5ce1ff', '#b388ff', '#ffd166', '#ff6b7d',
  '#ff9f43', '#67e8f9', '#f472b6', '#a3e635', '#f97316'
];

const POWERUPS = Object.freeze({
  shield: { name: '护盾', desc: '8 秒无敌，可穿过其他蛇', color: '#67e8f9', weight: 25 },
  speed: { name: '疾风', desc: '8 秒移动速度 +45%', color: '#facc15', weight: 25 },
  magnet: { name: '磁铁', desc: '12 秒吸取周围能量豆', color: '#c084fc', weight: 20 },
  double: { name: '双倍', desc: '12 秒吃豆得分翻倍', color: '#fb923c', weight: 18 },
  life: { name: '复活币', desc: '额外获得 1 次复活机会', color: '#f472b6', weight: 12 }
});

const POWERUP_KEYS = Object.keys(POWERUPS);

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function normAngle(angle) {
  let a = (angle + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
}

function radiusFor(mass) {
  return 9 + Math.sqrt(Math.max(1, mass)) * 0.8;
}

function lengthFor(mass) {
  return 90 + Math.max(1, mass) * 1.6;
}

function randRange(rng, min, max) {
  return min + rng() * (max - min);
}

function makeBody(x, y, angle, length) {
  const points = [];
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  const spacing = 7;
  for (let dist = 0; dist <= length; dist += spacing) {
    points.push({ x: x - dx * dist, y: y - dy * dist });
  }
  return points;
}

function trimBody(points, targetLength) {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
    if (total >= targetLength) {
      points.length = i + 1;
      return;
    }
  }
}

function weightedPowerup(rng) {
  const total = POWERUP_KEYS.reduce((sum, key) => sum + POWERUPS[key].weight, 0);
  let roll = rng() * total;
  for (const key of POWERUP_KEYS) {
    roll -= POWERUPS[key].weight;
    if (roll <= 0) return key;
  }
  return POWERUP_KEYS[0];
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

class Room {
  constructor(options = {}) {
    this.rng = options.rng || Math.random;
    this.players = new Map();
    this.state = 'lobby'; // lobby | countdown | playing | ended
    this.version = 0;
    this.hostId = null;
    this.round = 0;
    this.food = [];
    this.powerups = [];
    this.events = [];
    this.results = [];
    this.winnerId = null;
    this.countdownEndsAt = 0;
    this.startedAt = 0;
    this.roundEndsAt = 0;
    this.endAt = 0;
    this.lastTick = 0;
    this.nextPowerupAt = 0;
    this.participantsAtStart = 0;
    this.foodSeq = 0;
    this.powerupSeq = 0;
  }

  /* ---------------------------- 玩家 ---------------------------- */

  addPlayer({ id, name, color, now = Date.now() }) {
    if (this.players.size >= CONFIG.MAX_PLAYERS) return null;

    const player = {
      id,
      name: cleanName(name),
      color: cleanColor(color),
      score: 0,
      kills: 0,
      deaths: 0,
      bestMass: 0,
      lives: CONFIG.START_LIVES,
      alive: false,
      eliminated: false,
      spectator: false,
      mass: CONFIG.BASE_MASS,
      radius: radiusFor(CONFIG.BASE_MASS),
      angle: 0,
      targetAngle: 0,
      wantBoost: false,
      boosting: false,
      boostOrbAt: 0,
      x: CONFIG.MAP_W / 2,
      y: CONFIG.MAP_H / 2,
      points: [],
      buffs: { shieldUntil: 0, speedUntil: 0, magnetUntil: 0, doubleUntil: 0 },
      invulnUntil: 0,
      respawnAt: 0,
      joinedAt: now
    };

    if (this.state === 'playing') {
      // 中途加入的玩家直接在当前回合生成，避免被锁在观战席直到下一轮。
      // spawnPlayer 会设置出生护盾，保证不会一进来就被撞死。
      this.spawnPlayer(player, now);
    }

    this.players.set(player.id, player);
    if (!this.hostId) this.hostId = player.id;
    this.version++;
    return player;
  }

  removePlayer(id) {
    const player = this.players.get(id);
    if (!player) return false;
    this.players.delete(id);

    if (this.hostId === id) {
      this.hostId = this.players.keys().next().done ? null : this.players.keys().next().value;
    }

    if (this.players.size === 0) {
      this.state = 'lobby';
      this.food = [];
      this.powerups = [];
      this.results = [];
      this.winnerId = null;
      this.hostId = null;
      this.countdownEndsAt = 0;
      this.startedAt = 0;
      this.roundEndsAt = 0;
      this.endAt = 0;
    }

    this.version++;
    return true;
  }

  input(id, angle, boost) {
    const player = this.players.get(id);
    if (!player || !player.alive) return;
    if (Number.isFinite(angle)) player.targetAngle = normAngle(angle);
    player.wantBoost = !!boost;
  }

  /* ---------------------------- 回合流程 ---------------------------- */

  startRound(byId, now = Date.now()) {
    if (this.state !== 'lobby') return false;
    if (byId !== this.hostId) return false;
    if (this.players.size === 0) return false;

    for (const player of this.players.values()) {
      player.score = 0;
      player.kills = 0;
      player.deaths = 0;
      player.bestMass = 0;
      player.lives = CONFIG.START_LIVES;
      player.alive = false;
      player.eliminated = false;
      player.spectator = false;
      player.respawnAt = 0;
      player.invulnUntil = 0;
      player.mass = CONFIG.BASE_MASS;
      player.radius = radiusFor(CONFIG.BASE_MASS);
      player.points = [];
      player.buffs = { shieldUntil: 0, speedUntil: 0, magnetUntil: 0, doubleUntil: 0 };
    }

    this.state = 'countdown';
    this.countdownEndsAt = now + CONFIG.COUNTDOWN_MS;
    this.round += 1;
    this.events = [];
    this.version++;
    return true;
  }

  beginRound(now = Date.now()) {
    this.state = 'playing';
    this.startedAt = now;
    this.roundEndsAt = now + CONFIG.ROUND_MS;
    this.endAt = 0;
    this.lastTick = now;
    this.results = [];
    this.winnerId = null;
    this.food = [];
    this.powerups = [];
    this.nextPowerupAt = now + 4000;
    this.events = [];

    for (const player of this.players.values()) {
      player.spectator = false;
      player.eliminated = false;
      player.lives = CONFIG.START_LIVES;
      player.score = 0;
      player.kills = 0;
      player.deaths = 0;
      player.bestMass = 0;
      this.spawnPlayer(player, now);
    }

    this.participantsAtStart = [...this.players.values()].filter((p) => !p.spectator).length;

    for (let i = 0; i < CONFIG.FOOD_COUNT; i++) this.addRandomFood(now);
    for (let i = 0; i < 3; i++) this.addRandomPowerup(now);

    this.version++;
  }

  spawnPlayer(player, now) {
    const spawn = this.findSpawn();
    player.mass = CONFIG.BASE_MASS;
    player.radius = radiusFor(player.mass);
    // 朝地图中心出生：保证有一段足够长的安全跑道，避免玩家还没看清方向就撞墙。
    player.angle = Math.atan2(CONFIG.MAP_H / 2 - spawn.y, CONFIG.MAP_W / 2 - spawn.x);
    player.targetAngle = player.angle;
    player.x = spawn.x;
    player.y = spawn.y;
    player.points = makeBody(spawn.x, spawn.y, player.angle, lengthFor(player.mass));
    player.alive = true;
    player.eliminated = false;
    player.respawnAt = 0;
    player.invulnUntil = now + CONFIG.SPAWN_SHIELD_MS;
    player.boostOrbAt = 0;
    player.wantBoost = false;
    player.boosting = false;
    player.buffs = { shieldUntil: 0, speedUntil: 0, magnetUntil: 0, doubleUntil: 0 };
    player.bestMass = Math.max(player.bestMass, player.mass);
  }

  findSpawn() {
    const margin = 260;
    for (let attempt = 0; attempt < 60; attempt++) {
      const x = randRange(this.rng, margin, CONFIG.MAP_W - margin);
      const y = randRange(this.rng, margin, CONFIG.MAP_H - margin);
      let safe = true;

      for (const other of this.players.values()) {
        if (!other.alive || !other.points.length) continue;
        if (Math.hypot(other.x - x, other.y - y) < 620) {
          safe = false;
          break;
        }
        for (let i = 0; i < other.points.length; i += 4) {
          const p = other.points[i];
          if (Math.hypot(p.x - x, p.y - y) < 320) {
            safe = false;
            break;
          }
        }
        if (!safe) break;
      }

      if (safe) return { x, y };
    }

    return {
      x: randRange(this.rng, margin, CONFIG.MAP_W - margin),
      y: randRange(this.rng, margin, CONFIG.MAP_H - margin)
    };
  }

  /* ---------------------------- 主循环 ---------------------------- */

  tick(now = Date.now()) {
    if (this.state === 'countdown') {
      if (now >= this.countdownEndsAt) this.beginRound(now);
      return;
    }

    if (this.state === 'playing') {
      const dt = clamp((now - this.lastTick) / 1000, 0, 0.08);
      this.lastTick = now;
      this.playingTick(now, dt);
      return;
    }

    if (this.state === 'ended' && now >= this.endAt) {
      this.toLobby(now);
    }
  }

  playingTick(now, dt) {
    this.ensureFood();

    if (now >= this.nextPowerupAt) {
      this.addRandomPowerup(now);
      this.nextPowerupAt = now + CONFIG.POWERUP_EVERY_MS;
    }

    for (const player of this.players.values()) {
      if (player.alive) {
        this.movePlayer(player, now, dt);
      } else if (!player.spectator && !player.eliminated && player.respawnAt && now >= player.respawnAt) {
        this.spawnPlayer(player, now);
        this.events.push({ kind: 'revived', id: player.id, name: player.name, x: Math.round(player.x), y: Math.round(player.y) });
      }
    }

    this.resolveCollisions(now);
    this.checkRoundEnd(now);
  }

  movePlayer(player, now, dt) {
    const turn = clamp(normAngle(player.targetAngle - player.angle), -CONFIG.TURN_RATE * dt, CONFIG.TURN_RATE * dt);
    player.angle = normAngle(player.angle + turn);

    let speed = CONFIG.BASE_SPEED * (1 - clamp((player.radius - 12) * 0.004, 0, 0.15));
    if (player.buffs.speedUntil > now) speed *= CONFIG.SPEED_BUFF_MULT;

    const canBoost = player.wantBoost && player.mass > CONFIG.BOOST_MIN_MASS;
    player.boosting = canBoost;
    if (canBoost) speed *= CONFIG.BOOST_MULT;

    const head = player.points[0];
    const nx = head.x + Math.cos(player.angle) * speed * dt;
    const ny = head.y + Math.sin(player.angle) * speed * dt;

    if (nx < 0 || ny < 0 || nx > CONFIG.MAP_W || ny > CONFIG.MAP_H) {
      this.killPlayer(player, now, null, 'wall');
      return;
    }

    player.points.unshift({ x: nx, y: ny });
    player.x = nx;
    player.y = ny;

    if (canBoost) {
      player.mass = Math.max(CONFIG.MIN_MASS, player.mass - CONFIG.BOOST_DRAIN * dt);
      player.radius = radiusFor(player.mass);
      if (now >= player.boostOrbAt) {
        player.boostOrbAt = now + CONFIG.BOOST_ORB_MS;
        const tail = player.points[player.points.length - 1];
        if (tail) {
          this.addFood(
            clamp(tail.x + randRange(this.rng, -4, 4), 20, CONFIG.MAP_W - 20),
            clamp(tail.y + randRange(this.rng, -4, 4), 20, CONFIG.MAP_H - 20),
            1.2,
            now,
            player.id
          );
        }
      }
    }

    player.radius = radiusFor(player.mass);
    trimBody(player.points, lengthFor(player.mass));
    player.bestMass = Math.max(player.bestMass, player.mass);

    this.eatFood(player, now, dt);
    this.takePowerups(player, now);
  }

  eatFood(player, now, dt) {
    const head = player.points[0];
    const magnet = player.buffs.magnetUntil > now;
    const doubleScore = player.buffs.doubleUntil > now;

    for (let i = this.food.length - 1; i >= 0; i--) {
      const food = this.food[i];
      let dx = head.x - food.x;
      let dy = head.y - food.y;
      let dist = Math.hypot(dx, dy);

      if (magnet && dist < 265 && dist > 1) {
        const pull = Math.min(dist, 220 * dt);
        food.x += (dx / dist) * pull;
        food.y += (dy / dist) * pull;
        dx = head.x - food.x;
        dy = head.y - food.y;
        dist = Math.hypot(dx, dy);
      }

      if (food.ownerId === player.id && now - food.bornAt < 2500) continue;
      if (dist > player.radius + food.r + 4) continue;

      this.food.splice(i, 1);
      player.mass += food.mass;
      player.radius = radiusFor(player.mass);
      const points = Math.round(food.mass * 10 * (doubleScore ? 2 : 1));
      player.score += points;
      player.bestMass = Math.max(player.bestMass, player.mass);
      trimBody(player.points, lengthFor(player.mass));
    }
  }

  takePowerups(player, now) {
    const head = player.points[0];
    for (let i = this.powerups.length - 1; i >= 0; i--) {
      const item = this.powerups[i];
      if (Math.hypot(head.x - item.x, head.y - item.y) > player.radius + 20) continue;

      this.powerups.splice(i, 1);
      this.applyPowerup(player, item.type, now);
      player.score += 25;
      this.events.push({
        kind: 'powerup',
        id: player.id,
        name: player.name,
        type: item.type,
        x: Math.round(item.x),
        y: Math.round(item.y)
      });
    }
  }

  applyPowerup(player, type, now) {
    switch (type) {
      case 'shield':
        player.buffs.shieldUntil = Math.max(player.buffs.shieldUntil, now) + 8000;
        break;
      case 'speed':
        player.buffs.speedUntil = Math.max(player.buffs.speedUntil, now) + 8000;
        break;
      case 'magnet':
        player.buffs.magnetUntil = Math.max(player.buffs.magnetUntil, now) + 12000;
        break;
      case 'double':
        player.buffs.doubleUntil = Math.max(player.buffs.doubleUntil, now) + 12000;
        break;
      case 'life':
        player.lives = Math.min(CONFIG.MAX_LIVES, player.lives + 1);
        break;
      default:
        break;
    }
  }

  /* ---------------------------- 碰撞 ---------------------------- */

  resolveCollisions(now) {
    const alive = [];
    for (const player of this.players.values()) {
      if (player.alive && !player.spectator) alive.push(player);
    }

    const deaths = new Map();
    const protectedPlayer = (p) => p.buffs.shieldUntil > now || p.invulnUntil > now;

    for (let i = 0; i < alive.length; i++) {
      for (let j = i + 1; j < alive.length; j++) {
        const a = alive[i];
        const b = alive[j];
        if (deaths.has(a.id) || deaths.has(b.id)) continue;
        if (protectedPlayer(a) || protectedPlayer(b)) continue;

        const ah = a.points[0];
        const bh = b.points[0];
        const headDist = Math.hypot(ah.x - bh.x, ah.y - bh.y);
        const headRadius = a.radius + b.radius;

        if (headDist < headRadius) {
          if (a.mass > b.mass * 1.15) {
            deaths.set(b.id, { killerId: a.id, reason: 'eaten' });
            continue;
          }
          if (b.mass > a.mass * 1.15) {
            deaths.set(a.id, { killerId: b.id, reason: 'eaten' });
            continue;
          }
          deaths.set(a.id, { killerId: null, reason: 'head' });
          deaths.set(b.id, { killerId: null, reason: 'head' });
          continue;
        }

        if (this.headHitsBody(a, b)) {
          deaths.set(a.id, { killerId: b.id, reason: 'body' });
        }
        if (!deaths.has(b.id) && this.headHitsBody(b, a)) {
          deaths.set(b.id, { killerId: a.id, reason: 'body' });
        }
      }
    }

    for (const [id, info] of deaths) {
      const player = this.players.get(id);
      if (player && player.alive) this.killPlayer(player, now, info.killerId, info.reason);
    }
  }

  headHitsBody(attacker, target) {
    if (!target.points.length) return false;
    const head = attacker.points[0];
    const threshold = attacker.radius * 0.82 + target.radius * 0.82;
    const thresholdSq = threshold * threshold;

    for (let i = 4; i < target.points.length; i++) {
      const point = target.points[i];
      const dx = head.x - point.x;
      const dy = head.y - point.y;
      if (dx * dx + dy * dy < thresholdSq) return true;
    }
    return false;
  }

  killPlayer(player, now, killerId, reason) {
    if (!player.alive) return;

    const head = player.points[0] || { x: player.x, y: player.y };
    player.alive = false;
    player.boosting = false;
    player.wantBoost = false;
    player.deaths += 1;

    const killer = killerId ? this.players.get(killerId) : null;
    const creditedKiller = killer && killer.id !== player.id && killer.alive ? killer : null;

    this.scatterBody(player, now);

    if (creditedKiller) {
      creditedKiller.kills += 1;
      creditedKiller.score += 250;
      creditedKiller.mass += Math.max(6, player.mass * 0.25);
      creditedKiller.radius = radiusFor(creditedKiller.mass);
      creditedKiller.bestMass = Math.max(creditedKiller.bestMass, creditedKiller.mass);
    }

    const remainingLives = Math.max(0, player.lives);
    if (remainingLives > 0) {
      player.lives = remainingLives - 1;
      player.respawnAt = now + CONFIG.RESPAWN_MS;
      player.eliminated = false;
    } else {
      player.lives = 0;
      player.respawnAt = 0;
      player.eliminated = true;
    }

    player.points = [];
    player.mass = CONFIG.BASE_MASS;
    player.radius = radiusFor(player.mass);
    player.buffs = { shieldUntil: 0, speedUntil: 0, magnetUntil: 0, doubleUntil: 0 };
    player.invulnUntil = 0;

    this.events.push({
      kind: 'death',
      id: player.id,
      name: player.name,
      color: player.color,
      x: Math.round(head.x),
      y: Math.round(head.y),
      reason,
      killerId: creditedKiller ? creditedKiller.id : null,
      killerName: creditedKiller ? creditedKiller.name : null,
      lives: player.lives,
      eliminated: player.eliminated
    });

    if (player.eliminated) {
      this.events.push({ kind: 'eliminated', id: player.id, name: player.name });
    }
  }

  scatterBody(player, now) {
    const total = Math.min(520, player.mass * 0.55);
    if (total <= 0.5) return;

    const count = Math.min(30, Math.max(5, Math.round(player.mass / 10)));
    const per = total / count;
    const points = player.points.length ? player.points : [{ x: player.x, y: player.y }];

    for (let i = 0; i < count; i++) {
      const t = count === 1 ? 0 : i / (count - 1);
      const index = Math.min(points.length - 1, Math.floor(t * (points.length - 1)));
      const point = points[index];
      this.addFood(
        clamp(point.x + randRange(this.rng, -14, 14), 12, CONFIG.MAP_W - 12),
        clamp(point.y + randRange(this.rng, -14, 14), 12, CONFIG.MAP_H - 12),
        per,
        now,
        null
      );
    }
  }

  checkRoundEnd(now) {
    const contenders = [...this.players.values()].filter((p) => !p.spectator);
    if (!contenders.length) {
      this.endRound(now, 'empty');
      return;
    }

    const remaining = contenders.filter((p) => !p.eliminated);
    if (remaining.length === 0) {
      this.endRound(now, 'wipe');
      return;
    }

    if (this.participantsAtStart >= 2 && remaining.length <= 1) {
      this.endRound(now, 'last');
      return;
    }

    if (now >= this.roundEndsAt) this.endRound(now, 'time');
  }

  endRound(now, reason) {
    if (this.state !== 'playing') return;
    this.state = 'ended';
    this.endAt = now + CONFIG.RESULT_MS;
    this.roundEndsAt = now;
    this.events.push({ kind: 'roundEnd', reason });

    this.results = [...this.players.values()]
      .map((p) => ({
        id: p.id,
        name: p.name,
        color: p.color,
        score: p.score,
        kills: p.kills,
        deaths: p.deaths,
        bestMass: Math.round(p.bestMass),
        lives: p.lives,
        spectator: p.spectator
      }))
      .sort((a, b) => b.score - a.score || b.kills - a.kills || b.bestMass - a.bestMass);

    this.winnerId = this.results.length ? this.results[0].id : null;
    this.version++;
  }

  toLobby(now = Date.now()) {
    this.state = 'lobby';
    this.results = [];
    this.winnerId = null;
    this.food = [];
    this.powerups = [];
    this.events = [];
    this.countdownEndsAt = 0;
    this.startedAt = 0;
    this.roundEndsAt = 0;
    this.endAt = 0;

    for (const player of this.players.values()) {
      player.alive = false;
      player.eliminated = false;
      player.spectator = false;
      player.respawnAt = 0;
      player.points = [];
      player.score = 0;
      player.kills = 0;
      player.deaths = 0;
      player.bestMass = 0;
      player.lives = CONFIG.START_LIVES;
      player.mass = CONFIG.BASE_MASS;
      player.radius = radiusFor(player.mass);
      player.invulnUntil = 0;
      player.buffs = { shieldUntil: 0, speedUntil: 0, magnetUntil: 0, doubleUntil: 0 };
    }

    this.version++;
  }

  /* ---------------------------- 地图物件 ---------------------------- */

  addFood(x, y, mass, now, ownerId = null) {
    if (this.food.length >= CONFIG.MAX_FOOD) return;
    this.food.push({
      id: ++this.foodSeq,
      x,
      y,
      mass,
      r: 4 + Math.min(3.5, mass * 0.45),
      c: Math.floor(this.rng() * FOOD_COLORS.length),
      ownerId,
      bornAt: now
    });
  }

  addRandomFood(now = Date.now()) {
    this.addFood(
      randRange(this.rng, 45, CONFIG.MAP_W - 45),
      randRange(this.rng, 45, CONFIG.MAP_H - 45),
      1,
      now
    );
  }

  ensureFood() {
    let added = 0;
    while (this.food.length < CONFIG.FOOD_COUNT && added < 8) {
      this.addRandomFood();
      added++;
    }
  }

  addRandomPowerup(now = Date.now()) {
    if (this.powerups.length >= CONFIG.POWERUP_MAX) return;
    const type = weightedPowerup(this.rng);
    let x = 0;
    let y = 0;
    let safe = false;

    for (let attempt = 0; attempt < 30 && !safe; attempt++) {
      x = randRange(this.rng, 160, CONFIG.MAP_W - 160);
      y = randRange(this.rng, 160, CONFIG.MAP_H - 160);
      safe = true;
      for (const player of this.players.values()) {
        if (player.alive && Math.hypot(player.x - x, player.y - y) < 260) {
          safe = false;
          break;
        }
      }
    }

    this.powerups.push({ id: ++this.powerupSeq, x, y, type, spawnedAt: now });
  }

  drainEvents() {
    const events = this.events;
    this.events = [];
    return events;
  }

  /* ---------------------------- 序列化 ---------------------------- */

  getLobby(now = Date.now()) {
    return {
      state: this.state,
      round: this.round,
      hostId: this.hostId,
      maxPlayers: CONFIG.MAX_PLAYERS,
      countdownLeft: this.state === 'countdown' ? Math.max(0, this.countdownEndsAt - now) : 0,
      nextAt: this.state === 'ended' ? this.endAt : 0,
      players: [...this.players.values()].map((player) => ({
        id: player.id,
        name: player.name,
        color: player.color,
        isHost: player.id === this.hostId,
        spectator: player.spectator,
        score: player.score,
        kills: player.kills
      }))
    };
  }

  snapshot(now = Date.now()) {
    const players = [...this.players.values()].map((player) => ({
      id: player.id,
      name: player.name,
      color: player.color,
      alive: player.alive,
      eliminated: player.eliminated,
      spectator: player.spectator,
      score: player.score,
      kills: player.kills,
      deaths: player.deaths,
      lives: player.lives,
      mass: Math.round(player.mass),
      radius: round1(player.radius),
      x: Math.round(player.x),
      y: Math.round(player.y),
      angle: Math.round(player.angle * 100) / 100,
      boosting: player.boosting,
      shield: player.buffs.shieldUntil > now,
      invuln: player.invulnUntil > now,
      respawnIn: player.respawnAt ? Math.max(0, Math.round(player.respawnAt - now)) : 0,
      buffs: {
        shield: Math.max(0, player.buffs.shieldUntil - now),
        speed: Math.max(0, player.buffs.speedUntil - now),
        magnet: Math.max(0, player.buffs.magnetUntil - now),
        double: Math.max(0, player.buffs.doubleUntil - now)
      },
      points: player.alive ? player.points.map((p) => [Math.round(p.x), Math.round(p.y)]) : []
    }));

    return {
      type: 'state',
      t: now,
      serverTime: now,
      timeLeft: Math.max(0, this.roundEndsAt - now),
      roundEndsAt: this.roundEndsAt,
      round: this.round,
      players,
      food: this.food.map((f) => [Math.round(f.x), Math.round(f.y), f.c, round1(f.mass)]),
      powerups: this.powerups.map((p) => [Math.round(p.x), Math.round(p.y), p.type]),
      aliveCount: players.filter((p) => p.alive).length,
      participants: players.filter((p) => !p.spectator).length
    };
  }
}

/* ---------------------------- 工具 ---------------------------- */

function cleanName(name) {
  const cleaned = String(name == null ? '' : name)
    .replace(/[<>&\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 12);
  return cleaned || '玩家';
}

function cleanColor(color) {
  if (typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color)) {
    return PLAYER_COLORS.includes(color.toLowerCase()) ? color.toLowerCase() : PLAYER_COLORS[0];
  }
  return PLAYER_COLORS[0];
}

module.exports = {
  Room,
  CONFIG,
  POWERUPS,
  FOOD_COLORS,
  PLAYER_COLORS,
  cleanName,
  cleanColor,
  radiusFor,
  lengthFor
};
