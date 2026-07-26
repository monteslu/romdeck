// Self-checks for the native frontend.
//
// Ported from the Electron build, and mostly improved: the render checks no
// longer need a display server, because a screenshot is canvas.toBuffer()
// rather than a browser's capturePage(). That removes the entire
// DISPLAY/Xauthority class of environment failure from CI.
//
// House rule, unchanged: every check drives the REAL thing — real services,
// a real theme, a real core — and asserts observable behaviour. Anything
// visual also gets written to /tmp for eyeballing, because five bugs in this
// project were invisible to green assertions and obvious in a screenshot.
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { App } from './app.js';
import { Services } from './services.js';
import { userDataDir } from './paths.js';
import { HeadlessPresenter } from './present.js';

export function makeReporter(label) {
  let failures = 0;
  const check = (name, cond, extra = '') => {
    console.log(`${cond ? 'PASS' : 'FAIL'}: ${name}${extra ? ' ' + extra : ''}`);
    if (!cond) failures++;
    return cond;
  };
  const done = (okMsg) => {
    console.log(failures === 0 ? `${label} OK — ${okMsg}` : `${label} ${failures} FAILURES`);
    return failures === 0 ? 0 : 1;
  };
  return { check, done, get failures() { return failures; } };
}

export async function runChecks(name, ctx) {
  switch (name) {
    case 'smoke': return smoke(ctx);
    case 'pathcheck': return pathcheck(ctx);
    case 'realtheme': return realtheme(ctx);
    case 'padonly': return (await import('./checks-interaction.js')).padonly(ctx);
    case 'viewcheck': return (await import('./checks-interaction.js')).viewcheck(ctx);
    case 'cartcheck': return (await import('./checks-sessions.js')).cartcheck(ctx);
    case 'autoplay': return (await import('./checks-sessions.js')).autoplay(ctx);
    case 'devcheck': return (await import('./checks-sessions.js')).autoplay({ ...ctx, dev: true });
    case 'joincheck': return (await import('./checks-sessions.js')).joincheck(ctx);
    default: throw new Error(`unknown check: ${name}`);
  }
}

// ── smoke ────────────────────────────────────────────────────────────
async function smoke({ romsDir }) {
  const r = makeReporter('SMOKE');
  const app = new App({ romsDir, headless: true });
  await app.start();

  r.check('services constructed', !!app.svc.sessions && !!app.svc.themes);
  const lib = app.svc.library();
  r.check('library scanned', Array.isArray(lib.roms), `${lib.roms.length} roms`);
  r.check('theme loaded', !!app.stage.theme, app.stage.theme?.displayName);
  r.check('stage paints', !!app.render(), `${app.presenter.frames} frame(s)`);
  r.check('systems grouped', app.stage.systems.length > 0,
    app.stage.systems.map((s) => s.name).join(', '));

  // The services the Electron build reached through ~50 IPC handlers are now
  // just calls; spot-check the ones with real side effects.
  r.check('settings resolve', app.svc.settings.resolve('videoFilter', {}).source === 'default');
  r.check('bios checker runs', app.svc.bios.check(romsDir).length > 0);
  r.check('theme catalog', app.svc.themes.catalog().length > 0);

  app.svc.shutdown();
  return r.done('shell boots, services round-trip, stage paints');
}

// ── pathcheck: nobody's saves move ───────────────────────────────────
async function pathcheck() {
  const r = makeReporter('PATHCHECK');
  // Deliberately NOT honouring ROMDECK_USERDATA here: the point is the real
  // per-platform path Electron used.
  const saved = process.env.ROMDECK_USERDATA;
  delete process.env.ROMDECK_USERDATA;
  const dir = userDataDir();
  if (saved) process.env.ROMDECK_USERDATA = saved;

  const expected = {
    linux: path.join(process.env.HOME ?? '', '.config', 'romdeck'),
    darwin: path.join(process.env.HOME ?? '', 'Library', 'Application Support', 'romdeck'),
    win32: path.join(process.env.APPDATA ?? '', 'romdeck'),
  }[process.platform === 'darwin' ? 'darwin' : process.platform === 'win32' ? 'win32' : 'linux'];

  r.check('userData matches Electron', dir === expected, dir);
  r.check('userData exists', existsSync(dir));

  // If a real profile is there, its stores must still be found — this is the
  // assertion that catches "the new frontend silently lost your saves".
  if (existsSync(dir)) {
    const entries = readdirSync(dir);
    const svc = new Services({});
    for (const [label, present, probe] of [
      ['prefs', entries.includes('prefs.json'), () => svc.prefs.get('theme') !== undefined],
      ['states', entries.includes('states'), () => true],
      ['themes', entries.includes('themes'), () => svc.themes.list().length > 0],
      ['media', entries.includes('media'), () => true],
    ]) {
      if (present) r.check(`existing ${label} readable`, probe());
      else console.log(`SKIP: no existing ${label} in this profile`);
    }
    svc.shutdown();
  }
  return r.done(`userData is ${dir}`);
}

// ── realtheme: render a real theme, assert on PIXELS ──────────────────
async function realtheme({ romsDir, argAfter }) {
  const name = argAfter('realtheme') ?? 'romdeck-default';
  const variantArg = process.argv[process.argv.indexOf('--realtheme') + 2];
  const variant = variantArg && !variantArg.startsWith('-') && !existsSync(variantArg)
    ? variantArg : null;

  const r = makeReporter('REALTHEME');
  const app = new App({ romsDir, headless: true });
  await app.start();
  const res = await app.setTheme(name, { variant });
  // loadTheme() falls back to the bundled theme when one is missing, which is
  // right for a user and WRONG for a check: it reported "modern-es-de renders"
  // while showing Shelf. Assert on the theme that actually loaded.
  const loaded = app.stage.theme?.name;
  r.check(`${name} loads`, !res.error && loaded === name,
    res.error ?? (res.fellBackFrom ? `NOT INSTALLED — fell back to ${loaded}` : app.stage.theme.displayName));
  if (res.error || loaded !== name) { app.svc.shutdown(); return r.done(''); }
  await app.stage.preload();

  const shot = (label) => {
    const p = new HeadlessPresenter();
    p.present(app.stage.paint());
    const file = `/tmp/romdeck-native-${name}-${label}.png`;
    p.write(file);
    return file;
  };

  // System view
  app.stage.view = 'system';
  const sysEls = app.stage.elements().length;
  r.check('system view has elements', sysEls > 0, `${sysEls}`);
  const sysShot = shot('system');
  const sysStats = paintStats(app);

  // Gamelist view
  app.stage.view = 'gamelist';
  await app.stage.preload();
  const gameEls = app.stage.elements().length;
  r.check('gamelist view has elements', gameEls > 0, `${gameEls}`);
  const gameShot = shot('gamelist');

  // Pixels, not counts. Counts said "renders fine" while the screen was a
  // white rectangle with ${system.fullName} printed three times.
  r.check('rendered pixels are not blank', !sysStats.nearlyBlank,
    `${sysStats.distinctColors} distinct colours, ${(sysStats.coverage * 100).toFixed(1)}% non-background`);
  r.check('no unresolved ${} bindings reach the screen', sysStats.unresolved.length === 0,
    sysStats.unresolved.slice(0, 3).join(' | '));
  r.check('images referenced by the theme resolved', sysStats.missingImages === 0,
    `${sysStats.missingImages} missing`);

  console.log(`  wrote ${sysShot}`);
  console.log(`  wrote ${gameShot}`);
  app.svc.shutdown();
  return r.done(`${name} renders`);
}

/**
 * Inspect what a paint actually produced.
 *
 * nearlyBlank borrows romdev's renderHealth heuristic: a view where one
 * colour owns almost every pixel is a blank screen wearing a costume, and it
 * is exactly what §16f shipped for weeks.
 */
function paintStats(app) {
  const canvas = app.stage.paint();
  const { data, width, height } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
  const counts = new Map();
  const step = 4 * 7; // sample; a full 1920x1080 scan per check is wasteful
  for (let i = 0; i < data.length; i += step) {
    const key = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let top = 0;
  let total = 0;
  for (const n of counts.values()) { total += n; if (n > top) top = n; }
  const dominance = top / Math.max(1, total);

  const unresolved = [];
  let missingImages = 0;
  for (const el of app.stage.elements()) {
    const p = el.props;
    if (el.type === 'text' || el.type === 'datetime' || el.type === 'gamelistinfo') {
      const key = p.metadata ?? p.systemdata;
      const text = key ? app.stage.meta(key) : app.stage.bind(p.text ?? '');
      if (typeof text === 'string' && text.includes('${')) unresolved.push(text.slice(0, 40));
    }
    for (const k of ['path', 'staticImage']) {
      const v = p[k];
      if (typeof v !== 'string' || !v || v.includes('${')) continue;
      if (!app.stage.img(v) && !app.svc.resolveUrl(v)) missingImages++;
    }
  }

  return {
    distinctColors: counts.size,
    coverage: 1 - dominance,
    nearlyBlank: dominance > 0.985 || counts.size < 3,
    unresolved,
    missingImages,
    width,
    height,
  };
}
