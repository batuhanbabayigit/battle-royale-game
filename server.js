const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const { Server } = require('socket.io');
const db = require('./db');
const { SKINS, COIN_PACKAGES, findSkin } = require('./shop');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// Signing secret is generated at boot if not supplied — no manual key entry needed.
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
const TOKEN_MAX_AGE = 30 * 24 * 3600; // 30 days (seconds)

app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

function signToken(user) {
  return jwt.sign({ uid: user.id, username: user.username, isAdmin: !!user.isAdmin }, JWT_SECRET, { expiresIn: TOKEN_MAX_AGE });
}

function verifyToken(token) {
  try { return jwt.verify(token, JWT_SECRET); } catch (e) { return null; }
}

function authMiddleware(req, res, next) {
  const token = req.cookies && req.cookies.token;
  const payload = token ? verifyToken(token) : null;
  if (!payload) return res.status(401).json({ ok: false, error: 'Giris yapmalisin' });
  const user = db.findById(payload.uid);
  if (!user) return res.status(401).json({ ok: false, error: 'Hesap bulunamadi' });
  req.user = user;
  next();
}

// ---------- AUTH API ----------
app.post('/api/register', (req, res) => {
  const { username, password } = req.body || {};
  const uname = String(username || '').trim();
  if (uname.length < 3 || uname.length > 16 || !/^[a-zA-Z0-9_ÇçĞğİıÖöŞşÜü]+$/.test(uname)) {
    return res.status(400).json({ ok: false, error: 'Kullanici adi 3-16 karakter olmali' });
  }
  if (!password || String(password).length < 4) {
    return res.status(400).json({ ok: false, error: 'Sifre en az 4 karakter olmali' });
  }
  if (db.findByUsername(uname)) {
    return res.status(400).json({ ok: false, error: 'Bu kullanici adi zaten alinmis' });
  }
  const passwordHash = bcrypt.hashSync(String(password), 10);
  const user = db.createUser({ username: uname, passwordHash, isAdmin: false });
  const token = signToken(user);
  res.cookie('token', token, { maxAge: TOKEN_MAX_AGE * 1000, httpOnly: false, sameSite: 'lax' });
  res.json({ ok: true, user: db.publicUser(user), token });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const user = db.findByUsername(String(username || ''));
  if (!user || !bcrypt.compareSync(String(password || ''), user.passwordHash)) {
    return res.status(400).json({ ok: false, error: 'Kullanici adi veya sifre hatali' });
  }
  const token = signToken(user);
  res.cookie('token', token, { maxAge: TOKEN_MAX_AGE * 1000, httpOnly: false, sameSite: 'lax' });
  res.json({ ok: true, user: db.publicUser(user), token });
});

app.post('/api/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ ok: true });
});

app.get('/api/me', authMiddleware, (req, res) => {
  res.json({ ok: true, user: db.publicUser(req.user) });
});

// ---------- SHOP API ----------
app.get('/api/shop', (req, res) => {
  res.json({ ok: true, skins: SKINS, coinPackages: COIN_PACKAGES });
});

app.post('/api/shop/buy', authMiddleware, (req, res) => {
  const { skinId } = req.body || {};
  const skin = findSkin(skinId);
  if (!skin) return res.status(400).json({ ok: false, error: 'Gecersiz skin' });
  const user = req.user;
  const owned = user.ownedSkins || ['default'];
  if (owned.includes(skin.id)) return res.status(400).json({ ok: false, error: 'Zaten sahipsin' });
  if (user.coins < skin.price) return res.status(400).json({ ok: false, error: 'Yetersiz coin' });
  user.coins -= skin.price;
  user.ownedSkins = owned.concat(skin.id);
  db.saveUser(user);
  res.json({ ok: true, user: db.publicUser(user) });
});

app.post('/api/shop/equip', authMiddleware, (req, res) => {
  const { skinId } = req.body || {};
  const skin = findSkin(skinId);
  const user = req.user;
  if (!skin || !(user.ownedSkins || []).includes(skin.id)) {
    return res.status(400).json({ ok: false, error: 'Bu skin sende yok' });
  }
  user.skin = skin.id;
  db.saveUser(user);
  res.json({ ok: true, user: db.publicUser(user) });
});

// Real-money purchase endpoint — becomes active once a payment provider
// (Stripe/iyzico) is connected with the owner's own account + API keys set
// directly in Railway's environment variables.
app.post('/api/shop/checkout', authMiddleware, (req, res) => {
  if (!process.env.STRIPE_SECRET_KEY) {
    return res.status(503).json({ ok: false, error: 'Odeme altyapisi henuz baglanmadi. Site sahibi kendi Stripe hesabini baglamali.' });
  }
  res.status(501).json({ ok: false, error: 'Odeme entegrasyonu yapilandiriliyor.' });
});

// ---------- ADMIN SEED ----------
(function seedAdmin() {
  const existing = db.findByUsername('batuhan');
  if (existing) {
    if (!existing.isAdmin) db.saveUser(Object.assign(existing, { isAdmin: true, coins: 999999, skin: 'admin' }));
    return;
  }
  const pass = crypto.randomBytes(5).toString('hex');
  const passwordHash = bcrypt.hashSync(pass, 10);
  db.createUser({ username: 'batuhan', passwordHash, isAdmin: true });
  console.log('==============================================');
  console.log('ADMIN HESABI OLUSTURULDU');
  console.log('kullanici adi: batuhan');
  console.log('sifre: ' + pass);
  console.log('Giris yaptiktan sonra sifreni degistirmen onerilir.');
  console.log('==============================================');
})();

// ---------- CONFIG ----------
const MAP_SIZE = 3000;
const TICK_RATE = 30;
const TICK_MS = 1000 / TICK_RATE;
const BOT_COUNT = 8;
const PLAYER_SPEED = 220; // px/sec
const PLAYER_RADIUS = 18;
const MAX_HP = 100;
const ZONE_DAMAGE_PER_SEC = 6;
const MAX_ARMOR = 60;

const WEAPONS = {
  pistol:  { name: 'Tabanca',        damage: 12, fireDelay: 300,  bulletSpeed: 950,  spread: 0.05, range: 620,  pellets: 1 },
  rifle:   { name: 'Tufek',          damage: 19, fireDelay: 140,  bulletSpeed: 1250, spread: 0.06, range: 950,  pellets: 1 },
  shotgun: { name: 'Pompali',        damage: 10, fireDelay: 750,  bulletSpeed: 850,  spread: 0.30, range: 380,  pellets: 6 },
  smg:     { name: 'Otomatik',       damage: 9,  fireDelay: 90,   bulletSpeed: 1050, spread: 0.09, range: 700,  pellets: 1 },
  sniper:  { name: 'Keskin Nisanci', damage: 58, fireDelay: 1150, bulletSpeed: 1700, spread: 0.008, range: 1400, pellets: 1 },
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

function newPlayer(id, name, isBot, opts) {
  opts = opts || {};
  const pos = randomFreePos(PLAYER_RADIUS + 10);
  return {
    id,
    name: (name || 'Oyuncu').slice(0, 16),
    isBot: !!isBot,
    userId: opts.userId || null,
    isAdmin: !!opts.isAdmin,
    skin: opts.skin || 'default',
    x: pos.x,
    y: pos.y,
    angle: 0,
    hp: MAX_HP,
    armorHp: 0,
    alive: true,
    weapon: 'pistol',
    kills: 0,
    lastShot: 0,
    input: { up: false, down: false, left: false, right: false, angle: 0, shooting: false },
    botState: { dir: Math.random() * Math.PI * 2, changeAt: 0, targetId: null, skill: 0.55 + Math.random() * 0.4 },
    place: null,
  };
}

function spawnLoot() {
  loot = [];
  const types = ['rifle', 'shotgun', 'smg', 'sniper', 'medkit', 'medkit', 'armor'];
  for (let i = 0; i < 80; i++) {
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
    p.x = pos.x; p.y = pos.y; p.hp = MAX_HP; p.armorHp = 0; p.alive = true; p.weapon = 'pistol'; p.kills = 0; p.place = null;
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
    io.emit('matchEnd', { winnerName: winner.name, winnerIsBot: winner.isBot, winnerIsAdmin: winner.isAdmin });
    if (winner.userId) db.incrementUser(winner.userId, { coins: 50, wins: 1 });
  } else {
    io.emit('matchEnd', { winnerName: null });
  }
}

let events = []; // transient visual events (hits, deaths, shots) sent to clients each tick then cleared

function damagePlayer(target, amount, sourceName) {
  if (!target.alive) return;
  let dmg = amount;
  if (target.armorHp > 0) {
    dmg = amount * 0.62;
    target.armorHp = Math.max(0, target.armorHp - amount);
  }
  target.hp -= dmg;
  if (sourceName !== 'Bolge') events.push({ type: 'hit', x: target.x, y: target.y });
  if (target.hp <= 0) {
    target.hp = 0;
    target.alive = false;
    target.place = alivePlayers().length + 1;
    killFeed.unshift({ text: (sourceName || 'Bolge') + ' ' + target.name + ' oyuncusunu eledi', t: Date.now() });
    killFeed = killFeed.slice(0, 6);
    events.push({ type: 'death', x: target.x, y: target.y });
  }
}

function fireWeapon(shooter) {
  const w = WEAPONS[shooter.weapon];
  const now = Date.now();
  if (now - shooter.lastShot < w.fireDelay) return;
  shooter.lastShot = now;
  events.push({ type: 'shot', x: shooter.x, y: shooter.y, angle: shooter.angle, weapon: shooter.weapon });
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
  return { pistol: 0, smg: 1, shotgun: 2, rifle: 3, sniper: 4 }[name] || 0;
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
    const engageRange = 420 + bs.skill * 220;
    if (nearest && nd < engageRange) {
      const toTarget = Math.atan2(nearest.y - bot.y, nearest.x - bot.x);
      bot.angle = toTarget;
      moveAngle = nd < 160 ? toTarget + Math.PI : toTarget;
      if (nd < engageRange * 0.9) fireWeapon(bot);
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
      } else if (l.type === 'armor') {
        p.armorHp = MAX_ARMOR;
      } else {
        if (weaponRank(l.type) > weaponRank(p.weapon)) p.weapon = l.type;
      }
      events.push({ type: 'pickup', x: p.x, y: p.y });
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
        const wasAlive = p.alive;
        damagePlayer(p, b.damage, b.ownerName);
        events.push({ type: 'hitmarker', ownerId: b.ownerId });
        if (wasAlive && !p.alive) {
          const shooter = players[b.ownerId];
          if (shooter) {
            shooter.kills++;
            events.push({ type: 'kill', ownerId: shooter.id });
            if (shooter.userId) db.incrementUser(shooter.userId, { coins: 5, kills: 1 });
          }
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
  events = [];
}

function broadcastState() {
  const alive = alivePlayers();
  const state = {
    phase: matchPhase,
    waitMs: Math.max(0, waitTimer),
    zone,
    players: Object.values(players).map((p) => ({
      id: p.id, name: p.name, x: p.x, y: p.y, angle: p.angle, hp: p.hp, armorHp: p.armorHp, alive: p.alive,
      weapon: p.weapon, isBot: p.isBot, isAdmin: p.isAdmin, skin: p.skin, kills: p.kills, place: p.place,
    })),
    bullets: bullets.map((b) => ({ x: b.x, y: b.y, id: b.id })),
    loot,
    aliveCount: alive.length,
    killFeed,
    events,
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
io.use((socket, next) => {
  const token = socket.handshake.auth && socket.handshake.auth.token;
  if (token) {
    const payload = verifyToken(token);
    if (payload) {
      const user = db.findById(payload.uid);
      if (user) socket.authUser = user;
    }
  }
  next();
});

io.on('connection', (socket) => {
  socket.on('join', (data) => {
    const authUser = socket.authUser;
    if (authUser) {
      players[socket.id] = newPlayer(socket.id, authUser.username, false, {
        userId: authUser.id, isAdmin: authUser.isAdmin, skin: authUser.skin,
      });
    } else {
      const name = (data && data.name ? String(data.name) : 'Oyuncu').slice(0, 16);
      players[socket.id] = newPlayer(socket.id, name, false, { skin: (data && data.skin) || 'default' });
    }
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
