// Debug overlay for `--debug`: fps, the focus ring's state, and element boxes.
//
// This draws on top of a finished frame through App.onOverlay, so it can never
// change what the real UI painted -- a debug aid that perturbs layout is worse
// than none. Everything here reads state; nothing mutates it.
//
// Worth knowing why this exists at all: the self-checks are headless and
// assert on model state and pixels, which is exactly what makes them good at
// catching logic errors and blind to "the ring is on a widget nobody can see".
// This is the view for the questions a headless check cannot ask.
import { STAGE_W, STAGE_H } from './present.js';

const PAD = 10;
const LINE = 20;

/**
 * Attach the overlay to an app.
 *
 * @param {import('./app.js').App} app
 */
export function attachOverlay(app) {
  const fps = new FpsMeter();
  app.overlay = { fps };

  app.onOverlay = (ctx) => {
    fps.tick();
    ctx.save();
    drawElementBoxes(ctx, app);
    drawFocusRing(ctx, app);
    drawPanel(ctx, app, fps);
    ctx.restore();
  };

  // Repaint is event-driven, so an idle app would freeze the fps readout at
  // whatever it was when the last event landed. While the overlay is up, keep
  // a slow tick going so the number means something. 4 Hz, not 60: this is a
  // debug readout, and burning a core to animate it would misrepresent the
  // very idle cost the overlay exists to measure.
  const timer = setInterval(() => app.invalidate?.(), 250);
  timer.unref?.();
  app._timers?.push(timer);
}

/** Rolling frame-rate over a short window. */
class FpsMeter {
  constructor() {
    this.times = [];
    this.last = 0;
  }

  tick() {
    const now = performance.now();
    if (this.last) this.times.push(now - this.last);
    this.last = now;
    if (this.times.length > 60) this.times.shift();
  }

  /** Mean frame interval in ms, or null before there are two frames. */
  meanMs() {
    if (!this.times.length) return null;
    return this.times.reduce((a, b) => a + b, 0) / this.times.length;
  }

  fps() {
    const ms = this.meanMs();
    return ms ? 1000 / ms : null;
  }
}

/**
 * Outline every themed element, so a mis-projected box is visible.
 *
 * Elements carry normalized props, not pixels -- stage.box() is what turns
 * one into a rect, and it is the same call the painter makes. Reading a
 * cached rect off the element instead would mean the overlay could disagree
 * with what was actually drawn, which defeats the purpose.
 */
function drawElementBoxes(ctx, app) {
  const stage = app.stage;
  if (!stage) return;
  ctx.lineWidth = 1;
  ctx.font = '11px "romdeck-ui"';
  for (const el of stage.elements()) {
    const r = stage.box(el.props ?? {});
    if (!r || r.w <= 0 || r.h <= 0) continue;
    ctx.strokeStyle = 'rgba(0,255,180,0.55)';
    ctx.strokeRect(r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1);
    if (el.type) {
      ctx.fillStyle = 'rgba(0,255,180,0.85)';
      ctx.fillText(el.type, r.x + 2, Math.max(11, r.y - 2));
    }
  }
}

/** Highlight what the focus ring currently points at. */
function drawFocusRing(ctx, app) {
  const w = app.focus?.current?.();
  // Widgets carry x/y/w/h directly; anything without a width is not drawable.
  if (!w || !(w.w > 0) || !(w.h > 0)) return;
  ctx.strokeStyle = 'rgba(255,64,160,0.95)';
  ctx.lineWidth = 3;
  ctx.strokeRect(w.x - 1.5, w.y - 1.5, w.w + 3, w.h + 3);
}

function drawPanel(ctx, app, fps) {
  const f = app.focus;
  const active = f?.active?.() ?? null;
  const rate = fps.fps();
  const ms = fps.meanMs();

  const lines = [
    `${STAGE_W}x${STAGE_H} stage   present: ${app.presenter?.constructor?.name ?? '-'}`,
    rate ? `${rate.toFixed(1)} fps   ${ms.toFixed(1)} ms/frame   ${app.presenter?.frames ?? 0} frames` : 'measuring…',
    `theme: ${app.stage?.theme?.displayName ?? '-'}   view: ${app.stage?.view ?? '-'}`,
    // With no ring active the themed view is driving, and it navigates by
    // moving sysIndex/gameIndex directly rather than through a focus group.
    // Reporting a bare "(none)" there reads like a bug when it is the design.
    active
      ? `focus: ${f.activeName()} [${active.index + 1}/${active.live().length}]   depth ${f.depth()}`
      : `focus: stage (sys ${app.stage?.sysIndex ?? 0}, game ${app.stage?.gameIndex ?? 0})`,
    `elements: ${app.stage?.elements?.().length ?? 0}   menus: ${app.menus?.depth ?? 0}`,
  ];

  ctx.font = '13px "romdeck-ui"';
  const w = Math.max(...lines.map((l) => ctx.measureText(l).width)) + PAD * 2;
  const h = lines.length * LINE + PAD * 2 - 6;

  ctx.fillStyle = 'rgba(0,0,0,0.72)';
  ctx.fillRect(PAD, PAD, w, h);
  ctx.strokeStyle = 'rgba(255,255,255,0.25)';
  ctx.lineWidth = 1;
  ctx.strokeRect(PAD + 0.5, PAD + 0.5, w - 1, h - 1);

  ctx.fillStyle = '#e8e8e8';
  lines.forEach((l, i) => ctx.fillText(l, PAD * 2, PAD * 2 + i * LINE + 4));
}
