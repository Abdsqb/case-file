/**
 * Streak.jsx — the light behind the app.
 *
 * A bundle of thin strands streams in from off the top right, sweeps down and
 * left across the screen, turns a tight hairpin at a point in the lower left,
 * and streams back out to the right underneath itself. It is one bundle folded
 * back on itself, and the fold is the brightest thing on the screen: where a
 * hundred strands cross within a few pixels of each other, additive blending
 * burns the turn white without anything being drawn there.
 *
 * The whole bundle undulates on gradient noise, so it drifts and breathes like
 * silk under water rather than looping.
 *
 * It is a single full-viewport canvas behind everything, and it never takes
 * the pointer. Three things keep it from costing anything that matters:
 *
 *   - each strand is ONE bezier stroke with a gradient along it, not a chain
 *     of segments. Brightness varies along the strand without the hundreds of
 *     tiny strokes per frame that would otherwise take;
 *   - the loop stops dead when the tab is hidden, and the strand count drops
 *     on a small screen;
 *   - prefers-reduced-motion paints one frame and stops. The picture is the
 *     point; the motion is a bonus, and it is the bonus that costs.
 */

import { useEffect, useRef } from 'react';

/* Screens that are mostly content. The streak stays, at a fraction of its
   weight, because a wall of rows over a bright strand is hard to read. */
const DENSE = new Set(['reporting', 'settings', 'flashcards', 'cases']);

const STRANDS = 118;
const STRANDS_SMALL = 52;
const PARTICLES = 18;

/* How long one full undulation takes, give or take — the strands are on
   several frequencies, so the bundle never quite repeats. */
const CYCLE_MS = 11000;

const MAX_PARALLAX = 20;

/* ---- gradient noise ------------------------------------------------------
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

function noise(x) {
  const i = Math.floor(x) & 255;
  const f = x - Math.floor(x);
  /* Gradients in one dimension are just a sign and a magnitude. */
  const g0 = (PERM[i] & 15) / 7.5 - 1;
  const g1 = (PERM[i + 1] & 15) / 7.5 - 1;
  const u = fade(f);
  return (g0 * f) * (1 - u) + (g1 * (f - 1)) * u;
}

/* Cubic bezier, one axis. */
function bez(a, b, c, d, t) {
  const m = 1 - t;
  return m * m * m * a + 3 * m * m * t * b + 3 * m * t * t * c + t * t * t * d;
}

export default function Streak({ view }) {
  const ref = useRef(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return undefined;
    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) return undefined;

    const still =
      document.documentElement.dataset.motion === 'reduced' ||
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    let W = 0;
    let H = 0;
    let strands = [];
    let particles = [];
    let raf = 0;
    let t0 = performance.now();

    /* Where the pointer is pulling the bundle, and where it has got to: the
       second chases the first, which is what makes the parallax a drift
       rather than a jump. */
    const aim = { x: 0, y: 0 };
    const at = { x: 0, y: 0 };

    const build = () => {
      const small = W < 760;
      const n = small ? STRANDS_SMALL : STRANDS;
      strands = [];
      for (let i = 0; i < n; i += 1) {
        const t = n === 1 ? 0.5 : i / (n - 1);
        /* Signed position across the bundle. Squaring the magnitude crowds the
           strands toward the core and throws the outliers wide, which is what
           gives a bundle an edge instead of a boundary. */
        const u = t * 2 - 1;
        const spread = Math.sign(u) * Math.pow(Math.abs(u), 1.7);
        /* A strand's own character, fixed at build and never animated.
           ------------------------------------------------------------------
           Without these every strand is the same curve at a different offset,
           and a hundred copies of one curve read as a ribbon: smooth, even,
           and dead. Giving each one its own turn radius, its own entry angle
           and its own place along the fold is what makes the bundle look spun
           rather than printed — strands cross each other, some whip round the
           turn tight while their neighbours swing wide, and the fold gets an
           edge made of a hundred different curves instead of one.

           Hashed off the index rather than random, so the picture is the same
           every time the app starts. */
        const h = (k) => {
          const v = Math.sin((i + 1) * k) * 43758.5453;
          return v - Math.floor(v);
        };
        const curl = 0.62 + h(12.9898) * 0.95;
        const drift = h(78.233) * 2 - 1;
        const rake = h(39.425) * 2 - 1;
        const flare = 0.7 + h(93.989) * 0.8;

        strands.push({
          u,
          spread,
          curl,
          drift,
          rake,
          flare,
          /* Its own slice of the noise field, and its own clock. Without this
             the whole bundle would wave in lockstep like a flag. */
          seed: i * 1.37 + (i % 7) * 0.41,
          phase: (i / n) * Math.PI * 2,
          /* Thicker and brighter toward the core. */
          width: 0.6 + (1 - Math.abs(u)) * 0.9,
          alpha: 0.07 + (1 - Math.abs(u)) * 0.53,
          /* Mostly the accent. A few strands take the cooler tint and a few go
             pale, which is what stops a hundred lines of one colour reading as
             a flat wash. */
          hue: i % 11 === 0 ? 'cool' : i % 7 === 0 ? 'pale' : 'main',
        });
      }
      particles = [];
      for (let i = 0; i < (small ? 8 : PARTICLES); i += 1) {
        particles.push({
          strand: Math.floor((i / PARTICLES) * strands.length),
          p: Math.random(),
          speed: 0.012 + Math.random() * 0.03,
          size: 0.7 + Math.random() * 0.9,
        });
      }
    };

    const resize = () => {
      /* Capped at 2: past that the extra pixels are invisible and the fill
         rate is not. */
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      W = window.innerWidth;
      H = window.innerHeight;
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
      canvas.style.width = `${W}px`;
      canvas.style.height = `${H}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      build();
    };

    /* One strand at one moment, as two cubics joined at the turn.
     *
     * A hairpin cannot be one cubic: a cubic cannot reverse direction and come
     * back alongside itself. Two can, and they join cleanly if both of the
     * controls either side of the apex sit on the same vertical line through
     * it. The strand is then travelling straight down as it passes the turn,
     * which is exactly what a hairpin does.
     *
     *            A0  (off the top right, far out for the wide strands)
     *              .
     *               A1
     *                .
     *        A2 --,     (A2 directly above the apex)
     *             T     the apex
     *        B1 --'     (B1 directly below it)
     *                .
     *                 B2 ----- B3  (off the right edge again)
     *
     * How far out a strand rides decides everything about it: how far left it
     * reaches, how wide it turns, and how high above the screen it starts. The
     * core strands turn tight and the outer ones swing wide, which is what
     * makes the bundle a bundle rather than a hundred parallel lines. */
    const shape = (s, time, fx, fy) => {
      const n1 = noise(s.seed + time * 0.42);
      const n2 = noise(s.seed * 1.7 + 40 + time * 0.31);
      const n3 = noise(s.seed * 0.6 + 90 + time * 0.23);
      const swing = Math.sin(time * 1.6 + s.phase) * 0.5 + 0.5;

      /* Unsigned: both sides of the bundle fold the same way round the turn.
         The sign is spent on which of the two sheets a strand lies in. */
      const a = Math.abs(s.spread);
      const side = s.spread < 0 ? -1 : 1;

      /* The apex. The wide strands reach further left and sit a little lower,
         which fans the fold into a teardrop instead of stacking every turn on
         the same point. */
      /* Where this strand turns. The fold is not a point: the apexes are
         strung out along a short diagonal, which is what gives the bright
         part of the picture a LENGTH — a caustic you can follow rather than a
         dot everything is aimed at. */
      const tx = fx - a * W * 0.042 + s.drift * W * 0.028 + n3 * W * 0.012;
      const ty = fy + a * H * 0.035 + s.drift * H * 0.032 + side * a * H * 0.018;

      /* The radius of the turn. Tight at the core: a small radius against a
         wide separation between the two sheets is what makes the fold come to
         a point instead of rounding off into a bowl. Scaled by the strand's
         own curl, so neighbours whip round at different radii and cross. */
      const e = H * (0.055 + a * 0.25 + swing * 0.015) * s.curl;

      /* Straight above and straight below, so the strand is heading down as it
         passes the apex and the two halves meet without a corner. */
      const ax2 = tx + n1 * W * 0.006;
      const ay2 = ty - e;
      const bx1 = tx + n2 * W * 0.006;
      const by1 = ty + e * (0.64 + s.rake * 0.2);

      /* In from the upper right. The further out a strand rides the higher and
         further right it enters, so the top of the screen fills with the wide
         ones arriving while the core is already round the turn. */
      const ax1 = W * (0.44 + a * 0.3 + s.rake * 0.1) + n2 * W * 0.055;
      const ay1 = ay2 - H * (0.11 + a * 0.26) * s.flare;
      const ax0 = W * (1.1 + a * 0.25 + s.rake * 0.12);
      const ay0 = ay1 - H * (0.3 + a * 0.8) * s.flare + n1 * H * 0.13;

      /* And out again, flatter than it came in: the lower sheet of the fold
         runs back across the screen rather than dropping off the bottom. */
      const bx2 = W * (0.4 + a * 0.26 - s.rake * 0.14) + n3 * W * 0.07;
      const by2 = by1 + H * (0.05 + a * 0.12) * s.flare + n2 * H * 0.05;
      const bx3 = W * (1.15 + a * 0.22 - s.rake * 0.1);
      const by3 = by2 + H * (0.08 + a * 0.38) * s.flare + n3 * H * 0.1;

      return [ax0, ay0, ax1, ay1, ax2, ay2, tx, ty, bx1, by1, bx2, by2, bx3, by3];
    };

    /* A point along the whole fold, nose to tail, as one 0..1 -- the first
       half is the upper sheet, the second the lower. Used by the motes. */
    const along = (c, p) => {
      if (p < 0.5) {
        const t = p * 2;
        return [bez(c[0], c[2], c[4], c[6], t), bez(c[1], c[3], c[5], c[7], t)];
      }
      const t = (p - 0.5) * 2;
      return [bez(c[6], c[8], c[10], c[12], t), bez(c[7], c[9], c[11], c[13], t)];
    };

    /* Read from the stylesheet, once, at mount.
     *
     * Every colour in this app is written down in exactly one place, and the
     * canvas is not exempt: hard-coding the strands here is how the light ends
     * up the wrong colour three months after someone moves the accent. Parsed
     * to channels once rather than per frame — a canvas wants numbers, and
     * resolving a custom property sixty times a second for a hundred strands
     * is the kind of thing that quietly doubles a frame. */
    const token = (name, fallback) => {
      const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      const hex = /^#([0-9a-f]{6})$/i.exec(raw);
      if (!hex) return fallback;
      const n = parseInt(hex[1], 16);
      return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    };

    const accent = token('--accent', [169, 139, 255]);
    const COLOURS = {
      main: accent,
      cool: token('--accent-cool', [110, 140, 255]),
      pale: token('--text', [241, 239, 246]),
    };
    /* The bloom and the motes are the accent at its brightest — the same
       colour the strands are, lifted toward white. */
    const lift = (c, k) => c.map((v) => Math.round(v + (255 - v) * k));
    const hot = lift(accent, 0.3);
    const BLOOM = `${hot[0]}, ${hot[1]}, ${hot[2]}`;
    const CORE = `${accent[0]}, ${accent[1]}, ${accent[2]}`;

    const frame = (now) => {
      const time = ((now - t0) / CYCLE_MS) * Math.PI * 2;

      /* Eased toward the pointer, never snapping to it. */
      at.x += (aim.x - at.x) * 0.045;
      at.y += (aim.y - at.y) * 0.045;

      /* Where the fold turns. Left of centre and low, so the bundle crosses
         the screen on the diagonal and the turn sits under the greeting
         rather than across the middle of it. */
      const fx = W * 0.26 + at.x;
      const fy = H * 0.68 + at.y;

      ctx.clearRect(0, 0, W, H);
      /* Additive: where strands cross they add up, which is what makes the
         knot at the focal point burn white without anything drawing it. */
      ctx.globalCompositeOperation = 'lighter';

      /* The bloom. Drawn first so the strands sit in it rather than on it. */
      const bloom = ctx.createRadialGradient(fx, fy, 0, fx, fy, Math.max(W, H) * 0.22);
      bloom.addColorStop(0, `rgba(${BLOOM}, 0.26)`);
      bloom.addColorStop(0.12, `rgba(${CORE}, 0.1)`);
      bloom.addColorStop(0.4, `rgba(${CORE}, 0.03)`);
      bloom.addColorStop(1, 'rgba(0, 0, 0, 0)');
      ctx.fillStyle = bloom;
      ctx.fillRect(0, 0, W, H);

      ctx.lineCap = 'round';

      /* Brightness by distance from the fold, not by distance along a strand.
         A strand comes in from the top right, turns, and goes back out: it
         passes the bright patch once, somewhere in the middle of its length,
         and where that is depends on how wide it turns. A gradient anchored to
         the turn itself lights every strand at the moment it passes, which is
         what draws the caustic.

         Three gradients a frame rather than one per strand: the colour is the
         same for every strand of a hue and only the weight differs, which is
         what globalAlpha is for. */
      const R = Math.max(W, H) * 0.62;
      const lamp = (c) => {
        const [r, g, b] = c;
        const grad = ctx.createRadialGradient(fx, fy, 0, fx, fy, R);
        grad.addColorStop(0, `rgba(${r}, ${g}, ${b}, 1)`);
        grad.addColorStop(0.06, `rgba(${r}, ${g}, ${b}, 0.92)`);
        grad.addColorStop(0.22, `rgba(${r}, ${g}, ${b}, 0.5)`);
        grad.addColorStop(0.52, `rgba(${r}, ${g}, ${b}, 0.16)`);
        grad.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`);
        return grad;
      };
      const LAMPS = {
        main: lamp(COLOURS.main),
        cool: lamp(COLOURS.cool),
        pale: lamp(COLOURS.pale),
      };

      for (const s of strands) {
        const c = shape(s, time, fx, fy);

        ctx.globalAlpha = s.alpha;
        ctx.strokeStyle = LAMPS[s.hue];
        ctx.lineWidth = s.width;
        ctx.beginPath();
        ctx.moveTo(c[0], c[1]);
        ctx.bezierCurveTo(c[2], c[3], c[4], c[5], c[6], c[7]);
        ctx.bezierCurveTo(c[8], c[9], c[10], c[11], c[12], c[13]);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;

      /* A few motes carried along the strands. They are what tells you the
         picture is alive when the undulation is at its slowest. */
      for (const p of particles) {
        const s = strands[p.strand % strands.length];
        if (!s) continue;
        p.p += p.speed * 0.016;
        if (p.p > 1) p.p -= 1;
        const [x, y] = along(shape(s, time, fx, fy), p.p);
        /* Brightest at the fold, like everything else here. */
        const lit = Math.max(0, 1 - Math.abs(p.p - 0.5) * 3.2);
        ctx.fillStyle = `rgba(${BLOOM}, ${0.10 + lit * 0.5})`;
        ctx.beginPath();
        ctx.arc(x, y, p.size, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.globalCompositeOperation = 'source-over';
      raf = requestAnimationFrame(frame);
    };

    const start = () => {
      if (raf || still) return;
      /* Picked up from where it left off rather than from zero, so coming
         back to the tab does not snap the bundle into another shape. */
      t0 = performance.now() - (t0 ? performance.now() - t0 : 0);
      raf = requestAnimationFrame(frame);
    };
    const stop = () => {
      if (!raf) return;
      cancelAnimationFrame(raf);
      raf = 0;
    };

    const onMove = (e) => {
      aim.x = ((e.clientX / window.innerWidth) * 2 - 1) * MAX_PARALLAX;
      aim.y = ((e.clientY / window.innerHeight) * 2 - 1) * MAX_PARALLAX * 0.6;
    };
    const onVisibility = () => (document.hidden ? stop() : start());
    const onResize = () => {
      resize();
      if (still) frame(performance.now());
    };

    resize();
    if (still) {
      /* One frame, held. The bundle is a picture at rest, not an empty box. */
      at.x = 0; at.y = 0;
      frame(performance.now());
      cancelAnimationFrame(raf);
      raf = 0;
    } else {
      start();
    }

    window.addEventListener('resize', onResize, { passive: true });
    document.addEventListener('visibilitychange', onVisibility);
    if (!still) window.addEventListener('pointermove', onMove, { passive: true });

    return () => {
      stop();
      window.removeEventListener('resize', onResize);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pointermove', onMove);
    };
  }, []);

  return (
    <canvas
      ref={ref}
      className="streak"
      data-dense={DENSE.has(view) ? 'true' : 'false'}
      aria-hidden="true"
    />
  );
}
