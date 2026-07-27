// In-view menus, the on-screen keyboard, and the file browser.
//
// ES's answer to "how do I configure this from a couch" is a menu opened with
// a button, and that model is unchanged from M7 — only the drawing is. These
// are first-party fixed layouts consuming theme TOKENS (§16e decision 2)
// rather than theme-defined layouts, which is also what ES-DE does for its
// own menus.
//
// The file browser is new and closes a real hole: Electron's
// dialog.showOpenDialog was the last pointer-only surface in the app (ROMs
// folder, .cht import, controller profiles). Losing Electron means losing it,
// which is an improvement.
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { Panel, Widget, ValueWidget } from './widgets.js';
import { focus } from './focus.js';
import { STAGE_W, STAGE_H } from './present.js';
import { hex, fontStack, roundRect } from './stage.js';

let uid = 0;

/**
 * A stack of menus drawn over the stage.
 *
 * Each menu owns a focus group; opening pushes, `back` pops, and the group is
 * deleted on close so a stale empty ring never lingers (a bug M7 found).
 */
export class MenuStack {
  constructor(app) {
    this.app = app;
    this.stack = [];
  }

  get open() { return this.stack.length > 0; }
  get depth() { return this.stack.length; }
  top() { return this.stack[this.stack.length - 1] ?? null; }

  tokens() { return this.app.stage.theme?.desktop ?? {}; }

  /**
   * @param {{title:string, subtitle?:string, items:Array, footer?:string}} spec
   */
  open_(spec) {
    const name = `menu${uid++}`;
    const w = Math.min(720, STAGE_W * 0.42);
    const h = Math.min(STAGE_H * 0.86, 120 + spec.items.length * 70);
    const panel = new Panel({
      x: (STAGE_W - w) / 2,
      y: (STAGE_H - h) / 2,
      w,
      h,
      title: spec.title,
      subtitle: spec.subtitle ?? '',
      footer: spec.footer ?? 'Ⓐ select      Ⓑ back',
    });

    focus.group(name, { onBack: () => this.close(), scrollable: true });
    for (const item of spec.items) {
      const widget = item.options
        ? new ValueWidget({
          x: 0, y: 0, w, h: 60, label: item.label, hint: item.hint ?? '',
          options: item.options, value: item.value, onChange: item.onChange,
        })
        : new Widget({
          x: 0, y: 0, w, h: 60, label: item.label, hint: item.hint ?? '',
          enabled: item.disabled !== true,
          onActivate: () => item.action?.(),
        });
      panel.add(widget);
      if (item.disabled !== true) focus.register(name, widget);
    }

    // A menu whose entries are all disabled (a BIOS table, an empty save-state
    // list) would have an empty ring and no way out but `back`. Give it an
    // explicit exit rather than a dead end.
    //
    // It goes FIRST, not last: a long read-only list scrolls, and an exit
    // appended after 18 disabled rows lands off the visible page — which is
    // an empty ring by another name.
    if (!focus.groups.get(name).items.length) {
      const w2 = new Widget({ x: 0, y: 0, w, h: 60, label: '‹ Back', onActivate: () => this.close() });
      panel.items.unshift(w2);
      focus.register(name, w2);
    }

    this.stack.push({ name, panel, onClose: spec.onClose ?? null });
    // Lay out BEFORE pushing the ring. Widgets start invisible (they have no
    // position until the panel places them), so a group queried before the
    // first paint reports an empty ring — which reads as an unreachable
    // surface to --padonly and, worse, to a user pressing a direction and
    // getting nothing.
    panel.layout(0);
    focus.push(name);
    this.app.invalidate();
    return name;
  }

  close() {
    const entry = this.stack.pop();
    if (!entry) return false;
    if (focus.activeName() === entry.name) focus.pop();
    // Menus are rebuilt on open; leaving the group registered would strand an
    // empty ring and misreport reachability.
    focus.groups.delete(entry.name);
    entry.onClose?.();
    this.app.invalidate();
    return true;
  }

  closeAll() { while (this.stack.length) this.close(); }

  draw(ctx) {
    if (!this.stack.length) return;
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(0, 0, STAGE_W, STAGE_H);
    const tokens = this.tokens();
    for (const entry of this.stack) {
      const g = focus.groups.get(entry.name);
      const live = g?.live() ?? [];
      const focused = live[Math.min(g?.index ?? 0, Math.max(0, live.length - 1))];
      entry.panel.layout(g?.index ?? 0).draw(ctx, { focused, tokens });
    }
  }
}

// ── on-screen keyboard ───────────────────────────────────────────────
// One component, three alphabets (§16e decision 1). Text entry is the hardest
// thing to do with a pad, so search, cheat codes and share codes all use this
// rather than each inventing something.
const LAYOUTS = {
  text: [
    '1234567890'.split(''),
    'qwertyuiop'.split(''),
    'asdfghjkl-'.split(''),
    'zxcvbnm:.\''.split(''),
  ],
  code: [
    '01234567'.split(''),
    '89ABCDEF'.split(''),
    ['-', ':', '+', ' '],
  ],
  // Exactly the base24 alphabet: a character that cannot appear in a real
  // share code cannot be typed.
  base24: [
    '34679A'.split(''),
    'CDEFGH'.split(''),
    'JKMNPR'.split(''),
    'TUVWXY'.split(''),
  ],
};

export class Keyboard {
  constructor(app) {
    this.app = app;
    this.active = false;
    this.value = '';
    this.title = '';
    this.onCommit = null;
    this.onInput = null;
    this.keys = [];
    this.name = 'osk';
  }

  open({ layout = 'text', title = 'Enter text', value = '', onCommit = null, onInput = null } = {}) {
    const rows = LAYOUTS[layout] ?? LAYOUTS.text;
    this.active = true;
    this.value = value;
    this.title = title;
    this.onCommit = onCommit;
    this.onInput = onInput;
    this.keys = [];

    const keyW = 92;
    const keyH = 86;
    const gap = 10;
    const gridW = Math.max(...rows.map((r) => r.length)) * (keyW + gap) - gap;
    const gridH = rows.length * (keyH + gap) - gap;
    const x0 = (STAGE_W - gridW) / 2;
    const y0 = (STAGE_H - gridH) / 2 - 40;

    focus.group(this.name, { onBack: () => this.close() });
    rows.forEach((row, ri) => {
      row.forEach((ch, ci) => {
        const w = new Widget({
          x: x0 + ci * (keyW + gap),
          y: y0 + ri * (keyH + gap),
          w: keyW,
          h: keyH,
          label: ch === ' ' ? '␣' : ch,
          kind: 'key',
          onActivate: () => this.type(ch),
        });
        this.keys.push(w);
        focus.register(this.name, w);
      });
    });

    const actions = [
      ['⌫ Delete', () => { this.value = this.value.slice(0, -1); this._changed(); }],
      ['Clear', () => { this.value = ''; this._changed(); }],
      ...(layout === 'text' ? [['␣ Space', () => this.type(' ')]] : []),
      ['✓ Done', () => { const v = this.value; this.close(); onCommit?.(v); }],
      ['Cancel', () => this.close()],
    ];
    const aw = 190;
    const ax0 = (STAGE_W - (actions.length * (aw + gap) - gap)) / 2;
    actions.forEach(([label, fn], i) => {
      const w = new Widget({
        x: ax0 + i * (aw + gap),
        y: y0 + gridH + 28,
        w: aw,
        h: 74,
        label,
        kind: 'action',
        onActivate: fn,
      });
      this.keys.push(w);
      focus.register(this.name, w);
    });

    focus.push(this.name);
    this.app.invalidate();
  }

  type(ch) {
    this.value += ch;
    this._changed();
  }

  _changed() {
    this.onInput?.(this.value);
    this.app.invalidate();
  }

  close() {
    if (!this.active) return false;
    this.active = false;
    if (focus.activeName() === this.name) focus.pop();
    focus.groups.delete(this.name);
    this.app.invalidate();
    return true;
  }

  draw(ctx) {
    if (!this.active) return;
    const tokens = this.app.stage.theme?.desktop ?? {};
    ctx.fillStyle = 'rgba(0,0,0,0.72)';
    ctx.fillRect(0, 0, STAGE_W, STAGE_H);

    ctx.textAlign = 'center';
    ctx.font = fontStack(22, { weight: 400 });
    ctx.fillStyle = hex(tokens.dim, '#8b94a7');
    ctx.fillText(this.title, STAGE_W / 2, 200);

    const bw = 900;
    const bx = (STAGE_W - bw) / 2;
    roundRect(ctx, bx, 226, bw, 78, 10);
    ctx.fillStyle = hex(tokens.bg, '#0d0f14');
    ctx.fill();
    ctx.strokeStyle = hex(tokens.line, '#262d3d');
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.font = fontStack(34, { weight: 700 });
    ctx.fillStyle = hex(tokens.ink, '#e8ecf4');
    ctx.fillText(this.value || ' ', STAGE_W / 2, 280);

    // An OPAQUE plate behind the keys.
    //
    // Widget.draw fills an unfocused key with rgba(255,255,255,0.03), which is
    // effectively transparent, so whatever is behind the keyboard reads
    // straight through the key caps. A scrim does not fix that: against bright
    // box art the letters on the right-hand half were unreadable, and darkening
    // the scrim enough to hide 400x560 of full-colour artwork would black out
    // the whole screen. The keys need something solid to sit on.
    if (this.keys.length) {
      const pad = 18;
      const x0 = Math.min(...this.keys.map((k) => k.x)) - pad;
      const y0 = Math.min(...this.keys.map((k) => k.y)) - pad;
      const x1 = Math.max(...this.keys.map((k) => k.x + k.w)) + pad;
      const y1 = Math.max(...this.keys.map((k) => k.y + k.h)) + pad;
      roundRect(ctx, x0, y0, x1 - x0, y1 - y0, 14);
      ctx.fillStyle = hex(tokens.bg, '#0d0f14');
      ctx.fill();
      ctx.strokeStyle = hex(tokens.line, '#262d3d');
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    const g = focus.groups.get(this.name);
    const live = g?.live() ?? [];
    const focused = live[Math.min(g?.index ?? 0, Math.max(0, live.length - 1))];
    for (const k of this.keys) {
      k.draw(ctx, { focused: k === focused, tokens });
    }
  }
}

// ── file browser ─────────────────────────────────────────────────────
/**
 * A pad-navigable directory browser.
 *
 * Replaces every Electron OS dialog. Those were the last surfaces in the app
 * a pad could not reach, so this is a feature the port gains rather than a
 * compatibility shim.
 */
export class FileBrowser {
  constructor(app) {
    this.app = app;
    this.active = false;
    this.name = 'browser';
    this.dir = homedir();
    this.panel = null;
    this.mode = 'directory';
    this.filter = null;
    this.onPick = null;
  }

  open({ start = null, mode = 'directory', filter = null, title = null, onPick = null } = {}) {
    this.active = true;
    this.mode = mode;
    this.filter = filter;
    this.onPick = onPick;
    this.title = title ?? (mode === 'directory' ? 'Choose a folder' : 'Choose a file');
    this.dir = start && existsDir(start) ? start : homedir();
    this._build();
    this.panel.layout(0);
    focus.push(this.name);
    this.app.invalidate();
  }

  _build() {
    const w = Math.min(880, STAGE_W * 0.55);
    const h = STAGE_H * 0.8;
    this.panel = new Panel({
      x: (STAGE_W - w) / 2,
      y: (STAGE_H - h) / 2,
      w,
      h,
      title: this.title,
      subtitle: this.dir,
      footer: 'Ⓐ open      Ⓑ back',
    });
    // scrollable, like MenuStack: without it live() filters the ring down to
    // the widgets currently ON SCREEN, so `down` walked to the bottom of the
    // first page and wrapped straight back to the top. Every entry past the
    // first ~10 was unreachable — which in a FOLDER PICKER means the user
    // cannot reach their ROMs at all.
    focus.group(this.name, { onBack: () => this.close(), scrollable: true });

    const add = (label, hint, fn) => {
      const widget = new Widget({ x: 0, y: 0, w, h: 56, label, hint, onActivate: fn });
      this.panel.add(widget);
      focus.register(this.name, widget);
      return widget;
    };

    if (this.mode === 'directory') {
      add('✓ Use this folder', this.dir, () => {
        const chosen = this.dir;
        this.close();
        this.onPick?.(chosen);
      });
    }
    const parent = path.dirname(this.dir);
    if (parent && parent !== this.dir) {
      add('.. up one level', '', () => { this.dir = parent; this._rebuild(); });
    }

    let entries = [];
    try {
      entries = readdirSync(this.dir)
        .filter((e) => !e.startsWith('.'))
        .map((e) => {
          const full = path.join(this.dir, e);
          let dir = false;
          try { dir = statSync(full).isDirectory(); } catch { /* unreadable */ }
          return { name: e, full, dir };
        })
        .filter((e) => e.dir || (this.mode === 'file' && (!this.filter || this.filter.test(e.name))))
        .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1))
        .slice(0, 400);
    } catch {
      add('(cannot read this folder)', '', () => {});
    }

    for (const e of entries) {
      // "/" not an emoji folder glyph: romdeck ships four text fonts and no
      // emoji font, so 📁 rendered as a tofu box on every row of the picker.
      add(e.dir ? `${e.name}/` : e.name, '', () => {
        if (e.dir) { this.dir = e.full; this._rebuild(); }
        else { const f = e.full; this.close(); this.onPick?.(f); }
      });
    }
  }

  _rebuild() {
    const g = focus.groups.get(this.name);
    const wasActive = focus.activeName() === this.name;
    if (wasActive) focus.pop();
    focus.groups.delete(this.name);
    this._build();
    this.panel.layout(0);
    focus.push(this.name);
    this.app.invalidate();
  }

  close() {
    if (!this.active) return false;
    this.active = false;
    if (focus.activeName() === this.name) focus.pop();
    focus.groups.delete(this.name);
    this.app.invalidate();
    return true;
  }

  draw(ctx) {
    if (!this.active) return;
    const tokens = this.app.stage.theme?.desktop ?? {};
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(0, 0, STAGE_W, STAGE_H);
    const g = focus.groups.get(this.name);
    const live = g?.live() ?? [];
    const focused = live[Math.min(g?.index ?? 0, Math.max(0, live.length - 1))];
    this.panel.layout(g?.index ?? 0).draw(ctx, { focused, tokens });
  }
}

function existsDir(p) {
  try { return statSync(p).isDirectory(); } catch { return false; }
}
