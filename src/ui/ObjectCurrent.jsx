/**
 * ObjectCurrent.jsx — the Crystal Needles and Obsidian Edges backdrops.
 *
 * The motion is AeroShards' current (React Bits), ported as it was: five
 * ribbons at five depths flowing across the window, each twisting about its
 * own length and billowing like silk, drawing in from the left on arrival.
 * What rides it is drawn here, on plain WebGL, without AeroShards' per-pixel
 * ray tracing:
 *
 *   needles   thin crystal slivers spinning end over end, each a glowing line
 *             that flares when it turns across the light
 *   obsidian  plates of black glass banking with the ribbon, seen only by
 *             their edges, which glow in the accent; the edge facing the light
 *             catches white. Drawn far to near, so a near plate covers the
 *             glow behind it, the way black glass would.
 *
 * Everything is one triangle list rebuilt each frame and drawn in one call:
 * fills are flat, lines carry their own antialiased core and soft halo, and
 * the halo widens with distance from the focus depth. The cursor parts what it
 * passes and a click sends a ring of light out through it. Thirty pictures a
 * second, like the strands.
 */

import { useEffect, useRef } from 'react';

const TAU = Math.PI * 2;
const CAMERA = 4;
const FOCUS = 3.0;
const DEPTHS = [2.7, 3.9, 5.6, 8.1, 11.6];
const SHARE = [0.26, 0.23, 0.2, 0.17, 0.14];
const GROWTH = [1, 1.3, 1.8, 2.6, 3.6];
const FADE = [1, 0.8, 0.6, 0.42, 0.3];
const FULL_SLOPES = [[0.2, -0.78], [-0.72, 0.02], [0.58, -0.06], [-0.24, 0.62], [0.8, 0.3]];
const LEVELS = DEPTHS.length;
const SAMPLES = 160;
const INTRO_SECONDS = 3.4;
const RING_SECONDS = 2.6;
const MAX_BANK = 1.0;
const FLOATS = 9; // x, y, r, g, b, a, across, core, halo
/* The light, from above, slightly left and toward the viewer. */
const LIGHT = (() => { const v = [-0.3, 0.7, 0.65]; const l = Math.hypot(...v); return v.map((x) => x / l); })();

const COUNTS = { needles: 650, obsidian: 480 };

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const smoother = (x) => {
  const t = clamp(x, 0, 1);
  return t * t * t * (t * (t * 6 - 15) + 10);
};
const random = (seed) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

/* One point on ribbon `level` at s (0..1), in world space, for the "full"
   placement. Straight from AeroShards' ribbonPoint. */
function ribbonPoint(level, s, aspect, out) {
  const u = -1.32 + 2.64 * s;
  const slope = FULL_SLOPES[level];
  const v = slope[0] + (slope[1] - slope[0]) * s
    + 0.1 * Math.sin(s * TAU * 0.7 + level * 2.3)
    + 0.045 * Math.sin(s * TAU * 1.9 + level);
  const d = DEPTHS[level] + 0.35 * Math.sin(s * Math.PI * 1.4 + level * 1.9);
  out[0] = (u * aspect * d) / CAMERA;
  out[1] = (v * d) / CAMERA;
  out[2] = CAMERA - d;
  return out;
}

/* Each ribbon resampled evenly by length, with a frame that travels along it
   without spinning (tangent, across, lift). */
function buildPaths(aspect) {
  const raw = new Float32Array((SAMPLES + 1) * 3);
  const lengths = new Float32Array(SAMPLES + 1);
  const p = [0, 0, 0];
  return Array.from({ length: LEVELS }, (_, level) => {
    let total = 0;
    for (let i = 0; i <= SAMPLES; i += 1) {
      ribbonPoint(level, i / SAMPLES, aspect, p);
      raw[i * 3] = p[0]; raw[i * 3 + 1] = p[1]; raw[i * 3 + 2] = p[2];
      if (i > 0) total += Math.hypot(p[0] - raw[i * 3 - 3], p[1] - raw[i * 3 - 2], p[2] - raw[i * 3 - 1]);
      lengths[i] = total;
    }
    const path = {
      position: new Float32Array(SAMPLES * 3),
      tangent: new Float32Array(SAMPLES * 3),
      across: new Float32Array(SAMPLES * 3),
      lift: new Float32Array(SAMPLES * 3),
      length: Math.max(total, 1e-3),
    };
    let cursor = 0;
    for (let i = 0; i < SAMPLES; i += 1) {
      const want = (i / (SAMPLES - 1)) * total;
      while (cursor < SAMPLES - 1 && lengths[cursor + 1] < want) cursor += 1;
      const span = Math.max(lengths[cursor + 1] - lengths[cursor], 1e-6);
      const f = clamp((want - lengths[cursor]) / span, 0, 1);
      for (let c = 0; c < 3; c += 1) {
        path.position[i * 3 + c] = raw[cursor * 3 + c] + (raw[cursor * 3 + 3 + c] - raw[cursor * 3 + c]) * f;
      }
    }
    let px = 0; let py = 1; let pz = 0;
    for (let i = 0; i < SAMPLES; i += 1) {
      const a = Math.max(0, i - 1);
      const b = Math.min(SAMPLES - 1, i + 1);
      let tx = path.position[b * 3] - path.position[a * 3];
      let ty = path.position[b * 3 + 1] - path.position[a * 3 + 1];
      let tz = path.position[b * 3 + 2] - path.position[a * 3 + 2];
      const tl = Math.hypot(tx, ty, tz) || 1;
      tx /= tl; ty /= tl; tz /= tl;
      if (i === 0) { px = -ty; py = tx; pz = 0; }
      const along = px * tx + py * ty + pz * tz;
      px -= tx * along; py -= ty * along; pz -= tz * along;
      const pl = Math.hypot(px, py, pz) || 1;
      px /= pl; py /= pl; pz /= pl;
      path.tangent.set([tx, ty, tz], i * 3);
      path.across.set([px, py, pz], i * 3);
      path.lift.set([ty * pz - tz * py, tz * px - tx * pz, tx * py - ty * px], i * 3);
    }
    return path;
  });
}

function createObjects(count, seed) {
  const next = random(seed);
  const list = [];
  let made = 0;
  for (let level = 0; level < LEVELS; level += 1) {
    const amount = level === LEVELS - 1 ? count - made : Math.round(count * SHARE[level]);
    made += amount;
    for (let i = 0; i < amount; i += 1) {
      const flat = next() * 2 - 1;
      /* An irregular outline, sorted round its middle so a fan from the centre
         fills it: a black shard rather than a regular polygon. */
      const k = next() < 0.5 ? 4 : 5;
      const outline = [];
      for (let c = 0; c < k; c += 1) {
        const a = ((c + (next() - 0.5) * 0.6) / k) * TAU;
        const m = 0.55 + next() * 0.5;
        outline.push([Math.cos(a) * m * 1.15, Math.sin(a) * m * 0.7]);
      }
      list.push({
        level,
        phase: (i + next()) / Math.max(amount, 1),
        lane: Math.sign(flat) * Math.pow(Math.abs(flat), 0.85),
        layer: Math.sqrt(-2 * Math.log(Math.max(next(), 1e-6))) * Math.cos(TAU * next()),
        size: 0.6 + next() * next() * 1.25,
        drift: [next() * TAU, next() * TAU, next() * TAU],
        rate: [0.3 + next() * 0.35, 0.25 + next() * 0.35, 0.3 + next() * 0.3],
        yaw: (next() - 0.5) * 0.36,
        bank: (next() - 0.5) * 0.5,
        flutter: [next() * TAU, 0.5 + next() * 0.5],
        spin: [next() * TAU, (0.4 + next() * 0.9) * (next() < 0.5 ? -1 : 1), next() * TAU],
        arrive: next(),
        outline,
        glintEdge: Math.floor(next() * k),
        ox: 0, oy: 0, vx: 0, vy: 0,
      });
    }
  }
  return list;
}

const VS = `
attribute vec2 a_pos;
attribute vec4 a_col;
attribute vec3 a_line;
uniform vec2 u_view;
varying vec4 v_col;
varying vec3 v_line;
void main() {
  vec2 c = a_pos / u_view * 2.0 - 1.0;
  gl_Position = vec4(c.x, -c.y, 0.0, 1.0);
  v_col = a_col;
  v_line = a_line;
}`;

/* v_line: x = signed distance across a line (CSS px), y = half its core
   width, z = how far its halo reaches. z < 0 marks a fill, drawn flat. */
const FS = `
precision mediump float;
uniform float u_dpr;
varying vec4 v_col;
varying vec3 v_line;
void main() {
  if (v_line.z < 0.0) { gl_FragColor = v_col; return; }
  float dist = abs(v_line.x) * u_dpr;
  float core = clamp(v_line.y * u_dpr + 0.5 - dist, 0.0, 1.0);
  float h = 1.0 - clamp((dist - v_line.y * u_dpr) / max(v_line.z * u_dpr, 0.001), 0.0, 1.0);
  float cover = core + h * h * 0.45 * (1.0 - core);
  gl_FragColor = v_col * cover;
}`;

export default function ObjectCurrent({
  kind = 'needles',
  accent = [169, 139, 255],
  speed = 1,
  spread = 1,
  depthOfField = 1,
  replay = 0,
  paused = false,
  maxFps = 30,
  dpr = 1.5,
  mouseInteraction = true,
  pulseOnClick = true,
  className = '',
  onError,
}) {
  const ref = useRef(null);
  const settings = { kind, accent, speed, spread, depthOfField, replay, paused, maxFps, dpr, mouseInteraction, pulseOnClick };
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  useEffect(() => {
    const host = ref.current;
    if (!host) return undefined;
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block';
    host.appendChild(canvas);

    let gl = null;
    try {
      gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: false, depth: false });
    } catch {
      gl = null;
    }
    if (!gl) {
      canvas.remove();
      onErrorRef.current?.(new Error('WebGL is not available'));
      return undefined;
    }

    const compile = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`current shader: ${gl.getShaderInfoLog(s)}`);
      return s;
    };
    let prog;
    try {
      prog = gl.createProgram();
      gl.attachShader(prog, compile(gl.VERTEX_SHADER, VS));
      gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FS));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(`current program: ${gl.getProgramInfoLog(prog)}`);
    } catch (err) {
      canvas.remove();
      onErrorRef.current?.(err);
      return undefined;
    }
    const loc = {
      pos: gl.getAttribLocation(prog, 'a_pos'),
      col: gl.getAttribLocation(prog, 'a_col'),
      line: gl.getAttribLocation(prog, 'a_line'),
      view: gl.getUniformLocation(prog, 'u_view'),
      dpr: gl.getUniformLocation(prog, 'u_dpr'),
    };
    const buffer = gl.createBuffer();

    const reduced = () =>
      document.documentElement.dataset.motion === 'reduced' ||
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    let W = 1;
    let H = 1;
    let ratio = 1;
    let paths = null;
    let data = new Float32Array(1 << 16);
    let n = 0;
    let objects = createObjects(COUNTS[settingsRef.current.kind] || 900, 1337);
    let builtFor = settingsRef.current.kind;

    const state = {
      clock: 0,
      last: 0,
      introAt: 0,
      replayed: settingsRef.current.replay,
      travel: new Float64Array(LEVELS),
      twist: 0,
      roll: 0,
      drift: 0,
      pointer: { x: -1e4, y: -1e4, inside: false },
      presence: 0,
      rings: [],
    };

    const resize = () => {
      ratio = Math.min(window.devicePixelRatio || 1, settingsRef.current.dpr);
      W = Math.max(1, host.clientWidth);
      H = Math.max(1, host.clientHeight);
      canvas.width = Math.round(W * ratio);
      canvas.height = Math.round(H * ratio);
      paths = buildPaths(W / H);
    };

    /* ---- geometry --------------------------------------------------------- */
    const room = (verts) => {
      const need = (n + verts) * FLOATS;
      if (need <= data.length) return;
      const next = new Float32Array(Math.max(need, data.length * 2));
      next.set(data.subarray(0, n * FLOATS));
      data = next;
    };
    const vert = (x, y, r, g, b, a, across, core, halo) => {
      const o = n * FLOATS;
      data[o] = x; data[o + 1] = y;
      data[o + 2] = r * a; data[o + 3] = g * a; data[o + 4] = b * a; data[o + 5] = a;
      data[o + 6] = across; data[o + 7] = core; data[o + 8] = halo;
      n += 1;
    };
    /* A line as a quad wide enough for its core, its halo and a pixel of
       antialiasing, run a little past each end so the ends are not cut. */
    const line = (ax, ay, bx, by, col, a, core, halo) => {
      let dx = bx - ax;
      let dy = by - ay;
      const len = Math.hypot(dx, dy) || 1;
      dx /= len; dy /= len;
      const ext = core + halo + 1;
      const nx = -dy * ext;
      const ny = dx * ext;
      const sx = ax - dx * ext * 0.5;
      const sy = ay - dy * ext * 0.5;
      const ex = bx + dx * ext * 0.5;
      const ey = by + dy * ext * 0.5;
      room(6);
      const [r, g, b] = col;
      vert(sx + nx, sy + ny, r, g, b, a, ext, core, halo);
      vert(sx - nx, sy - ny, r, g, b, a, -ext, core, halo);
      vert(ex + nx, ey + ny, r, g, b, a, ext, core, halo);
      vert(sx - nx, sy - ny, r, g, b, a, -ext, core, halo);
      vert(ex - nx, ey - ny, r, g, b, a, -ext, core, halo);
      vert(ex + nx, ey + ny, r, g, b, a, ext, core, halo);
    };
    const fan = (pts, cx, cy, col, a) => {
      room(pts.length * 3);
      const [r, g, b] = col;
      for (let i = 0; i < pts.length; i += 1) {
        const p = pts[i];
        const q = pts[(i + 1) % pts.length];
        vert(cx, cy, r, g, b, a, 0, 0, -1);
        vert(p[0], p[1], r, g, b, a, 0, 0, -1);
        vert(q[0], q[1], r, g, b, a, 0, 0, -1);
      }
    };

    const items = [];

    const step = (s, dt, still) => {
      if (s.replay !== state.replayed) {
        state.replayed = s.replay;
        state.introAt = state.clock;
      }
      if (s.kind !== builtFor) {
        objects = createObjects(COUNTS[s.kind] || 900, 1337);
        builtFor = s.kind;
      }
      const moving = !s.paused && !still;
      if (moving) {
        for (let level = 0; level < LEVELS; level += 1) {
          state.travel[level] = (state.travel[level] + (dt * s.speed * 0.09) / paths[level].length) % 1;
        }
        state.twist += dt * s.speed * 0.08;
        state.roll += dt * s.speed;
        state.drift += dt * s.speed;
      }
      const engaged = s.mouseInteraction && state.pointer.inside && !still;
      state.presence += ((engaged ? 1 : 0) - state.presence) * (1 - Math.exp(-dt / 0.25));
      for (const r of state.rings) r.age += dt;
      state.rings = state.rings.filter((r) => r.age < RING_SECONDS);

      const focal = H * 0.5 * CAMERA;
      const introAge = still ? 1e3 : state.clock - state.introAt;
      const reach = H * 0.09;
      const steps = Math.max(1, Math.ceil(dt / (1 / 120)));
      const h = dt / steps;
      const accent = s.accent.map((v) => v / 255);
      const bright = accent.map((v) => v + (1 - v) * 0.55);
      const project = (p) => {
        const depth = Math.max(CAMERA - p[2], 0.35);
        return [W * 0.5 + (p[0] * focal) / depth, H * 0.5 - (p[1] * focal) / depth];
      };

      items.length = 0;
      for (const m of objects) {
        const level = m.level;
        const path = paths[level];
        let s0 = (m.phase + state.travel[level]) % 1;
        const begin = level * 0.22 + Math.max(0, s0 - 0.1) * (INTRO_SECONDS - 1.0 - (LEVELS - 1) * 0.22) + m.arrive * 0.15;
        const local = clamp((introAge - begin) / 0.9, 0, 1);
        const appear = smoother(local);
        if (appear <= 0.002) continue;
        const glide = (1 - local) * (1 - local);
        s0 = Math.max(0, s0 - glide * 0.06);

        const f = s0 * (SAMPLES - 1);
        const i0 = Math.floor(f);
        const i1 = Math.min(i0 + 1, SAMPLES - 1);
        const t = f - i0;
        const at = (arr) => [0, 1, 2].map((c) => arr[i0 * 3 + c] + (arr[i1 * 3 + c] - arr[i0 * 3 + c]) * t);
        const pos = at(path.position);
        const tan = at(path.tangent);
        const ac = at(path.across);
        const li = at(path.lift);
        const angle = s0 * TAU * 0.6 + state.twist + level * 1.7;
        const ca = Math.cos(angle);
        const sa = Math.sin(angle);
        const depthScale = DEPTHS[level] / CAMERA;
        const width = s.spread * (0.15 + 0.035 * DEPTHS[level]) * (0.8 + 0.3 * Math.sin(s0 * TAU * 1.3 + level * 0.8));
        const lane = m.lane * width;
        const layer = m.layer * 0.012 * depthScale;
        const taper = smoother(s0 / 0.12) * smoother((1 - s0) / 0.12);
        const billow = 0.16 * depthScale * Math.sin(s0 * TAU * 1.3 - state.drift * 0.5 + level * 1.1) * (0.4 + 0.6 * taper);
        const sway = 0.06 * depthScale * Math.sin(s0 * TAU * 0.8 - state.drift * 0.35 + level * 2.4);
        const wobble = 0.009 * depthScale;
        const p = [0, 1, 2].map((c) => pos[c] + li[c] * billow + ac[c] * sway
          + (ac[c] * ca + li[c] * sa) * lane + (li[c] * ca - ac[c] * sa) * layer
          + Math.sin(state.drift * m.rate[c] + m.drift[c]) * wobble);
        const depth = Math.max(CAMERA - p[2], 0.35);
        const [sx, sy] = project(p);

        /* The cursor parts what it passes; a ring of light pushes and lights. */
        let fx = 0;
        let fy = 0;
        let flash = 0;
        if (state.presence > 0.01) {
          const dx = sx + m.ox - state.pointer.x;
          const dy = sy + m.oy - state.pointer.y;
          const d2 = dx * dx + dy * dy;
          const fall = Math.exp(-d2 / (reach * reach)) * state.presence;
          if (fall > 0.002) {
            const dl = Math.sqrt(d2) || 1;
            const push = (fall * 2600) / (1 + level * 0.6);
            fx += (dx / dl) * push;
            fy += (dy / dl) * push;
            flash += fall * 0.5;
          }
        }
        for (const r of state.rings) {
          const life = r.age / RING_SECONDS;
          const radius = Math.max(0, r.age - level * 0.07) * Math.max(W, H) * 0.55;
          const dx = sx - r.x;
          const dy = sy - r.y;
          const dist = Math.hypot(dx, dy) || 1;
          const band = Math.exp(-((dist - radius) ** 2) / (H * H * 0.0016)) * (1 - life) * (1 - life);
          if (band > 0.01) {
            flash += band * 1.4;
            fx += (dx / dist) * band * 900;
            fy += (dy / dist) * band * 900;
          }
        }
        for (let k = 0; k < steps; k += 1) {
          m.vx += (fx - 24 * m.ox - 7.5 * m.vx) * h;
          m.vy += (fy - 24 * m.oy - 7.5 * m.vy) * h;
          m.ox += m.vx * h;
          m.oy += m.vy * h;
        }

        const blur = clamp(Math.abs(1 - FOCUS / depth) * 1.2 * s.depthOfField, 0, 1);
        const weight = FADE[level] * appear * Math.sqrt(taper);
        if (weight < 0.01) continue;
        items.push({ m, p, tan, ac, li, depth, blur, weight, flash, angle, s0, size: m.size * GROWTH[level] * Math.sqrt(taper) });
      }

      n = 0;
      if (s.kind === 'obsidian') {
        /* Far to near, so near black plates cover the glow behind them. */
        items.sort((a, b) => b.depth - a.depth);
        for (const it of items) {
          const { m, p, tan } = it;
          const v = norm([-p[0], -p[1], CAMERA - p[2]]);
          let k = [tan[0] - v[0] * dot(tan, v), tan[1] - v[1] * dot(tan, v), tan[2] - v[2] * dot(tan, v)];
          k = norm(k);
          const w = cross(v, k);
          const cy = Math.cos(m.yaw);
          const sy = Math.sin(m.yaw);
          const kk = [0, 1, 2].map((c) => k[c] * cy + w[c] * sy);
          const jj = [0, 1, 2].map((c) => w[c] * cy - k[c] * sy);
          const wave = 0.8 * Math.sin(it.angle) + 0.3 * Math.sin(it.s0 * TAU * 1.6 - state.roll * 0.55 + m.level * 0.9 + m.lane * 0.7);
          const flutter = 0.06 * Math.sin(state.clock * m.flutter[1] + m.flutter[0]);
          const bank = MAX_BANK * Math.tanh((wave + m.bank + flutter) / MAX_BANK);
          const nrm = [0, 1, 2].map((c) => v[c] * Math.cos(bank) + jj[c] * Math.sin(bank));
          const side = norm(cross(nrm, kk));
          const size = 0.07 * it.size;
          const pts = m.outline.map(([ox, oy]) => {
            const q = [0, 1, 2].map((c) => p[c] + (kk[c] * ox + side[c] * oy) * size);
            const [qx, qy] = project(q);
            return [qx + m.ox, qy + m.oy];
          });
          const [cx, cyy] = project(p);
          const spec = Math.pow(Math.abs(dot(nrm, LIGHT)), 6);
          const a = it.weight;
          fan(pts, cx + m.ox, cyy + m.oy, [0.035, 0.027, 0.06], 0.94 * a);
          const halo = 2.2 + it.blur * 6;
          const core = 0.55 * (1 - it.blur * 0.4);
          const edgeA = Math.min(1, (0.45 + spec * 0.4 + it.flash) * a * (1 - it.blur * 0.45));
          /* Two passes per edge: a wide soft glow in the accent, then a thin
             bright core on it. One line carrying both read as a grey wire. */
          for (let e = 0; e < pts.length; e += 1) {
            const P = pts[e];
            const Q = pts[(e + 1) % pts.length];
            line(P[0], P[1], Q[0], Q[1], accent, edgeA * 0.5, 0.15, halo + 3);
          }
          for (let e = 0; e < pts.length; e += 1) {
            const P = pts[e];
            const Q = pts[(e + 1) % pts.length];
            line(P[0], P[1], Q[0], Q[1], bright, edgeA, core, halo * 0.5);
          }
          if (spec > 0.05) {
            const P = pts[m.glintEdge];
            const Q = pts[(m.glintEdge + 1) % pts.length];
            line(P[0], P[1], Q[0], Q[1], [1, 1, 1], Math.min(1, spec * 0.95 * a), core * 0.9, halo * 0.6);
          }
        }
      } else {
        for (const it of items) {
          const { m, p, tan, ac, li } = it;
          /* Spinning end over end, each on its own axis and pace. */
          const phi = m.spin[0] + state.clock * m.spin[1];
          const theta = m.spin[2] + state.clock * 0.3 * m.spin[1];
          const sp = Math.sin(phi);
          const d = norm([0, 1, 2].map((c) => tan[c] * Math.cos(phi) + (ac[c] * Math.cos(theta) + li[c] * Math.sin(theta)) * sp));
          const half = 0.042 * it.size;
          const [ax, ay] = project([p[0] - d[0] * half, p[1] - d[1] * half, p[2] - d[2] * half]);
          const [bx, by] = project([p[0] + d[0] * half, p[1] + d[1] * half, p[2] + d[2] * half]);
          const glint = Math.pow(1 - Math.abs(dot(d, LIGHT)), 4);
          const col = bright.map((v) => v + (1 - v) * glint * 0.85);
          const a = Math.min(1, (0.35 + glint * 0.6 + it.flash) * it.weight * 0.85 * (1 - it.blur * 0.45));
          /* A wide glow in the accent, then the bright sliver on it. */
          line(ax + m.ox, ay + m.oy, bx + m.ox, by + m.oy, accent, a * (0.45 + glint * 0.35), 0.2, 5 + it.blur * 7);
          line(ax + m.ox, ay + m.oy, bx + m.ox, by + m.oy, col, a, 0.45 + glint * 0.4, 1.2 + it.blur * 3);
        }
      }
    };

    const draw = () => {
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      if (!n) return;
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.useProgram(prog);
      gl.uniform2f(loc.view, W, H);
      gl.uniform1f(loc.dpr, ratio);
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, data.subarray(0, n * FLOATS), gl.STREAM_DRAW);
      const stride = FLOATS * 4;
      gl.enableVertexAttribArray(loc.pos);
      gl.vertexAttribPointer(loc.pos, 2, gl.FLOAT, false, stride, 0);
      gl.enableVertexAttribArray(loc.col);
      gl.vertexAttribPointer(loc.col, 4, gl.FLOAT, false, stride, 8);
      gl.enableVertexAttribArray(loc.line);
      gl.vertexAttribPointer(loc.line, 3, gl.FLOAT, false, stride, 24);
      gl.drawArrays(gl.TRIANGLES, 0, n);
    };

    let raf = 0;
    let quiet = 0;
    const tick = (now) => {
      raf = requestAnimationFrame(tick);
      if (document.hidden) { state.last = 0; return; }
      const s = settingsRef.current;
      if (state.last && now - state.last < 1000 / s.maxFps - 4) return;
      const dt = state.last ? Math.min((now - state.last) / 1000, 0.05) : 0;
      state.last = now;
      const still = reduced();
      state.clock += dt;
      /* Nothing moving and nothing to answer: hold the last picture. */
      const transient = state.presence > 0.002 || state.rings.length > 0
        || state.clock - state.introAt < INTRO_SECONDS + 0.5 || s.replay !== state.replayed || s.kind !== builtFor;
      if ((s.paused || still) && !transient) {
        quiet += 1;
        if (quiet > 2) return;
      } else {
        quiet = 0;
      }
      step(s, dt, still);
      draw();
    };

    const onMove = (e) => {
      const r = host.getBoundingClientRect();
      state.pointer.x = e.clientX - r.left;
      state.pointer.y = e.clientY - r.top;
      state.pointer.inside = state.pointer.x >= 0 && state.pointer.y >= 0 && state.pointer.x <= r.width && state.pointer.y <= r.height;
    };
    const onLeave = () => { state.pointer.inside = false; };
    const onDown = (e) => {
      const s = settingsRef.current;
      if (!s.pulseOnClick || e.button !== 0 || reduced()) return;
      if (e.target instanceof Element && e.target.closest('a, button, input, textarea, select, label, [role="button"]')) return;
      const r = host.getBoundingClientRect();
      state.rings.push({ x: e.clientX - r.left, y: e.clientY - r.top, age: 0 });
      if (state.rings.length > 4) state.rings.shift();
    };
    const onLost = (e) => { e.preventDefault(); cancelAnimationFrame(raf); raf = 0; };

    const sizes = new ResizeObserver(() => { resize(); quiet = 0; });
    sizes.observe(host);
    window.addEventListener('pointermove', onMove, { passive: true });
    window.addEventListener('pointerdown', onDown, { passive: true });
    document.documentElement.addEventListener('pointerleave', onLeave);
    window.addEventListener('blur', onLeave);
    canvas.addEventListener('webglcontextlost', onLost);
    resize();
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      sizes.disconnect();
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerdown', onDown);
      document.documentElement.removeEventListener('pointerleave', onLeave);
      window.removeEventListener('blur', onLeave);
      canvas.removeEventListener('webglcontextlost', onLost);
      gl.deleteBuffer(buffer);
      gl.deleteProgram(prog);
      canvas.remove();
    };
  }, []);

  return <div ref={ref} className={className} style={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden' }} />;
}
