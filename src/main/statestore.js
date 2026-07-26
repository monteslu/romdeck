// Save-state store. One directory per state (OpenEmu-style bundle, no zip dep):
//
//   <userData>/states/<gameKey>/<stateName>/
//     info.json        game path/name/system, core, frameCount, savedAt, app version
//     screenshot.png   the moment, for thumbnails
//     state.bin        the raw core state blob
//
// "auto" is the reserved name for exit-autosave (resume-on-launch).
// gameKey is sha1(basename + size) for M1 — stable across library moves;
// replaced by real ROM-hash identity in the library milestone.
import { mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, existsSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

export class StateStore {
  constructor(userDataDir, appVersion = '0') {
    this.root = path.join(userDataDir, 'states');
    this.appVersion = appVersion;
  }

  gameKey(rom) {
    let size = rom.size;
    if (size === undefined) {
      try { size = statSync(rom.path).size; } catch { size = 0; }
    }
    return createHash('sha1')
      .update(path.basename(rom.path))
      .update(String(size))
      .digest('hex')
      .slice(0, 16);
  }

  _dir(rom, name) {
    return path.join(this.root, this.gameKey(rom), name);
  }

  save(rom, name, { stateB64, screenshotPngB64, frameCount, core }) {
    const dir = this._dir(rom, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'state.bin'), Buffer.from(stateB64, 'base64'));
    if (screenshotPngB64) {
      writeFileSync(path.join(dir, 'screenshot.png'), Buffer.from(screenshotPngB64, 'base64'));
    }
    writeFileSync(
      path.join(dir, 'info.json'),
      JSON.stringify(
        {
          name,
          romPath: rom.path,
          romName: rom.name,
          system: rom.system,
          core: core ?? null,
          frameCount: frameCount ?? null,
          savedAt: new Date().toISOString(),
          appVersion: this.appVersion,
        },
        null,
        2,
      ),
    );
    return { name, dir };
  }

  load(rom, name) {
    const dir = this._dir(rom, name);
    try {
      const info = JSON.parse(readFileSync(path.join(dir, 'info.json'), 'utf8'));
      const state = readFileSync(path.join(dir, 'state.bin'));
      return { info, stateB64: state.toString('base64') };
    } catch {
      return null;
    }
  }

  list(rom) {
    const gameDir = path.join(this.root, this.gameKey(rom));
    let names;
    try {
      names = readdirSync(gameDir);
    } catch {
      return [];
    }
    const out = [];
    for (const name of names) {
      const dir = path.join(gameDir, name);
      try {
        const info = JSON.parse(readFileSync(path.join(dir, 'info.json'), 'utf8'));
        const shotPath = path.join(dir, 'screenshot.png');
        out.push({
          name,
          savedAt: info.savedAt,
          frameCount: info.frameCount,
          core: info.core,
          screenshotDataUrl: existsSync(shotPath)
            ? 'data:image/png;base64,' + readFileSync(shotPath).toString('base64')
            : null,
        });
      } catch {
        // skip malformed entries
      }
    }
    // newest first, but "auto" always on top
    out.sort((a, b) => (a.name === 'auto' ? -1 : b.name === 'auto' ? 1 : (b.savedAt ?? '').localeCompare(a.savedAt ?? '')));
    return out;
  }

  delete(rom, name) {
    rmSync(this._dir(rom, name), { recursive: true, force: true });
  }

  hasAuto(rom) {
    return existsSync(path.join(this._dir(rom, 'auto'), 'state.bin'));
  }
}
