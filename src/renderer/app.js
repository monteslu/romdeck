// romdeck renderer — library grid, system rail, sessions, toasts, pad/keyboard nav.
/* global romdeck */
'use strict';

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
  }
});

(async () => {
  await loadLibrary(await romdeck.getLibrary());
  romdeck.uiReady();
})();
