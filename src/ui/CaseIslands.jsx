/**
 * CaseIslands.jsx — the case bar's two controls, as islands like the top nav.
 *
 * FolderIsland   the folder switcher. Folded, it is the folder you are in
 *                and its count; pointed at, it springs open downward into
 *                every folder and the folder actions (new, rename, delete).
 *
 * CaseTabsIsland the cases in that folder. Folded, it is just the open case
 *                (with its ⋯ menu); pointed at, it springs open sideways into
 *                all of them, in their order, still draggable to reorder.
 *                Pick one and it folds back around it.
 *
 * Both are a clipping pill whose width (and, for the folder, height) runs on
 * the shared springs, with the full content inside slid so the current item
 * sits in the folded window. Behaviour is island.js's useIsland: open on
 * hover or focus, fold on leaving, Escape or a press elsewhere, and stay open
 * while one of their menus is open or a tab is being dragged.
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ChevronsUpDown, Folder } from 'lucide-react';
import { MenuButton, Segmented } from './primitives.jsx';
import { SPRINGS, useIsland } from './island.js';

const ROW = 36;      // one row, and the folded height of both islands
const TAB_X = 16;    // the tabs island's side padding

const cx = (...c) => c.filter(Boolean).join(' ');

/* ------------------------------------------------------------------ *
 * FolderIsland
 * ------------------------------------------------------------------ */

/**
 * `items` is the folder menu as CaseFiles builds it: rows of
 * { key, label, meta, on, danger, onClick }, and { sep: true } between groups.
 * The row with `on` is the folder being shown.
 */
export function FolderIsland({ items, label }) {
  const current = items.find(item => item.on && !item.sep) || items.find(item => !item.sep);
  return (
    <MenuButton items={items} label={label} className="folder-island-trigger">
      <Folder size={14} strokeWidth={1.6} aria-hidden="true" />
      <span className="folder-island-trigger__label">{current?.label || 'Folders'}</span>
      {current?.meta !== undefined && <span className="island-menu__meta">{current.meta}</span>}
      <ChevronsUpDown size={12} strokeWidth={1.8} aria-hidden="true" />
    </MenuButton>
  );
}

/* ------------------------------------------------------------------ *
 * SegmentIsland
 * ------------------------------------------------------------------ */

/* What an open island may cover: the bar or row it belongs to. */
const BOUND = '.casebar__left, .settings-row, .subbar, .viewhead, .card';

/**
 * Any row of choices (Segmented's props), as an island: folded to the current
 * choice, opening sideways into all of them on hover or focus and folding
 * back around the one picked. In the layout it holds only its folded size;
 * open, it lies over whatever is beside it, up to the edge of its bar or row.
 * `align="end"` anchors it on the right and grows it leftward, for controls
 * that sit at the end of a row.
 */
export function SegmentIsland({ items, value, onChange, onReorder, label, align = 'start', className }) {
  const slotRef = useRef(null);
  const rootRef = useRef(null);
  const trackRef = useRef(null);
  const dragging = () => !!rootRef.current?.querySelector('.segmented__item.is-dragging');
  const { open, setOpen, handlers } = useIsland(rootRef, { keepOpen: dragging });
  const [m, setM] = useState({ left: 0, width: 120, track: 120, room: 600 });
  const [offset, setOffset] = useState(0);

  /* Where the current choice sits in the strip, how wide the strip is, and
     how much room the island has to open into. Also stamps each choice's
     distance from the current one as --i, which staggers them coming in. */
  useLayoutEffect(() => {
    const measure = () => {
      const strip = trackRef.current?.querySelector('.segmented');
      const slot = slotRef.current;
      if (!strip || !slot) return;
      const tabs = [...strip.querySelectorAll('.segmented__item')];
      const active = strip.querySelector('.segmented__item--active') || tabs[0];
      const at = tabs.indexOf(active);
      tabs.forEach((t, i) => t.style.setProperty('--i', Math.abs(i - at)));
      const bound = (slot.parentElement && slot.parentElement.closest(BOUND)) || slot.parentElement;
      const br = bound.getBoundingClientRect();
      const sr = slot.getBoundingClientRect();
      /* On a phone the bar's own groups leave an island a sliver to open
         into; it lies over its neighbours anyway, so there it opens to the
         edge of the screen. */
      const vw = document.documentElement.clientWidth;
      const room = vw <= 640
        ? (align === 'end' ? sr.right - 16 : vw - 16 - sr.left)
        : (align === 'end' ? sr.right - br.left : br.right - sr.left);
      setM({
        left: active ? active.offsetLeft : 0,
        width: active ? active.offsetWidth : 120,
        track: strip.scrollWidth,
        room: Math.max(0, Math.floor(room)),
      });
    };
    measure();
    document.fonts?.ready?.then(measure);
    window.addEventListener('resize', measure);
    let ro = null;
    if (typeof ResizeObserver === 'function') {
      ro = new ResizeObserver(measure);
      const strip = trackRef.current?.querySelector('.segmented');
      if (strip) ro.observe(strip);
    }
    return () => { ro?.disconnect(); window.removeEventListener('resize', measure); };
  }, [items, value, align]);

  const foldedW = m.width + TAB_X * 2;
  const openW = Math.max(foldedW, Math.min(m.track + TAB_X * 2, m.room));
  const overflow = Math.max(0, m.track + TAB_X * 2 - openW);

  /* Opening on a strip too long for its row: start with the current choice
     in view, centred where possible; the wheel moves along from there. */
  useEffect(() => {
    if (!open) return;
    const want = m.left + m.width / 2 - openW / 2 + TAB_X;
    setOffset(Math.max(0, Math.min(overflow, want)));
    // only on opening
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    const el = rootRef.current;
    if (!el || !open || !overflow) return undefined;
    const onWheel = (e) => {
      const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      setOffset((o) => Math.max(0, Math.min(overflow, o + d)));
      e.preventDefault();
    };
    el.addEventListener('wheel', onWheel, { passive: false });

    /* A finger has no wheel: dragged sideways, the strip follows it. A drag
       that moved is not also a tap on whatever it started on. */
    let drag = null;
    const onDown = (e) => {
      if (e.pointerType === 'mouse') return;
      drag = { x: e.clientX, moved: false, from: null };
      setOffset((o) => { drag.from = o; return o; });
    };
    const onMove = (e) => {
      if (!drag || drag.from === null) return;
      const dx = e.clientX - drag.x;
      if (!drag.moved && Math.abs(dx) < 6) return;
      drag.moved = true;
      setOffset(Math.max(0, Math.min(overflow, drag.from - dx)));
    };
    const onUp = () => { if (drag && !drag.moved) drag = null; };
    const onClickCapture = (e) => {
      if (drag && drag.moved) { e.preventDefault(); e.stopPropagation(); }
      drag = null;
    };
    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onUp);
    el.addEventListener('click', onClickCapture, true);
    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onUp);
      el.removeEventListener('click', onClickCapture, true);
    };
  }, [open, overflow]);

  const width = open ? openW : foldedW;
  const x = open ? TAB_X - Math.min(offset, overflow) : TAB_X - m.left;

  const pick = (id) => {
    if (!open) { setOpen(true); return; }   // a tap on the folded pill opens it
    setOpen(false);
    if (id !== value && onChange) onChange(id);
  };

  const onKeyDown = (e) => {
    // Keys pressed in a ⋯ menu bubble here through its portal: they are the menu's.
    if (!rootRef.current?.contains(e.target)) return;
    if (e.key === 'Escape') {
      setOpen(false);
      rootRef.current?.querySelector('.segmented__item--active .segmented__btn')?.focus();
      e.preventDefault();
    }
  };

  return (
    <div
      ref={slotRef}
      className={cx('tabisland-slot', align === 'end' && 'is-end', open && 'is-open', className)}
      style={{ ...SPRINGS, width: foldedW }}
    >
      <div
        ref={rootRef}
        className={cx('island', 'tabisland', open && 'is-open')}
        style={{ width }}
        onKeyDown={onKeyDown}
        {...handlers}
      >
        <div ref={trackRef} className="tabisland__track" style={{ transform: `translateX(${x}px)` }}>
          <Segmented
            className="segmented--island"
            items={items}
            value={value}
            onChange={pick}
            onReorder={onReorder}
            label={label}
          />
        </div>
      </div>
    </div>
  );
}

/** The case bar's tabs: a SegmentIsland of the folder's cases. */
export const CaseTabsIsland = SegmentIsland;
