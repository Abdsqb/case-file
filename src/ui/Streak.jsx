/**
 * Streak.jsx — the background behind the app.
 *
 * Mounts whichever backdrop Settings has chosen (ui/backdrops.js): Undertow's
 * sea of slats (MicroSlats, WebGL2) or Glass Current's shards (AeroShards,
 * WebGPU). Each is loaded only when picked, kept mounted across screens, and
 * replays its own intro on a visit to the dashboard. Neither takes the
 * pointer; both are held still while standby or the full-window board is up.
 *
 * The layer carries the Diffusion blur from Settings, and dims on screens
 * that are mostly content (data-dense, styles.css).
 */

import { lazy, Suspense, useEffect, useState } from 'react';
import { STANDBY_EVENT } from './Standby.jsx';
import { usePhoneWidth } from './island.js';
import { backdropById, readColours } from './backdrops.js';
import {
  KEY_ACCENT,
  KEY_BACKDROP,
  KEY_BACKDROP_BLUR,
  KEY_SLAT_SHADE,
  readBackdrop,
  readBackdropBlur,
  readSlatShade,
  useSetting,
} from '../lib/settings.js';

/* Loaded only when picked: AeroShards brings WebGPU, and Undertow needs none
   of it. */
const AeroShards = lazy(() => import('./AeroShards.jsx'));
const MicroSlats = lazy(() => import('./MicroSlats.jsx'));

const hex = (c) => `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`;

/* Anything that lays a blur over the whole window can hold the background
   still while it is up — the board opened full window does. Its own event
   rather than standby's, so standby waking underneath cannot restart it. */
export const STREAK_HOLD_EVENT = 'casefile:streak-hold';

/* Screens that are mostly content. The background stays, at a fraction of
   its weight, because a wall of rows over it is hard to read. */
const DENSE = new Set(['reporting', 'settings', 'cases']);

export default function Streak({ view }) {
  /* Read here so a change re-renders: the accent colours the shards, the
     rest pick the backdrop, its blur and Undertow's shade. */
  useSetting(KEY_ACCENT, '');
  useSetting(KEY_BACKDROP, '');
  useSetting(KEY_BACKDROP_BLUR, '');
  useSetting(KEY_SLAT_SHADE, '');
  /* Set on the layer itself, never as a custom property on <html>: a
     property up there restyles the whole document when it changes. */
  const blurPx = readBackdropBlur();
  const diffusion = { filter: blurPx ? `blur(${blurPx}px)` : 'none' };
  const shade = readSlatShade();
  /* Undertow forms from the top down on a phone; a desktop's is just there. */
  const phone = usePhoneWidth();

  /* Glass Current needs WebGPU; where it cannot start, Undertow stands in
     rather than leaving the room dark. */
  const chosenId = readBackdrop();
  const [failed, setFailed] = useState(null);
  const backdrop = backdropById(failed === chosenId ? 'slats' : chosenId);

  /* Counts dashboard visits: each backdrop takes it as `replay` and plays
     its intro again on the context it already has. */
  const [visit, setVisit] = useState(0);
  /* Standby or the full-window board is up: hold it still. */
  const [resting, setResting] = useState(false);

  useEffect(() => {
    if (view !== 'dashboard') return;
    setVisit((v) => v + 1);
  }, [view]);

  useEffect(() => {
    let asleep = false;
    let held = false;
    const sync = () => setResting(asleep || held);
    const onStandby = (e) => {
      const was = asleep;
      asleep = Boolean(e.detail && e.detail.on);
      /* Coming back from the idle screen is an arrival too. */
      if (was && !asleep) setVisit((v) => v + 1);
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

  return (
    <div className="streak" style={diffusion} data-dense={DENSE.has(view) ? 'true' : 'false'} aria-hidden="true">
      <Suspense fallback={null}>
        {backdrop.component === 'shards' ? (
          /* Tuned down from the React Bits example for running behind a
             whole app all day. The heaviest thing it does is ray-trace every
             shard pixel through five depth layers, so: drawn at 75% of a CSS
             pixel (the diffusion hides the difference), 30 frames a second,
             900 shards rather than 1300, lighter depth of field and no bloom
             (both were per-frame blur passes the diffusion already does the
             job of). Mounted once and kept: a dashboard visit replays its
             intro instead of rebuilding WebGPU and recompiling every
             pipeline, and a new accent is just a new prop. */
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
              console.warn('Glass Current could not start, falling back to Undertow', err);
              setFailed('shards');
            }}
          />
        ) : (
          <MicroSlats
            key="slats"
            replay={visit}
            preset="swell"
            color={shade.color}
            glintColor={shade.glint}
            backgroundColor="transparent"
            slatWidth={6}
            slatHeight={18}
            gap={6}
            roundness={1}
            interactive={false}
            swirl={0}
            trail={0.6}
            lean={0}
            intro={phone}
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
