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
 */

import { useCallback, useRef } from 'react';

const CLOSE_AT = 90;   // px pulled down before letting go closes the sheet

export function useSheetDrag(sheetRef, onClose) {
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
