// RetroAchievements -- the #1 feature OpenEmu marked wontfix.
//
// TWO SERVERS, and the distinction is the whole reason this file is shaped the
// way it is:
//
//   API/  (Web API)      read-only. Profiles, game info, achievement lists and
//                        whether you have already earned them. Authenticated
//                        with the Web API key from the user's settings page.
//   dorequest.php        what emulators talk to. This is where an unlock is
//                        SUBMITTED. It does not accept the Web API key: it
//                        needs a session TOKEN, obtained once with r=login2
//                        and then reused.
//
// Both are used. The list comes from the Web API; the unlock goes to
// dorequest. Protocol details below are taken from rcheevos' own request
// builders (src/rapi/rc_api_user.c, rc_api_runtime.c), not guessed.
//
// Credentials live in prefs under `ra: { username, apiKey, token }`. apiKey is
// the Web API key from the settings page. token is the dorequest session
// token, which romdeck obtains itself -- from the API key where RA allows it,
// or from a password the user types once and which is NEVER stored.
const API = 'https://retroachievements.org/API/';
const DOREQUEST = 'https://retroachievements.org/dorequest.php';

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
   * unlocking -- but it is exactly right for THIS, and it is RA's own code, so
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
      return null; // optional dep, unreadable ROM, unknown console -- all "no hash"
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
    // Remember the hash per ROM: awardachievement takes it as `m`, and RA
    // uses it to attribute the unlock to the right game entry.
    this._hashes ??= new Map();
    this._hashes.set(rom.path, md5);
    return game.achievements
      .filter((a) => a.memaddr && !a.unlocked)
      .map((a) => ({ id: a.id, memaddr: a.memaddr, title: a.title }));
  }

  // ── dorequest: the half that can actually submit ───────────────────

  /**
   * POST to dorequest.php. Form-encoded in, JSON out.
   *
   * The User-Agent is REQUIRED and is not a courtesy: without one RA's edge
   * returns `403 Forbidden` as an HTML page, so every request fails and the
   * JSON parse fails after it. With one, the same request returns a proper
   * JSON body (including well-formed errors like invalid_credentials).
   * Measured against the live server, not assumed.
   *
   * RA also asks emulators to identify themselves so they can be supported and
   *, if necessary, blocked -- sending a real name is the honest thing anyway.
   */
  async _doRequest(params) {
    const res = await fetch(DOREQUEST, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': userAgent(),
      },
      body: new URLSearchParams(params),
      signal: AbortSignal.timeout(15000),
    });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { /* fall through to the error below */ }
    if (!data) {
      throw new Error(res.status === 403
        ? 'RetroAchievements rejected the request (403) -- missing or blocked User-Agent'
        : `dorequest ${res.status}: ${text.slice(0, 120)}`);
    }
    if (data.Success === false) {
      throw new Error(data.Error ?? `dorequest error ${data.Code ?? res.status}`);
    }
    return data;
  }

  /**
   * Get a dorequest session token (r=login2).
   *
   * Accepts EITHER an api token (`t`) or a password (`p`) -- rcheevos'
   * rc_api_init_login_request sends whichever it has. romdeck tries the stored
   * Web API key as `t` first, because that costs the user nothing; if RA
   * rejects it, a password may be supplied and is used once and discarded.
   * The returned token is what gets persisted, never the password.
   */
  async login({ password = null } = {}) {
    const { username, apiKey } = this.creds();
    if (!username) return { status: 'not-configured' };
    if (!password && !apiKey) return { status: 'not-configured' };
    try {
      const data = await this._doRequest({
        r: 'login2',
        u: username,
        ...(password ? { p: password } : { t: apiKey }),
      });
      if (!data.Token) throw new Error('login succeeded but returned no token');
      this.prefs.set('ra', { ...this.creds(), token: data.Token });
      return { status: 'ok', user: data.User ?? username, score: data.Score ?? 0 };
    } catch (err) {
      return { status: 'error', message: err.message };
    }
  }

  /** A token is what dorequest actually needs; the Web API key is not one. */
  canSubmit() {
    return !!(this.creds().username && this.creds().token);
  }

  /**
   * Submit an unlock (r=awardachievement).
   *
   * The `v` parameter is a signature RA verifies server-side. rcheevos builds
   * it as md5(achievementId + username + hardcoreFlag) -- concatenated as
   * DECIMAL STRINGS with no separator (rc_api_runtime.c). Getting this wrong
   * is rejected by the server, so it is derived from upstream rather than
   * invented.
   *
   * hardcore is 0. romdeck offers save states, rewind and fast-forward, and
   * RA's hardcore rules forbid all three -- claiming hardcore would be lying to
   * the server about how the achievement was earned.
   */
  async award(rom, achievementId, { hardcore = false, gameHash = null } = {}) {
    gameHash ??= this._hashes?.get(rom?.path) ?? null;
    const { username, token } = this.creds();
    if (!username) return { status: 'not-configured' };
    if (!token) {
      // Try once to upgrade the stored API key into a session token, so a user
      // who only ever pasted an API key still gets submissions.
      const res = await this.login();
      if (res.status !== 'ok') {
        return { status: 'no-token', message: 'RA login needed before unlocks can be submitted' };
      }
    }
    const h = hardcore ? 1 : 0;
    const sig = await md5Hex(`${achievementId}${username}${h}`);
    try {
      const data = await this._doRequest({
        r: 'awardachievement',
        u: username,
        t: this.creds().token,
        a: String(achievementId),
        h: String(h),
        v: sig,
        ...(gameHash ? { m: gameHash } : {}),
      });
      return {
        status: 'ok',
        achievementId,
        score: data.Score ?? null,
        softcoreScore: data.SoftcoreScore ?? null,
      };
    } catch (err) {
      return { status: 'error', achievementId, message: err.message };
    }
  }
}

/** How romdeck identifies itself to RA. Required -- see _doRequest. */
function userAgent() {
  return `romdeck/${process.env.npm_package_version ?? '0.2.0'}`;
}

/** md5 of an ASCII string, hex. Node's crypto -- no dependency needed. */
async function md5Hex(s) {
  const { createHash } = await import('node:crypto');
  return createHash('md5').update(s, 'utf8').digest('hex');
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
