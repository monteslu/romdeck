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

// ES-DE's per-component default z-index (GuiComponent subclasses set these in
// their constructors). A theme that declares <zIndex> on one element and not
// the rest is relying on exactly these numbers.
const DEFAULT_Z = {
  image: 30,
  video: 30,
  animation: 35,
  badges: 35,
  text: 40,
  datetime: 40,
  gamelistinfo: 40,
  rating: 45,
  textlist: 50,
  carousel: 50,
  grid: 50,
  clock: 55,
  systemstatus: 55,
  helpsystem: 60,
};

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
    this.gameIndex = 0;
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
    if (this.sysIndex >= this.systems.length) {
      this.sysIndex = Math.max(0, this.systems.length - 1);
    }
  }

  search(q) {
    this.query = String(q ?? '').trim().toLowerCase();
    this.gameIndex = 0;
    this.regroup();
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
      case 'cover':
      case 'image':      // ES-DE's generic "the game's image"
      case 'boxcover':
      case 'box2d':
      case 'box3d':      return game.art ?? null;
      case 'video':      return game.video ?? null;
      // Real media types we simply do not scrape. Returning the cover here is
      // worse than returning nothing: it puts a box shot in a logo slot.
      case 'marquee':
      case 'screenshot':
      case 'titlescreen':
      case 'fanart':
      case 'physicalmedia':
      case 'miximage':
      case 'backcover':  return null;
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
    for (const el of this.elements()) {
      // filledPath/unfilledPath are the rating element's star art. Leaving
      // them out meant the first paint had no stars to draw with.
      for (const key of ['path', 'staticImage', 'defaultImage', 'default', 'imagePath',
        'filledPath', 'unfilledPath', 'iconPath']) {
        const v = el.props?.[key];
        if (typeof v !== 'string' || !v) continue;
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
    const z = (el) => el.props.zIndex ?? DEFAULT_Z[el.type] ?? 50;
    const els = [...this.elements()].sort((a, b) => z(a) - z(b));
    for (const el of els) {
      if (el.props.visible === 'false') continue;
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
      case 'text':
      case 'datetime':
      case 'gamelistinfo':
      case 'systemstatus': {
        const key = el.props.metadata ?? el.props.systemdata;
        const text = key
          ? (this.meta(key) || el.props.defaultValue || '')
          : this.bind(el.props.text ?? '');
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
    // scope="menu" is ES-DE's help for its own menu, not a view. scope="none"
    // means DO NOT DISPLAY -- art-book-next declares one to switch the row off
    // for a variant, and drawing it put a second prompt row in the top-left
    // corner on top of the theme's real one.
    if (p.scope === 'menu' || p.scope === 'none') return;
    const entries = this.view === 'gamelist'
      ? [['\u24B6', 'play'], ['\u24B7', 'back'], ['\u24CD', 'options'], ['\u24C2', 'menu']]
      : [['\u2190\u2192', 'system'], ['\u24B6', 'open'], ['\u24C2', 'menu']];

    const size = (p.fontSize ?? 0.022) * STAGE_H * Number(p.entryRelativeScale ?? 1);
    const gap = size * 1.1;
    ctx.font = fontStack(size, { family: p._family ?? null, weight: 700 });
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';

    // <pos> is the anchor and <origin> says which corner of the row it names,
    // so the row has to be measured before it can be placed.
    let width = 0;
    for (const [icon, label] of entries) {
      width += ctx.measureText(`${icon} ${label}`).width + gap;
    }
    width -= gap;
    const [ox, oy] = p.origin ?? [0, 0];
    let x = b.x - ox * width;
    const y = b.y - oy * size + size / 2;

    for (const [icon, label] of entries) {
      ctx.fillStyle = hex(p.iconColor, '#cccccc');
      ctx.fillText(icon, x, y);
      const iw = ctx.measureText(`${icon} `).width;
      ctx.fillStyle = hex(p.textColor, '#cccccc');
      ctx.fillText(label, x + iw, y);
      x += ctx.measureText(`${icon} ${label}`).width + gap;
    }
    ctx.textBaseline = 'alphabetic';
  }

  drawText(ctx, el, b, text) {
    if (!text) return;
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
    const ty = (b.h ? b.y + b.h / 2 : (p.pos?.[1] ?? 0) * STAGE_H) + size * 0.35;
    const shown = applyCase(text, p.letterCase);
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
    drawContain(ctx, img, this.box(p, img), p.color ? hex(p.color) : null);
  }

  drawCarousel(ctx, el, b) {
    const p = el.props;
    if (!this.systems.length) return;
    const count = Math.max(1, Math.min(p.maxItemCount ?? 5, this.systems.length));
    const half = Math.floor(count / 2);
    const gap = (p.itemSpacing ?? 0.02) * STAGE_W;
    const itemW = (b.w - gap * (count - 1)) / count;
    // ES-DE's default itemStacking is CENTERED (CarouselComponent.h): the
    // SELECTED item sits at the middle of the carousel and neighbours flank
    // it, rather than items filling slots left-to-right. Getting this wrong
    // put the theme's own selection box a slot away from the selection.
    const centerX = b.x + b.w / 2;

    for (let off = -half; off <= half; off++) {
      const idx = (this.sysIndex + off + this.systems.length * 2) % this.systems.length;
      const sys = this.systems[idx];
      if (!sys) continue;
      const sel = off === 0;
      const scale = sel ? (p.itemScale ?? 1) : 1;
      const w = itemW * scale;
      // Items sit INSIDE the carousel box rather than filling it, matching
      // .te-caritem's height in the DOM renderer.
      const h = b.h * 0.74 * scale;
      const cx = centerX + off * (itemW + gap) - w / 2;
      const cy = b.y + b.h / 2 - h / 2;

      roundRect(ctx, cx, cy, w, h, 14);
      ctx.fillStyle = hex(sel ? p.selectedColor : p.color, '#1a1f2b');
      ctx.fill();
      if (sel && p.selectorColor) {
        ctx.strokeStyle = hex(p.selectorColor);
        ctx.lineWidth = 4;
        ctx.stroke();
      }

      const url = this.perSystem(p.staticImage ?? p.imagePath ?? p.path, sys);
      let img = this.img(url);
      if (!img) img = this.img(this.perSystem(p.defaultImage, sys));
      if (img) {
        const tint = sel ? (p.imageSelectedColor ?? p.imageColor) : p.imageColor;
        drawContain(ctx, img, { x: cx, y: cy, w, h }, tint ? hex(tint) : null, 0.86);
      } else {
        ctx.fillStyle = hex(p.textColor, '#e8ecf4');
        ctx.font = fontStack(Math.round(h * 0.13));
        ctx.textAlign = 'center';
        wrapText(ctx, sys.name, cx + w / 2, cy + h / 2, w * 0.86, Math.round(h * 0.15));
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
        ctx.fillStyle = hex(p.selectorColor, 'rgba(255,255,255,0.08)');
        ctx.fillRect(selX, y - size * 0.95, Number.isFinite(selW) ? selW : b.w, lh);
      }
      ctx.fillStyle = hex(sel ? (p.selectedColor ?? p.color) : (p.primaryColor ?? p.color), sel ? '#ffffff' : '#8b94a7');
      const label = (sys.roms[i].meta?.favorite ? '★ ' : '') + sys.roms[i].name;
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
    // itemSize is normalized to the STAGE, so columns are stage-width over
    // item-width. A theme that leaves it to an include we did not select
    // still needs sane geometry.
    const [iw, ih] = p.itemSize?.[0] ? p.itemSize : [0.2, 0.42];
    const cols = Math.max(1, Math.round((p.size?.[0] ?? 1) / iw));
    const cellW = b.w / cols;
    const cellH = ih * STAGE_H;
    const rows = Math.max(1, Math.floor(b.h / cellH));
    const perPage = cols * rows;
    const page = Math.floor(this.gameIndex / perPage);
    const start = page * perPage;
    const pad = Math.min(cellW, cellH) * 0.06;

    ctx.save();
    ctx.beginPath();
    ctx.rect(b.x, b.y, b.w, b.h);
    ctx.clip();
    for (let i = start, n = 0; i < sys.roms.length && n < perPage; i++, n++) {
      const game = sys.roms[i];
      const cx = b.x + (n % cols) * cellW + pad;
      const cy = b.y + Math.floor(n / cols) * cellH + pad;
      const cw = cellW - pad * 2;
      const ch = cellH - pad * 2;
      const sel = i === this.gameIndex;

      roundRect(ctx, cx, cy, cw, ch, 8);
      ctx.fillStyle = 'rgba(255,255,255,0.05)';
      ctx.fill();
      const img = this.img(game.art);
      if (img) {
        drawContain(ctx, img, { x: cx, y: cy, w: cw, h: ch }, null, 1);
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

  drawBadges(ctx, el, b) {
    const game = this.currentGame();
    if (!game) return;
    // Only slots romdeck can actually populate. Inventing a value for
    // completed/kidgame/broken would be worse than an empty slot.
    const slots = String(el.props.slots ?? 'favorite')
      .split(',').map((s) => s.trim()).filter(Boolean);
    const active = slots.filter((s) => s === 'favorite' && game.meta?.favorite);
    if (!active.length) return;
    const size = Math.min(b.h || 40, 40);
    let x = b.x;
    let y = b.y;
    for (const slot of active) {
      const icon = this.img(el.props[`customBadgeIcon:${slot}`]);
      if (icon) {
        drawContain(ctx, icon, { x, y, w: size, h: size }, null, 1);
      } else {
        ctx.fillStyle = '#f6ad55';
        ctx.font = fontStack(Math.round(size * 0.8));
        ctx.textAlign = 'center';
        ctx.fillText('★', x + size / 2, y + size * 0.78);
      }
      if (el.props.direction === 'column') y += size * 1.2;
      else x += size * 1.2;
    }
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
      const whole = Math.round(value * 5);
      for (let i = 0; i < 5; i++) {
        const img = i < whole ? (filled ?? unfilled) : (unfilled ?? null);
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
    // A decoded snap frame if one is ready, otherwise the game's static
    // image — which is exactly what ES-DE shows before a snap starts, so the
    // fallback is correct rather than merely safe.
    const f = this.snap?.frame;
    if (f) {
      if (!this._snapCanvas || this._snapCanvas.width !== f.width || this._snapCanvas.height !== f.height) {
        this._snapCanvas = createCanvas(f.width, f.height);
        this._snapCtx = this._snapCanvas.getContext('2d');
        this._snapImage = this._snapCtx.createImageData(f.width, f.height);
      }
      this._snapImage.data.set(f.data);
      this._snapCtx.putImageData(this._snapImage, 0, 0);
      drawContain(ctx, this._snapCanvas, b, null, 1);
      return;
    }
    // Honour the element's own imageType for the still fallback, so a video
    // slot asking for a marquee does not fall back to the box art.
    const img = this.img(el.props.imageType
      ? this.artFor(el.props.imageType)
      : this.currentGame()?.art);
    if (img) { drawContain(ctx, img, b, null, 1); return; }
    ctx.fillStyle = 'rgba(255,255,255,0.04)';
    ctx.fillRect(b.x, b.y, b.w, b.h);
  }
}

// ── helpers ──────────────────────────────────────────────────────────
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
  const buf = createCanvas(Math.max(1, Math.ceil(w)), Math.max(1, Math.ceil(h)));
  const bctx = buf.getContext('2d');
  bctx.drawImage(img, 0, 0, w, h);
  bctx.globalCompositeOperation = 'source-in';
  bctx.fillStyle = tint;
  bctx.fillRect(0, 0, w, h);
  ctx.drawImage(buf, x, y);
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
