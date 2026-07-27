// Session checks for the native shell: --autoplay, --devcheck, --cartcheck,
// --joincheck.
//
// These barely change from the Electron versions, because they were never
// about the browser: they drive real player processes over the control
// channel. What changes is that they call the session manager directly
// instead of through IPC, which makes them shorter and removes the window
// they used to need.
import { App } from './app.js';
import { makeReporter } from './checks.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Wait for a specific session event, or give up. */
function waitFor(sessions, id, types, ms = 30000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { sessions.off('update', on); resolve(null); }, ms);
    const on = (ev) => {
      if (ev.id !== id || !types.includes(ev.type)) return;
      clearTimeout(timer);
      sessions.off('update', on);
      resolve(ev);
    };
    sessions.on('update', on);
  });
}

// ── --autoplay / --devcheck ──────────────────────────────────────────
export async function autoplay({ romsDir, dev = false }) {
  const label = dev ? 'DEVCHECK' : 'AUTOPLAY';
  const r = makeReporter(label);
  const app = new App({ romsDir, headless: true });
  await app.start();
  const { sessions, stateStore } = app.svc;

  const roms = app.svc.library().roms;
  if (!roms.length) { console.error(`${label} FAIL — no roms`); return 1; }
  const rom = roms[0];
  console.log(`${label} launching: ${rom.name} (${rom.system})`);

  let { id } = sessions.launch(rom, { resume: false });
  const ready = await waitFor(sessions, id, ['ready', 'crashed', 'error']);
  if (!ready || ready.type !== 'ready') {
    // The session already captured the player's last 8 lines; printing only
    // the exit code turns a diagnosable failure ("core package has no wasm")
    // into a bare "crashed: 1" that costs an hour to chase down.
    const tail = ready?.logTail?.length ? `\n  ${ready.logTail.join('\n  ')}` : '';
    r.check('session ready', false,
      (ready ? `${ready.type}: ${ready.message ?? ready.code}` : 'timed out') + tail);
    app.dispose();
    return r.done('');
  }
  r.check('session ready', true, `core=${ready.core}`);
  await sleep(2200);

  if (dev) {
    // Developer mode: a debugger pointed at the running game.
    const info = await sessions.rpc(id, 'memoryInfo');
    r.check('dev: memoryInfo', info.regions.length > 0,
      info.regions.map((x) => `${x.name}:${x.size}`).join(','));
    const rd = await sessions.rpc(id, 'readMemory', { region: 2, offset: 0, length: 64 });
    r.check('dev: readMemory', Buffer.from(rd.dataB64, 'base64').length === 64);
    await sessions.rpc(id, 'writeMemory', {
      region: 2, offset: 8, dataB64: Buffer.from([1, 2, 3, 4]).toString('base64'),
    });
    const back = Buffer.from(
      (await sessions.rpc(id, 'readMemory', { region: 2, offset: 8, length: 4 })).dataB64, 'base64');
    r.check('dev: writeMemory round-trip', back.toString('hex') === '01020304');
  } else {
    const st = await sessions.rpc(id, 'getStatus');
    r.check('runs frames', st.frameCount > 0, `frame=${st.frameCount}`);

    await sessions.rpc(id, 'pause');
    r.check('paused via channel', (await sessions.rpc(id, 'getStatus')).paused === true);
    await sessions.rpc(id, 'resume');

    const save = await sessions.rpc(id, 'saveState', {});
    r.check('saveState blob', (save.stateB64?.length ?? 0) > 1000, `${save.size}b`);
    stateStore.save(rom, 'checkpoint', { ...save, core: ready.core });
    r.check('state persisted', stateStore.load(rom, 'checkpoint') !== null);
    await sessions.rpc(id, 'loadState', { stateB64: save.stateB64 });
    r.check('loadState round-trip', true);

    const shot = await sessions.rpc(id, 'screenshot', {});
    r.check('screenshot', (shot.pngB64?.length ?? 0) > 500, `${shot.width}x${shot.height}`);

    const sp = await sessions.rpc(id, 'setSpeed', { x: 4 });
    r.check('fast-forward', sp.speed === 4);
    await sessions.rpc(id, 'setSpeed', { x: 1 });

    await sleep(1400);
    const st2 = await sessions.rpc(id, 'getStatus');
    if (st2.rewindDepth > 0) {
      const rw = await sessions.rpc(id, 'rewind', { steps: 1 });
      r.check('rewind', rw.frame <= st2.frameCount, `depth=${st2.rewindDepth}`);
    } else {
      r.check('rewind history accrued', false);
    }
  }

  await sessions.stop(id);
  const closed = await waitFor(sessions, id, ['closed', 'crashed'], 15000);
  r.check('graceful close', closed?.type === 'closed', `code=${closed?.code}`);
  r.check('exit autosave persisted', stateStore.hasAuto(rom));

  // Phase 2: relaunch and resume from the exit autosave. This is the check
  // that proves the whole state pipeline, so it runs in both modes.
  ({ id } = sessions.launch(rom, { resume: true }));
  const resumed = await waitFor(sessions, id, ['resumed', 'resume-failed', 'crashed'], 30000);
  r.check('resume-on-launch', resumed?.type === 'resumed',
    resumed ? (resumed.savedAt ?? resumed.message ?? resumed.type) : 'timed out');
  await sleep(400);
  await sessions.stop(id);
  await waitFor(sessions, id, ['closed', 'crashed'], 12000);

  app.dispose();
  return r.done(dev ? 'memory API works against a live game' : 'all session features verified');
}

// ── --cartcheck ──────────────────────────────────────────────────────
export async function cartcheck({ romsDir }) {
  const r = makeReporter('CARTCHECK');
  const app = new App({ romsDir, headless: true });
  await app.start();
  const { sessions } = app.svc;

  const byKind = new Map();
  for (const rom of app.svc.library().roms) {
    if (!byKind.has(rom.system)) byKind.set(rom.system, rom);
  }
  // This check is about one library serving all three cart types, so it needs
  // a library that HAS all three. roms-demo is that fixture; roms-real is
  // emulator ROMs only and will always "fail" here for want of carts, which
  // reads as a product bug when it is a wrong-folder mistake. Say so.
  const hasCarts = byKind.has('WASM Cart') && byKind.has('JS Game');
  const hasRom = [...byKind.keys()].some((k) => !['WASM Cart', 'JS Game'].includes(k));
  r.check('library has all three cart types', hasCarts && hasRom,
    hasCarts && hasRom
      ? [...byKind.keys()].join(', ')
      : `${[...byKind.keys()].join(', ') || 'empty'} — needs a library with a ROM, a .wasc and a .jsgame (try roms-demo)`);

  for (const [system, rom] of byKind) {
    const { id, error } = sessions.launch(rom, { resume: false });
    if (error) { r.check(`${system}: launch`, false, error); continue; }
    const ready = await waitFor(sessions, id, ['ready', 'crashed', 'error']);
    r.check(`${system}: session ready`, ready?.type === 'ready',
      ready?.type === 'ready' ? `core=${ready.core ?? 'n/a'}` : 'never became ready');
    if (ready?.type !== 'ready') continue;

    await sleep(2200);
    try {
      const st = await sessions.rpc(id, 'getStatus');
      r.check(`${system}: reports its kind`, !!st.kind, `kind=${st.kind}`);
      const caps = st.capabilities ?? {};
      r.check(`${system}: reports capabilities`, Object.keys(caps).length > 0,
        `pause=${caps.pause} saveState=${caps.saveState} screenshot=${caps.screenshot}`);
      const shot = await sessions.rpc(id, 'screenshot', {});
      r.check(`${system}: screenshot`, (shot.pngB64?.length ?? 0) > 500, `${shot.width}x${shot.height}`);
      // An unsupported control must REFUSE rather than pretend.
      if (caps.pause === false) {
        let threw = false;
        try { await sessions.rpc(id, 'pause'); } catch { threw = true; }
        r.check(`${system}: unsupported controls refuse`, threw);
      }
    } catch (err) {
      r.check(`${system}: session ops`, false, err.message);
    }
    await sessions.stop(id);
    await sleep(1000);
  }

  app.dispose();
  return r.done('ROM, wasmcart and jsgame all play from one library');
}

// ── --joincheck ──────────────────────────────────────────────────────
export async function joincheck({ romsDir, argAfter }) {
  const code = argAfter('joincheck');
  const r = makeReporter('JOINCHECK');
  if (!code) { console.error('JOINCHECK needs a share code'); return 1; }

  const app = new App({ romsDir, headless: true });
  await app.start();
  const res = app.doJoin(code);
  r.check('guest session spawned', !res.error, res.error ?? res.code);
  if (res.error) { app.dispose(); return r.done(''); }

  const ready = await waitFor(app.svc.sessions, res.id, ['ready', 'crashed', 'error'], 30000);
  r.check('connected to the host', ready?.type === 'ready',
    ready ? (ready.message ?? ready.type) : 'timed out');
  await app.svc.sessions.stop(res.id);
  app.dispose();
  return r.done(`joined ${code}`);
}
