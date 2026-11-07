/**
 * TopNav.jsx — the navigation's pill.
 *
 * A single glass pill naming the screen you are on. A click or tap on it, or
 * Enter on it, opens the menu wheel (NavWheel.jsx); holding Alt opens it from
 * anywhere. It no longer opens on hover: a wheel that covers the screen must
 * not burst open as the pointer crosses the top of it.
 *
 * It is drawn the way it always was, as the folded island: every screen's
 * name in a list inside a pill that clips it, slid so the current one sits in
 * the window, and the pill as wide as that name. A new screen slides the list
 * and resizes the pill on the island's springs (island.js, motion.css).
 */

import { useLayoutEffect, useRef, useState } from 'react';
import { SPRINGS } from './island.js';

const ROW = 36;           // px, one row; the pill is exactly one
const FOLDED_X = 22;      // the label's side padding

export default function TopNav({ items, current, open = false, onOpen }) {
  const labelRefs = useRef({});
  const [widths, setWidths] = useState(null);

  /* Label widths, measured once the faces are in: the pill is made from them. */
  useLayoutEffect(() => {
    let alive = true;
    const measure = () => {
      if (!alive) return;
      const next = {};
      for (const { id } of items) {
        const el = labelRefs.current[id];
        next[id] = el ? Math.ceil(el.getBoundingClientRect().width) : 80;
      }
      setWidths(next);
    };
    measure();
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(measure);
    return () => { alive = false; };
  }, [items]);

  const index = Math.max(0, items.findIndex((i) => i.id === current));
  const here = widths ? widths[current] ?? 90 : 90;

  return (
    <nav className="pillnav" style={SPRINGS} aria-label="Sections">
      <div className="pillnav__pill" style={{ width: here + FOLDED_X * 2, height: ROW }}>
        <ul className="pillnav__list" style={{ transform: `translateY(${-(index * ROW)}px)` }}>
          {items.map((item) => {
            const isCurrent = item.id === current;
            return (
              <li key={item.id}>
                <button
                  type="button"
                  className={`pillnav__item${isCurrent ? ' is-current' : ''}`}
                  aria-current={isCurrent ? 'page' : undefined}
                  aria-haspopup={isCurrent ? 'dialog' : undefined}
                  aria-expanded={isCurrent ? open : undefined}
                  aria-label={isCurrent ? `${item.label}. Open the menu` : undefined}
                  tabIndex={isCurrent ? 0 : -1}
                  onClick={onOpen}
                >
                  <span className="pillnav__label" ref={(el) => { labelRefs.current[item.id] = el; }}>
                    {item.label}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </nav>
  );
}
