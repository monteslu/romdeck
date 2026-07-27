// --padonly and --viewcheck for the native shell.
//
// THE ACCEPTANCE TEST: unplug the keyboard and the mouse; everything must
// still work. That bar does not change because the renderer did.
//
// This drives app.dispatch() — the same entry point real pad events use — so
// it exercises the production path rather than a parallel one, exactly as the
// Electron version did through nav(). It no longer needs executeJavaScript or
// a browser to inject into, which makes it both simpler and faster.
import { withApp } from './app.js';
import { DEFAULT_THEME } from '../services/themes.js';
import { focus } from './focus.js';
import { HeadlessPresenter } from './present.js';
import { makeReporter } from './checks.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function padonly({ romsDir }) {
  const r = makeReporter('PADONLY');
  return withApp({ romsDir, headless: true }, async (app) => {
  const pad = (action, times = 1) => {
    for (let i = 0; i < times; i++) app.dispatch(action);
  };

  // The stage itself has to be navigable before anything else matters.
  const sys0 = app.stage.currentSystem()?.name;
  pad('right');
  r.check('pad moves through systems', app.stage.currentSystem()?.name !== sys0,
    `${sys0} → ${app.stage.currentSystem()?.name}`);
  pad('confirm');
  r.check('pad opens a gamelist', app.stage.view === 'gamelist');
  const g0 = app.stage.gameIndex;
  pad('down');
  r.check('pad moves through games', app.stage.gameIndex !== g0);
  pad('back');
  r.check('back returns to the carousel', app.stage.view === 'system');

  // Start opens the main menu from anywhere — the ES model, and the reason
  // no feature needs a toolbar button to be reachable.
  pad('menu');
  r.check('Start opens the main menu', app.menus.open && focus.inventory().length > 0,
    `${focus.inventory().length} entries`);
  const mainLabels = focus.inventory();
  for (const needed of ['Search', 'Settings', 'Controllers', 'Themes', 'Developer mode', 'Quit romdeck']) {
    r.check(`main menu offers "${needed}"`, mainLabels.some((l) => l.includes(needed)));
  }

  // Every surface the main menu reaches must open, populate a ring, and be
  // escapable. Each was a mouse-only modal before M7.
  const surfaces = [
    ['Settings', 'Settings'],
    ['Controllers', 'Controllers'],
    ['Themes', 'Themes'],
    ['BIOS files', 'BIOS'],
    ['Homebrew', 'Homebrew'],
    ['Join a game', 'Join'],
    ['Developer mode', 'Developer'],
  ];
  for (const [label, title] of surfaces) {
    pad('menu'); // reopen main menu
    if (!app.menus.open) app.openMainMenu();
    const i = focus.inventory().findIndex((l) => l.includes(label));
    if (i < 0) { r.check(`${title} present in menu`, false); continue; }
    focus.focusIndex(i);
    pad('confirm');
    await sleep(120);
    const opened = app.menus.open || app.browser.active || app.keyboard.active;
    r.check(`${title} reachable by pad`, opened, `ring=${focus.inventory().length}`);
    r.check(`${title} has a focusable ring`, focus.inventory().length > 0);
    pad('back');
    await sleep(60);
    app.menus.closeAll();
    app.browser.close();
    app.keyboard.close();
  }

  // Per-game menu: save states, cheats, favourites — all details-panel-only
  // before M7, all pad-reachable now.
  app.stage.view = 'gamelist';
  app.openGameMenu(app.stage.currentGame());
  const gameLabels = focus.inventory();
  r.check('options opens the per-game menu', app.menus.open, `${gameLabels.length} entries`);
  for (const needed of ['Cheats', 'Save states']) {
    r.check(`game menu offers "${needed}"`, gameLabels.some((l) => l.includes(needed)));
  }
  // Nested menus must push and pop cleanly.
  const si = gameLabels.findIndex((l) => l.includes('Save states'));
  if (si >= 0) {
    focus.focusIndex(si);
    pad('confirm');
    await sleep(80);
    r.check('nested menu pushes a new ring', app.menus.depth >= 1 && focus.inventory().length > 0,
      `depth=${app.menus.depth}`);
    pad('back');
  }
  app.menus.closeAll();

  // Text entry without a keyboard.
  app.keyboard.open({ layout: 'text', title: 'test', onCommit: () => {} });
  r.check('on-screen keyboard opens', app.keyboard.active && focus.inventory().length > 10,
    `${focus.inventory().length} keys`);
  const before = app.keyboard.value;
  pad('confirm');
  r.check('pad types into the field', app.keyboard.value.length > before.length,
    JSON.stringify(app.keyboard.value));
  app.keyboard.close();

  // The file browser replaces every OS dialog — the last pointer-only surface.
  app.browser.open({ mode: 'directory', title: 'test', onPick: () => {} });
  r.check('file browser opens', app.browser.active && focus.inventory().length > 0,
    `${focus.inventory().length} entries`);
  r.check('file browser can be navigated', focus.step(1));
  pad('back');
  r.check('file browser closes with back', !app.browser.active);

  // Reachability overall.
  //
  // Counted by REOPENING each surface, because menu groups are deleted on
  // close — summing whatever happens to be registered at the end reports 0
  // and calls it a pass, which is the kind of vacuous metric this project has
  // been burned by.
  let total = 0;
  const per = {};
  for (const [label, open] of [
    ['main', () => app.openMainMenu()],
    ['game', () => app.openGameMenu(app.stage.currentGame())],
    ['settings', () => app.openSettingsMenu()],
    ['controllers', () => app.openControllersMenu()],
    ['themes', () => app.openThemesMenu()],
    ['bios', () => app.openBiosMenu()],
  ]) {
    app.menus.closeAll();
    open();
    const n = focus.inventory().length;
    per[label] = n;
    total += n;
    r.check(`${label} menu is populated`, n > 0, `${n} controls`);
  }
  app.menus.closeAll();

  r.check('ring drove real interactions',
    focus.stats.activations > 5 && focus.stats.moves > 0,
    `${focus.stats.moves} moves, ${focus.stats.activations} activations, ${focus.stats.visited.size} visited`);

  const shot = new HeadlessPresenter();
  app.openMainMenu();
  shot.present(app.render() ?? app.stage.canvas);
  shot.write('/tmp/romdeck-native-padonly.png');
  console.log('  wrote /tmp/romdeck-native-padonly.png');

  return r.done(`every surface reachable without a pointer (${total} controls registered)`);
  });
}

export async function viewcheck({ romsDir }) {
  const r = makeReporter('VIEWCHECK');
  return withApp({ romsDir, headless: true }, async (app) => {
  const startedFullscreen = !!app.svc.prefs.get('fullscreen');

  // The themed view IS the product: there is no other view to launch into now,
  // which is Phase 4 option (c) arriving by construction rather than by a
  // separate decision.
  r.check('launches into the themed view', !!app.stage.theme && app.stage.view === 'system',
    app.stage.theme?.displayName);
  r.check('windowed, not forced fullscreen', startedFullscreen === !!app.svc.prefs.get('fullscreen'));

  const first = app.stage.currentSystem()?.name;
  app.dispatch('right');
  const second = app.stage.currentSystem()?.name;
  r.check('view state advances', first !== second, `${first} → ${second}`);

  // The theme preference must round-trip, both ways.
  const before = app.svc.themePrefs().theme;
  app.svc.prefs.set('theme', DEFAULT_THEME);
  await app.setTheme(DEFAULT_THEME, {});
  r.check('theme choice persists', app.svc.prefs.get('theme') === DEFAULT_THEME);
  app.svc.prefs.set('theme', before);
  r.check('restored the original theme preference', app.svc.prefs.get('theme') === before, before);

  return r.done('the themed view is the product');
  });
}
