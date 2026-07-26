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
// Anything unrecognized is ignored rather than fatal — an unsupported theme
// renders partially instead of blowing up.
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { XMLParser } from 'fast-xml-parser';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const BUNDLED_THEMES_DIR = path.join(__dirname, '..', '..', 'themes');

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: false,
  isArray: (name) => ['view', 'variant', 'colorScheme', 'aspectRatio', 'include'].includes(name),
});

const ELEMENT_TYPES = new Set(['image', 'text', 'carousel', 'textlist', 'rating', 'datetime', 'video', 'grid']);

// romdeck extension: ES-DE's format has no desktop/mouse view, so a theme can
// declare <view name="desktop"> with a <colors> block (and a few layout hints)
// to skin the windowed library. Themes that don't are still fully supported —
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

// props that carry "x y" pairs
const PAIR_PROPS = new Set(['pos', 'size', 'maxSize', 'minSize', 'origin', 'itemSize']);
const NUM_PROPS = new Set([
  'rotation', 'opacity', 'zIndex', 'fontSize', 'lineSpacing', 'itemScale',
  'itemSpacing', 'maxItemCount', 'textRelativeScale', 'unfocusedItemOpacity',
]);

function parsePair(str) {
  const [a, b] = String(str).trim().split(/\s+/).map(Number);
  return [Number.isFinite(a) ? a : 0, Number.isFinite(b) ? b : 0];
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
        });
      }
    }
    return out;
  }

  find(name) {
    return this.list().find((t) => t.name === name) ?? null;
  }

  capabilities(themeDir) {
    const file = path.join(themeDir, 'capabilities.xml');
    const empty = { themeName: null, variants: [], colorSchemes: [], aspectRatios: [] };
    if (!existsSync(file)) return empty;
    try {
      const doc = parser.parse(readFileSync(file, 'utf8'))?.themeCapabilities ?? {};
      const mapNamed = (arr) =>
        (arr ?? []).map((v) => ({
          name: v['@_name'] ?? String(v),
          label: v.label ?? v['@_name'] ?? String(v),
        }));
      return {
        themeName: doc.themeName ?? null,
        variants: mapNamed(doc.variant),
        colorSchemes: mapNamed(doc.colorScheme),
        aspectRatios: (doc.aspectRatio ?? []).map((a) => (typeof a === 'string' ? a : a['#text'] ?? '')),
      };
    } catch {
      return empty;
    }
  }

  /**
   * Parse a theme into a render model for the given selection.
   * @returns {{name, displayName, variables, views:{system:Element[], gamelist:Element[]}}}
   */
  load(name, { variant = null, colorScheme = null, aspectRatio = null } = {}) {
    const theme = this.find(name);
    if (!theme) throw new Error(`no such theme: ${name}`);
    // ES-DE semantics: when the user hasn't chosen, the theme's FIRST declared
    // variant/colorScheme is the default — not "match everything", which would
    // let every conditional block apply at once.
    const ctx = {
      variant: variant ?? theme.variants[0]?.name ?? null,
      colorScheme: colorScheme ?? theme.colorSchemes[0]?.name ?? null,
      aspectRatio: aspectRatio ?? theme.aspectRatios[0] ?? null,
    };
    const variables = {};
    const views = { system: [], gamelist: [], desktop: [] };
    this._loadFile(path.join(theme.dir, 'theme.xml'), theme.dir, ctx, variables, views, 0);

    // resolve ${var} everywhere now that all variables are collected
    for (const list of Object.values(views)) {
      for (const el of list) this._substitute(el, variables);
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
    if (depth > 8 || !existsSync(file)) return;
    let doc;
    try {
      doc = parser.parse(readFileSync(file, 'utf8'))?.theme ?? {};
    } catch {
      return;
    }

    // variables — a theme may declare several blocks (a base one plus
    // variant/colorScheme-specific overrides); later matching blocks win
    const varBlocks = Array.isArray(doc.variables)
      ? doc.variables
      : doc.variables
        ? [doc.variables]
        : [];
    for (const block of varBlocks) {
      if (!this._matches(block, ctx)) continue;
      for (const [k, v] of Object.entries(block)) {
        if (k.startsWith('@_')) continue;
        if (typeof v === 'string') variables[k] = v;
        else if (v && typeof v === 'object' && typeof v['#text'] === 'string') variables[k] = v['#text'];
      }
    }

    // includes, relative to the including file
    for (const inc of doc.include ?? []) {
      const rel = typeof inc === 'string' ? inc : inc['#text'];
      if (!rel) continue;
      this._loadFile(path.resolve(path.dirname(file), rel), themeDir, ctx, variables, views, depth + 1);
    }

    for (const view of doc.view ?? []) {
      if (!this._matches(view, ctx)) continue;
      const names = String(view['@_name'] ?? '').split(',').map((s) => s.trim());
      for (const viewName of names) {
        if (!views[viewName]) continue;
        for (const [tag, value] of Object.entries(view)) {
          if (!ELEMENT_TYPES.has(tag)) continue;
          const entries = Array.isArray(value) ? value : [value];
          for (const raw of entries) {
            if (!this._matches(raw, ctx)) continue;
            const el = this._element(tag, raw, themeDir);
            // same-named element in a later file overrides the earlier one
            const idx = views[viewName].findIndex((e) => e.name === el.name && e.type === el.type);
            if (idx >= 0) views[viewName][idx] = { ...views[viewName][idx], ...el };
            else views[viewName].push(el);
          }
        }
      }
    }
  }

  /** variant / colorScheme / aspectRatio filtering on a node. */
  _matches(node, ctx) {
    const check = (attr, selected) => {
      const spec = node[attr];
      if (!spec) return true; // unconditional nodes always apply
      const list = String(spec).split(',').map((s) => s.trim());
      if (list.includes('all')) return true;
      // A node scoped to a specific variant/scheme applies only when that one
      // is selected — with nothing selected it stays out.
      return selected ? list.includes(selected) : false;
    };
    return (
      check('@_variant', ctx.variant) &&
      check('@_colorScheme', ctx.colorScheme) &&
      check('@_aspectRatio', ctx.aspectRatio)
    );
  }

  _element(type, raw, themeDir) {
    const el = { type, name: raw['@_name'] ?? type, props: {} };
    for (const [key, value] of Object.entries(raw)) {
      if (key.startsWith('@_') || key === '#text') continue;
      const v = typeof value === 'object' ? value['#text'] ?? '' : value;
      if (PAIR_PROPS.has(key)) el.props[key] = parsePair(v);
      else if (NUM_PROPS.has(key)) el.props[key] = Number(v);
      else el.props[key] = String(v);
    }
    // asset paths become protocol URLs the renderer can fetch
    for (const key of ['path', 'defaultPath', 'imagePath', 'backgroundImage']) {
      const p = el.props[key];
      if (typeof p === 'string' && p && !p.startsWith('$') && !/^\w+:/.test(p)) {
        el.props[key] = 'romdeck-theme://' + path.basename(themeDir) + '/' + p.replace(/^\.\//, '');
      }
    }
    return el;
  }

  _substitute(el, variables) {
    const sub = (s) =>
      String(s).replace(/\$\{([\w.-]+)\}/g, (m, key) =>
        variables[key] !== undefined ? variables[key] : m,
      );
    for (const [k, v] of Object.entries(el.props)) {
      if (typeof v === 'string' && v.includes('${')) el.props[k] = sub(v);
    }
  }

  /** Resolve a romdeck-theme:// path to a real file (protocol handler). */
  resolveAsset(themeName, rel) {
    const theme = this.find(themeName);
    if (!theme) return null;
    const target = path.normalize(path.join(theme.dir, rel));
    if (!target.startsWith(theme.dir + path.sep)) return null; // jail
    return existsSync(target) ? target : null;
  }
}
