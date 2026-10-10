/**
 * Standby.jsx — the screen the app falls into when it is left alone.
 *
 * After a minute with no click, key, scroll or pointer movement, everything
 * behind goes soft and a clock takes the middle of the screen. Any click or key
 * brings it back. Nothing is unmounted and nothing is saved or discarded on the
 * way in or out — standby is a sheet laid over the app, not a state the app
 * enters, so whatever was half-typed or half-scrolled is exactly where it was.
 */

import { useEffect, useRef, useState } from 'react';

/* Announced on the window when standby goes on or off, as { detail: { on } }.
   The streak behind the app listens for it and holds still while the sheet is
   up: a moving picture under a full-screen blur is the costliest thing the app
   can draw, and nobody is looking at it. */
export const STANDBY_EVENT = 'casefile:standby';

/* How long the app has to be left alone. */
const IDLE_MS = 60_000;

/* Everything that counts as being here. Pointer movement keeps the app awake —
   reading with a hand on the mouse is still using it — but it deliberately does
   not WAKE it: a desk knock should not dismiss the clock, and a click should. */
const ACTIVITY = ['pointerdown', 'pointerup', 'pointermove', 'keydown', 'wheel', 'touchstart', 'scroll'];
const WAKE = new Set(['pointerdown', 'keydown', 'wheel', 'touchstart']);

/* Whatever this machine calls a time. formatToParts rather than a formatted
   string because the parts are laid out separately — the colon blinks, the
   seconds are smaller — and because it keeps 24-hour locales 24-hour instead of
   this deciding on their behalf. */
const TIME = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const DATE = new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long' });

function readClock(ms) {
  const d = new Date(ms);
  const part = {};
  for (const p of TIME.formatToParts(d)) part[p.type] = p.value;
  return {
    hour: part.hour || '',
    minute: part.minute || '',
    period: (part.dayPeriod || '').trim(),
    date: DATE.format(d),
  };
}

export default function Standby() {
  const [asleep, setAsleep] = useState(false);
  const [clock, setClock] = useState(() => readClock(Date.now()));

  const lastRef = useRef(Date.now());
  /* The listeners are attached once and live for the life of the app, so they
     read the current value out of a ref rather than closing over a stale one. */
  const asleepRef = useRef(false);
  asleepRef.current = asleep;

  useEffect(() => {
    const touch = (e) => {
      lastRef.current = Date.now();
      if (asleepRef.current && WAKE.has(e.type)) setAsleep(false);
    };
    /* Capture, so a handler that stops propagation on its own subtree cannot
       quietly make part of the app look idle while it is being used. Passive,
       so none of this can hold up a scroll. */
    const opts = { capture: true, passive: true };
    for (const type of ACTIVITY) window.addEventListener(type, touch, opts);

    /* A hidden tab is not an idle one — coming back to the window is being
       here, and the count starts again from the moment it is looked at. */
    const onVisible = () => { if (!document.hidden) lastRef.current = Date.now(); };
    document.addEventListener('visibilitychange', onVisible);

    const watch = setInterval(() => {
      if (asleepRef.current) return;
      if (Date.now() - lastRef.current >= IDLE_MS) {
        setClock(readClock(Date.now()));
        setAsleep(true);
      }
    }, 1000);

    return () => {
      for (const type of ACTIVITY) window.removeEventListener(type, touch, opts);
      document.removeEventListener('visibilitychange', onVisible);
      clearInterval(watch);
    };
  }, []);

  useEffect(() => {
    window.dispatchEvent(new CustomEvent(STANDBY_EVENT, { detail: { on: asleep } }));
  }, [asleep]);

  /* No seconds on the face, so this wakes on the minute rather than every
     second — the screen a machine is left sitting on should not be re-rendering
     sixty times a minute to display the same two digits.

     Re-aimed at the next whole minute each time rather than set on an interval,
     so the display changes when the minute changes instead of drifting further
     off it with every pass. */
  useEffect(() => {
    if (!asleep) return undefined;
    let id = 0;
    const tick = () => {
      const now = Date.now();
      setClock(readClock(now));
      id = setTimeout(tick, 60_000 - (now % 60_000));
    };
    id = setTimeout(tick, 60_000 - (Date.now() % 60_000));
    return () => clearTimeout(id);
  }, [asleep]);

  /* Always mounted, so it can fade out as well as in — and hidden rather than
     merely transparent when it is off, because a transparent backdrop-filter
     is still a full-screen blur the compositor has to keep honouring. The
     clock holds its last reading through the fade instead of blanking.

     aria-hidden: the blur is a picture of inattention, not a change to what the
     app contains. Nothing here is unreachable underneath — the first key press
     dismisses it and lands where it was going. */
  return (
    <div className={`standby${asleep ? ' is-on' : ''}`} aria-hidden="true">
      <div className="standby__clock">
        <div className="standby__time">
          <span className="standby__h">{clock.hour}</span>
          <span className="standby__colon">:</span>
          <span className="standby__m">{clock.minute}</span>
          {/* Seconds were on here and came off: beside the minutes they read as
              part of the time — "4:43 14 PM" — and a clock you glance at from
              across the room has no use for them anyway. On a 24-hour locale
              there is no dayPeriod and the tail is simply absent. */}
          {clock.period ? <span className="standby__tail">{clock.period}</span> : null}
        </div>
        <div className="standby__date">{clock.date}</div>
      </div>
      <div className="standby__hint">standby · click to resume</div>
    </div>
  );
}
