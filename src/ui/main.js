#!/usr/bin/env node
// romdeck — entry point.
//
// Replaces Electron's main.js. Same self-check flags, same acceptance tests,
// no browser. The render checks now work with NO DISPLAY at all, because a
// screenshot is canvas.toBuffer() rather than a browser capturePage().
import { existsSync } from 'node:fs';
import path from 'node:path';
import { App } from './app.js';
import { runChecks } from './checks.js';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const argAfter = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : null;
};

// Flags that CONSUME the next argument. Everything else is boolean, so the
// bare word after it is still a candidate for the ROMs folder.
const VALUED = new Set(['shots', 'theme', 'realtheme', 'joincheck', 'snapcheck', 'cartcheck']);

// The first bare argument that exists on disk is the ROMs folder -- but NOT
// one that is a valued flag's value. `--shots <dir> <roms>` puts a bare word
// right after a flag, and once that word names something on disk (an output
// dir the check itself just created) it was silently taken as the library.
// The symptom is not an error: the app scans the wrong folder and every check
// quietly reports on an empty one.
const bare = argv.filter((a) => !a.startsWith('-') && existsSync(a));
const romsDir = argv.find((a, i) => {
  if (a.startsWith('-') || !existsSync(a)) return false;
  const prev = i > 0 ? argv[i - 1] : '';
  const isFlagValue = prev.startsWith('--') && VALUED.has(prev.slice(2));
  // A valued flag only claims the next path when there is ANOTHER one left to
  // be the library. `--shots <roms>` and `--cartcheck <roms>` pass the folder
  // and no value; treating it as the flag's value left romsDir null and the
  // check scanning nothing.
  return !isFlagValue || bare.length === 1;
}) ?? null;

const CHECKS = [
  'smoke', 'padonly', 'viewcheck', 'realtheme', 'cartcheck',
  'autoplay', 'devcheck', 'joincheck', 'pathcheck', 'snapcheck', 'shots',
];
const check = CHECKS.find((c) => flag(c));

if (flag('help') || flag('h')) {
  console.log(`
romdeck — a retro game library

  romdeck [romsDir]              run
  romdeck --fullscreen [romsDir] run fullscreen

Self-checks (no display required for the render ones):
  --smoke        boots, services round-trip
  --pathcheck    userData continuity + retroemu's optional deps
  --realtheme <name> [variant]   render a theme, assert on pixels
  --padonly      the unplugged test: every surface without a pointer
  --viewcheck    launch behaviour and view persistence
  --cartcheck    ROM, wasmcart and jsgame all play
  --snapcheck    video snaps decode (WASM h264)
  --shots [dir]  capture AND assert every visual surface (PNGs for review)
  --autoplay     full session surface against a real core
  --devcheck     memory read/write against a live game
  --joincheck [CODE]   remote play end to end: hosts a game and joins it.
                       Pass a code to join a real host on another machine.

Options:
  --live-profile checks write to the REAL profile (default: a throwaway copy)
  --headless     never open a window
  --debug        draw the debug overlay (fps, focus, element boxes)
  --gl           force the GL present path
`.trim());
  process.exit(0);
}

if (check) {
  // Checks run against a THROWAWAY profile by default.
  //
  // They write real settings, prefs and save states, and a check that leaves
  // `videoFilter: crt` in the global layer breaks the NEXT run of --smoke
  // ("settings resolve" expects a pristine default). Worse, it silently
  // changes how the user's own games launch. Nothing that only runs during a
  // test should be able to do that.
  //
  // Seeded by COPYING the real profile, so checks still exercise realistic
  // state — installed themes, scraped media, existing states — rather than an
  // empty directory that hides every state-dependent bug.
  //
  // --live-profile opts out, for deliberately testing the real one.
  // --pathcheck ignores all of this on purpose: its whole job is asserting the
  // real per-platform userData path.
  if (!flag('live-profile')) {
    const { mkdtempSync, cpSync, symlinkSync, rmSync, existsSync: hasPath } = await import('node:fs');
    const os = await import('node:os');
    const { userDataDir } = await import('./paths.js');
    const real = userDataDir();
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'romdeck-check-'));
    if (hasPath(real)) {
      // Big READ-ONLY trees are symlinked, not copied: themes are ~300 MB and
      // shaders ~60 MB, and --realtheme and the Picture checks genuinely need
      // them present. Everything a check WRITES (settings, prefs, states,
      // media, saves) is copied, so the real profile is never mutated.
      const linkOnly = new Set(['themes', 'shaders']);
      cpSync(real, tmp, {
        recursive: true,
        filter: (src) => !linkOnly.has(path.basename(src)) || src === real,
      });
      for (const name of linkOnly) {
        const from = path.join(real, name);
        if (!hasPath(from)) continue;
        try { symlinkSync(from, path.join(tmp, name), 'dir'); } catch { /* copied already */ }
      }
    }
    process.env.ROMDECK_USERDATA = tmp;
    if (process.env.ROMDECK_DEBUG) console.log(`[check] throwaway profile: ${tmp}`);

    // Remove it on the way out. A failed check keeps its profile when
    // ROMDECK_DEBUG is set, because "what did the check actually write?" is
    // usually the next question after a failure.
    process.on('exit', (code) => {
      if (code !== 0 && process.env.ROMDECK_DEBUG) {
        console.log(`[check] kept profile for inspection: ${tmp}`);
        return;
      }
      try { rmSync(tmp, { recursive: true, force: true }); } catch { /* nothing to clean */ }
    });
  }
  runChecks(check, { romsDir, argAfter, flag }).then(
    (code) => process.exit(code),
    (err) => { console.error(`${check.toUpperCase()} FAIL — ${err.stack ?? err.message}`); process.exit(1); },
  );
} else {
  const app = new App({ romsDir, headless: flag('headless') });
  if (flag('debug')) {
    const { attachOverlay } = await import('./overlay.js');
    attachOverlay(app);
  }
  app.start().then(
    () => {
      if (flag('fullscreen')) app.toggleFullscreen();
      if (flag('headless')) {
        console.log('romdeck: headless, nothing to show');
        app.quit(0);
      }
    },
    (err) => { console.error(`romdeck: ${err.message}`); process.exit(1); },
  );

  process.on('SIGINT', () => app.quit(0));
  process.on('SIGTERM', () => app.quit(0));
}
