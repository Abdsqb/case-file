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
 * CaseTabsIsland
 * ------------------------------------------------------------------ */

/** Segmented's props; the island wraps it. */
export function CaseTabsIsland({ items, value, onChange, onReorder, label }) {
  const slotRef = useRef(null);
  const rootRef = useRef(null);
  const trackRef = useRef(null);
  const dragging = () => !!rootRef.current?.querySelector('.segmented__item.is-dragging');
  const { open, setOpen, handlers } = useIsland(rootRef, { keepOpen: dragging });
  const [m, setM] = useState({ left: 0, width: 120, track: 120, slot: 600 });
  const [offset, setOffset] = useState(0);

  /* Where the open case sits in the strip, how wide the strip is, and how much
     room the bar has. Also stamps each tab's distance from the open one as
     --i, which staggers them coming into focus. */
  useLayoutEffect(() => {
    const measure = () => {
      const strip = trackRef.current?.querySelector('.segmented');
      const slot = slotRef.current;
      if (!strip || !slot) return;
      const tabs = [...strip.querySelectorAll('.segmented__item')];
      const active = strip.querySelector('.segmented__item--active') || tabs[0];
      const at = tabs.indexOf(active);
      tabs.forEach((t, i) => t.style.setProperty('--i', Math.abs(i - at)));
      setM({
        left: active ? active.offsetLeft : 0,
        width: active ? active.offsetWidth : 120,
        track: strip.scrollWidth,
        slot: slot.clientWidth,
      });
    };
    measure();
    document.fonts?.ready?.then(measure);
    if (typeof ResizeObserver !== 'function') return undefined;
    const ro = new ResizeObserver(measure);
    ro.observe(slotRef.current);
    const strip = trackRef.current?.querySelector('.segmented');
    if (strip) ro.observe(strip);
    return () => ro.disconnect();
  }, [items, value]);

  const openW = Math.min(m.track + TAB_X * 2, m.slot);
  const overflow = Math.max(0, m.track + TAB_X * 2 - openW);

  /* Opening on a strip too long for the bar: start with the open case in
     view, centred where possible; the wheel moves along from there. */
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
    return () => el.removeEventListener('wheel', onWheel);
  }, [open, overflow]);

  const width = open ? openW : m.width + TAB_X * 2;
  const x = open ? TAB_X - Math.min(offset, overflow) : TAB_X - m.left;

  const pick = (id) => {
    if (!open) { setOpen(true); return; }   // a tap on the folded pill opens it
    setOpen(false);
    if (id !== value && onChange) onChange(id);
  };

  const onKeyDown = (e) => {
    // Keys pressed in the ⋯ menu bubble here through its portal: they are the menu's.
    if (!rootRef.current?.contains(e.target)) return;
    if (e.key === 'Escape') {
      setOpen(false);
      rootRef.current?.querySelector('.segmented__item--active .segmented__btn')?.focus();
      e.preventDefault();
    }
  };

  return (
    <div ref={slotRef} className="tabisland-slot">
      <div
        ref={rootRef}
        className={cx('island', 'tabisland', open && 'is-open')}
        style={{ ...SPRINGS, width }}
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
