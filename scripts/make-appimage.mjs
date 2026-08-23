/**
 * Wrap an existing dist/romdeck-<target> bundle as an AppImage.
 *
 *   node scripts/make-bundle.mjs --no-archive
 *   node scripts/make-appimage.mjs
 *
 * Needs appimagetool: either on PATH or pointed at by APPIMAGETOOL.
 * The bundle IS the AppDir payload; AppRun execs its launcher.
 */
import { cpSync, chmodSync, mkdirSync, rmSync, writeFileSync, existsSync, symlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const archName = { x64: 'x86_64', arm64: 'aarch64' }[process.arch];
if (process.platform !== 'linux' || !archName) throw new Error('AppImages are built on linux only');
const target = `linux-${archName}`;

const dist = join(repo, 'dist');
const bundle = join(dist, `romdeck-${target}`);
if (!existsSync(join(bundle, 'romdeck'))) throw new Error(`bundle missing; run: node scripts/make-bundle.mjs`);

const appDir = join(dist, `AppDir-${target}`);
rmSync(appDir, { recursive: true, force: true });
mkdirSync(appDir, { recursive: true });

cpSync(bundle, join(appDir, 'romdeck-bundle'), { recursive: true });
writeFileSync(join(appDir, 'AppRun'),
  '#!/bin/sh\nHERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexec "$HERE/romdeck-bundle/romdeck" "$@"\n');
chmodSync(join(appDir, 'AppRun'), 0o755);
cpSync(join(repo, 'packaging', 'linux', 'romdeck.desktop'), join(appDir, 'romdeck.desktop'));
cpSync(join(repo, 'assets', 'icon', 'romdeck-256.png'), join(appDir, 'romdeck.png'));
symlinkSync('romdeck.png', join(appDir, '.DirIcon'));

const tool = process.env.APPIMAGETOOL || 'appimagetool';
const out = join(dist, `romdeck-${target}.AppImage`);
rmSync(out, { force: true });
execFileSync(tool, ['--appimage-extract-and-run', appDir, out], {
  stdio: 'inherit',
  env: { ...process.env, ARCH: archName },
});
console.log(`appimage: ${out}`);
