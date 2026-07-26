// GL present path.
//
// The CPU path copies a 1920x1080 RGBA stage into a window-sized buffer on
// every frame — fine on a desktop, measurable at 4K, and worse on a handheld
// where the copy competes with an emulator for memory bandwidth. GL uploads
// the stage once per repaint as a texture and lets the GPU do the scaling,
// which is the same lesson jsgame-libretro already learned with its gl_blit
// two-canvas pattern.
//
// Scope is deliberately narrow (NATIVE-FRONTEND §5): present and scale. Text,
// images, layout and tinting stay in skia, which does them well at ~200 fps.
// This exists for the blit, for video snap frames later, and eventually for
// ES-DE's genuinely-3D carousel transitions.
import { fitRect, STAGE_W, STAGE_H } from './present.js';

const VERT = `#version 300 es
in vec2 aPos;
in vec2 aUV;
out vec2 vUV;
void main() {
  vUV = aUV;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const FRAG = `#version 300 es
precision mediump float;
in vec2 vUV;
uniform sampler2D uTex;
out vec4 fragColor;
void main() { fragColor = texture(uTex, vUV); }`;

export class GlPresenter {
  constructor(window, gl) {
    this.window = window;
    this.kind = 'gl';
    this.frames = 0;
    this._w = 0;
    this._h = 0;
    this.gl = gl;
    this._init();
  }

  /**
   * Build a presenter, creating the GL context.
   *
   * Two acquisition paths, in jsgamelauncher's order (launcher.js:520-570),
   * because that order is what makes this work on handhelds as well as
   * desktops:
   *
   *   1. fbdev window surface — Mali/embedded, and it must be attempted
   *      BEFORE SDL takes the display.
   *   2. the SDL window's native GL handle — X11/Wayland desktops.
   *
   * Async because the binding is imported on demand: a machine with no
   * working GL stack must fall back to the CPU path, not fail to start.
   */
  static async create(window) {
    const { createWebGL2Context } = await import('webgl-node');
    const w = window.pixelWidth;
    const h = window.pixelHeight;

    const attempts = [];
    const nativeGL = window.native?.gl;
    if (nativeGL) attempts.push(['native window', { nativeWindow: nativeGL }]);
    attempts.push(['fbdev surface', { windowSurface: true }]);

    let lastErr = null;
    for (const [label, opts] of attempts) {
      try {
        const res = createWebGL2Context(w, h, opts);
        if (!res?.gl) throw new Error('no context returned');
        // Vsync off: the UI repaints on events, so blocking on a vblank
        // would add latency to a keypress for no benefit.
        res.setSwapInterval?.(0);
        const p = new GlPresenter(window, res.gl);
        p.swapBuffers = res.swapBuffers ?? null;
        p.makeCurrent = res.makeCurrent ?? null;
        p.acquiredVia = label;
        return p;
      } catch (err) {
        lastErr = err;
      }
    }
    throw new Error(`no GL context (${lastErr?.message ?? 'unknown'})`);
  }

  _init() {
    const gl = this.gl;

    const compile = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        throw new Error(`shader: ${gl.getShaderInfoLog(s)}`);
      }
      return s;
    };

    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error(`link: ${gl.getProgramInfoLog(prog)}`);
    }
    this.prog = prog;
    gl.useProgram(prog);

    // A full-screen quad with the V axis flipped: canvas pixel data is
    // top-down, GL textures are bottom-up.
    this.vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -1, -1, 0, 1,
       1, -1, 1, 1,
      -1,  1, 0, 0,
       1,  1, 1, 0,
    ]), gl.STATIC_DRAW);

    const aPos = gl.getAttribLocation(prog, 'aPos');
    const aUV = gl.getAttribLocation(prog, 'aUV');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(aUV);
    gl.vertexAttribPointer(aUV, 2, gl.FLOAT, false, 16, 8);

    this.tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    // LINEAR: the stage is scaled to arbitrary window sizes, and nearest
    // would alias the UI text badly. Games are a different matter and are
    // presented by the player process, not here.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.uniform1i(gl.getUniformLocation(prog, 'uTex'), 0);
  }

  present(stage) {
    const gl = this.gl;
    const w = this.window.pixelWidth;
    const h = this.window.pixelHeight;
    const pixels = new Uint8Array(stage.data().buffer);

    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    if (this._w !== STAGE_W || this._h !== STAGE_H) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, STAGE_W, STAGE_H, 0, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      this._w = STAGE_W;
      this._h = STAGE_H;
    } else {
      // texSubImage2D on an already-allocated texture avoids reallocating
      // 8 MB of GPU memory every frame.
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, STAGE_W, STAGE_H, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    }

    // Letterbox in the viewport rather than in pixels: the GPU scales, and
    // the black bars cost nothing.
    const r = fitRect(w, h);
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.viewport(Math.round(r.x), Math.round(h - r.y - r.h), Math.round(r.w), Math.round(r.h));
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    // swapBuffers comes from the context, not the SDL window: with an EGL
    // surface SDL never sees the frame.
    this.swapBuffers?.();
    this.frames++;
  }

  destroy() {
    const gl = this.gl;
    try {
      gl.deleteTexture(this.tex);
      gl.deleteBuffer(this.vbo);
      gl.deleteProgram(this.prog);
    } catch { /* context may already be gone */ }
  }
}
