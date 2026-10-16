/**
 * streakGL.js — the streak's painter on WebGL.
 *
 * Streak.jsx works out where every strand is; this draws them. It exists for
 * one measured reason: stroking 118 cubic curves through Canvas 2D costs the
 * browser's GPU process most of a CPU core, every frame, because each stroke
 * is turned into triangles on the CPU before the GPU ever sees it. On this
 * machine's integrated graphics that alone held the GPU process at ~100% with
 * the app idle and dropped one frame in five.
 *
 * Here the strands are flattened to polylines in JS (cheap: a few thousand
 * bezier evaluations), widened into one triangle mesh, and drawn in a single
 * call. Everything that made the picture is kept, by the same arithmetic:
 *
 *   - additive blending, ONE + ONE on premultiplied colour, which is exactly
 *     what Canvas 2D's 'lighter' does, so crossings still burn white;
 *   - the colour of a strand is the same radial lamp centred on the fold, with
 *     the same stops, evaluated per pixel;
 *   - a strand's coverage across its width is computed per pixel from its
 *     distance to the centreline, so the edges are antialiased the way a
 *     canvas stroke is, and a strand thinner than a device pixel is drawn one
 *     pixel wide at proportionally less weight, which is what Skia does too.
 *
 * On top of that picture, the drama, all of it per pixel and none of it extra
 * geometry (the knobs are each backdrop's `fx`, in backdrops.js):
 *
 *   - a halo: each strand's quad is widened by `glow` px and the light falls
 *     off across it, so strands bloom instead of being hairlines;
 *   - pulses: bright surges that run along every strand, each strand on its
 *     own phase, worked out from where along the strand a pixel is;
 *   - heat: near the focus the colour runs to white, and out at the edges it
 *     cools toward the second tint;
 *   - a flare: an anamorphic streak drawn through the focus in the bloom
 *     pass, and the bloom itself breathing;
 *   - the motes carry a soft glow of their own.
 *
 * WebGL 1, so it runs anywhere WebGL runs. If it cannot start, createStreakGL
 * returns null and the streak paints through Canvas 2D as it always did.
 */

/* Samples per cubic. Each strand is two cubics, so 2N+1 points along it. At
   the apex, where the turn is tightest, the curve moves slowly in t and the
   samples land a few pixels apart; along the long sweeps they are further
   apart but the curvature there is gentle. 72 keeps the whole mesh under the
   65536 vertices a 16-bit index can address at the full 118 strands. */
const N = 72;
const SAMPLES = 2 * N + 1;

/* GLSL for a piecewise-linear ramp over [offset, value] stops: the same
   interpolation a canvas gradient does between its colour stops. */
function ramp(name, stops, type, value) {
  const lines = [`${type} ${name}(float d) {`];
  lines.push(`  if (d <= ${stops[0][0].toFixed(4)}) return ${value(stops[0])};`);
  for (let i = 1; i < stops.length; i += 1) {
    const [o0] = stops[i - 1];
    const [o1] = stops[i];
    lines.push(
      `  if (d < ${o1.toFixed(4)}) return mix(${value(stops[i - 1])}, ${value(stops[i])}, (d - ${o0.toFixed(4)}) / ${(o1 - o0).toFixed(4)});`
    );
  }
  lines.push(`  return ${value(stops[stops.length - 1])};`, '}');
  return lines.join('\n');
}

const f = (v) => v.toFixed(4);
const rgb = (c) => `vec3(${f(c[0] / 255)}, ${f(c[1] / 255)}, ${f(c[2] / 255)})`;

const PRECISION = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
`;

/**
 * @param canvas      the streak's canvas
 * @param lampStops   [[offset, alpha], ...]  the strands' radial lamp
 * @param bloomStops  [[offset, [r,g,b], alpha], ...]  the glow at the fold
 * @param colours     { main, cool, pale } as [r,g,b] 0-255
 * @param moteColour  [r,g,b] 0-255
 * @param fx          { glow, halo, pulses, pulseSpeed, pulseGain, heat, chill,
 *                      flare, breathe } — see backdrops.js
 */
export function createStreakGL(canvas, { lampStops, bloomStops, colours, moteColour, fx = {} }) {
  let gl = null;
  try {
    gl = canvas.getContext('webgl', {
      alpha: true,
      premultipliedAlpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: false,
      powerPreference: 'low-power',
    });
  } catch {
    gl = null;
  }
  if (!gl) return null;

  /* ---- shaders ------------------------------------------------------- */

  const STRAND_VS = `
attribute vec2 a_pos;
attribute vec4 a_meta;
attribute vec2 a_along;
uniform vec2 u_size;
varying vec4 v_meta;
varying vec2 v_along;
void main() {
  vec2 c = a_pos / u_size * 2.0 - 1.0;
  gl_Position = vec4(c.x, -c.y, 0.0, 1.0);
  v_meta = a_meta;
  v_along = a_along;
}`;

  /* The motes have no a_along, so they keep the plain vertex shader. */
  const PLAIN_VS = `
attribute vec2 a_pos;
attribute vec4 a_meta;
uniform vec2 u_size;
varying vec4 v_meta;
void main() {
  vec2 c = a_pos / u_size * 2.0 - 1.0;
  gl_Position = vec4(c.x, -c.y, 0.0, 1.0);
  v_meta = a_meta;
}`;

  /* a_meta: x = signed distance from the centreline (device px), y = half the
     strand's width, z = its weight, w = which hue. a_along: x = how far along
     the strand, 0..1, y = the strand's own pulse phase. */
  const STRAND_FS = `${PRECISION}
uniform vec2 u_fold;
uniform float u_R;
uniform float u_time;
uniform float u_glow;
uniform vec4 u_pulse;
uniform vec3 u_heat;
varying vec4 v_meta;
varying vec2 v_along;
${ramp('lamp', lampStops, 'float', ([, a]) => f(a))}
void main() {
  float dist = abs(v_meta.x);
  /* The strand itself, antialiased, and its halo falling away beyond it. */
  float core = clamp(v_meta.y + 0.5 - dist, 0.0, 1.0);
  float h = 1.0 - clamp((dist - v_meta.y) / u_glow, 0.0, 1.0);
  float cover = core + h * h * u_heat.z * (1.0 - core);

  float d = length(gl_FragCoord.xy - u_fold) / u_R;
  /* A surge running down the strand: a sharp peak once per period, on this
     strand's own phase. It lights the strand even out where the lamp has
     faded, which is what makes it read as energy travelling. */
  float w = fract(v_along.x * u_pulse.x - u_time * u_pulse.y + v_along.y);
  float pulse = pow(1.0 - abs(w - 0.5) * 2.0, 10.0) * u_pulse.z;
  float lit = lamp(d) * (1.0 + pulse) + pulse * 0.16 * (1.0 - smoothstep(0.5, 1.3, d));
  float a = lit * v_meta.z * cover;

  vec3 col = v_meta.w < 0.5 ? ${rgb(colours.main)} : (v_meta.w < 1.5 ? ${rgb(colours.cool)} : ${rgb(colours.pale)});
  /* White-hot at the focus, cooling toward the second tint at the edges. */
  col = mix(col, vec3(1.0), (1.0 - smoothstep(0.0, 0.16, d)) * u_heat.x);
  col = mix(col, ${rgb(colours.cool)}, smoothstep(0.3, 0.95, d) * u_heat.y);
  col = mix(col, vec3(1.0), min(pulse, 1.0) * 0.4);
  gl_FragColor = vec4(col * a, a);
}`;

  const FULL_VS = `
attribute vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }`;

  /* Interpolated unpremultiplied, as a canvas gradient is, then premultiplied
     on the way out for the blend. */
  /* The flare: a thin horizontal streak through the focus, the way a lens
     with an anamorphic element draws a bright point — sharp across, long
     along. The bloom under it breathes. */
  const BLOOM_FS = `${PRECISION}
uniform vec2 u_fold;
uniform float u_R;
uniform vec2 u_size;
uniform float u_time;
uniform vec2 u_flare;
${ramp('bloom', bloomStops, 'vec4', ([, c, a]) => `vec4(${rgb(c)}, ${f(a)})`)}
void main() {
  vec2 p = gl_FragCoord.xy - u_fold;
  float breath = 1.0 + u_flare.y * sin(u_time * 1.3);
  vec4 c = bloom(length(p) / u_R);
  float a = c.a * breath;
  float across = abs(p.y) / (2.0 + u_size.y * 0.0035);
  float along = abs(p.x) / (u_size.x * 0.32);
  float streak = exp(-across) * exp(-along * along) * u_flare.x * breath;
  float wide = exp(-abs(p.y) / (u_size.y * 0.03)) * exp(-along * along * 2.0) * u_flare.x * 0.18;
  gl_FragColor = vec4(c.rgb * a + ${rgb(moteColour)} * (streak + wide), a + streak + wide);
}`;

  const MOTE_VS = PLAIN_VS;
  /* a_meta: xy = offset from the mote's centre (device px), z = radius, w = weight.
     A hard bright disc, and a soft glow round it four radii wide. */
  const MOTE_FS = `${PRECISION}
varying vec4 v_meta;
void main() {
  float r = length(v_meta.xy);
  float core = clamp(v_meta.z + 0.5 - r, 0.0, 1.0);
  float g = 1.0 - clamp(r / (v_meta.z * 4.0 + 1.0), 0.0, 1.0);
  float a = (core + g * g * g * 0.7) * v_meta.w;
  gl_FragColor = vec4(mix(${rgb(moteColour)}, vec3(1.0), core * 0.5) * a, a);
}`;

  /* ---- resources, rebuilt if the context is lost and restored ---------- */

  let res = null;
  let lost = false;

  const compile = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(s);
      gl.deleteShader(s);
      throw new Error(`streak shader: ${log}`);
    }
    return s;
  };
  const program = (vs, fs, names) => {
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`streak program: ${gl.getProgramInfoLog(p)}`);
    const u = {};
    for (const n of names) u[n] = gl.getUniformLocation(p, n);
    return {
      p,
      u,
      pos: gl.getAttribLocation(p, 'a_pos'),
      meta: gl.getAttribLocation(p, 'a_meta'),
      along: gl.getAttribLocation(p, 'a_along'),
    };
  };

  const init = () => {
    res = {
      strand: program(STRAND_VS, STRAND_FS, ['u_size', 'u_fold', 'u_R', 'u_time', 'u_glow', 'u_pulse', 'u_heat']),
      bloom: program(FULL_VS, BLOOM_FS, ['u_fold', 'u_R', 'u_size', 'u_time', 'u_flare']),
      mote: program(MOTE_VS, MOTE_FS, ['u_size']),
      full: gl.createBuffer(),
      pos: gl.createBuffer(),
      meta: gl.createBuffer(),
      along: gl.createBuffer(),
      index: gl.createBuffer(),
      motes: gl.createBuffer(),
      /* What the static buffers were built for; anything different rebuilds. */
      builtFor: null,
      builtDpr: 0,
      indexCount: 0,
    };
    gl.bindBuffer(gl.ARRAY_BUFFER, res.full);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  };

  try {
    init();
  } catch (err) {
    console.warn('Streak: WebGL unavailable, falling back to Canvas 2D', err);
    return null;
  }

  const onLost = (e) => { e.preventDefault(); lost = true; };
  const onRestored = () => {
    try { init(); lost = false; } catch { /* stays lost: the canvas just stops changing */ }
  };
  canvas.addEventListener('webglcontextlost', onLost);
  canvas.addEventListener('webglcontextrestored', onRestored);

  /* ---- per-frame scratch ---------------------------------------------- */

  let pos = new Float32Array(0);
  const pts = new Float32Array(SAMPLES * 2);
  const MAX_MOTES = 48;
  const motes = new Float32Array(MAX_MOTES * 6 * 6);

  /* How far the halo reaches beyond a strand's edge, in device px. It is
     baked into the quads' width as well as read by the shader. */
  const glowPx = (dpr) => Math.max(0.001, (fx.glow || 0) * dpr);
  /* Half a quad's width: the strand, a pixel of antialiasing, the halo. */
  const extent = (width, dpr) => (width * dpr < 1 ? 0.5 : (width * dpr) / 2) + 1 + (fx.glow || 0) * dpr;

  /* Per vertex, fixed for a given set of strands: which side of the line it
     is on and how far out, the strand's width, weight and hue. Only the
     positions change frame to frame. */
  const buildStatic = (strands, dpr) => {
    const verts = strands.length * SAMPLES * 2;
    const meta = new Float32Array(verts * 4);
    const along = new Float32Array(verts * 2);
    let k = 0;
    let q = 0;
    for (let n = 0; n < strands.length; n += 1) {
      const s = strands[n];
      const w = s.width * dpr;
      /* Thinner than a pixel: one pixel wide, at that fraction of the weight. */
      const hw = w < 1 ? 0.5 : w / 2;
      const weight = s.alpha * (w < 1 ? w : 1);
      const ext = extent(s.width, dpr);
      const hue = s.hue === 'main' ? 0 : s.hue === 'cool' ? 1 : 2;
      /* Hashed, so neighbouring strands do not pulse in step. */
      const ph = Math.sin((n + 1) * 91.17) * 43758.5453;
      const phase = ph - Math.floor(ph);
      for (let i = 0; i < SAMPLES; i += 1) {
        meta.set([ext, hw, weight, hue, -ext, hw, weight, hue], k);
        k += 8;
        const t = i / (SAMPLES - 1);
        along.set([t, phase, t, phase], q);
        q += 4;
      }
    }
    const index = new Uint16Array(strands.length * (SAMPLES - 1) * 6);
    let j = 0;
    for (let s = 0; s < strands.length; s += 1) {
      const base = s * SAMPLES * 2;
      for (let i = 0; i < SAMPLES - 1; i += 1) {
        const a = base + i * 2;
        index[j++] = a; index[j++] = a + 1; index[j++] = a + 2;
        index[j++] = a + 1; index[j++] = a + 3; index[j++] = a + 2;
      }
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, res.meta);
    gl.bufferData(gl.ARRAY_BUFFER, meta, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, res.along);
    gl.bufferData(gl.ARRAY_BUFFER, along, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, res.index);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, index, gl.STATIC_DRAW);
    res.indexCount = j;
    res.builtFor = strands;
    res.builtDpr = dpr;
    pos = new Float32Array(verts * 2);
  };

  /* The four bezier weights at each sample, worked out once: the curves
     change every frame but where along them the samples fall never does. */
  const WEIGHTS = new Float32Array((N + 1) * 4);
  for (let i = 0; i <= N; i += 1) {
    const t = i / N;
    const m = 1 - t;
    WEIGHTS.set([m * m * m, 3 * m * m * t, 3 * m * t * t, t * t * t], i * 4);
  }

  const bind = (buf, loc, size) => {
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
  };

  /**
   * frame: { W, H, dpr, fx, fy, R, bloomR, strands, curves, motes, time }
   * (fx, fy here are the focus; time is in seconds, for the pulses and flare)
   * curves[i] is strand i as the 14 numbers Streak's shape() returns, in CSS
   * px; motes are { x, y, r, a } in CSS px.
   */
  const paint = (frame) => {
    if (lost || !res) return;
    const { dpr, fx: focusX, fy: focusY, R, bloomR, strands, curves } = frame;
    const time = frame.time || 0;
    const dw = canvas.width;
    const dh = canvas.height;
    if (res.builtFor !== strands || res.builtDpr !== dpr) buildStatic(strands, dpr);

    /* Every strand flattened and widened, in device pixels. */
    let k = 0;
    for (let s = 0; s < strands.length; s += 1) {
      const c = curves[s];
      let n = 0;
      for (let i = 0; i <= N; i += 1) {
        const w = i * 4;
        const a = WEIGHTS[w]; const b = WEIGHTS[w + 1]; const d = WEIGHTS[w + 2]; const e = WEIGHTS[w + 3];
        pts[n++] = (a * c[0] + b * c[2] + d * c[4] + e * c[6]) * dpr;
        pts[n++] = (a * c[1] + b * c[3] + d * c[5] + e * c[7]) * dpr;
      }
      for (let i = 1; i <= N; i += 1) {
        const w = i * 4;
        const a = WEIGHTS[w]; const b = WEIGHTS[w + 1]; const d = WEIGHTS[w + 2]; const e = WEIGHTS[w + 3];
        pts[n++] = (a * c[6] + b * c[8] + d * c[10] + e * c[12]) * dpr;
        pts[n++] = (a * c[7] + b * c[9] + d * c[11] + e * c[13]) * dpr;
      }
      const ext = extent(strands[s].width, dpr);
      let nx = 0;
      let ny = 1;
      for (let i = 0; i < SAMPLES; i += 1) {
        const a = Math.max(0, i - 1) * 2;
        const b = Math.min(SAMPLES - 1, i + 1) * 2;
        const tx = pts[b] - pts[a];
        const ty = pts[b + 1] - pts[a + 1];
        const len = Math.sqrt(tx * tx + ty * ty);
        /* A zero-length step keeps the last good normal rather than a NaN. */
        if (len > 1e-6) { nx = -ty / len; ny = tx / len; }
        const x = pts[i * 2];
        const y = pts[i * 2 + 1];
        pos[k++] = x + nx * ext; pos[k++] = y + ny * ext;
        pos[k++] = x - nx * ext; pos[k++] = y - ny * ext;
      }
    }

    gl.viewport(0, 0, dw, dh);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    /* 'lighter': source plus destination, premultiplied. */
    gl.blendFunc(gl.ONE, gl.ONE);

    /* gl_FragCoord runs bottom-up. */
    const foldX = focusX * dpr;
    const foldY = dh - focusY * dpr;

    /* The bloom first, so the strands sit in it. */
    const bl = res.bloom;
    gl.useProgram(bl.p);
    gl.uniform2f(bl.u.u_fold, foldX, foldY);
    gl.uniform1f(bl.u.u_R, bloomR * dpr);
    gl.uniform2f(bl.u.u_size, dw, dh);
    gl.uniform1f(bl.u.u_time, time);
    gl.uniform2f(bl.u.u_flare, fx.flare || 0, fx.breathe || 0);
    bind(res.full, bl.pos, 2);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.disableVertexAttribArray(bl.pos);

    const st = res.strand;
    gl.useProgram(st.p);
    gl.uniform2f(st.u.u_size, dw, dh);
    gl.uniform2f(st.u.u_fold, foldX, foldY);
    gl.uniform1f(st.u.u_R, R * dpr);
    gl.uniform1f(st.u.u_time, time);
    gl.uniform1f(st.u.u_glow, glowPx(dpr));
    gl.uniform4f(st.u.u_pulse, fx.pulses || 0, fx.pulseSpeed || 0, fx.pulseGain || 0, 0);
    gl.uniform3f(st.u.u_heat, fx.heat || 0, fx.chill || 0, fx.halo || 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, res.pos);
    gl.bufferData(gl.ARRAY_BUFFER, pos, gl.STREAM_DRAW);
    gl.enableVertexAttribArray(st.pos);
    gl.vertexAttribPointer(st.pos, 2, gl.FLOAT, false, 0, 0);
    bind(res.meta, st.meta, 4);
    bind(res.along, st.along, 2);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, res.index);
    gl.drawElements(gl.TRIANGLES, res.indexCount, gl.UNSIGNED_SHORT, 0);
    gl.disableVertexAttribArray(st.pos);
    gl.disableVertexAttribArray(st.meta);
    gl.disableVertexAttribArray(st.along);

    /* The motes: a quad each, its disc cut out per pixel. */
    const list = frame.motes;
    const count = Math.min(list.length, MAX_MOTES);
    let m = 0;
    for (let i = 0; i < count; i += 1) {
      const { x, y, r, a } = list[i];
      const cx = x * dpr;
      const cy = y * dpr;
      const rr = r * dpr;
      /* Room for the glow: four radii and a pixel. */
      const e = rr * 4 + 2;
      const corners = [[-e, -e], [e, -e], [-e, e], [e, -e], [e, e], [-e, e]];
      for (const [ox, oy] of corners) {
        motes[m++] = cx + ox; motes[m++] = cy + oy;
        motes[m++] = ox; motes[m++] = oy; motes[m++] = rr; motes[m++] = a;
      }
    }
    if (count) {
      const mo = res.mote;
      gl.useProgram(mo.p);
      gl.uniform2f(mo.u.u_size, dw, dh);
      gl.bindBuffer(gl.ARRAY_BUFFER, res.motes);
      gl.bufferData(gl.ARRAY_BUFFER, motes.subarray(0, m), gl.STREAM_DRAW);
      gl.enableVertexAttribArray(mo.pos);
      gl.vertexAttribPointer(mo.pos, 2, gl.FLOAT, false, 24, 0);
      gl.enableVertexAttribArray(mo.meta);
      gl.vertexAttribPointer(mo.meta, 4, gl.FLOAT, false, 24, 8);
      gl.drawArrays(gl.TRIANGLES, 0, count * 6);
      gl.disableVertexAttribArray(mo.pos);
      gl.disableVertexAttribArray(mo.meta);
    }
  };

  const dispose = () => {
    canvas.removeEventListener('webglcontextlost', onLost);
    canvas.removeEventListener('webglcontextrestored', onRestored);
  };

  return { paint, dispose };
}
