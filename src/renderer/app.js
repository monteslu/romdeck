// romdeck renderer — library grid, system rail, sessions, toasts, pad/keyboard nav.
/* global romdeck */
'use strict';

const $ = (id) => document.getElementById(id);

const state = {
  romsDir: null,
  roms: [],
  system: 'All',
  filtered: [],
  selected: 0,
  playing: new Map(), // sessionId -> romPath
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
  for (const r of state.roms) counts.set(r.system, (counts.get(r.system) ?? 0) + 1);
  return [['All', state.roms.length], ...[...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]))];
}

function applyFilter() {
  state.filtered = state.system === 'All'
    ? state.roms
    : state.roms.filter((r) => r.system === state.system);
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

  const playingPaths = new Set(state.playing.values());
  state.filtered.forEach((rom, i) => {
    const tile = document.createElement('div');
    tile.className = 'tile' + (i === state.selected ? ' selected' : '');
    const initials = rom.name.split(/\s+/).slice(0, 2).map((w) => w[0] ?? '').join('').toUpperCase();
    tile.innerHTML = `
      <div class="art" style="${artStyle(rom)}"></div>
      <div class="meta"><div class="name"></div><div class="sys"></div></div>`;
    tile.querySelector('.art').textContent = initials;
    tile.querySelector('.name').textContent = rom.name;
    tile.querySelector('.name').title = rom.file;
    tile.querySelector('.sys').textContent = rom.system;
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
        for (const [id, p] of state.playing) if (p === rom.path) romdeck.stopSession(id);
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
}

function selectedRom() {
  return state.filtered[state.selected] ?? null;
}

async function launch(rom) {
  if (!rom) return;
  $('status').textContent = `launching ${rom.name}…`;
  const res = await romdeck.launch(rom.path, {});
  if (res?.error) toast('Launch failed', res.error, true);
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
  const map = {
    ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
    Enter: 'confirm', '[': 'prevSystem', ']': 'nextSystem',
  };
  if (map[ev.key]) { ev.preventDefault(); nav(map[ev.key]); }
});

romdeck.on('pad:nav', (ev) => nav(ev.action));

// ── sessions ─────────────────────────────────────────────────────────
romdeck.on('session:update', (ev) => {
  if (ev.type === 'started') {
    state.playing.set(ev.id, ev.romPath);
    $('status').textContent = `${ev.name} running (session ${ev.id})`;
    toast('Now playing', ev.name);
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
  $('status').textContent = `${lib.roms.length} games in library`;
}

$('choosedir').onclick = async () => loadLibrary(await romdeck.chooseRomsDir());
$('choosedir2').onclick = async () => loadLibrary(await romdeck.chooseRomsDir());
$('rescan').onclick = async () => loadLibrary(await romdeck.rescan());

(async () => {
  await loadLibrary(await romdeck.getLibrary());
  romdeck.uiReady();
})();
