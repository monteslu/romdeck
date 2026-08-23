// FocusManager -- one focus ring, ported from the DOM renderer.
//
// The logic is M7's, essentially unchanged: named groups on a stack, so a
// dialog pushes and `back` pops with focus restored; geometric navigation so a
// grid and a toolbar row each behave the way they look; adjustable controls
// that take left/right instead of moving the ring off themselves.
//
// It ports this cleanly because it never really touched the DOM -- it needed a
// bounding box, a visibility test and a way to paint a ring. Canvas widgets
// provide the first two and the third is a stroke.
class FocusGroup {
  constructor(name, opts = {}) {
    const { onBack = null, wrap = true } = opts;
    this.name = name;
    this.items = [];
    this.index = 0;
    this.onBack = onBack;
    this.wrap = wrap;
    // A panel-backed group scrolls, so its ring covers every item rather than
    // only the page currently drawn.
    this.scrollable = opts.scrollable ?? false;
    this._savedIndex = 0;
  }

  add(widget) { this.items.push(widget); return widget; }
  clear() { this.items = []; this.index = 0; }

  /**
   * Focusable items.
   *
   * `visible()` means "on screen right now", which for a scrolling panel is
   * only the current page. The ring must still be able to REACH a row that is
   * scrolled off -- otherwise a menu longer than its panel silently loses its
   * last entries, which is how Quit and Fullscreen became unreachable. So
   * scrollable groups navigate over every item and let the panel follow the
   * focus, rather than the focus being limited to the panel.
   */
  live() {
    if (this.scrollable) return this.items;
    return this.items.filter((w) => w.visible?.() !== false);
  }

  current() {
    const live = this.live();
    if (!live.length) return null;
    return live[Math.max(0, Math.min(this.index, live.length - 1))] ?? null;
  }
}

export class FocusManager {
  constructor() {
    this.stack = [];
    this.groups = new Map();
    this.enabled = true;
    this.stats = { moves: 0, activations: 0, visited: new Set() };
    this.ringFallback = true;
  }

  group(name, opts = {}) {
    let g = this.groups.get(name);
    if (!g) { g = new FocusGroup(name, opts); this.groups.set(name, g); }
    else {
      g.clear();
      if (opts.onBack !== undefined) g.onBack = opts.onBack;
    }
    return g;
  }

  register(groupName, widget) {
    const g = this.groups.get(groupName) ?? this.group(groupName);
    return g.add(widget);
  }

  push(groupName, { index = 0 } = {}) {
    const g = this.groups.get(groupName);
    if (!g) return false;
    const prev = this.active();
    if (prev) prev._savedIndex = prev.index;
    this.stack.push(g);
    g.index = index;
    return true;
  }

  pop() {
    if (this.stack.length <= 1) return false;
    this.stack.pop();
    const now = this.active();
    if (now && now._savedIndex !== undefined) now.index = now._savedIndex;
    return true;
  }

  reset(groupName) {
    this.stack = [];
    return this.push(groupName);
  }

  active() { return this.stack[this.stack.length - 1] ?? null; }
  activeName() { return this.active()?.name ?? null; }
  current() { return this.active()?.current() ?? null; }
  depth() { return this.stack.length; }

  focusIndex(i) {
    const g = this.active();
    if (!g) return;
    const live = g.live();
    if (!live.length) return;
    g.index = Math.max(0, Math.min(i, live.length - 1));
  }

  /** Focus a widget by predicate -- how the checks aim the ring. */
  focusWhere(pred) {
    const g = this.active();
    if (!g) return false;
    const live = g.live();
    const i = live.findIndex(pred);
    if (i < 0) return false;
    g.index = i;
    return true;
  }

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
    this._noteVisited();
    return true;
  }

  /**
   * Nearest widget in the direction of travel.
   *
   * Layout-agnostic on purpose: a grid, a toolbar row and a settings list all
   * behave correctly without describing themselves. Score is distance along
   * the axis, penalised by drift off it, so "down" lands under rather than
   * wherever list order points.
   */
  _geometricNext(live, from, direction) {
    const a = from.rect();
    const ax = a.x + a.width / 2;
    const ay = a.y + a.height / 2;
    const horizontal = direction === 'left' || direction === 'right';
    const sign = direction === 'right' || direction === 'down' ? 1 : -1;

    let best = -1;
    let bestScore = Infinity;
    live.forEach((w, i) => {
      if (w === from) return;
      const r = w.rect();
      const bx = r.x + r.width / 2;
      const by = r.y + r.height / 2;
      const along = horizontal ? (bx - ax) * sign : (by - ay) * sign;
      const across = horizontal ? Math.abs(by - ay) : Math.abs(bx - ax);
      if (along <= 1) return;
      const score = along + across * 2;
      if (score < bestScore) { bestScore = score; best = i; }
    });

    // Nothing that way: fall back to ring order, so a pad can always reach
    // every control even in a layout geometry cannot reason about.
    if (best < 0 && this.ringFallback) {
      const cur = live.indexOf(from);
      return (cur + sign + live.length) % live.length;
    }
    return best;
  }

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
    this._noteVisited();
    return true;
  }

  activate() {
    const g = this.active();
    if (!g || !this.enabled) return false;
    const w = g.current();
    if (!w) return false;
    this.stats.activations++;
    this._noteVisited();
    w.activate?.();
    return true;
  }

  back() {
    const g = this.active();
    if (!g) return false;
    if (g.onBack) { g.onBack(); return true; }
    return this.pop();
  }

  /** True when left/right should change a value instead of moving the ring. */
  adjustable() {
    const w = this.current();
    return !!w && typeof w.adjust === 'function';
  }

  adjust(delta) {
    const w = this.current();
    if (!w || typeof w.adjust !== 'function') return false;
    this.stats.moves++;
    return w.adjust(delta);
  }

  _noteVisited() {
    const w = this.current();
    if (w) this.stats.visited.add(`${this.activeName()}:${w.label || w.kind}`);
  }

  /** Everything reachable right now -- what --padonly asserts against. */
  inventory() {
    return (this.active()?.live() ?? []).map((w) => w.label || w.kind);
  }
}

export const focus = new FocusManager();
