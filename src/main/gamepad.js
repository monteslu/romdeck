// Gamepad navigation for the library UI. SDL gamepads (via gamepad-node) polled
// in the main process — the whole reason romdeck exists instead of trusting the
// browser Gamepad API. Emits discrete nav events with edge detection + repeat.
//
// Player processes do their own SDL input; this poller is UI-nav only.
export class PadNav {
  constructor(onEvent) {
    this.onEvent = onEvent;
    this.timer = null;
    this.prev = new Map(); // gamepad index -> pressed-set
    this.repeat = new Map(); // action -> next repeat time
    this.getGamepads = null;
  }

  async start() {
    try {
      const { installNavigatorShim } = await import('gamepad-node');
      const manager = installNavigatorShim();
      this.getGamepads = () => manager.getGamepads();
      this.timer = setInterval(() => this.poll(), 33);
      return true;
    } catch (err) {
      console.warn('padnav: gamepads unavailable (UI still works with keyboard/mouse):', err.message);
      return false;
    }
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  poll() {
    let pads;
    try {
      pads = this.getGamepads();
    } catch {
      return;
    }
    const now = Date.now();
    for (const pad of pads ?? []) {
      if (!pad) continue;
      const held = new Set();
      const b = pad.buttons ?? [];
      const ax = pad.axes ?? [];
      if (b[12]?.pressed || (ax[1] ?? 0) < -0.5) held.add('up');
      if (b[13]?.pressed || (ax[1] ?? 0) > 0.5) held.add('down');
      if (b[14]?.pressed || (ax[0] ?? 0) < -0.5) held.add('left');
      if (b[15]?.pressed || (ax[0] ?? 0) > 0.5) held.add('right');
      if (b[0]?.pressed) held.add('confirm'); // south
      if (b[1]?.pressed) held.add('back');    // east
      if (b[4]?.pressed) held.add('prevSystem'); // LB
      if (b[5]?.pressed) held.add('nextSystem'); // RB
      if (b[9]?.pressed) held.add('confirm'); // start

      const prev = this.prev.get(pad.index) ?? new Set();
      for (const action of held) {
        const isDir = ['up', 'down', 'left', 'right'].includes(action);
        const fresh = !prev.has(action);
        const due = (this.repeat.get(action) ?? 0) <= now;
        if (fresh || (isDir && due)) {
          this.onEvent({ action });
          this.repeat.set(action, now + (fresh ? 350 : 100));
        }
      }
      for (const action of prev) if (!held.has(action)) this.repeat.delete(action);
      this.prev.set(pad.index, held);
    }
  }
}
