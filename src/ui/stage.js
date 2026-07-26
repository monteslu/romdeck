// The stage: an ES-DE theme rendered onto a canvas.
//
// This is bigscreen.js's job, done with skia instead of DOM. The layout model
// is identical because it was never a CSS model: normalized 0-1 coordinates
// on a fixed 1920x1080 design space, fitted to the window at present time.
// That is a projection, and a projection does not need a browser.
//
// Element semantics follow ES-DE's own source (internal-romdeck/reference/
// es-de/es-core/src/ThemeData.cpp), not inference from reading themes — the
// latter is how five theme bugs got in.
import { createCanvas, loadImage, GlobalFonts } from '@napi-rs/canvas';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { STAGE_W, STAGE_H } from './present.js';
import { appDir } from './paths.js';

// ── fonts ────────────────────────────────────────────────────────────
// Bundled, not borrowed. Canvas does no automatic fallback, so a glyph the
// named family lacks is dropped SILENTLY — that is how the help line lost its
// pad symbols the first time this ran. Shipping the faces makes the UI
// identical on every machine instead of dependent on what the host installed.
// Two faces for text (DejaVu) and two for symbols (GNU FreeSans).
//
// The symbol face is FreeSans specifically, and finding that took measuring
// rather than trusting: DejaVu and Noto Sans Symbols2 both carry cmap entries
// for the pad glyphs (Ⓐ Ⓑ Ⓧ, U+24B6+) and both render them as TOFU. A probe
// that counts lit pixels calls that success, because a tofu box is lit; the
// only honest test is comparing the bitmap against a codepoint the font
// certainly lacks. FreeSans draws them for real.
//
// Both weights are registered because canvas does not substitute across
// weights the way a browser does — a `700 ...` string never falls through to
// a 400-only family.
const BUNDLED_FONTS = [
  ['romdeck-ui', 'romdeck-ui.ttf'],
  ['romdeck-ui-bold', 'romdeck-ui-bold.ttf'],
  ['romdeck-symbols', 'romdeck-symbols.ttf'],
  ['romdeck-symbols-bold', 'romdeck-symbols-bold.ttf'],
];
let fontsReady = false;

export function initFonts() {
  if (fontsReady) return;
  const dir = path.join(appDir(), 'themes', 'romdeck-default', 'fonts');
  for (const [family, file] of BUNDLED_FONTS) {
    const p = path.join(dir, file);
    if (existsSync(p)) GlobalFonts.registerFromPath(p, family);
  }
  fontsReady = true;
}

// Families are quoted (hyphens are otherwise ambiguous in a font shorthand)
// and the symbol faces trail the stack, so glyphs the text face lacks still
// resolve at whichever weight was asked for.
export const UI_FAMILIES =
  '"romdeck-ui-bold", "romdeck-symbols-bold", "romdeck-ui", "romdeck-symbols"';
export const UI_FONT = UI_FAMILIES;

/** A canvas font string with the fallback stack already applied. */
export function fontStack(px, { family = null, weight = 700 } = {}) {
  const fams = family ? `"${family}", ${UI_FAMILIES}` : UI_FAMILIES;
  return `${weight} ${px}px ${fams}`;
}

// ── colour ───────────────────────────────────────────────────────────
export function hex(c, fallback = '#ffffff') {
  if (!c) return fallback;
  const s = String(c).replace('#', '');
  if (s.length === 6) return `#${s}`;
  if (s.length === 8) {
    const a = (parseInt(s.slice(6, 8), 16) / 255).toFixed(3);
    return `rgba(${parseInt(s.slice(0, 2), 16)},${parseInt(s.slice(2, 4), 16)},${parseInt(s.slice(4, 6), 16)},${a})`;
  }
  return fallback;
}

export function roundRect(ctx, x, y, w, h, r) {
  const rad = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.arcTo(x + w, y, x + w, y + h, rad);
  ctx.arcTo(x + w, y + h, x, y + h, rad);
  ctx.arcTo(x, y + h, x, y, rad);
  ctx.arcTo(x, y, x + w, y, rad);
  ctx.closePath();
}

// ES-DE's per-element default z-index, taken from its source rather than
// inferred: setDefaultZIndex() calls in es-app/src/views/GamelistView.cpp and
// SystemView.cpp (vendored under internal-romdeck/reference/es-de). A theme
// that declares <zIndex> on one element and not the rest is relying on exactly
// these numbers.
//
// clock, systemstatus and helpsystem are deliberately absent: ES-DE never
// calls setDefaultZIndex for them because they are drawn outside the themed
// element stack. They fall through to DEFAULT_Z_FALLBACK, which puts them on
// top -- which is where they belong and what they looked like anyway.
const DEFAULT_Z = {
  image: 30,
  video: 30,
  animation: 35,
  badges: 35,
  text: 40,
  datetime: 40,
  gamelistinfo: 45,
  rating: 45,
  textlist: 50,
  carousel: 50,
  grid: 50,
};
const DEFAULT_Z_FALLBACK = 55;

// ES-DE's auto-collections (CollectionSystemsManager.cpp:51). The theme
// FOLDER name is what themes key their artwork and logos off, so it has to
// match exactly -- a theme ships auto-favorites/ and expects that string.
//
// "recent" is capped at LAST_PLAYED_MAX (CollectionSystemsManager.h:25) and
// ordered most-recent-first; the others keep the library's own order.
const LAST_PLAYED_MAX = 50;
const AUTO_COLLECTIONS = [
  {
    name: 'all games',
    short: 'auto-allgames',
    match: () => true,
  },
  {
    name: 'last played',
    short: 'auto-lastplayed',
    match: (rom) => !!rom.meta?.lastplayed && String(rom.meta.lastplayed) !== '0',
    order: (roms) => roms
      .slice()
      .sort((a, b) => String(b.meta?.lastplayed ?? '').localeCompare(String(a.meta?.lastplayed ?? '')))
      .slice(0, LAST_PLAYED_MAX),
  },
  {
    name: 'favorites',
    short: 'auto-favorites',
    match: (rom) => rom.meta?.favorite === true || rom.meta?.favorite === 'true',
  },
];

// ES-DE's scrollable-container constants (ScrollableContainer.h:14). A long
// description sits still for the start delay, creeps up one pixel at a time,
// pauses at the bottom for the reset delay, then snaps back and repeats.
const AUTO_SCROLL_DELAY = 4500;      // ms before scrolling starts
const AUTO_SCROLL_RESET_DELAY = 7000; // ms held at the end
const AUTO_SCROLL_SPEED = 4;          // ms per pixel, before modifiers

/**
 * Advance one scrolling container and report whether it moved.
 *
 * State lives on the element rather than in a component tree, because the
 * stage rebuilds its element list on every theme change and a container that
 * forgot its position on each repaint would never scroll at all.
 */
function tickScroll(el, contentH, boxH, dt) {
  const p = el.props;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, Number(v)));
  const startDelay = p.containerStartDelay !== undefined
    ? clamp(p.containerStartDelay, 0, 10) * 1000 : AUTO_SCROLL_DELAY;
  // The accumulator starts NEGATIVE by the start delay
  // (ScrollableContainer.cpp:67), which is what makes the text sit still and
  // readable before it moves. Starting at zero scrolled immediately.
  const st = el._scroll ?? (el._scroll = { pos: 0, acc: -startDelay, atEnd: 0 });
  if (contentH <= boxH) { st.pos = 0; return false; }
  const resetDelay = p.containerResetDelay !== undefined
    ? clamp(p.containerResetDelay, 0, 20) * 1000 : AUTO_SCROLL_RESET_DELAY;
  const perPixel = AUTO_SCROLL_SPEED / (p.containerScrollSpeed !== undefined
    ? clamp(p.containerScrollSpeed, 0.1, 10) : 1);

  if (st.atEnd) {                      // holding at the bottom
    st.atEnd += dt;
    if (st.atEnd >= resetDelay) { st.pos = 0; st.acc = -startDelay; st.atEnd = 0; }
    return true;
  }
  st.acc += dt;
  const before = st.pos;
  // ES-DE scales the interval by rows-of-text; below 8 lines it accelerates.
  // ES-DE scales the interval by how many text rows fit: under 8 rows it
  // accelerates so a short blurb does not crawl (ScrollableContainer.cpp:195).
  const rows = boxH / Math.max(1, contentH / Math.max(1, Math.round(contentH / boxH)));
  const rowModifier = rows < 8 ? Math.max(0.2, rows / 8) : 1;
  const interval = Math.max(1, perPixel * rowModifier * 8);
  while (st.acc >= interval) {
    st.pos += 1;
    st.acc -= interval;
  }
  if (st.pos + boxH >= contentH) { st.pos = contentH - boxH; st.atEnd = 1; }
  return st.pos !== before || st.atEnd > 0;
}

// Carousel item transition (CarouselComponent.h:1961). The selection slides
// to its new place over 400ms with an ease-out quadratic, unless the theme
// asks for <itemTransitions>instant. Duration shortens toward 200ms when the
// user is scrolling fast, so holding a direction does not lag behind the input.
const CAROUSEL_ANIM_MS = 400;
const CAROUSEL_ANIM_MIN_MS = 200;

/** ES-DE's easing: t = 1 - (1-t)^2. */
function easeOutQuad(t) {
  const c = Math.max(0, Math.min(1, t));
  return 1 - (1 - c) * (1 - c);
}

// Selection fade-in (GamelistView.cpp:17). An element with <scrollFadeIn>
// starts at half opacity when the selection changes and fades to full over
// 325ms, so scrolling a list does not strobe fresh artwork at full brightness.
const FADE_IN_START_OPACITY = 0.5;
const FADE_IN_TIME = 325;

// Carousel scroll tiers (IList.h:60). <fastScrolling> swaps the default slow
// pair -- 500ms then 200ms per item -- for the medium three-tier ramp, so
// holding a direction accelerates instead of plodding.
const SCROLL_TIERS_SLOW = [[500, 500], [0, 200]];
const SCROLL_TIERS_MEDIUM = [[500, 500], [1100, 180], [0, 80]];

/** Milliseconds per item after `heldMs` of holding a direction. */
export function scrollInterval(heldMs, fast) {
  const tiers = fast ? SCROLL_TIERS_MEDIUM : SCROLL_TIERS_SLOW;
  let elapsed = 0;
  for (const [duration, interval] of tiers) {
    if (duration === 0 || heldMs < elapsed + duration) return interval;
    elapsed += duration;
  }
  return tiers[tiers.length - 1][1];
}

/**
 * A gradient fill for a <color> + <colorEnd> pair.
 *
 * ES-DE lets any coloured element be a two-stop gradient, with
 * <gradientType> choosing the axis. Returning a canvas gradient rather than a
 * flat colour keeps every caller a one-line change.
 */
function fillStyle(ctx, box, color, colorEnd, gradientType, fallback = '#ffffff') {
  if (!colorEnd || colorEnd === color) return hex(color, fallback);
  const horizontal = gradientType === 'horizontal';
  const g = ctx.createLinearGradient(
    box.x, box.y,
    horizontal ? box.x + box.w : box.x,
    horizontal ? box.y : box.y + box.h,
  );
  g.addColorStop(0, hex(color, fallback));
  g.addColorStop(1, hex(colorEnd, fallback));
  return g;
}

/**
 * Draw order for <itemStacking> (CarouselComponent.h:1076).
 *
 * Which item ends up on TOP when neighbours overlap. "centered" (the default)
 * draws outward from the selection so it sits above both sides; ascending and
 * descending run one way, with the *Raised variants lifting the selection back
 * to the front.
 */
function stackOrder(offsets, mode) {
  const byDistance = [...offsets].sort((a, b) => Math.abs(b) - Math.abs(a));
  switch (mode) {
    case 'ascending': return [...offsets].sort((a, b) => b - a);
    case 'descending': return [...offsets].sort((a, b) => a - b);
    case 'ascendingRaised':
      return [...[...offsets].sort((a, b) => b - a).filter((o) => o !== 0), 0];
    case 'descendingRaised':
      return [...[...offsets].sort((a, b) => a - b).filter((o) => o !== 0), 0];
    default: return byDistance;          // centered
  }
}

/**
 * The themed view.
 *
 * Owns the theme model, the current selection, and how to paint it. Knows
 * nothing about windows, input or presenters — those drive it from outside,
 * which is what makes the same object usable headless in a self-check.
 */
export class Stage {
  constructor(services) {
    this.svc = services;
    this.canvas = createCanvas(STAGE_W, STAGE_H);
    this.ctx = this.canvas.getContext('2d');
    this.theme = null;
    this.view = 'system';
    this.systems = [];
    this.allRoms = [];
    this.query = '';
    this.sysIndex = 0;
    // Animated carousel offset, in ITEMS. 0 means settled on sysIndex; a
    // non-zero value is the slide still in flight.
    this.carouselOffset = 0;
    this._carouselAnim = null;
    this.gameIndex = 0;
    // While editing a custom collection, every gamelist marks which games
    // are already in it (GamelistBase.cpp:900). Null when not editing.
    this.editingCollection = null;
    this._images = new Map();
    this._themeFonts = 0;
    initFonts();
  }

  // ── model ──────────────────────────────────────────────────────────
  async setTheme(name = null, opts = {}) {
    const res = this.svc.loadTheme(name, opts);
    if (res.error) return res;
    this.theme = res.theme;
    this._images.clear();
    this._registerThemeFonts();
    await this.preload();
    return res;
  }

  /** A theme's own <fontPath> faces layer on top of the bundled ones. */
  _registerThemeFonts() {
    const seen = new Set();
    let i = 0;
    for (const list of Object.values(this.theme?.views ?? {})) {
      for (const el of list) {
        const p = el.props?.fontPath;
        if (typeof p !== 'string' || seen.has(p)) continue;
        seen.add(p);
        const file = this.svc.resolveUrl(p);
        if (file) {
          GlobalFonts.registerFromPath(file, `themefont${i}`);
          el.props._family = `themefont${i}`;
          i++;
        }
      }
    }
    this._themeFonts = i;
  }

  setLibrary(roms) {
    this.allRoms = roms;
    this.regroup();
  }

  regroup() {
    const list = this.query
      ? this.allRoms.filter((r) => r.name.toLowerCase().includes(this.query)
        || r.system.toLowerCase().includes(this.query))
      : this.allRoms;
    const grouped = new Map();
    for (const rom of list) {
      if (!grouped.has(rom.system)) grouped.set(rom.system, []);
      grouped.get(rom.system).push(rom);
    }
    this.systems = [...grouped.entries()]
      .map(([name, roms]) => ({ name, roms, short: roms[0]?.short ?? null }))
      .sort((a, b) => a.name.localeCompare(b.name));

    // Auto-collections are systems too -- same shape, so the carousel, the
    // gamelist and every themed element work on them unchanged. ES-DE puts
    // them AFTER the real systems and omits an empty one rather than showing
    // a system with nothing in it.
    const enabled = this.svc.prefs?.get('collections') ?? [];
    for (const decl of AUTO_COLLECTIONS) {
      if (!enabled.includes(decl.short)) continue;
      const roms = list.filter(decl.match);
      if (!roms.length) continue;
      this.systems.push({
        name: decl.name,
        roms: decl.order ? decl.order(roms) : roms,
        short: decl.short,
        isCollection: true,
      });
    }

    // Custom collections: user-built sets, stored in ES-DE's own .cfg format
    // so they interoperate. Each is a system whose roms are looked up by path,
    // in the order the user added them.
    const romsDir = this.svc.romsDir?.() ?? null;
    for (const name of this.svc.collections?.list() ?? []) {
      const paths = this.svc.collections.read(name, romsDir);
      const byPath = new Map(list.map((rom) => [rom.path, rom]));
      const roms = paths.map((pth) => byPath.get(pth)).filter(Boolean);
      if (!roms.length) continue;
      this.systems.push({
        name,
        roms,
        // Themes key custom-collection artwork off one shared folder rather
        // than a per-collection one (CollectionSystemsManager.cpp:54).
        short: 'custom-collections',
        isCollection: true,
        isCustom: true,
      });
    }

    if (this.sysIndex >= this.systems.length) {
      this.sysIndex = Math.max(0, this.systems.length - 1);
    }
  }

  search(q) {
    this.query = String(q ?? '').trim().toLowerCase();
    this.gameIndex = 0;
    this.regroup();
  }

  /** @see tickScroll -- exposed so the app's animation tick can drive it. */
  tickScroll(el, contentH, boxH, dt) { return tickScroll(el, contentH, boxH, dt); }

  /**
   * Begin a carousel slide toward the current selection.
   *
   * Called by the app when sysIndex changes. "instant" themes skip it, and so
   * does a headless render -- there is nobody to see a 400ms slide in a
   * screenshot, and animating there would make every check time-dependent.
   */
  /** @see scrollInterval -- exposed so the app can pick a scroll tier. */
  scrollInterval(heldMs, fast) { return scrollInterval(heldMs, fast); }

  /** Reset the video start-delay clock; the app calls this on selection change. */
  markSnapDelay(now = Date.now()) { this._snapShownAt = now; }

  startCarouselSlide(fromIndex, fast = false) {
    const el = this.elements().find((e) => e.type === 'carousel');
    if (!el || el.props.itemTransitions === 'instant') { this.carouselOffset = 0; return false; }
    const n = this.systems.length || 1;
    // Shortest way round: a wrap from the last item to the first slides one
    // step, not backwards through the whole list.
    let delta = this.sysIndex - fromIndex;
    if (delta > n / 2) delta -= n;
    if (delta < -n / 2) delta += n;
    if (!delta) return false;
    this._carouselAnim = {
      from: this.carouselOffset - delta,
      elapsed: 0,
      ms: fast ? CAROUSEL_ANIM_MIN_MS : CAROUSEL_ANIM_MS,
    };
    this.carouselOffset = this._carouselAnim.from;
    return true;
  }

  /** Advance the slide. Returns true while it is still moving. */
  tickCarousel(dt) {
    const a = this._carouselAnim;
    if (!a) return false;
    a.elapsed += dt;
    const t = Math.min(1, a.elapsed / a.ms);
    this.carouselOffset = a.from * (1 - easeOutQuad(t));
    if (t >= 1) { this.carouselOffset = 0; this._carouselAnim = null; }
    return true;
  }

  currentSystem() { return this.systems[this.sysIndex] ?? null; }
  currentGame() { return this.currentSystem()?.roms[this.gameIndex] ?? null; }

  /**
   * The media file for an ES-DE <imageType>, or null.
   *
   * ES-DE themes ask for specific artwork -- cover, marquee, screenshot,
   * titlescreen, fanart -- and a theme commonly places SEVERAL of them in one
   * view. Answering every request with the box art made modern-es-de draw the
   * same cover twice, once in its marquee slot (a wide logo strip) and once
   * in its image slot, overlapping. Only covers and videos are scraped, so
   * anything else must resolve to nothing and let the element stay empty,
   * which is what ES-DE does for missing media.
   */
  artFor(type) {
    const game = this.currentGame();
    if (!game) return null;
    switch (type) {
      // "image" is ES-DE's GENERIC slot, and FileData::getImagePath is a
      // fallback chain: miximage -> screenshot -> titlescreen -> cover. We
      // scrape only covers, so the chain collapses to the cover -- but it is a
      // chain, not a synonym, which is why this is the one non-cover type that
      // may legitimately answer with one.
      case 'image':
      case 'cover':      return game.art ?? null;
      case 'video':      return game.video ?? null;
      // Real, distinct media types (GamelistView.cpp's imageType dispatch).
      // We do not scrape any of them, and answering with the cover would put
      // a box shot in a marquee or screenshot slot -- which is exactly what
      // made modern-es-de draw the same cover twice.
      case 'miximage':
      case 'marquee':
      case 'screenshot':
      case 'titlescreen':
      case '3dbox':
      case 'backcover':
      case 'physicalmedia':
      case 'fanart':     return null;
      default:           return null;
    }
  }

  // ── images ─────────────────────────────────────────────────────────
  /**
   * Load every image the current view can reference, once.
   *
   * Drawing is synchronous — a paint cannot await — so anything that might be
   * drawn has to be resident first. Themes reference a bounded set (per-system
   * art plus the selected game's), so this stays small.
   */
  async preload() {
    if (!this.theme) return;
    const urls = new Set();
    // BOTH views, not just the active one. preload() runs at startup while
    // the stage is still on the system view, so gamelist-only assets -- the
    // badge icons especially -- were never warmed, and drawBadges hit a cold
    // cache and returned early on the very frame it was asked to draw.
    const everyElement = [
      ...(this.theme.views?.system ?? []),
      ...(this.theme.views?.gamelist ?? []),
    ];
    for (const el of everyElement) {
      // Detect assets by VALUE, not by a list of key names. The list kept
      // going stale -- it missed the rating element's filledPath, then the
      // badges' customBadgeIcon:<slot> keys, each time leaving the first paint
      // with nothing to draw. Anything pointing into the theme is an asset.
      for (const [key, v] of Object.entries(el.props ?? {})) {
        if (typeof v !== 'string' || !v) continue;
        if (!v.startsWith('romdeck-theme://') && !/\.(png|jpg|jpeg|svg|webp|gif)$/i.test(v)) continue;
        if (key === 'fontPath') continue;             // registered, not drawn
        if (v.includes('${system.theme}')) {
          for (const sys of this.systems) {
            if (sys.short) urls.add(v.replace(/\$\{system\.theme\}/g, sys.short));
          }
        } else if (!v.includes('${')) {
          urls.add(v);
        }
      }
    }
    const game = this.currentGame();
    if (game?.art) urls.add(game.art);
    await Promise.all([...urls].map((u) => this._load(u)));
  }

  async _load(url) {
    if (this._images.has(url)) return this._images.get(url);
    const file = this.svc.resolveUrl(url);
    if (!file) { this._images.set(url, null); return null; }
    try {
      const img = await loadImage(file);
      this._images.set(url, img);
      return img;
    } catch {
      this._images.set(url, null);
      return null;
    }
  }

  /**
   * A loaded image, or null.
   *
   * On a MISS this kicks off a load and repaints when it lands. preload()
   * only ever warmed the theme's own assets plus the art of whichever game
   * was selected at boot, so moving the selection showed an empty plate for
   * every other game: paint asked for a URL that was never fetched, got null,
   * and drew nothing. Nothing was wrong with the path, the theme or the file.
   *
   * Painting stays synchronous (it must). The frame that misses draws without
   * the image and a later frame has it, which for a cover plate is the right
   * trade -- navigation never blocks on disk.
   */
  img(url) {
    if (!url) return null;
    if (this._images.has(url)) return this._images.get(url);
    if (!this._pending) this._pending = new Set();
    if (!this._pending.has(url)) {
      this._pending.add(url);
      this._load(url).then((img) => {
        this._pending.delete(url);
        if (img) this.onImageLoaded?.();
      });
    }
    return null;
  }

  perSystem(template, sys = null) {
    if (typeof template !== 'string' || !template.includes('${system.theme}')) {
      return template && !template.includes('${') ? template : null;
    }
    const short = (sys ?? this.currentSystem())?.short;
    return short ? template.replace(/\$\{system\.theme\}/g, short) : null;
  }

  // ── data bindings ──────────────────────────────────────────────────
  meta(key) {
    const sys = this.currentSystem();
    const game = this.currentGame();
    switch (key) {
      case 'system.fullName':
      case 'system.fullName.noCollections': return sys?.name ?? '';
      case 'system.fullName.autoCollections':
      case 'system.fullName.customCollections': return '';
      case 'system.gameCount':
      case 'gamecount': return sys ? `${sys.roms.length} games` : '';
      case 'game.name':
      case 'name': return game?.name ?? '';
      case 'game.cover': return game?.art ?? '';
      case 'game.video': return game?.video ?? '';
      case 'game.detail': {
        if (!game) return '';
        const bits = [];
        if (game.verified) bits.push('✓ verified');
        if (game.meta?.playcount) bits.push(`played ${game.meta.playcount}×`);
        if (game.meta?.genre) bits.push(game.meta.genre);
        return bits.join('  ·  ');
      }
      case 'description': return game?.meta?.desc ?? '';
      case 'genre': return game?.meta?.genre ?? '';
      case 'developer': return game?.meta?.developer ?? '';
      case 'publisher': return game?.meta?.publisher ?? '';
      case 'players': return game?.meta?.players ?? '';
      case 'releasedate': return game?.meta?.releasedate ?? '';
      case 'rating': return game?.meta?.rating ? String(game.meta.rating) : '';
      case 'playcount': return String(game?.meta?.playcount ?? 0);
      case 'playtime': return '';
      default: return '';
    }
  }

  /** ${…} inside a <text> body is a RUNTIME binding, not a theme variable. */
  bind(text) {
    if (typeof text !== 'string') return '';
    if (!text.includes('${')) return text;
    return text.replace(/\$\{([\w.]+)\}/g, (_m, k) => this.meta(k));
  }

  elements() {
    return this.theme?.views?.[this.view] ?? [];
  }

  // ── geometry ───────────────────────────────────────────────────────
  /**
   * Element box in stage pixels.
   *
   * A theme may give only one dimension and expect the other to follow from
   * the image's aspect ratio (<size>0.2314 0</size>). The missing side is
   * filled in from the loaded image where one is available, because the
   * ORIGIN offset depends on it: treating the zero as real puts an
   * origin-0.5 element half a screen from where the theme meant it.
   */
  box(props, img = null) {
    const [x, y] = props.pos ?? [0, 0];
    // cropSize and imageMaxSize are real ES-DE size properties, not aliases we
    // can skip: art-book-next sizes its cover and every metadata icon with
    // them and declares no <size> at all. Ignoring them left w = 0 on each,
    // so a whole theme's imagery drew at zero width -- visible as blank slots
    // while element counts and "not blank" assertions all passed.
    let [w, h] = props.size ?? props.maxSize ?? props.cropSize
      ?? props.imageMaxSize ?? props.imageSize ?? [0, 0];
    if (img && (!w || !h)) {
      const ratio = img.width / img.height;
      if (w && !h) h = (w * STAGE_W / ratio) / STAGE_H;
      else if (h && !w) w = (h * STAGE_H * ratio) / STAGE_W;
    }
    // <maxSize> is a BOUNDING BOX, not a size: the image fits inside it
    // preserving aspect, so the real box is usually smaller in one axis. Using
    // the cap verbatim inflates the element and, because <origin> offsets by
    // the box's own size, shifts it -- slate's bottom-anchored console and
    // logo (origin 0 1 / 1 1) were pushed up off their row and clipped.
    if (img && !props.size && (props.maxSize || props.imageMaxSize) && w && h) {
      const s = Math.min((w * STAGE_W) / img.width, (h * STAGE_H) / img.height);
      w = (img.width * s) / STAGE_W;
      h = (img.height * s) / STAGE_H;
    }
    const [ox, oy] = props.origin ?? [0, 0];
    return {
      x: x * STAGE_W - ox * w * STAGE_W,
      y: y * STAGE_H - oy * h * STAGE_H,
      w: w * STAGE_W,
      h: h * STAGE_H,
    };
  }

  font(props, weight = 700) {
    const size = (props.fontSize ?? 0.03) * STAGE_H;
    return fontStack(size, { family: props._family ?? null, weight });
  }

  // ── painting ───────────────────────────────────────────────────────
  paint() {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, STAGE_W, STAGE_H);
    // A theme with no background still needs one, or the previous frame and
    // the desktop show through.
    ctx.fillStyle = hex(this.theme?.desktop?.bg, '#0d0f14');
    ctx.fillRect(0, 0, STAGE_W, STAGE_H);

    // Sort by zIndex, defaulting PER ELEMENT TYPE the way ES-DE does rather
    // than to 0 for everything.
    //
    // This is not a nicety. A theme only declares <zIndex> where it needs to
    // override the default, so modern-es-de sets `zIndex 0` on its background
    // image and says nothing about anything else -- expecting the defaults to
    // put content on top. Defaulting everything to 0 made the background TIE
    // with the game list, and ties fall back to document order, so the
    // background painted over it: a gamelist view with no games in it, while
    // "33 elements, renders fine" and every count-based assertion passed.
    const z = (el) => el.props.zIndex ?? DEFAULT_Z[el.type] ?? DEFAULT_Z_FALLBACK;
    const els = [...this.elements()].sort((a, b) => z(a) - z(b));
    for (const el of els) {
      if (el.props.visible === 'false') continue;
      // <metadataElement> marks an element as part of the metadata block, to
      // be hidden together with it (ImageComponent.cpp:739). ES-DE hides it
      // for folders, placeholders and any game with hidemetadata set.
      if ((el.props.metadataElement === 'true' || el.props.metadataElement === true)
        && this.currentGame()?.meta?.hidemetadata === 'true') continue;
      ctx.save();
      ctx.globalAlpha = el.props.opacity ?? 1;
      try { this.drawElement(ctx, el); } catch { /* one bad element must not blank the view */ }
      ctx.restore();
    }
    return this.canvas;
  }

  drawElement(ctx, el) {
    const b = this.box(el.props);
    switch (el.type) {
      case 'image': return this.drawImage(ctx, el, b);
      case 'carousel': return this.drawCarousel(ctx, el, b);
      case 'textlist': return this.drawTextlist(ctx, el, b);
      case 'grid': return this.drawGrid(ctx, el, b);
      case 'badges': return this.drawBadges(ctx, el, b);
      case 'video': return this.drawVideo(ctx, el, b);
      case 'clock': return this.drawText(ctx, el, b, clockText());
      case 'rating': return this.drawRating(ctx, el, b);
      case 'helpsystem': return this.drawHelp(ctx, el, b);
      case 'systemstatus': return this.drawSystemStatus(ctx, el, b);
      case 'text':
      case 'datetime':
      case 'gamelistinfo': {
        const key = el.props.metadata ?? el.props.systemdata;
        let text = key
          ? (this.meta(key) || el.props.defaultValue || '')
          : this.bind(el.props.text ?? '');
        // A <datetime> holds an ES-DE timestamp (19990801T000000) and the
        // theme's <format> says how to print it. Without this the raw stamp
        // went on screen verbatim.
        if (el.type === 'datetime') {
          text = el.props.displayRelative === 'true' || el.props.displayRelative === true
            ? relativeDate(text)
            : formatDate(text, el.props.format);
        }
        return this.drawText(ctx, el, b, text);
      }
      default: return undefined;
    }
  }

  /**
   * The themed help row: the button prompts along the bottom of a view.
   *
   * <helpsystem> carries no <text> and no <metadata>, so routing it through
   * drawText produced nothing at all -- art-book-next's OPTIONS/MENU/SELECT
   * row was simply absent from every render. The ENTRIES are the frontend's
   * to supply (they describe what the buttons do here, not what the theme
   * says); the theme supplies the placement and styling, which is what these
   * properties are for.
   *
   * scope="menu" is ES-DE's help for its own menu, not for a view, so it is
   * skipped rather than drawn over the library.
   */
  drawHelp(ctx, el, b) {
    const p = el.props;
    // <scope> is shared | view | menu | none (HelpComponent.cpp:214). "menu"
    // is ES-DE's help for its OWN menu, not a view, and "none" means do not
    // display -- art-book-next declares one to switch the row off for a
    // variant, and drawing it put a second prompt row in the top-left corner
    // on top of the theme's real one. "shared" and "view" both render.
    if (p.scope === 'menu' || p.scope === 'none') return;

    // The prompts this view offers. ES-DE names them with stable ids, and
    // <entries> filters and orders which are shown ("all" means every one).
    // Ids are ES-DE's own (HelpComponent.h sAllowedEntries): a, b, x, y,
    // start, back, lr, left/right, up/down and so on. Inventing our own meant
    // a theme naming "back" matched nothing and its row silently lost an
    // entry, which is exactly what art-book-next's "back,start,a" did.
    const all = this.view === 'gamelist'
      ? [['a', '\u24B6', 'play'], ['b', '\u24B7', 'back'],
        ['x', '\u24CD', 'options'], ['start', '\u24C2', 'menu'],
        ['back', '\u24C8', 'select']]
      : [['lr', '\u2190\u2192', 'system'], ['a', '\u24B6', 'open'],
        ['start', '\u24C2', 'menu'], ['back', '\u24C8', 'select']];
    let entries = all;
    if (typeof p.entries === 'string' && !/\ball\b/i.test(p.entries)) {
      const want = p.entries.toLowerCase().split(/[\s,]+/).filter(Boolean);
      // ES-DE preserves ITS canonical order, not the theme's writing order
      // (HelpComponent.cpp:247 walks sAllowedEntries and keeps matches).
      const picked = all.filter(([id]) => want.includes(id));
      if (picked.length) entries = picked;
    }

    // Spacings are fractions of SCREEN WIDTH, clamped exactly as ES-DE does
    // (HelpComponent.cpp:277). Hardcoding them ignored the theme's own rhythm.
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, Number(v)));
    const size = (p.fontSize ?? 0.022) * STAGE_H * Number(p.entryRelativeScale ?? 1);
    const entryGap = p.entrySpacing !== undefined
      ? clamp(p.entrySpacing, 0, 0.04) * STAGE_W : size * 1.1;
    const iconGap = p.iconTextSpacing !== undefined
      ? clamp(p.iconTextSpacing, 0, 0.04) * STAGE_W : size * 0.35;

    ctx.font = fontStack(size, { family: p._family ?? null, weight: 700 });
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';

    const widthOf = ([, icon, label]) =>
      ctx.measureText(icon).width + iconGap + ctx.measureText(label).width;
    let width = entries.reduce((a, e) => a + widthOf(e) + entryGap, 0) - entryGap;

    // <pos> is the anchor and <origin> says which corner of the row it names,
    // so the row has to be measured before it can be placed.
    const [ox, oy] = p.origin ?? [0, 0];
    let x = b.x - ox * width;
    const y = b.y - oy * size + size / 2;

    // The background plate, when the theme asks for one. Padding pairs are
    // (before, after) and BOTH axes are fractions of screen width.
    if (p.backgroundColor) {
      const [padL, padR] = p.backgroundHorizontalPadding ?? [0, 0];
      const [padT, padB] = p.backgroundVerticalPadding ?? [0, 0];
      const bx = x - padL * STAGE_W;
      const by = y - size / 2 - padT * STAGE_W;
      const bw = width + (padL + padR) * STAGE_W;
      const bh = size + (padT + padB) * STAGE_W;
      const radius = clamp(p.backgroundCornerRadius ?? 0, 0, 0.5) * STAGE_W;
      roundRect(ctx, bx, by, bw, bh, radius);
      ctx.fillStyle = hex(p.backgroundColor);
      ctx.fill();
    }

    for (const [, icon, label] of entries) {
      // *Dimmed variants apply when ES-DE dims the help row (during a
      // transition or while a menu is up). Our help row is never in that
      // state, so they are only used as a fallback when a theme supplies the
      // dimmed colour and no base one.
      ctx.fillStyle = hex(p.iconColor ?? p.iconColorDimmed, '#cccccc');
      ctx.fillText(icon, x, y);
      x += ctx.measureText(icon).width + iconGap;
      ctx.fillStyle = hex(p.textColor ?? p.textColorDimmed, '#cccccc');
      ctx.fillText(applyCase(label, p.letterCase), x, y);
      x += ctx.measureText(label).width + entryGap;
    }
    ctx.textBaseline = 'alphabetic';
  }


  /**
   * The device status row: battery, wifi, bluetooth.
   *
   * <height> sizes the icons as a fraction of screen height, clamped 0.01-0.5
   * (SystemStatusComponent.cpp:191); <pos> and <origin> place the row as
   * usual. Values come from sysfs, not from the theme -- this was the last
   * themable element that needed something other than a renderer.
   *
   * An absent indicator is SKIPPED rather than drawn empty: a desktop has no
   * battery, and a greyed-out battery icon there would be a lie.
   */
  drawSystemStatus(ctx, el, b) {
    const p = el.props;
    if (p.scope === 'none') return;
    const size = Math.max(0.01, Math.min(0.5, Number(p.height ?? 0.03))) * STAGE_H;
    const gap = size * 0.45;
    const st = this.svc.deviceStatus?.() ?? {};

    const parts = [];
    if (st.bluetooth?.on) parts.push(['\u0042', null]);          // B
    if (st.wifi) parts.push([st.wifi.connected ? '\u25B0'.repeat(Math.max(1, st.wifi.bars)) : '\u2715', null]);
    if (st.battery) {
      parts.push([`${st.battery.charging ? '\u26A1' : ''}${st.battery.capacity}%`, null]);
    }
    if (!parts.length) return;

    ctx.font = fontStack(size * 0.8, { family: p._family ?? null, weight: 700 });
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    let width = 0;
    for (const [txt] of parts) width += ctx.measureText(txt).width + gap;
    width -= gap;

    const [ox, oy] = p.origin ?? [0, 0];
    let x = b.x - ox * width;
    const y = b.y - oy * size + size / 2;
    ctx.fillStyle = hex(p.color ?? p.iconColor, '#e8ecf4');
    for (const [txt] of parts) {
      ctx.fillText(txt, x, y);
      x += ctx.measureText(txt).width + gap;
    }
    ctx.textBaseline = 'alphabetic';
  }

  drawText(ctx, el, b, text) {
    if (!text) {
      // Clear the measured height, or a container that HAD long text keeps
      // claiming it overflows and its scroll timer never stops.
      el._contentH = 0;
      el._scroll = null;
      return;
    }
    const p = el.props;
    const size = (p.fontSize ?? 0.03) * STAGE_H;
    ctx.fillStyle = hex(p.color, '#e8ecf4');
    ctx.font = this.font(p);
    const align = p.horizontalAlignment === 'center' ? 'center'
      : p.horizontalAlignment === 'right' ? 'right' : 'left';
    ctx.textAlign = align;
    // Text elements usually declare no <size>, so pos IS the anchor — the
    // same thing the DOM did with left/top plus a translate. Treating an
    // empty box as a real one collapsed centred text to the left edge.
    const tx = b.w
      ? (align === 'center' ? b.x + b.w / 2 : align === 'right' ? b.x + b.w : b.x)
      : (p.pos?.[0] ?? 0) * STAGE_W;
    // <verticalAlignment> is top | center | bottom (DateTimeComponent.cpp:332)
    // and defaults to centre. Always centring ignored a theme that anchors a
    // label to the top of its box, which is how metadata columns stay on the
    // same baseline as the icons beside them.
    const vAlign = p.verticalAlignment ?? 'center';
    const boxTop = b.h ? b.y : (p.pos?.[1] ?? 0) * STAGE_H;
    const ty = !b.h
      ? boxTop + size * 0.35
      : vAlign === 'top' ? boxTop + size * 0.85
        : vAlign === 'bottom' ? boxTop + b.h - size * 0.2
          : boxTop + b.h / 2 + size * 0.35;
    const shown = applyCase(text, p.letterCase);

    // A <container> element (or any <metadata>description) holds prose that
    // ES-DE wraps and scrolls inside its box. The scrolling is animation we
    // cannot show in a still, but the WRAPPING is layout: a description drawn
    // as one line runs straight out of its box and across the view.
    // <containerType> "horizontal" is a marquee, not a scrolling block, and
    // ES-DE turns the container OFF for it (GamelistView.cpp:297) -- so the
    // text stays on one line rather than wrapping.
    const wraps = (p.container === 'true' || p.container === true
      || (p.metadata === 'description' && p.container !== 'false'))
      && p.containerType !== 'horizontal';
    if (wraps && b.w && b.h) {
      const lineH = size * Number(p.lineSpacing ?? 1.3);
      ctx.save();
      ctx.beginPath();
      ctx.rect(b.x, b.y, b.w, b.h);
      ctx.clip();
      // Lay the text out first: the scroll offset needs the full height.
      const words = String(shown).split(/\s+/).filter(Boolean);
      const lines = [];
      let line = '';
      for (const word of words) {
        const test = line ? `${line} ${word}` : word;
        if (ctx.measureText(test).width > b.w && line) { lines.push(line); line = word; }
        else line = test;
      }
      if (line) lines.push(line);

      // <container> scrolls when the text overflows. The offset is advanced
      // by the app's animation tick, not here -- a draw that moved things
      // would scroll at whatever rate the app happened to repaint.
      // <containerVerticalSnap> (default TRUE, ScrollableContainer.cpp:28)
      // trims the box to whole lines so scrolling never leaves a half-row
      // clipped at the bottom edge.
      const snap = p.containerVerticalSnap !== 'false' && p.containerVerticalSnap !== false;
      const usableH = snap ? Math.max(lineH, Math.floor(b.h / lineH) * lineH) : b.h;
      const contentH = lines.length * lineH;
      const offset = contentH > usableH ? (el._scroll?.pos ?? 0) : 0;
      let ly = b.y + size * 0.9 - offset;
      for (const l of lines) {
        if (ly > b.y - lineH && ly < b.y + b.h + lineH) ctx.fillText(l, tx, ly);
        ly += lineH;
      }
      el._contentH = contentH;
      ctx.restore();
      return;
    }

    // A text element may carry its own plate (<backgroundColor> plus an
    // optional <backgroundCornerRadius>, clamped to 0.5 of screen width).
    if (p.backgroundColor && b.w && b.h) {
      const radius = Math.max(0, Math.min(0.5, Number(p.backgroundCornerRadius ?? 0))) * STAGE_W;
      roundRect(ctx, b.x, b.y, b.w, b.h, radius);
      ctx.fillStyle = hex(p.backgroundColor);
      ctx.fill();
      ctx.fillStyle = hex(p.color, '#e8ecf4');
    }
    if (b.w) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(b.x - 2, b.y - size, b.w + 4, (b.h || size * 2) + size);
      ctx.clip();
      ctx.fillText(shown, tx, ty);
      ctx.restore();
    } else {
      ctx.fillText(shown, tx, ty);
    }
  }

  drawImage(ctx, el, b) {
    const p = el.props;
    // A 1x1 image tinted with <color> is the box.png fill idiom every real
    // theme uses for backgrounds and separator rules. Drawing it as an image
    // paints the whole stage its own colour.
    //
    // But <color> on a REAL image means TINT, not fill — modern-es-de's
    // selectionBox is a shaped PNG with a colour, and filling its box painted
    // a cyan slab over the carousel. The fill idiom is specifically box.png
    // (or a tiled 1x1); anything else keeps its shape.
    const isBoxIdiom = /(^|\/)box\.(png|svg)$/i.test(p.path ?? '') || p.tile === 'true';
    if (p.color && (isBoxIdiom || (!p.path && !p.metadata && !p.imageType))) {
      ctx.fillStyle = hex(p.color);
      ctx.fillRect(b.x, b.y, b.w || STAGE_W, b.h || STAGE_H);
      return;
    }
    let url = null;
    if (p.metadata) url = this.meta(p.metadata);
    else if (p.imageType) url = this.artFor(p.imageType);
    else url = this.perSystem(p.path);
    let img = this.img(url);
    if (!img && p.default) img = this.img(this.perSystem(p.default));
    if (!img && p.defaultImage) img = this.img(this.perSystem(p.defaultImage));
    if (!img) return;
    // Recompute with the image in hand: a one-dimension <size> needs the
    // aspect ratio before the origin offset can be right.
    const box = this.box(p, img);
    const restoreInterp = withInterpolation(ctx, p.interpolation);
    // <flipHorizontal> / <flipVertical> mirror the image about its own centre.
    const flipH = p.flipHorizontal === 'true' || p.flipHorizontal === true;
    const flipV = p.flipVertical === 'true' || p.flipVertical === true;
    // <scrollFadeIn>: ramp opacity from 0.5 to 1 over 325ms after the
    // selection moved, rather than snapping new artwork in at full strength.
    const prevAlpha = ctx.globalAlpha;
    if (p.scrollFadeIn === 'true' || p.scrollFadeIn === true) {
      const since = Date.now() - (this._snapShownAt ?? 0);
      if (since < FADE_IN_TIME) {
        const t = since / FADE_IN_TIME;
        ctx.globalAlpha = prevAlpha
          * (FADE_IN_START_OPACITY + (1 - FADE_IN_START_OPACITY) * t);
      }
    }
    // <saturation> is 1 = untouched, and <cornerRadius> rounds the image's own
    // corners (both clamped as ImageComponent.cpp clamps them).
    const sat = Number(p.saturation ?? p.imageSaturation ?? 1);
    const shown = sat < 1
      ? saturateImage(img, box.w || img.width, box.h || img.height, Math.max(0, sat))
      : img;
    const radius = Math.max(0, Math.min(0.5, Number(p.cornerRadius ?? 0))) * STAGE_W;
    if (radius > 0 && box.w && box.h) {
      ctx.save();
      roundRect(ctx, box.x, box.y, box.w, box.h, radius);
      ctx.clip();
      drawContain(ctx, shown, box, p.color ? hex(p.color) : null);
      ctx.restore();
      ctx.globalAlpha = prevAlpha;
      restoreInterp();
      return;
    }
    if (flipH || flipV) {
      ctx.save();
      ctx.translate(box.x + box.w / 2, box.y + box.h / 2);
      ctx.scale(flipH ? -1 : 1, flipV ? -1 : 1);
      ctx.translate(-(box.x + box.w / 2), -(box.y + box.h / 2));
    }
    drawContain(ctx, shown, box, p.color ? hex(p.color) : null);
    if (flipH || flipV) ctx.restore();
    ctx.globalAlpha = prevAlpha;
    restoreInterp();
  }

  drawCarousel(ctx, el, b) {
    const p = el.props;
    if (!this.systems.length) return;
    // ES-DE's own geometry (CarouselComponent: mItemSize default is 25% of
    // screen width, mMaxItemCount default 3):
    //
    //   itemSpacing = ((size.x - itemSize.x * maxItemCount) / maxItemCount)
    //                 + itemSize.x
    //
    // itemSize is the ITEM'S OWN SIZE in normalized units; maxItemCount is how
    // many fit across, and it is fractional on purpose -- art-book-next asks
    // for 5.5, so the outer two are half-clipped at the screen edges. The two
    // together give the pitch, and when itemSize is larger than the pitch the
    // items OVERLAP, which is what makes that theme's slanted panels.
    const span = p.maxItemCount ?? 3;
    const declared = p.itemSize?.[0] ? p.itemSize[0] * STAGE_W : STAGE_W * 0.25;
    const declaredH = p.itemSize?.[1] ? p.itemSize[1] * STAGE_H : b.h * 0.74;
    const pitch = ((b.w - declared * span) / span) + declared;
    // An item WIDER than its pitch is deliberate overlap -- art-book-next's
    // 1x1 panels are stage-sized and slide over each other. Drawing them at
    // full declared width also means cropping a 1920-wide box down to a
    // 349-wide slot, which zooms the artwork past recognition, so the drawn
    // width is the pitch while the SOURCE keeps its declared proportions.
    // Only the WIDTH is clamped. Height is whatever the theme declared:
    // art-book-next's panels are stage-tall and stay stage-tall, and scaling
    // height by the same ratio collapsed them to a 196px band.
    const itemW = Math.min(declared, pitch);
    const itemH = declaredH;
    // ES-DE's default itemStacking is CENTERED (CarouselComponent.h): the
    // SELECTED item sits at the middle of the carousel and neighbours flank
    // it, rather than items filling slots left-to-right. Getting this wrong
    // put the theme's own selection box a slot away from the selection.
    // <itemHorizontalAlignment> / <wheelHorizontalAlignment> move the
    // SELECTED item away from the centre; <horizontalOffset> / <verticalOffset>
    // shift the whole strip, both clamped to -1..1 of the box
    // (CarouselComponent.h:1729).
    const align = p.itemHorizontalAlignment ?? p.wheelHorizontalAlignment ?? 'center';
    const alignX = align === 'left' ? b.x + itemW / 2
      : align === 'right' ? b.x + b.w - itemW / 2
        : b.x + b.w / 2;
    const clamp1 = (v) => Math.max(-1, Math.min(1, Number(v ?? 0)));
    const centerX = alignX + clamp1(p.horizontalOffset) * b.w;
    const offsetY = clamp1(p.verticalOffset) * b.h;
    // Draw out to the edges, not just the whole slots: a fractional span
    // means the outermost items are half off-screen and still visible, and
    // clamping the loop to the system count dropped them entirely.
    // ES-DE loads ceil((maxItemCount + 1) / 2) either side, so the
    // half-clipped outermost items still draw.
    const half = Math.ceil((span + 1) / 2);

    // <itemStacking> decides which item is on TOP where they overlap.
    const order = [];
    for (let o = -half; o <= half; o++) order.push(o);
    for (const off of stackOrder(order, p.itemStacking)) {
      const idx = (this.sysIndex + off + this.systems.length * 2) % this.systems.length;
      const sys = this.systems[idx];
      if (!sys) continue;
      const sel = off === 0;
      const scale = sel ? (p.itemScale ?? 1) : 1;
      // <itemLinearScale> shrinks each item a fixed step further from the
      // selection; <itemLinearSpacing> does the same to the gap. Both are
      // (x, y) pairs clamped -0.5..1 (CarouselComponent.h:1482).
      const lin = (pair, i) => (pair?.[i] === undefined ? 0
        : Math.max(-0.5, Math.min(1, Number(pair[i]))));
      const dist = Math.abs(off);
      const linScale = Math.max(0.05, 1 - lin(p.itemLinearScale, 0) * dist);
      const w = itemW * scale * linScale;
      const h = itemH * scale * linScale;
      const cx = centerX + (off + this.carouselOffset) * pitch - w / 2;
      // <itemVerticalAlignment> is top | center | bottom
      // (CarouselComponent.h:1674); centre is the default.
      const vAlign = p.itemVerticalAlignment ?? 'center';
      const cy = (vAlign === 'top' ? b.y
        : vAlign === 'bottom' ? b.y + b.h - h
          : b.y + b.h / 2 - h / 2) + offsetY
        // <itemDiagonalOffset> steps each item further down the further it is
        // from the selection, which is what makes a diagonal wheel.
        + off * (Number(p.itemDiagonalOffset ?? 0) * STAGE_H);

      // <itemRotation> turns each UNSELECTED item by a fixed angle about
      // <itemRotationOrigin> (a fraction of the item). The selected one stays
      // upright, which is what makes a fanned wheel read as a wheel.
      const itemRot = sel ? 0 : Number(p.itemRotation ?? 0);
      const rotated = itemRot !== 0;
      if (rotated) {
        const [rox, roy] = p.itemRotationOrigin ?? [0.5, 0.5];
        ctx.save();
        ctx.translate(cx + w * rox, cy + h * roy);
        ctx.rotate((itemRot * Math.PI) / 180);
        ctx.translate(-(cx + w * rox), -(cy + h * roy));
      }

      // A plate only when the theme asks for one. "00000000" is transparent,
      // and art-book-next sets exactly that: painting the default slate behind
      // full-bleed artwork put a grey card under every system image.
      const plate = sel ? (p.selectedColor ?? p.color) : p.color;
      if (plate && plate !== '00000000') {
        roundRect(ctx, cx, cy, w, h, 14);
        ctx.fillStyle = fillStyle(ctx, { x: cx, y: cy, w, h }, plate,
          sel ? p.selectedColorEnd : p.colorEnd, p.gradientType, '#1a1f2b');
        ctx.fill();
      }
      // <selectedBackgroundColor> is a PLATE behind the selected row, with
      // (left, right) margins and a corner radius, all fractions of screen
      // width (TextListComponent.h:518). It is distinct from selectorColor:
      // slate draws the pill with this and no selector bar at all.
      if (sel && p.selectedBackgroundColor && p.selectedBackgroundColor !== '00000000') {
        const [mL, mR] = p.selectedBackgroundMargins ?? [0, 0];
        const radius = Math.max(0, Math.min(0.5,
          Number(p.selectedBackgroundCornerRadius ?? 0))) * STAGE_W;
        roundRect(ctx, b.x + mL * STAGE_W, y - size * 0.95,
          b.w - (mL + mR) * STAGE_W, lh, radius);
        ctx.fillStyle = fillStyle(ctx,
          { x: b.x + mL * STAGE_W, y: y - size * 0.95, w: b.w - (mL + mR) * STAGE_W, h: lh },
          p.selectedBackgroundColor, p.selectedBackgroundColorEnd, p.gradientType);
        ctx.fill();
      }
      if (sel && p.selectorColor && p.selectorColor !== '00000000') {
        roundRect(ctx, cx, cy, w, h, 14);
        ctx.strokeStyle = hex(p.selectorColor);
        ctx.lineWidth = 4;
        ctx.stroke();
      }

      const url = this.perSystem(p.staticImage ?? p.imagePath ?? p.path, sys);
      let img = this.img(url);
      if (!img) img = this.img(this.perSystem(p.defaultImage, sys));
      if (img) {
        const tint = sel ? (p.imageSelectedColor ?? p.imageColor) : p.imageColor;
        // <imageBrightness> lifts or drops the item's artwork, -1..1.
        const brightness = Number(p.imageBrightness ?? 0);
        // Unfocused items get their own opacity/dimming, clamped as ES-DE
        // clamps them (CarouselComponent.h:1753). Drawing every item at full
        // strength is why our carousels read flatter than the themes do.
        const clamp01 = (v, lo, hi) => Math.max(lo, Math.min(hi, Number(v)));
        const prevAlpha = ctx.globalAlpha;
        if (!sel && p.unfocusedItemOpacity !== undefined) {
          ctx.globalAlpha = prevAlpha * clamp01(p.unfocusedItemOpacity, 0.1, 1);
        }
        // Full-bleed items COVER their box; inset cards are contained with a
        // margin. Letterboxing a 1x1 item left bars where the theme expects
        // edge-to-edge artwork.
        // <imageCornerRadius> rounds the ITEM's artwork (as distinct from
        // <cornerRadius>, which rounds a plain image element).
        // <unfocusedItemSaturation> desaturates the items either side of the
        // selection (CarouselComponent.h:1038); 1 leaves them untouched.
        const restoreItemInterp = withInterpolation(ctx, p.imageInterpolation);
        const itemSat = sel ? 1 : Number(p.unfocusedItemSaturation ?? 1);
        const shownImg = itemSat < 1
          ? saturateImage(img, w, h, Math.max(0, itemSat)) : img;
        const imgRadius = Math.max(0, Math.min(0.5,
          Number(p.imageCornerRadius ?? 0))) * STAGE_W;
        if (imgRadius > 0) {
          ctx.save();
          roundRect(ctx, cx, cy, w, h, imgRadius);
          ctx.clip();
        }
        if (p.itemSize?.[0] >= 1 || p.itemSize?.[1] >= 1) {
          drawCover(ctx, shownImg, { x: cx, y: cy, w, h }, tint ? hex(tint) : null);
        } else {
          drawContain(ctx, shownImg, { x: cx, y: cy, w, h }, tint ? hex(tint) : null, 0.86);
        }
        if (imgRadius > 0) ctx.restore();
        restoreItemInterp();
        // Dimming is a black wash OVER the item, not a change to its alpha.
        if (!sel && p.unfocusedItemDimming !== undefined) {
          const dim = 1 - clamp01(p.unfocusedItemDimming, 0, 1);
          if (dim > 0) {
            ctx.fillStyle = `rgba(0,0,0,${dim.toFixed(3)})`;
            ctx.fillRect(cx, cy, w, h);
          }
        }
        ctx.globalAlpha = prevAlpha;
      } else {
        ctx.fillStyle = hex(p.textColor, '#e8ecf4');
        ctx.font = fontStack(Math.round(h * 0.13));
        ctx.textAlign = 'center';
        // Collections get their own letter case in the carousel, chosen by
        // KIND -- auto and custom are separate properties
        // (CarouselComponent.h:1838). Everything else uses the element's
        // plain <letterCase>.
        // <textBackgroundColor> is a plate behind the carousel item's label.
        if (p.textBackgroundColor && p.textBackgroundColor !== '00000000') {
          const tbRadius = Math.max(0, Math.min(0.5,
            Number(p.textBackgroundCornerRadius ?? 0))) * STAGE_W;
          roundRect(ctx, cx, cy + h * 0.72, w, h * 0.28, tbRadius);
          ctx.fillStyle = hex(p.textBackgroundColor);
          ctx.fill();
          ctx.fillStyle = hex(p.textColor, '#e8ecf4');
        }
        const kindCase = sys.isCustom ? p.letterCaseCustomCollections
          : sys.isCollection ? p.letterCaseAutoCollections
            : null;
        wrapText(ctx, applyCase(sys.name, kindCase ?? p.letterCase),
          cx + w / 2, cy + h / 2, w * 0.86, Math.round(h * 0.15));
      }
      if (rotated) {
        ctx.restore();
      }
    }
  }

  drawTextlist(ctx, el, b) {
    const p = el.props;
    const sys = this.currentSystem();
    if (!sys) return;
    const size = (p.fontSize ?? 0.034) * STAGE_H;
    const lh = size * (p.lineSpacing ?? 1.5);
    const rows = Math.max(1, Math.floor(b.h / lh));
    const start = Math.max(0, Math.min(this.gameIndex - Math.floor(rows / 2), sys.roms.length - rows));

    ctx.save();
    ctx.beginPath();
    ctx.rect(b.x, b.y, b.w, b.h);
    ctx.clip();
    ctx.font = this.font(p);
    ctx.textAlign = p.horizontalAlignment === 'center' ? 'center' : 'left';
    for (let i = Math.max(0, start), row = 0; i < sys.roms.length && row < rows; i++, row++) {
      const sel = i === this.gameIndex;
      const y = b.y + row * lh + size;
      if (sel && p.selectorColor && p.selectorColor !== '00000000') {
        // <selectorWidth> is a WIDTH, not a flag. modern-es-de asks for
        // 0.0035 -- a thin marker bar down the edge of the row -- and painting
        // the full row width instead filled it with the same colour as
        // selectedColor, so the selected game became a solid green slab with
        // its own name invisible on top. Absent means "the whole row", which
        // is what themes without a marker expect.
        const selW = p.selectorWidth ? Number(p.selectorWidth) * STAGE_W : b.w;
        const selX = b.x + (p.selectorHorizontalOffset
          ? Number(p.selectorHorizontalOffset) * STAGE_W : 0);
        // <selectorHeight> overrides the row height; <selectorVerticalOffset>
        // nudges the bar off the text baseline.
        const selH = p.selectorHeight ? Number(p.selectorHeight) * STAGE_H : lh;
        const selY = y - size * 0.95
          + (p.selectorVerticalOffset ? Number(p.selectorVerticalOffset) * STAGE_H : 0);
        const selBox = { x: selX, y: selY, w: Number.isFinite(selW) ? selW : b.w, h: selH };
        // <selectorImagePath> replaces the bar with an image (tiled or not).
        const selImg = this.img(this.perSystem(p.selectorImagePath));
        if (selImg) {
          drawContain(ctx, selImg, selBox, p.selectorColor ? hex(p.selectorColor) : null, 1);
        } else {
          ctx.fillStyle = fillStyle(ctx, selBox, p.selectorColor, p.selectorColorEnd,
            p.selectorGradientType, 'rgba(255,255,255,0.08)');
          ctx.fillRect(selBox.x, selBox.y, selBox.w, selBox.h);
        }
      }
      // ES-DE splits list entries into PRIMARY (games) and SECONDARY
      // (folders), each with its own selected colour; secondary falls back to
      // the primary one when a theme omits it (TextListComponent.h:514).
      // romdeck has no folder entries, so every row is primary -- the
      // secondary colours are read so a theme that sets ONLY those still
      // renders in its own palette rather than the default grey.
      const primary = p.primaryColor ?? p.color ?? p.secondaryColor;
      const selected = p.selectedColor ?? p.selectedSecondaryColor ?? primary;
      ctx.fillStyle = hex(sel ? selected : primary, sel ? '#ffffff' : '#8b94a7');
      // <indicators> is symbols | ascii | none (TextListComponent.h:676) and
      // marks a favorite in the list. ES-DE's symbol is U+F005, a Font Awesome
      // private-use codepoint from a font it ships and we do not -- it would
      // render as tofu here, so the symbols mode uses a real star instead.
      const ind = p.indicators ?? 'symbols';
      const mark = !sys.roms[i].meta?.favorite || ind === 'none' ? ''
        : ind === 'ascii' ? '* ' : '★ ';
      // <systemNameSuffix> appends " [SYSTEM]" in a COLLECTION, where a list
      // mixes games from several systems and the name alone is ambiguous
      // (GamelistBase.cpp:789). It has its own letter case, separate from the
      // list's, and is inert outside a collection -- which is exactly why it
      // could not be implemented before collections existed.
      // <collectionIndicators> marks membership of the collection BEING
      // EDITED, on any list (GamelistBase.cpp:902). ES-DE's symbol is a Font
      // Awesome tick from a font it ships and we do not, so symbols mode uses
      // a real check mark here for the same reason the favorite star does.
      let inColl = '';
      if (this.editingCollection) {
        const romsDir = this.svc.romsDir?.() ?? null;
        if (this.svc.collections?.has(this.editingCollection, sys.roms[i].path, romsDir)) {
          inColl = (p.collectionIndicators ?? 'symbols') === 'ascii' ? '! ' : '\u2713  ';
        }
      }
      let label = inColl + mark + sys.roms[i].name;
      if (sys.isCollection && (p.systemNameSuffix === 'true' || p.systemNameSuffix === true)) {
        label += ` [${applyCase(sys.roms[i].system, p.letterCaseSystemNameSuffix ?? 'uppercase')}]`;
      }
      const margin = b.w * (p.horizontalMargin ?? 0.02);
      const tx = ctx.textAlign === 'center' ? b.x + b.w / 2 : b.x + margin;
      // Clipping alone leaves a name sliced mid-glyph at the edge, which
      // reads as a rendering fault. Ellipsis is what the DOM did via
      // text-overflow and what ES-DE does for a too-long entry.
      ctx.fillText(ellipsize(ctx, applyCase(label, p.letterCase), b.w - margin * 2), tx, y);
    }
    ctx.restore();
  }

  drawGrid(ctx, el, b) {
    const p = el.props;
    const sys = this.currentSystem();
    if (!sys) return;
    // ES-DE's grid geometry (GridComponent.h:545). Columns are not derived by
    // rounding: it accumulates itemSize + itemSpacing until the next one would
    // overflow the box, which is why an item that ALMOST fits leaves a gap
    // rather than being squeezed in.
    //
    //   width = horizontalMargin * 2
    //   loop:  width += itemSize.x (+ itemSpacing.x after the first)
    //          stop when width > size.x, else ++columns
    //
    // itemSize defaults to 15% of screen width (GridComponent.h:233).
    // A pair prop can be null when the theme leaves it to an include, so read
    // through optional chaining AND coalesce -- p.itemSpacing?.[0] is
    // undefined for null but NaN-propagates if the array holds junk.
    const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
    const itemW = num(p.itemSize?.[0], 0.15) * STAGE_W;
    const itemH = num(p.itemSize?.[1], 0.25) * STAGE_H;
    const spaceX = num(p.itemSpacing?.[0], 0) * STAGE_W;
    const spaceY = num(p.itemSpacing?.[1], 0) * STAGE_H;
    // scaleInwards keeps a scaled item inside its cell, so no margin is
    // needed to hold the overflow.
    const scale = Number(p.itemScale ?? 1);
    const inwards = p.scaleInwards === 'true' || p.scaleInwards === true;
    const marginX = ((itemW * (inwards ? 1 : scale)) - itemW) / 2;
    const marginY = ((itemH * (inwards ? 1 : scale)) - itemH) / 2;

    let cols = 0;
    let acc = marginX * 2;
    for (;;) {
      acc += itemW;
      if (cols !== 0) acc += spaceX;
      if (acc > b.w) break;
      cols++;
    }
    if (cols === 0) cols = 1;

    // fractionalRows lets a partial row show at the bottom edge; without it
    // only whole rows are laid out.
    const fractional = p.fractionalRows === 'true' || p.fractionalRows === true;
    const rowH = itemH + spaceY;
    const rows = Math.max(1, fractional
      ? Math.ceil((b.h - marginY * 2) / rowH)
      : Math.floor((b.h - marginY * 2 + spaceY) / rowH));
    const cellW = itemW + spaceX;
    const cellH = rowH;
    const perPage = cols * rows;
    const page = Math.floor(this.gameIndex / perPage);
    const start = page * perPage;
    const pad = 0;

    ctx.save();
    ctx.beginPath();
    ctx.rect(b.x, b.y, b.w, b.h);
    ctx.clip();
    for (let i = start, n = 0; i < sys.roms.length && n < perPage; i++, n++) {
      const game = sys.roms[i];
      const cx = b.x + marginX + (n % cols) * cellW + pad;
      const cy = b.y + marginY + Math.floor(n / cols) * cellH + pad;
      // <imageRelativeScale> shrinks the artwork inside its cell, leaving a
      // margin the theme can colour (GridComponent.h:1058).
      const relScale = Math.max(0.2, Math.min(1, Number(p.imageRelativeScale ?? 1)));
      const cw = (itemW - pad * 2) * relScale;
      const ch = (itemH - pad * 2) * relScale;
      // <imageFit> is contain | fill | cover (GridComponent.h:1066).
      const fit = p.imageFit ?? 'contain';
      const sel = i === this.gameIndex;

      roundRect(ctx, cx, cy, cw, ch, 8);
      ctx.fillStyle = 'rgba(255,255,255,0.05)';
      ctx.fill();
      const img = this.img(game.art);
      if (img) {
        const cell = { x: cx, y: cy, w: cw, h: ch };
        // "cover" crops to fill, "fill" stretches, "contain" letterboxes.
        if (fit === 'cover') drawCover(ctx, img, cell, null);
        else if (fit === 'fill') ctx.drawImage(img, cx, cy, cw, ch);
        else drawContain(ctx, img, cell, null, 1);
      } else {
        // An unscraped library must stay readable, not a wall of empty boxes.
        ctx.fillStyle = '#8b94a7';
        ctx.font = fontStack(Math.round(ch * 0.09), { weight: 600 });
        ctx.textAlign = 'center';
        wrapText(ctx, game.name, cx + cw / 2, cy + ch / 2, cw * 0.9, Math.round(ch * 0.11), 3);
      }
      if (sel) {
        roundRect(ctx, cx, cy, cw, ch, 8);
        ctx.strokeStyle = hex(p.selectorColor, '#4fd1c5');
        ctx.lineWidth = 4;
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  /**
   * Metadata badges: favorite, completed, kidgame, broken, manual, …
   *
   * ES-DE lays these out with a flexbox (FlexboxComponent.cpp:104):
   *
   *   grid        = direction "row" ? (itemsPerLine, lines) : (lines, itemsPerLine)
   *   maxItemSize = (size + itemMargin - grid * itemMargin) / grid
   *
   * itemsPerLine defaults to 4 (BadgeComponent.cpp:274) and lines to 1. Icons
   * come from the theme via customBadgeIcon:<slot>; ES-DE also has built-in
   * :/graphics/badge_*.svg fallbacks that we do not ship, so a slot with no
   * theme icon is skipped rather than drawn as an invented glyph.
   */
  drawBadges(ctx, el, b) {
    const game = this.currentGame();
    if (!game || !b.w || !b.h) return;
    const p = el.props;

    // Slots romdeck can actually answer for. Claiming "completed" or "broken"
    // would be inventing metadata we do not track.
    const KNOWN = {
      favorite: () => !!game.meta?.favorite,
      completed: () => game.meta?.completed === true || game.meta?.completed === 'true',
      kidgame: () => game.meta?.kidgame === true || game.meta?.kidgame === 'true',
      broken: () => game.meta?.broken === true || game.meta?.broken === 'true',
      manual: () => !!game.meta?.manual,
    };
    const order = ['favorite', 'completed', 'kidgame', 'broken', 'manual'];
    let wanted = order;
    if (typeof p.slots === 'string' && !/\ball\b/i.test(p.slots)) {
      const want = p.slots.toLowerCase().split(/[\s,]+/).filter(Boolean);
      wanted = order.filter((slot) => want.includes(slot));
    }
    const active = wanted.filter((slot) => KNOWN[slot]?.());
    if (!active.length) return;

    const perLine = Math.max(1, Math.min(10, Number(p.itemsPerLine ?? 4)));
    const lines = Math.max(1, Math.min(10, Number(p.lines ?? 1)));
    const [mx, my] = p.itemMargin ?? [0.01, 0.01];
    const marginX = mx * STAGE_W;
    const marginY = my * STAGE_H;
    const row = (p.direction ?? 'row') === 'row';
    const cols = row ? perLine : lines;
    const rows = row ? lines : perLine;
    const itemW = (b.w + marginX - cols * marginX) / cols;
    const itemH = (b.h + marginY - rows * marginY) / rows;
    const size = Math.max(1, Math.min(itemW, itemH));

    active.forEach((slot, i) => {
      const icon = this.img(this.perSystem(p[`customBadgeIcon:${slot}`]));
      if (!icon) return;                        // no built-in fallbacks shipped
      const col = row ? i % perLine : Math.floor(i / perLine);
      const ln = row ? Math.floor(i / perLine) : i % perLine;
      const x = b.x + col * (itemW + marginX);
      const y = b.y + ln * (itemH + marginY);
      const tint = slot === 'controller' ? p.controllerIconColor : p.badgeIconColor;
      drawContain(ctx, icon, { x, y, w: size, h: size }, tint ? hex(tint) : null, 1);

      // OVERLAY: a second icon sitting on top of the badge -- the controller
      // type on a "controller" badge, the link marker on a folder. Position is
      // a FRACTION of the badge that the overlay is CENTRED on, size is a
      // multiple of the badge's width (FlexboxComponent.cpp:222).
      const overlayKey = slot === 'controller' ? 'controller'
        : slot === 'folderlink' ? 'folderLink' : null;
      if (!overlayKey) return;
      const overlay = this.img(this.perSystem(
        p[`customBadgeIcon:${overlayKey.toLowerCase()}`] ?? p[`customBadgeIcon:${slot}-overlay`]));
      if (!overlay) return;
      const clampN = (v, lo, hi) => Math.max(lo, Math.min(hi, Number(v)));
      const oSize = size * clampN(p[`${overlayKey}Size`] ?? 0.5, 0.1,
        overlayKey === 'controller' ? 2 : 1);
      const [opx, opy] = p[`${overlayKey}Pos`] ?? [0.5, 0.5];
      const ox = x + size * clampN(opx, -1, 2) - oSize / 2;
      const oy = y + size * clampN(opy, -1, 2) - oSize / 2;
      drawContain(ctx, overlay, { x: ox, y: oy, w: oSize, h: oSize },
        p.controllerIconColor ? hex(p.controllerIconColor) : null, 1);
    });
  }


  /**
   * The five-star rating.
   *
   * A theme supplies its OWN star art via <filledPath>/<unfilledPath> (ES-DE's
   * properties, and art-book-next ships SVGs for both). Drawing text stars and
   * ignoring those meant the rating never matched the theme it was rendering
   * in. Text is the fallback for themes that supply no art.
   *
   * The unfilled row draws unconditionally: ES-DE shows an empty five-star
   * rail for an unrated game rather than nothing, which is also what makes the
   * metadata column line up with the icons beneath it.
   */
  drawRating(ctx, el, b) {
    const p = el.props;
    const value = Math.max(0, Math.min(1, Number(this.currentGame()?.meta?.rating ?? 0)));
    // <hideIfZero>: an unrated game shows NO rail rather than five empty stars.
    if (!value && (p.hideIfZero === 'true' || p.hideIfZero === true)) return;
    const filled = this.img(this.perSystem(p.filledPath));
    const unfilled = this.img(this.perSystem(p.unfilledPath));
    const size = b.h || (p.fontSize ?? 0.03) * STAGE_H;

    if (filled || unfilled) {
      // box() offsets by <origin> using the element's own width, which is 0
      // for a rating (its size comes from the star art), so the row has to
      // apply the origin itself against its REAL extent: five stars wide.
      const [ox, oy] = p.origin ?? [0, 0];
      const x0 = b.x - ox * size * 5;
      const y0 = b.y - oy * size;
      // <overlay> (default true, RatingComponent.cpp:24): filled icons draw
      // ON TOP of a full unfilled row. With it off, the unfilled row is
      // clipped away where the filled one covers it -- which matters for
      // semi-transparent icons, where overlapping would double the alpha.
      const overlay = !(p.overlay === 'false' || p.overlay === false);
      const whole = Math.round(value * 5);
      for (let i = 0; i < 5; i++) {
        const showUnfilled = overlay || i >= whole;
        const img = i < whole ? (filled ?? unfilled) : (showUnfilled ? unfilled : null);
        if (!img) continue;
        drawContain(ctx, img, { x: x0 + i * size, y: y0, w: size, h: size },
          p.color ? hex(p.color) : null);
      }
      return;
    }

    if (!value) return;
    ctx.fillStyle = hex(p.color, '#f6ad55');
    ctx.font = fontStack(size);
    ctx.textAlign = 'left';
    const stars = Math.round(value * 5);
    ctx.fillText('★★★★★'.slice(0, stars) + '☆☆☆☆☆'.slice(0, 5 - stars), b.x, b.y + size);
  }

  drawVideo(ctx, el, b) {
    // A snap or its still fallback honours <interpolation> too -- a pixel-art
    // screenshot scaled to a 16:9 plate is exactly the case "nearest" is for.
    const restoreInterp = withInterpolation(ctx, el.props.interpolation
      ?? el.props.imageInterpolation);

    // <delay> holds the STILL image for up to 15s before the video starts
    // (VideoComponent.cpp:325), so a gamelist that is being scrolled through
    // shows covers rather than a burst of half-second video stabs.
    // <fadeInType> black paints a black frame behind the fade; transparent
    // lets whatever is underneath show through.
    const delayMs = Math.max(0, Math.min(15, Number(el.props.delay ?? 0))) * 1000;
    if (delayMs > 0) {
      const since = Date.now() - (this._snapShownAt ?? Date.now());
      if (since < delayMs) {
        if (el.props.fadeInType === 'black') {
          ctx.fillStyle = '#000000';
          ctx.fillRect(b.x, b.y, b.w, b.h);
        }
        const still = this.img(el.props.imageType
          ? this.artFor(el.props.imageType) : this.currentGame()?.art);
        if (still) drawContain(ctx, still, b, null, 1);
        restoreInterp();
        return;
      }
    }
    // A decoded snap frame if one is ready, otherwise the game's static
    // image — which is exactly what ES-DE shows before a snap starts, so the
    // fallback is correct rather than merely safe.
    // <iterationCount> stops the snap after N loops (0 = forever, clamped to
    // 10), and <onIterationsDone> says what to show afterwards: "nothing"
    // leaves the last frame up, "image" falls back to the still. Without this
    // a snap loops for as long as the game stays selected, which on a
    // handheld is a video decoder running until the user moves.
    const iterations = Math.max(0, Math.min(10, Number(el.props.iterationCount ?? 0)));
    const done = iterations > 0 && (this.snap?.loops ?? 0) >= iterations;
    if (done && el.props.onIterationsDone === 'image') {
      const still = this.img(el.props.imageType
        ? this.artFor(el.props.imageType) : this.currentGame()?.art);
      if (still) { drawContain(ctx, still, b, null, 1); restoreInterp(); return; }
    }

    const f = this.snap?.frame;
    if (f) {
      if (!this._snapCanvas || this._snapCanvas.width !== f.width || this._snapCanvas.height !== f.height) {
        this._snapCanvas = createCanvas(f.width, f.height);
        this._snapCtx = this._snapCanvas.getContext('2d');
        this._snapImage = this._snapCtx.createImageData(f.width, f.height);
      }
      this._snapImage.data.set(f.data);
      this._snapCtx.putImageData(this._snapImage, 0, 0);
      pillarbox(ctx, this._snapCanvas, b, el.props);
      drawContain(ctx, this._snapCanvas, b, null, 1);
      restoreInterp();
      return;
    }
    // Honour the element's own imageType for the still fallback, so a video
    // slot asking for a marquee does not fall back to the box art.
    const img = this.img(el.props.imageType
      ? this.artFor(el.props.imageType)
      : this.currentGame()?.art);
    // NO pillarboxes here. ES-DE's black frame belongs to the VIDEO
    // (VideoComponent.cpp:51); the still fallback is a separate
    // mStaticImage that draws without one. Applying it to the still put
    // black bars around every cover in themes that never show video.
    if (img) { drawContain(ctx, img, b, null, 1); restoreInterp(); return; }
    restoreInterp();
    ctx.fillStyle = 'rgba(255,255,255,0.04)';
    ctx.fillRect(b.x, b.y, b.w, b.h);
  }
}

// ── helpers ──────────────────────────────────────────────────────────
/**
 * A date as "3 days ago", ES-DE's <displayRelative>.
 *
 * Wording and the "never" sentinel are its own (DateTimeComponent.cpp:96):
 * unset dates read "never" rather than "56 years ago".
 */
export function relativeDate(value, now = Date.now()) {
  const s = String(value ?? '');
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/.exec(s);
  if (!m) return s;
  if (s.startsWith('19700101')) return 'never';
  const [, Y, mo, d, H, Mi, S] = m;
  const then = Date.UTC(+Y, +mo - 1, +d, +H, +Mi, +S);
  const secs = Math.max(0, Math.floor((now - then) / 1000));
  const plural = (n, unit) => `${n} ${unit}${n === 1 ? '' : 's'} ago`;
  if (secs >= 86400) return plural(Math.floor(secs / 86400), 'day');
  if (secs >= 3600) return plural(Math.floor(secs / 3600), 'hour');
  if (secs >= 60) return plural(Math.floor(secs / 60), 'minute');
  return plural(secs, 'second');
}

/**
 * ES-DE date formatting.
 *
 * Values are stored as %Y%m%dT%H%M%S (MetaData.cpp) and themes print them
 * through a <format> string; DateTimeComponent's default is "%Y-%m-%d" and
 * TimeUtil::timeToString understands %Y %m %d %H %M %S. 19700101T000000 is
 * ES-DE's "unset" sentinel and renders as nothing rather than as 1970.
 */
export function formatDate(value, format = '%Y-%m-%d') {
  const s = String(value ?? '');
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/.exec(s);
  if (!m) return s;                       // already formatted, or not a date
  if (s.startsWith('19700101')) return '';
  const [, Y, mo, d, H, Mi, S] = m;
  return String(format || '%Y-%m-%d')
    .replace(/%Y/g, Y).replace(/%m/g, mo).replace(/%d/g, d)
    .replace(/%H/g, H).replace(/%M/g, Mi).replace(/%S/g, S);
}

function clockText() {
  return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function applyCase(text, letterCase) {
  if (letterCase === 'uppercase') return String(text).toUpperCase();
  if (letterCase === 'lowercase') return String(text).toLowerCase();
  if (letterCase === 'capitalize') {
    return String(text).replace(/\b\w/g, (c) => c.toUpperCase());
  }
  return text;
}

/**
 * Draw an image fitted inside a box, optionally tinted.
 *
 * Tinting replaces the DOM version's CSS mask: an <img> could not inherit
 * currentColor, so the browser needed a mask over a fill. On a canvas it is
 * source-in compositing on a scratch buffer — fewer moving parts.
 */
/**
 * Scale to COVER the box and clip the overflow.
 *
 * The counterpart to drawContain. A carousel item declaring <itemSize>1 1</>
 * is edge-to-edge artwork, and containing it leaves bars where the theme
 * expects none.
 */
/**
 * The black frame behind a video, expanded into pillarboxes/letterboxes.
 *
 * ES-DE fills the unused part of the video AREA with black, but only when the
 * gap is worth filling: narrow bars look worse than none, so it compares the
 * fitted size against the area and skips unless the ratio is under
 * <pillarboxThreshold> (VideoFFmpegComponent.cpp:1095, default 0.85 x / 0.90 y).
 *
 * @returns the rect the media should be drawn into.
 */
function pillarbox(ctx, src, area, props) {
  const scale = Math.min(area.w / src.width, area.h / src.height);
  const w = src.width * scale;
  const h = src.height * scale;
  const fitted = { x: area.x + (area.w - w) / 2, y: area.y + (area.h - h) / 2, w, h };

  const draw = props.pillarboxes === undefined
    ? true                                  // ES-DE's mDrawPillarboxes default
    : !(props.pillarboxes === 'false' || props.pillarboxes === false);
  if (!draw) return fitted;

  const [tx, ty] = props.pillarboxThreshold ?? [0.85, 0.9];
  const thX = Math.max(0.2, Math.min(1, Number(tx)));
  const thY = Math.max(0.2, Math.min(1, Number(ty)));

  let rectW = w;
  let rectH = h;
  if (w > h) {                              // landscape
    if (h < area.h && h / area.h < thY) rectH = area.h;
    if (w < area.w && w / area.w < thX) rectW = area.w;
  } else {                                  // portrait or square
    if (w <= area.w && w / area.w < thX) rectW = area.w;
  }
  if (rectW > w || rectH > h) {
    ctx.fillStyle = '#000000';
    ctx.fillRect(area.x + (area.w - rectW) / 2, area.y + (area.h - rectH) / 2, rectW, rectH);
  }
  return fitted;
}

/**
 * Apply <interpolation> / <imageInterpolation> for one draw.
 *
 * "nearest" is not a stylistic nicety here: pixel art scaled up with linear
 * filtering turns to mush, which is exactly why a retro theme asks for it
 * (ImageComponent.cpp:590). Canvas exposes it as imageSmoothingEnabled, so
 * this IS a still-frame property -- it was misfiled as animation in the audit
 * because of the name.
 *
 * @returns a restore function, so callers cannot leak the setting.
 */
function withInterpolation(ctx, mode) {
  if (mode !== 'nearest' && mode !== 'linear') return () => {};
  const prev = ctx.imageSmoothingEnabled;
  ctx.imageSmoothingEnabled = mode === 'linear';
  return () => { ctx.imageSmoothingEnabled = prev; };
}

function drawCover(ctx, img, b, tint = null) {
  const scale = Math.max(b.w / img.width, b.h / img.height);
  const w = img.width * scale;
  const h = img.height * scale;
  const x = b.x + (b.w - w) / 2;
  const y = b.y + (b.h - h) / 2;
  ctx.save();
  ctx.beginPath();
  ctx.rect(b.x, b.y, b.w, b.h);
  ctx.clip();
  if (!tint) {
    ctx.drawImage(img, x, y, w, h);
  } else {
    ctx.drawImage(tintImage(img, w, h, tint), x, y);
  }
  ctx.restore();
}

function drawContain(ctx, img, b, tint = null, pad = 1) {
  // A theme may set only one dimension (<size>0.2314 0</size>) and expect the
  // other to follow from the image's aspect ratio. Treating the zero as real
  // makes the scale collapse or explode; modern-es-de's selectionBox is
  // exactly this shape.
  const w0 = b.w > 0 ? b.w : (b.h > 0 ? b.h * (img.width / img.height) : img.width);
  const h0 = b.h > 0 ? b.h : (b.w > 0 ? b.w * (img.height / img.width) : img.height);
  b = { x: b.x, y: b.y, w: w0, h: h0 };
  const scale = Math.min((b.w * pad) / img.width, (b.h * pad) / img.height);
  const w = img.width * scale;
  const h = img.height * scale;
  const x = b.x + (b.w - w) / 2;
  const y = b.y + (b.h - h) / 2;
  if (!tint) { ctx.drawImage(img, x, y, w, h); return; }
  ctx.drawImage(tintImage(img, w, h, tint), x, y);
}

/**
 * Apply an ES-DE <color> to an image.
 *
 * ES-DE MULTIPLIES: white leaves the image untouched, and a colour shades it.
 * Compositing with source-in instead replaces every pixel, which turns art
 * into a flat silhouette -- art-book-next tints its system panels ffffffdd
 * (white, slightly transparent, i.e. "unchanged") and every one of them came
 * out grey.
 *
 * A fully-opaque, fully-saturated tint on a SHAPE (an icon, a 1x1 rule) still
 * wants the silhouette behaviour, and multiply gives that for free: a white
 * glyph multiplied by the tint IS the tint.
 */
/**
 * Desaturate an image toward greyscale.
 *
 * <imageSaturation> / <saturation> is 0..1 where 1 is untouched
 * (ImageComponent.cpp:462). Uses the same luminance weights the shader does.
 */
function saturateImage(img, w, h, amount) {
  const buf = createCanvas(Math.max(1, Math.ceil(w)), Math.max(1, Math.ceil(h)));
  const bctx = buf.getContext('2d');
  bctx.drawImage(img, 0, 0, w, h);
  const d = bctx.getImageData(0, 0, buf.width, buf.height);
  const px = d.data;
  for (let i = 0; i < px.length; i += 4) {
    const lum = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
    px[i] = lum + (px[i] - lum) * amount;
    px[i + 1] = lum + (px[i + 1] - lum) * amount;
    px[i + 2] = lum + (px[i + 2] - lum) * amount;
  }
  bctx.putImageData(d, 0, 0);
  return buf;
}

function tintImage(img, w, h, tint) {
  const buf = createCanvas(Math.max(1, Math.ceil(w)), Math.max(1, Math.ceil(h)));
  const bctx = buf.getContext('2d');
  bctx.drawImage(img, 0, 0, w, h);
  bctx.globalCompositeOperation = 'multiply';
  bctx.fillStyle = tint;
  bctx.fillRect(0, 0, w, h);
  // multiply also hits the transparent margin, so restore the alpha channel.
  bctx.globalCompositeOperation = 'destination-in';
  bctx.drawImage(img, 0, 0, w, h);
  return buf;
}

/** Trim to width with an ellipsis, the way text-overflow did in the DOM. */
function ellipsize(ctx, text, maxWidth) {
  const s = String(text);
  if (maxWidth <= 0 || ctx.measureText(s).width <= maxWidth) return s;
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ctx.measureText(`${s.slice(0, mid)}…`).width <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return lo > 0 ? `${s.slice(0, lo)}…` : '';
}

/** Centred word wrap, used where a name has to fit a card. */
function wrapText(ctx, text, cx, cy, maxWidth, lineHeight, maxLines = 2) {
  const words = String(text).split(/\s+/);
  const lines = [];
  let line = '';
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = word;
      if (lines.length === maxLines) break;
    } else {
      line = test;
    }
  }
  if (lines.length < maxLines && line) lines.push(line);
  const startY = cy - ((lines.length - 1) * lineHeight) / 2 + lineHeight * 0.32;
  lines.forEach((l, i) => ctx.fillText(l, cx, startY + i * lineHeight));
}
