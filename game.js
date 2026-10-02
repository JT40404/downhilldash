(() => {
  'use strict';

  // ---------- Setup ----------
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  const $ = (id) => document.getElementById(id);
  const hud = { dist: $('hDist'), speed: $('hSpeed'), time: $('hTime'), style: $('hStyle'), boost: $('hBoost') };
  const overlay = $('overlay'), dlgTitle = $('dlgTitle'), dlgBody = $('dlgBody'), dlgBtn = $('dlgBtn');
  const warn = $('warn'), boostBtn = $('boostBtn');

  const CELL = 320;            // world chunk size (px)
  const PX_PER_M = 16;         // pixels per meter
  const MONSTER_AT_M = 2000;   // when the walrus shows up
  const GRAVITY = 1100;
  const TARGET = [520, 440, 270, 0]; // target speed by |dir| (0 = straight down, 3 = sideways/stopped)
  const BOOST_MULT = 1.6;
  const SKIER_HIT = 8;
  const SKIER_SCREEN_Y = 0.32;
  const RADIUS = { tree: 11, dead: 7, rock: 10, mogul: 18, ramp: 24 };

  let W = 0, H = 0, DPR = 1;
  function resize() {
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth; H = window.innerHeight;
    canvas.width = Math.floor(W * DPR); canvas.height = Math.floor(H * DPR);
    canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  }
  window.addEventListener('resize', resize);
  resize();

  // ---------- Seeded world generation ----------
  let worldSeed = 1;
  function hash2(x, y) {
    let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return (h ^ (h >>> 16) ^ worldSeed) >>> 0;
  }
  function rng(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const cells = new Map();
  function cell(cx, cy) {
    const k = cx + ',' + cy;
    let c = cells.get(k);
    if (!c) { c = genCell(cx, cy); cells.set(k, c); }
    return c;
  }
  function genCell(cx, cy) {
    const r = rng(hash2(cx, cy));
    const out = [];
    const depthM = Math.max(0, (cy * CELL) / PX_PER_M);
    const n = 2 + Math.floor(r() * 3 + Math.min(3, depthM / 1200));
    for (let i = 0; i < n; i++) {
      const x = cx * CELL + r() * CELL;
      const y = cy * CELL + r() * CELL;
      const v = r(), s = 0.8 + r() * 0.5, seed = r();
      if (Math.abs(x) < 240 && y > -500 && y < 600) continue; // clear start area
      let type;
      if (v < 0.46) type = 'tree';
      else if (v < 0.56) type = 'dead';
      else if (v < 0.70) type = 'rock';
      else if (v < 0.93) type = 'mogul';
      else type = 'ramp';
      out.push({ type, x, y, s, seed, r: RADIUS[type] * (type === 'tree' ? s : 1), last: -9 });
    }
    return out;
  }
  function pruneCells() {
    const scx = Math.floor(skier.x / CELL), scy = Math.floor(skier.y / CELL);
    for (const k of cells.keys()) {
      const [cx, cy] = k.split(',').map(Number);
      if (cy < scy - 4 || Math.abs(cx - scx) > 10) cells.delete(k);
    }
  }

  // ---------- State ----------
  const S = { mode: 'title', paused: false, time: 0, style: 0, crashes: 0, dist: 0, shake: 0, best: loadBest() };
  let skier, monster, trail, popups, trailTimer = 0;

  function loadBest() { try { return Number(localStorage.getItem('downhill_best')) || 0; } catch { return 0; } }
  function saveBest(v) { try { localStorage.setItem('downhill_best', String(v)); } catch { /* ignore */ } }

  function reset() {
    worldSeed = (Math.random() * 1e9) | 0;
    cells.clear();
    skier = { x: 0, y: 0, z: 0, vz: 0, vx: 0, vy: 0, dir: 0, state: 'ski', crashT: 0, invuln: 0, air: 0, stamina: 1, boosting: false };
    monster = { active: false, x: 0, y: 0, t: 0, state: 'chase', eatT: 0 };
    trail = []; popups = [];
    Object.assign(S, { paused: false, time: 0, style: 0, crashes: 0, dist: 0, shake: 0 });
  }

  // ---------- Input ----------
  const input = { boostKey: false, boostPtr: false, boostBtn: false, pointerSteer: false, ptrType: 'mouse', touchDown: false, px: 0, py: 0 };
  const BLOCK = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', ' '];

  window.addEventListener('keydown', (e) => {
    const k = e.key;
    if (BLOCK.includes(k)) e.preventDefault();
    if (S.mode !== 'play') { if ((k === ' ' || k === 'Enter') && !e.repeat) dlgBtn.click(); return; }
    if (k === 'p' || k === 'P' || k === 'Escape') { togglePause(); return; }
    if (S.paused) { if (k === ' ' || k === 'Enter') togglePause(); return; }
    if (k === 'Shift' || k === 'f' || k === 'F') { input.boostKey = true; return; }
    input.pointerSteer = false;
    steerKey(k);
  });
  window.addEventListener('keyup', (e) => {
    if (e.key === 'Shift' || e.key === 'f' || e.key === 'F') input.boostKey = false;
  });

  function steerKey(k) {
    const s = skier;
    if (s.state !== 'ski') return;
    if (k === 'ArrowLeft' || k === 'a' || k === 'A') {
      if (s.dir > -3) s.dir--; else if (s.z <= 0) s.x -= 28;
    } else if (k === 'ArrowRight' || k === 'd' || k === 'D') {
      if (s.dir < 3) s.dir++; else if (s.z <= 0) s.x += 28;
    } else if (k === 'ArrowDown' || k === 's' || k === 'S') {
      s.dir = 0;
    } else if (k === 'ArrowUp' || k === 'w' || k === 'W') {
      s.dir = s.dir < 0 ? -3 : 3;
    }
  }

  canvas.addEventListener('pointermove', (e) => {
    input.px = e.clientX; input.py = e.clientY; input.ptrType = e.pointerType;
    if (e.pointerType === 'mouse' || input.touchDown) input.pointerSteer = true;
  });
  canvas.addEventListener('pointerdown', (e) => {
    input.px = e.clientX; input.py = e.clientY; input.ptrType = e.pointerType;
    if (S.mode !== 'play') return;
    if (e.pointerType === 'mouse') input.boostPtr = true;
    else { input.touchDown = true; input.pointerSteer = true; }
  });
  const ptrUp = () => { input.boostPtr = false; input.touchDown = false; };
  window.addEventListener('pointerup', ptrUp);
  window.addEventListener('pointercancel', ptrUp);

  const boostOn = (e) => { e.preventDefault(); input.boostBtn = true; boostBtn.classList.add('down'); };
  const boostOff = () => { input.boostBtn = false; boostBtn.classList.remove('down'); };
  boostBtn.addEventListener('pointerdown', boostOn);
  boostBtn.addEventListener('pointerup', boostOff);
  boostBtn.addEventListener('pointerleave', boostOff);
  boostBtn.addEventListener('pointercancel', boostOff);

  window.addEventListener('blur', () => { if (S.mode === 'play' && !S.paused) togglePause(); });

  // ---------- Dialogs ----------
  let dlgAction = () => {};
  dlgBtn.addEventListener('click', () => dlgAction());

  function showDialog(title, html, btnText, action) {
    dlgTitle.textContent = title;
    dlgBody.innerHTML = html;
    dlgBtn.textContent = btnText;
    dlgAction = action;
    overlay.classList.remove('hidden');
    dlgBtn.focus({ preventScroll: true });
  }
  function hideDialog() { overlay.classList.add('hidden'); }

  const CONTROLS = `
    <dl class="controls">
      <dt>← →</dt><dd>Turn (keep pressing to stop and side-step)</dd>
      <dt>↓ / ↑</dt><dd>Point straight down / stop</dd>
      <dt>Shift or F</dt><dd>Boost (uses the boost bar)</dd>
      <dt>Mouse</dt><dd>Point to steer, hold click to boost</dd>
      <dt>Touch</dt><dd>Drag to steer, hold BOOST</dd>
      <dt>P</dt><dd>Pause</dd>
    </dl>`;

  function showTitle() {
    S.mode = 'title';
    showDialog('Downhill Dash',
      `<p class="big">Downhill Dash</p>
       <p>Ski as far down the mountain as you can. Trees and rocks knock you down. Jumps earn style points.</p>
       ${CONTROLS}
       <p>Past 2,000m, don't stop moving.</p>
       ${S.best ? `<p>Your best: ${S.best.toLocaleString()}m</p>` : ''}`,
      'Start skiing', start);
  }

  function start() {
    reset();
    S.mode = 'play';
    hideDialog();
    canvas.focus?.();
  }

  function togglePause() {
    if (S.mode !== 'play') return;
    S.paused = !S.paused;
    if (S.paused) showDialog('Paused', `<p class="big">Paused</p>${CONTROLS}`, 'Resume', togglePause);
    else hideDialog();
  }

  function gameOver() {
    S.mode = 'over';
    const d = Math.floor(S.dist);
    const isBest = d > S.best;
    if (isBest) { S.best = d; saveBest(d); }
    showDialog('Game over',
      `<p class="big">The walrus got you.</p>
       <p>Distance: ${d.toLocaleString()}m<br>Time: ${fmtTime(S.time)}<br>Style: ${S.style.toLocaleString()}<br>Wipeouts: ${S.crashes}</p>
       ${isBest ? '<p class="new">New best distance!</p>' : `<p>Your best: ${S.best.toLocaleString()}m</p>`}`,
      'Ski again', start);
  }

  // ---------- Update ----------
  function popup(x, y, text, color) { popups.push({ x, y, text, color: color || '#0b1f8a', t: 0 }); }

  function crash() {
    const s = skier;
    s.state = 'crashed'; s.crashT = 1.1;
    s.vx = s.vy = 0; s.z = 0; s.vz = 0; s.boosting = false;
    S.crashes++; S.shake = 0.25;
    trail.push(null);
    popup(s.x, s.y - 40, 'OOF', '#c81e1e');
  }

  function update(dt) {
    S.time += dt;
    const s = skier;

    // Pointer steering
    if (input.pointerSteer && s.state === 'ski' && (input.ptrType === 'mouse' || input.touchDown)) {
      const dx = input.px - W / 2, dy = input.py - H * SKIER_SCREEN_Y;
      if (Math.hypot(dx, dy) > 24) {
        s.dir = dy < 8
          ? (dx < 0 ? -3 : 3)
          : Math.max(-3, Math.min(3, Math.round(Math.atan2(dx, dy) / (Math.PI / 6))));
      }
    }

    s.invuln = Math.max(0, s.invuln - dt);

    if (s.state === 'crashed') {
      s.crashT -= dt;
      s.stamina = Math.min(1, s.stamina + 0.11 * dt);
      if (s.crashT <= 0) { s.state = 'ski'; s.invuln = 1.0; }
    } else if (s.state === 'ski') {
      if (s.z <= 0) {
        const wantBoost = (input.boostKey || input.boostPtr || input.boostBtn) && Math.abs(s.dir) < 3;
        s.boosting = wantBoost && s.stamina > 0.01;
        let tgt = TARGET[Math.abs(s.dir)];
        if (s.boosting) { tgt *= BOOST_MULT; s.stamina = Math.max(0, s.stamina - 0.33 * dt); }
        else s.stamina = Math.min(1, s.stamina + 0.11 * dt);
        const a = s.dir * Math.PI / 6;
        const k = Math.min(1, dt * (s.boosting ? 2.6 : 2.0));
        s.vx += (Math.sin(a) * tgt - s.vx) * k;
        s.vy += (Math.cos(a) * tgt - s.vy) * k;
      } else {
        s.stamina = Math.min(1, s.stamina + 0.11 * dt);
        s.air += dt;
        s.vz -= GRAVITY * dt;
        s.z += s.vz * dt;
        if (s.z <= 0) {
          s.z = 0; s.vz = 0;
          if (s.air > 0.35) {
            const pts = Math.round(s.air * 120);
            S.style += pts;
            popup(s.x, s.y - 40, '+' + pts);
          }
          s.air = 0;
          trail.push(null);
        }
      }
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      collide();
    }

    // Ski tracks
    trailTimer += dt;
    const sp = Math.hypot(s.vx, s.vy);
    if (s.state === 'ski' && s.z <= 0 && sp > 20 && trailTimer > 0.03) {
      trailTimer = 0;
      trail.push({ x: s.x, y: s.y, a: s.dir * Math.PI / 6 });
      if (trail.length > 500) trail.splice(0, trail.length - 500);
    }

    S.dist = Math.max(S.dist, s.y / PX_PER_M);
    if (cells.size > 140) pruneCells();
  }

  function collide() {
    const s = skier;
    const cx = Math.floor(s.x / CELL), cy = Math.floor(s.y / CELL);
    for (let i = -1; i <= 1; i++) {
      for (let j = -1; j <= 1; j++) {
        for (const o of cell(cx + i, cy + j)) {
          const dx = o.x - s.x, dy = o.y - s.y, rr = o.r + SKIER_HIT;
          if (dx * dx + dy * dy > rr * rr) continue;
          if (S.time - o.last < 0.6) continue;
          switch (o.type) {
            case 'tree':
            case 'dead':
              if (s.z < 30 && s.invuln <= 0) { o.last = S.time; crash(); }
              break;
            case 'rock':
              if (s.z < 8 && s.invuln <= 0) { o.last = S.time; crash(); }
              break;
            case 'mogul':
              if (s.z <= 0) { o.last = S.time; s.vx *= 0.7; s.vy *= 0.7; s.vz = 140; s.z = 0.01; }
              break;
            case 'ramp':
              if (s.z <= 0 && s.vy > 80) {
                o.last = S.time;
                const speed = Math.hypot(s.vx, s.vy);
                s.vz = 280 + speed * 0.45; s.z = 0.01; s.air = 0;
                trail.push(null);
              }
              break;
          }
          if (s.state !== 'ski') return;
        }
      }
    }
  }

  function updateMonster(dt) {
    const s = skier, m = monster;
    if (!m.active) {
      if (S.dist >= MONSTER_AT_M) {
        m.active = true; m.state = 'chase'; m.t = 0;
        m.x = s.x + (Math.random() < 0.5 ? -1 : 1) * W * 0.3;
        m.y = s.y - H * SKIER_SCREEN_Y - 160;
      }
      return;
    }
    m.t += dt;
    if (m.state === 'chase') {
      const speed = 600 + m.t * 5; // a bit faster than you, unless you boost
      const dx = s.x - m.x, dy = s.y - m.y;
      const d = Math.hypot(dx, dy) || 1;
      if (d > 1600) { m.x = s.x - (dx / d) * 1100; m.y = s.y - (dy / d) * 1100; }
      m.x += (dx / d) * speed * dt;
      m.y += (dy / d) * speed * dt;
      if (d < 34 && s.z < 40) {
        m.state = 'eat'; m.eatT = 0;
        s.state = 'eaten'; s.vx = s.vy = 0;
        m.x = s.x; m.y = s.y + 2;
        S.shake = 0.4;
      }
    } else {
      m.eatT += dt;
      if (m.eatT > 2.4 && S.mode === 'play') gameOver();
    }
  }

  // ---------- Drawing helpers ----------
  function ellipse(x, y, rx, ry, rot = 0) { ctx.beginPath(); ctx.ellipse(x, y, rx, ry, rot, 0, Math.PI * 2); ctx.fill(); }
  function shadow(x, y, rx, ry) { ctx.fillStyle = 'rgba(70,100,140,0.16)'; ellipse(x, y, rx, ry); }

  function drawSpeckles(camX, camY) {
    const G = 56;
    const x0 = Math.floor(camX / G) - 1, x1 = Math.floor((camX + W) / G) + 1;
    const y0 = Math.floor(camY / G) - 1, y1 = Math.floor((camY + H) / G) + 1;
    ctx.fillStyle = 'rgba(150,180,215,0.35)';
    for (let gx = x0; gx <= x1; gx++) {
      for (let gy = y0; gy <= y1; gy++) {
        const h = hash2(gx * 7 + 3, gy * 13 + 1);
        if ((h & 3) !== 0) continue;
        const ox = (h >>> 4) % G, oy = (h >>> 12) % G;
        ctx.fillRect(gx * G + ox - camX, gy * G + oy - camY, 2, 1);
      }
    }
  }

  function drawTrail(camX, camY) {
    ctx.strokeStyle = 'rgba(140,168,205,0.5)';
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    for (const side of [-1, 1]) {
      ctx.beginPath();
      let pen = false;
      for (const p of trail) {
        if (!p) { pen = false; continue; }
        const ox = Math.cos(p.a) * 4 * side, oy = -Math.sin(p.a) * 2 * side;
        const x = p.x - camX + ox, y = p.y - camY + oy;
        if (!pen) { ctx.moveTo(x, y); pen = true; } else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
  }

  function drawTree(x, y, s) {
    ctx.save(); ctx.translate(x, y); ctx.scale(s, s);
    shadow(2, 1, 17, 5);
    ctx.fillStyle = '#6b4226'; ctx.fillRect(-3, -10, 6, 11);
    const layers = [[-8, 19, 24], [-20, 15, 21], [-31, 11, 19]];
    for (const [by, hw, h] of layers) {
      ctx.fillStyle = '#2f8a55';
      ctx.beginPath(); ctx.moveTo(-hw, by); ctx.lineTo(hw, by); ctx.lineTo(0, by - h); ctx.closePath(); ctx.fill();
      ctx.fillStyle = 'rgba(0,40,20,0.22)';
      ctx.beginPath(); ctx.moveTo(0, by); ctx.lineTo(hw, by); ctx.lineTo(0, by - h); ctx.closePath(); ctx.fill();
    }
    ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.moveTo(-5, -42); ctx.lineTo(5, -42); ctx.lineTo(0, -50); ctx.closePath(); ctx.fill();
    ctx.restore();
  }

  function drawDead(x, y, s) {
    ctx.save(); ctx.translate(x, y); ctx.scale(s, s);
    shadow(2, 1, 10, 3);
    ctx.strokeStyle = '#5a3a22'; ctx.lineCap = 'round';
    ctx.lineWidth = 4;
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, -36); ctx.stroke();
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(0, -14); ctx.lineTo(-11, -24);
    ctx.moveTo(0, -20); ctx.lineTo(10, -30);
    ctx.moveTo(0, -28); ctx.lineTo(-7, -37);
    ctx.moveTo(-6, -19); ctx.lineTo(-9, -15);
    ctx.stroke();
    ctx.restore();
  }

  function drawRock(x, y, seed) {
    ctx.save(); ctx.translate(x, y);
    shadow(1, 2, 14, 4);
    const r = rng((seed * 1e9) | 0);
    ctx.fillStyle = '#8a929c';
    ctx.beginPath();
    const n = 7;
    for (let i = 0; i < n; i++) {
      const a = Math.PI + (i / (n - 1)) * Math.PI;
      const rad = 10 + r() * 4;
      const px = Math.cos(a) * rad * 1.2, py = Math.sin(a) * rad * 0.85 + 2;
      i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
    }
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#b4bcc6'; ellipse(-4, -6, 5, 3);
    ctx.fillStyle = 'rgba(255,255,255,0.9)'; ellipse(2, -9, 6, 2);
    ctx.restore();
  }

  function drawMogul(x, y) {
    ctx.save(); ctx.translate(x, y);
    ctx.fillStyle = '#ffffff'; ellipse(0, 0, 20, 8);
    ctx.strokeStyle = 'rgba(120,150,190,0.55)'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.ellipse(0, 0, 20, 8, 0, 0.15, Math.PI - 0.15); ctx.stroke();
    ctx.beginPath(); ctx.ellipse(2, 1, 12, 4, 0, 0.3, Math.PI - 0.3); ctx.stroke();
    ctx.restore();
  }

  function drawRamp(x, y) {
    ctx.save(); ctx.translate(x, y);
    shadow(0, 8, 26, 4);
    ctx.fillStyle = '#e3eef9';
    ctx.beginPath(); ctx.moveTo(-24, 7); ctx.lineTo(24, 7); ctx.lineTo(17, -9); ctx.lineTo(-17, -9); ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#9bbbe0';
    ctx.fillRect(-24, 7, 48, 4);
    ctx.strokeStyle = 'rgba(110,145,190,0.6)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(-8, -9); ctx.lineTo(-11, 7); ctx.moveTo(8, -9); ctx.lineTo(11, 7); ctx.stroke();
    // marker poles
    for (const sx of [-27, 27]) {
      ctx.strokeStyle = '#333'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(sx, 10); ctx.lineTo(sx, -12); ctx.stroke();
      ctx.fillStyle = '#ff7a00';
      ctx.beginPath(); ctx.moveTo(sx, -12); ctx.lineTo(sx + (sx < 0 ? -9 : 9), -9); ctx.lineTo(sx, -6); ctx.closePath(); ctx.fill();
    }
    ctx.restore();
  }

  function drawSkis(a, spread) {
    const dx = Math.sin(a), dy = Math.cos(a) * 0.5;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len, uy = dy / len;
    const px = -uy * spread, py = ux * spread;
    const half = 13 * Math.max(0.6, Math.hypot(dx, dy));
    ctx.strokeStyle = '#1d1d1d'; ctx.lineWidth = 3; ctx.lineCap = 'round';
    for (const side of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(px * side - ux * half, py * side - uy * half);
      ctx.lineTo(px * side + ux * half, py * side + uy * half);
      ctx.stroke();
    }
  }

  function drawSkier(sx, sy) {
    const s = skier;
    if (s.state === 'eaten') return;
    const lift = Math.min(0.5, s.z / 300);
    shadow(sx, sy + 2, 14 * (1 - lift), 5 * (1 - lift));
    const y = sy - s.z;
    ctx.save();
    if (s.invuln > 0 && Math.floor(S.time * 12) % 2) ctx.globalAlpha = 0.45;
    ctx.translate(sx, y);

    if (s.state === 'crashed') {
      // tangled skis
      ctx.strokeStyle = '#1d1d1d'; ctx.lineWidth = 3; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(-14, -8); ctx.lineTo(12, 4); ctx.moveTo(-12, 4); ctx.lineTo(14, -8); ctx.stroke();
      ctx.fillStyle = '#d62828'; ellipse(0, -2, 11, 6);
      ctx.fillStyle = '#2b2b3a'; ellipse(9, 1, 6, 3);
      ctx.fillStyle = '#f1c27d'; ellipse(-12, -4, 5, 5);
      ctx.fillStyle = '#1d4ed8'; ellipse(-15, -5, 4, 4);
      // dizzy stars
      ctx.fillStyle = '#f5b800';
      for (let i = 0; i < 3; i++) {
        const t = S.time * 5 + (i * Math.PI * 2) / 3;
        ctx.fillRect(-12 + Math.cos(t) * 10 - 1.5, -16 + Math.sin(t) * 3 - 1.5, 3, 3);
      }
      ctx.restore();
      return;
    }

    const a = s.dir * Math.PI / 6;
    const lean = Math.sin(a) * 3;
    const airborne = s.z > 2;

    if (s.boosting) {
      ctx.strokeStyle = 'rgba(11,31,138,0.35)'; ctx.lineWidth = 2;
      const bx = -Math.sin(a), by = -Math.cos(a);
      for (let i = -1; i <= 1; i++) {
        const o = i * 6, l = 14 + Math.random() * 10;
        ctx.beginPath();
        ctx.moveTo(bx * 16 + by * o, by * 16 - 20 - bx * o);
        ctx.lineTo(bx * (16 + l) + by * o, by * (16 + l) - 20 - bx * o);
        ctx.stroke();
      }
    }

    drawSkis(airborne ? a + Math.sin(S.time * 10) * 0.15 : a, 3.5);

    // legs
    ctx.strokeStyle = '#2b2b3a'; ctx.lineWidth = 3.5; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(lean - 3, -12); ctx.lineTo(-3, -1); ctx.moveTo(lean + 3, -12); ctx.lineTo(3, -1); ctx.stroke();
    // poles + arms
    ctx.strokeStyle = '#555'; ctx.lineWidth = 1.5;
    if (airborne) {
      ctx.beginPath(); ctx.moveTo(lean - 7, -20); ctx.lineTo(lean - 16, -34); ctx.moveTo(lean + 7, -20); ctx.lineTo(lean + 16, -34); ctx.stroke();
    } else {
      ctx.beginPath(); ctx.moveTo(lean - 8, -16); ctx.lineTo(lean - 13, 2); ctx.moveTo(lean + 8, -16); ctx.lineTo(lean + 13, 2); ctx.stroke();
    }
    // jacket
    ctx.fillStyle = '#d62828';
    ctx.beginPath(); ctx.roundRect(lean - 7, -24, 14, 13, 4); ctx.fill();
    ctx.fillStyle = '#f2f2f2'; ctx.fillRect(lean - 7, -16, 14, 2);
    // head
    const hx = lean * 1.4;
    ctx.fillStyle = '#f1c27d'; ellipse(hx, -29, 5, 5);
    ctx.fillStyle = '#1d4ed8';
    ctx.beginPath(); ctx.arc(hx, -30, 5.3, Math.PI, 0); ctx.fill();
    ctx.fillStyle = '#fff'; ellipse(hx, -36, 2, 2);
    if (Math.abs(s.dir) < 3) {
      ctx.fillStyle = '#222'; ctx.fillRect(hx - 4 + Math.sin(a) * 1.5, -29, 8, 2.5);
    }
    ctx.restore();
  }

  function drawWalrus(x, y) {
    const m = monster;
    const eating = m.state === 'eat';
    const t = eating ? m.eatT : m.t;
    const bob = eating ? -Math.abs(Math.sin(t * 14)) * 10 : -Math.abs(Math.sin(t * 9)) * 9;
    ctx.save(); ctx.translate(x, y);
    shadow(0, 3, 40, 10);
    ctx.translate(0, bob);
    // tail flippers
    ctx.fillStyle = '#6f4736';
    ellipse(-14, -2, 13, 5, 0.3); ellipse(14, -2, 13, 5, -0.3);
    // body
    ctx.fillStyle = '#8b5e48'; ellipse(0, -32, 38, 32);
    ctx.fillStyle = '#a8775e'; ellipse(0, -26, 25, 22);
    // front flippers, flapping
    const flap = Math.sin(t * 12) * 0.35;
    ctx.fillStyle = '#6f4736';
    ellipse(-36, -18, 15, 7, -0.6 + flap); ellipse(36, -18, 15, 7, 0.6 - flap);
    // head
    ctx.fillStyle = '#8b5e48'; ellipse(0, -66, 25, 20);
    // eyes + angry brows
    ctx.fillStyle = '#111'; ellipse(-9, -71, 3, 3); ellipse(9, -71, 3, 3);
    ctx.strokeStyle = '#3b2418'; ctx.lineWidth = 3; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(-15, -79); ctx.lineTo(-5, -75); ctx.moveTo(15, -79); ctx.lineTo(5, -75); ctx.stroke();
    // open mouth while eating
    const open = eating ? (Math.sin(t * 16) + 1) / 2 : 0;
    if (eating) { ctx.fillStyle = '#3a0f0f'; ellipse(0, -50, 11, 3 + open * 7); }
    // muzzle
    ctx.fillStyle = '#c99c7f';
    ellipse(-9, -58 - open * 4, 11, 9); ellipse(9, -58 - open * 4, 11, 9);
    ctx.fillStyle = '#6b4a3a';
    for (const sx of [-1, 1]) for (let i = 0; i < 3; i++) ctx.fillRect(sx * (5 + i * 4) - 1, -58 - open * 4 + (i % 2) * 3, 2, 2);
    ctx.fillStyle = '#2a1a12'; ellipse(0, -64 - open * 4, 5, 3);
    // skier's legs and skis poking out of the mouth
    if (eating) {
      const wig = Math.sin(t * 20) * 3;
      ctx.strokeStyle = '#2b2b3a'; ctx.lineWidth = 3; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(-3, -46); ctx.lineTo(-6 + wig, -36); ctx.moveTo(3, -46); ctx.lineTo(6 - wig, -36); ctx.stroke();
      ctx.strokeStyle = '#1d1d1d';
      ctx.beginPath(); ctx.moveTo(-17 + wig, -36); ctx.lineTo(3 + wig, -34); ctx.moveTo(-3 - wig, -34); ctx.lineTo(17 - wig, -36); ctx.stroke();
    }
    // tusks
    ctx.fillStyle = '#fffaf0'; ctx.strokeStyle = '#cfc6b4'; ctx.lineWidth = 1;
    for (const sx of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(sx * 4, -52 - open * 4); ctx.lineTo(sx * 10, -52 - open * 4); ctx.lineTo(sx * 9, -28 - open * 4);
      ctx.closePath(); ctx.fill(); ctx.stroke();
    }
    ctx.restore();
  }

  function drawIndicator(camX, camY) {
    const m = monster;
    if (!m.active || m.state !== 'chase') return false;
    const mx = m.x - camX, my = m.y - camY - 40;
    if (mx > -40 && mx < W + 40 && my > -40 && my < H + 40) return false;
    const ex = Math.max(24, Math.min(W - 24, mx));
    const ey = Math.max(24, Math.min(H - 24, my));
    const ang = Math.atan2(my - ey, mx - ex);
    ctx.save(); ctx.translate(ex, ey); ctx.rotate(ang);
    ctx.fillStyle = '#c81e1e';
    ctx.beginPath(); ctx.moveTo(14, 0); ctx.lineTo(-8, -10); ctx.lineTo(-8, 10); ctx.closePath(); ctx.fill();
    ctx.restore();
    const d = Math.round(Math.hypot(m.x - skier.x, m.y - skier.y) / PX_PER_M);
    ctx.fillStyle = '#c81e1e'; ctx.font = '20px VT323, monospace'; ctx.textAlign = 'center';
    ctx.fillText(d + 'm', ex, ey + (ey < H / 2 ? 30 : -18));
    return true;
  }

  // ---------- Render ----------
  function render() {
    const s = skier;
    let camX = s.x - W / 2, camY = s.y - H * SKIER_SCREEN_Y;
    if (S.shake > 0) { camX += (Math.random() - 0.5) * S.shake * 30; camY += (Math.random() - 0.5) * S.shake * 30; }

    ctx.fillStyle = '#f4f8fc'; ctx.fillRect(0, 0, W, H);
    drawSpeckles(camX, camY);
    drawTrail(camX, camY);

    const objs = [];
    const x0 = Math.floor((camX - 80) / CELL), x1 = Math.floor((camX + W + 80) / CELL);
    const y0 = Math.floor((camY - 120) / CELL), y1 = Math.floor((camY + H + 80) / CELL);
    for (let cx = x0; cx <= x1; cx++) for (let cy = y0; cy <= y1; cy++) for (const o of cell(cx, cy)) objs.push(o);

    // flat ground features first
    for (const o of objs) {
      if (o.type === 'mogul') drawMogul(o.x - camX, o.y - camY);
      else if (o.type === 'ramp') drawRamp(o.x - camX, o.y - camY);
    }
    // depth-sorted standing things
    const ents = objs.filter((o) => o.type !== 'mogul' && o.type !== 'ramp');
    ents.push({ type: 'skier', y: s.z > 20 ? Infinity : s.y });
    if (monster.active) ents.push({ type: 'monster', y: monster.state === 'eat' ? monster.y + 1 : monster.y });
    ents.sort((a, b) => a.y - b.y);
    for (const e of ents) {
      if (e.type === 'tree') drawTree(e.x - camX, e.y - camY, e.s);
      else if (e.type === 'dead') drawDead(e.x - camX, e.y - camY, e.s);
      else if (e.type === 'rock') drawRock(e.x - camX, e.y - camY, e.seed);
      else if (e.type === 'skier') drawSkier(s.x - camX, s.y - camY);
      else if (e.type === 'monster') drawWalrus(monster.x - camX, monster.y - camY);
    }

    // popups
    ctx.font = '26px VT323, monospace'; ctx.textAlign = 'center';
    for (const p of popups) {
      ctx.globalAlpha = Math.max(0, 1 - p.t);
      ctx.fillStyle = p.color;
      ctx.fillText(p.text, p.x - camX, p.y - camY - p.t * 40);
    }
    ctx.globalAlpha = 1;

    const offscreen = drawIndicator(camX, camY);
    warn.classList.toggle('hidden', !(S.mode === 'play' && offscreen));
  }

  function fmtTime(t) {
    const m = Math.floor(t / 60), s = Math.floor(t % 60);
    return m + ':' + String(s).padStart(2, '0');
  }

  const last = {};
  function setText(el, key, v) { if (last[key] !== v) { last[key] = v; el.textContent = v; } }
  function updateHud() {
    const s = skier;
    setText(hud.dist, 'd', Math.floor(S.dist).toLocaleString() + 'm');
    setText(hud.speed, 's', Math.round((Math.hypot(s.vx, s.vy) / PX_PER_M) * 3.6) + ' km/h');
    setText(hud.time, 't', fmtTime(S.time));
    setText(hud.style, 'st', S.style.toLocaleString());
    const w = Math.round(s.stamina * 100) + '%';
    if (last.b !== w) { last.b = w; hud.boost.style.width = w; }
  }

  // ---------- Loop ----------
  let prev = performance.now();
  function frame(now) {
    const dt = Math.min(0.05, (now - prev) / 1000);
    prev = now;
    if (S.mode === 'play' && !S.paused) {
      update(dt);
      updateMonster(dt);
    } else if (S.mode === 'over' && monster.state === 'eat') {
      monster.eatT += dt; // keep chewing behind the dialog
    }
    if (!S.paused) {
      S.shake = Math.max(0, S.shake - dt);
      for (const p of popups) p.t += dt;
      popups = popups.filter((p) => p.t < 1);
    }
    render();
    updateHud();
    requestAnimationFrame(frame);
  }

  reset();
  showTitle();
  requestAnimationFrame(frame);
})();
