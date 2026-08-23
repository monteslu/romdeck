#!/usr/bin/env node
// SPIKE: render Shelf's system view with NO ELECTRON.
//
// The question this answers: what is Chromium actually buying romdeck?
//
// The theme engine's layout model is normalized 0-1 coordinates on a fixed
// stage -- that is a projection, not a CSS layout -- so the DOM was never doing
// the hard part. The hard parts were assumed to be text shaping, image decode
// and video. Two of those are solved by @napi-rs/canvas (GlobalFonts +
// loadImage, both already in jsgamelauncher's stack). Video snaps are
// deferred (PLAN 16b) and no theme requires them, so they are out of scope
// here rather than blocking the answer.
//
// This deliberately reuses the REAL ThemeStore -- the same parser that renders
// four community themes in Electron -- so the comparison is honest: same model
// in, different renderer out.
//
//   node scripts/spike-canvas-view.mjs [--headless] [theme] [variant]
import { tmpdir } from 'node:os';
import { createCanvas, loadImage, GlobalFonts } from '@napi-rs/canvas';
import { writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ThemeStore } from '../src/services/themes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HEADLESS = process.argv.includes('--headless');
const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const THEME = args[0] ?? 'slate-es-de';
const VARIANT = args[1] ?? null;

const STAGE_W = 1920;
const STAGE_H = 1080;

// ── the model ────────────────────────────────────────────────────────
// userData themes first so downloaded ones are visible, exactly as the app
// sees them.
const userData = process.env.ROMDECK_USERDATA
  ?? path.join(process.env.HOME, '.config', 'romdeck');
const store = new ThemeStore(userData);
store.dirs = [path.join(__dirname, '..', 'themes'), path.join(userData, 'themes')];

const theme = store.load(THEME, { variant: VARIANT });
console.log(`theme: ${theme.displayName} (${THEME})`);
console.log(`  system view: ${theme.views.system.length} elements`);

// Stand-in library: enough systems to exercise the carousel.
const systems = [
  { name: 'NES', short: 'nes', count: 12 },
  { name: 'SNES', short: 'snes', count: 4 },
  { name: 'Game Boy', short: 'gb', count: 7 },
  { name: 'Game Boy Advance', short: 'gba', count: 5 },
  { name: 'Genesis', short: 'genesis', count: 9 },
];
let sysIndex = 2;

// ── fonts ────────────────────────────────────────────────────────────
// BUNDLED, not borrowed from the host. Canvas does no automatic fallback, so
// a glyph the named family lacks is silently dropped -- that is how the help
// line lost its Ⓐ/Ⓑ/⛶ in the first run of this spike. Naming a system symbol
// font only works on machines that happen to have one, which is not a fix.
// Shipping the faces makes the UI identical everywhere.
const BUNDLED = [
  ['romdeck-ui', 'romdeck-ui.ttf'],
  ['romdeck-ui-bold', 'romdeck-ui-bold.ttf'],
  ['romdeck-symbols', 'romdeck-symbols.ttf'],
];
const fontDir = path.join(__dirname, '..', 'assets', 'fonts');
for (const [family, file] of BUNDLED) {
  const p = path.join(fontDir, file);
  if (existsSync(p)) GlobalFonts.registerFromPath(p, family);
}

// A theme may also ship its OWN faces via <fontPath>; those layer on top.
// Same call, which is the whole point -- jsgamelauncher's fontface.js does
// exactly this and needs no FreeType binding.
const fonts = new Set();
for (const el of theme.views.system) {
  if (typeof el.props.fontPath === 'string') fonts.add(el.props.fontPath);
}
let registered = 0;
for (const url of fonts) {
  const file = assetPath(url);
  if (file && existsSync(file)) {
    GlobalFonts.registerFromPath(file, `theme${registered}`);
    registered++;
  }
}
console.log(`  fonts: ${BUNDLED.length} bundled, ${registered}/${fonts.size} theme-supplied`);

/** romdeck-theme://<name>/<rel> → a real path on disk. */
function assetPath(url) {
  if (typeof url !== 'string' || !url.startsWith('romdeck-theme://')) return null;
  const u = new URL(url);
  return store.resolveAsset(u.host, decodeURIComponent(u.pathname.replace(/^\/+/, '')));
}

const imageCache = new Map();
async function image(url) {
  const file = assetPath(url);
  if (!file || !existsSync(file)) return null;
  if (!imageCache.has(file)) {
    try { imageCache.set(file, await loadImage(file)); }
    catch { imageCache.set(file, null); }
  }
  return imageCache.get(file);
}

// ── rendering ────────────────────────────────────────────────────────
const hex = (c, fallback = '#ffffff') => {
  if (!c) return fallback;
  const s = String(c).replace('#', '');
  if (s.length === 6) return `#${s}`;
  if (s.length === 8) {
    const a = (parseInt(s.slice(6, 8), 16) / 255).toFixed(3);
    return `rgba(${parseInt(s.slice(0, 2), 16)},${parseInt(s.slice(2, 4), 16)},${parseInt(s.slice(4, 6), 16)},${a})`;
  }
  return fallback;
};

/** Element box in stage pixels, honouring pos/size/origin like the DOM does. */
function box(props) {
  const [x, y] = props.pos ?? [0, 0];
  const [w, h] = props.size ?? props.maxSize ?? [0, 0];
  const [ox, oy] = props.origin ?? [0, 0];
  return {
    x: x * STAGE_W - ox * w * STAGE_W,
    y: y * STAGE_H - oy * h * STAGE_H,
    w: w * STAGE_W,
    h: h * STAGE_H,
  };
}

function metaValue(key) {
  const sys = systems[sysIndex];
  switch (key) {
    case 'system.fullName':
    case 'system.fullName.noCollections': return sys.name;
    case 'system.gameCount':
    case 'gamecount': return `${sys.count} games`;
    default: return '';
  }
}

async function drawSystemView(ctx) {
  ctx.clearRect(0, 0, STAGE_W, STAGE_H);
  const els = [...theme.views.system].sort(
    (a, b) => (a.props.zIndex ?? 0) - (b.props.zIndex ?? 0),
  );

  for (const el of els) {
    const p = el.props;
    if (p.visible === 'false') continue;
    const b = box(p);
    ctx.globalAlpha = p.opacity ?? 1;

    if (el.type === 'image') {
      // A tinted 1x1 fill (the box.png idiom) is a rect, same as in the DOM.
      const isFill = p.color && (p.tile === 'true' || /box\.(png|svg)$/i.test(p.path ?? ''));
      if (isFill || (p.color && !p.path)) {
        ctx.fillStyle = hex(p.color);
        ctx.fillRect(b.x, b.y, b.w || STAGE_W, b.h || STAGE_H);
      } else if (p.path) {
        const img = await image(p.path.replace(/\$\{system\.theme\}/g, systems[sysIndex].short));
        if (img) drawContain(ctx, img, b);
      }
    } else if (el.type === 'carousel') {
      await drawCarousel(ctx, el, b);
    } else if (el.type === 'text' || el.type === 'gamelistinfo') {
      const key = p.metadata ?? p.systemdata;
      const text = key ? metaValue(key) : bindText(p.text ?? '');
      if (!text) continue;
      const size = (p.fontSize ?? 0.03) * STAGE_H;
      ctx.fillStyle = hex(p.color, '#e8ecf4');
      ctx.font = `700 ${size}px ${fontFor(p)}`;
      const align = p.horizontalAlignment === 'center' ? 'center'
        : p.horizontalAlignment === 'right' ? 'right' : 'left';
      ctx.textAlign = align;
      // Text elements usually declare no <size>, so their box has zero width
      // and pos IS the anchor -- the same thing the DOM does with left/top plus
      // a translate. Using b.x + b.w/2 unconditionally collapsed centred text
      // to the left edge.
      const tx = b.w
        ? (align === 'center' ? b.x + b.w / 2 : align === 'right' ? b.x + b.w : b.x)
        : (p.pos?.[0] ?? 0) * STAGE_W;
      const ty = (b.h ? b.y + b.h / 2 : (p.pos?.[1] ?? 0) * STAGE_H) + size * 0.35;
      ctx.fillText(text, tx, ty);
    }
    ctx.globalAlpha = 1;
  }
}

/** Font stack: the theme's own face if it ships one, then the bundled ones. */
function fontFor(props) {
  const base = 'romdeck-ui-bold, romdeck-ui, romdeck-symbols';
  return props.fontPath && registered ? `theme0, ${base}` : base;
}

function bindText(text) {
  return String(text).replace(/\$\{([\w.]+)\}/g, (_m, k) => metaValue(k));
}

function drawContain(ctx, img, b) {
  const scale = Math.min(b.w / img.width, b.h / img.height);
  const w = img.width * scale;
  const h = img.height * scale;
  ctx.drawImage(img, b.x + (b.w - w) / 2, b.y + (b.h - h) / 2, w, h);
}

async function drawCarousel(ctx, el, b) {
  const p = el.props;
  const count = Math.min(p.maxItemCount ?? 5, systems.length);
  const half = Math.floor(count / 2);
  const gap = (p.itemSpacing ?? 0.02) * STAGE_W;
  const itemW = (b.w - gap * (count - 1)) / count;

  for (let off = -half, slot = 0; off <= half; off++, slot++) {
    const idx = (sysIndex + off + systems.length * 2) % systems.length;
    const sys = systems[idx];
    const sel = off === 0;
    const x = b.x + slot * (itemW + gap);
    const scale = sel ? (p.itemScale ?? 1) : 1;
    const w = itemW * scale;
    // Items sit inside the carousel box rather than filling it, matching the
    // DOM renderer's .te-caritem height. Filling it made every card a tall
    // slab that read nothing like the Electron build.
    const h = b.h * 0.74 * scale;
    const cx = x + itemW / 2 - w / 2;
    const cy = b.y + b.h / 2 - h / 2;

    roundRect(ctx, cx, cy, w, h, 14);
    ctx.fillStyle = hex(sel ? p.selectedColor : p.color, '#1a1f2b');
    ctx.fill();
    if (sel && p.selectorColor) {
      ctx.strokeStyle = hex(p.selectorColor);
      ctx.lineWidth = 4;
      ctx.stroke();
    }

    // Logos: staticImage with ${system.theme}, tinted per selection -- the
    // CSS-mask trick becomes a composite operation, and is simpler for it.
    const tpl = p.staticImage ?? p.imagePath;
    const img = tpl ? await image(String(tpl).replace(/\$\{system\.theme\}/g, sys.short)) : null;
    if (img) {
      const tint = hex(sel ? (p.imageSelectedColor ?? p.imageColor) : p.imageColor, null);
      drawTinted(ctx, img, { x: cx, y: cy, w, h }, tint);
    } else {
      ctx.fillStyle = hex(p.textColor, '#e8ecf4');
      ctx.font = `700 ${Math.round(h * 0.14)}px ${fontFor(p)}`;
      ctx.textAlign = 'center';
      ctx.fillText(sys.name, cx + w / 2, cy + h / 2);
    }
  }
}

/**
 * Draw a monochrome logo in a theme colour.
 *
 * In the DOM this needed a CSS mask because an <img> cannot inherit
 * currentColor. On a canvas it is source-in compositing on a scratch buffer --
 * fewer moving parts than the browser version.
 */
function drawTinted(ctx, img, b, tint) {
  const pad = 0.86;
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

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// ── run ──────────────────────────────────────────────────────────────
const canvas = createCanvas(STAGE_W, STAGE_H);
const ctx = canvas.getContext('2d');

const t0 = Date.now();
await drawSystemView(ctx);
const firstFrame = Date.now() - t0;

// Steady-state cost, which is what matters for a carousel that animates.
const t1 = Date.now();
const N = 20;
for (let i = 0; i < N; i++) { sysIndex = (sysIndex + 1) % systems.length; await drawSystemView(ctx); }
const perFrame = (Date.now() - t1) / N;
sysIndex = 2;
await drawSystemView(ctx);

writeFileSync(`${tmpdir()}/romdeck-spike-canvas.png`, canvas.toBuffer('image/png'));
console.log(`  first frame: ${firstFrame}ms   steady state: ${perFrame.toFixed(1)}ms/frame`);
console.log('  wrote /tmp/romdeck-spike-canvas.png');

if (HEADLESS) process.exit(0);

// ── the window: same buffer, no browser ──────────────────────────────
const sdl = (await import('@kmamal/sdl')).default;
const win = sdl.video.createWindow({ title: 'romdeck (no Electron)', width: 1280, height: 720, resizable: true });

async function present() {
  await drawSystemView(ctx);
  // fitStage()'s job, done by scaling the blit rather than a CSS transform.
  const out = createCanvas(win.pixelWidth, win.pixelHeight);
  const octx = out.getContext('2d');
  octx.fillStyle = '#000';
  octx.fillRect(0, 0, out.width, out.height);
  const s = Math.min(out.width / STAGE_W, out.height / STAGE_H);
  const w = STAGE_W * s;
  const h = STAGE_H * s;
  octx.drawImage(canvas, (out.width - w) / 2, (out.height - h) / 2, w, h);
  win.render(out.width, out.height, out.width * 4, 'rgba32', Buffer.from(out.data().buffer));
}

// The SAME action vocabulary --padonly injects, so navigation is comparable.
function nav(action) {
  if (action === 'left') sysIndex = (sysIndex - 1 + systems.length) % systems.length;
  else if (action === 'right') sysIndex = (sysIndex + 1) % systems.length;
  else return false;
  return true;
}

win.on('keyDown', (ev) => {
  const map = { left: 'left', right: 'right' };
  if (map[ev.key] && nav(map[ev.key])) present();
  if (ev.key === 'escape' || ev.key === 'q') { win.destroy(); process.exit(0); }
});
win.on('resize', () => present());
win.on('close', () => process.exit(0));

await present();
console.log('\n  ← → to browse, Esc to quit');
