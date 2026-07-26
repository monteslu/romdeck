// System identity: display name → ES-DE shortname (folder/gamelist ids) and
// libretro thumbnail-repo system name. Shortnames follow ES-DE so gamelists
// and media layouts round-trip with ES-DE / RetroDECK / Batocera.
export const SYSTEMS = {
  'NES':                { short: 'nes',            libretro: 'Nintendo - Nintendo Entertainment System' },
  'SNES':               { short: 'snes',           libretro: 'Nintendo - Super Nintendo Entertainment System' },
  'Game Boy':           { short: 'gb',             libretro: 'Nintendo - Game Boy' },
  'Game Boy Color':     { short: 'gbc',            libretro: 'Nintendo - Game Boy Color' },
  'Game Boy Advance':   { short: 'gba',            libretro: 'Nintendo - Game Boy Advance' },
  'Nintendo 64':        { short: 'n64',            libretro: 'Nintendo - Nintendo 64' },
  'Genesis':            { short: 'genesis',        libretro: 'Sega - Mega Drive - Genesis' },
  'Master System':      { short: 'mastersystem',   libretro: 'Sega - Master System - Mark III' },
  'Game Gear':          { short: 'gamegear',       libretro: 'Sega - Game Gear' },
  'SG-1000':            { short: 'sg-1000',        libretro: 'Sega - SG-1000' },
  'Atari 2600':         { short: 'atari2600',      libretro: 'Atari - 2600' },
  'Atari 5200':         { short: 'atari5200',      libretro: 'Atari - 5200' },
  'Atari 7800':         { short: 'atari7800',      libretro: 'Atari - 7800' },
  'Atari 800':          { short: 'atari800',       libretro: 'Atari - 8-bit' },
  'Lynx':               { short: 'atarilynx',      libretro: 'Atari - Lynx' },
  'PC Engine':          { short: 'pcengine',       libretro: 'NEC - PC Engine - TurboGrafx 16' },
  'Neo Geo Pocket':     { short: 'ngp',            libretro: 'SNK - Neo Geo Pocket' },
  'Neo Geo Pocket Color': { short: 'ngpc',         libretro: 'SNK - Neo Geo Pocket Color' },
  'WonderSwan':         { short: 'wonderswan',     libretro: 'Bandai - WonderSwan' },
  'WonderSwan Color':   { short: 'wonderswancolor', libretro: 'Bandai - WonderSwan Color' },
  'ColecoVision':       { short: 'colecovision',   libretro: 'Coleco - ColecoVision' },
  'Vectrex':            { short: 'vectrex',        libretro: 'GCE - Vectrex' },
  'ZX Spectrum':        { short: 'zxspectrum',     libretro: 'Sinclair - ZX Spectrum' },
  'MSX':                { short: 'msx',            libretro: 'Microsoft - MSX' },
  'PlayStation':        { short: 'psx',            libretro: 'Sony - PlayStation' },
  'Commodore 64':       { short: 'c64',            libretro: 'Commodore - 64' },
  'PICO-8':             { short: 'pico8',          libretro: null },
  'GameTank':           { short: 'gametank',       libretro: null },
  'WASM Cart':          { short: 'wasmcart',       libretro: null },
  'JS Game':            { short: 'jsgame',         libretro: null },
  'Archive':            { short: 'archive',        libretro: null },
  'Unknown':            { short: 'unknown',        libretro: null },
};

export function shortnameOf(systemDisplay) {
  return SYSTEMS[systemDisplay]?.short ?? 'unknown';
}

export function libretroNameOf(systemDisplay) {
  return SYSTEMS[systemDisplay]?.libretro ?? null;
}
