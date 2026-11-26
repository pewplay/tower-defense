// ================================================================
//  TOWER DEFENSE — PewPlay
//  @bg #18261a
//  @accent #8bd450
//  Griglia 16×10 (ruotata in verticale), 3 mappe, 4 torri con due
//  potenziamenti, 4 tipi di nemici con boss ogni 5 ondate, 20 ondate.
// ================================================================
(function () {
  'use strict';
  const { clamp, sfx, store } = PP;

  const GAME_ID = 'tower-defense';
  const COLS = 16, ROWS = 10, WAVES = 20;
  const MAPS = {
    Meadow: [[-1, 2], [4, 2], [4, 7], [9, 7], [9, 3], [13, 3], [13, 8], [16, 8]],
    Canyon: [[-1, 1], [13, 1], [13, 4], [2, 4], [2, 7], [14, 7], [14, 10]],
    Spiral: [[-1, 9], [14, 9], [14, 1], [1, 1], [1, 7], [11, 7], [11, 3], [5, 3], [5, 5], [8, 5]],
  };
  const MAP_NAMES = Object.keys(MAPS);
  const TOWERS = {
    arrow: { name: 'Arrow', color: '#8bd450', cost: [50, 60, 90], range: [2.6, 2.8, 3.1], dmg: [10, 18, 30], rate: [0.5, 0.42, 0.34] },
    cannon: { name: 'Cannon', color: '#f2994a', cost: [90, 110, 150], range: [2.4, 2.5, 2.7], dmg: [26, 44, 70], rate: [1.4, 1.3, 1.2], splash: [0.9, 1.05, 1.2] },
    frost: { name: 'Frost', color: '#56ccf2', cost: [70, 80, 110], range: [2.2, 2.4, 2.6], dmg: [4, 7, 11], rate: [0.9, 0.8, 0.7], slow: [0.45, 0.55, 0.65] },
    sniper: { name: 'Sniper', color: '#bb6bd9', cost: [130, 150, 200], range: [4.5, 5, 5.6], dmg: [70, 130, 220], rate: [2.2, 2.0, 1.8] },
  };
  const TKEYS = Object.keys(TOWERS);
  const ENEMIES = {
    runner: { hp: 28, speed: 2.4, reward: 6, color: '#f2c94c', r: 0.22 },
    grunt: { hp: 60, speed: 1.4, reward: 8, color: '#eb5757', r: 0.28 },
    tank: { hp: 220, speed: 0.8, reward: 18, color: '#828282', r: 0.36 },
    boss: { hp: 1300, speed: 0.7, reward: 120, color: '#9b51e0', r: 0.45 },
  };

  let mapIdx = 0;
  let path, pathCells, pathLen, towers, enemies, shots, effects, gold, lives, wave, spawning, spawnQueue, spawnT, speed, selected, buildType, waveActive, won;
  let rot = false, geo = {}, ui = [];

  // ── MAPPA ───────────────────────────────────────
  function buildPath() {
    rot = PP.H > PP.W * 1.05;
    const pts = MAPS[MAP_NAMES[mapIdx]].map(([x, y]) => (rot ? [y, x] : [x, y]));
    path = pts.map(([x, y]) => ({ x: x + 0.5, y: y + 0.5 }));
    pathCells = new Set();
    pathLen = 0;
    for (let i = 0; i < pts.length - 1; i++) {
      const [ax, ay] = pts[i], [bx, by] = pts[i + 1];
      const n = Math.max(Math.abs(bx - ax), Math.abs(by - ay));
      for (let k = 0; k <= n; k++) pathCells.add(`${ax + Math.sign(bx - ax) * k},${ay + Math.sign(by - ay) * k}`);
      pathLen += n;
    }
  }
  const cols = () => (rot ? ROWS : COLS), rows = () => (rot ? COLS : ROWS);
  function posAt(d) {
    let left = d;
    for (let i = 0; i < path.length - 1; i++) {
      const a = path[i], b = path[i + 1], seg = Math.hypot(b.x - a.x, b.y - a.y);
      if (left <= seg) return { x: a.x + (b.x - a.x) * (left / seg), y: a.y + (b.y - a.y) * (left / seg) };
      left -= seg;
    }
    return { ...path[path.length - 1], end: true };
  }

  function start() {
    buildPath();
    towers = []; enemies = []; shots = []; effects = [];
    gold = 200; lives = 20; wave = 0; spawnQueue = []; spawnT = 0; speed = 1; selected = null; buildType = null; waveActive = false; won = false;
    layout();
  }

  // ── ONDATE ──────────────────────────────────────
  function composeWave(n) {
    const q = [];
    const count = 6 + Math.floor(n * 1.6);
    for (let i = 0; i < count; i++) {
      let type = 'grunt';
      if (n >= 2 && i % 3 === 1) type = 'runner';
      if (n >= 4 && i % 5 === 4) type = 'tank';
      if (n >= 9 && i % 4 === 2) type = 'runner';
      if (n >= 12 && i % 3 === 0) type = 'tank';
      q.push({ type, gap: type === 'runner' ? 0.45 : type === 'tank' ? 1.1 : 0.7 });
    }
    if (n % 5 === 0) q.push({ type: 'boss', gap: 1.5 });
    return q;
  }
  function startWave() {
    if (waveActive || wave >= WAVES) return;
    wave++; waveActive = true;
    spawnQueue = composeWave(wave); spawnT = 0.2;
    sfx.chord([392, 523], 0.15, 'square', 0.08, 0.08);
  }
  function spawn(type) {
    const base = ENEMIES[type];
    const hp = Math.round(base.hp * Math.pow(1 + wave * 0.24, 1.18));
    enemies.push({ type, hp, max: hp, d: 0, speed: base.speed, reward: base.reward + Math.floor(wave / 4), slowT: 0, slowK: 0, r: base.r, color: base.color });
  }

  // ── TORRI ───────────────────────────────────────
  const towerAt = (cx, cy) => towers.find(t => t.cx === cx && t.cy === cy);
  function canBuild(cx, cy) { return cx >= 0 && cy >= 0 && cx < cols() && cy < rows() && !pathCells.has(`${cx},${cy}`) && !towerAt(cx, cy); }
  function build(cx, cy, type) {
    const c = TOWERS[type].cost[0];
    if (gold < c || !canBuild(cx, cy)) { sfx.tone(160, 0.08, 'square', 0.06); return false; }
    gold -= c;
    towers.push({ type, cx, cy, lvl: 0, cd: 0, spent: c, angle: -Math.PI / 2 });
    const p = toScreen(cx + 0.5, cy + 0.5); PP.burst(p.x, p.y, [TOWERS[type].color, '#fff'], 12, 120, 3, 0.4, 0);
    sfx.tone(440, 0.08, 'triangle', 0.12); sfx.tone(660, 0.08, 'triangle', 0.1, null, 0.06);
    return true;
  }
  function upgrade(t) {
    if (t.lvl >= 2) return;
    const c = TOWERS[t.type].cost[t.lvl + 1];
    if (gold < c) { sfx.tone(160, 0.08, 'square', 0.06); return; }
    gold -= c; t.spent += c; t.lvl++;
    const p = toScreen(t.cx + 0.5, t.cy + 0.5); PP.burst(p.x, p.y, ['#ffd166', '#fff'], 18, 160, 3, 0.6, 0);
    sfx.chord([523, 659, 784], 0.12, 'triangle', 0.12, 0.04);
  }
  function sell(t) {
    gold += Math.floor(t.spent * 0.7);
    towers = towers.filter(x => x !== t); selected = null;
    sfx.tone(300, 0.1, 'sine', 0.1, 600);
  }

  function update(dtRaw) {
    for (let k = 0; k < speed; k++) step(dtRaw);
  }
  function step(dt) {
    // generazione
    if (spawnQueue.length) { spawnT -= dt; if (spawnT <= 0) { const e = spawnQueue.shift(); spawn(e.type); spawnT = e.gap; } }
    // nemici
    for (let i = enemies.length - 1; i >= 0; i--) {
      const e = enemies[i];
      e.slowT = Math.max(0, e.slowT - dt);
      e.d += e.speed * (e.slowT > 0 ? 1 - e.slowK : 1) * dt;
      if (e.d >= pathLen + 1.5) {
        enemies.splice(i, 1);
        lives -= e.type === 'boss' ? 5 : 1;
        PP.shake = 6; sfx.tone(150, 0.2, 'sawtooth', 0.1, 90);
        if (lives <= 0) { lives = 0; return lose(); }
      }
    }
    // torri
    for (const t of towers) {
      const T = TOWERS[t.type];
      t.cd -= dt;
      const range = T.range[t.lvl];
      let target = null, best = -1;
      for (const e of enemies) {
        const p = posAt(e.d);
        if (Math.hypot(p.x - (t.cx + 0.5), p.y - (t.cy + 0.5)) <= range && e.d > best) { best = e.d; target = e; }
      }
      if (target) { const p = posAt(target.d); t.angle = Math.atan2(p.y - t.cy - 0.5, p.x - t.cx - 0.5); }
      if (target && t.cd <= 0) { t.cd = T.rate[t.lvl]; fire(t, target); }
    }
    // proiettili
    for (let i = shots.length - 1; i >= 0; i--) {
      const s = shots[i];
      const tp = s.target && enemies.includes(s.target) ? posAt(s.target.d) : s.last;
      s.last = tp;
      const dx = tp.x - s.x, dy = tp.y - s.y, d = Math.hypot(dx, dy), mv = s.speed * dt;
      if (d <= mv) { impact(s, tp); shots.splice(i, 1); }
      else { s.x += dx / d * mv; s.y += dy / d * mv; s.t += dt; }
    }
    for (let i = effects.length - 1; i >= 0; i--) { effects[i].t -= dt; if (effects[i].t <= 0) effects.splice(i, 1); }
    // fine ondata
    if (waveActive && !spawnQueue.length && !enemies.length) {
      waveActive = false;
      const bonus = 20 + wave * 3;
      gold += bonus;
      PP.floatText(`Wave ${wave} cleared +${bonus}`, PP.W / 2, PP.H * 0.3, '#ffd166', 20);
      if (wave >= WAVES) return win();
    }
  }
  function fire(t, e) {
    const T = TOWERS[t.type], from = { x: t.cx + 0.5, y: t.cy + 0.5 };
    if (t.type === 'sniper') { damage(e, T.dmg[t.lvl]); effects.push({ type: 'beam', a: from, b: posAt(e.d), t: 0.15, color: T.color }); sfx.tone(1200, 0.08, 'sawtooth', 0.05, 300); return; }
    if (t.type === 'frost') { damage(e, T.dmg[t.lvl]); e.slowT = 1.6; e.slowK = T.slow[t.lvl]; effects.push({ type: 'beam', a: from, b: posAt(e.d), t: 0.18, color: T.color }); sfx.tone(900, 0.05, 'sine', 0.04); return; }
    shots.push({ type: t.type, x: from.x, y: from.y, target: e, last: posAt(e.d), speed: t.type === 'cannon' ? 7 : 14, dmg: T.dmg[t.lvl], splash: T.splash ? T.splash[t.lvl] : 0, t: 0 });
    sfx.tone(t.type === 'cannon' ? 120 : 700, 0.05, t.type === 'cannon' ? 'sine' : 'triangle', t.type === 'cannon' ? 0.15 : 0.04);
  }
  function impact(s, p) {
    if (s.splash) {
      for (const e of enemies.slice()) { const q = posAt(e.d); if (Math.hypot(q.x - p.x, q.y - p.y) <= s.splash) damage(e, s.dmg); }
      effects.push({ type: 'boom', p, r: s.splash, t: 0.3 });
      const sp = toScreen(p.x, p.y); PP.burst(sp.x, sp.y, ['#f2994a', '#ffd166', '#555'], 10, 120, 3, 0.4, 0);
    } else if (s.target && enemies.includes(s.target)) damage(s.target, s.dmg);
  }
  function damage(e, d) {
    e.hp -= d;
    if (e.hp <= 0 && enemies.includes(e)) {
      enemies.splice(enemies.indexOf(e), 1);
      gold += e.reward;
      const p = posAt(e.d), sp = toScreen(p.x, p.y);
      PP.burst(sp.x, sp.y, [e.color, '#fff'], e.type === 'boss' ? 40 : 10, 160, 3, 0.5, 0);
      PP.floatText(`+${e.reward}`, sp.x, sp.y - 10, '#ffd166', 14);
      sfx.tone(e.type === 'boss' ? 200 : 600, 0.06, 'square', 0.05);
    }
  }

  function win() {
    won = true;
    const score = lives * 100 + gold, b = store.get(`best-${mapIdx}`, 0), rec = score > b;
    if (rec) store.set(`best-${mapIdx}`, score);
    sfx.win();
    PP.burst(PP.W / 2, PP.H / 2, ['#8bd450', '#ffd166', '#fff'], 70, 420, 5, 1.4, 300);
    PP.over(rec ? 'Victory — new record!' : 'Victory!', `${MAP_NAMES[mapIdx]} defended through ${WAVES} waves\nLives ${lives} · Gold ${gold} · Score ${score}\nBest: ${Math.max(b, score)}`);
  }
  function lose() {
    sfx.lose();
    PP.over('The base has fallen', `${MAP_NAMES[mapIdx]} · reached wave ${wave} of ${WAVES}`);
  }

  // ── GEOMETRIA ───────────────────────────────────
  function layout() {
    const W = PP.W, H = PP.H;
    const land = !rot;
    const barW = land ? clamp(W * 0.17, 130, 190) : 0, barH = land ? 0 : clamp(H * 0.17, 120, 160);
    const top = 50;
    const aw = W - barW - 16, ah = H - top - barH - 12;
    const cell = Math.floor(Math.min(aw / cols(), ah / rows()));
    geo = { cell, x: (aw - cell * cols()) / 2 + 8, y: top + (ah - cell * rows()) / 2, land, barW, barH };
  }
  const toScreen = (x, y) => ({ x: geo.x + x * geo.cell, y: geo.y + y * geo.cell });

  // ── DISEGNO ─────────────────────────────────────
  function draw(ctx, W, H) {
    ctx.fillStyle = '#18261a'; ctx.fillRect(0, 0, W, H);
    if (!path) { buildPath(); towers = []; enemies = []; shots = []; effects = []; }
    layout();
    const { cell, x: gx, y: gy } = geo;
    // erba a scacchi
    for (let y = 0; y < rows(); y++) for (let x = 0; x < cols(); x++) { ctx.fillStyle = (x + y) % 2 ? '#4f8a3a' : '#57943f'; ctx.fillRect(gx + x * cell, gy + y * cell, cell, cell); }
    // sentiero
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.strokeStyle = '#a7834f'; ctx.lineWidth = cell * 0.86;
    ctx.beginPath(); path.forEach((p, i) => { const s = toScreen(p.x, p.y); i ? ctx.lineTo(s.x, s.y) : ctx.moveTo(s.x, s.y); }); ctx.stroke();
    ctx.strokeStyle = '#c9a36a'; ctx.lineWidth = cell * 0.66; ctx.stroke();
    // base
    const end = toScreen(path[path.length - 1].x, path[path.length - 1].y);
    const last = path[path.length - 2], lp = toScreen(last.x, last.y);
    const bx = clamp(end.x, gx + cell * 0.6, gx + cell * (cols() - 0.6)), by = clamp(end.y, gy + cell * 0.6, gy + cell * (rows() - 0.6));
    ctx.fillStyle = '#3d5a80'; PP.rr(bx - cell * 0.5, by - cell * 0.5, cell, cell, cell * 0.2); ctx.fill();
    ctx.fillStyle = '#e0fbfc'; ctx.fillRect(bx - cell * 0.08, by - cell * 0.42, cell * 0.04, cell * 0.5);
    ctx.fillStyle = '#ee6c4d'; ctx.beginPath(); ctx.moveTo(bx - cell * 0.04, by - cell * 0.42); ctx.lineTo(bx + cell * 0.3, by - cell * 0.32); ctx.lineTo(bx - cell * 0.04, by - cell * 0.22); ctx.fill();
    void lp;
    if (PP.state === 'menu') return;
    // anteprima costruzione
    if (buildType && hover) {
      const ok = canBuild(hover.cx, hover.cy);
      const s = toScreen(hover.cx, hover.cy);
      ctx.fillStyle = ok ? 'rgba(255,255,255,.25)' : 'rgba(255,60,60,.35)'; ctx.fillRect(s.x, s.y, cell, cell);
      if (ok) { ctx.strokeStyle = 'rgba(255,255,255,.6)'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(s.x + cell / 2, s.y + cell / 2, TOWERS[buildType].range[0] * cell, 0, 7); ctx.stroke(); }
    }
    // torri
    for (const t of towers) {
      const T = TOWERS[t.type], s = toScreen(t.cx + 0.5, t.cy + 0.5);
      if (selected === t) { ctx.fillStyle = 'rgba(255,255,255,.12)'; ctx.beginPath(); ctx.arc(s.x, s.y, T.range[t.lvl] * cell, 0, 7); ctx.fill(); ctx.strokeStyle = 'rgba(255,255,255,.5)'; ctx.lineWidth = 2; ctx.stroke(); }
      ctx.fillStyle = 'rgba(0,0,0,.25)'; ctx.beginPath(); ctx.ellipse(s.x + 2, s.y + cell * 0.3, cell * 0.38, cell * 0.14, 0, 0, 7); ctx.fill();
      PP.rr(s.x - cell * 0.38, s.y - cell * 0.38, cell * 0.76, cell * 0.76, cell * 0.16); ctx.fillStyle = '#e8e2d0'; ctx.fill();
      PP.circle(s.x, s.y, cell * 0.28, T.color);
      ctx.save(); ctx.translate(s.x, s.y); ctx.rotate(t.angle);
      ctx.fillStyle = '#2d2d2d'; ctx.fillRect(0, -cell * 0.07, cell * (t.type === 'sniper' ? 0.48 : t.type === 'cannon' ? 0.36 : 0.32), cell * (t.type === 'cannon' ? 0.18 : 0.14));
      ctx.restore();
      for (let k = 0; k < t.lvl; k++) PP.circle(s.x - cell * 0.26 + k * cell * 0.14, s.y - cell * 0.28, cell * 0.06, '#ffd166');
    }
    // nemici
    for (const e of enemies) {
      const p = posAt(e.d), s = toScreen(p.x, p.y), r = e.r * cell;
      ctx.fillStyle = 'rgba(0,0,0,.25)'; ctx.beginPath(); ctx.ellipse(s.x, s.y + r * 0.7, r, r * 0.35, 0, 0, 7); ctx.fill();
      PP.circle(s.x, s.y, r, e.color);
      if (e.slowT > 0) { ctx.strokeStyle = '#a8e6ff'; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(s.x, s.y, r + 2, 0, 7); ctx.stroke(); }
      PP.circle(s.x - r * 0.3, s.y - r * 0.2, r * 0.2, '#fff'); PP.circle(s.x + r * 0.3, s.y - r * 0.2, r * 0.2, '#fff');
      PP.circle(s.x - r * 0.3, s.y - r * 0.15, r * 0.09, '#111'); PP.circle(s.x + r * 0.3, s.y - r * 0.15, r * 0.09, '#111');
      if (e.hp < e.max) { ctx.fillStyle = '#300'; ctx.fillRect(s.x - r, s.y - r - 8, r * 2, 4); ctx.fillStyle = '#6fcf97'; ctx.fillRect(s.x - r, s.y - r - 8, r * 2 * e.hp / e.max, 4); }
    }
    for (const sh of shots) { const s = toScreen(sh.x, sh.y); PP.circle(s.x, s.y, sh.type === 'cannon' ? cell * 0.12 : cell * 0.06, sh.type === 'cannon' ? '#333' : '#fff8d6'); }
    for (const ef of effects) {
      if (ef.type === 'beam') { const a = toScreen(ef.a.x, ef.a.y), b = toScreen(ef.b.x, ef.b.y); ctx.strokeStyle = ef.color; ctx.globalAlpha = ef.t * 5; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); ctx.globalAlpha = 1; }
      if (ef.type === 'boom') { const s = toScreen(ef.p.x, ef.p.y); ctx.fillStyle = `rgba(255,170,60,${ef.t * 1.5})`; ctx.beginPath(); ctx.arc(s.x, s.y, ef.r * cell * (1.3 - ef.t), 0, 7); ctx.fill(); }
    }
    PP.drawFx();
    drawUI(ctx, W, H);
  }

  function drawUI(ctx, W, H) {
    PP.text(`♥ ${lives}`, 14, 26, 18, '#ff8a8a', 'left', 900);
    PP.text(`● ${gold}`, 84, 26, 18, '#ffd166', 'left', 900);
    PP.text(`Wave ${wave}/${WAVES}`, 160, 26, 15, '#fff', 'left', 800);
    ui = [];
    const items = [];
    if (selected) {
      const T = TOWERS[selected.type];
      items.push({ id: 'info', label: `${T.name} L${selected.lvl + 1}`, sub: `dmg ${T.dmg[selected.lvl]} · range ${T.range[selected.lvl]}`, color: T.color, info: true });
      if (selected.lvl < 2) items.push({ id: 'up', label: 'Upgrade', sub: `● ${T.cost[selected.lvl + 1]}`, color: '#ffd166', off: gold < T.cost[selected.lvl + 1] });
      items.push({ id: 'sell', label: 'Sell', sub: `+${Math.floor(selected.spent * 0.7)}`, color: '#eb5757' });
      items.push({ id: 'close', label: 'Close', sub: '', color: '#888' });
    } else {
      for (const k of TKEYS) items.push({ id: k, label: TOWERS[k].name, sub: `● ${TOWERS[k].cost[0]}`, color: TOWERS[k].color, sel: buildType === k, off: gold < TOWERS[k].cost[0] });
    }
    const actions = [{ id: 'wave', label: waveActive ? `Wave ${wave}…` : wave >= WAVES ? 'Done' : `Start wave ${wave + 1}`, color: '#8bd450', off: waveActive }, { id: 'speed', label: `Speed ×${speed}`, color: '#56ccf2' }];
    if (geo.land) {
      const x = W - geo.barW - 8, w = geo.barW;
      let y = 60;
      const bh = clamp((H - 70 - 2 * 56) / items.length - 8, 44, 70);
      for (const it of items) { ui.push({ ...it, x, y, w, h: bh }); y += bh + 8; }
      y = H - 2 * 56;
      for (const a of actions) { ui.push({ ...a, x, y, w, h: 48 }); y += 56; }
    } else {
      const y0 = H - geo.barH - 6, n = items.length, gap = 6;
      const w = (W - 16 - gap * (n - 1)) / n, bh = geo.barH - 62;
      items.forEach((it, i) => ui.push({ ...it, x: 8 + i * (w + gap), y: y0, w, h: bh }));
      const aw = (W - 16 - gap) / 2;
      actions.forEach((a, i) => ui.push({ ...a, x: 8 + i * (aw + gap), y: y0 + bh + 8, w: aw, h: 46 }));
    }
    for (const b of ui) {
      PP.rr(b.x, b.y, b.w, b.h, 12);
      ctx.fillStyle = b.sel ? 'rgba(255,255,255,.28)' : b.info ? 'rgba(0,0,0,.3)' : 'rgba(255,255,255,.12)'; ctx.fill();
      if (b.sel) { ctx.strokeStyle = b.color; ctx.lineWidth = 3; ctx.stroke(); }
      ctx.globalAlpha = b.off ? 0.4 : 1;
      if (b.sub !== undefined) {
        PP.circle(b.x + 18, b.y + b.h / 2, 8, b.color);
        PP.text(b.label, b.x + 32, b.y + b.h / 2 - (b.sub ? 8 : 0), Math.min(15, b.w / 7), '#fff', 'left', 800);
        if (b.sub) PP.text(b.sub, b.x + 32, b.y + b.h / 2 + 10, Math.min(12, b.w / 9), 'rgba(255,255,255,.75)', 'left', 600);
      } else PP.text(b.label, b.x + b.w / 2, b.y + b.h / 2 + 1, 15, b.id === 'wave' && !b.off ? '#8bd450' : '#fff', 'center', 800);
      ctx.globalAlpha = 1;
    }
    if (!waveActive && wave === 0) PP.text(buildType ? 'Tap a grass tile to build' : 'Pick a tower, place it, then start the wave', geo.x + geo.cell * cols() / 2, geo.y + geo.cell * rows() + 2 - 14, 13, '#fff', 'center', 700);
  }

  // ── INPUT ───────────────────────────────────────
  let hover = null;
  function cellAt(p) { const cx = Math.floor((p.x - geo.x) / geo.cell), cy = Math.floor((p.y - geo.y) / geo.cell); return cx >= 0 && cy >= 0 && cx < cols() && cy < rows() ? { cx, cy } : null; }
  function pointerMove(p) { hover = cellAt(p); }
  function pointerDown(p) {
    for (const b of ui) if (p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h) { press(b); return; }
    const c = cellAt(p); hover = c;
    if (!c) return;
    const t = towerAt(c.cx, c.cy);
    if (t) { selected = t; buildType = null; sfx.click(); return; }
    if (buildType) { if (build(c.cx, c.cy, buildType) && gold < TOWERS[buildType].cost[0]) buildType = null; return; }
    selected = null;
  }
  function press(b) {
    sfx.click();
    if (TOWERS[b.id]) { buildType = buildType === b.id ? null : b.id; selected = null; return; }
    if (b.id === 'up') upgrade(selected);
    if (b.id === 'sell') sell(selected);
    if (b.id === 'close') selected = null;
    if (b.id === 'wave') startWave();
    if (b.id === 'speed') speed = speed === 1 ? 2 : 1;
  }
  function keyDown(code) {
    const i = ['Digit1', 'Digit2', 'Digit3', 'Digit4'].indexOf(code);
    if (i >= 0) { buildType = TKEYS[i]; selected = null; }
    if (code === 'Space' || code === 'Enter') startWave();
    if (code === 'KeyF') speed = speed === 1 ? 2 : 1;
    if (code === 'KeyU' && selected) upgrade(selected);
    if (code === 'KeyS' && selected) sell(selected);
  }

  function demo(n) {
    mapIdx = [0, 0, 1, 2][n];
    start();
    gold = [0, 145, 320, 60][n]; lives = [20, 18, 12, 20][n]; wave = [0, 6, 14, 1][n]; waveActive = n !== 3;
    const pick = (list) => list.forEach(([cx, cy, type, lvl]) => { const c = rot ? [cy, cx] : [cx, cy]; if (canBuild(c[0], c[1])) towers.push({ type, cx: c[0], cy: c[1], lvl, cd: 0, spent: 100, angle: 0.6 }); });
    if (n === 1) pick([[3, 3, 'arrow', 1], [5, 4, 'cannon', 0], [8, 6, 'frost', 1], [10, 5, 'arrow', 0], [12, 4, 'sniper', 0], [5, 6, 'arrow', 2]]);
    if (n === 2) pick([[3, 2, 'cannon', 2], [6, 3, 'arrow', 2], [9, 2, 'sniper', 1], [11, 5, 'frost', 2], [4, 5, 'cannon', 1], [8, 6, 'arrow', 1], [12, 3, 'sniper', 2], [6, 5, 'frost', 0]]);
    if (n === 3) { pick([[4, 7, 'arrow', 0], [6, 7, 'frost', 0]]); buildType = 'cannon'; hover = rot ? { cx: 2, cy: 7 } : { cx: 7, cy: 2 }; }
    if (n !== 3) {
      const types = n === 2 ? ['grunt', 'tank', 'runner', 'grunt', 'boss', 'runner', 'tank', 'grunt'] : ['grunt', 'runner', 'grunt', 'grunt', 'runner', 'tank'];
      types.forEach((t, i) => { spawn(t); enemies[enemies.length - 1].d = 3 + i * 2.1; if (i % 2) { enemies[enemies.length - 1].hp *= 0.55; enemies[enemies.length - 1].slowT = i % 4 === 1 ? 1 : 0; } });
      if (n === 1) { selected = towers[1]; }
      for (const t of towers) { let tg = null; for (const e of enemies) { const p = posAt(e.d); if (Math.hypot(p.x - t.cx - 0.5, p.y - t.cy - 0.5) < TOWERS[t.type].range[t.lvl]) tg = e; } if (tg) { const p = posAt(tg.d); t.angle = Math.atan2(p.y - t.cy - 0.5, p.x - t.cx - 0.5); if (t.type === 'frost' || t.type === 'sniper') effects.push({ type: 'beam', a: { x: t.cx + 0.5, y: t.cy + 0.5 }, b: p, t: 0.15, color: TOWERS[t.type].color }); } }
    }
    PP.game.update = () => {};
  }

  function icon(c, S) {
    c.fillStyle = '#4f8a3a'; c.fillRect(0, 0, S, S);
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) if ((x + y) % 2) { c.fillStyle = '#57943f'; c.fillRect(x * S / 8, y * S / 8, S / 8, S / 8); }
    c.strokeStyle = '#c9a36a'; c.lineWidth = S * 0.11; c.lineCap = 'round'; c.lineJoin = 'round';
    c.beginPath(); c.moveTo(S * 0.15, S * 0.3); c.lineTo(S * 0.55, S * 0.3); c.lineTo(S * 0.55, S * 0.72); c.lineTo(S * 0.85, S * 0.72); c.stroke();
    const tw = (x, y, col) => { c.fillStyle = '#e8e2d0'; c.beginPath(); c.roundRect(x - S * 0.08, y - S * 0.08, S * 0.16, S * 0.16, S * 0.03); c.fill(); c.fillStyle = col; c.beginPath(); c.arc(x, y, S * 0.055, 0, 7); c.fill(); c.fillStyle = '#2d2d2d'; c.fillRect(x, y - S * 0.012, S * 0.08, S * 0.025); };
    tw(S * 0.34, S * 0.52, '#f2994a'); tw(S * 0.74, S * 0.48, '#56ccf2');
    c.fillStyle = '#eb5757'; c.beginPath(); c.arc(S * 0.55, S * 0.42, S * 0.045, 0, 7); c.fill();
    c.fillStyle = '#f2c94c'; c.beginPath(); c.arc(S * 0.4, S * 0.3, S * 0.035, 0, 7); c.fill();
  }

  const realUpdate = update;
  PP.run({
    id: GAME_ID,
    title: 'Tower Defense',
    intro: 'Build and upgrade towers along the path to stop 20 waves of enemies.\nEarn gold for every defeat and protect your base.',
    choices: () => [{ label: 'Map', options: MAP_NAMES, value: mapIdx, onChange: i => { mapIdx = i; store.set('map', i); path = null; PP.showMain(); } }],
    bestText: () => { const b = store.get(`best-${mapIdx}`, 0); return b ? `Best score on ${MAP_NAMES[mapIdx]}: ${b}` : ''; },
    pauseText: () => `Wave ${wave}/${WAVES} · Lives ${lives} · Gold ${gold}`,
    init() { mapIdx = store.get('map', 0); },
    start() { PP.game.update = realUpdate; start(); },
    update, draw, pointerDown, pointerMove, keyDown, demo, icon,
    resize() { if (path) layout(); },
  });
})();
