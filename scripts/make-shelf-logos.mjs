#!/usr/bin/env node
// Generate Shelf's system logos.
//
// Shelf is the BUNDLED theme, so its assets have to be ours: community themes
// carry 20-220 MB of CC-BY-NC-SA console artwork, and none of that is
// redistributable by romdeck (see THEME_CATALOG in themes.js). These are
// typographic wordmarks instead — the system's short name set in a consistent
// typeface, a few hundred bytes each.
//
// They are deliberately NOT imitations of console logos. A real logo is
// trademarked artwork; a name set in a typeface is not, and it gives the
// carousel visual weight without shipping anyone's IP.
//
// GLYPHS ARE OUTLINED AT BUILD TIME, not set as <text>. Using <text> meant the
// letterforms depended on whatever the viewer had installed, so the same
// wordmark rendered differently on every platform. Outlining pins the shapes
// AND ships no font: 34 distinct glyphs become path data, so the runtime cost
// is a handful of KB instead of a 668 KB TTF that would need subsetting.
//
// Regenerate with:  node scripts/make-shelf-logos.mjs
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TTF } from './lib/ttf-glyphs.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, '..', 'themes', 'romdeck-default', 'logos');

// DejaVu Sans Condensed Bold: Bitstream Vera licence — free to use, modify
// and redistribute, including outlined into artwork like this. Condensed
// because system names are long and the cards are wide, not tall.
const FONT_CANDIDATES = [
  '/usr/share/fonts/truetype/dejavu/DejaVuSansCondensed-Bold.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
  '/Library/Fonts/DejaVuSansCondensed-Bold.ttf',
];

// shortname → [top line, bottom line]. Two lines let a long name stay large
// rather than shrinking to fit one; the split is chosen so the eye lands on
// the distinctive word ("SUPER / NINTENDO", "GAME BOY / ADVANCE").
const WORDMARKS = {
  nes: ['NINTENDO', 'ENTERTAINMENT SYSTEM'],
  snes: ['SUPER', 'NINTENDO'],
  gb: ['GAME BOY', ''],
  gbc: ['GAME BOY', 'COLOR'],
  gba: ['GAME BOY', 'ADVANCE'],
  n64: ['NINTENDO', '64'],
  genesis: ['GENESIS', ''],
  mastersystem: ['MASTER', 'SYSTEM'],
  gamegear: ['GAME GEAR', ''],
  'sg-1000': ['SG', '1000'],
  atari2600: ['ATARI', '2600'],
  atari5200: ['ATARI', '5200'],
  atari7800: ['ATARI', '7800'],
  atari800: ['ATARI', '800'],
  atarilynx: ['LYNX', ''],
  pcengine: ['PC ENGINE', ''],
  ngp: ['NEO GEO', 'POCKET'],
  ngpc: ['NEO GEO', 'POCKET COLOR'],
  wonderswan: ['WONDER', 'SWAN'],
  wonderswancolor: ['WONDERSWAN', 'COLOR'],
  colecovision: ['COLECO', 'VISION'],
  vectrex: ['VECTREX', ''],
  zxspectrum: ['ZX', 'SPECTRUM'],
  msx: ['MSX', ''],
  psx: ['PLAY', 'STATION'],
  c64: ['COMMODORE', '64'],
  pico8: ['PICO-8', ''],
  gametank: ['GAME', 'TANK'],
  wasmcart: ['WASM', 'CART'],
  jsgame: ['JS', 'GAME'],
};

const W = 640;
const H = 280;

const PAD = 40;              // breathing room at the edges of the viewBox
const TRACKING = 0.04;       // letter-spacing, as a fraction of font size
const MAX_SIZE = 108;

const fontFile = FONT_CANDIDATES.find((f) => existsSync(f));
if (!fontFile) {
  console.error('no source font found. Install fonts-dejavu-core, or point\n'
    + 'FONT_CANDIDATES at a TTF with a redistributable licence.');
  process.exit(1);
}
const font = new TTF(fontFile);
const em = font.unitsPerEm;
const round = (v) => Math.round(v * 100) / 100;

/** Width of a line at a given size, in SVG units, including tracking. */
function measure(text, size) {
  if (!text) return 0;
  let w = 0;
  for (const ch of text) w += font.advanceOf(ch) / em * size;
  return w + TRACKING * size * Math.max(0, text.length - 1);
}

/**
 * Largest size at which a line fits the usable width.
 *
 * Measured from the font's OWN advance widths rather than estimated from an
 * average character width — the estimate is what clipped "ENTERTAINMENT
 * SYSTEM", twice.
 */
function fitSize(text, max) {
  if (!text) return max;
  const at100 = measure(text, 100);
  return Math.max(18, Math.min(max, Math.floor(100 * (W - PAD * 2) / at100)));
}

/** One line of outlined text, centred on `cx` with its baseline at `y`. */
function line(text, size, cx, y) {
  if (!text) return '';
  let x = cx - measure(text, size) / 2;
  const s = (size / em).toFixed(5);
  const parts = [];
  for (const ch of text) {
    const { path: d, advance } = font.glyphPath(ch);
    // Glyph paths are in font units with Y already flipped; place and scale
    // each one into position.
    if (d) parts.push(`<path transform="translate(${round(x)} ${round(y)}) scale(${s})" d="${d}"/>`);
    x += advance / em * size + TRACKING * size;
  }
  return parts.join('');
}

function svg(top, bottom) {
  // fill="currentColor" so a theme can tint one asset for every colour
  // scheme; the renderer also masks these, which wants a single flat shape.
  let body;
  if (bottom) {
    // Lines are sized independently but capped relative to each other, so a
    // long subtitle ("ENTERTAINMENT SYSTEM") doesn't drag the whole wordmark
    // down to a whisper — it just sets smaller, the way a subtitle should.
    const topSize = fitSize(top, 96);
    const botSize = Math.min(fitSize(bottom, 96), topSize);
    body = line(top, topSize, W / 2, H / 2 - 14)
      + line(bottom, botSize, W / 2, H / 2 + botSize * 0.95 + 8);
  } else {
    const size = fitSize(top, MAX_SIZE);
    body = line(top, size, W / 2, H / 2 + size * 0.36);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" fill="currentColor">`
    + body + '</svg>\n';
}

mkdirSync(OUT, { recursive: true });
let bytes = 0;
for (const [short, [top, bottom]] of Object.entries(WORDMARKS)) {
  const body = svg(top, bottom);
  writeFileSync(path.join(OUT, `${short}.svg`), body);
  bytes += body.length;
}
// A system with no wordmark of its own still gets something rather than a
// blank card. The carousel falls back to the system NAME as text if even this
// is missing, so a generic mark is the middle rung of that ladder.
const fallback = svg('GAMES', '');
writeFileSync(path.join(OUT, '_default.svg'), fallback);
bytes += fallback.length;
console.log(`wrote ${Object.keys(WORDMARKS).length + 1} logos to ${OUT}`);
console.log(`  outlined from ${path.basename(fontFile)} — ${(bytes / 1024).toFixed(1)} KB total, no font shipped`);
