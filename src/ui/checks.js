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
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createCanvas } from '@napi-rs/canvas';
import path from 'node:path';
import { withApp } from './app.js';
import { DEFAULT_THEME } from '../services/themes.js';
import { Services } from './services.js';
import { userDataDir } from './paths.js';
import { HeadlessPresenter, STAGE_W, STAGE_H } from './present.js';
import { formatDate } from './stage.js';
import { focus } from './focus.js';

const req = createRequire(import.meta.url);

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
    case 'snapcheck': return snapcheck(ctx);
    case 'shots': return shots(ctx);
    default: throw new Error(`unknown check: ${name}`);
  }
}

// ── smoke ────────────────────────────────────────────────────────────
async function smoke({ romsDir }) {
  const r = makeReporter('SMOKE');
  return withApp({ romsDir, headless: true }, async (app) => {

  r.check('services constructed', !!app.svc.sessions && !!app.svc.themes);
  const lib = app.svc.library();
  r.check('library scanned', Array.isArray(lib.roms), `${lib.roms.length} roms`);
  r.check('theme loaded', !!app.stage.theme, app.stage.theme?.displayName);
  r.check('stage paints', !!app.render(), `${app.presenter.frames} frame(s)`);
  // A drawing element that THROWS is caught per-element so one failure cannot
  // blank the view. That is right, and it also hid a crash for an entire batch
  // of work -- the help row vanished and every assertion stayed green. Nothing
  // may throw during a normal paint.
  app.render();
  r.check('no element threw while drawing',
    (app.stage.drawErrors ?? []).length === 0,
    (app.stage.drawErrors ?? []).join(' | '));

  r.check('systems grouped', app.stage.systems.length > 0,
    app.stage.systems.map((s) => s.name).join(', '));

  // --debug is a documented flag whose module is only imported on that path,
  // so nothing else here would ever load it. It shipped broken (importing a
  // module that did not exist) and every headless check still passed, because
  // none of them take that branch. Assert that it loads AND that it actually
  // marks the frame -- an overlay that silently no-ops is the failure mode
  // this would otherwise miss.
  const { attachOverlay } = await import('./overlay.js');
  const before = app.render().toBuffer('image/png');
  attachOverlay(app);
  const after = app.render().toBuffer('image/png');
  r.check('--debug overlay draws', Buffer.compare(before, after) !== 0);
  app.onOverlay = null;

  // The services the Electron build reached through ~50 IPC handlers are now
  // just calls; spot-check the ones with real side effects.
  r.check('settings resolve', app.svc.settings.resolve('videoFilter', {}).source === 'default');
  r.check('bios checker runs', app.svc.bios.check(romsDir).length > 0);
  r.check('theme catalog', app.svc.themes.catalog().length > 0);

  // Picture cascade: shader and CPU filter share one question and must not
  // both apply. The layered override is the whole point — RetroArch's
  // global/core/game hierarchy, but with provenance the UI can show.
  {
    const st = app.svc.settings;
    const rom = app.svc.library().roms[0];
    if (rom) {
      const ctx = { platform: rom.short, gameKey: app.svc.gameKey(rom) };
      const saved = JSON.parse(JSON.stringify(st.data.layers));
      st.set('shader', 'a/global.glslp', 'global');
      const g = st.resolve('shader', ctx);
      st.set('shader', 'a/platform.glslp', `platform:${rom.short}`);
      const p2 = st.resolve('shader', ctx);
      st.set('shader', 'a/game.glslp', `game:${app.svc.gameKey(rom)}`);
      const g3 = st.resolve('shader', ctx);
      r.check('shader cascades global → platform → game',
        g.source === 'global' && p2.source === 'platform' && g3.source === 'game',
        `${g.source} → ${p2.source} → ${g3.source}`);
      // A preset that no longer exists must degrade to the CPU filter rather
      // than fail the launch.
      r.check('a missing preset resolves to null', app.svc.shaders.resolve('a/game.glslp') === null);
      st.data.layers = saved;
      st.save();
    }
  }
  r.check('picture options offered', app.svc.pictureFilters().length >= 4,
    `${app.svc.pictureFilters().length} CPU filters, ${app.svc.shaders.list().length} shaders`);

  // Path jailing. This used to be enforced by the custom protocol handlers;
  // it is now resolveUrl's job, and a theme is still untrusted input. The
  // sandbox went away, so the one guard that DID carry over gets asserted
  // rather than assumed. Traversal must return null, not a path outside root.
  //
  // Probe the RESOLVER layer, not just the URL layer: `new URL()` collapses
  // `../` in a pathname itself, so a traversal written into a romdeck-theme://
  // URL is already neutered before any of our code runs. Testing only that
  // form passes even with the jail deleted -- it proves URL parsing works, not
  // that we do. So the traversal is handed to resolveAsset directly, and the
  // percent-encoded form (which survives URL parsing and IS decoded by
  // resolveUrl) covers the path through the URL surface.
  // The traversal must reach a file that REALLY EXISTS, with enough `../` to
  // clear the root from wherever romdeck happens to be installed. Both
  // resolvers end in existsSync, so a payload that merely points outside the
  // jail at nothing returns null either way and the check passes without
  // testing the jail at all. Depth is computed, never hardcoded.
  const themeName = app.stage.theme?.name ?? DEFAULT_THEME;
  const themeDir = app.svc.themes.find(themeName)?.dir ?? process.cwd();
  const up = (dir) => '../'.repeat(dir.split(path.sep).filter(Boolean).length + 1);
  const target = process.platform === 'win32' ? 'Windows/win.ini' : 'etc/passwd';

  const leaked = [];
  for (const rel of [`${up(themeDir)}${target}`, `a/${up(themeDir)}${target}`]) {
    if (app.svc.themes.resolveAsset(themeName, rel) !== null) leaked.push(rel);
  }
  // Percent-encoded, so it survives `new URL()` (which would otherwise
  // collapse the `../` itself) and is decoded by resolveUrl on our side.
  const enc = encodeURIComponent(`${up(themeDir)}${target}`);
  // The media resolver joins TWO extra segments (<system>/covers) under the
  // root before the traversal applies, so it has to climb that much further.
  const mediaEnc = encodeURIComponent(`../../${up(app.svc.artwork.root)}${target}`);
  for (const url of [
    `romdeck-theme://${themeName}/${enc}`,
    `romdeck-media://art/nes/${mediaEnc}`,
  ]) {
    if (app.svc.resolveUrl(url) !== null) leaked.push(url);
  }
  r.check('asset paths are jailed', leaked.length === 0, leaked.join(' '));
  // …and the guard is not vacuous: a legitimate asset must still resolve.
  // Without this, resolveUrl could return null unconditionally and pass.
  const real = app.svc.resolveUrl(`romdeck-theme://${themeName}/theme.xml`);
  r.check('legitimate theme asset resolves', !!real, real ?? '');

  return r.done('shell boots, services round-trip, stage paints');
  });
}

// ── pathcheck: nobody's saves move ───────────────────────────────────
async function pathcheck() {
  const r = makeReporter('PATHCHECK');
  // Deliberately NOT honouring ROMDECK_USERDATA here: the point is the real
  // per-platform path, which must still be the one the Electron build wrote
  // to. Anyone upgrading has saves, states and themes sitting in it.
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
      // The prefs STORE must be readable — not "a theme key exists". romdeck
      // no longer writes a theme preference until the user picks one
      // (defaultTheme() supplies it at runtime), so asserting on that key
      // failed on any profile that had never chosen a theme. Read the file
      // itself instead, which is what "existing prefs readable" means.
      ['prefs', entries.includes('prefs.json'), () => Object.keys(svc.prefs.data).length > 0],
      ['states', entries.includes('states'), () => true],
      ['themes', entries.includes('themes'), () => svc.themes.list().length > 0],
      ['media', entries.includes('media'), () => true],
    ]) {
      if (present) r.check(`existing ${label} readable`, probe());
      else console.log(`SKIP: no existing ${label} in this profile`);
    }
    svc.stopSessions();
  }

  // retroemu's optional deps. Each one fails SILENTLY at the point of use --
  // remote play just never connects, a .p8 cart just never loads -- so the
  // only place this gets caught is a check that looks for them on purpose.
  // The old packaged build surfaced it as a builder warning; without a
  // package step, nothing else does. See docs/Packaging.md.
  for (const [mod, breaks] of [
    ['hsync', 'remote play signalling'],
    ['node-datachannel', 'remote play transport'],
    ['romdev-core-fake08', 'PICO-8 carts'],
  ]) {
    let found = true;
    try { req.resolve(mod, { paths: [retroemuDir(), process.cwd()] }); }
    catch { found = false; }
    r.check(`${mod} resolvable (${breaks})`, found);
  }

  // ── RetroAchievements submission protocol ──────────────────────────
  // Unlocks go to dorequest.php, NOT the read-only Web API. Two things about
  // that endpoint are easy to get wrong and impossible to notice locally:
  //
  //   1. It 403s an HTML page when the request has no User-Agent. Every
  //      submission would fail and the JSON parse would fail after it.
  //   2. The `v` signature is md5(achievementId + username + hardcore) as
  //      concatenated DECIMAL STRINGS. A wrong signature is simply rejected.
  //
  // Both are asserted against the LIVE server with deliberately invalid
  // credentials: a well-formed rejection proves the shape is right without
  // needing anyone's account. Network failures SKIP — a check that goes red
  // on a train is a check people learn to ignore.
  try {
    const probe = await fetch('https://retroachievements.org/dorequest.php', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'romdeck-selfcheck',
      },
      body: new URLSearchParams({ r: 'login2', u: 'romdeck_selfcheck_nobody', p: 'x' }),
      signal: AbortSignal.timeout(12000),
    });
    const text = await probe.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* asserted below */ }
    r.check('RA dorequest answers JSON with a User-Agent', !!json,
      json ? `${probe.status} ${json.Code ?? ''}` : `${probe.status} ${text.slice(0, 60)}`);
    r.check('RA dorequest rejects bad credentials cleanly',
      json?.Success === false && !!json?.Code,
      json ? `${json.Code}` : 'no JSON error body');
  } catch (err) {
    console.log(`SKIP: could not reach RetroAchievements (${err.message})`);
  }

  // The unlock signature, against rcheevos' own algorithm. Fixed vector: if
  // this ever changes, submissions start being rejected server-side and
  // nothing local would otherwise notice.
  const { createHash } = await import('node:crypto');
  const sig = createHash('md5').update('12345monteslu0', 'utf8').digest('hex');
  r.check('RA unlock signature matches rcheevos',
    sig === 'b13f11635dbbd81b8bec7d99cef2bdcc', sig);

  return r.done(`userData is ${dir}`);
}

/** retroemu's own directory, where its optional deps are installed. */
export function retroemuDir() {
  try { return path.dirname(req.resolve('retroemu/package.json')); }
  catch { return process.cwd(); }
}

// ── realtheme: render a real theme, assert on PIXELS ──────────────────
async function realtheme({ romsDir, argAfter }) {
  const name = argAfter('realtheme') ?? DEFAULT_THEME;
  const variantArg = process.argv[process.argv.indexOf('--realtheme') + 2];
  const variant = variantArg && !variantArg.startsWith('-') && !existsSync(variantArg)
    ? variantArg : null;

  const r = makeReporter('REALTHEME');
  return withApp({ romsDir, headless: true }, async (app) => {
  const res = await app.setTheme(name, { variant });
  // loadTheme() falls back to the bundled theme when one is missing, which is
  // right for a user and WRONG for a check: it reported "modern-es-de renders"
  // while showing Shelf. Assert on the theme that actually loaded.
  const loaded = app.stage.theme?.name;
  r.check(`${name} loads`, !res.error && loaded === name,
    res.error ?? (res.fellBackFrom ? `NOT INSTALLED — fell back to ${loaded}` : app.stage.theme.displayName));
  if (res.error || loaded !== name) return r.done('');
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
  // A theme may document art the USER supplies -- adroit's README says
  // "place your own background.gif" -- so an absent one is the theme working
  // as designed, not a resolution failure. Report it, do not fail on it.
  if (sysStats.missingImages) {
    console.log(`NOTE: ${sysStats.missingImages} theme image(s) absent `
      + `(user-supplied or optional): ${sysStats.missingList.join(', ')}`);
  }
  // Assert on what IS resolvable rather than on a count of absences: a theme
  // whose art all fails to resolve is broken, one missing a user-supplied GIF
  // is not. An always-true check reporting "PASS ... 1 missing" was worse than
  // no check at all.
  // A theme whose art is ALL per-system templates (${system.theme}) has no
  // literal paths to resolve at this level -- romdeck-default is one -- so
  // "zero resolved" there is correct, not a failure. Only assert when the
  // theme actually references literal files.
  if (sysStats.resolvedImages + sysStats.missingImages > 0) {
    r.check('theme art resolves', sysStats.resolvedImages > 0,
      `${sysStats.resolvedImages} resolved, ${sysStats.missingImages} absent`);
  } else {
    console.log('SKIP: this theme references only per-system art templates');
  }

  console.log(`  wrote ${sysShot}`);
  console.log(`  wrote ${gameShot}`);
  return r.done(`${name} renders`);
  });
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
  const missingList = [];
  let resolvedImages = 0;
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
      // "./none" is a deliberate SENTINEL, not a broken path: adroit uses it
      // seven times to mean "this variant has no background". And a theme may
      // reference art the USER supplies (adroit's background.gif is not in the
      // repo). Neither is a resolution failure on our side, so counting them
      // reported a working theme as broken.
      if (/(^|\/)none$/.test(v)) continue;
      if (!app.stage.img(v) && !app.svc.resolveUrl(v)) {
        missingImages++;
        missingList.push(v.split('/').slice(-2).join('/'));
      } else {
        resolvedImages++;
      }
    }
  }

  return {
    distinctColors: counts.size,
    coverage: 1 - dominance,
    nearlyBlank: dominance > 0.985 || counts.size < 3,
    unresolved,
    missingImages,
    missingList,
    resolvedImages,
    width,
    height,
  };
}

// ── --shots: every surface renders, and is looked at ─────────────────
/**
 * Capture and ASSERT ON every visual surface.
 *
 * Replaces the Electron build's --bigshot / --themeshot / --uishot, which
 * wrote PNGs and asserted nothing: they proved a capture succeeded, not that
 * anything was drawn. Three defects shipped past green assertions and were
 * caught only by a human opening the file (a white stage from a tinted 1x1
 * box.png, literal ${system.fullName} printed three times, the focus ring
 * and details panel describing different games). The pixels were always the
 * evidence; nothing was checking them.
 *
 * Two things this does that paintStats alone cannot:
 *   - It composites like App.render does, so MENUS, THE KEYBOARD, THE FILE
 *     BROWSER and TOASTS are in the captured frame. paintStats re-paints the
 *     stage only, so no check has ever asserted a single menu pixel.
 *   - It compares surfaces to each other. "Not blank" is weak; a menu that
 *     opens but paints nothing is IDENTICAL to the view behind it, and only
 *     a difference test catches that.
 *
 * PNGs still land in the output dir, because the lesson from those three
 * defects is that someone should be able to look.
 */
export async function shots({ romsDir, argAfter }) {
  const r = makeReporter('SHOTS');
  // Only treat the next argument as an output dir if it is NOT the ROMs
  // folder -- that one is also a bare argument, and swallowing it here would
  // silently scatter PNGs into the user's library.
  const next = argAfter('shots');
  const outDir = next && next !== romsDir ? next : '/tmp/romdeck-shots';
  mkdirSync(outDir, { recursive: true });

  return withApp({ romsDir, headless: true }, async (app) => {
  // --shots --theme <name> renders these surfaces under a REAL community
  // theme. Without it every run used whatever is in prefs, so three "runs
  // against different themes" silently produced byte-identical numbers.
  const themeArg = argAfter('theme');
  if (themeArg) {
    // setTheme, not loadTheme: loadTheme returns { theme } and silently falls
    // back to the bundled theme when one is missing, which would report a
    // community theme's name while rendering Shelf.
    await app.setTheme(themeArg, {});
    if (app.stage.theme?.name !== themeArg) {
      console.log(`SKIP: theme ${themeArg} is not installed (got ${app.stage.theme?.name})`);
      return 0;
    }
  }
  await app.stage.preload();
  const sel = app.stage.theme?.selected ?? {};
  console.log(`SHOTS theme: ${app.stage.theme?.displayName ?? '(none)'} `
    + `[${sel.variant ?? '-'} / ${sel.aspectRatio ?? '-'} / ${sel.colorScheme ?? '-'}]`);
  // The stage is a fixed 1920x1080 design space, so a theme offering several
  // aspect ratios must be laid out for 16:9. Defaulting to "first declared"
  // picked art-book-next's 32:9 block and rendered an ultrawide layout onto a
  // 16:9 stage -- every element drew, every count was right, and the result
  // looked nothing like the theme.
  // The loaded model carries only `selected`; the declared list lives on the
  // discovered theme entry, so ask the store rather than the model.
  const declared = app.svc.themes.find(app.stage.theme?.name)?.aspectRatios ?? [];
  if (declared.length > 1) {
    r.check('theme laid out for the stage ratio', sel.aspectRatio === '16:9',
      `${sel.aspectRatio ?? '(none)'} of ${declared.length} declared`);
  }

  const shot = (label) => {
    // app.render() composites stage + menus + browser + keyboard + toasts,
    // which is the whole point: capture what the user would see.
    const canvas = app.render();
    const png = canvas.toBuffer('image/png');
    const file = path.join(outDir, `${label}.png`);
    writeFileSync(file, png);
    const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
    const counts = new Map();
    for (let i = 0; i < data.length; i += 4 * 7) {
      const key = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    let top = 0; let total = 0;
    for (const n of counts.values()) { total += n; if (n > top) top = n; }
    return { label, file, png, colors: counts.size, dominance: top / Math.max(1, total) };
  };


  // getImageData throws if the rect leaves the canvas, and a theme is free to
  // place an element partly off-stage (art-book-next does). Clamp rather than
  // let a legitimate layout crash the check.
  const readRect = (ctx2, bx) => {
    const x0 = Math.max(0, Math.round(bx.x));
    const y0 = Math.max(0, Math.round(bx.y));
    const x1 = Math.min(STAGE_W, Math.round(bx.x + bx.w));
    const y1 = Math.min(STAGE_H, Math.round(bx.y + bx.h));
    if (x1 <= x0 || y1 <= y0) return null;
    return ctx2.getImageData(x0, y0, x1 - x0, y1 - y0);
  };

  const captured = [];
  const capture = (label) => {
    const s = shot(label);
    captured.push(s);
    r.check(`${label} renders`, s.colors >= 3 && s.dominance <= 0.985,
      `${s.colors} colours, ${((1 - s.dominance) * 100).toFixed(1)}% non-background`);
    return s;
  };

  // The two themed views. system -> gamelist is the navigation that the
  // Electron --bigshot exercised.
  const system = capture('system-view');

  // System artwork must keep its COLOUR. ES-DE's <color>/<imageColor>
  // MULTIPLIES -- white means unchanged -- and compositing it with source-in
  // instead replaced every pixel, turning art-book-next's system panels into
  // flat grey silhouettes. Every "not blank" test passed: a silhouette has
  // pixels. Saturation is what tells them apart.
  {
    const sd = readRect(app.render().getContext('2d'),
      { x: 0, y: STAGE_H * 0.15, w: STAGE_W, h: STAGE_H * 0.7 });
    let saturated = 0;
    let sampled = 0;
    for (let i = 0; sd && i < sd.data.length; i += 4 * 17) {
      const mx = Math.max(sd.data[i], sd.data[i + 1], sd.data[i + 2]);
      const mn = Math.min(sd.data[i], sd.data[i + 1], sd.data[i + 2]);
      sampled++;
      if (mx > 40 && mx - mn > 30) saturated++;
    }
    const pct = sampled ? (saturated / sampled) * 100 : 0;
    // Only meaningful where the SOURCE art is colour. A monochrome logo set
    // tinted with a grey token is the theme rendering exactly as designed --
    // asserting on it would be demanding colour the theme never had. Decide
    // from the file on disk, not from the render being graded.
    const carousel = app.stage.elements().find((e) => e.type === 'carousel');
    const srcUrl = carousel && app.stage.perSystem(
      carousel.props.staticImage ?? carousel.props.imagePath ?? carousel.props.path,
      app.stage.currentSystem());
    const srcImg = srcUrl ? app.stage.img(srcUrl) : null;
    let srcColour = false;
    if (srcImg) {
      const probe = createCanvas(64, 64);
      const pctx = probe.getContext('2d');
      pctx.drawImage(srcImg, 0, 0, 64, 64);
      const pd = pctx.getImageData(0, 0, 64, 64).data;
      for (let i = 0; i < pd.length; i += 4) {
        const mx = Math.max(pd[i], pd[i + 1], pd[i + 2]);
        const mn = Math.min(pd[i], pd[i + 1], pd[i + 2]);
        if (pd[i + 3] > 40 && mx > 40 && mx - mn > 30) { srcColour = true; break; }
      }
    }
    if (srcColour) {
      r.check('system artwork keeps its colour', pct > 2,
        `${pct.toFixed(1)}% of sampled pixels are saturated`);
    } else {
      console.log(`SKIP: this theme's system art is monochrome (${pct.toFixed(1)}% saturated)`);
    }
  }

  // The selected logo must be VISIBLE against its own card, which "not blank"
  // cannot tell you: a view full of panels and help text has plenty of colour
  // variance while every logo on it is invisible. That is not hypothetical --
  // the bundled logos shipped as fill="currentColor", which has no meaning
  // outside a CSS cascade and rasterises to BLACK, and <imageColor>
  // MULTIPLIES, so no tint could ever lift them. Near-black glyphs on a
  // near-black card passed every check here while the carousel read as empty.
  //
  // Measure contrast where the art actually is: the brightest pixels in the
  // selected card have to stand off that card's own background.
  {
    // Sample the INTERIOR of the selected card. The selector border is drawn
    // in the accent colour and is bright by definition, so a rect that
    // includes it reports high contrast no matter how invisible the logo is —
    // that is exactly how a first cut of this check passed a black-on-black
    // carousel. Inset well inside the border and measure only the art.
    const b = {
      x: STAGE_W * 0.415, y: STAGE_H * 0.27, w: STAGE_W * 0.17, h: STAGE_H * 0.30,
    };
    const d = readRect(app.render().getContext('2d'), b);
    if (d) {
      const lum = [];
      for (let i = 0; i < d.data.length; i += 4) {
        lum.push(0.299 * d.data[i] + 0.587 * d.data[i + 1] + 0.114 * d.data[i + 2]);
      }
      lum.sort((x, y) => x - y);
      // Median is the card; the 99th percentile is the glyph strokes on it.
      const bg = lum[Math.floor(lum.length * 0.5)];
      const fg = lum[Math.floor(lum.length * 0.99)];
      r.check('selected system logo is visible on its card', fg - bg > 24,
        `logo ${fg.toFixed(0)} vs card ${bg.toFixed(0)} (contrast ${(fg - bg).toFixed(0)})`);
    }
  }
  app.dispatch('confirm');
  for (let i = 0; i < 2; i++) app.dispatch('down');
  // Art loads lazily on a cache MISS, so the first paint after moving the
  // selection has no cover yet. Capturing straight away photographed an empty
  // plate and shipped it as the reference screenshot of the gamelist — the
  // view looked like a library with no art at all. Start the fetch, let it
  // land, then shoot. (The dedicated cover assertion below already did this;
  // the headline screenshot did not.)
  app.render();
  await new Promise((res) => setTimeout(res, 2000));
  const gamelist = capture('gamelist-view');
  r.check('gamelist differs from system view',
    Buffer.compare(system.png, gamelist.png) !== 0);

  // The game list itself must have games in it. modern-es-de declares
  // `zIndex 0` on its background and nothing on anything else, relying on
  // ES-DE's PER-TYPE defaults; defaulting everything to 0 let the background
  // tie with the list and paint over it. The view was a full gamelist screen
  // with no game names on it, and every count-based assertion passed.
  const list = app.stage.elements().find((e) => e.type === 'textlist');
  if (list) {
    const lb = app.stage.box(list.props);
    const ld = readRect(app.render().getContext('2d'), lb);
    const lseen = new Set();
    for (let i = 0; ld && i < ld.data.length; i += 4 * 13) {
      lseen.add((ld.data[i] << 16) | (ld.data[i + 1] << 8) | ld.data[i + 2]);
    }
    r.check('game list has games in it', lseen.size >= 5,
      `${lseen.size} colours in the list box`);
  }

  // Every element the theme declares must actually put pixels somewhere, or
  // be legitimately empty (no media, no metadata for this game). Comparing
  // against art-book-next's own README screenshots is what surfaced these:
  // the rating rail drew text stars instead of the theme's star SVGs, and the
  // help row -- OPTIONS/MENU/SELECT along the bottom -- never drew at all
  // because <helpsystem> carries no <text> and fell through the text branch.
  // Art loads lazily on a cache miss, so give the first paint's fetches time
  // to land BEFORE grading any pixels. Sampling first and waiting later read
  // the rating rail while its star SVGs were still in flight and called a
  // working element blank.
  app.render();
  await new Promise((res) => setTimeout(res, 2000));

  for (const [type, label] of [['rating', 'rating rail'], ['helpsystem', 'help prompts']]) {
    const els = app.stage.elements().filter((e) => e.type === type
      && e.props.scope !== 'menu' && e.props.scope !== 'none');
    if (!els.length) continue;
    const eb = app.stage.box(els[0].props);
    // Both are short rows whose <pos> is an ANCHOR, with <origin> deciding
    // which way they extend -- modern's help row is right-anchored at x=1843,
    // art-book-next's rating has w=0 until its star art loads. A fixed band
    // hung off the raw box samples empty stage and reports a working element
    // as blank, so centre the band on the anchor and let it reach both ways.
    const bw = Math.max(eb.w, 420);
    const bh = Math.max(eb.h, 56);
    const [ox, oy] = els[0].props.origin ?? [0, 0];
    const band = {
      x: eb.x - (ox > 0.5 ? bw : ox > 0 ? bw / 2 : 0),
      y: eb.y - (oy > 0.5 ? bh : oy > 0 ? bh / 2 : 0),
      w: bw,
      h: bh,
    };
    const bd = readRect(app.render().getContext('2d'), band);
    const bseen = new Set();
    for (let i = 0; bd && i < bd.data.length; i += 4 * 7) {
      bseen.add((bd.data[i] << 16) | (bd.data[i + 1] << 8) | bd.data[i + 2]);
    }
    r.check(`${label} renders`, bseen.size > 3, `${bseen.size} colours`);
  }

  // Metadata must actually reach the themes. Every theme has developer /
  // publisher / genre / release-date fields and NOTHING ever populated them,
  // so all four rendered a column of "Unknown" while every assertion passed.
  // Dates additionally need formatting: they are stored as ES-DE timestamps
  // (19990801T000000) and went on screen verbatim.
  {
    const lib = app.svc.library().roms;
    const withMeta = lib.filter((r) => r.meta?.developer || r.meta?.genre
      || r.meta?.publisher || r.meta?.releasedate);
    if (withMeta.length) {
      r.check('library has scraped metadata', true,
        `${withMeta.length}/${lib.length} games`);
      const dated = lib.find((rom) => rom.meta?.releasedate);
      if (dated) {
        const shown = formatDate(dated.meta.releasedate, undefined);
        r.check('release dates are formatted, not raw', /^\d{4}-\d{2}-\d{2}$/.test(shown),
          `${dated.meta.releasedate} -> ${shown}`);
      }
    } else {
      console.log('SKIP: no scraped metadata in this library');
    }
  }

  // Auto-collections. These are systems with a different `short`, so every
  // themed element works on them unchanged -- and they are what makes
  // systemNameSuffix reachable at all, since it is gated on isCollection.
  {
    const beforePref = app.svc.prefs.get('collections');
    app.svc.prefs.set('collections', ['auto-allgames', 'auto-lastplayed', 'auto-favorites']);
    const roms = app.svc.library().roms;
    const favBefore = roms[0]?.meta?.favorite;
    if (roms[0]) roms[0].meta.favorite = true;
    app.stage.setLibrary(roms);
    const colls = app.stage.systems.filter((sy) => sy.isCollection);
    r.check('auto-collections appear', colls.length >= 2,
      colls.map((c) => `${c.short}:${c.roms.length}`).join(' '));
    const all = colls.find((c) => c.short === 'auto-allgames');
    const favs = colls.find((c) => c.short === 'auto-favorites');
    // "all games" must span systems; favorites must contain only favorites.
    if (all) {
      const systems = new Set(all.roms.map((rom) => rom.system));
      r.check('all-games spans systems', systems.size > 1, `${systems.size} systems`);
    }
    if (favs) {
      r.check('favorites holds only favorites',
        favs.roms.every((rom) => rom.meta?.favorite === true || rom.meta?.favorite === 'true'),
        `${favs.roms.length} games`);
    }
    if (roms[0]) roms[0].meta.favorite = favBefore;
    app.svc.prefs.set('collections', beforePref ?? []);
    app.stage.setLibrary(app.svc.library().roms);
  }

  // Carousel transitions and texture filtering -- the last two audit entries
  // with observable behaviour. The slide cannot show in a still, but the
  // easing curve and its settling can be driven directly.
  {
    // The carousel is a SYSTEM-view element and this block runs after the
    // check navigated into the gamelist, so look there explicitly rather than
    // in the current view's element list.
    const wasView = app.stage.view;
    app.stage.view = 'system';
    const car = app.stage.elements().find((e) => e.type === 'carousel');
    if (car && app.stage.systems.length > 1) {
      const from = app.stage.sysIndex;
      app.stage.sysIndex = (from + 1) % app.stage.systems.length;
      const started = app.stage.startCarouselSlide(from, false);
      const at0 = app.stage.carouselOffset;
      app.stage.tickCarousel(200);
      const mid = app.stage.carouselOffset;
      app.stage.tickCarousel(200);
      const end = app.stage.carouselOffset;
      r.check('carousel eases and settles',
        started && Math.abs(at0) === 1 && Math.abs(mid) < 1 && Math.abs(mid) > 0 && end === 0,
        `${at0} -> ${mid.toFixed(3)} -> ${end}`);
      // "instant" must not animate at all.
      const was = car.props.itemTransitions;
      car.props.itemTransitions = 'instant';
      r.check('itemTransitions instant does not animate',
        app.stage.startCarouselSlide(from, false) === false);
      car.props.itemTransitions = was;
      app.stage.sysIndex = from;
      app.stage.carouselOffset = 0;
    }
    app.stage.view = wasView;

    // <interpolation> nearest vs linear must change scaled pixels.
    // Only a SCALED image can show a filtering difference; a 1:1 blit is
    // identical either way, and grading one would be asserting nothing.
    let icon = null;
    let img = null;
    let ib = null;
    for (const e of app.stage.elements()) {
      if (e.type !== 'image' || typeof e.props.path !== 'string'
        || e.props.path.includes('${')) continue;
      // Skip the box.png / tiled-1x1 FILL idiom: it takes drawImage's early
      // return and paints a solid rect, so filtering can never show there.
      if (e.props.tile === 'true' || /(^|\/)box\.(png|svg)$/i.test(e.props.path)) continue;
      const candidate = app.stage.img(app.stage.perSystem(e.props.path));
      if (!candidate) continue;
      const box = app.stage.box(e.props, candidate);
      if (box.w <= 8 || Math.abs(box.w - candidate.width) <= 8) continue;
      // The source must have DETAIL. slate's frame.png is a uniform 8x8 that
      // scales to 768px identically under either filter, so grading it
      // asserted nothing -- a flat source cannot show a filtering difference.
      const probe = createCanvas(Math.min(32, candidate.width), Math.min(32, candidate.height));
      const pctx = probe.getContext('2d');
      pctx.drawImage(candidate, 0, 0, probe.width, probe.height);
      const pd = pctx.getImageData(0, 0, probe.width, probe.height).data;
      const seen = new Set();
      for (let k = 0; k < pd.length; k += 4) seen.add((pd[k] << 16) | (pd[k + 1] << 8) | pd[k + 2]);
      if (seen.size < 4) continue;
      icon = e; img = candidate; ib = box; break;
    }
    if (!icon) {
      console.log('SKIP: no scaled, detailed image in this view to filter');
    } else {
      {
        const grab = () => {
          app.invalidate();
          return Uint8ClampedArray.from(readRect(app.render().getContext('2d'), ib)?.data ?? []);
        };
        const wasI = icon.props.interpolation;
        icon.props.interpolation = 'linear';
        const lin = grab();
        icon.props.interpolation = 'nearest';
        const near = grab();
        let d = 0;
        for (let i = 0; i < lin.length && i < near.length; i += 4) if (lin[i] !== near[i]) d++;
        r.check('interpolation filters scaled images', d > 20, `${d} px differ`);
        icon.props.interpolation = wasI;
      }
    }
  }

  // The last four audit entries. All time-based, so they are driven directly
  // rather than photographed: a still frame cannot show a 325ms fade.
  {
    // <fastScrolling> picks a scroll TIER; the tables are ES-DE's (IList.h:60).
    const slow = [0, 600, 2000].map((t) => app.stage.scrollInterval(t, false));
    const fast = [0, 600, 2000].map((t) => app.stage.scrollInterval(t, true));
    r.check('fastScrolling ramps faster',
      slow.join() === '500,200,200' && fast.join() === '500,180,80',
      `slow ${slow.join('/')} vs fast ${fast.join('/')}`);

    // <iterationCount> + <onIterationsDone> image: the snap stops after N
    // loops and the still takes over.
    const vid = app.stage.elements().find((e) => e.type === 'video');
    if (vid) {
      const wasCount = vid.props.iterationCount;
      const wasDone = vid.props.onIterationsDone;
      const wasSnap = app.stage.snap;
      const W = 32;
      const data = new Uint8ClampedArray(W * W * 4);
      for (let i = 0; i < W * W; i++) {
        data[i * 4] = 255; data[i * 4 + 2] = 255; data[i * 4 + 3] = 255;
      }
      app.stage.snap = { loops: 0, frame: { width: W, height: W, data } };
      vid.props.iterationCount = '2';
      vid.props.onIterationsDone = 'image';
      app.stage.markSnapDelay(Date.now() - 99999);
      const vb = app.stage.box(vid.props);
      const snapPx = () => {
        app.invalidate();
        const d = readRect(app.render().getContext('2d'), vb);
        let n = 0;
        for (let i = 0; d && i < d.data.length; i += 4) {
          if (d.data[i] > 200 && d.data[i + 1] < 60 && d.data[i + 2] > 200) n++;
        }
        return n;
      };
      const looping = snapPx();
      app.stage.snap.loops = 2;
      const stopped = snapPx();
      r.check('iterationCount stops the snap', looping > 100 && stopped === 0,
        `${looping} px looping, ${stopped} after ${vid.props.iterationCount} loops`);
      vid.props.iterationCount = wasCount;
      vid.props.onIterationsDone = wasDone;
      app.stage.snap = wasSnap;
    }
  }

  // <systemstatus>: battery / wifi / bluetooth from sysfs. The VALUES are
  // the machine's, so the assertion is that the element draws something when
  // there is something to report -- not that a specific icon appears.
  {
    const el = app.stage.elements().find((e) => e.type === 'systemstatus'
      && e.props.scope !== 'none');
    if (el) {
      const st = app.svc.deviceStatus();
      const reportable = !!(st.bluetooth?.on || st.wifi || st.battery);
      const eb = app.stage.box(el.props);
      const [ox, oy] = el.props.origin ?? [0, 0];
      const h = Math.max(0.01, Math.min(0.5, Number(el.props.height ?? 0.03))) * STAGE_H;
      const band = { x: eb.x - ox * 340, y: eb.y - oy * h, w: 340, h: Math.max(h, 40) };
      const sd = readRect(app.render().getContext('2d'), band);
      let lit = 0;
      for (let i = 0; sd && i < sd.data.length; i += 4) if (sd.data[i] > 90) lit++;
      if (reportable) r.check('system status draws', lit > 40, `${lit} lit px`);
      else console.log('SKIP: nothing to report on this machine');
    }
  }

  // Scrolling containers. The animation cannot show in a still, but the
  // MECHANISM can be driven directly: text sits still for the start delay,
  // then advances, then holds at the end. Also guards the repaint policy --
  // the timer must not exist when nothing overflows.
  {
    const el = app.stage.elements().find((e) => e.props.metadata === 'description');
    if (el) {
      const game = app.stage.currentGame();
      const descBefore = game?.meta?.desc;
      if (game) game.meta.desc = 'word '.repeat(400);
      app.invalidate();
      app.render();
      const boxH = app.stage.box(el.props).h;
      if ((el._contentH ?? 0) > boxH) {
        const delay = Number(el.props.containerStartDelay ?? 4.5) * 1000;
        app.stage.tickScroll(el, el._contentH, boxH, delay - 500);
        const held = el._scroll.pos;
        app.stage.tickScroll(el, el._contentH, boxH, 4000);
        const moved = el._scroll.pos;
        r.check('container holds, then scrolls', held === 0 && moved > 0,
          `${held}px during the delay, ${Math.round(moved)}px after`);
        el._scroll = null;
      } else {
        console.log('SKIP: description does not overflow its box');
      }
      if (game) game.meta.desc = descBefore;
      app.invalidate();
      app.render();
      app.updateScroll();
      r.check('no scroll timer when nothing scrolls', !app._scrollTimer);
    }
  }

  // Custom collections: created, persisted in ES-DE's .cfg format, and shown
  // as a system. The editing mode is what collectionIndicators marks.
  {
    const dir = app.svc.romsDir();
    const NAME = '__romdeck_check__';
    app.svc.collections.remove(NAME);
    r.check('custom collection created', app.svc.collections.create(NAME));
    const roms = app.svc.library().roms;
    if (roms.length >= 2) {
      app.svc.collections.toggle(NAME, roms[0].path, dir);
      app.svc.collections.toggle(NAME, roms[1].path, dir);
      // Stored with %ROMPATH% so the collection survives the library moving.
      const raw = readFileSync(path.join(app.svc.userData, 'collections', `custom-${NAME}.cfg`), 'utf8');
      r.check('stored in ES-DE format', raw.includes('%ROMPATH%'), raw.split('\n')[0]);
      r.check('reads back to real paths',
        app.svc.collections.read(NAME, dir).every((pth) => existsSync(pth)));
      app.stage.setLibrary(app.svc.library().roms);
      const cs = app.stage.systems.find((sy) => sy.isCustom);
      r.check('custom collection is a system', cs?.roms.length === 2,
        `${cs?.name} · short=${cs?.short}`);
      // Membership marks only appear while editing.
      app.stage.editingCollection = NAME;
      r.check('editing marks membership',
        app.svc.collections.has(NAME, roms[0].path, dir)
        && !app.svc.collections.has(NAME, roms[roms.length - 1].path, dir));
      app.stage.editingCollection = null;
    }
    app.svc.collections.remove(NAME);
    app.stage.setLibrary(app.svc.library().roms);
  }

  // Badges and grid: whole ELEMENT TYPES that never drew. Badges only appear
  // for a game with the metadata set, and grid only in a grid variant, so
  // neither was reachable from the default view -- they were "implemented"
  // and no render ever exercised them.
  {
    const badgeEl = app.stage.elements().find((e) => e.type === 'badges');
    if (badgeEl) {
      const game = app.stage.currentGame();
      const before = game?.meta?.favorite;
      const bb = app.stage.box(badgeEl.props);
      // The badge box sits OVER the cover art in some themes, so an absolute
      // colour count there is really counting the artwork -- it passed with
      // badge drawing disabled entirely. Compare the same region with and
      // without the badge instead: the badge must CHANGE those pixels.
      if (game) game.meta.favorite = false;
      app.render();
      await new Promise((res) => setTimeout(res, 1200));
      // COPY the pixels. readRect hands back an ImageData whose buffer the
      // next render reuses, so holding two of them compares a frame with
      // itself -- which is why this passed with badge drawing deleted.
      // repaint() forces a fresh frame; app.render() alone can hand back the
      // cached one, so both samples were the same frame.
      const frame = () => { app.invalidate(); return app.render().getContext('2d'); };
      const off = Uint8ClampedArray.from(readRect(frame(), bb)?.data ?? []);
      if (game) game.meta.favorite = true;
      const on = Uint8ClampedArray.from(readRect(frame(), bb)?.data ?? []);
      let diff = 0;
      for (let i = 0; i < off.length && i < on.length; i += 4) {
        if (off[i] !== on[i] || off[i + 1] !== on[i + 1] || off[i + 2] !== on[i + 2]) diff++;
      }
      // A theme with no customBadgeIcon for the slot legitimately draws
      // nothing: ES-DE falls back to its own :/graphics icons, which we do
      // not ship. Only assert where the theme supplies art.
      const hasIcon = !!badgeEl.props['customBadgeIcon:favorite'];
      // Threshold in proportion to the CELL, not an absolute: modern's badge
      // cell is 44px where art-book-next's is ~80, so a flat 200px floor
      // failed a badge that was drawing correctly.
      const cell = Math.max(1, Math.min(bb.w, bb.h) / Math.max(1, Number(badgeEl.props.itemsPerLine ?? 4)));
      if (hasIcon) {
        r.check('badges render', diff > cell * 2,
          `${diff} px change when favorited (cell ~${Math.round(cell)}px)`);
      }
      else console.log('SKIP: theme supplies no badge icons');
      if (game) game.meta.favorite = before;
    }
  }

  // Box art for the SELECTED game, which is not the one selected at boot.
  // preload() warmed only the theme's assets plus the boot selection, so
  // every other game drew an empty plate -- a library frontend with no cover
  // art, passing every assertion because the element existed and the stage
  // was not blank. Assert on the plate's PIXELS: flat means nothing loaded.
  const coverUrl = app.stage.meta('game.cover');
  // Find the theme's OWN cover element rather than hardcoding the default
  // theme's plate position -- against a community theme those coordinates
  // land on empty background, so the check silently graded the wrong pixels.
  // …and pick the element that shows THE COVER, not merely the first one with
  // an imageType. modern-es-de's first match is its marquee slot, which is
  // correctly empty (no marquees are scraped), so grading that box reported a
  // blank cover on a theme that renders one perfectly.
  const COVER_TYPES = new Set(['cover', 'image']);
  const coverEl = app.stage.elements().find((e) => (e.type === 'image' || e.type === 'video')
    && (e.props.metadata === 'game.cover' || COVER_TYPES.has(e.props.imageType)));
  if (coverUrl && coverEl) {
    app.render();                                  // miss starts the fetch
    await new Promise((res) => setTimeout(res, 2000));
    shot('gamelist-cover');
    const b = app.stage.box(coverEl.props, app.stage.img(coverUrl));
    const px = readRect(app.render().getContext('2d'), b);
    const seen = new Set();
    for (let i = 0; px && i < px.data.length; i += 4 * 11) {
      seen.add((px.data[i] << 16) | (px.data[i + 1] << 8) | px.data[i + 2]);
    }
    r.check('selected game cover renders', seen.size > 40,
      `${seen.size} colours in the cover plate`);
  } else {
    console.log('SKIP: no cover art in this library');
  }

  // Overlay surfaces. Each must CHANGE the frame -- a menu that opens and
  // paints nothing passes every "not blank" test on the view behind it.
  const base = shot('_base');
  for (const [label, open] of [
    ['menu', () => app.dispatch('menu')],
    ['keyboard', () => app.keyboard.open({ title: 'Search', value: '', onCommit() {} })],
    ['browser', () => app.browser.open({ start: romsDir, onPick() {} })],
  ]) {
    open();
    const s = capture(label);
    r.check(`${label} changes the frame`, Buffer.compare(base.png, s.png) !== 0);

    // …and the surface must be READABLE over whatever is behind it. Widgets
    // fill unfocused rows with rgba(255,255,255,0.03), so bright box art read
    // straight through the key caps and half the keyboard was illegible. A
    // scrim cannot fix that. Sample the surface's own area: if the content
    // behind it is bleeding through, the pixels there are not near-neutral.
    // Only the keyboard lays out bare widgets over the stage; the menu and
    // browser draw their own opaque panels, so there is nothing to sample.
    const widgets = label === 'keyboard' ? app.keyboard.keys : [];
    if (widgets.length) {
      const ctx2 = app.render().getContext('2d');
      // The FOCUSED cap is skipped: its fill is the theme's accent, and a
      // light theme (Modern) paints it near-white on purpose. Judging it by
      // "a cap is dark" flags correct rendering as bleed-through.
      const kbGroup = focus.groups.get(app.keyboard.name);
      const kbLive = kbGroup?.live() ?? [];
      const kbFocused = kbLive[Math.min(kbGroup?.index ?? 0, Math.max(0, kbLive.length - 1))];
      let bleed = 0;
      for (const w of widgets) {
        if (w === kbFocused) continue;
        // Sample the cap's INNER CORNER, not its centre: the wide action keys
        // ("Delete", "Space", "Done", "Cancel") have their label text through
        // the middle, and light grey glyph pixels look exactly like bleed to a
        // saturation test. The corner is padding on every key.
        const d = ctx2.getImageData(Math.round(w.x + 6), Math.round(w.y + 6), 1, 1).data;
        // A key cap is a dark neutral. Saturated or bright means art behind.
        const max = Math.max(d[0], d[1], d[2]);
        const min = Math.min(d[0], d[1], d[2]);
        if (max - min > 28 || max > 120) bleed++;
      }
      r.check(`${label} is opaque over content`, bleed === 0,
        bleed ? `${bleed}/${widgets.length} cells show what is behind them` : `${widgets.length} cells solid`);
    }
    // Close it again so the next surface opens over a clean frame.
    while (app.menus.depth) app.dispatch('back');
    app.keyboard.close?.();
    app.browser.close?.();
  }

  console.log(`SHOTS wrote ${captured.length} PNGs to ${outDir}`);
  return r.done(`${captured.length} surfaces captured and asserted`);
  });
}

// ── --snapcheck: video snaps actually decode ─────────────────────────
/**
 * Verify the WASM decoder against real files.
 *
 * Asserts on PIXELS, not on "it returned without throwing": a decoder that
 * emits uniformly black frames passes every structural check and is useless.
 */
export async function snapcheck({ argAfter }) {
  const r = makeReporter('SNAPCHECK');
  const { SnapPlayer, decoderAvailable } = await import('./video/player.js');
  // Only take the next argument if it actually looks like a video: the ROMs
  // folder is also a bare argument, and treating it as a file made the check
  // "fail" on a directory it was never asked about.
  const next = argAfter('snapcheck');
  const explicit = next && /\.(mp4|m4v)$/i.test(next) ? next : null;
  const candidates = explicit ? [explicit] : [
    path.join(process.env.HOME ?? '', 'code/cliemu/node-sdl/examples/09-ffmpeg-video/assets/video.mp4'),
    path.join(process.env.HOME ?? '', 'code/cliemu/three.js/examples/textures/pano.mp4'),
  ];
  const files = candidates.filter((f) => existsSync(f));

  if (!decoderAvailable()) {
    console.log('SKIP: decoder not built (scripts/build-video-decoder.sh)');
    console.log('SNAPCHECK OK — absent decoder degrades to the static image');
    return 0;
  }
  if (!files.length) {
    console.log('SKIP: no sample videos on this machine');
    return 0;
  }

  for (const file of files) {
    const p = new SnapPlayer();
    const loaded = await p.load(file);
    const name = path.basename(file);
    r.check(`${name}: demuxed and opened`, loaded);
    if (!loaded) continue;

    let frames = 0;
    for (let i = 0; i < 40; i++) {
      p.startedAt = Date.now() - i * 80;
      if (p.tick()) frames++;
    }
    r.check(`${name}: decodes frames`, frames > 10, `${frames} frames`);
    const f = p.frame;
    r.check(`${name}: frame has dimensions`, !!f && f.width > 0 && f.height > 0,
      f ? `${f.width}x${f.height}` : 'none');
    if (f) {
      // A black frame is what a broken colour conversion produces, and it
      // passes every structural assertion.
      let lit = 0;
      for (let i = 0; i < f.data.length; i += 4) {
        if (f.data[i] > 25 || f.data[i + 1] > 25 || f.data[i + 2] > 25) lit++;
      }
      r.check(`${name}: picture is not blank`, lit > f.width * f.height * 0.05,
        `${lit} lit of ${f.width * f.height}`);
    }
    p.close();
  }

  // Absent files must degrade, never throw.
  const missing = new SnapPlayer();
  r.check('a missing file degrades quietly', (await missing.load('/nope/none.mp4')) === false);
  r.check('a non-MP4 degrades quietly', (await missing.load('/etc/hostname')) === false);

  return r.done('snaps decode to real pictures');
}
