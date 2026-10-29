/**
 * island.js — what the Dynamic-Island controls share: the spring curves, and
 * the open/fold behaviour.
 *
 * Used by the top navigation (TopNav.jsx), the folder switcher and the case
 * tabs (CaseIslands.jsx). The look is in motion.css under ISLANDS.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

/* A damped spring, sampled into a CSS linear() easing. `bounce` is how far
   past the target it swings (0 = none); the spring is scaled to settle by the
   end of whatever duration the CSS gives it. */
export function springEasing(bounce, samples = 40) {
  const zeta = 1 - bounce;                                  // damping ratio
  const omega = 6.9 / zeta;                                 // settles to 0.1% at t = 1
  const wd = omega * Math.sqrt(1 - zeta * zeta);
  const points = [];
  for (let i = 0; i <= samples; i += 1) {
    const t = i / samples;
    const decay = Math.exp(-zeta * omega * t);
    const x = 1 - decay * (Math.cos(wd * t) + ((zeta * omega) / wd) * Math.sin(wd * t));
    points.push(i === samples ? 1 : Number(x.toFixed(4)));
  }
  return `linear(${points.join(', ')})`;
}

/* The two springs as custom properties, for a style prop. Empty where the
   engine has no linear(), and the CSS falls back to a cubic-bezier. */
export const SPRINGS = (() => {
  const open = springEasing(0.32);    // about 5% overshoot
  const close = springEasing(0.12);   // barely any
  const ok = typeof CSS !== 'undefined' && CSS.supports?.('transition-timing-function', open);
  return ok ? { '--pn-open': open, '--pn-close': close } : {};
})();

export const CLOSE_DELAY = 180;  // grace before folding when the pointer leaves

/**
 * Open while the pointer is over it or focus is in it; fold on leaving (after
 * a short grace), on Escape, or on a press anywhere else. While a menu inside
 * it is open (anything with aria-expanded="true"), it stays open, so a popover
 * anchored to one of its rows does not lose its anchor; it folds once that menu
 * closes with the pointer gone. `keepOpen`, if given, is one more reason to
 * stay open (a tab being dragged), checked the same way.
 *
 * Returns { open, setOpen, handlers, quiet } — spread `handlers` on the root,
 * and set quiet.current while moving focus inside it programmatically so that
 * focus does not reopen it.
 */
export function useIsland(rootRef, { keepOpen } = {}) {
  const [open, setOpen] = useState(false);
  const closeTimer = useRef(0);
  const quiet = useRef(false);
  const menuClosedAt = useRef(-Infinity);

  const menuOpen = () => !!rootRef.current?.querySelector('[aria-expanded="true"]') || !!keepOpen?.();
  /* Whether the pointer is over it, asked of the DOM rather than tracked from
     enter and leave: a menu vanishing from under the pointer reports no leave,
     and React counts its portalled popover as inside. */
  const hovered = () => !!rootRef.current?.matches(':hover');
  const fold = useCallback(() => {
    clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => {
      if (!menuOpen() && !hovered()) setOpen(false);
    }, CLOSE_DELAY);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => () => clearTimeout(closeTimer.current), []);

  /* A menu closing (or a drag ending) after the pointer has left is the cue to
     fold, even though the menu hands focus back to its button inside: that is
     the end of a mouse visit, not the start of a keyboard one. Only the change
     from held to not held counts, so other class changes do nothing. */
  useEffect(() => {
    const root = rootRef.current;
    if (!open || !root || typeof MutationObserver !== 'function') return undefined;
    let held = menuOpen();
    const mo = new MutationObserver(() => {
      const now = menuOpen();
      if (held && !now) {
        menuClosedAt.current = performance.now();
        fold();
      }
      held = now;
    });
    mo.observe(root, { subtree: true, attributes: true, attributeFilter: ['aria-expanded', 'class'] });
    return () => mo.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, fold]);

  // A press anywhere else folds it: the touch path has no pointerleave. A press
  // inside a portalled menu belongs to that menu, which says so by being open.
  useEffect(() => {
    if (!open) return undefined;
    const away = (e) => {
      if (rootRef.current?.contains(e.target) || menuOpen()) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  /* A tap focuses the button it lands on (Android, and most browsers), and
     focus opens the island — so the click a moment later would find it open
     and fold it again. Focus that a press brought is left to the click. */
  const pressedAt = useRef(-Infinity);

  const handlers = {
    onPointerDownCapture: () => { pressedAt.current = performance.now(); },
    onPointerEnter: (e) => {
      if (e.pointerType !== 'mouse') return;
      clearTimeout(closeTimer.current);
      setOpen(true);
    },
    onPointerLeave: (e) => {
      if (e.pointerType !== 'mouse') return;
      fold();
    },
    onFocus: (e) => {
      // Focus arriving in a portalled menu, or handed back by one as it closes,
      // is not someone arriving at the island.
      if (quiet.current || !rootRef.current?.contains(e.target)) return;
      if (performance.now() - menuClosedAt.current < 400) return;
      if (performance.now() - pressedAt.current < 600) return;
      clearTimeout(closeTimer.current);
      setOpen(true);
    },
    onBlur: (e) => {
      if (!rootRef.current?.contains(e.relatedTarget) && !menuOpen()) setOpen(false);
    },
  };

  return { open, setOpen, handlers, quiet };
}
