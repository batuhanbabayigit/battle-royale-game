/* global io */
(function () {
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  const minimapCanvas = document.getElementById('minimap');
  const mctx = minimapCanvas.getContext('2d');

  const startScreen = document.getElementById('startScreen');
  const nameInput = document.getElementById('nameInput');
  const playBtn = document.getElementById('playBtn');
  const hud = document.getElementById('hud');
  const hpFill = document.getElementById('hpFill');
  const weaponLabel = document.getElementById('weaponLabel');
  const aliveCountEl = document.getElementById('aliveCount');
  const killFeedEl = document.getElementById('killFeed');
  const overlay = document.getElementById('overlay');
  const overlayText = document.getElementById('overlayText');
  const overlaySub = document.getElementById('overlaySub');
  const waitBanner = document.getElementById('waitBanner');
  const touchControls = document.getElementById('touchControls');
  const joystick = document.getElementById('joystick');
  const joystickKnob = document.getElementById('joystickKnob');
  const shootBtn = document.getElementById('shootBtn');

  let socket = null;
  let myId = null;
  let mapSize = 3000;
  let obstacles = [];
  let weapons = {};
  let latestState = null;
  let joined = false;
  let camera = { x: 0, y: 0 };

  const WEAPON_LABELS = { pistol: 'Tabanca', rifle: 'Tüfek', shotgun: 'Pompalı', smg: 'Otomatik' };
  const WEAPON_COLORS = { pistol: '#9fb3c8', rifle: '#e8b84b', shotgun: '#e8574b', smg: '#4be89a' };

  function resize() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  }
  window.addEventListener('resize', resize);
  resize();

  const isTouch = 'ontouchstart' in window;
  if (isTouch) touchControls.classList.add('visible');

  // ---------- INPUT ----------
  const keys = { up: false, down: false, left: false, right: false };
  let aimAngle = 0;
  let shooting = false;
  let mouseX = window.innerWidth / 2;
  let mouseY = window.innerHeight / 2;

  window.addEventListener('keydown', (e) => {
    if (e.key === 'w' || e.key === 'ArrowUp') keys.up = true;
    if (e.key === 's' || e.key === 'ArrowDown') keys.down = true;
    if (e.key === 'a' || e.key === 'ArrowLeft') keys.left = true;
    if (e.key === 'd' || e.key === 'ArrowRight') keys.right = true;
  });
  window.addEventListener('keyup', (e) => {
    if (e.key === 'w' || e.key === 'ArrowUp') keys.up = false;
    if (e.key === 's' || e.key === 'ArrowDown') keys.down = false;
    if (e.key === 'a' || e.key === 'ArrowLeft') keys.left = false;
    if (e.key === 'd' || e.key === 'ArrowRight') keys.right = false;
  });
  window.addEventListener('mousemove', (e) => { mouseX = e.clientX; mouseY = e.clientY; });
  window.addEventListener('mousedown', () => { shooting = true; });
  window.addEventListener('mouseup', () => { shooting = false; });

  // touch joystick
  let joyActive = false, joyStartX = 0, joyStartY = 0, joyDX = 0, joyDY = 0;
  joystick.addEventListener('touchstart', (e) => {
    const t = e.changedTouches[0];
    joyActive = true; joyStartX = t.clientX; joyStartY = t.clientY;
    e.preventDefault();
  }, { passive: false });
  window.addEventListener('touchmove', (e) => {
    if (!joyActive) return;
    const t = [...e.changedTouches].find((tt) => true);
    if (!t) return;
    joyDX = t.clientX - joyStartX;
    joyDY = t.clientY - joyStartY;
    const max = 40;
    const len = Math.hypot(joyDX, joyDY);
    if (len > max) { joyDX = (joyDX / len) * max; joyDY = (joyDY / len) * max; }
    joystickKnob.style.transform = `translate(${joyDX}px, ${joyDY}px)`;
  }, { passive: false });
  window.addEventListener('touchend', () => {
    joyActive = false; joyDX = 0; joyDY = 0;
    joystickKnob.style.transform = 'translate(0,0)';
  });
  shootBtn.addEventListener('touchstart', (e) => { shooting = true; e.preventDefault(); }, { passive: false });
  shootBtn.addEventListener('touchend', () => { shooting = false; });

  // ---------- SOCKET ----------
  function connect(name) {
    socket = io();
    socket.emit('join', { name });
    socket.on('joined', (data) => {
      myId = data.id;
      mapSize = data.mapSize;
      obstacles = data.obstacles;
      weapons = data.weapons;
      joined = true;
      startScreen.classList.add('hidden');
      hud.classList.remove('hidden');
    });
    socket.on('state', (state) => { latestState = state; });
    socket.on('matchEnd', (data) => {
      overlay.classList.remove('hidden');
      if (data.winnerName) {
        const isMe = latestState && latestState.players.find((p) => p.id === myId && p.name === data.winnerName);
        overlayText.textContent = data.winnerIsBot ? `${data.winnerName} kazandı` : (isMe ? 'ZAFER! #1' : `${data.winnerName} kazandı`);
      } else {
        overlayText.textContent = 'Maç bitti';
      }
      overlaySub.textContent = 'Yeni maç birazdan başlıyor...';
      setTimeout(() => overlay.classList.add('hidden'), 6500);
    });
  }

  playBtn.addEventListener('click', () => {
    const name = nameInput.value.trim() || 'Oyuncu';
    connect(name);
  });
  nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') playBtn.click(); });

  // ---------- SEND INPUT LOOP ----------
  setInterval(() => {
    if (!joined || !socket) return;
    let up = keys.up, down = keys.down, left = keys.left, right = keys.right;
    if (isTouch && (joyDX || joyDY)) {
      up = joyDY < -8; down = joyDY > 8; left = joyDX < -8; right = joyDX > 8;
    }
    socket.emit('input', { up, down, left, right, angle: aimAngle, shooting });
  }, 1000 / 30);

  // ---------- RENDER LOOP ----------
  function draw() {
    requestAnimationFrame(draw);
    if (!ctx) return;
    ctx.fillStyle = '#0d1b12';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (!latestState || !joined) return;

    const me = latestState.players.find((p) => p.id === myId);
    if (me) {
      camera.x = me.x; camera.y = me.y;
      if (!isTouch) {
        const dx = mouseX - canvas.width / 2;
        const dy = mouseY - canvas.height / 2;
        aimAngle = Math.atan2(dy, dx);
      } else if (joyDX || joyDY) {
        aimAngle = Math.atan2(joyDY, joyDX);
      }
    }

    ctx.save();
    ctx.translate(canvas.width / 2 - camera.x, canvas.height / 2 - camera.y);

    // background grid
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.lineWidth = 1;
    const gridSize = 100;
    const startX = Math.floor((camera.x - canvas.width) / gridSize) * gridSize;
    const startY = Math.floor((camera.y - canvas.height) / gridSize) * gridSize;
    for (let x = startX; x < camera.x + canvas.width; x += gridSize) {
      ctx.beginPath(); ctx.moveTo(x, camera.y - canvas.height); ctx.lineTo(x, camera.y + canvas.height); ctx.stroke();
    }
    for (let y = startY; y < camera.y + canvas.height; y += gridSize) {
      ctx.beginPath(); ctx.moveTo(camera.x - canvas.width, y); ctx.lineTo(camera.x + canvas.width, y); ctx.stroke();
    }

    // map border
    ctx.strokeStyle = '#4b3b2a';
    ctx.lineWidth = 8;
    ctx.strokeRect(0, 0, mapSize, mapSize);

    // obstacles
    ctx.fillStyle = '#3a4a3a';
    ctx.strokeStyle = '#22301f';
    obstacles.forEach((r) => {
      ctx.fillRect(r.x, r.y, r.w, r.h);
      ctx.strokeRect(r.x, r.y, r.w, r.h);
    });

    // zone (danger area outside circle) + circle line
    const z = latestState.zone;
    if (z) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(camera.x - canvas.width, camera.y - canvas.height, canvas.width * 2, canvas.height * 2);
      ctx.arc(z.x, z.y, z.radius, 0, Math.PI * 2, true);
      ctx.fillStyle = 'rgba(150,20,20,0.28)';
      ctx.fill('evenodd');
      ctx.restore();
      ctx.beginPath();
      ctx.arc(z.x, z.y, z.radius, 0, Math.PI * 2);
      ctx.strokeStyle = '#ffdf6b';
      ctx.lineWidth = 4;
      ctx.stroke();
    }

    // loot
    latestState.loot.forEach((l) => {
      ctx.save();
      ctx.translate(l.x, l.y);
      const color = l.type === 'medkit' ? '#4be86b' : (WEAPON_COLORS[l.type] || '#fff');
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(0, 0, 10, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#0b0f0b';
      ctx.font = 'bold 9px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(l.type === 'medkit' ? '+' : (WEAPON_LABELS[l.type] || '?').slice(0, 1), 0, 3);
      ctx.restore();
    });

    // bullets
    ctx.fillStyle = '#ffe27a';
    latestState.bullets.forEach((b) => {
      ctx.beginPath();
      ctx.arc(b.x, b.y, 4, 0, Math.PI * 2);
      ctx.fill();
    });

    // players
    latestState.players.forEach((p) => {
      if (!p.alive) return;
      ctx.save();
      ctx.translate(p.x, p.y);
      // gun direction
      ctx.rotate(p.angle);
      ctx.fillStyle = '#2b2f36';
      ctx.fillRect(10, -3, 20, 6);
      ctx.restore();

      ctx.beginPath();
      ctx.arc(p.x, p.y, 18, 0, Math.PI * 2);
      ctx.fillStyle = p.id === myId ? '#3ba9ff' : (p.isBot ? '#c78a3a' : '#e35b5b');
      ctx.fill();
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(0,0,0,0.4)';
      ctx.stroke();

      // name + hp bar
      ctx.font = '11px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillStyle = '#fff';
      ctx.fillText(p.name, p.x, p.y - 28);
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.fillRect(p.x - 18, p.y - 24, 36, 5);
      ctx.fillStyle = p.hp > 40 ? '#4be86b' : '#e8574b';
      ctx.fillRect(p.x - 18, p.y - 24, 36 * (p.hp / 100), 5);
    });

    ctx.restore();

    // ---- HUD updates ----
    if (me) {
      hpFill.style.width = Math.max(0, me.hp) + '%';
      weaponLabel.textContent = WEAPON_LABELS[me.weapon] || me.weapon;
    }
    aliveCountEl.textContent = latestState.aliveCount + ' / ' + latestState.players.length + ' hayatta';

    killFeedEl.innerHTML = '';
    latestState.killFeed.slice(0, 5).forEach((k) => {
      const div = document.createElement('div');
      div.className = 'killItem';
      div.textContent = k.text;
      killFeedEl.appendChild(div);
    });

    if (latestState.phase === 'waiting') {
      waitBanner.classList.remove('hidden');
      waitBanner.textContent = 'Maç başlamak üzere: ' + Math.ceil(latestState.waitMs / 1000) + 's';
    } else {
      waitBanner.classList.add('hidden');
    }

    if (me && !me.alive && latestState.phase === 'playing') {
      overlay.classList.remove('hidden');
      overlayText.textContent = 'Elendin';
      overlaySub.textContent = (me.place ? '#' + me.place + ' sırada bitirdin' : '') + ' — sonraki maçı bekle';
    } else if (latestState.phase === 'playing') {
      overlay.classList.add('hidden');
    }

    // minimap
    mctx.clearRect(0, 0, minimapCanvas.width, minimapCanvas.height);
    const scale = minimapCanvas.width / mapSize;
    mctx.fillStyle = 'rgba(0,0,0,0.35)';
    mctx.fillRect(0, 0, minimapCanvas.width, minimapCanvas.height);
    if (z) {
      mctx.beginPath();
      mctx.arc(z.x * scale, z.y * scale, z.radius * scale, 0, Math.PI * 2);
      mctx.strokeStyle = '#ffdf6b';
      mctx.lineWidth = 1.5;
      mctx.stroke();
    }
    latestState.players.forEach((p) => {
      if (!p.alive) return;
      mctx.beginPath();
      mctx.arc(p.x * scale, p.y * scale, p.id === myId ? 3.5 : 2.5, 0, Math.PI * 2);
      mctx.fillStyle = p.id === myId ? '#3ba9ff' : (p.isBot ? '#c78a3a' : '#e35b5b');
      mctx.fill();
    });
  }
  requestAnimationFrame(draw);
})();
