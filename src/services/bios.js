// BIOS checker. Seed database of the firmware files romdeck's cores actually
// use, with widely-documented MD5s (libretro-docs lineage; facts re-expressed
// in our own schema, RetroDECK-style). `required: false` = core has an HLE
// fallback and the file is an accuracy upgrade, not a blocker.
//
// Files are looked for in <romsDir>/bios and <userData>/bios.
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

export const BIOS_DB = [
  { file: 'gba_bios.bin', md5: 'a860e8c0b6d573d191e4ec7db1b1e4f6', system: 'Game Boy Advance', desc: 'GBA BIOS', required: false },
  { file: 'gb_bios.bin', md5: '32fbbd84168d3482956eb3c5051637f5', system: 'Game Boy', desc: 'Game Boy boot ROM', required: false },
  { file: 'gbc_bios.bin', md5: 'dbfce9db9deaa2567f6a84fde55f9680', system: 'Game Boy Color', desc: 'Game Boy Color boot ROM', required: false },
  { file: 'scph5501.bin', md5: '490f666e1afb15b7362b406ed1cea246', system: 'PlayStation', desc: 'PS1 BIOS (US, SCPH-5501)', required: false },
  { file: 'scph5500.bin', md5: '8dd7d5296a650fac7319bce665a6a53c', system: 'PlayStation', desc: 'PS1 BIOS (JP, SCPH-5500)', required: false },
  { file: 'scph5502.bin', md5: '32736f17079d0b2b7024407c39bd3050', system: 'PlayStation', desc: 'PS1 BIOS (EU, SCPH-5502)', required: false },
  { file: '5200.rom', md5: '281f20ea4320404ec820fb7ec0693b38', system: 'Atari 5200', desc: 'Atari 5200 BIOS', required: true },
  { file: 'ATARIXL.ROM', md5: '06daac977823773a3eea3422fd26a703', system: 'Atari 800', desc: 'Atari XL OS ROM', required: true },
  { file: 'ATARIBAS.ROM', md5: '0bac0c6a50104045d902df4503a4c30b', system: 'Atari 800', desc: 'Atari BASIC ROM', required: true },
  { file: 'ATARIOSB.ROM', md5: 'a3e8d617c95d08031fe1b20d541434b2', system: 'Atari 800', desc: 'Atari 800 OS-B ROM', required: false },
  { file: 'colecovision.rom', md5: '2c66f5911e5b42b8ebe113403548eee7', system: 'ColecoVision', desc: 'ColecoVision BIOS', required: true },
  { file: 'syscard3.pce', md5: '38179df8f4ac870017db21ebcbf53114', system: 'PC Engine', desc: 'PCE CD System Card 3', required: false },
  { file: 'MSX.ROM', md5: 'aa95aea2563cd5ec0a0919b44cc17d47', system: 'MSX', desc: 'MSX main BIOS (fMSX)', required: false },
  { file: 'MSX2.ROM', md5: 'ec3a01c91f24fbddcbcab0ad301bc9ef', system: 'MSX', desc: 'MSX2 main BIOS (fMSX)', required: false },
  { file: 'MSX2EXT.ROM', md5: '2183c2aff17cf4297bdb496de78c2e8a', system: 'MSX', desc: 'MSX2 extended BIOS (fMSX)', required: false },
  { file: 'bios_CD_U.bin', md5: '2efd74e3232ff260e371b99f84024f7f', system: 'Genesis', desc: 'Sega CD BIOS (US, model 1)', required: false },
  { file: 'bios_CD_E.bin', md5: 'e66fa1dc5820d254611fdcdba0662372', system: 'Genesis', desc: 'Mega-CD BIOS (EU, model 1)', required: false },
  { file: 'bios_CD_J.bin', md5: '278a9397d192149e84e820ac621a8edd', system: 'Genesis', desc: 'Mega-CD BIOS (JP, model 1)', required: false },
];

export class BiosChecker {
  constructor(userDataDir) {
    this.userBiosDir = path.join(userDataDir, 'bios');
  }

  /**
   * Scan bios dirs and report per-entry status.
   * @param {string|null} romsDir
   * @returns {Array<{file,system,desc,required,status:'ok'|'bad-hash'|'missing',foundAt:string|null,md5:string|null}>}
   */
  check(romsDir) {
    const dirs = [this.userBiosDir];
    if (romsDir) dirs.unshift(path.join(romsDir, 'bios'));

    // Case-insensitive filename index across the bios dirs
    const found = new Map(); // lowercase name -> full path
    for (const dir of dirs) {
      if (!existsSync(dir)) continue;
      for (const f of readdirSync(dir)) {
        const key = f.toLowerCase();
        if (!found.has(key)) found.set(key, path.join(dir, f));
      }
    }

    return BIOS_DB.map((entry) => {
      const at = found.get(entry.file.toLowerCase()) ?? null;
      if (!at) return { ...entry, status: 'missing', foundAt: null, md5Actual: null };
      let md5 = null;
      try {
        md5 = createHash('md5').update(readFileSync(at)).digest('hex');
      } catch { /* unreadable */ }
      return {
        ...entry,
        status: md5 === entry.md5 ? 'ok' : 'bad-hash',
        foundAt: at,
        md5Actual: md5,
      };
    });
  }
}
