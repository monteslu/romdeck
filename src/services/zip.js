// Read ONE file out of a ZIP, with node:zlib and nothing else.
//
// romdeck has no zip dependency and this is not a good enough reason to add
// one: a stored-or-deflated ZIP member is a length-prefixed raw deflate stream,
// which zlib already does. statestore.js made the same call ("no zip dep").
//
// Deliberately NOT a general unzipper. It extracts a single named member for
// the homebrew feed, because several homebrew releases ship the ROM inside a
// zip alongside a LICENSE and a README. No directory traversal, no writing to
// disk, no multi-file extraction — it returns a Buffer to the caller.
import { inflateRawSync } from 'node:zlib';

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
const LFH_SIG = 0x04034b50;

/**
 * Every file in a ZIP, read from the CENTRAL DIRECTORY.
 *
 * The central directory is the authority, not the local headers: both feed
 * candidates were written by streaming writers that leave csize/usize as 0 in
 * the local header and put the real values in a trailing data descriptor. A
 * reader that trusts the local header sees every file as zero bytes.
 */
export function listZip(buf) {
  // The EOCD is at the end, after a comment of unknown length, so scan back.
  let eocd = buf.length - 22;
  const limit = Math.max(0, buf.length - 22 - 0xffff);
  while (eocd >= limit && buf.readUInt32LE(eocd) !== EOCD_SIG) eocd--;
  if (eocd < limit) throw new Error('not a zip file (no end-of-central-directory)');

  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== CD_SIG) break;
    const nameLen = buf.readUInt16LE(off + 28);
    entries.push({
      name: buf.slice(off + 46, off + 46 + nameLen).toString('utf8'),
      method: buf.readUInt16LE(off + 10),
      compressedSize: buf.readUInt32LE(off + 20),
      size: buf.readUInt32LE(off + 24),
      offset: buf.readUInt32LE(off + 42),
    });
    off += 46 + nameLen + buf.readUInt16LE(off + 30) + buf.readUInt16LE(off + 32);
  }
  return entries;
}

/** Is this a macOS resource-fork shadow rather than a real file? */
export function isMacJunk(name) {
  // A zip made on macOS carries a __MACOSX/…/._<name> twin for every file. It
  // has the same extension as the real thing and is a couple of hundred bytes,
  // so "the first entry ending in .gba" picks the 176-byte AppleDouble stub
  // instead of the 109 KB ROM and the core is handed garbage.
  return name.startsWith('__MACOSX/') || name.split('/').pop().startsWith('._');
}

/**
 * Extract one member by exact name, or by picking the largest real file
 * matching a predicate when `name` is null.
 *
 * @param {Buffer} buf   the whole zip
 * @param {string|null} name  exact member path, or null to auto-pick
 * @param {(n: string) => boolean} [accept]  filter used when name is null
 */
export function readZipEntry(buf, name, accept = () => true) {
  const files = listZip(buf).filter((e) => !e.name.endsWith('/') && !isMacJunk(e.name));

  let entry;
  if (name) {
    entry = files.find((e) => e.name === name);
    if (!entry) {
      throw new Error(`"${name}" not in archive (has: ${files.map((f) => f.name).join(', ')})`);
    }
  } else {
    // Largest match wins. Homebrew zips pair the ROM with a LICENSE and a
    // README, and the ROM is reliably the big one.
    const matches = files.filter((e) => accept(e.name)).sort((a, b) => b.size - a.size);
    if (!matches.length) throw new Error('no matching file in archive');
    entry = matches[0];
  }

  // Local header again for its OWN name/extra lengths — they can differ from
  // the central directory's, and the data starts right after them.
  const lho = entry.offset;
  if (buf.readUInt32LE(lho) !== LFH_SIG) throw new Error(`bad local header for ${entry.name}`);
  const start = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
  const raw = buf.slice(start, start + entry.compressedSize);

  const out = entry.method === 0 ? raw
    : entry.method === 8 ? inflateRawSync(raw)
      : null;
  if (!out) throw new Error(`unsupported compression method ${entry.method} for ${entry.name}`);
  if (entry.size && out.length !== entry.size) {
    throw new Error(`${entry.name}: expected ${entry.size} bytes, got ${out.length}`);
  }
  return { name: entry.name, data: out };
}
