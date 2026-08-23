/**
 * Build a single-file .flatpak bundle from an existing dist/romdeck-<target>.
 *
 *   node scripts/make-bundle.mjs --no-archive
 *   node scripts/make-flatpak.mjs
 *
 * Needs flatpak-builder and the org.freedesktop 24.08 runtime/sdk
 * (--install-deps-from=flathub fetches them when missing).
 */
import { cpSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const archName = { x64: 'x86_64', arm64: 'aarch64' }[process.arch];
if (process.platform !== 'linux' || !archName) throw new Error('flatpaks are built on linux only');
const target = `linux-${archName}`;
const appId = 'io.github.monteslu.romdeck';

const dist = join(repo, 'dist');
const bundle = join(dist, `romdeck-${target}`);
if (!existsSync(join(bundle, 'romdeck'))) throw new Error('bundle missing; run: node scripts/make-bundle.mjs');

// stage at the fixed path the manifest points to
const src = join(dist, 'flatpak-src');
rmSync(src, { recursive: true, force: true });
cpSync(bundle, src, { recursive: true });

const buildDir = join(dist, 'flatpak-build');
const repoDir = join(dist, 'flatpak-repo');
const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit', cwd: repo });

run('flatpak-builder', ['--user', '--force-clean', '--install-deps-from=flathub',
  `--repo=${repoDir}`, buildDir, join('packaging', 'flatpak', `${appId}.yml`)]);
const out = join(dist, `romdeck-${target}.flatpak`);
rmSync(out, { force: true });
run('flatpak', ['build-bundle', repoDir, out, appId]);
console.log(`flatpak: ${out}`);
