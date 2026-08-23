/**
 * Generate the app icon: a fanned deck of game carts on slate.
 * Deterministic; rerun after design changes and commit the PNGs.
 *
 *   node scripts/make-icon.mjs
 */
import { createCanvas } from '@napi-rs/canvas';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'icon');
mkdirSync(outDir, { recursive: true });

function rounded(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function draw(size) {
  const c = createCanvas(size, size);
  const ctx = c.getContext('2d');
  const u = size / 512;

  // slate plate
  const bg = ctx.createLinearGradient(0, 0, 0, size);
  bg.addColorStop(0, '#232833');
  bg.addColorStop(1, '#151820');
  rounded(ctx, 8 * u, 8 * u, size - 16 * u, size - 16 * u, 96 * u);
  ctx.fillStyle = bg;
  ctx.fill();

  // fanned deck of three carts
  const carts = [
    { rot: -0.20, color: '#3fb68b', dx: -46, dy: 30 },
    { rot: -0.05, color: '#4f8fd0', dx: 0, dy: 6 },
    { rot: 0.12, color: '#d08f4f', dx: 52, dy: 36 },
  ];
  for (const cart of carts) {
    ctx.save();
    ctx.translate(size / 2 + cart.dx * u, size / 2 + cart.dy * u);
    ctx.rotate(cart.rot);
    const w = 210 * u, h = 260 * u;
    ctx.shadowColor = 'rgba(0,0,0,0.45)';
    ctx.shadowBlur = 22 * u;
    ctx.shadowOffsetY = 10 * u;
    rounded(ctx, -w / 2, -h / 2, w, h, 26 * u);
    ctx.fillStyle = cart.color;
    ctx.fill();
    ctx.shadowColor = 'transparent';
    // label window
    rounded(ctx, -w / 2 + 28 * u, -h / 2 + 30 * u, w - 56 * u, h * 0.46, 14 * u);
    ctx.fillStyle = 'rgba(21,24,32,0.85)';
    ctx.fill();
    // grip notches
    ctx.fillStyle = 'rgba(21,24,32,0.35)';
    for (let i = 0; i < 3; i++) {
      rounded(ctx, -w / 2 + 30 * u + i * 52 * u, h / 2 - 52 * u, 36 * u, 22 * u, 8 * u);
      ctx.fill();
    }
    ctx.restore();
  }

  return c.toBuffer('image/png');
}

for (const size of [512, 256, 128]) {
  writeFileSync(join(outDir, `romdeck-${size}.png`), draw(size));
  console.log(`assets/icon/romdeck-${size}.png`);
}
