/**
 * backdrops.js — the shapes the light behind the app can take.
 *
 * Every backdrop is the same material: a bundle of thin strands, added
 * together in light, so that wherever they crowd or cross the picture burns
 * toward white. What changes is the choreography — where the strands come
 * from, where they meet, and how they leave. Streak.jsx animates whichever one
 * is chosen and streakGL.js paints it; neither knows which it is drawing.
 *
 * A backdrop is:
 *
 *   id, name, line   what Settings shows
 *   count            [strands on a large screen, on a small one] — at most 225,
 *                    the most the painter's 16-bit index can address
 *   focus            where the lamp sits, as fractions of the window. The lamp
 *                    lights every strand by its distance from here, so this is
 *                    where the picture is brightest
 *   lamp, bloom      the lamp's and the glow's radius, as fractions of the
 *                    window's longer side
 *   fx               the drama, all per pixel in the painter: glow (px the halo
 *                    reaches past a strand), halo (its strength), pulses (surges
 *                    per strand), pulseSpeed (strand lengths a second),
 *                    pulseGain, heat (white at the focus), chill (cool tint at
 *                    the edges), flare (the anamorphic streak), breathe (how
 *                    much the bloom swells and settles)
 *   look(s)          optional: a strand's width and weight, if not the default
 *   shape(s, time, fx, fy, W, H)
 *                    one strand at one moment, as two cubics joined end to end:
 *                    the 14 numbers [P0, P1, P2, M, Q1, Q2, Q3] in CSS px
 *
 * Shapes are hashed off the strand's index, never random, so each backdrop is
 * the same picture every time the app starts.
 */

/* ---- gradient noise -------------------------------------------------------
   One dimension is all this needs: every strand reads its own slice of the
   same drifting field, offset by its index. Hashed gradients with a smoothstep
   between them — the real thing, not summed sines, which beat against each
   other and give the bundle a pulse you can count. */
const PERM = new Uint8Array(512);
(() => {
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i += 1) p[i] = i;
  /* A fixed shuffle. The field has to be the same on every load, or the
     bundle would be a different shape each time the app started. */
  let seed = 1337;
  for (let i = 255; i > 0; i -= 1) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const j = seed % (i + 1);
    const t = p[i]; p[i] = p[j]; p[j] = t;
  }
  for (let i = 0; i < 512; i += 1) PERM[i] = p[i & 255];
})();

const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);

export function noise(x) {
  const i = Math.floor(x) & 255;
  const f = x - Math.floor(x);
  /* Gradients in one dimension are just a sign and a magnitude. */
  const g0 = (PERM[i] & 15) / 7.5 - 1;
  const g1 = (PERM[i + 1] & 15) / 7.5 - 1;
  const u = fade(f);
  return (g0 * f) * (1 - u) + (g1 * (f - 1)) * u;
}

/* Three slices of the field and a slow swing, per strand per moment. Every
   shape stirs itself with these. */
function stir(s, time) {
  return {
    n1: noise(s.seed + time * 0.42),
    n2: noise(s.seed * 1.7 + 40 + time * 0.31),
    n3: noise(s.seed * 0.6 + 90 + time * 0.23),
    swing: Math.sin(time * 1.6 + s.phase) * 0.5 + 0.5,
  };
}

/* Two cubics through P, M and Q, each point given with the direction and
   speed the strand has there. Hermite to Bézier: a control point sits a third
   of the velocity out from its end. Sharing M's velocity between the two
   halves is what makes them meet without a corner. */
function through(px, py, pvx, pvy, mx, my, mvx, mvy, qx, qy, qvx, qvy) {
  return [
    px, py, px + pvx / 3, py + pvy / 3, mx - mvx / 3, my - mvy / 3,
    mx, my,
    mx + mvx / 3, my + mvy / 3, qx - qvx / 3, qy - qvy / 3, qx, qy,
  ];
}

/* ---- the strands' own character -------------------------------------------
   Without this every strand is the same curve at a different offset, and a
   hundred copies of one curve read as a ribbon: smooth, even, and dead. Each
   gets its own turn radius, entry angle and place along the meeting point,
   which is what makes a bundle look spun rather than printed. */
export function buildStrands(backdrop, W) {
  const small = W < 760;
  const n = small ? backdrop.count[1] : backdrop.count[0];
  const strands = [];
  for (let i = 0; i < n; i += 1) {
    const t = n === 1 ? 0.5 : i / (n - 1);
    /* Signed position across the bundle. Squaring the magnitude crowds the
       strands toward the core and throws the outliers wide, which is what
       gives a bundle an edge instead of a boundary. */
    const u = t * 2 - 1;
    const spread = Math.sign(u) * Math.pow(Math.abs(u), 1.7);
    const h = (k) => {
      const v = Math.sin((i + 1) * k) * 43758.5453;
      return v - Math.floor(v);
    };
    const s = {
      i,
      t,
      u,
      spread,
      curl: 0.62 + h(12.9898) * 0.95,
      drift: h(78.233) * 2 - 1,
      rake: h(39.425) * 2 - 1,
      flare: 0.7 + h(93.989) * 0.8,
      /* Its own slice of the noise field, and its own clock. Without this
         the whole bundle would wave in lockstep like a flag. */
      seed: i * 1.37 + (i % 7) * 0.41,
      phase: (i / n) * Math.PI * 2,
      /* Thicker and brighter toward the core. */
      width: 0.6 + (1 - Math.abs(u)) * 0.9,
      alpha: 0.07 + (1 - Math.abs(u)) * 0.53,
      /* Mostly the accent. A few strands take the cooler tint and a few go
         pale, which is what stops a hundred lines of one colour reading as a
         flat wash. */
      hue: i % 11 === 0 ? 'cool' : i % 7 === 0 ? 'pale' : 'main',
    };
    if (backdrop.look) Object.assign(s, backdrop.look(s, h));
    strands.push(s);
  }
  return strands;
}

/* ===========================================================================
   The backdrops. The first is the default.
   =========================================================================== */

export const BACKDROPS = [
  /* ---- Silk Fold ----------------------------------------------------------
     The original. A bundle streams in from off the top right, sweeps down and
     left, turns a tight hairpin low on the left and streams back out to the
     right underneath itself. The fold is the brightest thing on the screen:
     where a hundred strands turn within a few pixels of each other, the turn
     burns white without anything being drawn there. */
  {
    id: 'silk',
    name: 'Silk Fold',
    line: 'One ribbon, folded back on itself.',
    count: [118, 52],
    focus: [0.26, 0.68],
    lamp: 0.62,
    bloom: 0.22,
    fx: { glow: 5, halo: 0.28, pulses: 1.4, pulseSpeed: 0.16, pulseGain: 2.4, heat: 0.62, chill: 0.45, flare: 0.6, breathe: 0.18 },
    shape(s, time, fx, fy, W, H) {
      const { n1, n2, n3, swing } = stir(s, time);
      /* Unsigned: both sides of the bundle fold the same way round the turn.
         The sign is spent on which of the two sheets a strand lies in. */
      const a = Math.abs(s.spread);
      const side = s.spread < 0 ? -1 : 1;

      /* Where this strand turns. The apexes are strung out along a short
         diagonal, which gives the bright part a LENGTH — a caustic you can
         follow rather than a dot everything is aimed at. */
      const tx = fx - a * W * 0.042 + s.drift * W * 0.028 + n3 * W * 0.012;
      const ty = fy + a * H * 0.035 + s.drift * H * 0.032 + side * a * H * 0.018;

      /* The radius of the turn: tight at the core, so the fold comes to a
         point instead of rounding off into a bowl. */
      const e = H * (0.055 + a * 0.25 + swing * 0.015) * s.curl;

      /* Straight above and straight below the apex, so the two halves meet
         heading straight down, as a hairpin does. */
      const ax2 = tx + n1 * W * 0.006;
      const ay2 = ty - e;
      const bx1 = tx + n2 * W * 0.006;
      const by1 = ty + e * (0.64 + s.rake * 0.2);

      /* In from the upper right; the wide strands enter higher and further
         out, so the top fills with them while the core is already round. */
      const ax1 = W * (0.44 + a * 0.3 + s.rake * 0.1) + n2 * W * 0.055;
      const ay1 = ay2 - H * (0.11 + a * 0.26) * s.flare;
      const ax0 = W * (1.1 + a * 0.25 + s.rake * 0.12);
      const ay0 = ay1 - H * (0.3 + a * 0.8) * s.flare + n1 * H * 0.13;

      /* And out again, flatter than it came in. */
      const bx2 = W * (0.4 + a * 0.26 - s.rake * 0.14) + n3 * W * 0.07;
      const by2 = by1 + H * (0.05 + a * 0.12) * s.flare + n2 * H * 0.05;
      const bx3 = W * (1.15 + a * 0.22 - s.rake * 0.1);
      const by3 = by2 + H * (0.08 + a * 0.38) * s.flare + n3 * H * 0.1;

      return [ax0, ay0, ax1, ay1, ax2, ay2, tx, ty, bx1, by1, bx2, by2, bx3, by3];
    },
  },

  /* ---- Zenith -------------------------------------------------------------
     An arch. Strands rise from below the left of the screen, crest together
     at one point high in the middle, and fall away off the bottom right — a
     rainbow pinched at its peak. The narrow core arcs tight, the outliers
     swing wide, and the crest is where they all agree. */
  {
    id: 'zenith',
    name: 'Zenith',
    line: 'An arch of light, pinned at its peak.',
    count: [124, 54],
    /* High and right of centre: over the dashboard's panel, behind its glass,
       rather than under the brief you are reading. */
    focus: [0.62, 0.18],
    lamp: 0.6,
    bloom: 0.2,
    fx: { glow: 5, halo: 0.32, pulses: 1.2, pulseSpeed: 0.14, pulseGain: 2.6, heat: 0.85, chill: 0.5, flare: 0.95, breathe: 0.2 },
    shape(s, time, fx, fy, W, H) {
      const { n1, n2, n3, swing } = stir(s, time);
      const a = Math.abs(s.spread);
      const side = s.spread < 0 ? -1 : 1;

      /* The crest: nearly one point, smeared a little along the arch so the
         bright part has a length. */
      const mx = fx + s.drift * W * 0.035 + n3 * W * 0.015;
      const my = fy + a * H * 0.05 + side * a * H * 0.02 + s.drift * H * 0.015;
      /* Speed through the crest decides how wide the arch is there. */
      const sweep = W * (0.28 + a * 0.75) * s.curl * (0.85 + swing * 0.2);

      const px = W * (0.5 - 0.3 - a * 0.42 + s.rake * 0.08) + n2 * W * 0.05;
      const py = H * (1.06 + a * 0.18 * s.flare);
      const qx = W * (0.62 + 0.3 + a * 0.4 - s.rake * 0.08) + n1 * W * 0.05;
      const qy = H * (1.08 + a * 0.24 * s.flare) + n3 * H * 0.05;
      const climb = H * (1.0 + a * 0.7) * s.flare;

      return through(
        px, py, W * 0.08, -climb,
        mx, my, sweep, n1 * H * 0.08,
        qx, qy, W * 0.06, climb * (0.9 + s.rake * 0.15),
      );
    },
  },

  /* ---- Crosswind ----------------------------------------------------------
     Two sheets, crossing. Half the strands blow in from the upper left and
     out to the lower right; the other half rise from the lower left to the
     upper right. Both are drawn through the same narrow gap, and the X they
     make there is the hot spot. */
  {
    id: 'crosswind',
    name: 'Crosswind',
    line: 'Two currents, passing through each other.',
    count: [128, 56],
    /* Low on the left, under the lists rather than through them. */
    focus: [0.34, 0.8],
    lamp: 0.58,
    bloom: 0.2,
    fx: { glow: 4, halo: 0.32, pulses: 2, pulseSpeed: 0.22, pulseGain: 2.2, heat: 0.85, chill: 0.4, flare: 0.75, breathe: 0.15 },
    shape(s, time, fx, fy, W, H) {
      const { n1, n2, n3, swing } = stir(s, time);
      const a = Math.abs(s.spread);
      const up = s.i % 2 === 0;
      /* Each sheet's heading, and the side it fans out to. */
      const dx = W;
      const dy = up ? -H * 0.5 : H * 0.62;
      const len = Math.hypot(dx, dy);
      const ux = dx / len;
      const uy = dy / len;
      const vx = -uy;
      const vy = ux;

      /* Through the gap, a few pixels apart. */
      const off = s.spread * H * 0.025 + n3 * H * 0.01;
      const mx = fx + vx * off + ux * s.drift * W * 0.03;
      const my = fy + vy * off + uy * s.drift * W * 0.03;

      /* Fanned wide at both ends, mirrored across the gap the way rays are
         through a lens, and the whole sheet bowed so it is never a straight
         line. */
      const reach = W * (0.62 + a * 0.2) * s.flare;
      const fan = s.spread * H * (0.55 + swing * 0.08) * s.curl;
      const bow = H * (up ? 0.12 : -0.1) + n1 * H * 0.06;
      const px = mx - ux * reach + vx * fan;
      const py = my - uy * reach + vy * fan + bow;
      const qx = mx + ux * reach * 1.05 - vx * fan * 1.1;
      const qy = my + uy * reach * 1.05 - vy * fan * 1.1 + bow;

      const speed = reach * (1.1 + s.rake * 0.2);
      return through(
        px, py, ux * speed + vx * -fan * 0.6, uy * speed + n2 * H * 0.2,
        mx, my, ux * speed * 0.9, uy * speed * 0.9,
        qx, qy, ux * speed - vx * fan * 0.4, uy * speed + n1 * H * 0.2,
      );
    },
  },

  /* ---- Perihelion ---------------------------------------------------------
     A comet at its closest pass. A long tail curls in from off the lower left,
     the strands gather to one bright head high on the right, and spray out a
     short way past it. All tail and one point of fire. */
  {
    id: 'perihelion',
    name: 'Perihelion',
    line: 'A comet at its closest pass.',
    count: [120, 52],
    focus: [0.76, 0.28],
    /* Long enough to light the tail all the way back to the left edge. */
    lamp: 1.0,
    bloom: 0.18,
    fx: { glow: 6, halo: 0.36, pulses: 2.4, pulseSpeed: 0.3, pulseGain: 2.8, heat: 0.55, chill: 0.6, flare: 1.0, breathe: 0.25 },
    shape(s, time, fx, fy, W, H) {
      const { n1, n2, n3, swing } = stir(s, time);
      const a = Math.abs(s.spread);

      /* The head. */
      const mx = fx + s.drift * W * 0.014 + n3 * W * 0.008;
      const my = fy + s.spread * H * 0.03 + n1 * H * 0.01;

      /* The tail, fanned up and down the left edge: it crosses the whole
         screen to reach the head, so the wide strands start further off. */
      const px = W * (-0.06 - a * 0.1 + s.rake * 0.03);
      const py = H * (0.66 + s.spread * 0.5 * s.flare) + n1 * H * 0.08;
      /* Leaving the edge heading slightly down and arriving at the head
         climbing, so the tail sags under the head like a thrown line. */
      const pvx = W * (0.95 + a * 0.2);
      const pvy = H * (0.2 + a * 0.15) * s.curl - swing * H * 0.06;
      const mvx = W * (0.36 + a * 0.12) * s.curl;
      const mvy = -H * (0.36 + a * 0.1) * s.curl + n2 * H * 0.05;

      /* The spray past the head: short, fanned, falling away. */
      const qx = mx + W * (0.14 + a * 0.18) * s.flare;
      const qy = my - H * (0.12 + s.spread * 0.34) * s.curl + n2 * H * 0.04;
      const qvx = W * (0.2 + a * 0.15);
      const qvy = -H * (0.04 + s.spread * 0.4);

      return through(px, py, pvx, pvy, mx, my, mvx, mvy, qx, qy, qvx, qvy);
    },
  },

  /* ---- Aurora -------------------------------------------------------------
     Curtains. Each strand is a ray hanging up from a band that ripples across
     the screen, leaning with the fold of the curtain it is in. The rays are
     wide and faint, so where they bunch on a fold they add up to a sheet of
     light, the way the real thing does. */
  {
    id: 'aurora',
    name: 'Aurora',
    line: 'Curtains of light over a dark sky.',
    count: [210, 96],
    /* The lamp sits on the band and reaches the whole width, so the curtain
       is brightest along its hem and fades as the rays climb. */
    focus: [0.5, 0.46],
    lamp: 1.0,
    bloom: 0.34,
    /* The flare lies along the hem, so it reads as a glowing horizon under
       the curtain; a slow shimmer rises up the rays, and it breathes most. */
    fx: { glow: 3, halo: 0.26, pulses: 1, pulseSpeed: 0.12, pulseGain: 2.6, heat: 0.45, chill: 0.7, flare: 0.5, breathe: 0.32 },
    /* Two kinds of ray. Most are wide and faint, and overlap into a sheet —
       that is the curtain. One in four is a fine bright thread, which is the
       structure you see in it. */
    look: (s, h) => (s.i % 4 === 0
      ? { width: 0.8 + h(17.17) * 0.9, alpha: 0.22 + h(51.3) * 0.26, hue: s.i % 3 === 0 ? 'pale' : 'main' }
      : { width: 7 + h(17.17) * 12, alpha: 0.06 + h(51.3) * 0.09, hue: s.i % 5 === 1 ? 'cool' : 'main' }),
    shape(s, time, fx, fy, W, H) {
      const { n1, n2, swing } = stir(s, time);
      /* Evenly across the whole width, then shoved together and apart by a
         slow field: where the rays bunch, the curtain has a fold and the
         light piles up there; where they part, it thins to almost nothing. */
      const bunch = noise(s.t * 7 + time * 0.22) * W * 0.09 + noise(s.t * 19 - time * 0.13) * W * 0.03;
      const x = W * (-0.06 + s.t * 1.12) + bunch;
      /* The hem the curtain hangs from: a long travelling ripple. Its slope is
         what each ray leans with. */
      const k = (x / W) * 5.2 + time * 0.3;
      const base = fy + H * (0.09 * Math.sin(k) + 0.04 * Math.sin(k * 2.3 + 1.7)) + n1 * H * 0.015;
      const slope = Math.cos(k) * 0.6 + Math.cos(k * 2.3 + 1.7) * 0.2;
      const lean = slope * H * 0.18 + n2 * H * 0.05;

      /* Short rays and tall ones side by side give the top a ragged edge. */
      const tall = H * (0.3 + s.flare * 0.32 + swing * 0.06);
      const px = x;
      const py = base + H * 0.02 * s.curl;
      const mx = x + lean * 0.35;
      const my = base - tall * 0.35;
      const qx = x + lean * (1.0 + s.rake * 0.25);
      const qy = base - tall;

      return through(
        px, py, lean * 0.15, -tall * 0.4,
        mx, my, lean * 0.6, -tall * 0.6,
        qx, qy, lean * 0.8, -tall * 0.7,
      );
    },
  },

  /* ---- Maelstrom ----------------------------------------------------------
     Everything spirals in. Strands come round from all sides of the screen
     and wind down into one point low on the left, turning slowly as a whole.
     The core is where every strand ends up, so it is the brightest thing
     there is. */
  {
    id: 'maelstrom',
    name: 'Maelstrom',
    line: 'Everything spirals toward one point.',
    count: [132, 56],
    focus: [0.3, 0.62],
    lamp: 0.56,
    bloom: 0.2,
    fx: { glow: 5, halo: 0.34, pulses: 1.8, pulseSpeed: 0.2, pulseGain: 2.6, heat: 0.95, chill: 0.55, flare: 0.6, breathe: 0.22 },
    shape(s, time, fx, fy, W, H) {
      const { n1, n2, n3, swing } = stir(s, time);
      const a = Math.abs(s.spread);
      const big = Math.max(W, H);

      /* Where round the screen it starts, turning slowly as a whole. */
      const t0 = s.t * Math.PI * 2 + time * 0.045 + n1 * 0.25;
      const tm = t0 + (1.5 + s.curl * 0.6);
      const tq = tm + (1.7 + s.curl * 0.5 + swing * 0.15);
      const r0 = big * (0.78 + a * 0.28) * s.flare;
      const rm = big * (0.2 + a * 0.12) * (0.9 + n2 * 0.2);
      const rq = big * (0.012 + a * 0.03) + n3 * big * 0.006;

      const at = (th, r) => [fx + Math.cos(th) * r, fy + Math.sin(th) * r * 0.82];
      /* Velocity along a spiral: inward by the change in radius, round by
         the radius times the change in angle. */
      const vel = (th, r, dth, dr) => [
        dr * Math.cos(th) - r * dth * Math.sin(th),
        (dr * Math.sin(th) + r * dth * Math.cos(th)) * 0.82,
      ];
      const [px, py] = at(t0, r0);
      const [mx, my] = at(tm, rm);
      const [qx, qy] = at(tq, rq);
      const d1 = tm - t0;
      const d2 = tq - tm;
      const [pvx, pvy] = vel(t0, r0, d1, (rm - r0) * 1.1);
      const [mvx, mvy] = vel(tm, rm, (d1 + d2) * 0.5, (rq - r0) * 0.25);
      const [qvx, qvy] = vel(tq, rq + big * 0.02, d2, (rq - rm) * 0.3);

      return through(px, py, pvx, pvy, mx, my, mvx, mvy, qx, qy, qvx, qvy);
    },
  },

  /* ---- Lights Out ---------------------------------------------------------
     Nothing behind the glass but the dark. Also the cheapest thing the app
     can draw. */
  {
    id: 'off',
    name: 'Lights Out',
    line: 'Just the dark. Easiest on the battery.',
    off: true,
  },
];

export const DEFAULT_BACKDROP = BACKDROPS[0].id;

export function backdropById(id) {
  return BACKDROPS.find((b) => b.id === id) || BACKDROPS[0];
}

/* The strands' lamp: how bright a strand is by its distance from the focus,
   as a fraction of the lamp's radius. Shared by both painters. */
export const LAMP_STOPS = [[0, 1], [0.06, 0.92], [0.22, 0.5], [0.52, 0.16], [1, 0]];

/* Read from the stylesheet. Every colour in this app is written down in
   exactly one place, and the canvas is not exempt. Parsed to channels once —
   a canvas wants numbers, and resolving a custom property per strand per
   frame is the kind of thing that quietly doubles a frame. */
export function readColours() {
  const token = (name, fallback) => {
    const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    const hex = /^#([0-9a-f]{6})$/i.exec(raw);
    if (!hex) return fallback;
    const n = parseInt(hex[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  };
  const accent = token('--accent', [169, 139, 255]);
  /* The bloom and the motes are the accent at its brightest — the same colour
     the strands are, lifted toward white. */
  const lift = (c, k) => c.map((v) => Math.round(v + (255 - v) * k));
  const hot = lift(accent, 0.3);
  return {
    main: accent,
    cool: token('--accent-cool', [110, 140, 255]),
    pale: token('--text', [241, 239, 246]),
    hot,
    /* The glow at the focus: [offset, colour, alpha]. */
    bloomStops: [[0, hot, 0.36], [0.12, accent, 0.14], [0.4, accent, 0.045], [1, [0, 0, 0], 0]],
  };
}

/**
 * One still frame of a backdrop, in miniature, through Canvas 2D — for the
 * swatches in Settings. Laid out on a full window's geometry and scaled down,
 * so the composition is the real one; the strands keep their own width in
 * swatch pixels, or at a fifth of the size they would vanish. The drama is
 * approximated the way Canvas 2D can: a wide faint pass for the halo, a
 * moving dash for the pulses, a squashed radial gradient for the flare.
 */
export function paintStill(canvas, backdrop, colours, { width, height, time = 2.1, secs = 0 } = {}) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (backdrop.off) return;

  const W = 1440;
  const H = (W * height) / width;
  const k = (width / W) * dpr;
  ctx.setTransform(k, 0, 0, k, 0, 0);
  ctx.globalCompositeOperation = 'lighter';

  const fx = W * backdrop.focus[0];
  const fy = H * backdrop.focus[1];
  const big = Math.max(W, H);
  const R = big * backdrop.lamp;

  const drama = backdrop.fx || {};
  const bloom = ctx.createRadialGradient(fx, fy, 0, fx, fy, big * backdrop.bloom);
  for (const [o, c, a] of colours.bloomStops) bloom.addColorStop(o, `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${a})`);
  ctx.fillStyle = bloom;
  ctx.fillRect(0, 0, W, H);

  /* The flare: a radial gradient squashed flat. */
  if (drama.flare) {
    const [r, g, b] = colours.hot;
    for (const [squash, a] of [[0.01, drama.flare * 0.9], [0.07, drama.flare * 0.16]]) {
      ctx.save();
      ctx.translate(fx, fy);
      ctx.scale(1, squash);
      const fl = ctx.createRadialGradient(0, 0, 0, 0, 0, W * 0.5);
      fl.addColorStop(0, `rgba(${r}, ${g}, ${b}, ${a})`);
      fl.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`);
      ctx.fillStyle = fl;
      ctx.fillRect(-W, -W * 0.5, W * 2, W);
      ctx.restore();
    }
  }

  /* Heat: white at the focus, the hue in the middle, cooling at the edge. */
  const mixc = (a, b, k) => a.map((v, i) => Math.round(v + (b[i] - v) * k));
  const lamp = (c) => {
    const grad = ctx.createRadialGradient(fx, fy, 0, fx, fy, R);
    for (const [o, a] of LAMP_STOPS) {
      let col = mixc(c, [255, 255, 255], (1 - Math.min(1, o / 0.16)) * (drama.heat || 0));
      col = mixc(col, colours.cool, Math.max(0, Math.min(1, (o - 0.3) / 0.65)) * (drama.chill || 0));
      grad.addColorStop(o, `rgba(${col[0]}, ${col[1]}, ${col[2]}, ${a})`);
    }
    return grad;
  };
  const lamps = { main: lamp(colours.main), cool: lamp(colours.cool), pale: lamp(colours.pale) };

  ctx.lineCap = 'round';
  const px = dpr / k; // one swatch pixel, in the virtual window's units
  const period = 1500 / Math.max(0.5, drama.pulses || 1);
  const strands = buildStrands(backdrop, W);
  const trace = (c) => {
    ctx.beginPath();
    ctx.moveTo(c[0], c[1]);
    ctx.bezierCurveTo(c[2], c[3], c[4], c[5], c[6], c[7]);
    ctx.bezierCurveTo(c[8], c[9], c[10], c[11], c[12], c[13]);
    ctx.stroke();
  };
  for (const s of strands) {
    const c = backdrop.shape(s, time, fx, fy, W, H);
    ctx.strokeStyle = lamps[s.hue];
    if (drama.halo) {
      ctx.globalAlpha = Math.min(1, s.alpha * drama.halo * 0.6);
      ctx.lineWidth = (Math.max(0.5, s.width * 0.8) + (drama.glow || 0) * 0.6) * px;
      trace(c);
    }
    ctx.globalAlpha = Math.min(1, s.alpha * 1.25);
    ctx.lineWidth = Math.max(0.5, s.width * 0.8) * px;
    trace(c);
    if (drama.pulseGain) {
      const ph = Math.sin((s.i + 1) * 91.17) * 43758.5453;
      ctx.setLineDash([period * 0.06, period * 0.94]);
      ctx.lineDashOffset = ((ph - Math.floor(ph)) - secs * (drama.pulseSpeed || 0) * 2) * period;
      ctx.globalAlpha = Math.min(1, s.alpha * drama.pulseGain * 0.8);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
      ctx.lineWidth = Math.max(0.8, s.width) * px;
      trace(c);
      ctx.setLineDash([]);
    }
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
}
