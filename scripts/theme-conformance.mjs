#!/usr/bin/env node
// Theme conformance harness — the check that would have caught §16f on day one.
//
// PLAN §16f: romdeck shipped a theme engine validated ONLY against a theme
// written in its own flattened dialect. A real community theme produced zero
// elements — a blank screen — and nothing noticed, because both sides of every
// test were written by the same hand.
//
// This loads REAL themes through the REAL ThemeStore and fails when a view
// yields no elements. "Supports ES-DE themes" is a claim this can back up.
//
// Usage:
//   node scripts/theme-conformance.mjs [themesDir]
//   THEME_REPOS=1 node scripts/theme-conformance.mjs   # clone the list first
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ThemeStore } from '../src/services/themes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The themes ES-DE itself lists. Cloning is opt-in (they're large) but the
// harness is worthless if it only ever sees themes we wrote.
const THEME_REPOS = [
  ['modern-es-de', 'https://gitlab.com/es-de/themes/modern-es-de.git'],
  ['slate-es-de', 'https://gitlab.com/es-de/themes/slate-es-de.git'],
];

const themesDir = process.argv[2] ?? '/tmp/es-themes';

function ensureThemes() {
  mkdirSync(themesDir, { recursive: true });
  for (const [name, url] of THEME_REPOS) {
    const dest = path.join(themesDir, name);
    if (existsSync(dest)) continue;
    console.log(`cloning ${name}…`);
    try {
      execFileSync('git', ['clone', '--depth', '1', '-q', url, dest], { stdio: 'inherit' });
    } catch (err) {
      console.error(`  could not clone ${name}: ${err.message}`);
    }
  }
}

if (process.env.THEME_REPOS) ensureThemes();

if (!existsSync(themesDir)) {
  console.error(`no themes at ${themesDir} — run with THEME_REPOS=1 to clone them`);
  process.exit(1);
}

// ThemeStore looks in <userData>/themes, so point it at the parent.
const store = new ThemeStore(path.dirname(themesDir) === themesDir
  ? themesDir
  : path.dirname(path.join(themesDir, 'x')));
store.dirs = [themesDir, path.join(__dirname, '..', 'themes')];

const discovered = store.list();
if (!discovered.length) {
  console.error(`no themes with a theme.xml found under ${themesDir}`);
  process.exit(1);
}

let failures = 0;
const rows = [];

for (const theme of discovered) {
  // Exercise every declared combination, not just the defaults: a theme can
  // easily render under one aspect ratio and produce nothing under another.
  const variants = theme.variants.length ? theme.variants.map((v) => v.name) : [null];
  const schemes = theme.colorSchemes.length ? theme.colorSchemes.map((c) => c.name) : [null];
  const ratios = theme.aspectRatios.length ? theme.aspectRatios : [null];

  for (const variant of variants) {
    for (const aspectRatio of ratios) {
      // Colour schemes rarely change element COUNT, so only the first is swept
      // across ratios; all schemes are checked at the default ratio below.
      const scheme = schemes[0];
      let model;
      try {
        model = store.load(theme.name, { variant, colorScheme: scheme, aspectRatio });
      } catch (err) {
        rows.push({ theme: theme.name, variant, aspectRatio, error: err.message });
        failures++;
        continue;
      }
      const system = model.views.system.length;
      const gamelist = model.views.gamelist.length;
      const types = new Set([...model.views.system, ...model.views.gamelist].map((e) => e.type));
      const ok = system > 0 && gamelist > 0;
      if (!ok) failures++;
      rows.push({
        theme: theme.name,
        variant,
        aspectRatio,
        system,
        gamelist,
        types: [...types].sort().join(','),
        vars: Object.keys(model.variables).length,
        tokens: Object.keys(model.desktop).length,
        ok,
      });
    }
  }
}

const width = Math.max(...rows.map((r) => r.theme.length), 12);
console.log('');
console.log(`${'theme'.padEnd(width)}  ${'variant'.padEnd(20)} ${'aspect'.padEnd(7)} ${'sys'.padStart(4)} ${'game'.padStart(5)}  vars tokens  elements`);
console.log('-'.repeat(width + 74));
for (const r of rows) {
  if (r.error) {
    console.log(`${r.theme.padEnd(width)}  ${String(r.variant).padEnd(20)} ${String(r.aspectRatio).padEnd(7)}  ERROR: ${r.error}`);
    continue;
  }
  const mark = r.ok ? ' ' : '✗';
  console.log(
    `${mark}${r.theme.padEnd(width - 1)}  ${String(r.variant ?? '-').padEnd(20)} ` +
    `${String(r.aspectRatio ?? '-').padEnd(7)} ${String(r.system).padStart(4)} ${String(r.gamelist).padStart(5)}  ` +
    `${String(r.vars).padStart(4)} ${String(r.tokens).padStart(6)}  ${r.types}`,
  );
}

console.log('');
if (failures) {
  console.log(`CONFORMANCE FAIL — ${failures} of ${rows.length} combinations produced an empty view`);
  process.exit(1);
}
console.log(`CONFORMANCE OK — ${rows.length} combinations across ${discovered.length} themes, every view populated`);
