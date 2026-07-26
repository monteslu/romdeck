// romdeck's frontend, without a browser.
//
// One plain Node process: SDL window, skia stage, services called directly.
// Games still run in their own crash-isolated player processes — that was
// never the browser's doing and it does not change.
//
// Repaint is EVENT-DRIVEN, not a render loop. The UI is motionless almost
// always, and a frontend that burns a core drawing a static carousel is a
// defect on a handheld. Frames happen when something changed.
import { Stage } from './stage.js';
import { createPresenter, fitRect, STAGE_W, STAGE_H } from './present.js';
import { Services } from './services.js';
import { PadNav } from '../main/gamepad.js';
import { focus } from './focus.js';
import { MenuStack, Keyboard, FileBrowser } from './menus.js';
import { Toasts } from './widgets.js';
import { installMenus } from './app-menus.js';

export class App {
  constructor({ romsDir = null, headless = false } = {}) {
    this.svc = new Services({ romsDir });
    this.stage = new Stage(this.svc);
    this.headless = headless;
    this.window = null;
    this.presenter = null;
    this.padNav = null;
    this.running = false;
    this._dirty = true;
    this._timers = [];
    this.overlay = null; // debug overlay (§11), set by --debug
    this.menus = new MenuStack(this);
    this.keyboard = new Keyboard(this);
    this.browser = new FileBrowser(this);
    this.toasts = new Toasts();
    this.focus = focus;
  }

  toast(title, body = '', opts = {}) {
    this.toasts.push(title, body, opts);
    this.invalidate();
    // Toasts expire on their own, so one wake-up per toast keeps the frame
    // honest without a render loop.
    setTimeout(() => this.invalidate(), (opts.ms ?? 4000) + 50);
  }

  async start() {
    const lib = this.svc.library();
    this.stage.setLibrary(lib.roms);

    const prefs = this.svc.themePrefs();
    const res = await this.stage.setTheme(prefs.theme, {
      variant: prefs.variant,
      colorScheme: prefs.colorScheme,
    });
    if (res.error) throw new Error(`theme: ${res.error}`);

    if (!this.headless) await this._openWindow();
    else this.presenter = await createPresenter({ mode: 'headless' });

    this._startSessions();
    this.running = true;
    this.invalidate();
    return this;
  }

  async _openWindow() {
    const sdl = (await import('@kmamal/sdl')).default;
    const fullscreen = !!this.svc.prefs.get('fullscreen');
    const wantGl = process.env.ROMDECK_GL !== '0';
    const makeWindow = (opengl) => sdl.video.createWindow({
      title: 'romdeck',
      width: 1280,
      height: 720,
      resizable: true,
      fullscreen,
      ...(opengl ? { opengl: true } : {}),
    });

    // A GL context needs a window created FOR gl; asking for one afterwards
    // fails with eglCreateWindowSurface 0x3003. Try the GL window first and
    // fall back to a plain one, so a machine with no usable GL still gets a
    // working UI rather than a black screen.
    this.window = makeWindow(wantGl);
    this.presenter = await createPresenter({ window: this.window });
    if (wantGl && this.presenter.kind !== 'gl') {
      // The GL window is useless to the CPU path (window.render is not
      // available on an opengl window), so swap it for a plain one.
      try { this.window.destroy(); } catch { /* already gone */ }
      this.window = makeWindow(false);
      this.presenter = await createPresenter({ window: this.window, mode: 'cpu' });
    }

    this.window.on('close', () => this.quit());
    this.window.on('resize', () => this.invalidate());
    this.window.on('expose', () => this.invalidate());
    this.window.on('keyDown', (ev) => this._onKey(ev));
    this.window.on('textInput', (ev) => this._onText(ev));

    // Pads drive the UI in-process now; under Electron this had to hop
    // through IPC to reach the renderer.
    this.padNav = new PadNav(
      (ev) => this.dispatch(ev.action),
      {
        onDevices: (info) => {
          for (const key of info.added) {
            const dev = info.devices.find((d) => d.key === key);
            if (dev) this.svc.mappings.noteDevice(dev.key, dev.id);
          }
          // A pad vanishing mid-game is the tripped-over-the-cable case.
          if (info.removed.length) {
            for (const s of this.svc.sessions.list()) {
              if (!s.paused) this.svc.sessions.rpc(s.id, 'pause').catch(() => {});
            }
          }
          this.onDevices?.(info);
          this.invalidate();
        },
        onRaw: (snapshot) => { this.onRaw?.(snapshot); },
      },
    );
    await this.padNav.start();

    // The clock element ticks; nothing else needs a timer.
    this._timers.push(setInterval(() => {
      if (this.stage.elements().some((e) => e.type === 'clock')) this.invalidate();
    }, 20000));
  }

  _startSessions() {
    this.svc.sessions.on('update', (ev) => {
      this.onSession?.(ev);
      if (ev.type === 'closed' || ev.type === 'crashed') this.svc.invalidateLibrary();
      this.invalidate();
    });
  }

  // ── input ──────────────────────────────────────────────────────────
  _onKey(ev) {
    const map = {
      left: 'left', right: 'right', up: 'up', down: 'down',
      return: 'confirm', backspace: 'back', escape: 'back',
      tab: 'menu', space: 'options',
      leftbracket: 'prevSystem', rightbracket: 'nextSystem',
      f11: 'fullscreen',
    };
    const action = map[ev.key];
    if (action) { this.dispatch(action); return; }
    if (ev.key === 'q' && (ev.ctrl || ev.super)) this.quit();
  }

  _onText(ev) {
    this.onText?.(ev.text);
  }

  /**
   * The single action entry point.
   *
   * Pad, keyboard and (later) mouse all arrive here, which is what let the
   * DOM version's focus model stay honest and is why --padonly can drive the
   * real path rather than a parallel one.
   */
  dispatch(action) {
    if (action === 'fullscreen') { this.toggleFullscreen(); return true; }

    // Overlays float above every view and take input FIRST — otherwise `back`
    // inside a menu would navigate the view behind it.
    if (this.keyboard.active || this.browser.active || this.menus.open) {
      const handled = this._navFocus(action);
      this.invalidate();
      return handled;
    }

    if (action === 'menu') { this.openMainMenu(); return true; }
    if (action === 'options') { this.openGameMenu(this.stage.currentGame()); return true; }

    const handled = this.navStage(action);
    this.invalidate();
    return handled;
  }

  /** Focus-ring navigation, shared by every overlay surface. */
  _navFocus(action) {
    if (action === 'confirm') return focus.activate();
    if (action === 'back') return focus.back();
    if ((action === 'left' || action === 'right') && focus.adjustable()) {
      return focus.adjust(action === 'right' ? 1 : -1);
    }
    if (action === 'up') return focus.step(-1);
    if (action === 'down') return focus.step(1);
    if (action === 'left' || action === 'right') return focus.move(action);
    if (action === 'menu') { this.menus.closeAll(); return true; }
    return false;
  }

  /** Default navigation, used until the interaction layer takes over. */
  navStage(action) {
    const st = this.stage;
    if (st.view === 'system') {
      if (action === 'left') { st.sysIndex = (st.sysIndex - 1 + st.systems.length) % st.systems.length; st.gameIndex = 0; return true; }
      if (action === 'right') { st.sysIndex = (st.sysIndex + 1) % st.systems.length; st.gameIndex = 0; return true; }
      if (action === 'confirm') { st.view = 'gamelist'; return true; }
      return false;
    }
    const sys = st.currentSystem();
    const max = (sys?.roms.length ?? 1) - 1;
    // A grid moves by columns vertically; a list moves one at a time.
    const grid = st.elements().find((e) => e.type === 'grid');
    const step = grid
      ? Math.max(1, Math.round((grid.props.size?.[0] ?? 1) / (grid.props.itemSize?.[0] || 0.2)))
      : 1;
    const jump = grid ? 1 : 10;
    if (action === 'up') { st.gameIndex = Math.max(0, st.gameIndex - step); return true; }
    if (action === 'down') { st.gameIndex = Math.min(max, st.gameIndex + step); return true; }
    if (action === 'left' || action === 'prevSystem') { st.gameIndex = Math.max(0, st.gameIndex - jump); return true; }
    if (action === 'right' || action === 'nextSystem') { st.gameIndex = Math.min(max, st.gameIndex + jump); return true; }
    if (action === 'back') { st.view = 'system'; return true; }
    if (action === 'confirm') { this.launchSelected(); return true; }
    return false;
  }

  launchSelected() {
    const game = this.stage.currentGame();
    if (!game) return { error: 'nothing selected' };
    return this.svc.launch(game);
  }

  async toggleFullscreen() {
    if (!this.window) return;
    const on = !this.window.fullscreen;
    this.window.setFullscreen(on);
    this.svc.prefs.set('fullscreen', on);
    this.invalidate();
  }

  // ── painting ───────────────────────────────────────────────────────
  /** Mark the frame stale. Cheap and idempotent; the loop coalesces. */
  invalidate() {
    this._dirty = true;
    if (this.headless) this.render();
    else this._schedule();
  }

  _schedule() {
    if (this._scheduled) return;
    this._scheduled = true;
    setImmediate(() => {
      this._scheduled = false;
      if (this._dirty) this.render();
    });
  }

  render() {
    if (!this.presenter) return null;
    this._dirty = false;
    const canvas = this.stage.paint();
    const ctx = this.stage.ctx;
    // Overlays draw in the order they stack, so a keyboard opened from a menu
    // sits above it.
    this.menus.draw(ctx);
    this.browser.draw(ctx);
    this.keyboard.draw(ctx);
    this.toasts.draw(ctx, { stageW: STAGE_W, stageH: STAGE_H, tokens: this.stage.theme?.desktop ?? {} });
    this.onOverlay?.(ctx);
    this.presenter.present(canvas);
    return canvas;
  }

  /**
   * Start or stop the snap for the current selection.
   *
   * Snaps are decoration: they animate only while a theme asks for one and a
   * game has one, and they stop the moment the selection moves. That keeps
   * the event-driven repaint policy intact — the only thing in the app that
   * schedules continuous frames, and only while it is visible.
   */
  async updateSnap() {
    const wantsVideo = this.stage.elements().some((e) => e.type === 'video');
    const file = wantsVideo ? this.stage.currentGame()?.video : null;
    if (!file) {
      if (this._snapTimer) { clearInterval(this._snapTimer); this._snapTimer = null; }
      this.stage.snap?.close();
      this.stage.snap = null;
      return;
    }
    if (!this.stage.snap) {
      const { SnapPlayer } = await import('./video/player.js');
      this.stage.snap = new SnapPlayer();
    }
    const ok = await this.stage.snap.load(file);
    if (this._snapTimer) { clearInterval(this._snapTimer); this._snapTimer = null; }
    if (!ok) return; // no decoder, or not a container we handle: static image
    this._snapTimer = setInterval(() => {
      if (this.stage.snap?.tick()) this.invalidate();
    }, 33);
    this._timers.push(this._snapTimer);
  }

  /** Reload the library from disk and repaint. */
  async refresh() {
    const lib = this.svc.library({ refresh: true });
    this.stage.setLibrary(lib.roms);
    await this.stage.preload();
    this.invalidate();
    return lib;
  }

  async setTheme(name, opts = {}) {
    const res = await this.stage.setTheme(name, opts);
    this.invalidate();
    return res;
  }

  quit(code = 0) {
    this.running = false;
    for (const t of this._timers) clearInterval(t);
    this._timers = [];
    this.padNav?.stop();
    this.svc.shutdown();
    this.presenter?.destroy?.();
    try { this.window?.destroy(); } catch { /* already gone */ }
    // Give the player processes a moment to take their quit RPC.
    setTimeout(() => process.exit(code), 250);
  }

  /** Map a window pixel back into stage space (mouse support, §15). */
  toStage(px, py) {
    if (!this.window) return { x: px, y: py };
    const r = fitRect(this.window.pixelWidth, this.window.pixelHeight);
    return { x: (px - r.x) / r.scale, y: (py - r.y) / r.scale };
  }
}

// Menu content lives in its own module so app.js stays about the shell.
installMenus(App);
