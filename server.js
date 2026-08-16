const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));

// ---------- CONFIG ----------
const MAP_SIZE = 3000;
const TICK_RATE = 30;
const TICK_MS = 1000 / TICK_RATE;
const BOT_COUNT = 8;
const PLAYER_SPEED = 220; // px/sec
const PLAYER_RADIUS = 18;
const MAX_HP = 100;
const ZONE_DAMAGE_PER_SEC = 6;

const WEAPONS = {
  pistol:  { name: 'Tabanca',  damage: 12, fireDelay: 300, bulletSpeed: 950, spread: 0.05, range: 620, pellets: 1 },
  rifle:   { name: 'Tufek',    damage: 19, fireDelay: 140, bulletSpeed: 1250, spread: 0.06, range: 950, pellets: 1 },
  shotgun: { name: 'Pompali',  damage: 10, fireDelay: 750, bulletSpeed: 850, spread: 0.30, range: 380, pellets: 6 },
  smg:     { name: 'Otomatik', damage: 9,  fireDelay: 90,  bulletSpeed: 1050, spread: 0.09, range: 700, pellets: 1 },
};

const ZONE_PHASES = [
  { holdMs: 12000, shrinkMs: 18000, radiusFactor: 0.62 },
  { holdMs: 10000, shrinkMs: 16000, radiusFactor: 0.38 },
  { holdMs: 9000,  shrinkMs: 14000, radiusFactor: 0.20 },
  { holdMs: 7000,  shrinkMs: 11000, radiusFactor: 0.08 },
  { holdMs: 6000,  shrinkMs: 9000,  radiusFactor: 0.0 },
];

// Static obstacles (rectangles) for cover
const OBSTACLES = [];
(function buildObstacles() {
  const rand = (a, b) => a + Math.random() * (b - a);
  for (let i = 0; i < 26; i++) {
    OBSTACLES.push({
      x: rand(150, MAP_SIZE - 150),
      y: rand(150, MAP_SIZE - 150),
      w: rand(80, 220),
      h: rand(80, 220),
    });
  }
})();

function rectContains(rect, x, y, pad) {
  return x > rect.x - pad && x < rect.x + rect.w + pad && y > rect.y - pad && y < rect.y + rect.h + pad;
}

function randomFreePos(pad) {
  let tries = 0;
  while (tries < 40) {
    const x = 60 + Math.random() * (MAP_SIZE - 120);
    const y = 60 + Math.random() * (MAP_SIZE - 120);
    if (!OBSTACLES.some((r) => rectContains(r, x, y, pad))) return { x, y };
    tries++;
  }
  return { x: MAP_SIZE / 2, y: MAP_SIZE / 2 };
}

// ---------- STATE ----------
let players = {}; // id -> player object (includes bots, flagged isBot)
let bullets = [];
let loot = [];
let lootSeq = 1;
let bulletSeq = 1;

let zone = { x: MAP_SIZE / 2, y: MAP_SIZE / 2, radius: MAP_SIZE * 0.72, from: MAP_SIZE * 0.72, to: MAP_SIZE * 0.72, phaseStart: 0 };
let phaseIndex = -1;
let matchPhase = 'waiting'; // waiting | playing | ended
let waitTimer = 8000;
let restartTimer = 0;
let killFeed = [];

function makeBotName(i) {
  const names = ['Kartal', 'Kurt', 'Sahin', 'Yilmaz', 'Demir', 'Volkan', 'Baran', 'Ejder', 'Kaya', 'Firtina', 'Ruzgar', 'Celik'];
  return names[i % names.length] + '_' + (i + 1);
}

function newPlayer(id, name, isBot) {
  const pos = randomFreePos(PLAYER_RADIUS + 10);
  return {
    id,
    name: (name || 'Oyuncu').slice(0, 16),
    isBot: !!isBot,
    x: pos.x,
    y: pos.y,
    angle: 0,
    hp: MAX_HP,
    alive: true,
    weapon: 'pistol',
    kills: 0,
    lastShot: 0,
    input: { up: false, down: false, left: false, right: false, angle: 0, shooting: false },
    botState: { dir: Math.random() * Math.PI * 2, changeAt: 0, targetId: null },
    place: null,
  };
}

function spawnLoot() {
  loot = [];
  const types = ['rifle', 'shotgun', 'smg', 'medkit', 'medkit'];
  for (let i = 0; i < 70; i++) {
    const pos = randomFreePos(20);
    const type = types[Math.floor(Math.random() * types.length)];
    loot.push({ id: lootSeq++, x: pos.x, y: pos.y, type });
  }
}

function alivePlayers() {
  return Object.values(players).filter((p) => p.alive);
}

function startMatch() {
  matchPhase = 'playing';
  phaseIndex = -1;
  zone = { x: MAP_SIZE / 2, y: MAP_SIZE / 2, radius: MAP_SIZE * 0.72, from: MAP_SIZE * 0.72, to: MAP_SIZE * 0.72, phaseStart: Date.now() };
  spawnLoot();
  killFeed = [];
  Object.values(players).forEach((p) => {
    const pos = randomFreePos(PLAYER_RADIUS + 10);
    p.x = pos.x; p.y = pos.y; p.hp = MAX_HP; p.alive = true; p.weapon = 'pistol'; p.kills = 0; p.place = null;
  });
  advanceZonePhase();
}

function advanceZonePhase() {
  phaseIndex++;
  if (phaseIndex >= ZONE_PHASES.length) return;
  const phase = ZONE_PHASES[phaseIndex];
  const nx = 200 + Math.random() * (MAP_SIZE - 400);
  const ny = 200 + Math.random() * (MAP_SIZE - 400);
  const newRadius = MAP_SIZE * 0.72 * phase.radiusFactor + 60;
  zone.from = zone.radius;
  zone.to = newRadius;
  zone.fromX = zone.x; zone.fromY = zone.y;
  zone.toX = zone.x + (nx - zone.x) * 0.5;
  zone.toY = zone.y + (ny - zone.y) * 0.5;
  zone.holdMs = phase.holdMs;
  zone.shrinkMs = phase.shrinkMs;
  zone.phaseStart = Date.now();
  zone.stage = 'hold';
}

function updateZone() {
  if (phaseIndex < 0 || phaseIndex >= ZONE_PHASES.length) return;
  const elapsed = Date.now() - zone.phaseStart;
  if (zone.stage === 'hold') {
    if (elapsed >= zone.holdMs) { zone.stage = 'shrink'; zone.phaseStart = Date.now(); }
  } else if (zone.stage === 'shrink') {
    const t = Math.min(1, elapsed / zone.shrinkMs);
    zone.radius = zone.from + (zone.to - zone.from) * t;
    zone.x = zone.fromX + (zone.toX - zone.fromX) * t;
    zone.y = zone.fromY + (zone.toY - zone.fromY) * t;
    if (t >= 1) advanceZonePhase();
  }
}

function endMatch(winner) {
  matchPhase = 'ended';
  restartTimer = 8000;
  if (winner) {
    io.emit('matchEnd', { winnerName: winner.name, winnerIsBot: winner.isBot });
  } else {
    io.emit('matchEnd', { winnerName: null });
  }
}

function damagePlayer(target, amount, sourceName) {
  if (!target.alive) return;
  target.hp -= amount;
  if (target.hp <= 0) {
    target.hp = 0;
    target.alive = false;
    target.place = alivePlayers().length + 1;
    killFeed.unshift({ text: `${sourceName || 'Bolge'} ${target.name} oyuncusunu eledi`, t: Date.now() });
    killFeed = killFeed.slice(0, 6);
  }
}

function fireWeapon(shooter) {
  const w = WEAPONS[shooter.weapon];
  const now = Date.now();
  if (now - shooter.lastShot < w.fireDelay) return;
  shooter.lastShot = now;
  const pellets = w.pellets || 1;
  for (let i = 0; i < pellets; i++) {
    const spread = (Math.random() - 0.5) * w.spread * (pellets > 1 ? 2.2 : 1);
    const a = shooter.angle + spread;
    bullets.push({
      id: bulletSeq++,
      x: shooter.x + Math.cos(a) * (PLAYER_RADIUS + 4),
      y: shooter.y + Math.sin(a) * (PLAYER_RADIUS + 4),
      vx: Math.cos(a) * w.bulletSpeed,
      vy: Math.sin(a) * w.bulletSpeed,
      damage: w.damage,
      ownerId: shooter.id,
      ownerName: shooter.name,
      dist: 0,
      maxDist: w.range,
    });
  }
}

function weaponRank(name) {
  return { pistol: 0, smg: 1, shotgun: 2, rifle: 3 }[name] || 0;
}

function tickBots(dt) {
  const botsArr = Object.values(players).filter((p) => p.isBot);
  const alive = alivePlayers();
  botsArr.forEach((bot) => {
    if (!bot.alive) return;
    const bs = bot.botState;
    let nearest = null, nd = Infinity;
    alive.forEach((p) => {
      if (p.id === bot.id) return;
      const d = Math.hypot(p.x - bot.x, p.y - bot.y);
      if (d < nd) { nd = d; nearest = p; }
    });
    let moveAngle = bs.dir;
    if (nearest && nd < 520) {
      const toTarget = Math.atan2(nearest.y - bot.y, nearest.x - bot.x);
      bot.angle = toTarget;
      moveAngle = nd < 160 ? toTarget + Math.PI : toTarget;
      if (nd < 480) fireWeapon(bot);
    } else {
      if (now() > bs.changeAt) {
        bs.dir = Math.random() * Math.PI * 2;
        bs.changeAt = now() + 1500 + Math.random() * 2000;
      }
      bot.angle = bs.dir;
    }
    const distToZoneCenter = Math.hypot(bot.x - zone.x, bot.y - zone.y);
    if (distToZoneCenter > zone.radius - 60) {
      moveAngle = Math.atan2(zone.y - bot.y, zone.x - bot.x);
    }
    const nx = bot.x + Math.cos(moveAngle) * PLAYER_SPEED * dt;
    const ny = bot.y + Math.sin(moveAngle) * PLAYER_SPEED * dt;
    if (!blockedByObstacle(nx, ny)) { bot.x = nx; bot.y = ny; }
    bot.x = clamp(bot.x, 20, MAP_SIZE - 20);
    bot.y = clamp(bot.y, 20, MAP_SIZE - 20);
    checkLootPickup(bot);
  });
}

function now() { return Date.now(); }
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

function blockedByObstacle(x, y) {
  return OBSTACLES.some((r) => rectContains(r, x, y, PLAYER_RADIUS - 4));
}

function checkLootPickup(p) {
  for (let i = loot.length - 1; i >= 0; i--) {
    const l = loot[i];
    if (Math.hypot(l.x - p.x, l.y - p.y) < PLAYER_RADIUS + 16) {
      if (l.type === 'medkit') {
        p.hp = Math.min(MAX_HP, p.hp + 45);
      } else {
        if (weaponRank(l.type) > weaponRank(p.weapon)) p.weapon = l.type;
      }
      loot.splice(i, 1);
    }
  }
}

function tickPlayers(dt) {
  Object.values(players).forEach((p) => {
    if (p.isBot || !p.alive) return;
    const inp = p.input;
    let dx = 0, dy = 0;
    if (inp.up) dy -= 1;
    if (inp.down) dy += 1;
    if (inp.left) dx -= 1;
    if (inp.right) dx += 1;
    if (dx || dy) {
      const len = Math.hypot(dx, dy);
      const nx = p.x + (dx / len) * PLAYER_SPEED * dt;
      const ny = p.y + (dy / len) * PLAYER_SPEED * dt;
      if (!blockedByObstacle(nx, p.y)) p.x = nx;
      if (!blockedByObstacle(p.x, ny)) p.y = ny;
      p.x = clamp(p.x, 20, MAP_SIZE - 20);
      p.y = clamp(p.y, 20, MAP_SIZE - 20);
    }
    p.angle = inp.angle;
    if (inp.shooting) fireWeapon(p);
    checkLootPickup(p);
  });
}

function tickBullets(dt) {
  bullets = bullets.filter((b) => {
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    b.dist += Math.hypot(b.vx, b.vy) * dt;
    if (b.dist > b.maxDist) return false;
    if (b.x < 0 || b.y < 0 || b.x > MAP_SIZE || b.y > MAP_SIZE) return false;
    if (OBSTACLES.some((r) => rectContains(r, b.x, b.y, 0))) return false;
    for (const p of Object.values(players)) {
      if (!p.alive || p.id === b.ownerId) continue;
      if (Math.hypot(p.x - b.x, p.y - b.y) < PLAYER_RADIUS) {
        damagePlayer(p, b.damage, b.ownerName);
        if (!p.alive) {
          const shooter = players[b.ownerId];
          if (shooter) shooter.kills++;
        }
        return false;
      }
    }
    return true;
  });
}

function tickZoneDamage(dt) {
  Object.values(players).forEach((p) => {
    if (!p.alive) return;
    const d = Math.hypot(p.x - zone.x, p.y - zone.y);
    if (d > zone.radius) {
      damagePlayer(p, ZONE_DAMAGE_PER_SEC * dt, 'Bolge');
    }
  });
}

function checkMatchEnd() {
  const alive = alivePlayers();
  const humans = Object.values(players).filter((p) => !p.isBot);
  if (humans.length === 0) return;
  if (matchPhase === 'playing' && alive.length <= 1) {
    endMatch(alive[0] || null);
  }
}

let lastTick = Date.now();
function gameLoop() {
  const t = Date.now();
  const dt = Math.min(0.1, (t - lastTick) / 1000);
  lastTick = t;

  const humanCount = Object.values(players).filter((p) => !p.isBot).length;

  if (matchPhase === 'waiting') {
    if (humanCount > 0) {
      waitTimer -= TICK_MS;
      if (waitTimer <= 0) startMatch();
    } else {
      waitTimer = 8000;
    }
  } else if (matchPhase === 'playing') {
    updateZone();
    tickPlayers(dt);
    tickBots(dt);
    tickBullets(dt);
    tickZoneDamage(dt);
    checkMatchEnd();
  } else if (matchPhase === 'ended') {
    restartTimer -= TICK_MS;
    if (restartTimer <= 0) {
      const humanCount2 = Object.values(players).filter((p) => !p.isBot).length;
      if (humanCount2 > 0) startMatch(); else { matchPhase = 'waiting'; waitTimer = 8000; }
    }
  }

  broadcastState();
}

function broadcastState() {
  const alive = alivePlayers();
  const state = {
    phase: matchPhase,
    waitMs: Math.max(0, waitTimer),
    zone,
    players: Object.values(players).map((p) => ({
      id: p.id, name: p.name, x: p.x, y: p.y, angle: p.angle, hp: p.hp, alive: p.alive,
      weapon: p.weapon, isBot: p.isBot, kills: p.kills, place: p.place,
    })),
    bullets: bullets.map((b) => ({ x: b.x, y: b.y, id: b.id })),
    loot,
    aliveCount: alive.length,
    killFeed,
  };
  io.emit('state', state);
}

setInterval(gameLoop, TICK_MS);

// ---------- BOTS INIT ----------
for (let i = 0; i < BOT_COUNT; i++) {
  const id = 'bot_' + i;
  players[id] = newPlayer(id, makeBotName(i), true);
}
spawnLoot();

// ---------- SOCKET.IO ----------
io.on('connection', (socket) => {
  socket.on('join', (data) => {
    const name = (data && data.name ? String(data.name) : 'Oyuncu').slice(0, 16);
    players[socket.id] = newPlayer(socket.id, name, false);
    socket.emit('joined', {
      id: socket.id,
      mapSize: MAP_SIZE,
      obstacles: OBSTACLES,
      weapons: WEAPONS,
    });
  });

  socket.on('input', (data) => {
    const p = players[socket.id];
    if (!p) return;
    p.input.up = !!data.up;
    p.input.down = !!data.down;
    p.input.left = !!data.left;
    p.input.right = !!data.right;
    p.input.angle = typeof data.angle === 'number' ? data.angle : p.input.angle;
    p.input.shooting = !!data.shooting;
  });

  socket.on('disconnect', () => {
    delete players[socket.id];
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Battle Royale server running on :' + PORT));
