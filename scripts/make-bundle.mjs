/**
 * Build a self-contained romdeck bundle for the current platform:
 * a Node.js runtime, the packed app, its production node_modules, and a
 * launcher. The result runs on a machine with no Node and no npm.
 *
 * Usage:
 *   node scripts/make-bundle.mjs            # dist/romdeck-<target>/ + archive
 *   node scripts/make-bundle.mjs --no-archive
 *
 * The Node runtime is the one running this script (process.execPath), so the
 * bundled ABI always matches the node_modules that npm ci resolves.
 */
import { cpSync, chmodSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));

const osName = { linux: 'linux', darwin: 'macos', win32: 'windows' }[process.platform];
const archName = { x64: 'x86_64', arm64: 'aarch64' }[process.arch];
if (!osName || !archName) throw new Error(`unsupported platform ${process.platform}-${process.arch}`);
const target = `${osName}-${archName}`;
const win = process.platform === 'win32';

const dist = join(repo, 'dist');
const root = join(dist, `romdeck-${target}`);
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', ...opts });

rmSync(root, { recursive: true, force: true });
mkdirSync(join(root, 'app'), { recursive: true });
mkdirSync(join(root, 'node'), { recursive: true });

// 1. App payload: exactly what npm would publish, via npm pack
console.log('packing app...');
const packOut = execFileSync(win ? 'npm.cmd' : 'npm', ['pack', '--silent', '--pack-destination', dist], { cwd: repo, encoding: 'utf8', shell: win }).trim();
const tarball = join(dist, packOut.split('\n').pop());
run('tar', ['-xf', tarball, '-C', join(root, 'app'), '--strip-components=1']);
rmSync(tarball, { force: true });

// 2. Production dependencies, resolved by the lockfile
console.log('installing production dependencies...');
cpSync(join(repo, 'package-lock.json'), join(root, 'app', 'package-lock.json'));
run(win ? 'npm.cmd' : 'npm', ['ci', '--omit=dev', '--no-audit', '--no-fund'], { cwd: join(root, 'app'), shell: win });

// 3. Node runtime: the binary running this script
const nodeBin = win ? 'node.exe' : 'node';
cpSync(process.execPath, join(root, 'node', nodeBin));
if (!win) chmodSync(join(root, 'node', nodeBin), 0o755);

// 4. Launcher
if (win) {
  writeFileSync(join(root, 'romdeck.cmd'),
    '@echo off\r\n"%~dp0node\\node.exe" "%~dp0app\\src\\ui\\main.js" %*\r\n');
} else {
  writeFileSync(join(root, 'romdeck'),
    '#!/bin/sh\nDIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexec "$DIR/node/node" "$DIR/app/src/ui/main.js" "$@"\n');
  chmodSync(join(root, 'romdeck'), 0o755);
}
writeFileSync(join(root, 'VERSION'), `${pkg.version}\n`);

console.log(`bundle: ${root}`);

if (!process.argv.includes('--no-archive')) {
  const archive = win ? `romdeck-${target}.zip` : `romdeck-${target}.tar.gz`;
  console.log(`archiving ${archive}...`);
  if (win) {
    run('tar', ['-a', '-cf', join(dist, archive), '-C', dist, `romdeck-${target}`]);
  } else {
    run('tar', ['-czf', join(dist, archive), '-C', dist, `romdeck-${target}`]);
  }
  console.log(`archive: ${join(dist, archive)}`);
}
