#!/usr/bin/env node
// npx romdeck — launch the Electron app with any extra args passed through.
// (e.g. `npx romdeck ~/ROMs` to point at a ROMs folder on first run)
//
// Electron lives in devDependencies, because electron-builder refuses to
// package an app that lists it as a runtime dependency. That means the npx
// path has to find it for itself: a checkout with dev deps installed has it,
// a bare `npx romdeck` does not, and the difference has to be explained
// rather than surfacing as "Cannot find module 'electron'".
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const appDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

let electronPath;
try {
  // `require('electron')` from plain Node returns the path to the binary.
  electronPath = require('electron');
} catch {
  console.error(`
romdeck needs Electron, which isn't installed here.

  From a checkout:   npm install && npm start -- <roms>
  Packaged builds:   https://github.com/monteslu/romdeck/releases

(Electron is a dev dependency because packaging requires it there; the
published installers bundle it, so they need none of this.)
`.trim());
  process.exit(1);
}

const child = spawn(electronPath, [appDir, ...process.argv.slice(2)], {
  stdio: 'inherit',
});
child.on('exit', (code) => process.exit(code ?? 0));
