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

import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { STANDBY_EVENT } from './Standby.jsx';

/* The backdrops drawn by their own components, loaded only when picked:
   AeroShards brings WebGPU, and most visits need none of them. */
const AeroShards = lazy(() => import('./AeroShards.jsx'));
const ObjectCurrent = lazy(() => import('./ObjectCurrent.jsx'));
const MicroSlats = lazy(() => import('./MicroSlats.jsx'));

const hex = (c) => `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`;

/* Anything that lays a blur over the whole window can hold the streak still
   while it is up — the board opened full window does. Its own event rather
   than standby's, so standby waking underneath cannot restart it. */
export const STREAK_HOLD_EVENT = 'casefile:streak-hold';
import { createStreakGL } from './streakGL.js';
import { backdropById, buildStrands, DEFAULT_BACKDROP, LAMP_STOPS, readColours } from './backdrops.js';
import {
  KEY_ACCENT,
  KEY_BACKDROP,
  KEY_BACKDROP_BLUR,
  readAccent,
  readBackdrop,
  readBackdropBlur,
  useSetting,
} from '../lib/settings.js';

/* Screens that are mostly content. The streak stays, at a fraction of its
   weight, because a wall of rows over a bright strand is hard to read. */
const DENSE = new Set(['reporting', 'settings', 'cases']);

const PARTICLES = 16;

/* How long one full undulation takes, give or take — the strands are on
   several frequencies, so the bundle never quite repeats. Slow: it should
   read as a current you notice, not motion that pulls at the eye. */
const CYCLE_MS = 15000;

/* The arrival: how long the light takes to pour in along its course when the
   dashboard opens (or the backdrop changes). */
const ARRIVAL_MS = 3800;

/* Slow in, slow out — the front gathers, runs, and settles. */
const easeInOut = (t) => 0.5 - 0.5 * Math.cos(Math.PI * t);

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
  useSetting(KEY_BACKDROP_BLUR, '');
  /* Set on the layer itself, never as a custom property on <html>: a
     property up there restyles the whole document when it changes. */
  const blurPx = readBackdropBlur();
  const diffusion = { filter: blurPx ? `blur(${blurPx}px)` : 'none' };
  const accentId = readAccent();
  const chosenId = readBackdrop();
  /* A component backdrop that cannot start (no WebGPU on this machine, say)
     falls back to the default rather than leaving the room dark. */
  const [failed, setFailed] = useState(null);
  const backdropId = failed === chosenId ? DEFAULT_BACKDROP : chosenId;
  /* Counts dashboard visits: each component backdrop takes it as `replay`
     and plays its own intro again, the way the strands pour in, on the
     context it already has. */
  const [visit, setVisit] = useState(0);
  /* Standby or the full-window board is up: hold the component still. */
  const [resting, setResting] = useState(false);
  /* When the light last started to arrive. Read by the running loop each
     frame, so restarting it is just writing a new time here. */
  const arrival = useRef(0);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return undefined;
    const backdrop = backdropById(backdropId);
    /* Lights Out: nothing to draw and nothing to run. A component backdrop
       runs itself. */
    if (backdrop.off || backdrop.component) return undefined;
    /* A new look arrives the same way the dashboard does. */
    arrival.current = performance.now();

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
      for (let i = 0; i < (small ? 8 : PARTICLES); i += 1) {
        particles.push({
          strand: Math.floor((i / PARTICLES) * strands.length),
          p: Math.random(),
          speed: 0.008 + Math.random() * 0.016,
          size: 0.7 + Math.random() * 0.8,
          twinkle: Math.random() * Math.PI * 2,
        });
      }
    };

    /* Capped at 2: past that the extra pixels are invisible and the fill
       rate is not. Under any diffusion the blur is already wider than a device
       pixel, so one canvas pixel per CSS pixel looks the same and, on a 2x
       screen, fills a quarter of the pixels. */
    const pixelRatio = () => Math.min(window.devicePixelRatio || 1, readBackdropBlur() > 0 ? 1 : 2);

    const resize = () => {
      dpr = pixelRatio();
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

      /* How far through the arrival: held at the whole picture when motion
         is reduced, since there is no animation to arrive by. */
      const reveal = still ? 1 : easeInOut(Math.min(1, Math.max(0, (now - arrival.current) / ARRIVAL_MS)));

      /* A few motes carried along the strands. They are what tells you the
         picture is alive when the undulation is at its slowest. */
      motes.length = 0;
      for (const p of particles) {
        const i = p.strand % strands.length;
        if (!strands[i]) continue;
        p.p += p.speed * (dt / 1000);
        if (p.p > 1) p.p -= 1;
        const [x, y] = along(curves[i], p.p);
        /* Brightest near the focus, like everything else here, each one
           slowly brightening and dimming on its own beat, and only once the
           light has arrived. */
        const lit = Math.max(0, 1 - Math.hypot(x - fx, y - fy) / (R * 0.4));
        const glint = 0.75 + 0.25 * Math.sin(now * 0.0011 + p.twinkle);
        motes.push({ x, y, r: p.size, a: (0.06 + lit * 0.3) * glint * reveal * reveal });
      }

      if (glr) glr.paint({ W, H, dpr, fx, fy, R, bloomR, strands, curves, motes, time: (now - t0) / 1000, reveal });
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
    // Diffusion turned on or off changes the resolution worth drawing at.
    const onSettings = () => { if (pixelRatio() !== dpr) onResize(); };

    resize();
    if (still) {
      /* One frame, held. The bundle is a picture at rest, not an empty box. */
      at.x = 0; at.y = 0;
      draw(performance.now(), 0);
    } else {
      start();
    }

    window.addEventListener('resize', onResize, { passive: true });
    window.addEventListener('casefile:settings', onSettings);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener(STANDBY_EVENT, onStandby);
    window.addEventListener(STREAK_HOLD_EVENT, onHold);
    if (!still) window.addEventListener('pointermove', onMove, { passive: true });

    return () => {
      stop();
      if (glr) glr.dispose();
      window.removeEventListener('resize', onResize);
      window.removeEventListener('casefile:settings', onSettings);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener(STANDBY_EVENT, onStandby);
      window.removeEventListener(STREAK_HOLD_EVENT, onHold);
      window.removeEventListener('pointermove', onMove);
    };
  }, [accentId, backdropId]);

  /* Every visit to the dashboard, the light pours in again. */
  useEffect(() => {
    if (view !== 'dashboard') return;
    arrival.current = performance.now();
    setVisit((v) => v + 1);
  }, [view]);

  useEffect(() => {
    let asleep = false;
    let held = false;
    const sync = () => setResting(asleep || held);
    const onStandby = (e) => {
      const was = asleep;
      asleep = Boolean(e.detail && e.detail.on);
      /* Coming back from the idle screen is an arrival too: the light pours
         in again, and the component backdrops replay their intro. */
      if (was && !asleep) {
        arrival.current = performance.now();
        setVisit((v) => v + 1);
      }
      sync();
    };
    const onHold = (e) => { held = Boolean(e.detail && e.detail.on); sync(); };
    window.addEventListener(STANDBY_EVENT, onStandby);
    window.addEventListener(STREAK_HOLD_EVENT, onHold);
    return () => {
      window.removeEventListener(STANDBY_EVENT, onStandby);
      window.removeEventListener(STREAK_HOLD_EVENT, onHold);
    };
  }, []);

  const backdrop = backdropById(backdropId);
  /* Nothing behind the glass at all: no canvas, no context, no loop. */
  if (backdrop.off) return null;

  if (backdrop.component) {
    return (
      <div className="streak" style={diffusion} data-dense={DENSE.has(view) ? 'true' : 'false'} aria-hidden="true">
        <Suspense fallback={null}>
          {backdrop.component === 'shards' ? (
            /* Tuned down from the React Bits example for running behind a
               whole app all day. The heaviest thing it does is ray-trace every
               shard pixel through five depth layers, so: drawn at 75% of a CSS
               pixel (the diffusion above hides the difference), 30 frames a
               second like the strands, 900 shards rather than 1300, lighter
               depth of field and no bloom (both were per-frame blur passes the
               diffusion already does the job of). Mounted once and kept: a
               dashboard visit replays its intro instead of rebuilding WebGPU
               and recompiling every pipeline, and a new accent is just a new
               prop. It keeps flowing on every screen, like the strands. */
            <AeroShards
              key="shards"
              replay={visit}
              shardColor={hex(readColours().main)}
              accentColor="#000000"
              placement="full"
              material="glass"
              markers="plus"
              count={900}
              depthOfField={0.4}
              glow={0}
              vignette={0.3}
              dpr={0.75}
              maxFps={30}
              mouseInteraction
              pulseOnClick
              holdToGather
              mouseStrength={0.86}
              paused={resting}
              onError={(err) => {
                console.warn('Glass Current could not start, falling back to Silk Fold', err);
                setFailed('shards');
              }}
            />
          ) : backdrop.component === 'needles' || backdrop.component === 'obsidian' ? (
            /* Kept across dashboard visits like the glass: a visit replays the
               intro. Keyed by kind, so switching between the two arrives fresh. */
            <ObjectCurrent
              key={backdrop.component}
              kind={backdrop.component}
              replay={visit}
              accent={readColours().main}
              dpr={blurPx > 0 ? 1 : 1.5}
              paused={resting}
              onError={(err) => {
                console.warn(`${backdrop.name} could not start, falling back to Silk Fold`, err);
                setFailed(backdrop.id);
              }}
            />
          ) : (
            <MicroSlats
              key="slats"
              replay={visit}
              preset="swell"
              color="#59545e"
              glintColor="#4f4f4f"
              backgroundColor="transparent"
              slatWidth={2}
              slatHeight={6}
              gap={3}
              roundness={1}
              interactive
              cursorStrength={1}
              cursorSize={40}
              swirl={0}
              trail={0.6}
              lean={0}
              intro
              speed={0.8}
              maxFps={30}
              direction={278}
              chop={0.4}
              glint={0.3}
              perspective={0.15}
              fog={0}
              paused={resting}
            />
          )}
        </Suspense>
      </div>
    );
  }

  return (
    <canvas
      ref={ref}
      className="streak"
      style={diffusion}
      data-dense={DENSE.has(view) ? 'true' : 'false'}
      aria-hidden="true"
    />
  );
}
