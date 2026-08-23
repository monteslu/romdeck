// Save-state store. One directory per state (OpenEmu-style bundle, no zip dep):
//
//   <userData>/states/<gameKey>/<stateName>/
//     info.json        game path/name/system, core, frameCount, savedAt, app version
//     screenshot.png   the moment, for thumbnails
//     state.bin        the raw core state blob
//
// "auto" is the reserved name for exit-autosave (resume-on-launch).
// gameKey is sha1(basename + size) for M1 -- stable across library moves;
// replaced by real ROM-hash identity in the library milestone.
import {
  mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, existsSync,
  statSync, renameSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

export class StateStore {
  constructor(userDataDir, appVersion = '0') {
    this.root = path.join(userDataDir, 'states');
    this.appVersion = appVersion;
  }

  /**
   * Stable identity for a game's states, cheats and per-game settings.
   *
   * Prefers the CRC-verified ROM identity: two copies of the same game keep
   * one set of saves however they are named, and renaming a file no longer
   * strands its progress. Falls back to the old basename+size hash when a ROM
   * hasn't been identified -- most libraries are only partly verified, and a
   * key that changes the moment identification runs would be worse than one
   * that is merely weak.
   *
   * `legacyGameKey()` + `migrate()` carry existing data across; see save().
   */
  gameKey(rom) {
    // A disc's serial beats its CRC: two good dumps of the same game hash
    // differently (sector mode, subchannel data, padding) but carry the same
    // serial, so saves follow the game rather than the dump.
    if (rom?.serial) {
      return createHash('sha1').update('serial:').update(rom.serial).digest('hex').slice(0, 16);
    }
    if (rom?.crc && rom.verified) {
      return createHash('sha1').update('crc:').update(rom.crc).digest('hex').slice(0, 16);
    }
    return this.legacyGameKey(rom);
  }

  /** The pre-identification key: sha1(basename + size). */
  legacyGameKey(rom) {
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

  /**
   * Move a game's states from the legacy key to the CRC-verified one.
   *
   * Runs once per game, the first time it's touched after identification.
   * A user who identifies their library must not watch their save states
   * disappear -- that is the failure mode that makes this change dangerous,
   * and the reason it ships with migration rather than a version bump.
   *
   * @returns {string|null} the key data was moved FROM, or null if nothing moved
   */
  migrate(rom) {
    const to = this.gameKey(rom);
    const from = this.legacyGameKey(rom);
    if (to === from) return null;
    const src = path.join(this.root, from);
    const dst = path.join(this.root, to);
    if (!existsSync(src)) return null;
    try {
      if (!existsSync(dst)) {
        renameSync(src, dst);
        return from;
      }
      // Both exist: keep the newer key's data and fold in any states it
      // lacks, rather than clobbering either side.
      let moved = false;
      for (const name of readdirSync(src)) {
        if (existsSync(path.join(dst, name))) continue;
        renameSync(path.join(src, name), path.join(dst, name));
        moved = true;
      }
      if (!readdirSync(src).length) rmSync(src, { recursive: true, force: true });
      return moved ? from : null;
    } catch {
      return null; // migration is best-effort; the fallback key still works
    }
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
