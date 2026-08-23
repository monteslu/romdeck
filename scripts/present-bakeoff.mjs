#!/usr/bin/env node
// Present-path bake-off: CPU blit vs GL texture, at 1080p and 4K.
//
// NATIVE-FRONTEND §4 says the GL library choice is a measurement, not a
// doctrine, and §13's M8.4 says record the numbers here. This does that
// rather than asserting one is faster.
//
// What is measured is PRESENT ONLY -- the stage paint is identical either way
// (skia, ~5 ms) and is subtracted out by painting once and presenting many
// times. That is also realistic: the UI repaints on events, so a scroll
// re-presents an unchanged stage far more often than it repaints one.
//
//   node scripts/present-bakeoff.mjs [--windowed]
import { createCanvas } from '@napi-rs/canvas';
import { App } from '../src/ui/app.js';
import { CpuPresenter, STAGE_W, STAGE_H, fitRect } from '../src/ui/present.js';

const N = 60;
const SIZES = [
  ['1080p', 1920, 1080],
  ['1440p', 2560, 1440],
  ['4K', 3840, 2160],
];

const app = new App({ romsDir: process.argv[2] ?? null, headless: true });
await app.start();
const stage = app.stage.paint();
console.log(`stage: ${STAGE_W}x${STAGE_H}, theme ${app.stage.theme.displayName}\n`);

/** A fake window so the CPU path can be measured without a display. */
function fakeWindow(w, h) {
  return {
    pixelWidth: w,
    pixelHeight: h,
    render() { /* the copy under test already happened in _compose */ },
  };
}

console.log('CPU path (skia compose + rgba32 upload)');
const cpuResults = {};
for (const [label, w, h] of SIZES) {
  const p = new CpuPresenter(fakeWindow(w, h));
  p.present(stage); // warm the target allocation
  const t0 = performance.now();
  for (let i = 0; i < N; i++) p.present(stage);
  const ms = (performance.now() - t0) / N;
  cpuResults[label] = ms;
  console.log(`  ${label.padEnd(6)} ${ms.toFixed(2)} ms/present   ${(1000 / ms).toFixed(0)} fps ceiling`);
}

// The GL path needs a real window and a real context, so it only runs when a
// display is available. Reporting "GL is faster" without measuring it would
// be exactly the kind of claim this project keeps getting burned by.
console.log('\nGL path (texSubImage2D + scaled quad)');
let glRan = false;
try {
  const sdl = (await import('@kmamal/sdl')).default;
  const { GlPresenter } = await import('../src/ui/present-gl.js');
  // ONE window and ONE context for every size. Creating a second GLX context
  // against a fresh window fails with BadAccess on X11, and the resolution
  // under test is just a viewport anyway.
  const win = sdl.video.createWindow({
    title: 'bakeoff', width: 1280, height: 720, resizable: true, opengl: true,
  });
  const p = await GlPresenter.create(win);
  console.log(`  (context via ${p.acquiredVia})`);
  for (const [label, w, h] of SIZES) {
    Object.defineProperty(win, 'pixelWidth', { get: () => w, configurable: true });
    Object.defineProperty(win, 'pixelHeight', { get: () => h, configurable: true });
    p.present(stage);
    const t0 = performance.now();
    for (let i = 0; i < N; i++) p.present(stage);
    const ms = (performance.now() - t0) / N;
    glRan = true;
    const cpu = cpuResults[label];
    console.log(`  ${label.padEnd(6)} ${ms.toFixed(2)} ms/present   ${(1000 / ms).toFixed(0)} fps ceiling`
      + `   ${(cpu / ms).toFixed(2)}x vs CPU`);
  }
  p.destroy();
  win.destroy();
} catch (err) {
  console.log(`  unavailable: ${err.message}`);
  console.log('  (needs a display; the CPU path is the fallback and works everywhere)');
}

console.log('\nverdict:');
const worstCpu = Math.max(...Object.values(cpuResults));
if (!glRan) {
  console.log('  GL not measurable here. CPU path stands; it is the default.');
} else {
  console.log('  see the ratios above.');
}
console.log(`  CPU worst case ${worstCpu.toFixed(2)} ms/present`
  + ` -- ${worstCpu < 8 ? 'comfortably under a 120 Hz frame' : worstCpu < 16 ? 'under a 60 Hz frame' : 'ABOVE a 60 Hz frame budget'}`);
console.log('  Repaint is event-driven, so this cost is paid on interaction, not continuously.');

app.dispose();
process.exit(0);
