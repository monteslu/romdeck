// ScreenScraper.fr client -- hash-matched metadata + art, the richest source.
// Requires a per-app dev ID (register on their forum) and benefits from a
// per-user account (thread quota). Until credentials are configured in prefs
// ({ ss: { devid, devpassword, ssid, sspassword } }) every call reports
// 'not-configured' and romdeck stays on libretro-thumbnails.
const API = 'https://api.screenscraper.fr/api2/jeuInfos.php';

export class ScreenScraper {
  constructor(prefs) {
    this.prefs = prefs;
  }

  configured() {
    const ss = this.prefs.get('ss') ?? {};
    return !!(ss.devid && ss.devpassword);
  }

  /**
   * Look a game up by CRC (and filename as a hint).
   * @returns {Promise<{status:'not-configured'|'nomatch'|'ok', game?:object}>}
   */
  async lookup(rom, crc) {
    if (!this.configured()) return { status: 'not-configured' };
    const ss = this.prefs.get('ss');
    const params = new URLSearchParams({
      devid: ss.devid,
      devpassword: ss.devpassword,
      softname: 'romdeck',
      output: 'json',
      romtype: 'rom',
      crc: crc ?? '',
      romnom: rom.file ?? '',
    });
    if (ss.ssid) params.set('ssid', ss.ssid);
    if (ss.sspassword) params.set('sspassword', ss.sspassword);
    try {
      const res = await fetch(`${API}?${params}`, { signal: AbortSignal.timeout(20000) });
      if (!res.ok) return { status: 'nomatch' };
      const data = await res.json();
      const jeu = data?.response?.jeu;
      if (!jeu) return { status: 'nomatch' };
      return { status: 'ok', game: jeu };
    } catch {
      return { status: 'nomatch' };
    }
  }
}
