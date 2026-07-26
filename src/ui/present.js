// The present seam: how a finished stage canvas reaches a screen (or a file).
//
// One interface, three implementations, chosen at startup:
//
//   cpu       skia buffer -> window.render()          (works everywhere)
//   gl        skia buffer -> texture -> scaled quad   (M8.4)
//   headless  skia buffer -> PNG on disk              (self-checks, CI)
//
// The headless presenter is why romdeck's render checks need NO DISPLAY at
// all. Under Electron they needed an X server, which on this machine meant
// hunting Xwayland's auth cookie; that entire class of environment problem
// disappears when a "screenshot" is just canvas.toBuffer().
//
// Scaling lives here rather than in the renderer because it is the only thing
// that differs between a window and a file: the stage is always drawn at its
// design size (1920x1080) and fitted at present time, which is what made the
// DOM version resolution-independent and keeps this one honest.
import { createCanvas } from '@napi-rs/canvas';
import { writeFileSync } from 'node:fs';

export const STAGE_W = 1920;
export const STAGE_H = 1080;

/**
 * Letterbox geometry for a stage inside a target, preserving aspect.
 * Exported because the input layer needs it to map pointer coordinates back
 * into stage space.
 */
export function fitRect(targetW, targetH, stageW = STAGE_W, stageH = STAGE_H) {
  const scale = Math.min(targetW / stageW, targetH / stageH);
  const w = stageW * scale;
  const h = stageH * scale;
  return { x: (targetW - w) / 2, y: (targetH - h) / 2, w, h, scale };
}

class BasePresenter {
  constructor() {
    this._out = null;
    this._outCtx = null;
    this.frames = 0;
  }

  /** A reusable target canvas; reallocating one per frame would churn. */
  _target(w, h) {
    if (!this._out || this._out.width !== w || this._out.height !== h) {
      this._out = createCanvas(w, h);
      this._outCtx = this._out.getContext('2d');
    }
    return this._outCtx;
  }

  /** Draw the stage letterboxed into a target of the given size. */
  _compose(stage, w, h) {
    const ctx = this._target(w, h);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);
    const r = fitRect(w, h);
    ctx.drawImage(stage, r.x, r.y, r.w, r.h);
    return this._out;
  }
}

/**
 * CPU presenter: skia buffer straight into the SDL window.
 *
 * This is jsgamelauncher's shipping path — window.render() with an rgba32
 * buffer — so it is proven on desktops and on knulli handhelds.
 */
export class CpuPresenter extends BasePresenter {
  constructor(window) {
    super();
    this.window = window;
    this.kind = 'cpu';
  }

  present(stage) {
    const w = this.window.pixelWidth;
    const h = this.window.pixelHeight;
    // pixelWidth, not width: on a HiDPI display they differ, and using the
    // logical size renders a soft, half-resolution UI.
    const out = this._compose(stage, w, h);
    this.window.render(w, h, w * 4, 'rgba32', Buffer.from(out.data().buffer));
    this.frames++;
  }

  destroy() {}
}

/**
 * Headless presenter: writes PNGs instead of pixels on a screen.
 *
 * Same composition path as the real one, so a screenshot in CI is the same
 * image a user would see, letterboxing included.
 */
export class HeadlessPresenter extends BasePresenter {
  constructor({ width = STAGE_W, height = STAGE_H } = {}) {
    super();
    this.width = width;
    this.height = height;
    this.kind = 'headless';
    this.last = null;
  }

  present(stage) {
    this.last = this._compose(stage, this.width, this.height);
    this.frames++;
  }

  /** Write the most recent frame. Presents first if nothing is buffered. */
  write(file, stage = null) {
    if (!this.last && stage) this.present(stage);
    if (!this.last) throw new Error('nothing presented yet');
    writeFileSync(file, this.last.toBuffer('image/png'));
    return file;
  }

  destroy() {}
}

/**
 * Choose a presenter.
 *
 * `mode` is 'auto' | 'cpu' | 'gl' | 'headless'. GL lands in M8.4 behind this
 * same call, so nothing upstream changes when it does.
 */
export async function createPresenter({ window = null, mode = 'auto' } = {}) {
  if (mode === 'headless' || !window) return new HeadlessPresenter();
  // GL is the DEFAULT, because the bake-off settled it rather than taste:
  // the CPU blit is ~1.6 ms at 1080p but 25 ms at 4K (it copies the whole
  // stage per frame), while GL is flat at ~1.6 ms everywhere because the GPU
  // does the scaling. 15x at 4K, and above a 60 Hz budget on CPU.
  // ROMDECK_GL=0 forces the CPU path for debugging.
  if (mode === 'cpu' || process.env.ROMDECK_GL === '0') return new CpuPresenter(window);
  if (mode === 'gl' || mode === 'auto') {
    try {
      const { GlPresenter } = await import('./present-gl.js');
      return await GlPresenter.create(window);
    } catch (err) {
      // A missing or broken GL stack must degrade to a working UI, never to
      // a black screen.
      console.warn(`GL present unavailable (${err.message}); using CPU`);
    }
  }
  return new CpuPresenter(window);
}
