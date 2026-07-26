// A minimal ISO-BMFF (MP4) demuxer.
//
// Video snaps are the one thing Electron was genuinely buying (<video> and
// its decoder). Replacing it does NOT mean porting ffmpeg: a snap is a
// container holding H.264 samples, and demuxing is pure structure — boxes,
// offsets, sizes. No native code belongs at this layer, so there is none.
//
// Scope follows ES-DE's own list (FileData.h: .mp4 first) and the reality
// that every scraper (ScreenScraper, Skraper, EmuMovies) writes MP4/H.264.
// Other containers fall back to the static image rather than being half
// supported.
//
// What this produces: SPS/PPS from avcC, plus length-prefixed samples ready
// for a decoder, with presentation times.
const FULLBOX = new Set(['mvhd', 'tkhd', 'mdhd', 'hdlr', 'stsd', 'stts', 'stsc', 'stsz', 'stco', 'co64', 'stss']);

class Reader {
  constructor(buf) { this.buf = buf; this.p = 0; }
  u8() { return this.buf[this.p++]; }
  u16() { const v = this.buf.readUInt16BE(this.p); this.p += 2; return v; }
  u32() { const v = this.buf.readUInt32BE(this.p); this.p += 4; return v; }
  u64() { const v = Number(this.buf.readBigUInt64BE(this.p)); this.p += 8; return v; }
  str(n) { const v = this.buf.toString('latin1', this.p, this.p + n); this.p += n; return v; }
  skip(n) { this.p += n; }
  get left() { return this.buf.length - this.p; }
}

/** Walk boxes at this level, calling back for each. */
function boxes(r, end, fn) {
  while (r.p + 8 <= end) {
    const start = r.p;
    let size = r.u32();
    const type = r.str(4);
    if (size === 1) size = r.u64();
    else if (size === 0) size = end - start;
    if (size < 8) break;
    const bodyEnd = Math.min(start + size, end);
    if (FULLBOX.has(type)) { r.u8(); r.skip(3); } // version + flags
    fn(type, r, bodyEnd);
    r.p = bodyEnd;
  }
}

/**
 * Parse an MP4 into decodable video samples.
 *
 * @returns {{width, height, timescale, sps, pps, nalLengthSize, samples}|null}
 */
export function demuxMp4(buf) {
  const r = new Reader(buf);
  const track = {
    timescale: 1000,
    width: 0,
    height: 0,
    sps: null,
    pps: null,
    nalLengthSize: 4,
    stts: [],
    stsc: [],
    stsz: [],
    chunkOffsets: [],
    syncSamples: null,
    isVideo: false,
  };
  let found = null;

  boxes(r, buf.length, (type, rr, end) => {
    if (type === 'moov') {
      boxes(rr, end, (t2, r2, e2) => {
        if (t2 !== 'trak') return;
        const t = { ...track, stts: [], stsc: [], stsz: [], chunkOffsets: [], isVideo: false };
        parseTrak(r2, e2, t);
        // First video track wins; snaps have exactly one.
        if (t.isVideo && t.sps && !found) found = t;
      });
    }
  });

  if (!found) return null;
  found.samples = buildSamples(found, buf);
  return found;
}

function parseTrak(r, end, t) {
  boxes(r, end, (type, rr, e) => {
    if (type === 'mdia') {
      boxes(rr, e, (t2, r2, e2) => {
        if (t2 === 'mdhd') {
          r2.u32(); r2.u32(); // creation, modification
          t.timescale = r2.u32();
        } else if (t2 === 'hdlr') {
          r2.u32(); // pre_defined
          if (r2.str(4) === 'vide') t.isVideo = true;
        } else if (t2 === 'minf') {
          boxes(r2, e2, (t3, r3, e3) => {
            if (t3 === 'stbl') parseStbl(r3, e3, t);
          });
        }
      });
    }
  });
}

function parseStbl(r, end, t) {
  boxes(r, end, (type, rr, e) => {
    switch (type) {
      case 'stsd': {
        rr.u32(); // entry count
        boxes(rr, e, (t2, r2, e2) => {
          if (!/^avc[13]$/.test(t2)) return;
          r2.skip(6 + 2 + 16); // reserved, data ref index, pre_defined
          t.width = r2.u16();
          t.height = r2.u16();
          r2.skip(50);
          boxes(r2, e2, (t3, r3) => {
            if (t3 !== 'avcC') return;
            r3.skip(4); // configVersion, profile, compat, level
            t.nalLengthSize = (r3.u8() & 0x03) + 1;
            const numSps = r3.u8() & 0x1f;
            for (let i = 0; i < numSps; i++) {
              const len = r3.u16();
              const nal = r3.buf.subarray(r3.p, r3.p + len);
              if (!t.sps) t.sps = Buffer.from(nal);
              r3.skip(len);
            }
            const numPps = r3.u8();
            for (let i = 0; i < numPps; i++) {
              const len = r3.u16();
              const nal = r3.buf.subarray(r3.p, r3.p + len);
              if (!t.pps) t.pps = Buffer.from(nal);
              r3.skip(len);
            }
          });
        });
        break;
      }
      case 'stts': {
        const n = rr.u32();
        for (let i = 0; i < n; i++) t.stts.push({ count: rr.u32(), delta: rr.u32() });
        break;
      }
      case 'stsc': {
        const n = rr.u32();
        for (let i = 0; i < n; i++) {
          t.stsc.push({ first: rr.u32(), perChunk: rr.u32(), descIndex: rr.u32() });
        }
        break;
      }
      case 'stsz': {
        const uniform = rr.u32();
        const n = rr.u32();
        if (uniform) for (let i = 0; i < n; i++) t.stsz.push(uniform);
        else for (let i = 0; i < n; i++) t.stsz.push(rr.u32());
        break;
      }
      case 'stco': {
        const n = rr.u32();
        for (let i = 0; i < n; i++) t.chunkOffsets.push(rr.u32());
        break;
      }
      case 'co64': {
        const n = rr.u32();
        for (let i = 0; i < n; i++) t.chunkOffsets.push(rr.u64());
        break;
      }
      case 'stss': {
        const n = rr.u32();
        t.syncSamples = new Set();
        for (let i = 0; i < n; i++) t.syncSamples.add(rr.u32() - 1);
        break;
      }
      default: break;
    }
  });
}

/**
 * Turn the sample tables into a flat list of {offset, size, pts, keyframe}.
 *
 * This is the whole reason the tables exist: chunk offsets plus
 * samples-per-chunk plus sizes give byte ranges, and the time-to-sample table
 * gives presentation times.
 */
function buildSamples(t, buf) {
  const samples = [];
  let sampleIndex = 0;
  let dts = 0;
  let sttsRun = 0;
  let sttsLeft = t.stts[0]?.count ?? 0;

  for (let c = 0; c < t.chunkOffsets.length; c++) {
    // How many samples this chunk holds, per the stsc run it falls in.
    let perChunk = 1;
    for (let i = t.stsc.length - 1; i >= 0; i--) {
      if (c + 1 >= t.stsc[i].first) { perChunk = t.stsc[i].perChunk; break; }
    }
    let offset = t.chunkOffsets[c];
    for (let s = 0; s < perChunk && sampleIndex < t.stsz.length; s++, sampleIndex++) {
      const size = t.stsz[sampleIndex];
      if (offset + size > buf.length) break;
      const delta = t.stts[sttsRun]?.delta ?? 0;
      samples.push({
        offset,
        size,
        pts: dts / t.timescale,
        keyframe: t.syncSamples ? t.syncSamples.has(sampleIndex) : sampleIndex === 0,
      });
      dts += delta;
      offset += size;
      if (--sttsLeft <= 0 && sttsRun < t.stts.length - 1) {
        sttsRun++;
        sttsLeft = t.stts[sttsRun].count;
      }
    }
  }
  return samples;
}

/**
 * Convert a length-prefixed AVCC sample to Annex-B, prepending SPS/PPS on a
 * keyframe. Decoders want start codes, containers store lengths.
 */
export function toAnnexB(buf, sample, track) {
  const parts = [];
  const startCode = Buffer.from([0, 0, 0, 1]);
  if (sample.keyframe && track.sps && track.pps) {
    parts.push(startCode, track.sps, startCode, track.pps);
  }
  let p = sample.offset;
  const end = sample.offset + sample.size;
  const n = track.nalLengthSize;
  while (p + n <= end) {
    let len = 0;
    for (let i = 0; i < n; i++) len = (len << 8) | buf[p + i];
    p += n;
    if (len <= 0 || p + len > end) break;
    parts.push(startCode, buf.subarray(p, p + len));
    p += len;
  }
  return Buffer.concat(parts);
}
