/**
 * CornerWheel.jsx — the screens, fanned out of the to-do button on a phone.
 *
 * A tap on the to-do button opens today's list. Held, it opens this instead:
 * a quarter of the menu wheel, swung up and to the left from the button, with
 * the screens along its arc. The finger stays down; sliding it toward one
 * lights that section, and lifting it opens that screen. Lifting it over the
 * button again, without having gone anywhere, lets it go.
 *
 * It is driven entirely by the finger that held the button, which TodayWindow
 * hands over in the CORNER_WHEEL event (where the button's middle is, and the
 * pointer's id). Plainer than the big wheel: the screens' icons in grey along
 * the arc, the one pointed at in white with its name, and a ring round the
 * button with a thicker run of it toward the choice.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ICONS } from './NavWheel.jsx';
import { SPRINGS } from './island.js';
import './CornerWheel.css';

export const CORNER_WHEEL = 'casefile:corner-wheel';

/* In px, around the button's middle. Angles in degrees, 0 to the right and
   clockwise, as on screen: 180 is left, 270 is up. */
const R_OUT = 250;
const R_ICON = 215;       // well off the corner, and room between the icons
const HUB = 31;
const FROM = 180;
const TO = 270;
const NEAR = 56;          // a finger this close to the button points at nothing
const LEAVE_MS = 300;
const PICK_AFTER_MS = 200; // the wheel folds away before the new screen starts

const pt = (r, deg) => {
  const a = (deg * Math.PI) / 180;
  return [R_OUT + r * Math.cos(a), R_OUT + r * Math.sin(a)];
};
const f = (n) => n.toFixed(2);
function arc(r, a0, a1) {
  const [x1, y1] = pt(r, a0), [x2, y2] = pt(r, a1);
  return `M${f(x1)} ${f(y1)}A${r} ${r} 0 0 1 ${f(x2)} ${f(y2)}`;
}
const cx = (...c) => c.filter(Boolean).join(' ');

export default function CornerWheel({ items, current, onPick }) {
  const n = items.length;
  const step = (TO - FROM) / Math.max(1, n - 1);
  const angleOf = (i) => FROM + i * step;

  const [at, setAt] = useState(null);       // { x, y, pointerId } while it is up
  const [shown, setShown] = useState(false);
  const [hot, setHot] = useState(-1);
  const leaving = useRef(0);

  const close = useCallback(() => {
    setShown(false);
    clearTimeout(leaving.current);
    leaving.current = setTimeout(() => setAt(null), LEAVE_MS);
  }, []);

  // The button was held: come up around it.
  useEffect(() => {
    const onHold = (e) => {
      clearTimeout(leaving.current);
      setHot(-1);
      setShown(false);
      setAt(e.detail);
    };
    window.addEventListener(CORNER_WHEEL, onHold);
    return () => { window.removeEventListener(CORNER_WHEEL, onHold); clearTimeout(leaving.current); };
  }, []);

  /* Unfold only once the folded state is really there. Flipping to shown on
     the next frame from the event alone sometimes landed in the same render
     as the mount, so there was no folded state to move from and it popped
     up. Here the folded wheel is in the page and laid out (the read forces
     its styles) before the class that unfolds it goes on. */
  const rootRef = useRef(null);
  useLayoutEffect(() => {
    if (!at) return undefined;
    rootRef.current?.getBoundingClientRect();
    const id = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(id);
  }, [at]);

  // Follow the finger that held it; lifting it decides.
  useEffect(() => {
    if (!at) return undefined;
    const which = (x, y) => {
      const dx = x - at.x, dy = y - at.y;
      if (Math.hypot(dx, dy) < NEAR) return -1;
      let a = (Math.atan2(dy, dx) * 180) / Math.PI;
      if (a < 90) a += 360;                    // right and down count as past the ends
      return Math.max(0, Math.min(n - 1, Math.round((a - FROM) / step)));
    };
    const mine = (e) => e.pointerId === at.pointerId;
    const onMove = (e) => { if (mine(e)) setHot(which(e.clientX, e.clientY)); };
    const onUp = (e) => {
      if (!mine(e)) return;
      const i = which(e.clientX, e.clientY);
      close();
      /* The screen change is heavy enough to swallow the fold if it starts on
         the same frame, so it waits for the wheel to have gone. */
      if (i >= 0 && items[i].id !== current) setTimeout(() => onPick(items[i]), PICK_AFTER_MS);
    };
    const onCancel = (e) => { if (mine(e)) close(); };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
    };
  }, [at, n, step, items, current, onPick, close]);

  if (!at) return null;

  const size = R_OUT * 2;
  const turn = hot < 0 ? 0 : angleOf(hot);

  return (
    <div ref={rootRef} className={cx('cornerwheel', shown && 'is-shown')} style={SPRINGS} aria-hidden="true">
      <div className="cornerwheel__ground" />
      <div
        className="cornerwheel__origin"
        style={{ left: at.x - R_OUT, top: at.y - R_OUT, width: size, height: size }}
      >
        <svg className="cornerwheel__drawing" viewBox={`0 0 ${size} ${size}`}>
          <circle className="cornerwheel__hub" cx={R_OUT} cy={R_OUT} r={HUB} />
          {hot >= 0 ? <path className="cornerwheel__rim" d={arc(HUB, turn - 16, turn + 16)} /> : null}
        </svg>
        {items.map((it, i) => {
          const [x, y] = pt(R_ICON, angleOf(i));
          const Icon = ICONS[it.id];
          // Where it comes out from: most of the way back to the button.
          const from = { '--dx': `${f((R_OUT - x) * 0.7)}px`, '--dy': `${f((R_OUT - y) * 0.7)}px` };
          return (
            <div
              key={it.id}
              className={cx('cornerwheel__item', i === hot && 'is-hot', it.id === current && 'is-current')}
              style={{ left: x, top: y, '--i': i, ...from }}
            >
              {Icon ? <Icon strokeWidth={1.6} /> : null}
              <span>{it.label}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
