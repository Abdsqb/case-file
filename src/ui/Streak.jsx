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
 * the pointer. It is the most expensive thing in the app, and what keeps it
 * in check, measured on this machine's integrated GPU:
 *
 *   - it is painted through WebGL (streakGL.js), one draw call for every
 *     strand. Stroking the same curves through Canvas 2D held the browser's
 *     GPU process at a full core and dropped one frame in five; Canvas 2D is
 *     now only the fallback, and it paints the same picture;
 *   - thirty pictures a second, not sixty: every glass panel re-blurs what is
 *     behind it each time the streak changes;
 *   - the loop stops dead when the tab is hidden or standby is up, and the
 *     strand count drops on a small screen;
 *   - prefers-reduced-motion paints one frame and stops. The picture is the
 *     point; the motion is a bonus, and it is the bonus that costs.
 */

import { useEffect, useRef } from 'react';
import { STANDBY_EVENT } from './Standby.jsx';

/* Anything that lays a blur over the whole window can hold the streak still
   while it is up — the board opened full window does. Its own event rather
   than standby's, so standby waking underneath cannot restart it. */
export const STREAK_HOLD_EVENT = 'casefile:streak-hold';
import { createStreakGL } from './streakGL.js';
import { backdropById, buildStrands, LAMP_STOPS, readColours } from './backdrops.js';
import { KEY_ACCENT, KEY_BACKDROP, readAccent, readBackdrop, useSetting } from '../views/Settings.jsx';

/* Screens that are mostly content. The streak stays, at a fraction of its
   weight, because a wall of rows over a bright strand is hard to read. */
const DENSE = new Set(['reporting', 'settings', 'flashcards', 'cases']);

const PARTICLES = 36;

/* How long one full undulation takes, give or take — the strands are on
   several frequencies, so the bundle never quite repeats. */
const CYCLE_MS = 9000;

const MAX_PARALLAX = 20;

/* Cubic bezier, one axis. */
function bez(a, b, c, d, t) {
  const m = 1 - t;
  return m * m * m * a + 3 * m * m * t * b + 3 * m * t * t * c + t * t * t * d;
}

export default function Streak({ view }) {
  const ref = useRef(null);
  /* Only here to restart the effect: the colours below are read from the
     stylesheet at mount, so a new accent needs a new mount. readAccent()
     normalises a junk stored value to the one the stylesheet is showing. */
  useSetting(KEY_ACCENT, '');
  useSetting(KEY_BACKDROP, '');
  const accentId = readAccent();
  const backdropId = readBackdrop();

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return undefined;
    const backdrop = backdropById(backdropId);
    /* Lights Out: nothing to draw and nothing to run. */
    if (backdrop.off) return undefined;

    const still =
      document.documentElement.dataset.motion === 'reduced' ||
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    let W = 0;
    let H = 0;
    let dpr = 1;
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
      strands = buildStrands(backdrop, W);
      particles = [];
      for (let i = 0; i < (small ? 14 : PARTICLES); i += 1) {
        particles.push({
          strand: Math.floor((i / PARTICLES) * strands.length),
          p: Math.random(),
          speed: 0.015 + Math.random() * 0.04,
          size: 0.9 + Math.random() * 1.4,
          twinkle: Math.random() * Math.PI * 2,
        });
      }
    };

    const resize = () => {
      /* Capped at 2: past that the extra pixels are invisible and the fill
         rate is not. */
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      W = window.innerWidth;
      H = window.innerHeight;
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
      canvas.style.width = `${W}px`;
      canvas.style.height = `${H}px`;
      if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      build();
    };

    /* One strand at one moment, as two cubics joined end to end: how it is
       laid out is the backdrop's business (backdrops.js). */
    const shape = (s, time, fx, fy) => backdrop.shape(s, time, fx, fy, W, H);

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

    /* Read from the stylesheet, once per mount — and the effect remounts when
       the accent changes. */
    const palette = readColours();
    const COLOURS = { main: palette.main, cool: palette.cool, pale: palette.pale };
    const hot = palette.hot;
    const BLOOM = `${hot[0]}, ${hot[1]}, ${hot[2]}`;
    const BLOOM_STOPS = palette.bloomStops;

    /* WebGL if it will start, Canvas 2D if not. The picture is the same
       either way; see streakGL.js for why the first exists at all. */
    const glr = createStreakGL(canvas, {
      lampStops: LAMP_STOPS,
      bloomStops: BLOOM_STOPS,
      colours: COLOURS,
      moteColour: hot,
      fx: backdrop.fx,
    });
    const ctx = glr ? null : canvas.getContext('2d', { alpha: true });
    if (!glr && !ctx) return undefined;

    /* This frame's geometry, worked out once and handed to whichever painter
       is drawing. */
    const curves = [];
    const motes = [];

    /* One picture of the bundle at `now`, `dt` ms after the last one. */
    const draw = (now, dt) => {
      const time = ((now - t0) / CYCLE_MS) * Math.PI * 2;

      /* Eased toward the pointer, never snapping to it. The rate is per 60th
         of a second whatever the frame rate, so the drift takes as long at 30
         frames a second as it did at 60. */
      const ease = 1 - Math.pow(1 - 0.045, dt / 16.667);
      at.x += (aim.x - at.x) * ease;
      at.y += (aim.y - at.y) * ease;

      /* Where the fold turns. Left of centre and low, so the bundle crosses
         the screen on the diagonal and the turn sits under the greeting
         rather than across the middle of it. */
      const fx = W * backdrop.focus[0] + at.x;
      const fy = H * backdrop.focus[1] + at.y;

      const R = Math.max(W, H) * backdrop.lamp;
      const bloomR = Math.max(W, H) * backdrop.bloom;

      curves.length = strands.length;
      for (let i = 0; i < strands.length; i += 1) curves[i] = shape(strands[i], time, fx, fy);

      /* A few motes carried along the strands. They are what tells you the
         picture is alive when the undulation is at its slowest. */
      motes.length = 0;
      for (const p of particles) {
        const i = p.strand % strands.length;
        if (!strands[i]) continue;
        p.p += p.speed * (dt / 1000);
        if (p.p > 1) p.p -= 1;
        const [x, y] = along(curves[i], p.p);
        /* Brightest near the focus, like everything else here, and each one
           glinting on its own beat. */
        const lit = Math.max(0, 1 - Math.hypot(x - fx, y - fy) / (R * 0.4));
        const glint = 0.7 + 0.3 * Math.sin(now * 0.004 + p.twinkle);
        motes.push({ x, y, r: p.size, a: (0.14 + lit * 0.6) * glint });
      }

      if (glr) glr.paint({ W, H, dpr, fx, fy, R, bloomR, strands, curves, motes, time: (now - t0) / 1000 });
      else paint2d(fx, fy, R, bloomR);
    };

    const paint2d = (fx, fy, R, bloomR) => {
      ctx.clearRect(0, 0, W, H);
      /* Additive: where strands cross they add up, which is what makes the
         knot at the focal point burn white without anything drawing it. */
      ctx.globalCompositeOperation = 'lighter';

      /* The bloom. Drawn first so the strands sit in it rather than on it. */
      const bloom = ctx.createRadialGradient(fx, fy, 0, fx, fy, bloomR);
      for (const [o, c, a] of BLOOM_STOPS) bloom.addColorStop(o, `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${a})`);
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
      const lamp = (c) => {
        const [r, g, b] = c;
        const grad = ctx.createRadialGradient(fx, fy, 0, fx, fy, R);
        for (const [o, a] of LAMP_STOPS) grad.addColorStop(o, `rgba(${r}, ${g}, ${b}, ${a})`);
        return grad;
      };
      const LAMPS = {
        main: lamp(COLOURS.main),
        cool: lamp(COLOURS.cool),
        pale: lamp(COLOURS.pale),
      };

      for (let i = 0; i < strands.length; i += 1) {
        const s = strands[i];
        const c = curves[i];

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

      for (const m of motes) {
        ctx.fillStyle = `rgba(${BLOOM}, ${m.a})`;
        ctx.beginPath();
        ctx.arc(m.x, m.y, m.r, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.globalCompositeOperation = 'source-over';
    };

    /* Thirty pictures a second, not sixty.
       ------------------------------------------------------------------
       The bundle takes eleven seconds to undulate, so the eye cannot tell 30
       from 60 here — but every glass panel on screen blurs whatever is behind
       it, and each new picture of the streak is a new thing behind every one
       of them. At 60 the streak and the re-blurs it causes were most of the
       frame budget with nobody touching anything, and the screen in front of
       them dropped to 30 anyway. Drawing every other frame hands that half
       back to the interface. Skipped against a little slack so a 60Hz display
       lands on every second frame rather than jittering between 2 and 3, and a
       120Hz one on every fourth. */
    const STEP_MS = 1000 / 30;
    let last = 0;
    const frame = (now) => {
      raf = requestAnimationFrame(frame);
      if (last && now - last < STEP_MS - 4) return;
      /* Clamped, so a long stall does not fling the motes round their strands. */
      const dt = last ? Math.min(now - last, 100) : STEP_MS;
      last = now;
      draw(now, dt);
    };

    /* Paused by standby as well as by a hidden tab. Standby lays a full-screen
       blur over this, and a moving picture under a full-screen blur is the
       single most expensive thing the app can draw — on a screen that has been
       left alone, for as long as it is left. */
    let pausedAt = 0;
    let asleep = false;
    let held = false;
    const start = () => {
      if (raf || still || asleep || held || document.hidden) return;
      /* Picked up from where it left off rather than jumping ahead by however
         long it was stopped, so coming back does not snap the bundle into
         another shape. */
      if (pausedAt) {
        t0 += performance.now() - pausedAt;
        pausedAt = 0;
      }
      last = 0;
      raf = requestAnimationFrame(frame);
    };
    const stop = () => {
      if (!raf) return;
      cancelAnimationFrame(raf);
      raf = 0;
      pausedAt = performance.now();
    };

    const onMove = (e) => {
      aim.x = ((e.clientX / window.innerWidth) * 2 - 1) * MAX_PARALLAX;
      aim.y = ((e.clientY / window.innerHeight) * 2 - 1) * MAX_PARALLAX * 0.6;
    };
    const onVisibility = () => (document.hidden ? stop() : start());
    const onStandby = (e) => {
      asleep = Boolean(e.detail && e.detail.on);
      if (asleep) stop(); else start();
    };
    const onHold = (e) => {
      held = Boolean(e.detail && e.detail.on);
      if (held) stop(); else start();
    };
    const onResize = () => {
      resize();
      /* Resizing a canvas clears it. Running, the next frame repaints it;
         held still or paused, nothing would, so paint the held picture now. */
      if (!raf) draw(pausedAt || performance.now(), 0);
    };

    resize();
    if (still) {
      /* One frame, held. The bundle is a picture at rest, not an empty box. */
      at.x = 0; at.y = 0;
      draw(performance.now(), 0);
    } else {
      start();
    }

    window.addEventListener('resize', onResize, { passive: true });
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener(STANDBY_EVENT, onStandby);
    window.addEventListener(STREAK_HOLD_EVENT, onHold);
    if (!still) window.addEventListener('pointermove', onMove, { passive: true });

    return () => {
      stop();
      if (glr) glr.dispose();
      window.removeEventListener('resize', onResize);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener(STANDBY_EVENT, onStandby);
      window.removeEventListener(STREAK_HOLD_EVENT, onHold);
      window.removeEventListener('pointermove', onMove);
    };
  }, [accentId, backdropId]);

  /* Nothing behind the glass at all: no canvas, no context, no loop. */
  if (backdropById(backdropId).off) return null;

  return (
    <canvas
      ref={ref}
      className="streak"
      data-dense={DENSE.has(view) ? 'true' : 'false'}
      aria-hidden="true"
    />
  );
}
