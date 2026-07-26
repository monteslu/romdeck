// FocusManager — one focus ring, three input devices.
//
// The problem this solves (PLAN §16d): romdeck grew 52 `onclick` handlers that
// each assumed a pointer, and no concept of "what is selected right now". A
// gamepad could browse the library and launch a game; every other feature —
// settings, cheats, states, remapping, themes, BIOS, remote play — was
// mouse-gated. On a TV the app was unusable beyond launching whatever happened
// to be on screen.
//
// The model:
//   * Every interactive element registers into a focus GROUP.
//   * Exactly one group is active at a time — a stack, so opening a dialog
//     pushes a group and closing it pops back with focus restored.
//   * Pad, keyboard and mouse all drive the SAME ring. Hover SETS focus rather
//     than bypassing it, so the pointer and the pad can never disagree about
//     what is selected.
//
// Geometry, not DOM order, decides where "down" goes: a grid of tiles and a
// row of toolbar buttons both behave the way they look, without either one
// needing to describe its own layout.

/** A focusable entry: the element plus how to activate it. */
class Focusable {
  constructor(el, { onActivate = null, onFocus = null, group = null } = {}) {
    this.el = el;
    this.onActivate = onActivate;
    this.onFocus = onFocus;
    this.group = group;
  }

  /** Screen rect, used for geometric navigation. */
  rect() {
    return this.el.getBoundingClientRect();
  }

  /** Off-screen or hidden elements are skipped by navigation. */
  visible() {
    const r = this.rect();
    if (r.width <= 0 || r.height <= 0) return false;
    return this.el.offsetParent !== null || this.el === document.body;
  }
}

/** One navigable surface: a screen, a dialog, a menu. */
class FocusGroup {
  constructor(name, { onBack = null, wrap = true } = {}) {
    this.name = name;
    this.items = [];
    this.index = 0;
    this.onBack = onBack;
    this.wrap = wrap;
  }

  add(focusable) {
    focusable.group = this;
    this.items.push(focusable);
    return focusable;
  }

  clear() {
    this.items = [];
    this.index = 0;
  }

  live() {
    return this.items.filter((f) => f.visible());
  }

  current() {
    const live = this.live();
    if (!live.length) return null;
    return live[Math.max(0, Math.min(this.index, live.length - 1))] ?? null;
  }
}

export class FocusManager {
  constructor() {
    this.stack = []; // FocusGroup[] — last is active
    this.groups = new Map(); // name -> FocusGroup
    this.enabled = true;
    this._ringClass = 'focus-ring';
    // Test hook: everything the --padonly self-check needs to assert on.
    this.stats = { moves: 0, activations: 0, visited: new Set() };
  }

  /** Create (or reset) a named group. */
  group(name, opts = {}) {
    let g = this.groups.get(name);
    if (!g) {
      g = new FocusGroup(name, opts);
      this.groups.set(name, g);
    } else {
      g.clear();
      if (opts.onBack !== undefined) g.onBack = opts.onBack;
    }
    return g;
  }

  /**
   * Register an element. Safe to call on elements that already have onclick —
   * the pointer path and the ring converge here rather than competing.
   */
  register(groupName, el, { onActivate = null, onFocus = null } = {}) {
    if (!el) return null;
    const g = this.groups.get(groupName) ?? this.group(groupName);
    // Prefer an explicit handler; fall back to the element's own click path so
    // existing UI keeps working without being rewritten twice.
    const activate = onActivate ?? (() => el.click());
    const f = g.add(new Focusable(el, { onActivate: activate, onFocus }));

    // Hover sets focus instead of bypassing it: the two input models stay in
    // sync, so a mouse user and a pad user see the same selection.
    el.addEventListener('mouseenter', () => {
      if (this.active() !== g) return;
      const live = g.live();
      const i = live.indexOf(f);
      if (i >= 0) this.focusIndex(i, { silent: true });
    });
    // Keep the ring where the pointer clicked.
    el.addEventListener('mousedown', () => {
      if (this.active() !== g) return;
      const live = g.live();
      const i = live.indexOf(f);
      if (i >= 0) g.index = i;
    });
    return f;
  }

  /** Push a group onto the stack and focus its first item. */
  push(groupName, { index = 0 } = {}) {
    const g = this.groups.get(groupName);
    if (!g) return false;
    // Remember where the group below was, so `back` restores it.
    const prev = this.active();
    if (prev) prev._savedIndex = prev.index;
    this.stack.push(g);
    g.index = index;
    this.paint();
    return true;
  }

  /** Pop the active group, restoring focus underneath. */
  pop() {
    if (this.stack.length <= 1) return false;
    const g = this.stack.pop();
    this.unpaint(g);
    const now = this.active();
    if (now && now._savedIndex !== undefined) now.index = now._savedIndex;
    this.paint();
    return true;
  }

  /** Replace the whole stack (used when switching top-level views). */
  reset(groupName) {
    for (const g of this.stack) this.unpaint(g);
    this.stack = [];
    return this.push(groupName);
  }

  active() {
    return this.stack[this.stack.length - 1] ?? null;
  }

  activeName() {
    return this.active()?.name ?? null;
  }

  focusIndex(i, { silent = false } = {}) {
    const g = this.active();
    if (!g) return;
    const live = g.live();
    if (!live.length) return;
    g.index = Math.max(0, Math.min(i, live.length - 1));
    this.paint();
    if (!silent) this.stats.moves++;
  }

  /** Direction is 'up' | 'down' | 'left' | 'right'. */
  move(direction) {
    const g = this.active();
    if (!g || !this.enabled) return false;
    const live = g.live();
    if (live.length < 2) return false;
    const from = live[Math.min(g.index, live.length - 1)];
    const next = this._geometricNext(live, from, direction);
    if (next < 0) return false;
    g.index = next;
    this.stats.moves++;
    this.paint();
    return true;
  }

  /**
   * Pick the nearest element in the requested direction.
   *
   * Layout-agnostic on purpose: a grid, a toolbar row and a vertical settings
   * list all behave correctly without describing themselves. Elements are
   * scored on distance along the axis of travel, penalised by how far they
   * drift off it, so "down" from a tile lands under it rather than wherever
   * DOM order happens to point.
   */
  _geometricNext(live, from, direction) {
    const a = from.rect();
    const ax = a.left + a.width / 2;
    const ay = a.top + a.height / 2;
    const horizontal = direction === 'left' || direction === 'right';
    const sign = direction === 'right' || direction === 'down' ? 1 : -1;

    let best = -1;
    let bestScore = Infinity;
    live.forEach((f, i) => {
      if (f === from) return;
      const r = f.rect();
      const bx = r.left + r.width / 2;
      const by = r.top + r.height / 2;
      const along = horizontal ? (bx - ax) * sign : (by - ay) * sign;
      const across = horizontal ? Math.abs(by - ay) : Math.abs(bx - ax);
      // Must actually lie in the direction of travel. The tolerance lets a
      // slightly-misaligned neighbour still count as "beside" rather than
      // stranding focus on rows that don't line up to the pixel.
      if (along <= 1) return;
      const score = along + across * 2;
      if (score < bestScore) {
        bestScore = score;
        best = i;
      }
    });

    // Nothing in that direction: fall back to ring order so a pad can always
    // reach every control even in layouts geometry can't reason about.
    if (best < 0 && this._ringFallback) {
      const cur = live.indexOf(from);
      const step = sign;
      const n = live.length;
      const wrapped = (cur + step + n) % n;
      return wrapped;
    }
    return best;
  }

  /** Linear ring movement, for lists where geometry is overkill. */
  step(delta) {
    const g = this.active();
    if (!g) return false;
    const live = g.live();
    if (!live.length) return false;
    let i = g.index + delta;
    if (g.wrap) i = (i + live.length) % live.length;
    else i = Math.max(0, Math.min(live.length - 1, i));
    g.index = i;
    this.stats.moves++;
    this.paint();
    return true;
  }

  activate() {
    const g = this.active();
    if (!g || !this.enabled) return false;
    const f = g.current();
    if (!f) return false;
    this.stats.activations++;
    this.stats.visited.add(this._id(f));
    f.onActivate?.();
    return true;
  }

  /**
   * A <select> can't be driven by a d-pad the way a button can: a native
   * dropdown traps the pointer. Cycling its options in place is the behaviour
   * console UIs actually use, and it keeps the ring in charge.
   */
  adjust(delta) {
    const f = this.active()?.current();
    const el = f?.el;
    if (!el) return false;
    if (el.tagName === 'SELECT' && el.options.length) {
      const n = el.options.length;
      el.selectedIndex = (el.selectedIndex + delta + n) % n;
      el.dispatchEvent(new Event('change', { bubbles: true }));
      this.stats.moves++;
      return true;
    }
    if (el.type === 'range') {
      const step = Number(el.step) || 1;
      const next = Number(el.value) + step * delta;
      el.value = String(Math.max(Number(el.min), Math.min(Number(el.max), next)));
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      this.stats.moves++;
      return true;
    }
    return false;
  }

  /** True when left/right should adjust a value instead of moving the ring. */
  adjustable() {
    const el = this.active()?.current()?.el;
    return !!el && (el.tagName === 'SELECT' || el.type === 'range');
  }

  /** `back` walks out of the active group, or runs its escape hatch. */
  back() {
    const g = this.active();
    if (!g) return false;
    if (g.onBack) {
      g.onBack();
      return true;
    }
    return this.pop();
  }

  _id(f) {
    return `${f.group?.name ?? '?'}:${f.el.id || f.el.textContent?.trim().slice(0, 24) || f.el.className}`;
  }

  /** Apply the visual ring to the focused element, clear it everywhere else. */
  paint() {
    for (const g of this.groups.values()) {
      for (const f of g.items) f.el.classList.remove(this._ringClass);
    }
    const g = this.active();
    const f = g?.current();
    if (!f) return;
    f.el.classList.add(this._ringClass);
    this.stats.visited.add(this._id(f));
    f.onFocus?.(f.el);
    // Keep the focused element on screen without yanking the whole page.
    try {
      f.el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    } catch { /* older engines */ }
  }

  unpaint(g) {
    for (const f of g.items) f.el.classList.remove(this._ringClass);
  }

  /** Everything currently reachable — what --padonly asserts against. */
  inventory() {
    const g = this.active();
    if (!g) return [];
    return g.live().map((f) => this._id(f));
  }
}

export const focus = new FocusManager();
// Geometry can't reason about every layout; the ring guarantees reachability.
focus._ringFallback = true;
