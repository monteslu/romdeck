// Minimal TrueType glyph reader: enough to turn a handful of characters into
// SVG path data at build time.
//
// Why this exists rather than a dependency: Shelf needs 34 capitals and digits
// to look identical on every platform. Bundling a whole 668 KB font for that
// is wasteful, subsetting needs a toolchain romdeck doesn't have, and adding
// fontkit/opentype.js to the app's dependencies to do work that happens ONCE
// at build time is the wrong trade. This reads glyf/loca/cmap directly, is
// used only by scripts/make-shelf-logos.mjs, and ships nothing at runtime —
// the logos come out as plain SVG paths.
//
// Scope is deliberately narrow: simple (non-composite) glyphs, quadratic
// curves, format-4 cmap. That covers Latin capitals and digits in every
// mainstream font. Anything else throws rather than emitting a wrong shape.
import { readFileSync } from 'node:fs';

export class TTF {
  constructor(file) {
    this.buf = readFileSync(file);
    this.tables = {};
    const numTables = this.buf.readUInt16BE(4);
    for (let i = 0; i < numTables; i++) {
      const o = 12 + i * 16;
      this.tables[this.buf.toString('latin1', o, o + 4)] = {
        off: this.buf.readUInt32BE(o + 8),
        len: this.buf.readUInt32BE(o + 12),
      };
    }
    const head = this.tables.head.off;
    this.unitsPerEm = this.buf.readUInt16BE(head + 18);
    this.indexToLocFormat = this.buf.readInt16BE(head + 50);
    this.numGlyphs = this.buf.readUInt16BE(this.tables.maxp.off + 4);
    this._cmap = this._readCmap();
    this._hmtx = this._readHmtx();
  }

  /** Unicode → glyph id, via a format-4 subtable. */
  _readCmap() {
    const { off } = this.tables.cmap;
    const n = this.buf.readUInt16BE(off + 2);
    let best = 0;
    for (let i = 0; i < n; i++) {
      const rec = off + 4 + i * 8;
      const platform = this.buf.readUInt16BE(rec);
      const encoding = this.buf.readUInt16BE(rec + 2);
      const sub = off + this.buf.readUInt32BE(rec + 4);
      // Windows BMP (3,1) is the one to prefer; Unicode (0,x) is a fine
      // fallback. Both are format 4 in practice.
      if ((platform === 3 && encoding === 1) || platform === 0) {
        if (this.buf.readUInt16BE(sub) === 4) { best = sub; if (platform === 3) break; }
      }
    }
    if (!best) throw new Error('no format-4 cmap subtable');

    const segCountX2 = this.buf.readUInt16BE(best + 6);
    const segCount = segCountX2 / 2;
    const endO = best + 14;
    const startO = endO + segCountX2 + 2;
    const deltaO = startO + segCountX2;
    const rangeO = deltaO + segCountX2;

    return (code) => {
      for (let s = 0; s < segCount; s++) {
        const end = this.buf.readUInt16BE(endO + s * 2);
        if (code > end) continue;
        const start = this.buf.readUInt16BE(startO + s * 2);
        if (code < start) return 0;
        const delta = this.buf.readInt16BE(deltaO + s * 2);
        const rangeOffset = this.buf.readUInt16BE(rangeO + s * 2);
        if (rangeOffset === 0) return (code + delta) & 0xffff;
        const gi = rangeO + s * 2 + rangeOffset + (code - start) * 2;
        const g = this.buf.readUInt16BE(gi);
        return g === 0 ? 0 : (g + delta) & 0xffff;
      }
      return 0;
    };
  }

  /** Glyph id → advance width, in font units. */
  _readHmtx() {
    const numH = this.buf.readUInt16BE(this.tables.hhea.off + 34);
    const off = this.tables.hmtx.off;
    return (gid) => {
      const i = Math.min(gid, numH - 1);
      return this.buf.readUInt16BE(off + i * 4);
    };
  }

  advanceOf(ch) {
    return this._hmtx(this._cmap(ch.codePointAt(0)));
  }

  _glyphRange(gid) {
    const loca = this.tables.loca.off;
    if (this.indexToLocFormat === 0) {
      return [this.buf.readUInt16BE(loca + gid * 2) * 2,
        this.buf.readUInt16BE(loca + (gid + 1) * 2) * 2];
    }
    return [this.buf.readUInt32BE(loca + gid * 4),
      this.buf.readUInt32BE(loca + (gid + 1) * 4)];
  }

  /**
   * SVG path data for one character, in font units with Y already flipped
   * so it reads in normal SVG coordinates.
   * @returns {{path: string, advance: number}}
   */
  glyphPath(ch) {
    const gid = this._cmap(ch.codePointAt(0));
    const advance = this._hmtx(gid);
    const [start, end] = this._glyphRange(gid);
    if (start === end) return { path: '', advance }; // blank, e.g. space

    const g = this.tables.glyf.off + start;
    const numContours = this.buf.readInt16BE(g);
    if (numContours < 0) {
      throw new Error(`composite glyph for ${JSON.stringify(ch)} is out of scope`);
    }

    // Contour end points
    const endPts = [];
    for (let i = 0; i < numContours; i++) endPts.push(this.buf.readUInt16BE(g + 10 + i * 2));
    const numPts = endPts[endPts.length - 1] + 1;

    let p = g + 10 + numContours * 2;
    p += 2 + this.buf.readUInt16BE(p); // skip instructions

    // Flags, run-length encoded
    const flags = [];
    while (flags.length < numPts) {
      const f = this.buf.readUInt8(p++);
      flags.push(f);
      if (f & 8) { let r = this.buf.readUInt8(p++); while (r-- > 0) flags.push(f); }
    }

    // Coordinates, stored as deltas with per-axis short/same encoding
    const xs = [];
    let x = 0;
    for (const f of flags) {
      if (f & 2) { const d = this.buf.readUInt8(p++); x += (f & 16) ? d : -d; }
      else if (!(f & 16)) { x += this.buf.readInt16BE(p); p += 2; }
      xs.push(x);
    }
    const ys = [];
    let y = 0;
    for (const f of flags) {
      if (f & 4) { const d = this.buf.readUInt8(p++); y += (f & 32) ? d : -d; }
      else if (!(f & 32)) { y += this.buf.readInt16BE(p); p += 2; }
      ys.push(y);
    }

    // Emit contours. TrueType is quadratic, and consecutive off-curve points
    // imply an on-curve midpoint between them.
    const cmds = [];
    let s = 0;
    for (const e of endPts) {
      const pts = [];
      for (let i = s; i <= e; i++) {
        pts.push({ x: xs[i], y: -ys[i], on: !!(flags[i] & 1) });
      }
      s = e + 1;
      if (!pts.length) continue;

      // Start on an on-curve point; synthesise one if the contour has none.
      let startIdx = pts.findIndex((q) => q.on);
      let first;
      if (startIdx < 0) {
        first = { x: (pts[0].x + pts[pts.length - 1].x) / 2,
          y: (pts[0].y + pts[pts.length - 1].y) / 2, on: true };
        startIdx = 0;
        pts.unshift(first);
      } else {
        first = pts[startIdx];
      }

      cmds.push(`M${r(first.x)} ${r(first.y)}`);
      let ctrl = null;
      for (let i = 1; i <= pts.length; i++) {
        const q = pts[(startIdx + i) % pts.length];
        if (q.on) {
          cmds.push(ctrl ? `Q${r(ctrl.x)} ${r(ctrl.y)} ${r(q.x)} ${r(q.y)}` : `L${r(q.x)} ${r(q.y)}`);
          ctrl = null;
        } else if (ctrl) {
          // Two off-curve points in a row: the implied on-curve point sits
          // halfway between them.
          const mid = { x: (ctrl.x + q.x) / 2, y: (ctrl.y + q.y) / 2 };
          cmds.push(`Q${r(ctrl.x)} ${r(ctrl.y)} ${r(mid.x)} ${r(mid.y)}`);
          ctrl = q;
        } else {
          ctrl = q;
        }
      }
      if (ctrl) cmds.push(`Q${r(ctrl.x)} ${r(ctrl.y)} ${r(first.x)} ${r(first.y)}`);
      cmds.push('Z');
    }
    return { path: cmds.join(''), advance };
  }
}

const r = (v) => Math.round(v);
