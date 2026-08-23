// romdeck's frontend, without a browser.
//
// One plain Node process: SDL window, skia stage, services called directly.
// Games still run in their own crash-isolated player processes -- that was
// never the browser's doing and it does not change.
//
// Repaint is EVENT-DRIVEN, not a render loop. The UI is motionless almost
// always, and a frontend that burns a core drawing a static carousel is a
// defect on a handheld. Frames happen when something changed.
import { Stage } from './stage.js';
import { createPresenter, fitRect, STAGE_W, STAGE_H } from './present.js';
import { Services } from './services.js';
import { PadNav } from '../services/gamepad.js';
import { focus } from './focus.js';
import { MenuStack, Keyboard, FileBrowser } from './menus.js';
import { Toasts } from './widgets.js';
import { installMenus } from './app-menus.js';

export class App {
  constructor({ romsDir = null, headless = false } = {}) {
    this.svc = new Services({ romsDir });
    this.stage = new Stage(this.svc);
    // Art is fetched lazily on a cache miss (see Stage.img), so a late arrival
    // has to ask for the repaint that shows it. Without this the cover appears
    // only on the next unrelated input.
    this.stage.onImageLoaded = () => this.invalidate();
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

    // romdeck bundles no theme, so on a first run there is nothing on disk to
    // render at all. Fetch the default (Slate, ~20 MB) BEFORE the first
    // setTheme, or the app starts with no artwork and no way to have any.
    //
    // This never throws: being offline on first run is a real situation, and
    // the answer to it is a sentence on screen, not a failed launch. themeError
    // carries it so the stage can say so.
    this.themeError = null;
    const boot = await this.svc.ensureDefaultTheme((line) => {
      this.bootProgress = line;
      this.invalidate();
    });
    this.bootProgress = null;
    if (boot?.error) this.themeError = boot.error;
    this.stage.themeError = this.themeError;

    const prefs = this.svc.themePrefs();
    const res = await this.stage.setTheme(prefs.theme, {
      variant: prefs.variant,
      colorScheme: prefs.colorScheme,
    });
    // A missing theme is no longer fatal -- with nothing bundled it is the
    // expected state of a first run that could not reach the network. Record
    // it and start anyway, so the user gets a window that explains itself.
    if (res.error) this.themeError = this.themeError ?? res.error;
    this.stage.themeError = this.themeError;

    if (!this.headless) await this._openWindow();
    else this.presenter = await createPresenter({ mode: 'headless' });

    this._startSessions();
    this.running = true;
    this.invalidate();

    // FIRST RUN: no ROMs folder has ever been chosen, so there is no library
    // and every themed element resolves to nothing. Without this the app
    // opens on a black screen with a help bar -- no library, no error, no
    // instruction, and no way to guess that the fix is behind Start › Choose
    // ROMs folder. Ask for the folder instead of waiting to be asked.
    //
    // Only when the folder was never SET. A configured folder that is empty
    // or has gone missing is a different situation: the stage says so (see
    // Stage.drawEmptyState) and the user keeps control of the app.
    if (!this.headless && !this.svc.romsDir()) {
      this.openRomsFolderPicker();
      this.invalidate();
    }
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
      if (ev.type === 'achievement') this._onAchievement(ev);
      if (ev.type === 'ready') this._armAchievements(ev).catch(() => { /* optional feature */ });
      this.invalidate();
    });
  }

  /**
   * Arm the achievement evaluator for a session that just came up.
   *
   * The split is deliberate: the FRONTEND fetches definitions, because it owns
   * the RetroAchievements credentials, and the PLAYER evaluates them, because
   * it owns the emulation loop and the memory. The player never sees an API
   * key and never makes a network call for this.
   *
   * Entirely best-effort. No credentials, no network, an unrecognised game or
   * an evaluator that was never built all mean "no achievements this session",
   * never a failed launch.
   */
  async _armAchievements(ev) {
    const rom = this.svc.findRom(ev.romPath);
    if (!rom || !this.svc.ra.configured()) return;
    const caps = (await this.svc.sessions.rpc(ev.id, 'getStatus')).capabilities ?? {};
    if (!caps.achievements) return;

    const defs = await this.svc.ra.runtimeAchievements(rom);
    if (!defs?.length) return;
    const res = await this.svc.sessions.rpc(ev.id, 'cheevosActivate', { achievements: defs });
    if (res?.activated) {
      this.toast('Achievements active', `${res.activated} tracked`, { ms: 3000 });
    }
  }

  /** An achievement fired in the player. Award it and tell the player so. */
  async _onAchievement(ev) {
    this.toast('Achievement unlocked', ev.title ?? `#${ev.achievementId}`, { ms: 6000 });
    // Submitting is the frontend's job and must never take the session down.
    // It also must not silently claim success: an unlock that did not reach
    // the site is a different thing from one that did, and the player is
    // entitled to know which happened.
    try {
      const res = await this.svc.ra.award(ev.rom, ev.achievementId);
      if (res.status === 'ok') {
        if (res.score != null) this.toast('Submitted', `${res.score} points`, { ms: 4000 });
      } else if (res.status === 'no-token') {
        this.toast('Not submitted', 'sign in to RetroAchievements first', { error: true });
      } else if (res.status !== 'not-configured') {
        this.toast('Not submitted', res.message ?? res.status, { error: true });
      }
    } catch (err) {
      this.toast('Not submitted', err.message, { error: true });
    }
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

    // Overlays float above every view and take input FIRST -- otherwise `back`
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
      if (action === 'left' || action === 'right') {
        const from = st.sysIndex;
        st.sysIndex = action === 'left'
          ? (st.sysIndex - 1 + st.systems.length) % st.systems.length
          : (st.sysIndex + 1) % st.systems.length;
        st.gameIndex = 0;
        // Repeated presses inside the animation window mean the user is
        // scrolling fast, so the slide shortens rather than queueing up.
        // <fastScrolling> picks the scroll TIER: holding a direction
        // accelerates through 500/180/80ms per item instead of 500/200
        // (IList.h:60). The held duration decides which tier applies.
        const now = Date.now();
        const gap = now - (this._lastNav ?? 0);
        const held = gap < 400 ? (this._heldMs ?? 0) + gap : 0;
        this._heldMs = held;
        this._lastNav = now;
        const car = st.elements().find((e) => e.type === 'carousel');
        const fastTier = car?.props.fastScrolling === 'true'
          || car?.props.fastScrolling === true;
        const fast = st.scrollInterval(held, fastTier) < 300;
        if (!this.headless && st.startCarouselSlide(from, fast)) this.startCarouselTimer();
        return true;
      }
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
    // Animation timers are (re)evaluated on the frame after a selection or
    // view change, which is the only thing that can start or stop them.
    // updateSnap had NO callers at all -- video snaps never started in the
    // real app, only in the check that drove them by hand.
    if (this._animKey !== this._animState()) {
      this._animKey = this._animState();
      this.stage.markSnapDelay();
      this.updateSnap?.();
      this.updateScroll?.();
    }
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
   * Drive scrolling containers.
   *
   * Same contract as the snap timer: this runs ONLY while something is
   * actually scrolling, and stops the moment nothing is. The event-driven
   * repaint policy is the reason an idle library costs no CPU, and a
   * permanent 30 Hz animation loop would quietly undo it -- on a handheld
   * that is battery, not just cycles.
   */
  /**
   * Drive the carousel slide.
   *
   * Third and last animation timer, same contract as the other two: it exists
   * only while something moves and clears itself the moment it settles. A
   * carousel that kept a 30 Hz timer after the slide finished would be a
   * render loop wearing a different hat.
   */
  startCarouselTimer() {
    if (this._carouselTimer) return;
    let last = Date.now();
    this._carouselTimer = setInterval(() => {
      const now = Date.now();
      const dt = now - last;
      last = now;
      if (this.stage.tickCarousel(dt)) {
        this.invalidate();
      } else {
        clearInterval(this._carouselTimer);
        this._carouselTimer = null;
      }
    }, 16);
    this._timers.push(this._carouselTimer);
  }

  /** What the animation timers depend on: which game, in which view. */
  _animState() {
    return `${this.stage.view}:${this.stage.sysIndex}:${this.stage.gameIndex}`;
  }

  updateScroll() {
    const wants = this.stage.elements().some((e) => {
      const p = e.props;
      if (e.type === 'textlist'
        && (p.textHorizontalScrolling === 'true' || p.textHorizontalScrolling === true)) {
        return true;
      }
      return e.type === 'text'
        && (p.container === 'true' || p.container === true
          || (p.metadata === 'description' && p.container !== 'false'))
        && (e._contentH ?? 0) > this.stage.box(p).h;
    });
    if (!wants) {
      if (this._scrollTimer) { clearInterval(this._scrollTimer); this._scrollTimer = null; }
      return;
    }
    // NOT an early return before the `wants` test above: if the timer is
    // already running and nothing overflows any more, it has to be cleared.
    if (this._scrollTimer) return;
    let last = Date.now();
    this._scrollTimer = setInterval(() => {
      const now = Date.now();
      const dt = now - last;
      last = now;
      let moved = false;
      let stillWants = false;
      // The marquee shares the scroll timer rather than adding a fourth: both
      // animate text, both stop when nothing needs them.
      if (this.stage.tickMarquee(dt)) { stillWants = true; moved = true; }
      for (const el of this.stage.elements()) {
        if (!el._contentH) continue;
        const h = this.stage.box(el.props).h;
        if (el._contentH <= h) continue;
        stillWants = true;
        if (this.stage.tickScroll(el, el._contentH, h, dt)) moved = true;
      }
      // A shorter description (or a selection change) can leave nothing to
      // scroll. The timer has to notice and stop itself, or it outlives what
      // it was animating and quietly reinstates a render loop.
      if (!stillWants) {
        clearInterval(this._scrollTimer);
        this._scrollTimer = null;
        return;
      }
      if (moved) this.invalidate();
    }, 33);
    this._timers.push(this._scrollTimer);
  }

  /**
   * Start or stop the snap for the current selection.
   *
   * Snaps are decoration: they animate only while a theme asks for one and a
   * game has one, and they stop the moment the selection moves. That keeps
   * the event-driven repaint policy intact -- the only thing in the app that
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

  /**
   * Release everything this App holds, WITHOUT exiting the process.
   *
   * Every long-lived handle an App opens is a GC root: a live setInterval keeps
   * its closure -- and therefore the whole App, its stage and the stage's
   * decoded-image cache -- reachable forever. That is why headless harnesses
   * that build one App per iteration (the theme sweep builds 64) used to climb
   * from 480 MB to 7.8 GB in 45 seconds and eventually get OOM-killed: they
   * called svc.shutdown(), which only stops child sessions, so every previous
   * App stayed pinned by its own timers.
   *
   * Prefer withApp() over calling this by hand -- it cannot be forgotten on an
   * early return or a throw. This is idempotent, so the two compose safely.
   */
  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this.running = false;
    for (const t of this._timers) clearInterval(t);
    this._timers = [];
    // These three are tracked in _timers too, but they are re-armed
    // independently, so a live one can outlast the array it was pushed to.
    for (const k of ['_carouselTimer', '_scrollTimer', '_snapTimer']) {
      if (this[k]) { clearInterval(this[k]); this[k] = null; }
    }
    this.padNav?.stop();
    this.svc.stopSessions();
    this.presenter?.destroy?.();
    try { this.window?.destroy(); } catch { /* already gone */ }
    this.window = null;
    this.presenter = null;
    // Drop the heavy retained graphics: decoded artwork dominates an App's
    // footprint, and the stage outlives this call in any harness that kept a
    // reference to it.
    try { this.stage?._images?.clear(); } catch { /* nothing cached */ }
  }

  quit(code = 0) {
    this.dispose();
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

/**
 * Run `fn` with a started App and dispose it on EVERY exit path.
 *
 * An App owns OS resources -- interval timers, a gamepad poller, an SDL window,
 * a GL context, child player processes -- so "who releases this, and when?"
 * needs an answer that does not depend on remembering. Fifteen headless call
 * sites independently reached for svc.shutdown(), which only stops child
 * sessions; the result was a harness that grew to 7.8 GB and was OOM-killed.
 * That is a design gap, not fifteen separate mistakes, so the fix is a scope
 * that owns the lifetime rather than another rule to follow.
 *
 * Disposal happens in `finally`, which is the part hand-written teardown kept
 * missing: before today no check file had a single `finally`, so any throw
 * leaked the App AND left its emulator child processes running.
 *
 *   return withApp({ romsDir, headless: true }, async (app) => {
 *     ...                       // early-return freely; throw freely
 *   });
 *
 * @template T
 * @param {ConstructorParameters<typeof App>[0]} opts
 * @param {(app: App) => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withApp(opts, fn) {
  const app = new App(opts);
  try {
    await app.start();
    return await fn(app);
  } finally {
    app.dispose();
  }
}
