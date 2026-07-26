// Canvas widgets: the surface FocusManager consumes.
//
// A widget is `{ rect(), visible(), draw(ctx), activate() }` — deliberately
// the exact shape the DOM focusables had, so the focus ring, its stack, the
// geometric navigation and the adjustable-control semantics all port from
// focus.js without being rewritten. The ring was the risky part of M7; it is
// the cheap part of M8 precisely because it never touched the DOM for
// anything but a bounding box and a class.
import { hex, roundRect, fontStack } from './stage.js';

export class Widget {
  constructor({ x, y, w, h, label = '', hint = '', onActivate = null, kind = 'button', enabled = true } = {}) {
    Object.assign(this, { x, y, w, h, label, hint, onActivate, kind, enabled });
    this._visible = true;
  }

  rect() { return { x: this.x, y: this.y, width: this.w, height: this.h, left: this.x, top: this.y }; }
  visible() { return this._visible && this.w > 0 && this.h > 0; }
  activate() { if (this.enabled) this.onActivate?.(this); }

  draw(ctx, { focused = false, tokens = {} } = {}) {
    const accent = hex(tokens.accent, '#4fd1c5');
    const panel = hex(tokens.bg2 ?? tokens.panel, '#1a1f2b');
    const ink = hex(tokens.ink, '#e8ecf4');
    const dim = hex(tokens.dim, '#8b94a7');

    roundRect(ctx, this.x, this.y, this.w, this.h, 10);
    ctx.fillStyle = focused ? panel : 'rgba(255,255,255,0.03)';
    ctx.fill();
    if (focused) {
      // One focus style, theme-derived, exactly as the CSS ring was.
      ctx.strokeStyle = accent;
      ctx.lineWidth = 3;
      ctx.stroke();
    }

    const pad = Math.min(18, this.w * 0.06);
    const fs = Math.min(this.h * 0.42, 30);
    ctx.font = fontStack(fs, { weight: focused ? 700 : 600 });
    ctx.textAlign = 'left';
    ctx.fillStyle = this.enabled ? (focused ? ink : dim) : 'rgba(139,148,167,0.5)';
    ctx.fillText(this.label, this.x + pad, this.y + this.h / 2 + fs * 0.35);

    if (this.hint) {
      ctx.textAlign = 'right';
      ctx.font = fontStack(fs * 0.72, { weight: 400 });
      ctx.fillStyle = dim;
      ctx.fillText(this.hint, this.x + this.w - pad, this.y + this.h / 2 + fs * 0.3);
    }
  }
}

/**
 * A value control: a select cycling options, or a boolean toggle.
 *
 * left/right adjust it in place rather than moving the ring off it — the
 * behaviour console UIs use, and the only way a d-pad can set one. A native
 * dropdown could not be driven by a pad at all, which is why the DOM version
 * needed the same special case.
 */
export class ValueWidget extends Widget {
  constructor(opts) {
    super({ ...opts, kind: 'value' });
    this.options = opts.options ?? [];
    this.index = Math.max(0, this.options.findIndex((o) => o.value === opts.value));
    this.onChange = opts.onChange ?? null;
  }

  get value() { return this.options[this.index]?.value; }

  adjust(delta) {
    if (!this.options.length) return false;
    this.index = (this.index + delta + this.options.length) % this.options.length;
    this.onChange?.(this.value, this);
    return true;
  }

  activate() { this.adjust(1); }

  draw(ctx, opts = {}) {
    super.draw(ctx, opts);
    const tokens = opts.tokens ?? {};
    const fs = Math.min(this.h * 0.38, 26);
    ctx.font = fontStack(fs, { weight: 700 });
    ctx.textAlign = 'right';
    ctx.fillStyle = hex(tokens.accent, '#4fd1c5');
    const label = this.options[this.index]?.label ?? '';
    // Chevrons say "this one changes with left/right" without a legend.
    ctx.fillText(`‹ ${label} ›`, this.x + this.w - Math.min(18, this.w * 0.06), this.y + this.h / 2 + fs * 0.35);
  }
}

/**
 * A vertical list of widgets inside a fixed box.
 *
 * Scrolling is an offset rather than scrollIntoView; everything else about
 * how the ring treats it is unchanged.
 */
export class Panel {
  constructor({ x, y, w, h, title = '', subtitle = '', footer = '' } = {}) {
    Object.assign(this, { x, y, w, h, title, subtitle, footer });
    this.items = [];
    this.scroll = 0;
    this.rowH = 62;
    this.gap = 8;
  }

  add(widget) { this.items.push(widget); return widget; }

  /** Lay items out in a column and clamp the scroll to the focused one. */
  layout(focusedIndex = 0) {
    const headH = this.title ? 86 : 16;
    const footH = this.footer ? 46 : 12;
    const viewH = this.h - headH - footH;
    const perPage = Math.max(1, Math.floor(viewH / (this.rowH + this.gap)));
    if (focusedIndex < this.scroll) this.scroll = focusedIndex;
    if (focusedIndex >= this.scroll + perPage) this.scroll = focusedIndex - perPage + 1;
    this.scroll = Math.max(0, Math.min(this.scroll, Math.max(0, this.items.length - perPage)));

    this.items.forEach((w, i) => {
      const row = i - this.scroll;
      w._visible = row >= 0 && row < perPage;
      w.x = this.x + 16;
      w.w = this.w - 32;
      w.h = this.rowH;
      w.y = this.y + headH + row * (this.rowH + this.gap);
    });
    this._perPage = perPage;
    return this;
  }

  draw(ctx, { focused = null, tokens = {} } = {}) {
    const panel = hex(tokens.panel, '#1a1f2b');
    const line = hex(tokens.line, '#262d3d');
    const ink = hex(tokens.ink, '#e8ecf4');
    const dim = hex(tokens.dim, '#8b94a7');

    roundRect(ctx, this.x, this.y, this.w, this.h, 16);
    ctx.fillStyle = panel;
    ctx.fill();
    ctx.strokeStyle = line;
    ctx.lineWidth = 2;
    ctx.stroke();

    if (this.title) {
      ctx.textAlign = 'left';
      ctx.font = fontStack(30, { weight: 700 });
      ctx.fillStyle = ink;
      ctx.fillText(this.title, this.x + 22, this.y + 44);
      if (this.subtitle) {
        ctx.font = fontStack(19, { weight: 400 });
        ctx.fillStyle = dim;
        ctx.fillText(this.subtitle, this.x + 22, this.y + 72);
      }
      ctx.strokeStyle = line;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(this.x + 16, this.y + 84);
      ctx.lineTo(this.x + this.w - 16, this.y + 84);
      ctx.stroke();
    }

    for (const w of this.items) {
      if (w.visible()) w.draw(ctx, { focused: w === focused, tokens });
    }

    // A scroll indicator, because a list that silently continues off the
    // bottom reads as a truncated list.
    if (this.items.length > (this._perPage ?? this.items.length)) {
      ctx.textAlign = 'right';
      ctx.font = fontStack(17, { weight: 400 });
      ctx.fillStyle = dim;
      const shown = Math.min(this.items.length, this.scroll + this._perPage);
      ctx.fillText(`${this.scroll + 1}–${shown} of ${this.items.length}`,
        this.x + this.w - 22, this.y + this.h - 18);
    }

    if (this.footer) {
      ctx.textAlign = 'left';
      ctx.font = fontStack(18, { weight: 400 });
      ctx.fillStyle = dim;
      ctx.fillText(this.footer, this.x + 22, this.y + this.h - 18);
    }
  }
}

/** Toast notifications, drawn over everything. */
export class Toasts {
  constructor() { this.items = []; }

  push(title, body = '', { error = false, ms = 4000 } = {}) {
    const t = { title, body, error, until: Date.now() + ms };
    this.items.push(t);
    if (this.items.length > 4) this.items.shift();
    return t;
  }

  prune() {
    const now = Date.now();
    const before = this.items.length;
    this.items = this.items.filter((t) => t.until > now);
    return this.items.length !== before;
  }

  draw(ctx, { stageW, stageH, tokens = {} }) {
    this.prune();
    if (!this.items.length) return;
    const w = 520;
    const h = 92;
    let y = stageH - 40 - h;
    for (const t of [...this.items].reverse()) {
      const x = stageW - 40 - w;
      roundRect(ctx, x, y, w, h, 12);
      ctx.fillStyle = hex(tokens.panel, '#1a1f2b');
      ctx.fill();
      ctx.fillStyle = t.error ? hex(tokens.danger, '#fc8181') : hex(tokens.accent, '#4fd1c5');
      ctx.fillRect(x, y + 8, 5, h - 16);
      ctx.textAlign = 'left';
      ctx.font = fontStack(23, { weight: 700 });
      ctx.fillStyle = hex(tokens.ink, '#e8ecf4');
      ctx.fillText(t.title, x + 22, y + 38);
      if (t.body) {
        ctx.font = fontStack(19, { weight: 400 });
        ctx.fillStyle = hex(tokens.dim, '#8b94a7');
        ctx.fillText(String(t.body).split('\n')[0].slice(0, 52), x + 22, y + 66);
      }
      y -= h + 10;
    }
  }
}
