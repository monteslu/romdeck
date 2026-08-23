// ES-DE theme engine, main-process half: discovery + parsing.
//
// romdeck reimplements the EmulationStation/ES-DE frontend in browser tech,
// so themes are the ES-DE XML format rather than anything invented here:
//
//   <theme>/capabilities.xml   variants, colorSchemes, aspectRatios
//   <theme>/theme.xml          views + elements (the layout itself)
//
// Supported subset (documented for theme authors in docs/Themes.md):
//   views:     system, gamelist
//   elements:  image, text, carousel, textlist, rating, datetime, video
//   props:     pos, size, maxSize, origin, rotation, opacity, zIndex, visible,
//              color, backgroundColor, fontSize, horizontalAlignment,
//              verticalAlignment, path, text, metadata, lineSpacing,
//              itemScale, itemSpacing, selectedColor, secondaryColor
//   plus:      <variables>, ${var} substitution, <include>, variant/
//              colorScheme/aspectRatio filtering
//
// Anything unrecognized is ignored rather than fatal -- an unsupported theme
// renders partially instead of blowing up.
import { readFileSync, existsSync, readdirSync, statSync, rmSync, mkdirSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { XMLParser } from 'fast-xml-parser';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const BUNDLED_THEMES_DIR = path.join(__dirname, '..', '..', 'themes');
// Per-theme supplemental assets for systems the theme does not cover.
export const SUPPLEMENTS_DIR = path.join(__dirname, '..', '..', 'assets', 'theme-supplements');

/**
 * The theme romdeck uses when the user has not chosen one.
 *
 * Art Book Next: cover-art-forward, the look this app leads with. It is
 * INSTALLED ON FIRST RUN rather than bundled -- see the licence note on
 * THEME_CATALOG below -- so the first thing a new user sees is a real
 * library, not a wireframe. The ~220 MB first-run download is an accepted
 * cost of that; do not swap this back to a smaller theme to save bandwidth.
 */
export const DEFAULT_THEME = 'art-book-next-es-de';

/**
 * Themes romdeck offers to install, the way ES-DE ships a themes list.
 *
 * They are FETCHED, not bundled. Every one is CC-BY-NC-SA or similar: bundling
 * would make romdeck a redistributor of other people's artwork, with the
 * attribution and share-alike obligations that follow, and art-book-next alone
 * is 220 MB against an app that is otherwise about one. Downloading on request
 * keeps romdeck a client -- the same posture ES-DE takes -- and keeps `npx
 * romdeck` small.
 *
 * Each entry carries its licence and author so the UI can show them BEFORE
 * anything is downloaded.
 */
export const THEME_CATALOG = [
  {
    name: 'art-book-next-es-de',
    displayName: 'Art Book Next',
    author: 'Anthony Caccese',
    license: 'CC-BY-NC-SA 2.0',
    url: 'https://github.com/anthonycaccese/art-book-next-es-de.git',
    archive: 'https://github.com/anthonycaccese/art-book-next-es-de/archive/HEAD.tar.gz',
    description: 'Cover-art-forward, in the style of a coffee table book. 20 variants, 31 colour schemes.',
    size: '~220 MB',
    recommended: true,
  },
  {
    name: 'modern-es-de',
    displayName: 'Modern',
    author: 'Sophia Hadash',
    license: 'CC-BY-NC-SA',
    url: 'https://gitlab.com/es-de/themes/modern-es-de.git',
    archive: 'https://gitlab.com/es-de/themes/modern-es-de/-/archive/master/modern-es-de-master.tar.gz',
    description: 'Clean and image-driven, based on the Nintendo Switch UI.',
    size: '~60 MB',
  },
  {
    name: 'slate-es-de',
    displayName: 'Slate',
    author: 'ES-DE',
    license: 'CC-BY-NC-SA',
    url: 'https://gitlab.com/es-de/themes/slate-es-de.git',
    archive: 'https://gitlab.com/es-de/themes/slate-es-de/-/archive/master/slate-es-de-master.tar.gz',
    description: "ES-DE's own default theme.",
    size: '~20 MB',
  },
];

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: false,
  // `fontSize` is BOTH a conditional wrapper (<fontSize name="medium">) and a
  // scalar element property (<fontSize>0.032</fontSize>) -- ES-DE's own
  // ThemeData.cpp lists it as FLOAT among element properties while also
  // accepting it as a variables wrapper. Forcing it to an array made every
  // element-level fontSize parse as ["0.032"], which Number() coerces to 0
  // for a single entry only by luck and to NaN for more than one. Either way
  // the text rendered at size 0, i.e. invisibly.
  //
  // _walk() handles the wrapper case explicitly, so the array hint is only
  // needed for genuinely repeatable nodes.
  isArray: (name, jpath) => {
    if (name === 'fontSize') return /(^|\.)theme\.fontSize$/.test(jpath ?? '');
    return ['view', 'variant', 'colorScheme', 'aspectRatio', 'include',
      'language', 'variables'].includes(name);
  },
});

const ELEMENT_TYPES = new Set([
  'gameselector',
  'image', 'text', 'carousel', 'textlist', 'rating', 'datetime', 'video', 'grid',
  // Real themes lean on these constantly; parsing them (even when the renderer
  // only handles some) keeps element counts honest and layouts intact.
  'gamelistinfo', 'badges', 'helpsystem', 'clock', 'systemstatus', 'gameselector',
  'animation', 'gridtile', 'gamelist',
]);

// Wrapper elements that carry a CONDITION and nest content inside themselves.
// This is the shape §16f missed: real themes put their views inside
// <variant>/<aspectRatio>/<fontSize>/<colorScheme> blocks and reach them via
// <include> at every depth, rather than flattening conditions onto attributes.
const WRAPPER_TAGS = {
  variant: 'variant',
  colorScheme: 'colorScheme',
  aspectRatio: 'aspectRatio',
  fontSize: 'fontSize',
};

// romdeck extension: ES-DE's format has no desktop/mouse view, so a theme can
// declare <view name="desktop"> with a <colors> block (and a few layout hints)
// to skin the windowed library. Themes that don't are still fully supported --
// their <variables> are mapped onto the same tokens by convention, so every
// ES-DE theme changes the desktop look without being written for romdeck.
const DESKTOP_TOKENS = [
  'bg', 'bg2', 'panel', 'line', 'ink', 'dim', 'accent', 'accent2', 'danger',
];
// Conventional variable names themes already use, in preference order.
const TOKEN_ALIASES = {
  bg: ['bg', 'background', 'backgroundColor', 'primaryColor', 'bgColor'],
  bg2: ['bg2', 'panelBg', 'secondaryBackground', 'backgroundAlt'],
  panel: ['panel', 'panelColor', 'cardColor', 'secondaryColor'],
  line: ['line', 'border', 'borderColor', 'separator'],
  ink: ['ink', 'text', 'textColor', 'fontColor', 'primaryText'],
  dim: ['dim', 'textDim', 'secondaryText', 'subtleColor', 'unfocusedColor'],
  accent: ['accent', 'accentColor', 'selectedColor', 'highlight', 'primary'],
  accent2: ['accent2', 'accentSecondary', 'warning', 'highlight2'],
  danger: ['danger', 'error', 'errorColor', 'alert'],
};

// Props naming a file inside the theme. Real themes are image-driven, so
// these carry most of what a theme actually looks like.
const ASSET_PROPS = [
  'path', 'defaultPath', 'imagePath', 'backgroundImage', 'staticImage',
  'fontPath', 'filledPath', 'unfilledPath', 'defaultImage', 'iconPath',
];

/**
 * Is this prop a path into the theme?
 *
 * ASSET_PROPS covers the fixed names, but themes also carry per-slot keys --
 * customBadgeIcon:favorite, customBadgeIcon:completed -- which cannot be
 * listed. Both places that rewrite a path have to agree on this, or a prop
 * gets resolved in one and left relative in the other: modern-es-de's badge
 * icons stayed "./assets/dark/badges/favorite.svg" and never loaded.
 */
function isAssetProp(key) {
  return ASSET_PROPS.includes(key) || key.startsWith('custom');
}

// props that carry "x y" pairs
// cropSize/imageMaxSize/imageSize are ES-DE size properties in their own
// right, and art-book-next uses them INSTEAD of <size>. Left out of this set
// they parse as strings, so every element sized that way computed a zero box.
const PAIR_PROPS = new Set(['pos', 'size', 'maxSize', 'minSize', 'origin', 'itemSize',
  'cropSize', 'imageMaxSize', 'imageSize', 'imageCropSize',
  // Padding pairs are (before, after) on one axis -- both expressed as a
  // fraction of SCREEN WIDTH, even the vertical one (HelpComponent.cpp:160).
  'backgroundHorizontalPadding', 'backgroundVerticalPadding',
  'selectedBackgroundMargins', 'selectedItemMargins', 'itemMargin', 'pillarboxThreshold',
  'controllerPos', 'folderLinkPos', 'cropPos', 'imageCropPos', 'tileSize',
  'backgroundMargins', 'itemLinearScale', 'itemLinearSpacing', 'itemRotationOrigin',
  'selectedItemOffset', 'rotationOrigin']);
const NUM_PROPS = new Set([
  'rotation', 'opacity', 'zIndex', 'fontSize', 'lineSpacing', 'itemScale',
  'itemSpacing', 'maxItemCount', 'textRelativeScale', 'unfocusedItemOpacity',
]);

function parsePair(str) {
  const [a, b] = String(str).trim().split(/\s+/).map(Number);
  return [Number.isFinite(a) ? a : 0, Number.isFinite(b) ? b : 0];
}

/**
 * The declared aspect ratio closest to the stage.
 *
 * Names are ES-DE's own ("16:9", "19.5:9", "5:3_vertical"). The stage is a
 * fixed 1920x1080 design space, so the target is 16:9; anything else is a
 * theme laying out for a screen shape we are not.
 */
export function pickAspectRatio(list, target = 16 / 9) {
  if (!list?.length) return null;
  let best = null;
  let bestErr = Infinity;
  for (const name of list) {
    const m = String(name).match(/^(\d+(?:\.\d+)?)[:\-](\d+(?:\.\d+)?)/);
    if (!m) continue;
    let ratio = Number(m[1]) / Number(m[2]);
    // A "_vertical" entry is the portrait form of the same numbers.
    if (/vertical/i.test(name)) ratio = 1 / ratio;
    const err = Math.abs(Math.log(ratio / target));
    if (err < bestErr) { bestErr = err; best = name; }
  }
  return best ?? list[0];
}

export class ThemeStore {
  constructor(userDataDir) {
    this.userThemesDir = path.join(userDataDir, 'themes');
    this.dirs = [BUNDLED_THEMES_DIR, this.userThemesDir];
  }

  /** All themes found, bundled first. */
  list() {
    const out = [];
    for (const dir of this.dirs) {
      if (!existsSync(dir)) continue;
      for (const name of readdirSync(dir)) {
        const themeDir = path.join(dir, name);
        try {
          if (!statSync(themeDir).isDirectory()) continue;
        } catch {
          continue;
        }
        if (!existsSync(path.join(themeDir, 'theme.xml'))) continue;
        const caps = this.capabilities(themeDir);
        out.push({
          name,
          dir: themeDir,
          bundled: dir === BUNDLED_THEMES_DIR,
          displayName: caps.themeName ?? name,
          variants: caps.variants,
          colorSchemes: caps.colorSchemes,
          aspectRatios: caps.aspectRatios,
          fontSizes: caps.fontSizes,
        });
      }
    }
    return out;
  }

  find(name) {
    return this.list().find((t) => t.name === name) ?? null;
  }

  /** The catalog, annotated with what's already on disk. */
  catalog() {
    const installed = new Set(this.list().map((t) => t.name));
    return THEME_CATALOG.map((entry) => ({
      ...entry,
      installed: installed.has(entry.name),
    }));
  }

  /**
   * Install a catalog theme with a shallow git clone.
   *
   * `--depth 1` matters: art-book-next carries 187 MB of history on top of
   * 220 MB of artwork, and none of it is wanted.
   *
   * @param {string} name catalog entry name
   * @param {(line:string)=>void} [onProgress] git's stderr, line by line
   */
  async install(name, onProgress = null) {
    const entry = THEME_CATALOG.find((t) => t.name === name);
    if (!entry) throw new Error(`unknown theme: ${name}`);
    if (this.find(name)) return { name, alreadyInstalled: true };

    mkdirSync(this.userThemesDir, { recursive: true });
    const dest = path.join(this.userThemesDir, entry.name);
    // A previous attempt may have left a partial clone behind.
    rmSync(dest, { recursive: true, force: true });

    try {
      await this._cloneWithGit(entry, dest, onProgress);
    } catch (err) {
      // No git on the machine (flatpak's runtime has none; plenty of Windows
      // boxes have none). Every catalog entry also names the forge's
      // snapshot tarball, so fall back to fetching that.
      if (!err.gitMissing || !entry.archive) throw err;
      await this._fetchArchive(entry, dest, onProgress);
    }

    // A download that lands without a theme.xml is not a theme, and leaving
    // it would put a broken entry in the picker.
    if (!existsSync(path.join(dest, 'theme.xml'))) {
      rmSync(dest, { recursive: true, force: true });
      throw new Error('downloaded, but it contains no theme.xml');
    }
    return { name: entry.name, displayName: entry.displayName };
  }

  /** Shallow git clone of a catalog entry into dest. */
  _cloneWithGit(entry, dest, onProgress) {
    return new Promise((resolve, reject) => {
      const child = spawn('git', [
        'clone', '--depth', '1', '--progress', entry.url, dest,
      ], { stdio: ['ignore', 'ignore', 'pipe'] });

      let tail = '';
      child.stderr.on('data', (buf) => {
        tail = String(buf).slice(-400);
        if (!onProgress) return;
        // git writes progress with \r; take the last non-empty fragment.
        const line = String(buf).split(/[\r\n]+/).filter(Boolean).pop();
        if (line) onProgress(line.trim());
      });

      child.on('error', (err) => {
        rmSync(dest, { recursive: true, force: true });
        const wrapped = new Error(err.code === 'ENOENT'
          ? 'git is not installed'
          : err.message);
        wrapped.gitMissing = err.code === 'ENOENT';
        reject(wrapped);
      });

      child.on('exit', (code) => {
        if (code !== 0) {
          rmSync(dest, { recursive: true, force: true });
          reject(new Error(`download failed: ${tail.trim() || `git exited ${code}`}`));
          return;
        }
        // Drop the git metadata -- it is dead weight once cloned.
        rmSync(path.join(dest, '.git'), { recursive: true, force: true });
        resolve();
      });
    });
  }

  /**
   * git-less install: fetch the forge's snapshot tarball and unpack it with
   * the system tar (present in the flatpak runtime and on Windows 10+).
   * Archives wrap everything in one top-level directory; strip it.
   *
   * The download itself prefers the system curl over node's fetch: GitLab's
   * WAF fingerprints clients below the header layer and intermittently 406s
   * node/undici no matter what headers it sends, while curl sails through.
   * curl ships with the flatpak runtime, Windows 10+, and macOS, so on the
   * platforms most likely to lack git it is the reliable engine; fetch stays
   * as the last resort for machines with neither.
   */
  async _fetchArchive(entry, dest, onProgress) {
    const tmp = path.join(this.userThemesDir, `.${entry.name}.download.tar.gz`);
    rmSync(tmp, { force: true });
    try {
      try {
        await this._downloadWithCurl(entry.archive, tmp, onProgress);
      } catch (err) {
        if (!err.curlMissing) throw err;
        await this._downloadWithFetch(entry.archive, tmp, onProgress);
      }
      mkdirSync(dest, { recursive: true });
      const r = spawnSync('tar', ['-xzf', tmp, '-C', dest, '--strip-components=1']);
      if (r.error || r.status !== 0) {
        throw new Error(`could not unpack theme archive: ${r.error?.message ?? `tar exited ${r.status}`}`);
      }
    } catch (err) {
      rmSync(dest, { recursive: true, force: true });
      throw err;
    } finally {
      rmSync(tmp, { force: true });
    }
  }

  /** Download url to file with the system curl. Rejects with .curlMissing when there is no curl. */
  _downloadWithCurl(url, file, onProgress) {
    return new Promise((resolve, reject) => {
      const child = spawn('curl', [
        '--fail', '--location', '--silent', '--show-error',
        '--retry', '3', '--retry-delay', '2', '--retry-all-errors',
        '--output', file, url,
      ], { stdio: ['ignore', 'ignore', 'pipe'] });
      if (onProgress) onProgress('downloading');
      let tail = '';
      child.stderr.on('data', (buf) => { tail = String(buf).slice(-300); });
      child.on('error', (err) => {
        const wrapped = new Error(err.code === 'ENOENT' ? 'curl is not installed' : err.message);
        wrapped.curlMissing = err.code === 'ENOENT';
        reject(wrapped);
      });
      child.on('exit', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`download failed: ${tail.trim() || `curl exited ${code}`}`));
      });
    });
  }

  /** Download url to file with node's fetch. Last resort; some WAFs block it. */
  async _downloadWithFetch(url, file, onProgress) {
    const res = await fetch(url, {
      redirect: 'follow',
      headers: { 'accept-encoding': 'identity' },
    });
    if (!res.ok) throw new Error(`download failed: HTTP ${res.status} for ${url}`);
    let bytes = 0;
    let lastReported = 0;
    await pipeline(
      Readable.fromWeb(res.body),
      async function* (source) {
        for await (const chunk of source) {
          bytes += chunk.length;
          if (onProgress && bytes - lastReported > 4_000_000) {
            lastReported = bytes;
            onProgress(`downloading: ${(bytes / 1048576).toFixed(0)} MB`);
          }
          yield chunk;
        }
      },
      createWriteStream(file),
    );
  }

  /** Remove an installed user theme. Bundled themes are never removable. */
  remove(name) {
    const theme = this.find(name);
    if (!theme) throw new Error(`not installed: ${name}`);
    if (theme.bundled) throw new Error('bundled themes cannot be removed');
    const target = path.normalize(theme.dir);
    // Jail: only ever delete inside the user themes directory.
    if (!target.startsWith(this.userThemesDir + path.sep)) {
      throw new Error('refusing to remove a theme outside the themes folder');
    }
    rmSync(target, { recursive: true, force: true });
    return { name };
  }

  capabilities(themeDir) {
    const file = path.join(themeDir, 'capabilities.xml');
    const empty = {
      themeName: null, variants: [], colorSchemes: [], aspectRatios: [], fontSizes: [],
    };
    if (!existsSync(file)) return empty;
    try {
      const doc = parser.parse(readFileSync(file, 'utf8'))?.themeCapabilities ?? {};
      const mapNamed = (arr) =>
        (arr ?? []).map((v) => ({
          name: v['@_name'] ?? String(v),
          label: typeof v.label === 'string' ? v.label : v['@_name'] ?? String(v),
        }));
      const plain = (arr) => (arr ?? [])
        .map((a) => (typeof a === 'string' ? a : a['#text'] ?? ''))
        .filter(Boolean);
      return {
        themeName: typeof doc.themeName === 'string' ? doc.themeName : null,
        variants: mapNamed(doc.variant),
        colorSchemes: mapNamed(doc.colorScheme),
        aspectRatios: plain(doc.aspectRatio),
        // ES-DE's fontSize capability gates whole <variables> blocks.
        fontSizes: plain(doc.fontSize),
      };
    } catch {
      return empty;
    }
  }

  /**
   * Parse a theme into a render model for the given selection.
   * @returns {{name, displayName, variables, views:{system:Element[], gamelist:Element[]}}}
   */
  load(name, { variant = null, colorScheme = null, aspectRatio = null, fontSize = null } = {}) {
    const theme = this.find(name);
    if (!theme) throw new Error(`no such theme: ${name}`);
    // ES-DE semantics: when the user hasn't chosen, the theme's FIRST declared
    // variant/colorScheme is the default -- not "match everything", which would
    // let every conditional block apply at once.
    const ctx = {
      variant: variant ?? theme.variants[0]?.name ?? null,
      colorScheme: colorScheme ?? theme.colorSchemes[0]?.name ?? null,
      // Aspect ratio is the exception to "first declared wins": ES-DE picks
      // the one that MATCHES THE SCREEN, and only falls back to the first if
      // the theme offers nothing close. art-book-next declares 32:9 first, so
      // first-wins rendered an ultrawide layout onto a 16:9 stage -- a theme
      // that looked nothing like itself while every element still drew.
      aspectRatio: aspectRatio ?? pickAspectRatio(theme.aspectRatios) ?? null,
      // Real themes gate their font-size variables on this; without a
      // selection those <variables> blocks never apply and every fontSize
      // resolves to a literal ${name}.
      fontSize: fontSize ?? theme.fontSizes[0] ?? null,
    };
    const variables = {};
    const views = { system: [], gamelist: [], desktop: [] };
    this._loadFile(path.join(theme.dir, 'theme.xml'), theme.dir, ctx, variables, views, 0);

    // resolve ${var} everywhere now that all variables are collected
    for (const list of Object.values(views)) {
      for (const el of list) this._substitute(el, variables, theme.dir);
    }
    return {
      name: theme.name,
      displayName: theme.displayName,
      dir: theme.dir,
      variables,
      views,
      desktop: this._desktopTokens(variables, views.desktop),
      selected: ctx,
    };
  }

  /**
   * Design tokens for the windowed library UI.
   *
   * Preference order: an explicit <view name="desktop"> element wins, then a
   * conventionally-named theme variable, then romdeck's built-in default. So
   * a theme written for ES-DE still restyles the desktop through its own
   * palette, and a theme that cares can be precise.
   */
  _desktopTokens(variables, desktopElements = []) {
    const explicit = {};
    for (const el of desktopElements) {
      // <text name="accent"><color>ff0000</color></text> or a <colors> element
      const val = el.props?.color ?? el.props?.value ?? el.props?.path;
      if (val && DESKTOP_TOKENS.includes(el.name)) explicit[el.name] = val;
      for (const token of DESKTOP_TOKENS) {
        if (el.props?.[token]) explicit[token] = el.props[token];
      }
      if (el.name === 'background' && el.props?.path) explicit.backgroundImage = el.props.path;
      if (el.name === 'grid') {
        if (el.props.itemSize) explicit.tileMin = Math.round(el.props.itemSize[0]);
        if (el.props.aspectRatio) explicit.tileAspect = el.props.aspectRatio;
      }
    }

    const out = { ...explicit };
    for (const token of DESKTOP_TOKENS) {
      if (out[token]) continue;
      for (const alias of TOKEN_ALIASES[token]) {
        if (variables[alias]) { out[token] = variables[alias]; break; }
      }
    }
    return out;
  }

  _loadFile(file, themeDir, ctx, variables, views, depth) {
    if (depth > 16 || !existsSync(file)) return;
    let doc;
    try {
      doc = parser.parse(readFileSync(file, 'utf8'))?.theme ?? {};
    } catch {
      return;
    }
    this._walk(doc, file, themeDir, ctx, variables, views, depth);
  }

  /**
   * Walk a theme node, descending through conditional wrappers.
   *
   * This is the §16f fix. Real ES-DE themes are a TREE of conditional
   * wrappers, not a flat list:
   *
   *   <theme>
   *     <fontSize name="medium"><variables>…</variables></fontSize>
   *     <variant name="all">
   *       <aspectRatio name="16:9">
   *         <include>./aspect-ratio-16-9.xml</include>   ← views live here
   *       </aspectRatio>
   *       <view name="system, gamelist">…</view>
   *     </variant>
   *   </theme>
   *
   * The old parser only read <view>/<include> at the top level of <theme>, so
   * the files holding every view were never opened and the result was zero
   * elements. Each wrapper's condition applies to everything inside it, and
   * includes are followed at every depth.
   */
  _walk(node, file, themeDir, ctx, variables, views, depth) {
    if (!node || typeof node !== 'object') return;

    // <variables> -- a theme declares several blocks (a base one plus
    // variant/colorScheme/fontSize-specific overrides); later matches win.
    for (const block of node.variables ?? []) {
      if (!this._matches(block, ctx)) continue;
      for (const [k, v] of Object.entries(block)) {
        if (k.startsWith('@_')) continue;
        if (typeof v === 'string') variables[k] = v;
        else if (v && typeof v === 'object' && typeof v['#text'] === 'string') {
          variables[k] = v['#text'];
        }
      }
    }

    // <include> -- relative to the INCLUDING file, at any depth.
    for (const inc of node.include ?? []) {
      const raw = typeof inc === 'string' ? inc : inc['#text'];
      if (!raw) continue;
      if (inc && typeof inc === 'object' && !this._matches(inc, ctx)) continue;
      // An include PATH can itself be built from variables:
      //   <include>./${carousel-style}.xml</include>
      // aura-es-de reaches its entire system view that way, so leaving the
      // ${...} in place meant the file never loaded and the view rendered
      // with a background and nothing else -- blank, with no error anywhere.
      // ${system.theme} is per-system and only the renderer knows it; an
      // include naming one is skipped rather than guessed at.
      const rel = String(raw).replace(/\$\{([\w.-]+)\}/g, (m, key) =>
        (variables[key] !== undefined ? variables[key] : m));
      if (rel.includes('${')) continue;
      const resolved = path.resolve(path.dirname(file), rel);
      if (!existsSync(resolved)) continue;
      this._loadFile(resolved, themeDir, ctx, variables, views, depth + 1);
    }

    // <view> -- may name several views at once: <view name="system, gamelist">
    for (const view of node.view ?? []) {
      if (!this._matches(view, ctx)) continue;
      const names = String(view['@_name'] ?? '').split(',').map((s) => s.trim());
      for (const viewName of names) {
        if (!views[viewName]) continue;
        this._collectElements(view, views[viewName], ctx, themeDir);
      }
    }

    // Conditional wrappers: descend, but only when their condition holds. The
    // wrapper's own condition is checked here rather than being pushed into
    // ctx, because ES-DE semantics are "this block applies when selected",
    // and everything inside inherits that by virtue of not being visited.
    for (const tag of Object.keys(WRAPPER_TAGS)) {
      const blocks = node[tag];
      if (!blocks) continue;
      for (const block of Array.isArray(blocks) ? blocks : [blocks]) {
        if (!block || typeof block !== 'object') continue;
        if (!this._matchesWrapper(tag, block, ctx)) continue;
        this._walk(block, file, themeDir, ctx, variables, views, depth + 1);
      }
    }
  }

  /** Pull element tags out of a <view> block into that view's element list. */
  _collectElements(view, list, ctx, themeDir) {
    for (const [tag, value] of Object.entries(view)) {
      if (!ELEMENT_TYPES.has(tag)) continue;
      const entries = Array.isArray(value) ? value : [value];
      for (const raw of entries) {
        if (!raw || typeof raw !== 'object') continue;
        if (!this._matches(raw, ctx)) continue;
        // An element can also name several targets at once, and real themes
        // rely on redeclaring a name later to layer properties onto it.
        const names = String(raw['@_name'] ?? tag).split(',').map((s) => s.trim());
        for (const name of names) {
          const el = this._element(tag, raw, themeDir, name);
          const idx = list.findIndex((e) => e.name === el.name && e.type === el.type);
          if (idx >= 0) {
            // Later declarations MERGE onto earlier ones (ES-DE semantics):
            // themes routinely set shared properties once and then refine a
            // single element by redeclaring just the property that differs.
            list[idx] = { ...list[idx], ...el, props: { ...list[idx].props, ...el.props } };
          } else {
            list.push(el);
          }
        }
      }
    }
  }

  /** A wrapper element's condition lives in its `name` attribute. */
  _matchesWrapper(tag, block, ctx) {
    const selected = ctx[WRAPPER_TAGS[tag]];
    const spec = block['@_name'];
    if (!spec) return true;
    const list = String(spec).split(',').map((s) => s.trim());
    if (list.includes('all')) return true;
    return selected ? list.includes(selected) : false;
  }

  /** variant / colorScheme / aspectRatio filtering on a node's ATTRIBUTES. */
  _matches(node, ctx) {
    const check = (attr, selected) => {
      const spec = node[attr];
      if (!spec) return true; // unconditional nodes always apply
      const list = String(spec).split(',').map((s) => s.trim());
      if (list.includes('all')) return true;
      // A node scoped to a specific variant/scheme applies only when that one
      // is selected -- with nothing selected it stays out.
      return selected ? list.includes(selected) : false;
    };
    return (
      check('@_variant', ctx.variant) &&
      check('@_colorScheme', ctx.colorScheme) &&
      check('@_aspectRatio', ctx.aspectRatio)
    );
  }

  _element(type, raw, themeDir, name = null) {
    const el = { type, name: name ?? raw['@_name'] ?? type, props: {} };
    for (const [key, value] of Object.entries(raw)) {
      if (key.startsWith('@_') || key === '#text') continue;
      // <customBadgeIcon badge="favorite">path</customBadgeIcon> -- several of
      // these appear per element, distinguished only by their attribute, so
      // they'd collapse onto one another without being keyed by it.
      if (key === 'customBadgeIcon' || key === 'customControllerIcon') {
        const attr = key === 'customBadgeIcon' ? '@_badge' : '@_controller';
        for (const one of Array.isArray(value) ? value : [value]) {
          if (!one || typeof one !== 'object') continue;
          const slot = one[attr];
          const p = one['#text'];
          if (slot && p) el.props[`${key}:${slot}`] = String(p);
        }
        continue;
      }
      const v = typeof value === 'object' ? value['#text'] ?? '' : value;
      // A prop written as ${variable} must stay a STRING until _substitute()
      // resolves it. Parsing it now turns "${systemViewLogoPos}" into [0, 0]
      // and silently pins the element to the top-left corner -- the variable is
      // then never seen again, because it is no longer a string to substitute.
      if (typeof v === 'string' && v.includes('${')) el.props[key] = v;
      else if (PAIR_PROPS.has(key)) el.props[key] = parsePair(v);
      else if (NUM_PROPS.has(key)) el.props[key] = Number(v);
      else el.props[key] = String(v);
    }
    // Asset paths become protocol URLs the renderer can fetch. Paths holding
    // a ${variable} are left for _substitute(), which runs once every file has
    // contributed its <variables> -- rewriting them here would bake in a name
    // that hasn't been resolved yet.
    for (const key of Object.keys(el.props)) {
      // Badge/controller icons are keyed dynamically (customBadgeIcon:favorite)
      // so they can't be listed in ASSET_PROPS, but they're still paths.
      if (!isAssetProp(key)) continue;
      const p = el.props[key];
      if (typeof p === 'string' && p && !p.includes('${') && !/^\w+:/.test(p)) {
        el.props[key] = this._assetUrl(themeDir, p);
      }
    }
    return el;
  }

  _assetUrl(themeDir, rel) {
    return 'romdeck-theme://' + path.basename(themeDir) + '/' + rel.replace(/^\.\//, '');
  }

  _substitute(el, variables, themeDir) {
    const sub = (s) =>
      String(s).replace(/\$\{([\w.-]+)\}/g, (m, key) =>
        variables[key] !== undefined ? variables[key] : m,
      );
    for (const [k, v] of Object.entries(el.props)) {
      if (typeof v === 'string' && v.includes('${')) {
        const resolved = sub(v);
        // A path built from variables (./${artDirectory}/${system.theme}.webp)
        // can only become a URL once its variables are known -- which is why
        // this runs after every file has contributed its <variables>.
        // A path can still hold ${system.theme} -- that one is per-system and
        // only the renderer knows it. Convert to a URL anyway so the renderer
        // just substitutes the system name into an already-valid URL, rather
        // than having to know where the theme lives on disk.
        el.props[k] = isAssetProp(k) && !/^\w+:/.test(resolved)
          ? this._assetUrl(themeDir, resolved)
          : resolved;
        // Numeric props declared through a variable arrive as strings.
        if (NUM_PROPS.has(k)) el.props[k] = Number(el.props[k]);
        else if (PAIR_PROPS.has(k)) el.props[k] = parsePair(el.props[k]);
      }
    }
  }

  /** Resolve a romdeck-theme:// path to a real file (protocol handler). */
  resolveAsset(themeName, rel) {
    const theme = this.find(themeName);
    if (!theme) return null;
    const target = path.normalize(path.join(theme.dir, rel));
    if (!target.startsWith(theme.dir + path.sep)) return null; // jail
    if (existsSync(target)) return target;
    // Supplement fallback: romdeck ships art for systems the community
    // themes have never heard of (wasmcart, gametank). A missing theme
    // asset is answered from assets/theme-supplements/<theme>/<same rel>,
    // so downloaded themes are never mutated and a theme update wins the
    // moment it starts shipping the file itself.
    const supDir = path.join(SUPPLEMENTS_DIR, theme.name);
    const sup = path.normalize(path.join(supDir, rel));
    if (!sup.startsWith(supDir + path.sep)) return null; // same jail
    return existsSync(sup) ? sup : null;
  }
}
