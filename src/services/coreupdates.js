// Core update manager -- romdeck's structural answer to what killed OpenEmu.
//
// OpenEmu hand-maintained a fork of every emulator and shipped core updates
// only with app releases; its Mednafen fork sat three years stale and the fix
// never reached users. romdeck's cores are plain npm packages (romdev-core-*),
// so they version independently of the app: this module reports what's
// installed versus what's published, and updating is an npm install away.
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const REGISTRY = 'https://registry.npmjs.org/';

function retroemuRoot() {
  try {
    return path.dirname(require.resolve('retroemu/package.json'));
  } catch {
    return null;
  }
}

export class CoreUpdates {
  /** Installed romdev-core-* packages, read from retroemu's dependency tree. */
  installed() {
    const root = retroemuRoot();
    if (!root) return [];
    const out = [];
    const seen = new Set();
    const scan = (nodeModules) => {
      if (!existsSync(nodeModules)) return;
      for (const name of readdirSync(nodeModules)) {
        if (!name.startsWith('romdev-core-') || seen.has(name)) continue;
        try {
          const pkg = JSON.parse(readFileSync(path.join(nodeModules, name, 'package.json'), 'utf8'));
          seen.add(name);
          out.push({
            name,
            version: pkg.version,
            description: pkg.description ?? '',
          });
        } catch { /* skip unreadable */ }
      }
    };
    scan(path.join(root, 'node_modules'));
    scan(path.join(root, '..')); // hoisted layout
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Ask npm for the latest published version of each installed core. */
  async check() {
    const cores = this.installed();
    const results = await Promise.all(
      cores.map(async (core) => {
        try {
          const res = await fetch(`${REGISTRY}${core.name}/latest`, {
            signal: AbortSignal.timeout(12000),
          });
          if (!res.ok) return { ...core, latest: null, status: 'unknown' };
          const data = await res.json();
          const latest = data.version ?? null;
          return {
            ...core,
            latest,
            status: !latest ? 'unknown' : latest === core.version ? 'current' : 'update',
          };
        } catch {
          return { ...core, latest: null, status: 'offline' };
        }
      }),
    );
    return {
      cores: results,
      updatesAvailable: results.filter((c) => c.status === 'update').length,
      // Updating is deliberately a command the user runs, not something the
      // app does behind their back to a running emulator tree.
      updateCommand: 'npm install ' + (results.filter((c) => c.status === 'update').map((c) => `${c.name}@latest`).join(' ') || '<core>@latest'),
    };
  }
}
