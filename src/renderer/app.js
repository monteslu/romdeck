// romdeck renderer — library grid, system rail, sessions, toasts, pad/keyboard nav.
/* global romdeck */
'use strict';

import {
  enterBigScreen, exitBigScreen, bigScreenNav, bigScreenActive, bigScreenRefresh,
} from './bigscreen.js';

const $ = (id) => document.getElementById(id);

const state = {
  romsDir: null,
  roms: [],
  system: 'All',
  query: '',
  filtered: [],
  selected: 0,
  playing: new Map(), // sessionId -> { romPath, paused, speed }
};

// Deterministic pleasant gradient per system for placeholder art (real box art
// arrives with the scraper milestone).
function hueOf(str) {
  let h = 0;
  for (const c of str) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % 360;
}
function artStyle(rom) {
  const h = hueOf(rom.system);
  const h2 = (h + 40) % 360;
  return `background: linear-gradient(135deg, hsl(${h} 45% 30%), hsl(${h2} 55% 18%))`;
}

function systems() {
  const counts = new Map();
  let favs = 0;
  for (const r of state.roms) {
    counts.set(r.system, (counts.get(r.system) ?? 0) + 1);
    if (r.meta?.favorite) favs++;
  }
  const rail = [['All', state.roms.length]];
  if (favs > 0) rail.push(['★ Favorites', favs]);
  rail.push(...[...counts.entries()].sort((a, b) => a[0].localeCompare(b[0])));
  return rail;
}

function applyFilter() {
  let list = state.roms;
  if (state.system === '★ Favorites') list = list.filter((r) => r.meta?.favorite);
  else if (state.system !== 'All') list = list.filter((r) => r.system === state.system);
  if (state.query) {
    const q = state.query.toLowerCase();
    list = list.filter((r) => r.name.toLowerCase().includes(q) || r.system.toLowerCase().includes(q));
  }
  state.filtered = list;
  state.selected = Math.min(state.selected, Math.max(0, state.filtered.length - 1));
}

function render() {
  // system rail
  const rail = $('systems');
  rail.replaceChildren();
  for (const [name, count] of systems()) {
    const el = document.createElement('div');
    el.className = 'sysitem' + (name === state.system ? ' active' : '');
    el.innerHTML = `<span></span><span class="count"></span>`;
    el.firstChild.textContent = name;
    el.lastChild.textContent = count;
    el.onclick = () => { state.system = name; state.selected = 0; applyFilter(); render(); };
    rail.appendChild(el);
  }

  // grid
  const grid = $('grid');
  grid.replaceChildren();
  $('empty').classList.toggle('hidden', state.roms.length > 0);
  $('dirpath').textContent = state.romsDir ?? 'no folder selected';

  const playingPaths = new Set([...state.playing.values()].map((s) => s.romPath));
  state.filtered.forEach((rom, i) => {
    const tile = document.createElement('div');
    tile.className = 'tile' + (i === state.selected ? ' selected' : '');
    tile.innerHTML = `
      <div class="art"></div>
      <div class="meta"><div class="name"></div><div class="sys"></div></div>`;
    const art = tile.querySelector('.art');
    if (rom.art) {
      const img = document.createElement('img');
      img.loading = 'lazy';
      img.src = rom.art;
      art.appendChild(img);
    } else {
      art.style.cssText = artStyle(rom);
      art.textContent = rom.name.split(/\s+/).slice(0, 2).map((w) => w[0] ?? '').join('').toUpperCase();
    }
    tile.querySelector('.name').textContent = rom.name;
    tile.querySelector('.name').title = rom.file;
    tile.querySelector('.sys').textContent = rom.system;
    if (rom.meta?.favorite) {
      const fav = document.createElement('div');
      fav.className = 'fav';
      fav.textContent = '★';
      tile.appendChild(fav);
    }
    if (rom.verified) {
      const v = document.createElement('div');
      v.className = 'verified';
      v.title = `CRC-verified: ${rom.datName}`;
      v.textContent = '✓';
      tile.appendChild(v);
    }
    if (playingPaths.has(rom.path)) {
      const badge = document.createElement('div');
      badge.className = 'playing';
      badge.textContent = 'PLAYING';
      tile.appendChild(badge);
      const stop = document.createElement('button');
      stop.className = 'stop';
      stop.textContent = 'stop';
      stop.onclick = (ev) => {
        ev.stopPropagation();
        for (const [id, s] of state.playing) if (s.romPath === rom.path) romdeck.stopSession(id);
      };
      tile.appendChild(stop);
    }
    tile.onclick = () => { state.selected = i; render(); };
    tile.ondblclick = () => launch(rom);
    grid.appendChild(tile);
  });

  const n = state.playing.size;
  $('sessioncount').classList.toggle('hidden', n === 0);
  $('sessioncount').textContent = `${n} playing`;

  renderDetails(); // async; renders the side panel for the selection
}

function selectedRom() {
  return state.filtered[state.selected] ?? null;
}

async function launch(rom, opts = {}) {
  if (!rom) return;
  $('status').textContent = `launching ${rom.name}…`;
  const res = await romdeck.launch(rom.path, opts);
  if (res?.error) toast('Launch failed', res.error, true);
}

// ── details panel (selected game + live session controls + states) ───
function sessionFor(rom) {
  if (!rom) return null;
  for (const [id, s] of state.playing) if (s.romPath === rom.path) return { id, ...s };
  return null;
}

async function renderDetails() {
  const rom = selectedRom();
  const panel = $('details');
  if (!rom) {
    panel.classList.add('hidden');
    return;
  }
  panel.classList.remove('hidden');
  $('dt-name').textContent = rom.name;
  const bits = [rom.system];
  if (rom.verified) bits.push('✓ verified');
  if (rom.meta?.playcount) bits.push(`played ${rom.meta.playcount}×`);
  if (rom.meta?.lastplayed) {
    const lp = rom.meta.lastplayed;
    const d = new Date(`${lp.slice(0, 4)}-${lp.slice(4, 6)}-${lp.slice(6, 8)}T${lp.slice(9, 11)}:${lp.slice(11, 13)}:${lp.slice(13, 15)}`);
    if (!Number.isNaN(d.getTime())) bits.push(`last ${d.toLocaleDateString()}`);
  }
  $('dt-system').textContent = bits.join(' · ');

  const live = sessionFor(rom);
  const actions = $('dt-actions');
  actions.replaceChildren();
  const btn = (label, fn, cls = '') => {
    const b = document.createElement('button');
    b.textContent = label;
    if (cls) b.className = cls;
    b.onclick = fn;
    actions.appendChild(b);
    return b;
  };

  const fav = rom.meta?.favorite;
  btn(fav ? '★' : '☆', async () => {
    await romdeck.setFavorite(rom.path, !fav);
    await reloadLibrary();
  }, fav ? 'active' : '');
  btn('🧬 Cheats', () => openCheats(rom));

  if (!live) {
    btn('▶ Play', () => launch(rom), 'primary');
    btn('Play from start', () => launch(rom, { resume: false }));
    if (!rom.art) {
      btn('🎨 Get art', async () => {
        $('status').textContent = 'fetching box art…';
        const r = await romdeck.scrape(rom.path);
        if (r.status === 'ok') { toast('Box art found', rom.name); await reloadLibrary(); }
        else toast('No art match', r.status === 'unsupported' ? 'No thumbnail repo for this system' : 'Name not found in libretro-thumbnails');
        $('status').textContent = 'ready';
      });
    }
  } else {
    btn(live.paused ? '▶ Resume' : '⏸ Pause', async () => {
      const r = await romdeck.cmd(live.id, live.paused ? 'resume' : 'pause');
      if (r.error) toast('Session', r.error, true);
      else state.playing.get(live.id).paused = !live.paused;
      renderDetails();
    });
    btn('💾 Save', async () => {
      const name = `save-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`;
      const r = await romdeck.saveState(live.id, name);
      r.error ? toast('Save failed', r.error, true) : toast('State saved', name);
      renderDetails();
    });
    btn('📷', async () => {
      const r = await romdeck.screenshot(live.id);
      r.error ? toast('Screenshot failed', r.error, true) : toast('Screenshot', r.result.file);
    });
    const ff = live.speed !== 1;
    btn(ff ? '⏩ 4x' : '⏩', async () => {
      const r = await romdeck.cmd(live.id, 'setSpeed', { x: ff ? 1 : 4 });
      if (r.error) toast('Session', r.error, true);
      else state.playing.get(live.id).speed = r.result.speed;
      renderDetails();
    }, ff ? 'active' : '');
    btn('⏪', async () => {
      const r = await romdeck.cmd(live.id, 'rewind', { steps: 2 });
      if (r.error) toast('Rewind', r.error, true);
    });
    btn('⛶', async () => {
      const st = await romdeck.cmd(live.id, 'getStatus');
      const on = !(st.result?.fullscreen ?? false);
      await romdeck.cmd(live.id, 'setFullscreen', { on });
    });
    btn('✕ Stop', () => romdeck.stopSession(live.id), 'danger');
  }

  // states list
  const list = await romdeck.statesList(rom.path);
  const wrap = $('dt-states');
  wrap.replaceChildren();
  if (!list.length) {
    const none = document.createElement('div');
    none.className = 'none';
    none.textContent = 'No save states yet.';
    wrap.appendChild(none);
  }
  for (const st of list) {
    const card = document.createElement('div');
    card.className = 'state-card';
    const img = document.createElement('img');
    if (st.screenshotDataUrl) img.src = st.screenshotDataUrl;
    card.appendChild(img);
    const meta = document.createElement('div');
    meta.className = 'st-meta';
    const nm = document.createElement('div');
    nm.className = 'st-name';
    nm.textContent = st.name === 'auto' ? 'Resume point' : st.name;
    const tm = document.createElement('div');
    tm.className = 'st-time';
    tm.textContent = st.savedAt ? new Date(st.savedAt).toLocaleString() : '';
    const row = document.createElement('div');
    row.className = 'st-actions';
    const loadB = document.createElement('button');
    loadB.textContent = live ? 'Load' : 'Play from here';
    loadB.onclick = async () => {
      if (live) {
        const r = await romdeck.loadState(live.id, st.name);
        r.error ? toast('Load failed', r.error, true) : toast('State loaded', nm.textContent);
      } else {
        launch(rom, { resume: false, stateName: st.name });
      }
    };
    const delB = document.createElement('button');
    delB.className = 'danger';
    delB.textContent = 'Delete';
    delB.onclick = async () => {
      await romdeck.statesDelete(rom.path, st.name);
      renderDetails();
    };
    row.append(loadB, delB);
    meta.append(nm, tm, row);
    card.appendChild(meta);
    wrap.appendChild(card);
  }
}

function toast(title, body, isCrash = false, actions = []) {
  const el = document.createElement('div');
  el.className = 'toast' + (isCrash ? ' crash' : '');
  el.innerHTML = `<div class="title"></div><div class="body"></div>`;
  el.querySelector('.title').textContent = title;
  el.querySelector('.body').textContent = body;
  if (actions.length) {
    const row = document.createElement('div');
    row.className = 'actions';
    for (const [label, fn] of actions) {
      const b = document.createElement('button');
      b.textContent = label;
      b.onclick = () => { fn(); el.remove(); };
      row.appendChild(b);
    }
    el.appendChild(row);
  }
  $('toasts').appendChild(el);
  setTimeout(() => el.remove(), isCrash ? 12000 : 4000);
}

// ── navigation (keyboard + gamepad share one code path) ──────────────
function columns() {
  const grid = $('grid');
  if (!grid.children.length) return 1;
  const style = getComputedStyle(grid);
  return Math.max(1, style.gridTemplateColumns.split(' ').length);
}

function nav(action) {
  if (bigScreenActive()) {
    bigScreenNav(action);
    return;
  }
  const cols = columns();
  const max = state.filtered.length - 1;
  if (max < 0) return;
  let i = state.selected;
  if (action === 'left') i -= 1;
  else if (action === 'right') i += 1;
  else if (action === 'up') i -= cols;
  else if (action === 'down') i += cols;
  else if (action === 'confirm') return launch(selectedRom());
  else if (action === 'prevSystem' || action === 'nextSystem') {
    const names = systems().map(([n]) => n);
    const cur = names.indexOf(state.system);
    const next = (cur + (action === 'nextSystem' ? 1 : names.length - 1)) % names.length;
    state.system = names[next];
    state.selected = 0;
    applyFilter();
    return render();
  } else return;
  state.selected = Math.max(0, Math.min(max, i));
  render();
  document.querySelector('.tile.selected')?.scrollIntoView({ block: 'nearest' });
}

document.addEventListener('keydown', (ev) => {
  if (ev.key === 'F11') { ev.preventDefault(); toggleBigScreen(); return; }
  if (ev.key === 'Escape' && bigScreenActive()) { ev.preventDefault(); nav('back'); return; }
  const map = {
    ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
    Enter: 'confirm', Backspace: 'back', '[': 'prevSystem', ']': 'nextSystem',
  };
  if (map[ev.key]) { ev.preventDefault(); nav(map[ev.key]); }
});

// ── big-screen mode ──────────────────────────────────────────────────
async function toggleBigScreen() {
  if (bigScreenActive()) {
    exitBigScreen();
    await romdeck.setFullscreen(false);
    return;
  }
  const prefs = await romdeck.themePrefs();
  const res = await enterBigScreen({
    roms: state.roms,
    themeName: prefs.theme,
    variant: prefs.variant,
    colorScheme: prefs.colorScheme,
    onLaunch: (rom) => launch(rom),
    onExit: () => toggleBigScreen(),
  });
  if (res?.error) { toast('Big-screen mode', res.error, true); return; }
  await romdeck.setFullscreen(true);
}

$('bigscreenbtn').onclick = toggleBigScreen;

// ── homebrew feed ────────────────────────────────────────────────────
async function openFeed() {
  $('feedmodal').classList.remove('hidden');
  const list = $('feedlist');
  list.textContent = 'Loading…';
  const entries = await romdeck.feedList();
  list.replaceChildren();
  if (!entries.length) {
    list.textContent = 'Feed unavailable.';
    return;
  }
  for (const e of entries) {
    const row = document.createElement('div');
    row.className = 'feedrow';
    const kind = document.createElement('span');
    kind.className = `kind ${e.kind}`;
    kind.textContent = e.kind;
    const info = document.createElement('div');
    info.className = 'finfo';
    const t = document.createElement('div');
    t.className = 'ftitle';
    t.textContent = `${e.title} — ${e.systemLabel ?? e.system}`;
    const d = document.createElement('div');
    d.className = 'fdesc';
    d.textContent = `${e.description} · ${e.author} · ${e.license}`;
    info.append(t, d);
    const btn = document.createElement('button');
    btn.textContent = e.installed ? 'Installed' : 'Add to library';
    btn.disabled = !!e.installed;
    btn.onclick = async () => {
      btn.disabled = true;
      btn.textContent = 'Adding…';
      const res = await romdeck.feedInstall(e.id);
      if (res.error) {
        toast('Homebrew', res.error, true);
        btn.disabled = false;
        btn.textContent = 'Add to library';
      } else {
        toast('Added to library', e.title);
        btn.textContent = 'Installed';
        await reloadLibrary();
      }
    };
    row.append(kind, info, btn);
    list.appendChild(row);
  }
}
$('feedbtn').onclick = openFeed;
$('feedclose').onclick = () => $('feedmodal').classList.add('hidden');
$('feedmodal').onclick = (ev) => { if (ev.target.id === 'feedmodal') $('feedmodal').classList.add('hidden'); };

// ── developer mode: live memory viewer ───────────────────────────────
const dev = { sessionId: null, regions: [], prev: null, timer: null, base: null };

function devSessionId() {
  const rom = selectedRom();
  const live = rom ? sessionFor(rom) : null;
  return live?.id ?? ([...state.playing.keys()][0] ?? null);
}

async function openDev() {
  $('devmodal').classList.remove('hidden');
  dev.sessionId = devSessionId();
  if (dev.sessionId === null) {
    $('dev-status').textContent = 'No game running — start one, then reopen this panel.';
    $('dev-region').replaceChildren();
    $('dev-hex').textContent = '';
    return;
  }
  const res = await romdeck.dev(dev.sessionId, 'memoryInfo');
  if (res.error) { $('dev-status').textContent = res.error; return; }
  dev.regions = res.result.regions;
  const sel = $('dev-region');
  sel.replaceChildren();
  for (const r of dev.regions) {
    const o = document.createElement('option');
    o.value = String(r.id);
    o.textContent = `${r.name} (${r.size.toLocaleString()} bytes)`;
    sel.appendChild(o);
  }
  $('dev-status').textContent = `Inspecting session ${dev.sessionId} — memory is live while the game runs.`;
  readMem();
}

function parseOffset() {
  const raw = $('dev-offset').value.trim();
  const n = raw.startsWith('0x') ? parseInt(raw, 16) : parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

async function readMem() {
  if (dev.sessionId === null) return;
  const region = Number($('dev-region').value || 2);
  const offset = parseOffset();
  const res = await romdeck.dev(dev.sessionId, 'readMemory', { region, offset, length: 256 });
  if (res.error) { $('dev-status').textContent = res.error; return; }
  const bytes = Uint8Array.from(atob(res.result.dataB64), (c) => c.charCodeAt(0));
  renderHex(bytes, offset);
  dev.prev = bytes;
}

function renderHex(bytes, offset) {
  const out = [];
  for (let row = 0; row < bytes.length; row += 16) {
    const addr = (offset + row).toString(16).padStart(6, '0');
    let hex = '';
    let ascii = '';
    for (let i = 0; i < 16 && row + i < bytes.length; i++) {
      const b = bytes[row + i];
      const changed = dev.prev && dev.prev[row + i] !== undefined && dev.prev[row + i] !== b;
      const h = b.toString(16).padStart(2, '0');
      hex += changed ? `<span class="chg">${h}</span> ` : `${h} `;
      ascii += b >= 32 && b < 127 ? String.fromCharCode(b) : '.';
    }
    out.push(`<span class="addr">${addr}</span>  ${hex.padEnd(0)} ${escapeHtml(ascii)}`);
  }
  $('dev-hex').innerHTML = out.join('\n');
}

function escapeHtml(s) {
  return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

// "find changed bytes": snapshot the whole region, wait, snapshot again, and
// report the addresses that moved — the first step of hunting a lives counter.
async function scanChanged() {
  if (dev.sessionId === null) return;
  const region = Number($('dev-region').value || 2);
  const info = dev.regions.find((r) => r.id === region);
  const len = Math.min(info?.size ?? 8192, 65536);
  const out = $('dev-scanout');
  out.textContent = 'Snapshot 1…';
  const a = await romdeck.dev(dev.sessionId, 'readMemory', { region, offset: 0, length: len });
  if (a.error) { out.textContent = a.error; return; }
  out.textContent = 'Playing for 1s…';
  await new Promise((r) => setTimeout(r, 1000));
  const b = await romdeck.dev(dev.sessionId, 'readMemory', { region, offset: 0, length: len });
  if (b.error) { out.textContent = b.error; return; }
  const A = Uint8Array.from(atob(a.result.dataB64), (c) => c.charCodeAt(0));
  const B = Uint8Array.from(atob(b.result.dataB64), (c) => c.charCodeAt(0));
  const hits = [];
  for (let i = 0; i < A.length && hits.length < 60; i++) {
    if (A[i] !== B[i]) hits.push(`${i.toString(16).padStart(4, '0')}: ${A[i]}→${B[i]}`);
  }
  out.textContent = hits.length
    ? `${hits.length} changed: ${hits.join('  ')}`
    : 'nothing changed in that second (is the game paused?)';
}

$('devbtn').onclick = openDev;
$('dev-refresh').onclick = readMem;
$('dev-scan').onclick = scanChanged;
$('dev-region').onchange = () => { dev.prev = null; readMem(); };
$('dev-auto').onchange = () => {
  clearInterval(dev.timer);
  if ($('dev-auto').checked) dev.timer = setInterval(readMem, 500);
};
$('devclose').onclick = () => {
  clearInterval(dev.timer);
  $('dev-auto').checked = false;
  $('devmodal').classList.add('hidden');
};

// ── settings (with provenance) ───────────────────────────────────────
// Scope follows the selection: with a game selected you can pin a setting to
// that game or its platform; otherwise you're editing the global default.
let settingsScope = 'global';

async function openSettings() {
  const rom = selectedRom();
  const ctx = rom ? { platform: rom.short, gameKey: null } : {};
  const { settings } = await romdeck.settingsGet(ctx);

  $('settings-scope').textContent = rom
    ? `Editing ${settingsScope === 'global' ? 'defaults for all games' : `${rom.system} games only`} — badges show where each value comes from.`
    : 'Editing defaults for all games — badges show where each value comes from.';

  const list = $('settingslist');
  list.replaceChildren();

  if (rom) {
    const scopeRow = document.createElement('div');
    scopeRow.className = 'setrow';
    const info = document.createElement('div');
    info.className = 'sinfo';
    info.innerHTML = '<div class="slabel">Apply changes to</div>';
    const sel = document.createElement('select');
    for (const [v, label] of [['global', 'All games'], [`platform:${rom.short}`, `${rom.system} only`]]) {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = label;
      sel.appendChild(o);
    }
    sel.value = settingsScope;
    sel.onchange = () => { settingsScope = sel.value; openSettings(); };
    scopeRow.append(info, sel);
    list.appendChild(scopeRow);
  }

  for (const s of settings) {
    const row = document.createElement('div');
    row.className = 'setrow';
    const info = document.createElement('div');
    info.className = 'sinfo';
    const lab = document.createElement('div');
    lab.className = 'slabel';
    lab.textContent = s.label;
    const help = document.createElement('div');
    help.className = 'shelp';
    help.textContent = s.help;
    info.append(lab, help);

    const prov = document.createElement('span');
    prov.className = `prov ${s.source}`;
    prov.textContent = s.source === 'default' ? 'default' : s.source;
    prov.title = `Value comes from the "${s.layer}" layer`;

    let control;
    if (s.type === 'bool') {
      control = document.createElement('input');
      control.type = 'checkbox';
      control.checked = !!s.value;
      control.onchange = async () => {
        await romdeck.settingsSet(s.key, control.checked, settingsScope);
        openSettings();
      };
    } else {
      control = document.createElement('select');
      for (const o of s.options ?? []) {
        const opt = document.createElement('option');
        opt.value = o.value;
        opt.textContent = o.label;
        control.appendChild(opt);
      }
      control.value = String(s.value);
      control.onchange = async () => {
        await romdeck.settingsSet(s.key, control.value, settingsScope);
        openSettings();
      };
    }

    row.append(info, prov, control);
    // clearing a layer lets the value fall back through the cascade
    if (s.source !== 'default') {
      const clr = document.createElement('button');
      clr.textContent = '↺';
      clr.title = `Clear the ${s.layer} value and inherit again`;
      clr.onclick = async () => {
        await romdeck.settingsSet(s.key, null, s.layer);
        openSettings();
      };
      row.appendChild(clr);
    }
    list.appendChild(row);
  }

  // core versions
  const coreList = $('corelist');
  coreList.textContent = 'Checking npm for core updates…';
  romdeck.coresCheck().then((res) => {
    coreList.replaceChildren();
    if (!res.cores.length) {
      coreList.textContent = 'No cores found.';
      return;
    }
    for (const c of res.cores) {
      const row = document.createElement('div');
      row.className = 'corerow';
      const nm = document.createElement('span');
      nm.textContent = c.name.replace('romdev-core-', '');
      const ver = document.createElement('span');
      ver.className = 'cver';
      ver.textContent = `v${c.version}`;
      const stat = document.createElement('span');
      stat.className = `cstat ${c.status}`;
      stat.textContent = c.status === 'update' ? `→ v${c.latest} available`
        : c.status === 'current' ? 'up to date'
        : c.status === 'offline' ? 'offline' : '';
      row.append(nm, ver, stat);
      coreList.appendChild(row);
    }
    const note = document.createElement('div');
    note.className = 'shelp';
    note.textContent = res.updatesAvailable
      ? `${res.updatesAvailable} core update(s) available — cores version independently of romdeck:`
      : 'All cores are current. Cores version independently of romdeck.';
    coreList.appendChild(note);
    if (res.updatesAvailable) {
      const cmd = document.createElement('div');
      cmd.className = 'corecmd';
      cmd.textContent = res.updateCommand;
      coreList.appendChild(cmd);
    }
  });

  $('settingsmodal').classList.remove('hidden');
}

$('settingsbtn').onclick = openSettings;
$('settingsclose').onclick = () => $('settingsmodal').classList.add('hidden');
$('settingsmodal').onclick = (ev) => { if (ev.target.id === 'settingsmodal') $('settingsmodal').classList.add('hidden'); };

// ── cheats drawer ────────────────────────────────────────────────────
let cheatRom = null;

async function openCheats(rom) {
  cheatRom = rom;
  $('cheat-game').textContent = rom.name;
  await renderCheats();
  $('cheatmodal').classList.remove('hidden');
}

async function renderCheats() {
  const codes = await romdeck.cheatsList(cheatRom.path);
  const list = $('cheatlist');
  list.replaceChildren();
  if (!codes.length) {
    const none = document.createElement('div');
    none.className = 'shelp';
    none.textContent = 'No cheats yet. Add a code below, or import a RetroArch .cht file.';
    list.appendChild(none);
  }
  codes.forEach((c, i) => {
    const row = document.createElement('div');
    row.className = 'cheatrow';
    const on = document.createElement('input');
    on.type = 'checkbox';
    on.checked = !!c.enabled;
    on.onchange = async () => { await romdeck.cheatsToggle(cheatRom.path, i, on.checked); renderCheats(); };
    const desc = document.createElement('span');
    desc.className = 'cdesc';
    desc.textContent = c.desc;
    const code = document.createElement('span');
    code.className = 'ccode';
    code.textContent = c.code;
    const del = document.createElement('button');
    del.textContent = '✕';
    del.onclick = async () => { await romdeck.cheatsRemove(cheatRom.path, i); renderCheats(); };
    row.append(on, desc, code, del);
    list.appendChild(row);
  });
}

$('cheat-add-btn').onclick = async () => {
  const desc = $('cheat-desc').value;
  const code = $('cheat-code').value;
  const res = await romdeck.cheatsAdd(cheatRom.path, { desc, code });
  if (res.error) { toast('Cheat', res.error, true); return; }
  $('cheat-desc').value = '';
  $('cheat-code').value = '';
  renderCheats();
};
$('cheat-import-btn').onclick = async () => {
  const res = await romdeck.cheatsImport(cheatRom.path);
  if (res.error) toast('Import failed', res.error, true);
  else if (!res.canceled) toast('Cheats imported', `${res.added} codes`);
  renderCheats();
};
$('cheatclose').onclick = () => $('cheatmodal').classList.add('hidden');
$('cheatmodal').onclick = (ev) => { if (ev.target.id === 'cheatmodal') $('cheatmodal').classList.add('hidden'); };

// ── theme picker ─────────────────────────────────────────────────────
async function openThemes() {
  const [list, prefs] = await Promise.all([romdeck.themeList(), romdeck.themePrefs()]);
  const wrap = $('themelist');
  wrap.replaceChildren();
  for (const t of list) {
    const card = document.createElement('div');
    card.className = 'theme-card' + (t.name === prefs.theme ? ' sel' : '');
    const nm = document.createElement('div');
    nm.className = 'tname';
    nm.textContent = t.displayName + (t.bundled ? '  (bundled)' : '');
    const meta = document.createElement('div');
    meta.className = 'tmeta';
    meta.textContent = `${t.variants.length} variants · ${t.colorSchemes.length} color schemes · ${t.aspectRatios.join(', ') || 'any aspect'}`;
    card.append(nm, meta);

    const opts = document.createElement('div');
    opts.className = 'opts';
    const mkSel = (label, items, current, onPick) => {
      if (!items.length) return;
      const sel = document.createElement('select');
      for (const it of items) {
        const o = document.createElement('option');
        o.value = it.name;
        o.textContent = `${label}: ${it.label}`;
        sel.appendChild(o);
      }
      sel.value = current ?? items[0].name;
      sel.onchange = () => onPick(sel.value);
      sel.onclick = (ev) => ev.stopPropagation();
      opts.appendChild(sel);
    };
    mkSel('Variant', t.variants, prefs.variant, async (v) => {
      await romdeck.themeSetPrefs({ theme: t.name, variant: v });
      toast('Theme', `${t.displayName} · ${v}`);
    });
    mkSel('Colors', t.colorSchemes, prefs.colorScheme, async (c) => {
      await romdeck.themeSetPrefs({ theme: t.name, colorScheme: c });
      toast('Theme', `${t.displayName} · ${c}`);
    });
    card.appendChild(opts);

    card.onclick = async () => {
      await romdeck.themeSetPrefs({ theme: t.name });
      toast('Theme selected', t.displayName);
      openThemes();
    };
    wrap.appendChild(card);
  }
  $('thememodal').classList.remove('hidden');
}

$('themebtn').onclick = openThemes;
$('themeclose').onclick = () => $('thememodal').classList.add('hidden');
$('thememodal').onclick = (ev) => { if (ev.target.id === 'thememodal') $('thememodal').classList.add('hidden'); };

// Hook for the main process's --bigshot self-check (headless verification of
// the theme engine). Harmless in normal runs.
window.__romdeckTest = {
  enterBigScreen: () => toggleBigScreen(),
  nav: (action) => nav(action),
  openSettings: () => openSettings(),
  openCheats: () => openCheats(selectedRom()),
  state: () => ({
    active: bigScreenActive(),
    elements: document.getElementById('bs-stage').children.length,
    text: [...document.querySelectorAll('#bs-stage .te-text')].map((n) => n.textContent).filter(Boolean),
  }),
};

romdeck.on('pad:nav', (ev) => nav(ev.action));

// ── sessions ─────────────────────────────────────────────────────────
romdeck.on('session:update', (ev) => {
  if (ev.type === 'started') {
    state.playing.set(ev.id, { romPath: ev.romPath, paused: false, speed: 1 });
    $('status').textContent = `${ev.name} running (session ${ev.id})`;
    toast('Now playing', ev.name);
  } else if (ev.type === 'ready') {
    $('status').textContent = `${ev.name} running (${ev.core})`;
    return; // no re-render needed yet; resume event may follow
  } else if (ev.type === 'resumed') {
    toast('Resumed', `${ev.name} — from ${new Date(ev.savedAt).toLocaleString()}`);
    return;
  } else if (ev.type === 'resume-failed') {
    toast('Resume failed', ev.message, true);
    return;
  } else {
    state.playing.delete(ev.id);
    if (ev.type === 'crashed') {
      const tail = (ev.logTail ?? []).slice(-2).join(' · ');
      toast(`${ev.name} crashed`, `exit ${ev.code ?? ev.signal}${tail ? ' — ' + tail : ''} — the library kept running. That's the whole point.`, true, [
        ['Relaunch', () => romdeck.launch(ev.romPath, {})],
      ]);
      $('status').textContent = `${ev.name} crashed (isolated — library unaffected)`;
    } else if (ev.type === 'error') {
      toast('Could not start player', ev.message, true);
    } else {
      $('status').textContent = 'ready';
    }
  }
  render();
});

// ── boot ─────────────────────────────────────────────────────────────
async function loadLibrary(lib) {
  state.romsDir = lib.romsDir;
  state.roms = lib.roms;
  applyFilter();
  render();
  bigScreenRefresh(state.roms);
  $('status').textContent = `${lib.roms.length} games in library`;
}

async function reloadLibrary() {
  await loadLibrary(await romdeck.rescan());
}

$('choosedir').onclick = async () => loadLibrary(await romdeck.chooseRomsDir());
$('choosedir2').onclick = async () => loadLibrary(await romdeck.chooseRomsDir());
$('rescan').onclick = reloadLibrary;

$('search').oninput = () => {
  state.query = $('search').value.trim();
  state.selected = 0;
  applyFilter();
  render();
};
// don't let grid nav steal keys while typing
$('search').addEventListener('keydown', (ev) => ev.stopPropagation());

$('scrapeall').onclick = async () => {
  $('scrapeall').disabled = true;
  $('status').textContent = 'fetching box art…';
  const res = await romdeck.scrapeAll();
  toast('Box art', `${res.ok} of ${res.total} covers found`);
  $('scrapeall').disabled = false;
  await reloadLibrary();
};

romdeck.on('library:changed', (ev) => {
  if (ev.type === 'scrape-progress') {
    $('status').textContent = `art: ${ev.done}/${ev.total} (${ev.ok} found) — ${ev.current}`;
  } else if (ev.type === 'identify-progress') {
    if (ev.phase === 'dat') $('status').textContent = `downloading database: ${ev.current}`;
    else if (ev.phase === 'dat-failed') $('status').textContent = `no database for ${ev.current}`;
    else if (ev.phase === 'hash') $('status').textContent = `identifying: ${ev.done}/${ev.total} (${ev.matched} matched)`;
  }
});

$('identify').onclick = async () => {
  $('identify').disabled = true;
  $('status').textContent = 'identifying library…';
  const res = await romdeck.identify();
  toast('Identification', `${res.matched} of ${res.total} ROMs verified (${res.datsFetched} databases fetched)`);
  $('identify').disabled = false;
  await reloadLibrary();
};

$('bios').onclick = async () => {
  const rows = await romdeck.biosCheck();
  $('biosdirs').textContent = `${state.romsDir ?? '<roms>'}/bios`;
  const table = $('biostable');
  table.replaceChildren();
  for (const r of rows) {
    const tr = document.createElement('tr');
    const icon = r.status === 'ok' ? '✅' : r.status === 'bad-hash' ? '⚠️' : '—';
    const cls = r.status === 'ok' ? 'st-ok' : r.status === 'bad-hash' ? 'st-bad' : 'st-missing';
    tr.innerHTML = `<td class="${cls}"></td><td></td><td></td><td></td><td></td>`;
    const cells = tr.querySelectorAll('td');
    cells[0].textContent = icon;
    cells[1].textContent = r.file;
    cells[2].textContent = r.system;
    cells[3].textContent = r.desc;
    cells[4].textContent = r.status === 'bad-hash' ? 'hash mismatch' : r.required && r.status === 'missing' ? 'required' : '';
    if (r.required && r.status !== 'ok') cells[4].classList.add('req');
    table.appendChild(tr);
  }
  $('biosmodal').classList.remove('hidden');
};
$('biosclose').onclick = () => $('biosmodal').classList.add('hidden');
$('biosmodal').onclick = (ev) => { if (ev.target.id === 'biosmodal') $('biosmodal').classList.add('hidden'); };

// ── controllers: live view + press-to-bind remapping ─────────────────
const padUI = {
  open: false,
  info: null,       // { devices, buttons, portOrder, layers, deadzones }
  live: new Map(),  // deviceKey -> { buttons:[], axes:[] }
  listening: null,  // { deviceKey, buttonId }
  layer: 'global',
};

// W3C default source per libretro button — shown when nothing is rebound
const DEFAULT_W3C = { 0: 0, 1: 2, 2: 8, 3: 9, 4: 12, 5: 13, 6: 14, 7: 15, 8: 1, 9: 3, 10: 4, 11: 5, 12: 6, 13: 7, 14: 10, 15: 11 };
const W3C_NAMES = ['South', 'East', 'West', 'North', 'L1', 'R1', 'L2', 'R2', 'Select', 'Start', 'L3', 'R3', 'D-Up', 'D-Down', 'D-Left', 'D-Right', 'Guide'];

function sourceLabel(source, buttonId) {
  if (!source) return W3C_NAMES[DEFAULT_W3C[buttonId]] ?? '—';
  if (source.type === 'button') return W3C_NAMES[source.index] ?? `btn ${source.index}`;
  if (source.type === 'axis') return `axis ${source.index}${source.dir < 0 ? '−' : '+'}`;
  return '—';
}

async function openPads() {
  padUI.open = true;
  padUI.info = await romdeck.padsList();
  await romdeck.padsRawMode(true);
  $('padmodal').classList.remove('hidden');
  renderPads();
}

async function closePads() {
  padUI.open = false;
  padUI.listening = null;
  await romdeck.padsRawMode(false);
  $('padmodal').classList.add('hidden');
}

function bindingFor(deviceKey, buttonId) {
  const layers = padUI.info?.layers ?? {};
  // most specific wins; UI edits the global layer for now
  return layers[padUI.layer]?.[deviceKey]?.bindings?.[buttonId]
    ?? layers.global?.[deviceKey]?.bindings?.[buttonId]
    ?? null;
}

function renderPads() {
  const list = $('padlist');
  const info = padUI.info;
  list.replaceChildren();
  const devices = info?.devices ?? [];
  $('padnone').classList.toggle('hidden', devices.length > 0);

  devices.forEach((dev) => {
    const card = document.createElement('div');
    card.className = 'pad-card';

    const head = document.createElement('div');
    head.className = 'pad-head';
    const name = document.createElement('div');
    name.className = 'pad-name';
    name.textContent = dev.id;
    const key = document.createElement('div');
    key.className = 'pad-key';
    key.textContent = dev.key.slice(0, 20);
    head.append(name, key);

    // player port
    const portSel = document.createElement('select');
    for (let p = 0; p < Math.max(4, devices.length); p++) {
      const o = document.createElement('option');
      o.value = String(p);
      o.textContent = `Player ${p + 1}`;
      portSel.appendChild(o);
    }
    const curPort = info.portOrder.indexOf(dev.key);
    portSel.value = String(curPort >= 0 ? curPort : dev.port);
    portSel.onchange = async () => {
      const r = await romdeck.padsAssignPort(dev.key, Number(portSel.value));
      padUI.info.portOrder = r.portOrder;
      toast('Controllers', `${dev.id} → Player ${Number(portSel.value) + 1}`);
      renderPads();
    };
    head.appendChild(portSel);
    card.appendChild(head);

    // live button state
    const live = document.createElement('div');
    live.className = 'pad-live';
    const snapshot = padUI.live.get(dev.key);
    for (let i = 0; i < dev.buttons; i++) {
      const b = document.createElement('div');
      b.className = 'b' + (snapshot?.buttons?.[i] ? ' on' : '');
      b.textContent = String(i);
      live.appendChild(b);
    }
    card.appendChild(live);

    // bindings
    const grid = document.createElement('div');
    grid.className = 'bindgrid';
    for (const btn of info.buttons) {
      const source = bindingFor(dev.key, btn.id);
      const row = document.createElement('div');
      const listening = padUI.listening?.deviceKey === dev.key && padUI.listening?.buttonId === btn.id;
      row.className = 'bindrow' + (listening ? ' listening' : '') + (source ? ' custom' : '');
      // highlight when this binding is currently pressed
      const src = source ?? { type: 'button', index: DEFAULT_W3C[btn.id] };
      if (src.type === 'button' && snapshot?.buttons?.[src.index]) row.classList.add('active');
      const label = document.createElement('span');
      label.textContent = btn.name;
      const val = document.createElement('span');
      val.className = 'src';
      val.textContent = listening ? 'press…' : sourceLabel(source, btn.id);
      row.append(label, val);
      row.onclick = () => {
        padUI.listening = listening ? null : { deviceKey: dev.key, buttonId: btn.id };
        renderPads();
      };
      grid.appendChild(row);
    }
    card.appendChild(grid);

    // deadzone + profile actions
    const actions = document.createElement('div');
    actions.className = 'pad-actions';
    const dzLabel = document.createElement('span');
    dzLabel.className = 'src';
    const dz = info.deadzones?.[dev.key] ?? 0.35;
    dzLabel.textContent = `deadzone ${dz.toFixed(2)}`;
    const dzInput = document.createElement('input');
    dzInput.type = 'range';
    dzInput.min = '0.05';
    dzInput.max = '0.8';
    dzInput.step = '0.05';
    dzInput.value = String(dz);
    dzInput.oninput = () => { dzLabel.textContent = `deadzone ${Number(dzInput.value).toFixed(2)}`; };
    dzInput.onchange = async () => {
      await romdeck.padsDeadzone(dev.key, Number(dzInput.value));
      padUI.info.deadzones[dev.key] = Number(dzInput.value);
    };
    const resetB = document.createElement('button');
    resetB.textContent = 'Reset to defaults';
    resetB.onclick = async () => {
      await romdeck.padsClear(dev.key, padUI.layer);
      padUI.info = await romdeck.padsList();
      renderPads();
    };
    const expB = document.createElement('button');
    expB.textContent = 'Export profile';
    expB.onclick = async () => {
      const r = await romdeck.padsExport(dev.key);
      if (r.file) toast('Profile exported', r.file);
    };
    const impB = document.createElement('button');
    impB.textContent = 'Import profile';
    impB.onclick = async () => {
      const r = await romdeck.padsImport(dev.key);
      if (r.error) toast('Import failed', r.error, true);
      else if (!r.canceled) {
        padUI.info = await romdeck.padsList();
        renderPads();
        toast('Profile imported', dev.id);
      }
    };
    actions.append(dzLabel, dzInput, resetB, expB, impB);
    card.appendChild(actions);

    list.appendChild(card);
  });
}

// Raw pad stream: drives the live view AND completes press-to-bind
romdeck.on('pad:raw', (snapshot) => {
  if (!padUI.open) return;
  for (const pad of snapshot.pads) padUI.live.set(pad.key, pad);

  if (padUI.listening) {
    const pad = snapshot.pads.find((p) => p.key === padUI.listening.deviceKey);
    if (pad) {
      const btnIdx = pad.buttons.findIndex(Boolean);
      let source = null;
      if (btnIdx >= 0) source = { type: 'button', index: btnIdx };
      else {
        const axIdx = pad.axes.findIndex((v) => Math.abs(v) > 0.7);
        if (axIdx >= 0) source = { type: 'axis', index: axIdx, dir: pad.axes[axIdx] < 0 ? -1 : 1 };
      }
      if (source) {
        const { deviceKey, buttonId } = padUI.listening;
        padUI.listening = null;
        romdeck.padsBind(deviceKey, buttonId, source, padUI.layer).then(async () => {
          padUI.info = await romdeck.padsList();
          renderPads();
        });
        return;
      }
    }
  }
  renderPads();
});

romdeck.on('pad:devices', async (info) => {
  for (const key of info.added) {
    const dev = info.devices.find((d) => d.key === key);
    toast('Controller connected', dev?.id ?? key);
  }
  if (info.removed.length) {
    toast('Controller disconnected', 'Live games paused', true);
  }
  if (padUI.open) {
    padUI.info = await romdeck.padsList();
    renderPads();
  }
});

$('pads').onclick = openPads;
$('padclose').onclick = closePads;
$('padmodal').onclick = (ev) => { if (ev.target.id === 'padmodal') closePads(); };

(async () => {
  await loadLibrary(await romdeck.getLibrary());
  romdeck.uiReady();
})();
