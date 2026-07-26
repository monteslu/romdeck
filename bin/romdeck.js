#!/usr/bin/env node
// npx romdeck — launch the Electron app with any extra args passed through.
// (e.g. `npx romdeck ~/ROMs` to point at a ROMs folder on first run)
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
// `require('electron')` from plain Node returns the path to the Electron binary.
const electronPath = require('electron');
const appDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const child = spawn(electronPath, [appDir, ...process.argv.slice(2)], {
  stdio: 'inherit',
});
child.on('exit', (code) => process.exit(code ?? 0));
