// Tiny JSON preferences store in Electron's userData dir.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

export class Prefs {
  constructor(userDataDir) {
    this.file = path.join(userDataDir, 'prefs.json');
    try {
      this.data = JSON.parse(readFileSync(this.file, 'utf8'));
    } catch {
      this.data = {};
    }
  }

  get(key, fallback = undefined) {
    return this.data[key] ?? fallback;
  }

  set(key, value) {
    this.data[key] = value;
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify(this.data, null, 2));
    } catch (err) {
      console.warn('prefs: failed to persist:', err.message);
    }
  }
}
