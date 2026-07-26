// Big-screen mode: the ES-DE theme engine's renderer half.
//
// A theme's normalized 0-1 coordinates map onto a fixed-aspect "stage" div
// that is scaled to the window — so one layout is resolution-independent,
// exactly as the XML format assumes. Everything is DOM + CSS; no canvas
// needed for the element set we support.
/* global romdeck */
'use strict';

const STAGE_W = 1920; // stage design space; CSS transform scales it to fit
const STAGE_H = 1080;

const bs = {
  active: false,
  theme: null, // parsed model from main
  view: 'system', // system | gamelist
  systems: [], // [{ name, roms }]
  sysIndex: 0,
  gameIndex: 0,
  els: new Map(), // element name -> DOM node
  onLaunch: null,
  onExit: null,
};

function hex(color, fallback = '#ffffff') {
  if (!color) return fallback;
  const c = String(color).replace('#', '');
  if (c.length === 6) return `#${c}`;
  if (c.length === 8) {
    // ES themes use RRGGBBAA
    const a = parseInt(c.slice(6, 8), 16) / 255;
    return `rgba(${parseInt(c.slice(0, 2), 16)},${parseInt(c.slice(2, 4), 16)},${parseInt(c.slice(4, 6), 16)},${a})`;
  }
  return fallback;
}

function place(node, props) {
  const [x, y] = props.pos ?? [0, 0];
  const [w, h] = props.size ?? [0, 0];
  const [ox, oy] = props.origin ?? [0, 0];
  node.style.position = 'absolute';
  node.style.left = `${x * 100}%`;
  node.style.top = `${y * 100}%`;
  if (w) node.style.width = `${w * 100}%`;
  if (h) node.style.height = `${h * 100}%`;
  const tx = -ox * 100;
  const ty = -oy * 100;
  const rot = props.rotation ? ` rotate(${props.rotation}deg)` : '';
  node.style.transform = `translate(${tx}%, ${ty}%)${rot}`;
  if (props.opacity !== undefined) node.style.opacity = String(props.opacity);
  if (props.zIndex !== undefined) node.style.zIndex = String(props.zIndex);
  if (props.fontSize) node.style.fontSize = `${props.fontSize * STAGE_H}px`;
  if (props.horizontalAlignment) node.style.textAlign = props.horizontalAlignment;
}

// ── data the theme's <metadata> tags resolve against ─────────────────
function currentSystem() {
  return bs.systems[bs.sysIndex] ?? null;
}
function currentGame() {
  return currentSystem()?.roms[bs.gameIndex] ?? null;
}

function metaValue(key) {
  const sys = currentSystem();
  const game = currentGame();
  switch (key) {
    case 'system.fullName': return sys?.name ?? '';
    case 'system.gameCount': return sys ? `${sys.roms.length} games` : '';
    case 'game.name': return game?.name ?? '';
    case 'game.cover': return game?.art ?? '';
    case 'game.video': return '';
    case 'game.detail': {
      if (!game) return '';
      const bits = [];
      if (game.verified) bits.push('✓ verified');
      if (game.meta?.playcount) bits.push(`played ${game.meta.playcount}×`);
      if (game.meta?.genre) bits.push(game.meta.genre);
      return bits.join('  ·  ');
    }
    default: return '';
  }
}

// ── element builders ─────────────────────────────────────────────────
function buildImage(el) {
  const node = document.createElement('div');
  node.className = 'te-image';
  place(node, el.props);
  if (el.props.color && !el.props.path && !el.props.metadata) {
    node.style.background = hex(el.props.color);
  }
  if (el.props.path) {
    const img = document.createElement('img');
    img.src = el.props.path;
    node.appendChild(img);
  }
  return node;
}

function buildText(el) {
  const node = document.createElement('div');
  node.className = 'te-text';
  place(node, el.props);
  node.style.color = hex(el.props.color);
  return node;
}

function buildCarousel(el) {
  const node = document.createElement('div');
  node.className = 'te-carousel';
  place(node, el.props);
  node.style.background = hex(el.props.color, 'transparent');
  return node;
}

function buildTextlist(el) {
  const node = document.createElement('div');
  node.className = 'te-textlist';
  place(node, el.props);
  return node;
}

function buildVideo(el) {
  const node = document.createElement('div');
  node.className = 'te-video';
  place(node, el.props);
  return node;
}

const BUILDERS = {
  image: buildImage,
  text: buildText,
  carousel: buildCarousel,
  textlist: buildTextlist,
  video: buildVideo,
  rating: buildText,
  datetime: buildText,
};

// ── rendering ────────────────────────────────────────────────────────
function buildView(viewName) {
  const stage = document.getElementById('bs-stage');
  stage.replaceChildren();
  bs.els.clear();
  const elements = bs.theme?.views?.[viewName] ?? [];
  for (const el of elements) {
    const build = BUILDERS[el.type];
    if (!build) continue; // unsupported element types are skipped, not fatal
    const node = build(el);
    node.dataset.el = el.name;
    stage.appendChild(node);
    bs.els.set(el.name, { node, el });
  }
  paint();
}

function paint() {
  for (const [, { node, el } ] of bs.els) {
    const p = el.props;
    if (el.type === 'text' || el.type === 'rating' || el.type === 'datetime') {
      node.textContent = p.metadata ? metaValue(p.metadata) : (p.text ?? '');
    } else if (el.type === 'image' && p.metadata) {
      node.replaceChildren();
      const src = metaValue(p.metadata);
      if (src) {
        const img = document.createElement('img');
        img.src = src;
        node.appendChild(img);
      } else {
        node.style.background = 'rgba(255,255,255,0.05)';
        node.style.borderRadius = '10px';
      }
    } else if (el.type === 'carousel') {
      paintCarousel(node, el);
    } else if (el.type === 'textlist') {
      paintTextlist(node, el);
    }
  }
}

function paintCarousel(node, el) {
  node.replaceChildren();
  // Never wrap past the real system count — repeating the same console in two
  // slots reads as a bug, not a carousel.
  const count = Math.min(el.props.maxItemCount ?? 5, bs.systems.length);
  const half = Math.floor(count / 2);
  const seen = new Set();
  for (let off = -half; off <= half; off++) {
    const idx = bs.sysIndex + off;
    const wrapped = (idx % bs.systems.length + bs.systems.length) % bs.systems.length;
    if (seen.has(wrapped) && bs.systems.length <= count) continue;
    seen.add(wrapped);
    const sys = bs.systems[wrapped];
    if (!sys) continue;
    const item = document.createElement('div');
    item.className = 'te-caritem' + (off === 0 ? ' sel' : '');
    item.style.background = hex(off === 0 ? el.props.selectedColor : el.props.color, '#1a1f2b');
    item.style.color = hex(el.props.textColor, '#e8ecf4');
    if (off === 0 && el.props.itemScale) item.style.transform = `scale(${el.props.itemScale})`;
    item.textContent = sys.name;
    node.appendChild(item);
  }
}

function paintTextlist(node, el) {
  node.replaceChildren();
  const sys = currentSystem();
  if (!sys) return;
  const rows = 12;
  const start = Math.max(0, Math.min(bs.gameIndex - Math.floor(rows / 2), sys.roms.length - rows));
  for (let i = Math.max(0, start); i < Math.min(sys.roms.length, start + rows); i++) {
    const row = document.createElement('div');
    const sel = i === bs.gameIndex;
    row.className = 'te-row' + (sel ? ' sel' : '');
    row.style.color = hex(sel ? el.props.selectedColor : el.props.color, '#8b94a7');
    if (sel) row.style.background = hex(el.props.selectorColor, 'rgba(255,255,255,0.08)');
    row.style.lineHeight = String(el.props.lineSpacing ?? 1.4);
    row.textContent = (sys.roms[i].meta?.favorite ? '★ ' : '') + sys.roms[i].name;
    node.appendChild(row);
  }
}

function fitStage() {
  const stage = document.getElementById('bs-stage');
  const scale = Math.min(window.innerWidth / STAGE_W, window.innerHeight / STAGE_H);
  stage.style.width = `${STAGE_W}px`;
  stage.style.height = `${STAGE_H}px`;
  stage.style.transform = `translate(-50%, -50%) scale(${scale})`;
}

// ── navigation ───────────────────────────────────────────────────────
function nav(action) {
  if (!bs.active) return false;
  const sys = currentSystem();
  if (bs.view === 'system') {
    if (action === 'left') { bs.sysIndex = (bs.sysIndex - 1 + bs.systems.length) % bs.systems.length; bs.gameIndex = 0; paint(); }
    else if (action === 'right') { bs.sysIndex = (bs.sysIndex + 1) % bs.systems.length; bs.gameIndex = 0; paint(); }
    else if (action === 'confirm') { bs.view = 'gamelist'; buildView('gamelist'); }
    else if (action === 'back') bs.onExit?.();
    return true;
  }
  // gamelist
  if (action === 'up') { bs.gameIndex = Math.max(0, bs.gameIndex - 1); paint(); }
  else if (action === 'down') { bs.gameIndex = Math.min((sys?.roms.length ?? 1) - 1, bs.gameIndex + 1); paint(); }
  else if (action === 'left' || action === 'prevSystem') { bs.gameIndex = Math.max(0, bs.gameIndex - 10); paint(); }
  else if (action === 'right' || action === 'nextSystem') { bs.gameIndex = Math.min((sys?.roms.length ?? 1) - 1, bs.gameIndex + 10); paint(); }
  else if (action === 'confirm') { const g = currentGame(); if (g) bs.onLaunch?.(g); }
  else if (action === 'back') { bs.view = 'system'; buildView('system'); }
  return true;
}

// ── public API ───────────────────────────────────────────────────────
export async function enterBigScreen({ roms, themeName, variant, colorScheme, onLaunch, onExit }) {
  const grouped = new Map();
  for (const rom of roms) {
    if (!grouped.has(rom.system)) grouped.set(rom.system, []);
    grouped.get(rom.system).push(rom);
  }
  bs.systems = [...grouped.entries()]
    .map(([name, list]) => ({ name, roms: list }))
    .sort((a, b) => a.name.localeCompare(b.name));
  if (!bs.systems.length) return { error: 'no games in library' };

  const res = await romdeck.themeLoad(themeName, { variant, colorScheme });
  if (res.error) return res;
  bs.theme = res.theme;
  bs.active = true;
  bs.view = 'system';
  bs.sysIndex = 0;
  bs.gameIndex = 0;
  bs.onLaunch = onLaunch;
  bs.onExit = onExit;

  document.getElementById('bigscreen').classList.remove('hidden');
  fitStage();
  buildView('system');
  window.addEventListener('resize', fitStage);
  return { ok: true };
}

export function exitBigScreen() {
  bs.active = false;
  document.getElementById('bigscreen').classList.add('hidden');
  window.removeEventListener('resize', fitStage);
}

export function bigScreenNav(action) {
  return nav(action);
}

export function bigScreenActive() {
  return bs.active;
}

export function bigScreenRefresh(roms) {
  if (!bs.active) return;
  const grouped = new Map();
  for (const rom of roms) {
    if (!grouped.has(rom.system)) grouped.set(rom.system, []);
    grouped.get(rom.system).push(rom);
  }
  const name = currentSystem()?.name;
  bs.systems = [...grouped.entries()].map(([n, l]) => ({ name: n, roms: l })).sort((a, b) => a.name.localeCompare(b.name));
  const idx = bs.systems.findIndex((s) => s.name === name);
  if (idx >= 0) bs.sysIndex = idx;
  paint();
}
