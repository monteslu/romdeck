import {
  copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { listZip, readZipEntry, isMacJunk } from './zip.js';

function validateManifest(m) {
  if (m?.format !== 'active-bezel' || m.formatVersion !== 1) throw new Error('not an Active Bezel v1 package');
  if (!/^[a-z0-9][a-z0-9._-]{2,127}$/.test(m.id ?? '')) throw new Error('invalid Active Bezel id');
  if (!/^[0-9]+\.[0-9]+\.[0-9]+/.test(m.version ?? '')) throw new Error('invalid Active Bezel version');
  if (!m.name || m.runtime?.abi !== 'active-bezel-1') throw new Error('invalid Active Bezel manifest');
  if (!['cpu-rgba-v1', 'gpu-command-v1'].includes(m.runtime?.renderer)) throw new Error('unsupported Active Bezel renderer');
  if (typeof m.entry !== 'string' || !m.entry || m.entry.startsWith('/')
    || m.entry.includes('\\') || m.entry.split('/').includes('..')) {
    throw new Error('invalid Active Bezel entry');
  }
  m.settings ??= [];
  m.games ??= [];
  m.compatible ??= [];
  return m;
}

function manifestFromArchive(bytes) {
  const entries = listZip(bytes);
  const names = new Set(entries.map((entry) => entry.name));
  for (const entry of entries) {
    if (entry.name.startsWith('/') || entry.name.split('/').includes('..') || entry.name.includes('\\')) {
      throw new Error(`unsafe Active Bezel archive entry: ${entry.name}`);
    }
  }
  const manifest = validateManifest(JSON.parse(readZipEntry(bytes, 'manifest.json').data.toString('utf8')));
  if (!names.has(manifest.entry)) throw new Error(`Active Bezel package is missing ${manifest.entry}`);
  return manifest;
}

function canonicalRomBytes(rom) {
  const bytes = readFileSync(rom.path);
  if (path.extname(rom.path).toLowerCase() !== '.zip') return bytes;
  const supported = /\.(?:nes|sfc|smc|gb|gbc|gba|md|gen|smd|sms|gg|a26|a78|lnx|pce|rom|mx1|mx2)$/i;
  const candidates = listZip(bytes)
    .filter((entry) => !entry.name.endsWith('/') && !isMacJunk(entry.name) && supported.test(entry.name))
    .sort((a, b) => b.size - a.size);
  if (!candidates.length) throw new Error('no supported ROM in archive');
  return readZipEntry(bytes, candidates[0].name).data;
}

function defaults(schema) {
  return Object.fromEntries(schema.filter((s) => s.type !== 'action').map((s) => [s.key, s.default]));
}

function normalizeSetting(setting, value) {
  if (!setting) throw new Error('unknown Active Bezel setting');
  if (setting.type === 'boolean') return !!value;
  if (setting.type === 'choice') {
    const choices = setting.choices ?? [];
    const normalized = choices.find((choice) =>
      (typeof choice === 'object' ? choice.value : choice) === value);
    if (normalized === undefined) return setting.default;
    return typeof normalized === 'object' ? normalized.value : normalized;
  }
  if (['integer', 'float', 'number'].includes(setting.type)) {
    let n = Number(value);
    if (!Number.isFinite(n)) n = Number(setting.default) || 0;
    if (Number.isFinite(setting.min)) n = Math.max(setting.min, n);
    if (Number.isFinite(setting.max)) n = Math.min(setting.max, n);
    return setting.type === 'integer' ? Math.round(n) : n;
  }
  if (setting.type === 'color') {
    return /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i.test(String(value))
      ? String(value) : setting.default;
  }
  return value;
}

export class ActiveBezelStore {
  constructor(userDataDir, gameKeyFor) {
    this.root = path.join(userDataDir, 'active-bezels');
    this.file = path.join(userDataDir, 'active-bezels.json');
    this.gameKeyFor = gameKeyFor;
    mkdirSync(this.root, { recursive: true });
    try { this.data = JSON.parse(readFileSync(this.file, 'utf8')); } catch { this.data = {}; }
    this.data.packages ??= {};
    this.data.associations ??= {};
    this.data.config ??= {};
  }

  save() {
    mkdirSync(path.dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.data, null, 2));
  }

  install(source) {
    const archive = readFileSync(source);
    const manifest = manifestFromArchive(archive);
    const sha256 = crypto.createHash('sha256').update(archive).digest('hex');
    const dir = path.join(this.root, manifest.id, manifest.version);
    const destination = path.join(dir, `${sha256}.ab`);
    mkdirSync(dir, { recursive: true });
    if (!existsSync(destination)) copyFileSync(source, destination);
    const artifact = `${manifest.id}@${manifest.version}#${sha256}`;
    this.data.packages[artifact] = { artifact, path: destination, sha256, manifest, installedAt: new Date().toISOString() };
    this.save();
    return this.data.packages[artifact];
  }

  list() {
    return Object.values(this.data.packages).filter((pkg) => existsSync(pkg.path));
  }

  get(artifact) {
    const pkg = this.data.packages[artifact];
    return pkg && existsSync(pkg.path) ? pkg : null;
  }

  association(rom) {
    return this.data.associations[this.gameKeyFor(rom)] ?? null;
  }

  associate(rom, artifact, { force = false } = {}) {
    if (artifact !== null && artifact !== false && !this.get(artifact)) throw new Error('Active Bezel package is not installed');
    const key = this.gameKeyFor(rom);
    if (artifact === null) delete this.data.associations[key];
    else if (artifact === false) this.data.associations[key] = { disabled: true };
    else this.data.associations[key] = { artifact, force: !!force };
    this.save();
  }

  configFor(rom, manifestId) {
    const key = `${this.gameKeyFor(rom)}:${manifestId}`;
    const schema = this.list().find((x) => x.manifest.id === manifestId)?.manifest.settings ?? [];
    const stored = this.data.config[key]?.values ?? {};
    return Object.fromEntries(schema.filter((setting) => setting.type !== 'action').map((setting) => [
      setting.key,
      normalizeSetting(setting, stored[setting.key] === undefined ? setting.default : stored[setting.key]),
    ]));
  }

  resetConfig(rom, manifestId) {
    delete this.data.config[`${this.gameKeyFor(rom)}:${manifestId}`];
    this.save();
  }

  setConfig(rom, manifestId, settingKey, value, version = null) {
    const installed = this.list().find((x) => x.manifest.id === manifestId);
    const setting = installed?.manifest.settings?.find((x) => x.key === settingKey);
    if (setting?.type === 'action') return true;
    value = normalizeSetting(setting, value);
    const key = `${this.gameKeyFor(rom)}:${manifestId}`;
    this.data.config[key] ??= { version, values: {} };
    this.data.config[key].version = version;
    this.data.config[key].values[settingKey] = value;
    this.save();
    return value;
  }

  match(rom) {
    const explicit = this.association(rom);
    if (explicit?.disabled) return null;
    if (explicit) {
      const pkg = this.get(explicit.artifact);
      return pkg ? { package: pkg, level: explicit.force ? 'forced' : 'associated', force: explicit.force } : null;
    }
    let bytes;
    try { bytes = canonicalRomBytes(rom); } catch { return null; }
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    for (const pkg of this.list()) {
      const exact = pkg.manifest.games.find((g) => g.platform === rom.short && String(g.sha256).toLowerCase() === sha256);
      if (exact) return { package: pkg, level: 'exact', force: false };
      for (const rule of pkg.manifest.compatible) {
        if (rule.platform !== rom.short || rule.size !== bytes.length) continue;
        const ok = rule.signatures?.every((sig) => {
          const expected = Buffer.from(sig.bytes, 'hex');
          return bytes.subarray(sig.offset, sig.offset + expected.length).equals(expected);
        });
        if (ok) return { package: pkg, level: 'compatible', force: false };
      }
    }
    return null;
  }

  launchOptions(rom) {
    const match = this.match(rom);
    if (!match) return null;
    return {
      path: match.package.path,
      config: this.configFor(rom, match.package.manifest.id),
      force: match.force || match.level === 'associated',
      match: match.level,
      package: match.package,
    };
  }
}
