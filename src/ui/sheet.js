/**
 * sheet.js — pull a bottom sheet down to close it.
 *
 * On a phone the to-do window and the notes pad open as sheets from the bottom
 * edge (mobile.css). There is no Escape key there, so as well as the close
 * button the sheet follows a finger dragged down from its handle, and lets go
 * past a threshold to close. Touch and pen only: a mouse never drags it.
 *
 * The offset is written as --sheet-drag on the sheet itself — never on <html>,
 * where a custom property changing every frame restyles the whole document.
 *
 * And while a sheet is open on a phone the page under it holds still, and a
 * downward swipe anywhere on the sheet, once what it scrolls is at its top,
 * pulls the sheet down the same way the handle does.
 */

import { useCallback, useEffect, useRef } from 'react';

const CLOSE_AT = 90;   // px pulled down before letting go closes the sheet
const FLICK = 0.5;     // px/ms: a quick flick down closes from a shorter pull
const PHONE = '(max-width: 640px)';

/* The nearest thing between the finger and the sheet that scrolls up and
   down, if there is one. */
function scrollerOf(node, sheet) {
  for (let el = node; el && el !== sheet; el = el.parentElement) {
    if (el.scrollHeight > el.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(el).overflowY)) return el;
  }
  return null;
}

export function useSheetDrag(sheetRef, onClose, open = false) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const sheet = sheetRef.current;
    if (!open || !sheet || !window.matchMedia(PHONE).matches) return undefined;

    /* The page under the sheet does not scroll (mobile.css). */
    const root = document.documentElement;
    root.classList.add('is-sheet-locked');

    let t = null;
    const onStart = (e) => {
      if (e.touches.length !== 1 || e.target.closest('.sheet__grab')) { t = null; return; }
      const p = e.touches[0];
      t = { x: p.clientX, y: p.clientY, at: e.timeStamp, dy: 0, mode: null, scroller: scrollerOf(e.target, sheet) };
    };
    const onMove = (e) => {
      if (!t) return;
      const p = e.touches[0];
      const dx = p.clientX - t.x;
      const dy = p.clientY - t.y;
      if (!t.mode) {
        if (Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
        const atTop = !t.scroller || t.scroller.scrollTop <= 0;
        t.mode = Math.abs(dx) > Math.abs(dy) ? 'across'
          : dy > 0 && atTop ? 'pull'
            : t.scroller ? 'scroll'
              : 'hold';
        if (t.mode === 'pull') { t.y = p.clientY; sheet.classList.add('is-dragging'); }
      }
      if (t.mode === 'pull') {
        e.preventDefault();
        t.dy = Math.max(0, p.clientY - t.y);
        t.v = t.dy / Math.max(1, e.timeStamp - t.at);
        sheet.style.setProperty('--sheet-drag', `${t.dy}px`);
      } else if (t.mode === 'hold') {
        e.preventDefault();   // nothing here scrolls, so neither does the page
      }
    };
    const onEnd = () => {
      if (t && t.mode === 'pull') {
        sheet.classList.remove('is-dragging');
        sheet.style.removeProperty('--sheet-drag');
        if (t.dy > CLOSE_AT || (t.dy > 30 && t.v > FLICK)) closeRef.current();
      }
      t = null;
    };
    sheet.addEventListener('touchstart', onStart, { passive: true });
    sheet.addEventListener('touchmove', onMove, { passive: false });
    sheet.addEventListener('touchend', onEnd);
    sheet.addEventListener('touchcancel', onEnd);
    return () => {
      root.classList.remove('is-sheet-locked');
      sheet.removeEventListener('touchstart', onStart);
      sheet.removeEventListener('touchmove', onMove);
      sheet.removeEventListener('touchend', onEnd);
      sheet.removeEventListener('touchcancel', onEnd);
    };
  }, [sheetRef, open]);

  const drag = useRef(null);

  const onPointerDown = useCallback((e) => {
    if (e.pointerType === 'mouse' || !sheetRef.current) return;
    drag.current = { y: e.clientY, dy: 0, id: e.pointerId };
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* already gone */ }
    sheetRef.current.classList.add('is-dragging');
  }, [sheetRef]);

  const onPointerMove = useCallback((e) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.id || !sheetRef.current) return;
    d.dy = Math.max(0, e.clientY - d.y);
    sheetRef.current.style.setProperty('--sheet-drag', `${d.dy}px`);
  }, [sheetRef]);

  const end = useCallback(() => {
    const d = drag.current;
    drag.current = null;
    const el = sheetRef.current;
    if (el) {
      el.classList.remove('is-dragging');
      el.style.removeProperty('--sheet-drag');
    }
    if (d && d.dy > CLOSE_AT) onClose();
  }, [sheetRef, onClose]);

  return { onPointerDown, onPointerMove, onPointerUp: end, onPointerCancel: end };
}
