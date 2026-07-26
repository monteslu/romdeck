// Custom collections: user-defined sets of games, in ES-DE's own format.
//
// Storage is <userData>/collections/custom-<name>.cfg, one ROM path per line
// (CollectionSystemsManager.cpp:1686). Paths are written with a %ROMPATH%
// variable rather than absolute, so a collection survives the library moving
// and can be shared between machines -- ES-DE reads absolute paths too, but
// only for backward compatibility, and writes the variable form.
//
// The format is the interop contract: a collection made in ES-DE has to load
// here, and one made here has to load in ES-DE. That is why this is a .cfg of
// plain paths and not JSON, which would have been easier and wrong.
import {
  existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';

const PREFIX = 'custom-';
const SUFFIX = '.cfg';

export class CollectionStore {
  constructor(userDataDir) {
    this.root = path.join(userDataDir, 'collections');
  }

  _file(name) {
    return path.join(this.root, `${PREFIX}${name}${SUFFIX}`);
  }

  /**
   * Every custom collection's name.
   *
   * "custom-.cfg" is skipped exactly as ES-DE skips it
   * (CollectionSystemsManager.cpp:1607): an empty name is not a collection.
   */
  list() {
    if (!existsSync(this.root)) return [];
    return readdirSync(this.root)
      .filter((f) => f.startsWith(PREFIX) && f.endsWith(SUFFIX) && f !== `${PREFIX}${SUFFIX}`)
      .map((f) => f.slice(PREFIX.length, -SUFFIX.length))
      .sort((a, b) => a.localeCompare(b));
  }

  /**
   * The ROM paths in one collection, resolved against the library root.
   *
   * Lines are kept in file order: a custom collection is an ordered list the
   * user built, not something to re-sort.
   */
  read(name, romsDir) {
    const file = this._file(name);
    if (!existsSync(file)) return [];
    return readFileSync(file, 'utf8')
      .split('\n')
      .map((line) => line.replace(/\r/g, '').trim())
      .filter(Boolean)
      .map((line) => (romsDir ? line.replace('%ROMPATH%', romsDir).replace(/\/\//g, '/') : line));
  }

  /** Write the collection, storing paths under %ROMPATH% where possible. */
  write(name, romPaths, romsDir) {
    mkdirSync(this.root, { recursive: true });
    const lines = romPaths.map((p) => (romsDir && p.startsWith(romsDir)
      ? `%ROMPATH%${p.slice(romsDir.length)}`
      : p));
    writeFileSync(this._file(name), `${lines.join('\n')}\n`);
  }

  create(name) {
    if (!name || this.list().includes(name)) return false;
    this.write(name, [], null);
    return true;
  }

  remove(name) {
    const file = this._file(name);
    if (!existsSync(file)) return false;
    unlinkSync(file);
    return true;
  }

  has(name, romPath, romsDir) {
    return this.read(name, romsDir).includes(romPath);
  }

  /** Add or remove one game. Returns the membership state afterwards. */
  toggle(name, romPath, romsDir) {
    const current = this.read(name, romsDir);
    const i = current.indexOf(romPath);
    if (i >= 0) current.splice(i, 1);
    else current.push(romPath);
    this.write(name, current, romsDir);
    return i < 0;
  }
}
