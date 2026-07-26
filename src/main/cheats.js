// Per-game cheat codes.
//
// romdeck stores codes and hands them to the player; the CORE decodes them
// (libretro's retro_cheat_set). That means Game Genie, GameShark/PAR and raw
// address:value all work wherever the core supports them, and romdeck never
// pretends to decode a format it doesn't understand.
//
// Format on disk mirrors RetroArch's .cht semantics, stored as JSON per game:
//   { codes: [ { desc, code, enabled } ] }
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

export class CheatStore {
  constructor(userDataDir) {
    this.file = path.join(userDataDir, 'cheats.json');
    try {
      this.data = JSON.parse(readFileSync(this.file, 'utf8'));
    } catch {
      this.data = {};
    }
    this.data.games ??= {}; // gameKey -> [{desc, code, enabled}]
  }

  save() {
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify(this.data, null, 2));
    } catch { /* best effort */ }
  }

  list(gameKey) {
    return [...(this.data.games[gameKey] ?? [])];
  }

  /** Only the enabled ones, in the shape the player expects. */
  active(gameKey) {
    return this.list(gameKey)
      .filter((c) => c.enabled)
      .map((c) => ({ code: c.code, enabled: true, desc: c.desc }));
  }

  add(gameKey, { desc, code }) {
    const clean = String(code ?? '').trim();
    if (!clean) throw new Error('a cheat needs a code');
    this.data.games[gameKey] ??= [];
    this.data.games[gameKey].push({
      desc: String(desc ?? '').trim() || clean,
      code: clean,
      enabled: true,
    });
    this.save();
    return this.list(gameKey);
  }

  toggle(gameKey, index, enabled) {
    const list = this.data.games[gameKey];
    if (!list?.[index]) return this.list(gameKey);
    list[index].enabled = enabled ?? !list[index].enabled;
    this.save();
    return this.list(gameKey);
  }

  remove(gameKey, index) {
    const list = this.data.games[gameKey];
    if (list?.[index]) {
      list.splice(index, 1);
      this.save();
    }
    return this.list(gameKey);
  }

  /** Import RetroArch .cht text (cheat0_desc / cheat0_code pairs). */
  importCht(gameKey, text) {
    const descs = new Map();
    const codes = new Map();
    for (const line of String(text).split(/\r?\n/)) {
      const m = /^cheat(\d+)_(desc|code)\s*=\s*"?([^"]*)"?\s*$/.exec(line.trim());
      if (!m) continue;
      (m[2] === 'desc' ? descs : codes).set(m[1], m[3]);
    }
    let added = 0;
    for (const [idx, code] of codes) {
      if (!code.trim()) continue;
      this.add(gameKey, { desc: descs.get(idx) ?? code, code });
      added++;
    }
    return { added, codes: this.list(gameKey) };
  }
}
