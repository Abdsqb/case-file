/**
 * TopNav.jsx — the navigation, folded to one pill.
 *
 * At rest it is a single glass pill naming the screen you are on. Point at it
 * (or tab to it) and it opens downward into the full list, always in the same
 * order, with the current screen still under the pointer; pick one and it folds
 * back up around the new name. Leaving it folds it after a short grace period,
 * so brushing past does not make it flicker. Arrow keys move through the list
 * and Escape folds it; on touch, a tap on the pill opens it.
 *
 * It moves like the Dynamic Island, in the panels' dark glass: on springs
 * (island.js) that overshoot a little, stretching sideways before it drops and pulling up before it
 * narrows, with the rows coming into focus as it grows (motion.css, TOP).
 *
 * How the fold works: the list is always rendered whole, inside a pill that
 * clips it. Folded, the pill is one row tall and as wide as the current label,
 * and the list is slid up so the current row sits in that window. Open, the
 * pill grows to fit every row and the list slides back. Width, height and the
 * slide all transition together, so it reads as one shape growing.
 *
 * Below the screens, after a hairline, sit `actions`: today's to-do and the
 * notes pad. On a desktop they have Shift+T and Shift+N; on a phone there is
 * no Shift key, and this is how they are reached. They come after every
 * screen, so the fold's arithmetic (which row sits in the window) is untouched.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { CLOSE_DELAY, SPRINGS } from './island.js';

const ROW = 36;           // px, one row; the folded pill is exactly one
const PAD = 6;            // the list's inner padding while open
const FOLDED_X = 22;      // a folded label's side padding
const OPEN_X = 30;        // an open row's side padding: the island opens wide
const OPEN_MIN = 200;     // and never narrower than this
const SEP = 9;            // the hairline between the screens and the actions

export default function TopNav({ items, current, onGo, actions = [] }) {
  const navRef = useRef(null);
  const labelRefs = useRef({});
  const quiet = useRef(false);
  const closeTimer = useRef(0);
  const [open, setOpen] = useState(false);
  const [widths, setWidths] = useState(null);

  /* Label widths, measured once the faces are in: the pill's two sizes are
     made from them. */
  useLayoutEffect(() => {
    let alive = true;
    const measure = () => {
      if (!alive) return;
      const next = {};
      for (const { id } of [...items, ...actions]) {
        const el = labelRefs.current[id];
        next[id] = el ? Math.ceil(el.getBoundingClientRect().width) : 80;
      }
      setWidths(next);
    };
    measure();
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(measure);
    return () => { alive = false; };
  }, [items, actions]);

  useEffect(() => () => clearTimeout(closeTimer.current), []);

  const index = Math.max(0, items.findIndex((i) => i.id === current));
  const widest = widths ? Math.max(...Object.values(widths)) : 90;
  const here = widths ? widths[current] ?? widest : 90;
  const extra = actions.length ? SEP + actions.length * ROW : 0;
  const size = open
    ? { width: Math.max(OPEN_MIN, widest + OPEN_X * 2 + PAD * 2), height: items.length * ROW + extra + PAD * 2 }
    : { width: here + FOLDED_X * 2, height: ROW };
  const slide = open ? 0 : -(index * ROW);

  const focusCurrent = useCallback(() => {
    const el = navRef.current?.querySelector('[aria-current="page"]');
    if (!el) return;
    quiet.current = true;
    el.focus({ preventScroll: true });
    quiet.current = false;
  }, []);

  /* A new screen: if focus was in the list, it follows to the new current row
     (which is the only one left showing) without reopening the pill. */
  useEffect(() => {
    if (navRef.current?.contains(document.activeElement)) focusCurrent();
  }, [current, focusCurrent]);

  const pick = (id) => {
    if (!open) { setOpen(true); return; }    // a tap on the folded pill opens it
    setOpen(false);
    if (id !== current) onGo(id);
  };

  /* Focus is let go of first: the sheet it opens hands focus back to whatever
     had it when it closes, and landing back in here would quietly reopen the
     island behind it. */
  const act = (action) => {
    setOpen(false);
    if (navRef.current?.contains(document.activeElement)) document.activeElement.blur();
    action.run();
  };

  const onPointerEnter = (e) => {
    if (e.pointerType !== 'mouse') return;
    clearTimeout(closeTimer.current);
    setOpen(true);
  };
  const onPointerLeave = (e) => {
    if (e.pointerType !== 'mouse') return;
    clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => setOpen(false), CLOSE_DELAY);
  };
  /* Focus opens it for the keyboard. A tap focuses the button too (on Android
     and in most browsers), and the click right after it would then find the
     island already open and fold it straight back up — so focus that a press
     brought is left to the click to deal with. */
  const pressing = useRef(false);
  const onPointerDownCapture = () => { pressing.current = true; };
  const onClickCapture = () => { pressing.current = false; };
  const onFocus = () => {
    if (quiet.current || pressing.current) return;
    clearTimeout(closeTimer.current);
    setOpen(true);
  };
  const onBlur = (e) => {
    if (!navRef.current?.contains(e.relatedTarget)) setOpen(false);
  };
  const onKeyDown = (e) => {
    const rows = [...navRef.current.querySelectorAll('.pillnav__item')];
    const at = rows.indexOf(document.activeElement);
    if (e.key === 'Escape') {
      setOpen(false);
      focusCurrent();
      e.preventDefault();
    } else if (e.key === 'ArrowDown') {
      setOpen(true);
      rows[Math.min(rows.length - 1, at + 1)]?.focus();
      e.preventDefault();
    } else if (e.key === 'ArrowUp') {
      setOpen(true);
      rows[Math.max(0, at - 1)]?.focus();
      e.preventDefault();
    }
  };

  // A press anywhere else folds it: the touch path has no pointerleave.
  useEffect(() => {
    if (!open) return undefined;
    const away = (e) => { if (!navRef.current?.contains(e.target)) setOpen(false); };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [open]);

  return (
    <nav
      ref={navRef}
      className={`pillnav${open ? ' is-open' : ''}`}
      style={SPRINGS}
      aria-label="Sections"
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      onPointerDownCapture={onPointerDownCapture}
      onClickCapture={onClickCapture}
      onFocus={onFocus}
      onBlur={onBlur}
      onKeyDown={onKeyDown}
    >
      <div className="pillnav__pill" style={{ width: size.width, height: size.height }}>
        <ul className="pillnav__list" style={{ transform: `translateY(${slide}px)` }}>
          {items.map((item, i) => {
            const isCurrent = item.id === current;
            return (
              <li key={item.id}>
                <button
                  type="button"
                  className={`pillnav__item${isCurrent ? ' is-current' : ''}`}
                  aria-current={isCurrent ? 'page' : undefined}
                  tabIndex={open || isCurrent ? 0 : -1}
                  style={{ '--i': Math.abs(i - index) }}
                  onClick={() => pick(item.id)}
                >
                  <span className="pillnav__label" ref={(el) => { labelRefs.current[item.id] = el; }}>
                    {item.label}
                  </span>
                </button>
              </li>
            );
          })}
          {actions.length ? <li className="pillnav__sep" aria-hidden="true" /> : null}
          {actions.map((action, i) => (
            <li key={action.id}>
              <button
                type="button"
                className="pillnav__item pillnav__item--action"
                tabIndex={open ? 0 : -1}
                style={{ '--i': items.length - index + i }}
                onClick={() => act(action)}
                title={action.hint || undefined}
              >
                <span className="pillnav__label" ref={(el) => { labelRefs.current[action.id] = el; }}>
                  {action.label}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </nav>
  );
}
