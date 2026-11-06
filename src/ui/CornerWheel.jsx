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
 * pointer's id). Drawn like the big wheel (NavWheel): a frosted ring broken at
 * each section, the lit one in the accent, and a ring round the button with a
 * thicker run of it toward the choice.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { ICONS } from './NavWheel.jsx';
import { SPRINGS } from './island.js';
import './CornerWheel.css';

export const CORNER_WHEEL = 'casefile:corner-wheel';

/* In px, around the button's middle. Angles in degrees, 0 to the right and
   clockwise, as on screen: 180 is left, 270 is up. */
const R_IN = 92;
const R_OUT = 176;
const R_ICON = 134;
const HUB = 31;
const FROM = 180;
const TO = 270;
const GAP = 1.6;
const NEAR = 44;          // a finger this close to the button points at nothing
const LEAVE_MS = 260;

const pt = (r, deg) => {
  const a = (deg * Math.PI) / 180;
  return [R_OUT + r * Math.cos(a), R_OUT + r * Math.sin(a)];
};
const f = (n) => n.toFixed(2);
function sector(r1, r2, a0, a1) {
  const [x1, y1] = pt(r2, a0), [x2, y2] = pt(r2, a1), [x3, y3] = pt(r1, a1), [x4, y4] = pt(r1, a0);
  return `M${f(x1)} ${f(y1)}A${r2} ${r2} 0 0 1 ${f(x2)} ${f(y2)}L${f(x3)} ${f(y3)}A${r1} ${r1} 0 0 0 ${f(x4)} ${f(y4)}Z`;
}
function arc(r, a0, a1) {
  const [x1, y1] = pt(r, a0), [x2, y2] = pt(r, a1);
  return `M${f(x1)} ${f(y1)}A${r} ${r} 0 0 1 ${f(x2)} ${f(y2)}`;
}
const cx = (...c) => c.filter(Boolean).join(' ');

export default function CornerWheel({ items, current, onPick }) {
  const n = items.length;
  const step = (TO - FROM) / Math.max(1, n - 1);
  const angleOf = (i) => FROM + i * step;
  const span = (i) => [angleOf(i) - step / 2 + GAP / 2, angleOf(i) + step / 2 - GAP / 2];

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
      setAt(e.detail);
      requestAnimationFrame(() => requestAnimationFrame(() => setShown(true)));
    };
    window.addEventListener(CORNER_WHEEL, onHold);
    return () => { window.removeEventListener(CORNER_WHEEL, onHold); clearTimeout(leaving.current); };
  }, []);

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
      if (i >= 0 && items[i].id !== current) onPick(items[i]);
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
  const band = items.map((_, i) => sector(R_IN, R_OUT, ...span(i))).join('');
  const turn = hot < 0 ? 0 : angleOf(hot);

  return (
    <div className={cx('cornerwheel', shown && 'is-shown')} style={SPRINGS} aria-hidden="true">
      <div className="cornerwheel__ground" />
      <div
        className="cornerwheel__origin"
        style={{ left: at.x - R_OUT, top: at.y - R_OUT, width: size, height: size }}
      >
        <div className="cornerwheel__band" style={{ clipPath: `path('${band}')` }} />
        <svg className="cornerwheel__drawing" viewBox={`0 0 ${size} ${size}`}>
          {hot >= 0 ? <path className="cornerwheel__wedge" d={sector(R_IN, R_OUT, ...span(hot))} /> : null}
          <circle className="cornerwheel__hub" cx={R_OUT} cy={R_OUT} r={HUB} />
          {hot >= 0 ? <path className="cornerwheel__rim" d={arc(HUB, turn - 16, turn + 16)} /> : null}
        </svg>
        {items.map((it, i) => {
          const [x, y] = pt(R_ICON, angleOf(i));
          const Icon = ICONS[it.id];
          return (
            <div
              key={it.id}
              className={cx('cornerwheel__item', i === hot && 'is-hot', it.id === current && 'is-current')}
              style={{ left: x, top: y, '--i': i }}
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
