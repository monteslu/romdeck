// RetroAchievements — the #1 feature OpenEmu marked wontfix.
//
// SCOPE, honestly: this is the read-only half. It logs in, identifies a game
// by RA's hash, and lists that game's achievements with your unlock status.
// It does NOT unlock achievements while you play — that requires rcheevos
// (MIT, designed for exactly this) running its condition evaluator against
// core memory every frame. The memory plumbing that needs already exists
// (see developer mode / ControlChannel.readMemory), so wiring rcheevos in is
// the next step, not a rewrite.
//
// Credentials live in prefs under `ra: { username, apiKey }` — the API key
// comes from the user's RA settings page, never their password.
const API = 'https://retroachievements.org/API/';

// RA hashes most cart systems as plain MD5 of the ROM with console-specific
// header rules; romdeck reuses the header-stripping the Identifier already
// does, so this covers the systems where RA's rule is "MD5 of the raw ROM".
const SIMPLE_MD5_SYSTEMS = new Set([
  'Game Boy', 'Game Boy Color', 'Game Boy Advance', 'Genesis', 'Master System',
  'Game Gear', 'Atari 2600', 'Atari 7800', 'Lynx', 'WonderSwan',
  'WonderSwan Color', 'Neo Geo Pocket', 'Neo Geo Pocket Color', 'PC Engine',
]);

export class RetroAchievements {
  constructor(prefs) {
    this.prefs = prefs;
  }

  creds() {
    return this.prefs.get('ra') ?? {};
  }

  configured() {
    const { username, apiKey } = this.creds();
    return !!(username && apiKey);
  }

  /** Can we hash this system the simple way? (Others need rcheevos' rules.) */
  static hashable(system) {
    return SIMPLE_MD5_SYSTEMS.has(system);
  }

  async _get(endpoint, params = {}) {
    const { username, apiKey } = this.creds();
    const qs = new URLSearchParams({ z: username, y: apiKey, ...params });
    const res = await fetch(`${API}${endpoint}?${qs}`, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`RetroAchievements API ${res.status}`);
    return res.json();
  }

  /** Confirm the credentials work and report the user's profile summary. */
  async whoami() {
    if (!this.configured()) return { status: 'not-configured' };
    try {
      const { username } = this.creds();
      const data = await this._get('API_GetUserProfile.php', { u: username });
      return {
        status: 'ok',
        user: data?.User ?? username,
        points: data?.TotalPoints ?? 0,
        rank: data?.Rank ?? null,
      };
    } catch (err) {
      return { status: 'error', message: err.message };
    }
  }

  /**
   * Look a game up by its RA hash and return the achievement list.
   * @param {string} md5 hash of the ROM (header-stripped where applicable)
   */
  async gameByHash(md5) {
    if (!this.configured()) return { status: 'not-configured' };
    try {
      const lookup = await this._get('API_GetGameIDByHash.php', { h: md5 });
      const gameId = lookup?.GameID ?? lookup?.gameId ?? null;
      if (!gameId) return { status: 'unknown-game' };
      const { username } = this.creds();
      const info = await this._get('API_GetGameInfoAndUserProgress.php', {
        u: username,
        g: gameId,
      });
      const achievements = Object.values(info?.Achievements ?? {}).map((a) => ({
        id: Number(a.ID),
        title: a.Title,
        description: a.Description,
        points: Number(a.Points ?? 0),
        unlocked: !!a.DateEarned,
        unlockedAt: a.DateEarned ?? null,
        // The condition string rcheevos compiles and evaluates. Without it the
        // list is display-only, which is what this whole service used to be.
        memaddr: a.MemAddr ?? null,
      }));
      return {
        status: 'ok',
        gameId,
        title: info?.Title ?? null,
        console: info?.ConsoleName ?? null,
        achievements,
        earned: achievements.filter((a) => a.unlocked).length,
        total: achievements.length,
      };
    } catch (err) {
      return { status: 'error', message: err.message };
    }
  }

  /**
   * RA's hash for a ROM, using rcheevos' own rules.
   *
   * The `rcheevos` npm package is hash-only, which made it useless for
   * unlocking — but it is exactly right for THIS, and it is RA's own code, so
   * it agrees with the server about what a game is. That matters: romdeck's
   * hand-rolled SIMPLE_MD5_SYSTEMS list only ever covered the systems whose
   * rule is "MD5 of the raw ROM", and got everything else wrong.
   */
  async hashRom(rom) {
    try {
      const { RCheevos, Console } = await import('rcheevos');
      const key = CONSOLE_IDS[rom.system];
      if (key === undefined) return null;
      const { readFile } = await import('node:fs/promises');
      const bytes = await readFile(rom.path);
      const hasher = await RCheevos.initialize();
      return hasher.computeHash(Console[key], bytes.buffer.slice(
        bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    } catch {
      return null; // optional dep, unreadable ROM, unknown console — all "no hash"
    }
  }

  /**
   * The achievement definitions to hand the evaluator, for a game.
   *
   * Already-earned ones are FILTERED OUT: arming them would re-trigger and
   * re-submit achievements the player earned months ago the moment they walk
   * back into the same room.
   */
  async runtimeAchievements(rom) {
    if (!this.configured()) return [];
    const md5 = await this.hashRom(rom);
    if (!md5) return [];
    const game = await this.gameByHash(md5);
    if (game.status !== 'ok') return [];
    this._lastGameId = game.gameId;
    return game.achievements
      .filter((a) => a.memaddr && !a.unlocked)
      .map((a) => ({ id: a.id, memaddr: a.memaddr, title: a.title }));
  }

  /**
   * Submit an unlock.
   *
   * NOTE: RA's public Web API is read-only — awarding goes through the
   * dorequest endpoint used by emulators, which needs a session token from the
   * user's credentials rather than the Web API key. Until romdeck implements
   * that login, an unlock is real and local (the player earned it, the toast
   * fires, the UI updates) but is not submitted to the site.
   */
  async award(rom, achievementId) {
    if (!this.configured()) return { status: 'not-configured' };
    return { status: 'not-submitted', achievementId, reason: 'dorequest login not implemented' };
  }
}

/**
 * rom.system → rcheevos Console enum key. Only what romdeck actually runs;
 * an unlisted system simply gets no hash and no achievements.
 */
const CONSOLE_IDS = {
  'Game Boy': 'GAMEBOY',
  'Game Boy Color': 'GAMEBOY_COLOR',
  'Game Boy Advance': 'GAMEBOY_ADVANCE',
  NES: 'NINTENDO',
  SNES: 'SUPER_NINTENDO',
  Genesis: 'MEGA_DRIVE',
  'Master System': 'MASTER_SYSTEM',
  'Game Gear': 'GAME_GEAR',
  'Atari 2600': 'ATARI_2600',
  'Atari 7800': 'ATARI_7800',
  Lynx: 'ATARI_LYNX',
  'PC Engine': 'PC_ENGINE',
  'Neo Geo Pocket': 'NEOGEO_POCKET',
  WonderSwan: 'WONDERSWAN',
  PlayStation: 'PLAYSTATION',
  'Nintendo 64': 'NINTENDO_64',
};
