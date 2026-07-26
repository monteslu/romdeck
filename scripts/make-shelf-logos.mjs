#!/usr/bin/env node
// Generate Shelf's system logos.
//
// Shelf is the BUNDLED theme, so its assets have to be ours: community themes
// carry 20-220 MB of CC-BY-NC-SA console artwork, and none of that is
// redistributable by romdeck (see THEME_CATALOG in themes.js). These are
// typographic wordmarks instead — the system's short name set in the theme's
// own style, drawn as SVG text, a few hundred bytes each.
//
// They are deliberately NOT imitations of console logos. A real logo is
// trademarked artwork; a name set in a typeface is not, and it gives the
// carousel something with visual weight without shipping anyone's IP.
//
// Regenerate with:  node scripts/make-shelf-logos.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, '..', 'themes', 'romdeck-default', 'logos');

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

const PAD = 40;          // breathing room at the edges of the viewBox
const LETTER_SPACING = 2;

/**
 * Size the type so the longest line fits inside the box.
 *
 * The 0.62 is the approximate advance width of a bold sans capital as a
 * fraction of its font size. Letter-spacing has to be counted separately —
 * leaving it out is what clipped "ENTERTAINMENT SYSTEM" at both ends.
 */
function fontSizeFor(text, max) {
  const n = text.length || 1;
  const usable = W - PAD * 2 - LETTER_SPACING * n;
  // Floor, not round: rounding up by one pixel is enough to clip a long line.
  return Math.max(24, Math.floor(Math.min(max, usable / (n * 0.62))));
}

function svg(top, bottom) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  // currentColor: the theme tints these with <color>, so one asset serves
  // every colour scheme instead of shipping a copy per palette.
  const lines = [];
  if (bottom) {
    const s1 = fontSizeFor(top, 96);
    const s2 = fontSizeFor(bottom, 96);
    lines.push(
      `  <text x="${W / 2}" y="${H / 2 - 12}" font-size="${s1}" ${'font-family="Segoe UI, system-ui, sans-serif"'}`
      + ` font-weight="700" letter-spacing="2" text-anchor="middle" fill="currentColor">${esc(top)}</text>`,
      `  <text x="${W / 2}" y="${H / 2 + 78}" font-size="${s2}" font-family="Segoe UI, system-ui, sans-serif"`
      + ` font-weight="700" letter-spacing="2" text-anchor="middle" fill="currentColor">${esc(bottom)}</text>`,
    );
  } else {
    const s = fontSizeFor(top, 110);
    lines.push(
      `  <text x="${W / 2}" y="${H / 2 + 28}" font-size="${s}" font-family="Segoe UI, system-ui, sans-serif"`
      + ` font-weight="700" letter-spacing="2" text-anchor="middle" fill="currentColor">${esc(top)}</text>`,
    );
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">\n`
    + `${lines.join('\n')}\n</svg>\n`;
}

mkdirSync(OUT, { recursive: true });
let bytes = 0;
for (const [short, [top, bottom]] of Object.entries(WORDMARKS)) {
  const body = svg(top, bottom);
  writeFileSync(path.join(OUT, `${short}.svg`), body);
  bytes += body.length;
}
// A system with no wordmark of its own still gets something rather than a
// blank card; the carousel falls back to the system NAME as text if even
// this is missing.
writeFileSync(path.join(OUT, '_default.svg'), svg('', ''));
console.log(`wrote ${Object.keys(WORDMARKS).length + 1} logos to ${OUT} (${(bytes / 1024).toFixed(1)} KB)`);
