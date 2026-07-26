#!/usr/bin/env node
// romdeck — entry point.
//
// Replaces Electron's main.js. Same self-check flags, same acceptance tests,
// no browser. The render checks now work with NO DISPLAY at all, because a
// screenshot is canvas.toBuffer() rather than a browser capturePage().
import { existsSync } from 'node:fs';
import { App } from './app.js';
import { runChecks } from './checks.js';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const argAfter = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : null;
};

// The first bare argument that exists on disk is the ROMs folder.
const romsDir = argv.find((a) => !a.startsWith('-') && existsSync(a)) ?? null;

const CHECKS = [
  'smoke', 'padonly', 'viewcheck', 'realtheme', 'cartcheck',
  'autoplay', 'devcheck', 'joincheck', 'pathcheck', 'snapcheck',
];
const check = CHECKS.find((c) => flag(c));

if (flag('help') || flag('h')) {
  console.log(`
romdeck — a retro game library

  romdeck [romsDir]              run
  romdeck --fullscreen [romsDir] run fullscreen

Self-checks (no display required for the render ones):
  --smoke        boots, services round-trip
  --pathcheck    userData continuity with the Electron build
  --realtheme <name> [variant]   render a theme, assert on pixels
  --padonly      the unplugged test: every surface without a pointer
  --viewcheck    launch behaviour and view persistence
  --cartcheck    ROM, wasmcart and jsgame all play
  --autoplay     full session surface against a real core
  --devcheck     memory read/write against a live game
  --joincheck <CODE>   join a live remote-play host

Options:
  --headless     never open a window
  --debug        draw the debug overlay (fps, focus, element boxes)
  --gl           force the GL present path
`.trim());
  process.exit(0);
}

if (check) {
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
