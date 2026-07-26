// Battery, wifi and bluetooth state, for the <systemstatus> theme element.
//
// ES-DE draws an indicator row here (SystemStatusComponent: mBattery,
// mBatteryPercentage, wifi, bluetooth) and every theme in the catalogue
// places one. It is the last themable element that needed something other
// than a renderer -- the values are device telemetry, not theme data.
//
// Linux exposes all of it as plain files, so this needs no native module and
// no polling daemon:
//
//   /sys/class/power_supply/*/capacity   0-100
//   /sys/class/power_supply/*/status     Charging | Discharging | Full
//   /sys/class/net/*/operstate           up | down
//   /proc/net/wireless                   signal level per interface
//
// On a desktop with no battery the battery fields are simply null and the
// theme's battery icon is skipped, which is what ES-DE does too.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const POWER = '/sys/class/power_supply';
const NET = '/sys/class/net';

function readTrimmed(file) {
  try { return readFileSync(file, 'utf8').trim(); } catch { return null; }
}

/**
 * The system battery, or null.
 *
 * A "battery" under /sys/class/power_supply can also be a wireless MOUSE or
 * gamepad -- this machine reports a controller's cell at 100%. Those have a
 * scope of "Device"; the system battery does not, which is how they are told
 * apart. Reporting a mouse as the handheld's battery would be worse than
 * reporting nothing.
 */
export function battery() {
  if (!existsSync(POWER)) return null;
  let names;
  try { names = readdirSync(POWER); } catch { return null; }
  for (const name of names) {
    const dir = path.join(POWER, name);
    if (readTrimmed(path.join(dir, 'type')) !== 'Battery') continue;
    if (readTrimmed(path.join(dir, 'scope')) === 'Device') continue;
    const capacity = Number(readTrimmed(path.join(dir, 'capacity')));
    if (!Number.isFinite(capacity)) continue;
    const status = readTrimmed(path.join(dir, 'status')) ?? 'Unknown';
    return { capacity, charging: status === 'Charging' || status === 'Full' };
  }
  return null;
}

/** Wifi: connected plus a 0-4 bar strength, or null when there is no radio. */
export function wifi() {
  if (!existsSync(NET)) return null;
  let names;
  try { names = readdirSync(NET); } catch { return null; }
  const iface = names.find((n) => existsSync(path.join(NET, n, 'wireless')));
  if (!iface) return null;
  const up = readTrimmed(path.join(NET, iface, 'operstate')) === 'up';
  if (!up) return { connected: false, bars: 0 };
  // /proc/net/wireless reports link quality in the 3rd column, 0-70ish.
  let bars = 0;
  const table = readTrimmed('/proc/net/wireless');
  const row = table?.split('\n').find((l) => l.trim().startsWith(`${iface}:`));
  if (row) {
    const quality = Number(row.trim().split(/\s+/)[2]);
    if (Number.isFinite(quality)) bars = Math.max(1, Math.min(4, Math.round(quality / 17.5)));
  }
  return { connected: true, bars };
}

/** Bluetooth: powered on or not. rfkill is the one file that always exists. */
export function bluetooth() {
  const dir = '/sys/class/rfkill';
  if (!existsSync(dir)) return null;
  let names;
  try { names = readdirSync(dir); } catch { return null; }
  for (const name of names) {
    if (readTrimmed(path.join(dir, name, 'type')) !== 'bluetooth') continue;
    return { on: readTrimmed(path.join(dir, name, 'soft')) === '0' };
  }
  return null;
}

/**
 * Everything at once, cached briefly.
 *
 * The status row is repainted on every frame a theme shows it, and reading
 * four sysfs files per frame would be a syscall storm for values that change
 * on a scale of minutes.
 */
let cache = null;
let cachedAt = 0;
export function deviceStatus(ttlMs = 10000, now = Date.now()) {
  if (cache && now - cachedAt < ttlMs) return cache;
  cache = { battery: battery(), wifi: wifi(), bluetooth: bluetooth() };
  cachedAt = now;
  return cache;
}
