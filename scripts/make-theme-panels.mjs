/**
 * Compose art-book-next style system panels (454x1080, slanted parallelogram
 * with transparent corners) for the systems the theme does not cover, from
 * screenshots of our own freely licensed homebrew:
 *
 *   gametank: Cubicle Knight (MIT, github.com/GameTankConsole) title + gameplay
 *   wasmcart: Flappy Wyvern (rom-games/wasmcart/wyvern) title-flight scene
 *
 * Captures live in scripts/theme-panel-captures/ (taken through romdev).
 * Geometry matches the theme's own panels, measured from _default.png:
 * content is 340px wide, the left edge slants from x=112 (top) to x=0
 * (bottom).
 *
 *   node scripts/make-theme-panels.mjs
 */
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const capDir = join(repo, 'scripts', 'theme-panel-captures');
const outBase = join(repo, 'assets', 'theme-supplements', 'art-book-next-es-de', '_inc', 'systems');

const W = 454, H = 1080, CONTENT_W = 340, DRIFT = 112;

function shearOnto(content) {
  const c = createCanvas(W, H);
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  // x' = x - (DRIFT/(H-1)) * y + DRIFT maps the 340-wide strip onto the
  // theme's parallelogram exactly.
  ctx.setTransform(1, 0, -DRIFT / (H - 1), 1, DRIFT, 0);
  ctx.drawImage(content, 0, 0);
  return c;
}

function grayscale(canvas) {
  const c = createCanvas(canvas.width, canvas.height);
  const ctx = c.getContext('2d');
  ctx.filter = 'grayscale(1)';
  ctx.drawImage(canvas, 0, 0);
  return c;
}

function writeVariants(short, content) {
  const panel = shearOnto(content);
  const noir = grayscale(panel);
  for (const [variant, canvas] of [
    ['artwork', panel], ['artwork-screenshots', panel], ['artwork-noir', noir],
  ]) {
    const dir = join(outBase, variant);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${short}.png`), canvas.toBuffer('image/png'));
    console.log(join(variant, `${short}.png`));
  }
}

// gametank: three 128x128 scenes stacked, each drawn 360x360 (10px cropped
// per side to fill the 340 width), nearest-neighbor for crisp pixels.
{
  const content = createCanvas(CONTENT_W, H);
  const ctx = content.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  const shots = ['gametank-1.png', 'gametank-2.png', 'gametank-3.png'];
  for (let i = 0; i < shots.length; i++) {
    const img = await loadImage(join(capDir, shots[i]));
    // GameTank's blitter leaves junk in the outermost rows; crop 2px all
    // round so the seams between stacked scenes stay clean.
    ctx.drawImage(img, 2, 2, 124, 124, -10, i * 360, 360, 360);
  }
  writeVariants('gametank', content);
}

// wasmcart: two 340-wide native-resolution crops from one Flappy Wyvern
// frame: the wyvern in the clouds on top, a pipe and the ground below.
{
  const content = createCanvas(CONTENT_W, H);
  const ctx = content.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  const img = await loadImage(join(capDir, 'wyvern-full.png'));
  // y starts below the score HUD text so the sky slice is clean.
  ctx.drawImage(img, 130, 60, CONTENT_W, 540, 0, 0, CONTENT_W, 540);
  ctx.drawImage(img, 530, 180, CONTENT_W, 540, 0, 540, CONTENT_W, 540);
  writeVariants('wasmcart', content);
}
