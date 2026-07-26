// Controller mapping store.
//
// Bindings are keyed by DEVICE (SDL GUID when available, else the pad's name)
// so a controller keeps its layout across replugs and port shuffles — OS
// enumeration order is never trusted.
//
// Cascade, most specific wins:  global → platform:<short> → game:<gameKey>
// A layer only needs to carry the buttons it changes.
//
// A binding source is { type:'button', index } or { type:'axis', index, dir }.
// Absent bindings fall back to the positional W3C defaults in the player.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

// libretro RETRO_DEVICE_ID_JOYPAD_* — the vocabulary the UI and player share
export const BUTTONS = [
  { id: 0, name: 'B', hint: 'south' },
  { id: 1, name: 'Y', hint: 'west' },
  { id: 2, name: 'Select' },
  { id: 3, name: 'Start' },
  { id: 4, name: 'Up' },
  { id: 5, name: 'Down' },
  { id: 6, name: 'Left' },
  { id: 7, name: 'Right' },
  { id: 8, name: 'A', hint: 'east' },
  { id: 9, name: 'X', hint: 'north' },
  { id: 10, name: 'L' },
  { id: 11, name: 'R' },
  { id: 12, name: 'L2' },
  { id: 13, name: 'R2' },
  { id: 14, name: 'L3' },
  { id: 15, name: 'R3' },
];

export const DEFAULT_DEADZONE = 0.35;

export class MappingStore {
  constructor(userDataDir) {
    this.file = path.join(userDataDir, 'controllers.json');
    try {
      this.data = JSON.parse(readFileSync(this.file, 'utf8'));
    } catch {
      this.data = {};
    }
    this.data.devices ??= {}; // deviceKey → { name, deadzone }
    this.data.layers ??= {}; // layerKey → { deviceKey → { bindings } }
    this.data.portOrder ??= []; // deviceKey[] — player 1 first
    this.data.chords ??= {}; // action → { type:'button', index } (future)
  }

  save() {
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify(this.data, null, 2));
    } catch { /* best effort */ }
  }

  /** Stable key for a pad: SDL GUID when present, else its name. */
  static deviceKey(pad) {
    return pad?.guid || pad?.id || 'unknown';
  }

  noteDevice(key, name) {
    const cur = this.data.devices[key] ?? {};
    if (cur.name !== name) {
      this.data.devices[key] = { ...cur, name };
      this.save();
    }
  }

  deadzoneFor(key) {
    return this.data.devices[key]?.deadzone ?? DEFAULT_DEADZONE;
  }

  setDeadzone(key, value) {
    this.data.devices[key] = { ...(this.data.devices[key] ?? {}), deadzone: value };
    this.save();
  }

  /** Effective bindings for a device under a platform/game context. */
  resolve(deviceKey, { platform = null, gameKey = null } = {}) {
    const layers = ['global'];
    if (platform) layers.push(`platform:${platform}`);
    if (gameKey) layers.push(`game:${gameKey}`);
    const out = {};
    for (const layer of layers) {
      const b = this.data.layers[layer]?.[deviceKey]?.bindings;
      if (b) Object.assign(out, b);
    }
    return out;
  }

  /** Bind one button in one layer. `source` null clears the binding. */
  bind(deviceKey, buttonId, source, { layer = 'global' } = {}) {
    this.data.layers[layer] ??= {};
    this.data.layers[layer][deviceKey] ??= { bindings: {} };
    const bindings = this.data.layers[layer][deviceKey].bindings;
    if (source === null) delete bindings[buttonId];
    else bindings[buttonId] = source;
    this.save();
  }

  clearLayer(deviceKey, layer = 'global') {
    if (this.data.layers[layer]?.[deviceKey]) {
      delete this.data.layers[layer][deviceKey];
      this.save();
    }
  }

  /** Player order. Devices not listed fall in after the listed ones. */
  get portOrder() {
    return [...this.data.portOrder];
  }

  setPortOrder(keys) {
    this.data.portOrder = [...keys];
    this.save();
  }

  assignPort(deviceKey, port) {
    const order = this.data.portOrder.filter((k) => k !== deviceKey);
    order.splice(Math.max(0, port), 0, deviceKey);
    this.data.portOrder = order;
    this.save();
  }

  /**
   * The config handed to a player process at launch.
   * @param {{platform?:string, gameKey?:string}} ctx
   */
  playerConfig(ctx = {}) {
    const devices = {};
    for (const key of new Set([...Object.keys(this.data.devices), ...this.data.portOrder])) {
      const bindings = this.resolve(key, ctx);
      devices[key] = {
        bindings,
        deadzone: this.deadzoneFor(key),
        name: this.data.devices[key]?.name ?? null,
      };
    }
    return { devices, portOrder: this.portOrder };
  }

  /** Export a portable profile (a device's layers + deadzone). */
  exportProfile(deviceKey) {
    const layers = {};
    for (const [layer, byDevice] of Object.entries(this.data.layers)) {
      if (byDevice[deviceKey]) layers[layer] = byDevice[deviceKey];
    }
    return {
      kind: 'romdeck-controller-profile',
      version: 1,
      deviceKey,
      name: this.data.devices[deviceKey]?.name ?? null,
      deadzone: this.deadzoneFor(deviceKey),
      layers,
    };
  }

  importProfile(profile, { deviceKey = null } = {}) {
    if (profile?.kind !== 'romdeck-controller-profile') {
      throw new Error('not a romdeck controller profile');
    }
    const key = deviceKey ?? profile.deviceKey;
    if (!key) throw new Error('profile has no device key');
    this.data.devices[key] = {
      ...(this.data.devices[key] ?? {}),
      name: profile.name ?? this.data.devices[key]?.name ?? null,
      deadzone: profile.deadzone ?? DEFAULT_DEADZONE,
    };
    for (const [layer, entry] of Object.entries(profile.layers ?? {})) {
      this.data.layers[layer] ??= {};
      this.data.layers[layer][key] = { bindings: { ...(entry.bindings ?? {}) } };
    }
    this.save();
    return key;
  }
}
