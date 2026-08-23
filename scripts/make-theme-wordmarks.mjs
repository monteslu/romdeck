/**
 * Generate pixel-block wordmark SVGs for systems the community themes do
 * not cover. rect-only (no <text>): ES-DE renders logos with nanosvg, and
 * romdeck's canvas is happiest the same way. White fill so the theme can
 * recolor via its logo color property.
 *
 *   node scripts/make-theme-wordmarks.mjs
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..',
  'assets', 'theme-supplements', 'art-book-next-es-de', '_inc', 'systems', 'logos');
mkdirSync(outDir, { recursive: true });

// 5x7 block glyphs (same technique as gametank-libretro's gen-logo.py).
const GLYPHS = {
  G: ['01110', '10001', '10000', '10011', '10001', '10001', '01110'],
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  N: ['10001', '11001', '10101', '10101', '10011', '10001', '10001'],
  K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
  W: ['10001', '10001', '10001', '10101', '10101', '10101', '01010'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  C: ['01110', '10001', '10000', '10000', '10000', '10001', '01110'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
};

function wordmark(text, cell = 14, gap = 1, pad = 30) {
  const rects = [];
  let x0 = pad;
  for (const ch of text) {
    const g = GLYPHS[ch];
    if (!g) throw new Error(`no glyph for ${ch}`);
    for (let r = 0; r < g.length; r++) {
      for (let c = 0; c < g[r].length; c++) {
        if (g[r][c] === '1') {
          rects.push(`<rect x="${x0 + c * cell}" y="${pad + r * cell}" width="${cell}" height="${cell}"/>`);
        }
      }
    }
    x0 += (5 + gap) * cell;
  }
  const w = x0 - gap * cell + pad;
  const h = pad * 2 + 7 * cell;
  return `<?xml version="1.0" encoding="utf-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}">\n<g fill="#ffffff">\n${rects.join('\n')}\n</g>\n</svg>\n`;
}

for (const [file, text] of [['gametank.svg', 'GAMETANK'], ['wasmcart.svg', 'WASMCART']]) {
  writeFileSync(join(outDir, file), wordmark(text));
  console.log(join('assets/theme-supplements/art-book-next-es-de/_inc/systems/logos', file));
}
