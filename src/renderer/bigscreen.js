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
  onOptions: null, // per-game menu (M7 Phase 2)
  onMenu: null,    // main menu
  query: '',       // themed-view search filter
  allRoms: [],     // unfiltered, so search can be cleared
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
  // <maxSize> is a BOX the content fits inside while keeping its aspect
  // ratio — the difference between a cover displayed correctly and one
  // stretched to a fixed rectangle. Real themes use it for exactly that
  // (marquees, box art), so it can't just be parsed and ignored.
  const [mw, mh] = props.maxSize ?? [0, 0];
  if (mw || mh) {
    if (mw) node.style.maxWidth = `${mw * 100}%`;
    if (mh) node.style.maxHeight = `${mh * 100}%`;
    // Without an explicit size, the box IS the size and the image scales
    // down to fit inside it.
    if (!w && mw) node.style.width = `${mw * 100}%`;
    if (!h && mh) node.style.height = `${mh * 100}%`;
    node.dataset.fit = 'contain';
  }
  const [minW, minH] = props.minSize ?? [0, 0];
  if (minW) node.style.minWidth = `${minW * 100}%`;
  if (minH) node.style.minHeight = `${minH * 100}%`;
  const tx = -ox * 100;
  const ty = -oy * 100;
  const rot = props.rotation ? ` rotate(${props.rotation}deg)` : '';
  node.style.transform = `translate(${tx}%, ${ty}%)${rot}`;
  if (props.opacity !== undefined) node.style.opacity = String(props.opacity);
  if (props.zIndex !== undefined) node.style.zIndex = String(props.zIndex);
  if (props.fontSize) node.style.fontSize = `${props.fontSize * STAGE_H}px`;
  if (props.horizontalAlignment) node.style.textAlign = props.horizontalAlignment;
  const family = fontFamilyFor(props);
  if (family) node.style.fontFamily = family;
  if (props.lineSpacing) node.style.lineHeight = String(props.lineSpacing);
  if (props.letterCase === 'capitalize') node.style.textTransform = 'capitalize';
  else if (props.letterCase === 'uppercase') node.style.textTransform = 'uppercase';
  else if (props.letterCase === 'lowercase') node.style.textTransform = 'lowercase';
  if (props.visible === 'false') node.style.display = 'none';
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
    // romdeck's own binding names…
    case 'system.fullName': return sys?.name ?? '';
    case 'system.gameCount': return sys ? `${sys.roms.length} games` : '';
    case 'game.name': return game?.name ?? '';
    case 'game.cover': return game?.art ?? '';
    case 'game.video': return game?.video ?? '';
    // …and the ones REAL ES-DE themes actually use.
    // system.fullName has collection-scoped siblings: a theme declares all
    // three at the same position and ES-DE shows whichever applies. romdeck
    // has no collections, so only the plain one resolves and the others
    // deliberately come back empty rather than stacking on top of it.
    case 'system.fullName.noCollections': return sys?.name ?? '';
    case 'system.fullName.autoCollections': return '';
    case 'system.fullName.customCollections': return '';
    case 'gamecount': return sys ? `${sys.roms.length} games` : '';
    case 'name': return game?.name ?? '';
    case 'description': return game?.meta?.desc ?? '';
    case 'genre': return game?.meta?.genre ?? '';
    case 'developer': return game?.meta?.developer ?? '';
    case 'publisher': return game?.meta?.publisher ?? '';
    case 'players': return game?.meta?.players ?? '';
    case 'releasedate': return game?.meta?.releasedate ?? '';
    case 'rating': return game?.meta?.rating ? String(game.meta.rating) : '';
    case 'playcount': return String(game?.meta?.playcount ?? 0);
    case 'playtime': return '';
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

/**
 * Resolve a <text> body's ${…} bindings.
 *
 * These are NOT theme variables — those were substituted in the main process.
 * What survives is runtime data (`${system.fullName}`), which only the
 * renderer knows. An unresolved binding becomes empty rather than being shown
 * as literal `${…}` on screen, which is what real themes expect: they declare
 * several collection-scoped variants at one position and rely on the
 * inapplicable ones staying blank.
 */
function bindText(text) {
  if (typeof text !== 'string') return '';
  if (!text.includes('${')) return text;
  return text.replace(/\$\{([\w.]+)\}/g, (_m, key) => metaValue(key) ?? '');
}

// ── element builders ─────────────────────────────────────────────────
function buildImage(el) {
  const node = document.createElement('div');
  node.className = 'te-image';
  place(node, el.props);
  const p = el.props;

  // Real themes use a 1x1 white box.png tinted with <color> as a solid fill —
  // backgrounds, separator lines, panels. Rendering it as an untinted <img>
  // painted the whole stage white and buried everything behind it.
  const isFill = typeof p.path === 'string' && p.color
    && (p.tile === 'true' || /box\.(png|svg)$/i.test(p.path));
  if (isFill) {
    node.style.background = hex(p.color);
    return node;
  }
  if (p.color && !p.path && !p.metadata && !p.imageType) {
    node.style.background = hex(p.color);
  }
  if (p.path) {
    const img = document.createElement('img');
    // ${system.theme} appears on ordinary images too (a per-system logo beside
    // the carousel), not only on carousel art — it is resolved wherever it
    // appears, since only the renderer knows which system is selected.
    img.src = perSystemPath(p.path) ?? p.path;
    // A theme referencing art for a system/game we don't have shouldn't leave
    // a broken-image glyph on the stage. <default> is the theme's own fallback.
    img.onerror = () => {
      const fallback = perSystemPath(p.default) ?? p.default;
      if (fallback && img.src !== fallback) img.src = fallback;
      else img.remove();
    };
    node.appendChild(img);
  }
  return node;
}

/** Fill ${system.theme} — the ES-DE shortname — for the current system. */
function perSystemPath(template) {
  if (typeof template !== 'string' || !template.includes('${system.theme}')) return null;
  const sys = currentSystem();
  const short = sys?.short ?? null;
  return short ? template.replace(/\$\{system\.theme\}/g, short) : null;
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

function buildGrid(el) {
  const node = document.createElement('div');
  node.className = 'te-grid';
  place(node, el.props);
  return node;
}

function buildVideo(el) {
  const node = document.createElement('div');
  node.className = 'te-video';
  place(node, el.props);
  // Video snaps play through a real <video>: hardware-decoded, and simpler
  // than ES-DE's own FFmpeg path. Muted and looping because a gamelist
  // preview that demands attention is worse than one that doesn't.
  const v = document.createElement('video');
  v.muted = true;
  v.loop = true;
  v.autoplay = true;
  v.playsInline = true;
  node.appendChild(v);
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
  // Real-theme element types. Rendering them as positioned text keeps a
  // theme's layout intact instead of leaving holes where these sit; the ones
  // romdeck has no data for simply come out empty rather than misplacing
  // everything around them.
  grid: buildGrid,
  gamelistinfo: buildText,
  clock: buildClock,
  systemstatus: buildText,
  helpsystem: buildText,
  badges: buildBadges,
};

function buildClock(el) {
  const node = buildText(el);
  const tick = () => {
    if (!node.isConnected) return;
    node.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    setTimeout(tick, 20000);
  };
  tick();
  return node;
}

function buildBadges(el) {
  const node = document.createElement('div');
  node.className = 'te-badges';
  place(node, el.props);
  if (el.props.direction === 'column') node.classList.add('col');
  return node;
}

// Badges romdeck can actually populate, in ES-DE's own slot vocabulary. The
// rest of ES-DE's set (completed, kidgame, broken, altemulator, manual)
// depends on metadata romdeck doesn't track, and inventing a value for them
// would be worse than leaving the slot empty.
const BADGE_SLOTS = {
  favorite: (g) => !!g?.meta?.favorite,
  collection: () => false,
  folder: () => false,
  controller: () => false,
};

function paintBadges(node, el) {
  node.replaceChildren();
  const game = currentGame();
  // A theme lists which slots it wants, in order.
  const slots = String(el.props.slots ?? 'favorite')
    .split(',').map((s) => s.trim()).filter(Boolean);
  for (const slot of slots) {
    const test = BADGE_SLOTS[slot];
    if (!test || !test(game)) continue;
    const b = document.createElement('div');
    b.className = `te-badge ${slot}`;
    // A theme can supply its own icon; otherwise a glyph stands in rather
    // than the slot silently vanishing.
    const custom = el.props[`customBadgeIcon:${slot}`];
    if (custom) {
      const img = document.createElement('img');
      img.src = custom;
      img.onerror = () => { img.remove(); b.textContent = '★'; };
      b.appendChild(img);
    } else {
      b.textContent = slot === 'favorite' ? '★' : '●';
    }
    node.appendChild(b);
  }
}

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
    if (el.type === 'clock') {
      // self-updating; leave it alone
    } else if (el.type === 'text' || el.type === 'rating' || el.type === 'datetime'
      || el.type === 'gamelistinfo' || el.type === 'systemstatus' || el.type === 'helpsystem') {
      // Real themes bind through <metadata> OR <systemdata>; a literal <text>
      // is the fallback, and <defaultValue> covers "nothing for this game".
      const key = p.metadata ?? p.systemdata;
      node.textContent = key
        ? (metaValue(key) || p.defaultValue || '')
        : bindText(p.text);
    } else if (el.type === 'image' && typeof p.path === 'string' && p.path.includes('${system.theme}')) {
      // A per-system image has to follow the carousel, so its src is refreshed
      // on every paint rather than fixed when the view was built.
      const img = node.querySelector('img');
      const src = perSystemPath(p.path);
      if (img && src && img.getAttribute('src') !== src) img.src = src;
    } else if (el.type === 'image' && (p.metadata || p.imageType)) {
      node.replaceChildren();
      // <imageType>marquee|image|cover</imageType> is how real themes ask for
      // per-game art; romdeck has one cover per game, so they all resolve to it.
      const src = p.metadata ? metaValue(p.metadata) : (currentGame()?.art ?? '');
      if (src) {
        const img = document.createElement('img');
        img.src = src;
        node.appendChild(img);
        // Clear any placeholder left from a game that had no art — without
        // this the empty-slot box stays painted behind real cover art.
        node.style.background = '';
        node.style.borderRadius = '';
      } else {
        node.style.background = 'rgba(255,255,255,0.05)';
        node.style.borderRadius = '10px';
      }
    } else if (el.type === 'carousel') {
      paintCarousel(node, el);
    } else if (el.type === 'textlist') {
      paintTextlist(node, el);
    } else if (el.type === 'grid') {
      paintGrid(node, el);
    } else if (el.type === 'badges') {
      paintBadges(node, el);
    } else if (el.type === 'video') {
      const v = node.querySelector('video');
      const src = currentGame()?.video ?? '';
      if (v && v.getAttribute('src') !== src) {
        if (src) { v.src = src; v.play?.().catch(() => { /* autoplay policy */ }); }
        else { v.removeAttribute('src'); v.load?.(); }
      }
      // A game with no snap shouldn't leave the previous game's footage up.
      node.classList.toggle('empty', !src);
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
    // A theme can mark the selection with a border instead of a fill, which
    // is what an art-forward layout wants: a flat slab of accent colour reads
    // badly when the card has no logo to sit on.
    if (off === 0 && el.props.selectorColor) {
      item.style.outline = `3px solid ${hex(el.props.selectorColor)}`;
      item.style.outlineOffset = '-1px';
    }
    if (off === 0 && el.props.itemScale) item.style.transform = `scale(${el.props.itemScale})`;

    // Real ES-DE themes are IMAGE-driven: the carousel shows a per-system
    // logo, resolved through ${system.theme} (the ES-DE shortname). Drawing
    // text boxes instead was the second half of §16f — a fixed parser alone
    // would still have looked wrong.
    const logo = systemLogoUrl(el, sys);
    if (logo) {
      const img = document.createElement('img');
      img.src = logo;
      img.alt = sys.name;
      // Themes ship logos for systems a given library may not have. Try the
      // theme's own <defaultImage> first, then the plain name — an empty card
      // is the one outcome worth avoiding.
      const fallback = el.props.defaultImage ?? el.props.default ?? null;
      img.onerror = () => {
        if (fallback && img.getAttribute('src') !== fallback) { img.src = fallback; return; }
        img.remove();
        item.textContent = sys.name;
      };
      // <imageColor> tints a monochrome logo to the palette. An <img> can't
      // inherit currentColor, so the SVG becomes a mask over a solid fill —
      // one asset then serves every colour scheme.
      const tint = off === 0
        ? (el.props.imageSelectedColor ?? el.props.imageColor)
        : el.props.imageColor;
      if (tint) applyTint(img, logo, hex(tint));
      item.appendChild(img);
    } else {
      item.textContent = sys.name;
    }
    node.appendChild(item);
  }
}

/**
 * Tint a monochrome logo to a theme colour.
 *
 * ES-DE's <imageColor> recolours artwork. An <img> can't inherit
 * currentColor, so the image is used as a CSS mask over a solid fill: the
 * shape comes from the SVG, the colour from the theme. One asset then serves
 * every colour scheme instead of shipping a copy per palette.
 *
 * Only applied where the theme asks for it — masking a full-colour cover
 * would flatten it to a silhouette.
 */
function applyTint(img, url, color) {
  img.style.backgroundColor = color;
  img.style.webkitMaskImage = `url("${url}")`;
  img.style.maskImage = `url("${url}")`;
  img.style.webkitMaskRepeat = 'no-repeat';
  img.style.maskRepeat = 'no-repeat';
  img.style.webkitMaskPosition = 'center';
  img.style.maskPosition = 'center';
  img.style.webkitMaskSize = 'contain';
  img.style.maskSize = 'contain';
  // The pixels are now supplied by the mask, so hide the image's own.
  img.style.opacity = '1';
  img.dataset.tinted = '1';
}

/**
 * Resolve a carousel item's image for one system.
 *
 * ES-DE themes write `./${artDirectory}/${system.theme}.webp`. Everything but
 * `${system.theme}` is already substituted by the time the model arrives, so
 * the per-system part is filled in here, where the system is known.
 */
function systemLogoUrl(el, sys) {
  const template = el.props.staticImage ?? el.props.imagePath ?? el.props.path;
  if (typeof template !== 'string' || !template) return null;
  if (!template.includes('${system.theme}')) {
    return template.includes('${') ? null : template;
  }
  const short = sys.short ?? shortnameOf(sys.name);
  return short ? template.replace(/\$\{system\.theme\}/g, short) : null;
}

/**
 * ES-DE shortname for a system display name. The rom records carry `short`
 * already (main.js sets it from systems.js), so this is only a fallback for
 * groups built before that lands.
 */
function shortnameOf(displayName) {
  const rom = bs.allRoms.find((r) => r.system === displayName && r.short);
  return rom?.short ?? null;
}

/**
 * Grid view — the gamelist as cover art rather than a list.
 *
 * Themes give a normalized <itemSize> and expect the columns to fall out of
 * it, which is how they control "5 across" vs "10 across" per aspect ratio
 * without naming a column count anywhere. The grid shares gameIndex with the
 * textlist, so switching variants doesn't lose the player's place.
 */
function paintGrid(node, el) {
  node.replaceChildren();
  const sys = currentSystem();
  if (!sys) return;

  // itemSize is normalized to the STAGE, not to the grid, so columns are
  // stage-width over item-width. A theme that leaves it to an include we
  // didn't select still needs sane geometry, hence the fallback.
  const [iw, ih] = el.props.itemSize?.[0] ? el.props.itemSize : [0.2, 0.42];
  const [gw, gh] = el.props.size ?? [1, 1];
  const cols = Math.max(1, Math.round(gw / iw));
  node.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
  // Rows are sized from the theme's item height so cells keep their aspect
  // ratio instead of stretching to fill whatever space is left.
  node.style.gridAutoRows = `${(ih / gh) * 100}%`;

  // Keep the selection on screen without paging the whole list around it.
  const rows = Math.max(1, Math.floor(gh / ih));
  const perPage = cols * rows;
  const page = Math.floor(bs.gameIndex / perPage);
  const start = page * perPage;

  for (let i = start; i < Math.min(sys.roms.length, start + perPage); i++) {
    const game = sys.roms[i];
    const cell = document.createElement('div');
    cell.className = 'te-cell' + (i === bs.gameIndex ? ' sel' : '');
    if (i === bs.gameIndex && el.props.selectorColor) {
      cell.style.outline = `3px solid ${hex(el.props.selectorColor)}`;
    }
    if (game.art) {
      const img = document.createElement('img');
      img.src = game.art;
      img.onerror = () => { img.remove(); cell.textContent = game.name; };
      cell.appendChild(img);
    } else {
      // No cover: the name still has to be readable, or the grid is a wall
      // of empty boxes for an unscraped library.
      cell.textContent = game.name;
      cell.classList.add('noart');
    }
    node.appendChild(cell);
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

/**
 * Register the theme's own fonts (§16f blocker 3).
 *
 * Themes ship .ttf/.otf files and name them per element via <fontPath>. Each
 * distinct file becomes an @font-face whose family is derived from the URL,
 * so elements can reference it by the same path they declared.
 */
function installThemeFonts(theme) {
  const style = document.getElementById('bs-fonts') ?? (() => {
    const s = document.createElement('style');
    s.id = 'bs-fonts';
    document.head.appendChild(s);
    return s;
  })();

  const paths = new Set();
  for (const list of Object.values(theme?.views ?? {})) {
    for (const el of list) {
      const p = el.props?.fontPath;
      if (typeof p === 'string' && p.startsWith('romdeck-theme://')) paths.add(p);
    }
  }

  const rules = [];
  bs.fontFamilies = new Map();
  let i = 0;
  for (const p of paths) {
    const family = `themefont${i++}`;
    bs.fontFamilies.set(p, family);
    rules.push(`@font-face{font-family:"${family}";src:url("${p}");font-display:swap;}`);
  }
  style.textContent = rules.join('\n');
}

/** The CSS family for an element's declared fontPath, if the theme shipped one. */
function fontFamilyFor(props) {
  const p = props?.fontPath;
  return p && bs.fontFamilies?.get(p) ? `"${bs.fontFamilies.get(p)}"` : null;
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
  // gamelist. A grid moves by COLUMNS vertically and one at a time
  // horizontally; a list does the opposite. Reading the step from whichever
  // element the theme actually declared keeps navigation matching what's on
  // screen instead of assuming a list.
  const max = (sys?.roms.length ?? 1) - 1;
  const grid = [...bs.els.values()].find((e) => e.el.type === 'grid')?.el ?? null;
  const step = grid
    ? Math.max(1, Math.round((grid.props.size?.[0] ?? 1) / (grid.props.itemSize?.[0] ?? 0.2)))
    : 1;
  const jump = grid ? 1 : 10;

  if (action === 'up') { bs.gameIndex = Math.max(0, bs.gameIndex - step); paint(); }
  else if (action === 'down') { bs.gameIndex = Math.min(max, bs.gameIndex + step); paint(); }
  else if (action === 'left' || action === 'prevSystem') { bs.gameIndex = Math.max(0, bs.gameIndex - jump); paint(); }
  else if (action === 'right' || action === 'nextSystem') { bs.gameIndex = Math.min(max, bs.gameIndex + jump); paint(); }
  else if (action === 'confirm') { const g = currentGame(); if (g) bs.onLaunch?.(g); }
  else if (action === 'back') { bs.view = 'system'; buildView('system'); }
  return true;
}

/**
 * Filter the themed view's gamelist. Search from a couch needs the on-screen
 * keyboard, so the query arrives already typed rather than being read from a
 * DOM input the pad can't reach.
 */
export function bigScreenSearch(query) {
  bs.query = String(query ?? '').trim().toLowerCase();
  regroup(bs.allRoms);
  bs.gameIndex = 0;
  buildView(bs.view);
}

export function bigScreenQuery() {
  return bs.query;
}

/** Group roms into systems, honouring the active search filter. */
function regroup(roms) {
  bs.allRoms = roms;
  const list = bs.query
    ? roms.filter((r) => r.name.toLowerCase().includes(bs.query)
      || r.system.toLowerCase().includes(bs.query))
    : roms;
  const grouped = new Map();
  for (const rom of list) {
    if (!grouped.has(rom.system)) grouped.set(rom.system, []);
    grouped.get(rom.system).push(rom);
  }
  bs.systems = [...grouped.entries()]
    // `short` is the ES-DE shortname, which is how themes name their logo
    // files — carry it through so the carousel can resolve ${system.theme}.
    .map(([name, l]) => ({ name, roms: l, short: l[0]?.short ?? null }))
    .sort((a, b) => a.name.localeCompare(b.name));
  if (bs.sysIndex >= bs.systems.length) bs.sysIndex = Math.max(0, bs.systems.length - 1);
}

// ── public API ───────────────────────────────────────────────────────
export async function enterBigScreen({
  roms, themeName, variant, colorScheme, onLaunch, onExit, onOptions, onMenu,
}) {
  bs.query = '';
  regroup(roms);
  if (!bs.systems.length) return { error: 'no games in library' };

  const res = await romdeck.themeLoad(themeName, { variant, colorScheme });
  if (res.error) return res;
  bs.theme = res.theme;
  installThemeFonts(res.theme);
  bs.active = true;
  bs.view = 'system';
  bs.sysIndex = 0;
  bs.gameIndex = 0;
  bs.onLaunch = onLaunch;
  bs.onExit = onExit;
  bs.onOptions = onOptions;
  bs.onMenu = onMenu;

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

/** The game the themed view has selected — what the per-game menu acts on. */
export function bigScreenSelectedGame() {
  return currentGame();
}

export function bigScreenRefresh(roms) {
  if (!bs.active) return;
  const name = currentSystem()?.name;
  regroup(roms);
  const idx = bs.systems.findIndex((s) => s.name === name);
  if (idx >= 0) bs.sysIndex = idx;
  paint();
}
