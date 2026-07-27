#!/usr/bin/env node
// Render EVERY installed theme and assert on pixels, not element counts.
//
// theme-conformance.mjs proves a theme's views populate. That is necessary and
// not sufficient: a view can hold 40 elements and still paint a blank screen,
// which is exactly the class of bug this project keeps finding. This renders
// each theme's system and gamelist views for real and reports:
//
//   blank      one colour owns >98.5% of the frame
//   threw      an element raised during paint (normally swallowed per-element)
//   unresolved ${...} left in visible text, i.e. a binding we do not support
//
// Usage: node scripts/theme-render-sweep.mjs [themesDir]
import { readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { withApp } from '../src/ui/app.js';

const dir = process.argv[2] ?? '/tmp/all-themes';
const romsDir = process.argv[3] ?? path.join(process.env.HOME, 'code/cliemu/roms-real');

function stats(canvas) {
  const { data } = canvas.getContext('2d')
    .getImageData(0, 0, canvas.width, canvas.height);
  const counts = new Map();
  for (let i = 0; i < data.length; i += 4 * 7) {
    const k = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  let top = 0; let total = 0;
  for (const n of counts.values()) { total += n; if (n > top) top = n; }
  return { colors: counts.size, dominance: top / Math.max(1, total) };
}

const names = readdirSync(dir).filter((n) => existsSync(path.join(dir, n, 'capabilities.xml'))
  || existsSync(path.join(dir, n, 'theme.xml')));

let failures = 0;
const rows = [];

// Print each row AS IT LANDS. Buffering to the end meant a single theme that
// hung took the whole run's output with it: the first attempt sat for fifty
// minutes with an empty log and no way to tell which theme was stuck.
const w = Math.max(...names.map((n) => n.length), 10);
console.log(`${'theme'.padEnd(w)}  ${'system'.padEnd(14)} ${'gamelist'.padEnd(14)} notes`);
console.log('-'.repeat(w + 56));
const fmt = (s) => `${String(s.colors).padStart(4)}c ${((1 - s.dominance) * 100).toFixed(1).padStart(5)}%`;

for (const name of names) {
  // withApp disposes on every path, including the throw this catch handles —
  // a leak here is what took the machine down, since the loop builds 64 Apps.
  try {
    await withApp({ romsDir, headless: true }, async (app) => {
    app.svc.themes.dirs = [dir, ...app.svc.themes.dirs];
    const res = await app.stage.setTheme(name, {});
    if (res.error || app.stage.theme?.name !== name) {
      const note = `did not load: ${res.error ?? 'fell back'}`;
      rows.push({ name, note });
      console.log(`${name.padEnd(w)}  ${note}`);
      failures++;
      return; // ends this theme's scope; withApp disposes on the way out
    }
    await app.stage.preload();
    const out = { name, threw: [], unresolved: [] };
    for (const view of ['system', 'gamelist']) {
      app.stage.view = view;
      if (view === 'gamelist') app.stage.gameIndex = 0;
      app.invalidate();
      const canvas = app.render();
      await new Promise((r) => setTimeout(r, 400));
      app.invalidate();
      const s = stats(app.render());
      out[view] = s;
      if (s.dominance > 0.985 || s.colors < 3) out.threw.push(`${view}:blank`);
      out.threw.push(...(app.stage.drawErrors ?? []));
      for (const el of app.stage.elements()) {
        const key = el.props.metadata ?? el.props.systemdata;
        const text = key ? app.stage.meta(key, el.props) : app.stage.bind(el.props.text ?? '');
        if (typeof text === 'string' && text.includes('${')) out.unresolved.push(text.slice(0, 30));
      }
      void canvas;
    }
    if (out.threw.length || out.unresolved.length) failures++;
    rows.push(out);
    const notes = [...new Set([...out.threw, ...out.unresolved.map((u) => `unresolved ${u}`)])];
    console.log(`${name.padEnd(w)}  ${fmt(out.system).padEnd(14)} ${fmt(out.gamelist).padEnd(14)} ${notes.join(' | ')}`);
    });
  } catch (err) {
    rows.push({ name, note: `crashed: ${err.message}` });
    console.log(`${name.padEnd(w)}  crashed: ${err.message}`);
    failures++;
  }
}

console.log('');
if (failures) {
  console.log(`RENDER SWEEP — ${failures} of ${rows.length} themes have problems`);
  process.exit(1);
}
console.log(`RENDER SWEEP OK — ${rows.length} themes render in both views`);
