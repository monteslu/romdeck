import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { ActiveBezelStore } from '../../src/services/activebezels.js';

function storedZip(name, data) {
  const word = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
  const dword = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
  const nameBytes = Buffer.from(name);
  const payload = Buffer.from(data);
  const local = Buffer.concat([
    dword(0x04034b50), word(20), word(0), word(0), word(0), word(0),
    dword(0), dword(payload.length), dword(payload.length),
    word(nameBytes.length), word(0), nameBytes, payload,
  ]);
  const central = Buffer.concat([
    dword(0x02014b50), word(20), word(20), word(0), word(0), word(0), word(0),
    dword(0), dword(payload.length), dword(payload.length),
    word(nameBytes.length), word(0), word(0), word(0), word(0), dword(0), dword(0), nameBytes,
  ]);
  return Buffer.concat([
    local, central, dword(0x06054b50), word(0), word(0), word(1), word(1),
    dword(central.length), dword(local.length), word(0),
  ]);
}

test('installs, auto-matches, associates and persists Active Bezel config', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'romdeck-ab-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const romPath = path.join(root, 'test.nes');
  const rom = Buffer.from([0x4e, 0x45, 0x53, 0x1a, 1, 2, 3, 4]);
  await fsp.writeFile(romPath, rom);

  // Reuse the real package and packer, adding this fixture's exact ROM hash.
  const packagePath = path.join(root, 'diagnostic.ab');
  // Resolve retroemu the way Node does, not by guessing at a sibling
  // checkout: on a developer machine node_modules/retroemu may be a symlink
  // to the local tree, on CI it is the registry install, and the published
  // package ships both bin/active-bezel.js and the diagnostic example.
  const retroemu = path.dirname(
    createRequire(import.meta.url).resolve('retroemu/package.json'));
  const packageSource = path.join(root, 'diagnostic');
  await fsp.cp(path.join(retroemu, 'examples/active-bezel/diagnostic'), packageSource, { recursive: true });
  const manifestPath = path.join(packageSource, 'manifest.json');
  const manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
  manifest.games = [{
    platform: 'nes',
    sha256: crypto.createHash('sha256').update(rom).digest('hex'),
  }];
  await fsp.writeFile(manifestPath, JSON.stringify(manifest));
  execFileSync(process.execPath, [
    path.join(retroemu, 'bin/active-bezel.js'), 'pack',
    packageSource, packagePath,
  ], { stdio: 'ignore' });
  assert.equal(fs.existsSync(packagePath), true);
  const bytes = await fsp.readFile(packagePath);
  // Patch no package contents here: forced association is explicitly supported.
  const store = new ActiveBezelStore(root, (game) => `game-${path.basename(game.path)}`);
  const installed = store.install(packagePath);
  assert.equal(installed.manifest.id, 'org.romdeck.diagnostic');
  assert.equal(store.list().length, 1);

  const game = { path: romPath, short: 'nes' };
  assert.equal(store.match(game).level, 'exact');
  const zippedRomPath = path.join(root, 'test.zip');
  await fsp.writeFile(zippedRomPath, storedZip('folder/test.nes', rom));
  assert.equal(store.match({ path: zippedRomPath, short: 'nes' }).level, 'exact');
  store.associate(game, installed.artifact, { force: true });
  assert.equal(store.launchOptions(game).force, true);
  store.setConfig(game, installed.manifest.id, 'game_left', true, installed.manifest.version);
  assert.equal(store.launchOptions(game).config.game_left, true);
  store.resetConfig(game, installed.manifest.id);
  assert.equal(store.launchOptions(game).config.game_left, false);

  store.associate(game, false);
  assert.equal(store.launchOptions(game), null);
  store.associate(game, null);
  assert.equal(store.association(game), null);
  assert.match(crypto.createHash('sha256').update(bytes).digest('hex'), /^[0-9a-f]{64}$/);
});
