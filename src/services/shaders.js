// Installed shader presets, for the Picture picker.
//
// Shaders are GPU multi-pass .glslp presets run by retroemu; the CPU
// "video filter" family (none/sharp/scanlines/crt) is a DIFFERENT subsystem
// and the two are mutually exclusive — see internal-romdeck/SHADERS.md §1.
// The UI presents them as one "Picture" question because to a player they are
// one question, and this module is what makes that possible: it hands the
// settings layer a single flat option list covering both.
//
// Presets are NOT bundled. libretro/glsl-shaders is 61 MB and CC-BY-NC-SA,
// the same reason themes are downloaded rather than shipped. A user drops the
// repo in <userData>/shaders/ (or points ROMDECK_SHADER_DIR at one) and the
// picker fills in.
import path from 'node:path';
import { existsSync, readdirSync, statSync } from 'node:fs';

/** The CPU filters retroemu implements natively. Always available. */
export const CPU_FILTERS = [
  { value: 'none', label: 'Clean (no effect)', kind: 'filter' },
  { value: 'sharp', label: 'Sharp pixels', kind: 'filter' },
  { value: 'scanlines', label: 'Scanlines', kind: 'filter' },
  { value: 'crt', label: 'CRT (scanlines + phosphor mask)', kind: 'filter' },
];

/**
 * A curated front of the corpus.
 *
 * 619 presets in a gamepad menu is not a feature, it is a wall. These are the
 * ones worth surfacing first; everything else is still reachable under "All
 * shaders". Order is deliberate — cheapest and most legible first, because a
 * handheld user scrolling this list is usually after "make it look like a CRT"
 * rather than a specific algorithm.
 */
const FEATURED = [
  ['crt/crt-geom-mini.glslp', 'CRT — Geom (light)'],
  ['crt/crt-geom.glslp', 'CRT — Geom'],
  ['crt/crt-hyllian.glslp', 'CRT — Hyllian'],
  ['crt/crt-easymode.glslp', 'CRT — Easymode'],
  ['crt/zfast_crt.glslp', 'CRT — zfast (handheld-friendly)'],
  ['handheld/lcd-grid.glslp', 'Handheld — LCD grid'],
  ['handheld/dot.glslp', 'Handheld — dot matrix'],
  ['ntsc/ntsc-simple.glslp', 'NTSC — composite'],
  ['xbr/xbr-lv2.glslp', 'Smoothing — xBR level 2'],
  ['scalefx/scalefx.glslp', 'Smoothing — ScaleFX'],
];

export class ShaderStore {
  constructor(userData) {
    this.userData = userData;
    // ROMDECK_SHADER_DIR lets a packaged image point at a system-wide corpus
    // without copying 61 MB into every user profile.
    this.dirs = [
      process.env.ROMDECK_SHADER_DIR,
      userData ? path.join(userData, 'shaders') : null,
    ].filter(Boolean);
  }

  /** Where presets would be installed, whether or not it exists yet. */
  installDir() {
    return this.dirs[this.dirs.length - 1] ?? null;
  }

  installed() {
    return this.dirs.some((d) => existsSync(d));
  }

  /**
   * Every .glslp under the shader dirs, as { value, label, kind }.
   *
   * `value` is the path RELATIVE to its root, so a preset chosen on one
   * machine still resolves on another with a different userData location —
   * absolute paths in a settings file do not survive a profile move.
   */
  list() {
    const out = [];
    const seen = new Set();
    for (const root of this.dirs) {
      if (!existsSync(root)) continue;
      const walk = (dir) => {
        let entries;
        try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
          if (e.name === '.git' || e.name.startsWith('.')) continue;
          const full = path.join(dir, e.name);
          if (e.isDirectory()) { walk(full); continue; }
          if (!e.name.endsWith('.glslp')) continue;
          const rel = path.relative(root, full);
          if (seen.has(rel)) continue;
          seen.add(rel);
          out.push({ value: rel, label: prettyLabel(rel), kind: 'shader' });
        }
      };
      walk(root);
    }
    return out.sort((a, b) => a.label.localeCompare(b.label));
  }

  /** The short list the Picture menu shows before "All shaders". */
  featured() {
    const have = new Map(this.list().map((s) => [s.value, s]));
    return FEATURED
      .filter(([rel]) => have.has(rel))
      .map(([rel, label]) => ({ value: rel, label, kind: 'shader' }));
  }

  /**
   * Resolve a stored value to an absolute path retroemu can open.
   * Returns null when the preset is gone — a profile can outlive its files.
   */
  resolve(rel) {
    if (!rel) return null;
    for (const root of this.dirs) {
      const p = path.join(root, rel);
      try { if (statSync(p).isFile()) return p; } catch { /* next root */ }
    }
    return null;
  }
}

/** "crt/crt-geom-mini.glslp" -> "crt / crt geom mini" */
function prettyLabel(rel) {
  const parts = rel.replace(/\.glslp$/, '').split(path.sep);
  const name = parts.pop().replace(/[-_]+/g, ' ');
  return parts.length ? `${parts.join(' / ')} / ${name}` : name;
}
