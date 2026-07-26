// Video snap playback.
//
// A snap is a short, silent, looping clip shown beside the selected game.
// It is NOT an HTMLMediaElement, and pretending otherwise is what would drag
// a browser back in: the stage needs frames and a loop point, nothing more.
//
// Degradation is the important property. If the WASM decoder has not been
// built, or a file is a container we do not handle, or a frame fails to
// decode, the element falls back to the game's static image — which is what
// ES-DE does before a snap starts anyway. A missing snap must never be a
// crash or a black hole in the layout.
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { demuxMp4, toAnnexB } from './mp4.js';
import { appDir } from '../paths.js';

const WASM_DIR = path.join(appDir(), 'src', 'ui', 'video', 'wasm');

let decoderFactory = null;
let decoderState = 'unknown'; // unknown | ready | unavailable

/**
 * Load the WASM decoder once.
 *
 * Returns null when it has not been built — callers treat that as "no snaps",
 * not as an error, because the build is optional
 * (scripts/build-video-decoder.sh).
 */
async function loadDecoder() {
  if (decoderState === 'unavailable') return null;
  if (decoderFactory) return decoderFactory;
  const js = path.join(WASM_DIR, 'h264.js');
  if (!existsSync(js)) {
    decoderState = 'unavailable';
    return null;
  }
  try {
    const mod = await import(js);
    decoderFactory = mod.default ?? mod.createH264Decoder;
    decoderState = 'ready';
    return decoderFactory;
  } catch {
    decoderState = 'unavailable';
    return null;
  }
}

export function decoderAvailable() {
  return decoderState !== 'unavailable';
}

/**
 * One snap, decoded on demand.
 *
 * Frames are decoded a few ahead and dropped when behind, because a snap is
 * decoration: it must never hold up the UI thread that a pad press is waiting
 * on.
 */
export class SnapPlayer {
  constructor() {
    this.file = null;
    this.track = null;
    this.buf = null;
    this.mod = null;
    this.index = 0;
    this.startedAt = 0;
    this.frame = null;      // { data: Uint8ClampedArray, width, height }
    this.failed = false;
    this.loops = 0;
  }

  get active() { return !!this.track && !this.failed; }

  /** Point at a file. Cheap: demux only, no decode. */
  async load(file) {
    if (this.file === file) return this.active;
    this.close();
    this.file = file;
    if (!file || !existsSync(file)) return false;
    // Only MP4 for now; ES-DE lists .mp4 first and every scraper writes it.
    if (!/\.mp4$/i.test(file)) return false;

    const factory = await loadDecoder();
    if (!factory) return false;

    try {
      this.buf = readFileSync(file);
      this.track = demuxMp4(this.buf);
      if (!this.track || !this.track.samples.length) { this.close(); return false; }
      this.mod = await factory();
      if (this.mod.ccall('h264_open', 'number', [], []) !== 0) { this.close(); return false; }
      this.index = 0;
      this.startedAt = Date.now();
      return true;
    } catch {
      this.failed = true;
      this.close();
      return false;
    }
  }

  /**
   * Advance to the frame due now, decoding what is needed.
   * @returns {boolean} true when a NEW frame became available
   */
  tick() {
    if (!this.active || !this.mod) return false;
    const elapsed = (Date.now() - this.startedAt) / 1000;
    const samples = this.track.samples;

    // Loop: a snap runs until the selection changes.
    if (this.index >= samples.length) {
      this.index = 0;
      this.startedAt = Date.now();
      this.loops++;
      return false;
    }
    if (samples[this.index].pts > elapsed) return false;

    // Catch up by decoding (not skipping) — H.264 frames depend on their
    // predecessors, so dropping input produces garbage rather than a jump.
    let produced = false;
    let guard = 0;
    while (this.index < samples.length && samples[this.index].pts <= elapsed && guard++ < 8) {
      const annexB = toAnnexB(this.buf, samples[this.index], this.track);
      this.index++;
      const ptr = this.mod._malloc(annexB.length);
      this.mod.HEAPU8.set(annexB, ptr);
      let rc;
      try {
        rc = this.mod.ccall('h264_decode', 'number', ['number', 'number'], [ptr, annexB.length]);
      } finally {
        this.mod._free(ptr);
      }
      if (rc < 0) { this.failed = true; return false; }
      if (rc === 1) produced = true;
    }

    if (produced) {
      const w = this.mod.ccall('h264_width', 'number', [], []);
      const h = this.mod.ccall('h264_height', 'number', [], []);
      const p = this.mod.ccall('h264_frame_ptr', 'number', [], []);
      if (w > 0 && h > 0 && p) {
        // A copy, because HEAPU8 can move when the WASM heap grows.
        this.frame = {
          data: new Uint8ClampedArray(this.mod.HEAPU8.subarray(p, p + w * h * 4)),
          width: w,
          height: h,
        };
      }
    }
    return produced;
  }

  close() {
    try { this.mod?.ccall('h264_close', null, [], []); } catch { /* already gone */ }
    this.mod = null;
    this.track = null;
    this.buf = null;
    this.frame = null;
    this.index = 0;
  }
}
