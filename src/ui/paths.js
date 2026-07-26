// Where romdeck keeps its data — without Electron.
//
// This reproduces `app.getPath('userData')` EXACTLY, per platform. It has to:
// people have save states, cheats, gamelists, downloaded themes and scraped
// art in those directories already, and a frontend that silently starts
// looking somewhere else has lost their progress as far as they can tell.
// That is the worst failure this app could have, so the paths are pinned here
// and verified by a self-check rather than assumed.
//
// Electron's rule (from its docs and source):
//   Linux    $XDG_CONFIG_HOME/<name>   else  ~/.config/<name>
//   macOS    ~/Library/Application Support/<name>
//   Windows  %APPDATA%/<name>
// where <name> is the `name` (or `productName`) from package.json.
import { homedir } from 'node:os';
import path from 'node:path';
import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const APP_NAME = 'romdeck';

/** Electron's userData directory, computed without Electron. */
export function userDataDir() {
  // An explicit override makes the self-checks able to run against a scratch
  // profile without touching a real one.
  if (process.env.ROMDECK_USERDATA) return process.env.ROMDECK_USERDATA;

  const home = homedir();
  switch (process.platform) {
    case 'darwin':
      return path.join(home, 'Library', 'Application Support', APP_NAME);
    case 'win32':
      return path.join(
        process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming'),
        APP_NAME,
      );
    default:
      return path.join(
        process.env.XDG_CONFIG_HOME || path.join(home, '.config'),
        APP_NAME,
      );
  }
}

/** Electron's app.getPath('temp') equivalent, for scratch files. */
export function tempDir() {
  return path.join(
    process.env.TMPDIR || process.env.TEMP || '/tmp',
    APP_NAME,
  );
}

/** The app's own root (repo checkout or install dir). */
export function appDir() {
  return path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
}

/** Create userData and its known subdirectories if missing. */
export function ensureUserData() {
  const root = userDataDir();
  for (const sub of ['', 'saves', 'states', 'media', 'themes', 'gamelists', 'dats', 'bios', 'screenshots']) {
    mkdirSync(path.join(root, sub), { recursive: true });
  }
  return root;
}

/** App version, read from package.json rather than Electron's app.getVersion(). */
export function appVersion() {
  try {
    const pkg = fileURLToPath(new URL('../../package.json', import.meta.url));
    return JSON.parse(readFileSync(pkg, 'utf8')).version ?? '0';
  } catch {
    return '0';
  }
}
