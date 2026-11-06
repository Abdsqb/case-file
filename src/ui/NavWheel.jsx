/**
 * NavWheel.jsx — the menu, as a wheel.
 *
 * The screens and the two things that open over the page (today's to-do,
 * the notes pad) sit in a ring around a small hub. Whatever direction the
 * pointer is in from the middle, anywhere on the screen, the section that
 * way is lit: one see-through wedge in the accent, with a thicker run of the
 * hub's rim on the same side, gliding round together to the next choice.
 * A click or tap anywhere off the hub opens the lit section; the hub itself
 * closes the wheel. On a touch screen a finger can also press, slide toward
 * a section and let go.
 *
 * Space is press-and-hold: holding it brings the wheel, pointing lights a
 * section, and letting go opens it. From the top pill it stays open until a
 * click; there keys work as well: the arrows go round, Enter opens, 1–7 jump,
 * Escape or a press of Space closes.
 *
 * The ground darkens first and the wheel arrives on it; leaving, the wheel
 * goes first and the ground lifts after (NavWheel.css).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { CalendarDays, ChartColumn, Folder, LayoutGrid, ListTodo, NotebookPen, SlidersHorizontal } from 'lucide-react';
import { SPRINGS } from './island.js';
import './NavWheel.css';

const ICONS = {
  dashboard: LayoutGrid,
  cases: Folder,
  reporting: ChartColumn,
  calendar: CalendarDays,
  settings: SlidersHorizontal,
  today: ListTodo,
  notes: NotebookPen,
};

/* The drawing, in its own units: a 380-unit square around the middle. */
const BOX = 380;
const C = BOX / 2;
const HUB = 30;              // the hub's ring
const W1 = 70, W2 = 125;     // the lit wedge's inner and outer edge
const IR = 97;               // where each section's icon and name sit
const RIM = 16;              // half the thick run of rim, in degrees
const GAP = 1.6;             // degrees between one section and the next
const LEAVE_MS = 320;        // the wheel out, then the ground (NavWheel.css)

const pt = (r, deg) => {
  const a = (deg * Math.PI) / 180;
  return [C + r * Math.cos(a), C + r * Math.sin(a)];
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

const still = () =>
  document.documentElement.dataset.motion === 'reduced'
  || window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* Space opens the wheel, but not from inside a field, from a control (where
   Space presses it), or from inside another dialog. */
const spaceIsTheirs = (t) =>
  !!t && (t.isContentEditable
    || /^(INPUT|TEXTAREA|SELECT|BUTTON|A|SUMMARY)$/.test(t.tagName)
    || !!t.closest?.('[role="dialog"], [role="menu"]'));

const cx = (...c) => c.filter(Boolean).join(' ');

export default function NavWheel({ items, current, open, onOpen, onClose, onPick }) {
  const N = items.length;
  const SEG = 360 / N;
  const rootRef = useRef(null);
  const discRef = useRef(null);
  const returnTo = useRef(null);
  const press = useRef(null);
  /* Space held since it opened the wheel: letting go opens what is lit.
     Kept in refs, read by a keyup listener that is always there, so even a
     release a few milliseconds after the press is caught. */
  const held = useRef(false);
  const hotRef = useRef(-1);
  const [mounted, setMounted] = useState(false);   // in the page at all
  const [shown, setShown] = useState(false);       // arrived (the transitions run between the two)
  const [hot, setHot] = useState(-1);
  const [turn, setTurn] = useState(0);
  const [instant, setInstant] = useState(false);   // no glide: the first frame points straight at here

  /* Point at section i. The wedge and the rim take the short way round. */
  const aim = useCallback((i) => {
    hotRef.current = i;
    setHot(i);
    setTurn((from) => {
      let to = i * SEG;
      to += Math.round((from - to) / 360) * 360;
      return to;
    });
  }, [SEG]);

  // Arriving and leaving.
  useEffect(() => {
    if (open) {
      returnTo.current = document.activeElement;
      const here = Math.max(0, items.findIndex((it) => it.id === current));
      setInstant(true);
      hotRef.current = here;
      setHot(here);
      setTurn(here * SEG);
      setMounted(true);
      /* One frame in the page at rest, so the transitions have a start;
         then shown. */
      const id = requestAnimationFrame(() => {
        rootRef.current?.getBoundingClientRect();
        setInstant(false);
        setShown(true);
        rootRef.current?.focus({ preventScroll: true });
      });
      return () => cancelAnimationFrame(id);
    }
    setShown(false);
    const t = setTimeout(() => setMounted(false), still() ? 0 : LEAVE_MS);
    const back = returnTo.current;
    if (back && back.isConnected && back !== document.body) back.focus?.({ preventScroll: true });
    return () => clearTimeout(t);
    // items/current/SEG are read once, as it opens
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Space, from anywhere that is not someone else's, opens it.
  useEffect(() => {
    if (open) return undefined;
    const onKey = (e) => {
      if (e.key !== ' ' || e.repeat || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      if (spaceIsTheirs(e.target)) return;
      e.preventDefault();
      held.current = true;
      onOpen();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onOpen]);

  const choose = useCallback((i) => {
    onClose();
    // Landing on the screen already open is just closing.
    if (i >= 0 && items[i].id !== current) onPick(items[i]);
  }, [items, current, onClose, onPick]);

  /* Hold Space, point, let go: the release opens what is lit. */
  useEffect(() => {
    const onUp = (e) => {
      if (e.key !== ' ' || !held.current) return;
      held.current = false;
      e.preventDefault();
      choose(hotRef.current);
    };
    window.addEventListener('keyup', onUp, true);
    return () => window.removeEventListener('keyup', onUp, true);
  }, [choose]);

  // Keys while it is open.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') { held.current = false; e.preventDefault(); e.stopPropagation(); onClose(); return; }
      if (e.key === ' ') {
        // Held down: the keyup decides. A fresh press, with the wheel opened from the pill: close.
        e.preventDefault(); e.stopPropagation();
        if (!e.repeat && !held.current) onClose();
        return;
      }
      const at = hot < 0 ? 0 : hot;
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); aim((at + 1) % N); }
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); aim((at - 1 + N) % N); }
      else if (e.key === 'Enter') { e.preventDefault(); choose(hot); }
      else if (/^[1-9]$/.test(e.key) && +e.key <= N) { e.preventDefault(); choose(+e.key - 1); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, hot, N, aim, choose, onClose]);

  /* Which section lies in the pointer's direction from the middle: anywhere
     on the screen counts, except over the hub. */
  const sectionAt = (x, y) => {
    const r = discRef.current?.getBoundingClientRect();
    if (!r) return -1;
    const k = r.width / BOX;
    const dx = x - (r.left + r.width / 2);
    const dy = y - (r.top + r.height / 2);
    if (Math.hypot(dx, dy) / k < HUB + 3) return -1;
    const deg = (Math.atan2(dy, dx) * 180) / Math.PI + 90;
    return ((Math.round(deg / SEG) % N) + N) % N;
  };

  const onPointerMove = (e) => {
    if (!open) return;
    const i = sectionAt(e.clientX, e.clientY);
    if (i >= 0 && i !== hot) aim(i);
  };
  const onPointerDown = (e) => {
    if (!open) return;
    const i = sectionAt(e.clientX, e.clientY);
    press.current = { i };
    if (i >= 0 && i !== hot) aim(i);
  };
  /* Opens on letting go, so a finger can press, slide to a section, and lift. */
  const onPointerUp = (e) => {
    if (!open || !press.current) return;
    const started = press.current.i;
    press.current = null;
    const i = sectionAt(e.clientX, e.clientY);
    if (i >= 0) choose(i);
    else if (started < 0) onClose();
  };

  if (!mounted) return null;

  const RimAt = arc(HUB, -90 - RIM, -90 + RIM);
  const spin = { transform: `rotate(${turn}deg)`, opacity: hot < 0 ? 0 : 1 };

  return (
    <div
      ref={rootRef}
      className={cx('navwheel', shown && 'is-shown', instant && 'is-instant', still() && 'is-still')}
      role="dialog"
      aria-modal="true"
      aria-label="Menu"
      tabIndex={-1}
      style={SPRINGS}
      onPointerMove={onPointerMove}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
    >
      <div className="navwheel__ground" />
      <div className="navwheel__disc" ref={discRef}>
        <div className="navwheel__band" aria-hidden="true" style={{ '--seg': `${SEG}deg`, '--gap': `${GAP}deg` }} />
        <svg className="navwheel__drawing" viewBox={`0 0 ${BOX} ${BOX}`} aria-hidden="true">
          <defs>
            <filter id="navwheel-halo" x="-100%" y="-100%" width="300%" height="300%">
              <feGaussianBlur stdDeviation="4.5" />
            </filter>
          </defs>
          <g className="navwheel__mover" style={spin}>
            <path className="navwheel__wedge" d={sector(W1, W2, -90 - SEG / 2 + GAP / 2, -90 + SEG / 2 - GAP / 2)} />
          </g>
          <circle className="navwheel__halo" cx={C} cy={C} r={HUB + 3} filter="url(#navwheel-halo)" />
          <circle className="navwheel__hub" cx={C} cy={C} r={HUB} />
          <g className="navwheel__mover" style={spin}>
            <path className="navwheel__rim" d={RimAt} />
          </g>
        </svg>
        <ul className="navwheel__items" role="menu" aria-label="Sections">
          {items.map((it, i) => {
            const [x, y] = pt(IR, -90 + i * SEG);
            const Icon = ICONS[it.id];
            // Where it comes out from: 24px back toward the middle.
            const a = ((-90 + i * SEG) * Math.PI) / 180;
            const from = { '--i': i, '--dx': `${f(-Math.cos(a) * 24)}px`, '--dy': `${f(-Math.sin(a) * 24)}px` };
            return (
              <li key={it.id} style={{ left: `${(x / BOX) * 100}%`, top: `${(y / BOX) * 100}%` }}>
                <button
                  type="button"
                  role="menuitem"
                  className={cx('navwheel__item', i === hot && 'is-hot', it.id === current && 'is-current')}
                  aria-current={it.id === current ? 'page' : undefined}
                  title={it.hint || undefined}
                  style={from}
                  onFocus={() => { if (i !== hot) aim(i); }}
                  // A pointer opens on letting go (above); this is Enter and Space on a focused row.
                  onClick={(e) => { if (e.detail === 0) choose(i); }}
                >
                  {Icon ? <Icon aria-hidden="true" strokeWidth={1.6} /> : null}
                  <span>{it.label}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
