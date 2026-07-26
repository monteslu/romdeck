// Settings with an honest cascade.
//
// The single loudest complaint about RetroArch's UX is its config-scope trap:
// you change a setting, it saves into a scope you didn't expect, and it
// silently reverts later. romdeck's answer is that every resolved value
// reports WHERE it came from, and the UI shows that provenance inline.
//
// Layers, least → most specific:  default → global → platform:<short> → game:<key>
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

// The settings romdeck understands, with plain-language labels — no jargon
// like "content" or "RetroPad".
export const SETTINGS = [
  {
    key: 'videoFilter',
    label: 'Picture',
    help: 'CRT-style effect applied to the game window.',
    type: 'enum',
    options: [
      { value: 'none', label: 'Clean (no effect)' },
      { value: 'sharp', label: 'Sharp pixels' },
      { value: 'scanlines', label: 'Scanlines' },
      { value: 'crt', label: 'CRT (scanlines + phosphor mask)' },
    ],
    default: 'none',
  },
  {
    key: 'fullscreen',
    label: 'Start fullscreen',
    help: 'Open games fullscreen instead of in a window.',
    type: 'bool',
    default: false,
  },
  {
    key: 'resume',
    label: 'Resume where you left off',
    help: 'Load the automatic save state when a game starts.',
    type: 'bool',
    default: true,
  },
  {
    key: 'fastForwardSpeed',
    label: 'Fast-forward speed',
    help: 'Multiplier used by the fast-forward button.',
    type: 'enum',
    options: [
      { value: '2', label: '2×' },
      { value: '4', label: '4×' },
      { value: '8', label: '8×' },
      { value: '0', label: 'Uncapped' },
    ],
    default: '4',
  },
  {
    key: 'rewindEnabled',
    label: 'Rewind',
    help: 'Keep recent history in memory so you can rewind mistakes.',
    type: 'bool',
    default: true,
  },
];

const BY_KEY = new Map(SETTINGS.map((s) => [s.key, s]));

export class SettingsStore {
  constructor(userDataDir) {
    this.file = path.join(userDataDir, 'settings.json');
    try {
      this.data = JSON.parse(readFileSync(this.file, 'utf8'));
    } catch {
      this.data = {};
    }
    this.data.layers ??= {}; // layerKey -> { settingKey: value }
  }

  save() {
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify(this.data, null, 2));
    } catch { /* best effort */ }
  }

  static layerKeys({ platform = null, gameKey = null } = {}) {
    const layers = ['global'];
    if (platform) layers.push(`platform:${platform}`);
    if (gameKey) layers.push(`game:${gameKey}`);
    return layers;
  }

  /**
   * Effective value plus where it came from.
   * @returns {{value:any, source:'default'|'global'|'platform'|'game', layer:string}}
   */
  resolve(key, ctx = {}) {
    const def = BY_KEY.get(key);
    let out = { value: def?.default ?? null, source: 'default', layer: 'default' };
    for (const layer of SettingsStore.layerKeys(ctx)) {
      const v = this.data.layers[layer]?.[key];
      if (v !== undefined) {
        out = {
          value: v,
          source: layer === 'global' ? 'global' : layer.startsWith('platform:') ? 'platform' : 'game',
          layer,
        };
      }
    }
    return out;
  }

  /** Every setting resolved for a context — what the Settings UI renders. */
  resolveAll(ctx = {}) {
    return SETTINGS.map((s) => ({ ...s, ...this.resolve(s.key, ctx) }));
  }

  /** Set a value in an explicit layer. `undefined` clears it (falls through). */
  set(key, value, layer = 'global') {
    if (!BY_KEY.has(key)) throw new Error(`unknown setting: ${key}`);
    this.data.layers[layer] ??= {};
    if (value === undefined || value === null) delete this.data.layers[layer][key];
    else this.data.layers[layer][key] = value;
    this.save();
    return this.resolve(key, layerToCtx(layer));
  }

  /**
   * Move a per-game layer from an old key to a new one.
   *
   * The game: layer keys on the same gameKey as states and cheats, so it has
   * to travel with them when identification upgrades a game to its CRC
   * identity.
   */
  migrateGameLayer(fromKey, toKey) {
    if (!fromKey || fromKey === toKey) return false;
    const from = this.data.layers[`game:${fromKey}`];
    if (!from || !Object.keys(from).length) return false;
    const to = this.data.layers[`game:${toKey}`] ?? {};
    // Values already set under the new key win — they're the more recent
    // expression of intent.
    this.data.layers[`game:${toKey}`] = { ...from, ...to };
    delete this.data.layers[`game:${fromKey}`];
    this.save();
    return true;
  }

  /** Launch options for a game, with the cascade already applied. */
  launchOptions(ctx = {}) {
    const val = (k) => this.resolve(k, ctx).value;
    return {
      videoFilter: val('videoFilter'),
      fullscreen: !!val('fullscreen'),
      resume: !!val('resume'),
      fastForwardSpeed: Number(val('fastForwardSpeed')),
      rewindEnabled: !!val('rewindEnabled'),
    };
  }
}

function layerToCtx(layer) {
  if (layer.startsWith('platform:')) return { platform: layer.slice(9) };
  if (layer.startsWith('game:')) return { gameKey: layer.slice(5) };
  return {};
}
