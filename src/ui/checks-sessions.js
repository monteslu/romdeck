// Session checks for the native shell: --autoplay, --devcheck, --cartcheck,
// --joincheck.
//
// These barely change from the Electron versions, because they were never
// about the browser: they drive real player processes over the control
// channel. What changes is that they call the session manager directly
// instead of through IPC, which makes them shorter and removes the window
// they used to need.
import { createRequire } from 'node:module';
import { withApp } from './app.js';
import { makeReporter, retroemuDir } from './checks.js';

const req = createRequire(import.meta.url);
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
  return withApp({ romsDir, headless: true }, async (app) => {
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

    // ── achievements ─────────────────────────────────────────────────
    // The evaluator runs against the SAME live memory the debugger just
    // proved, so this is the natural place to assert it end to end. It is an
    // optional artifact (scripts/build-rcheevos.sh in retroemu), so a build
    // that lacks it skips rather than fails.
    const caps = (await sessions.rpc(id, 'getStatus')).capabilities ?? {};
    if (!caps.achievements) {
      console.log('SKIP: achievement evaluator not built (retroemu/scripts/build-rcheevos.sh)');
    } else {
      // rcheevos requires a TRANSITION into the true state — a condition
      // already true when armed never fires, which is correct (the player has
      // to DO something). So arm on a value the RAM does not currently hold,
      // then write it.
      const ADDR = 0x100;
      const MAGIC = 0x5a;
      const armed = await sessions.rpc(id, 'cheevosActivate', {
        achievements: [
          { id: 9001, memaddr: `0xH${ADDR.toString(16).padStart(4, '0')}=${MAGIC}`, title: 'probe' },
          { id: 9002, memaddr: '0xHfffe=255_0xHffff=254', title: 'impossible' },
        ],
      });
      r.check('cheevos: definitions compile', armed.activated === 2,
        `${armed.activated} armed, ${armed.rejected.length} rejected (rcheevos ${armed.version})`);

      const fired = [];
      const onCheevo = (ev) => { if (ev.type === 'achievement') fired.push(ev.achievementId); };
      sessions.on('update', onCheevo);

      // The GAME owns this RAM and rewrites it constantly — a single write is
      // zeroed within ~100ms, so whether an evaluated frame ever observed the
      // magic value was a race. Hold it across frames instead.
      const b64 = Buffer.from([MAGIC]).toString('base64');
      for (let i = 0; i < 40 && !fired.includes(9001); i++) {
        await sessions.rpc(id, 'writeMemory', { region: 2, offset: ADDR, dataB64: b64 });
        await sleep(25);
      }
      await sleep(400);
      sessions.off('update', onCheevo);

      r.check('cheevos: unlocks on a real memory transition', fired.includes(9001),
        fired.length ? `fired ${fired.join(',')}` : 'never fired');
      // The half that matters as much: an achievement whose conditions were
      // never met must NOT fire. Without this the check passes on a runtime
      // that unlocks everything.
      r.check('cheevos: no false positives', !fired.includes(9002));
      await sessions.rpc(id, 'cheevosStop', {}).catch(() => {});
    }
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

  return r.done(dev ? 'memory API works against a live game' : 'all session features verified');
  });
}

// ── --cartcheck ──────────────────────────────────────────────────────
export async function cartcheck({ romsDir }) {
  const r = makeReporter('CARTCHECK');
  return withApp({ romsDir, headless: true }, async (app) => {
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

  return r.done('ROM, wasmcart and jsgame all play from one library');
  });
}

// ── --joincheck ──────────────────────────────────────────────────────
/**
 * Remote play, end to end, with no human in the loop.
 *
 * This used to require a share code typed in by hand from a host someone
 * started on another machine — so P2P co-op was the ONE feature verified only
 * by a person remembering to test it, and it depends on WebRTC, an hsync
 * signalling server, and two optional deps (`hsync`, `node-datachannel`) that
 * fail SILENTLY when absent. The failure mode is a launch that connects to
 * nothing, which is exactly what an automated check should catch.
 *
 * romdeck can be both ends: launch a game, ask that session to host over the
 * control channel (which returns the share code), then join it as a guest and
 * assert the data channel actually came up. `--joincheck <CODE>` still works
 * for testing against a real remote host on another machine.
 *
 * Needs the network. It says so and skips rather than failing when the
 * signalling server cannot be reached — a check that goes red on a train is a
 * check people learn to ignore.
 */
export async function joincheck({ romsDir, argAfter }) {
  // `--joincheck <roms>` passes the LIBRARY, not a code — argAfter cannot tell
  // them apart and handed back "../roms-real", which was then dialled as a
  // share code and timed out. A code is base24 XXX-XXX-XXX and never a path,
  // so require the shape rather than trusting position.
  const arg = argAfter('joincheck');
  const given = arg && /^[A-Za-z0-9]{3}-[A-Za-z0-9]{3}-[A-Za-z0-9]{3}$/.test(arg.trim())
    ? arg.trim().toUpperCase()
    : null;
  const r = makeReporter('JOINCHECK');

  // The optional deps are what make this feature exist at all, and they fail
  // quietly. Say so up front rather than letting it surface as "timed out".
  for (const [mod, why] of [['hsync', 'signalling'], ['node-datachannel', 'WebRTC transport']]) {
    let ok = true;
    try { req.resolve(mod, { paths: [retroemuDir(), process.cwd()] }); } catch { ok = false; }
    if (!r.check(`${mod} resolvable (${why})`, ok)) {
      console.log('SKIP: remote play cannot work without it — install it in retroemu');
      return r.done('');
    }
  }

  return withApp({ romsDir, headless: true }, async (app) => {
    const { sessions } = app.svc;

    // ── the host half ────────────────────────────────────────────────
    // Given a code, trust it and only exercise the guest (a real host on
    // another machine). Otherwise be both ends.
    let code = given;
    let hostId = null;
    if (!code) {
      const rom = app.svc.library().roms.find((x) => x.short) ?? app.svc.library().roms[0];
      if (!rom) { console.error('JOINCHECK needs a library to host from'); return 1; }

      const launched = sessions.launch(rom, { resume: false });
      if (launched.error) { r.check('host session launched', false, launched.error); return r.done(''); }
      hostId = launched.id;
      const ready = await waitFor(sessions, hostId, ['ready', 'crashed', 'error']);
      if (!r.check('host session launched', ready?.type === 'ready',
        ready?.type === 'ready' ? `${rom.name} on ${ready.core}` : 'never became ready')) {
        return r.done('');
      }
      await sleep(1500); // let it run frames before anyone watches them

      let info;
      try {
        info = await sessions.rpc(hostId, 'remoteHost', {});
      } catch (err) {
        // Reaching the signalling server is the network-dependent part.
        r.check('hosting started', false, err.message);
        console.log('SKIP: could not reach the signalling server — is this machine online?');
        await sessions.stop(hostId).catch(() => {});
        return r.done('');
      }
      code = info?.code ?? null;
      // A share code is base24 XXX-XXX-XXX. Asserting the SHAPE catches a host
      // that "started" but published nothing to join.
      r.check('hosting started', !!code && /^[A-Z0-9]{3}-[A-Z0-9]{3}-[A-Z0-9]{3}$/.test(code),
        code ?? 'no code returned');
      if (!code) { await sessions.stop(hostId).catch(() => {}); return r.done(''); }

      const status = await sessions.rpc(hostId, 'remoteStatus', {}).catch(() => null);
      r.check('host reports itself hosting', status?.hosting === true,
        status ? JSON.stringify(status) : 'no status');
    }

    // ── the guest half ───────────────────────────────────────────────
    const res = app.doJoin(code);
    r.check('guest session spawned', !res.error, res.error ?? res.code);
    if (!res.error) {
      const joined = await waitFor(sessions, res.id, ['ready', 'crashed', 'error'], 45000);
      r.check('guest connected to the host', joined?.type === 'ready',
        joined ? (joined.message ?? joined.type) : 'timed out waiting for the data channel');

      // A guest that connects and then dies is not a working feature. Give it
      // a moment of real streaming before calling it good.
      if (joined?.type === 'ready') {
        await sleep(2500);
        r.check('guest still alive after streaming', !!sessions.get(res.id));

        // "Connected" is not "working". A data channel can come up and carry
        // nothing, which looks identical from the guest side — so ask the HOST
        // whether it saw the peer and actually pushed frames down the wire.
        // Sampling status before the guest arrives (as the earlier assertion
        // does) always reads guests:0 framesSent:0, and would pass forever.
        if (hostId) {
          const live = await sessions.rpc(hostId, 'remoteStatus', {}).catch(() => null);
          r.check('host sees the guest', (live?.guests ?? 0) > 0, `guests=${live?.guests ?? 0}`);
          r.check('host is streaming frames', (live?.framesSent ?? 0) > 0,
            `${live?.framesSent ?? 0} frames, ${live?.kbSent ?? 0} kB`);
        }
      }

      // The code is remembered so it can be rejoined from the menu.
      if (!given) {
        r.check('share code remembered for rejoin',
          (app.svc.prefs.get('recentCodes') ?? []).includes(code));
      }
      await sessions.stop(res.id).catch(() => {});
      await waitFor(sessions, res.id, ['closed', 'crashed'], 10000);
    }

    // ── teardown ─────────────────────────────────────────────────────
    if (hostId) {
      // Hosting must be stoppable without killing the game — the host goes
      // back to playing alone.
      const stopped = await sessions.rpc(hostId, 'remoteStop', {}).catch((e) => ({ error: e.message }));
      r.check('hosting stops cleanly', !stopped?.error, stopped?.error ?? '');
      r.check('host session survives its guests leaving', !!sessions.get(hostId));
      await sessions.stop(hostId).catch(() => {});
      await waitFor(sessions, hostId, ['closed', 'crashed'], 12000);
    }

    return r.done(given ? `joined ${code}` : `hosted and joined ${code}`);
  });
}
