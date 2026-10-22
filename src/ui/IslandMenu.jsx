/**
 * IslandMenu.jsx — every dropdown in the app, as a Dynamic Island.
 *
 * IslandSurface   the shape. The control steps aside and the island takes its
 *                 place, the same size, then springs out to its full size,
 *                 growing down from where the control was (or up, when there
 *                 is no room below), its first row starting right there.
 *                 Closing, it folds back to the control's size and the control
 *                 is there again, showing whatever was chosen. The ⋯ menus,
 *                 the select pills and the date pickers all open through it.
 *
 * IslandMenu      a trigger button plus a vertical list in an IslandSurface:
 *                 what IconMenu, MenuButton and PillSelect are made of.
 *
 * How the growth works: the surface is laid out once at its final size, and
 * its frame animates from the control's rectangle to that size (width,
 * height and a translate, on the shared springs). The content inside is
 * counter-translated by the same amount, so it never moves on screen while
 * the frame opens around it: nothing reflows, nothing slides. The fold back
 * is a detached copy of the surface doing the same in reverse, so it plays
 * even though whatever opened it has already unmounted it.
 *
 * Menus open on a click (or Enter, Space, the arrow keys), not on hover: a row
 * of controls must not burst open as the pointer crosses it. Escape closes the
 * innermost one and returns focus to its control; a press anywhere else, the
 * window losing focus, another menu opening or standby closes it.
 */

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check } from 'lucide-react';
import { SPRINGS } from './island.js';
import './IslandMenu.css';

const cx = (...parts) => parts.filter(Boolean).join(' ');

const EDGE = 8;        // px kept clear of the window edge
const MIN_W = 176;     // a list is never narrower than this
const RADIUS = 20;     // the open island's corners
const OPEN_MS = 540;
const CLOSE_MS = 320;
const OPEN_EVENT = 'casefile:island-open';

const reduced = () =>
  document.documentElement.dataset.motion === 'reduced'
  || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const openEase = () => SPRINGS['--pn-open'] || 'cubic-bezier(0.34, 1.3, 0.64, 1)';
const closeEase = () => SPRINGS['--pn-close'] || 'cubic-bezier(0.32, 0.72, 0, 1)';

/* Escape belongs to the innermost open surface. */
const stack = [];

const boxOf = (el) => {
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
};

/* Where the island ends up. As wide as its content (never narrower than the
   control), growing down from the control's top edge, or up from its bottom
   edge when there is more room above; always on screen. */
function layout(T, content, align, minWidth) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const width = Math.min(vw - EDGE * 2, Math.max(T.width, content.width, minWidth));
  const height = Math.min(vh - EDGE * 2, Math.max(T.height, content.height));
  const below = vh - EDGE - T.top;
  const above = T.bottom - EDGE;
  const up = height > below && above > below;
  const top = Math.max(EDGE, Math.min(up ? T.bottom - height : T.top, vh - EDGE - height));
  const left = Math.max(EDGE, Math.min(align === 'end' ? T.right - width : T.left, vw - EDGE - width));
  return { left, top, width, height, up, T };
}

const sameLayout = (a, b) =>
  !!a && !!b && a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height && a.up === b.up;

/**
 * The shape. Render it only while open; it plays its own fold on unmount.
 *   anchorRef   the control it grows out of
 *   onDismiss   a press elsewhere, blur, another island, standby
 *   onEscape    Escape while it is the innermost
 */
export function IslandSurface({ anchorRef, align = 'start', onDismiss, onEscape, label, role, className,
  minWidth = MIN_W, children }) {
  const outer = useRef(null);
  const inner = useRef(null);
  const body = useRef(null);
  const geoRef = useRef(null);
  const played = useRef(false);
  const handlers = useRef({});
  handlers.current = { onDismiss, onEscape };
  const id = useId();
  const [geo, setGeo] = useState(null);

  const place = useCallback(() => {
    const a = anchorRef.current;
    const b = body.current;
    if (!a || !b) return;
    const next = layout(boxOf(a), { width: Math.ceil(b.scrollWidth), height: Math.ceil(b.scrollHeight) }, align, minWidth);
    setGeo((prev) => (sameLayout(prev, next) ? prev : next));
  }, [anchorRef, align, minWidth]);

  // Measure before the first paint, and again whenever the content or the window changes.
  useLayoutEffect(() => {
    place();
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(place) : null;
    if (ro && body.current) ro.observe(body.current);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [place]);

  // While the island is out, the control steps aside: the island is in its place.
  useLayoutEffect(() => {
    geoRef.current = geo;
    if (geo && anchorRef.current) anchorRef.current.dataset.islandPresent = 'true';
  }, [geo, anchorRef]);

  // The opening: once, from the control's rectangle to the island.
  useLayoutEffect(() => {
    if (!geo || played.current) return;
    played.current = true;
    if (reduced()) return;
    const T = geo.T;
    const dx = T.left - geo.left;
    const dy = T.top - geo.top;
    const timing = { duration: OPEN_MS, easing: openEase() };
    outer.current.animate([
      { width: `${T.width}px`, height: `${T.height}px`, transform: `translate(${dx}px, ${dy}px)`, borderRadius: `${T.height / 2}px` },
      { width: `${geo.width}px`, height: `${geo.height}px`, transform: 'translate(0, 0)', borderRadius: `${RADIUS}px` },
    ], timing);
    // The content holds still on screen while the frame grows around it.
    inner.current.animate([
      { transform: `translate(${-dx}px, ${-dy}px)` },
      { transform: 'translate(0, 0)' },
    ], timing);
  }, [geo]);

  // The fold: a detached copy shrinks back into the control after this unmounts.
  useLayoutEffect(() => () => {
    const s = outer.current;
    const a = anchorRef.current;
    const g = geoRef.current;
    const release = () => { if (a) delete a.dataset.islandPresent; };
    if (!s || !g || reduced()) { release(); return; }
    const ghost = s.cloneNode(true);
    ghost.removeAttribute('id');
    ghost.classList.add('is-folding');
    ghost.setAttribute('aria-hidden', 'true');
    ghost.inert = true;
    document.body.appendChild(ghost);
    // One frame on, the control has its new value (a choice was just made)
    // and sits where it now is; the island folds into exactly that.
    requestAnimationFrame(() => {
      const live = a && a.isConnected;
      const T = live ? boxOf(a) : g.T;
      const dx = T.left - g.left;
      const dy = T.top - g.top;
      const timing = { duration: CLOSE_MS, easing: closeEase(), fill: 'forwards' };
      const anim = ghost.animate([
        { width: `${g.width}px`, height: `${g.height}px`, transform: 'translate(0, 0)', borderRadius: `${RADIUS}px` },
        { width: `${T.width}px`, height: `${T.height}px`, transform: `translate(${dx}px, ${dy}px)`, borderRadius: `${T.height / 2}px` },
      ], timing);
      ghost.querySelector('.island__inner')?.animate([
        { transform: 'translate(0, 0)' },
        { transform: `translate(${-dx}px, ${-dy}px)` },
      ], timing);
      anim.onfinish = () => { ghost.remove(); release(); };
      anim.oncancel = anim.onfinish;
    });
  }, [anchorRef]);

  // Dismissal: Escape (innermost only), a press elsewhere, blur, another island, standby.
  useEffect(() => {
    const token = {};
    stack.push(token);
    document.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: id }));
    const onKey = (e) => {
      if (e.key !== 'Escape' || stack[stack.length - 1] !== token) return;
      e.preventDefault();
      e.stopPropagation();
      handlers.current.onEscape?.();
    };
    const onDown = (e) => {
      if (outer.current?.contains(e.target) || anchorRef.current?.contains(e.target)) return;
      // A press inside an island opened from within this one belongs to that one.
      if (e.target instanceof Element && e.target.closest('.island') && stack[stack.length - 1] !== token) return;
      handlers.current.onDismiss?.();
    };
    const onOther = (e) => {
      if (e.detail === id) return;
      // An island opened from inside this one leaves it open.
      const other = document.querySelector(`[data-island-id="${e.detail}"]`);
      if (other && outer.current?.contains(other)) return;
      handlers.current.onDismiss?.();
    };
    const onBlur = () => handlers.current.onDismiss?.();
    const onStandby = (e) => { if (e.detail?.on) handlers.current.onDismiss?.(); };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener(OPEN_EVENT, onOther);
    window.addEventListener('blur', onBlur);
    window.addEventListener('casefile:standby', onStandby);
    return () => {
      const i = stack.indexOf(token);
      if (i !== -1) stack.splice(i, 1);
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener(OPEN_EVENT, onOther);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('casefile:standby', onStandby);
    };
  }, [anchorRef, id]);

  if (typeof document === 'undefined') return null;
  return createPortal(
    <div
      ref={outer}
      className={cx('island-pop', geo?.up && 'is-up', align === 'end' && 'is-end', className)}
      data-island-id={id}
      role={role}
      aria-label={label}
      style={geo
        ? { left: geo.left, top: geo.top, width: geo.width, height: geo.height, borderRadius: RADIUS }
        // Measuring frame: off screen and transparent, but not hidden, so the
        // content can already take focus (a calendar focuses its day on mount).
        : { left: -10000, top: 0, opacity: 0, pointerEvents: 'none' }}
    >
      <div
        ref={inner}
        className="island__inner"
        style={geo ? { width: geo.width, height: geo.height } : { width: 'max-content' }}
      >
        <div ref={body} className="island__body">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

/* ------------------------------------------------------------------ *
 * The menu
 * ------------------------------------------------------------------ */

function MenuList({ items, label, menuId, focusOnOpen, onChoose, onTab }) {
  const list = useRef(null);
  const typed = useRef({ text: '', at: 0 });
  // The first row opens where the control was: a quick second press on the
  // control must not land on it as a choice.
  const openedAt = useRef(performance.now());

  const options = () => [...(list.current?.querySelectorAll('[data-menuitem]:not(:disabled)') || [])];

  useEffect(() => {
    if (!focusOnOpen) return;
    const all = options();
    const target = all.find((o) => o.getAttribute('aria-checked') === 'true') || all[0];
    target?.focus({ preventScroll: true });
  }, [focusOnOpen]);

  const onKeyDown = (e) => {
    const all = options();
    const at = all.indexOf(document.activeElement);
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
      e.preventDefault();
      const next = e.key === 'Home' ? 0
        : e.key === 'End' ? all.length - 1
        : at === -1 ? (e.key === 'ArrowUp' ? all.length - 1 : 0)
        : (at + (e.key === 'ArrowUp' ? -1 : 1) + all.length) % all.length;
      all[next]?.focus({ preventScroll: true });
    } else if (e.key === 'Tab') {
      onTab();
    } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      // Type to jump: letters typed in quick succession spell a prefix.
      const now = performance.now();
      typed.current.text = now - typed.current.at < 700 ? typed.current.text + e.key.toLowerCase() : e.key.toLowerCase();
      typed.current.at = now;
      const order = [...all.slice(at + 1), ...all.slice(0, at + 1)];
      const hit = order.find((o) => o.textContent.trim().toLowerCase().startsWith(typed.current.text));
      if (hit) { e.preventDefault(); hit.focus({ preventScroll: true }); }
    }
  };

  return (
    <div ref={list} id={menuId} className="island-menu" role="menu" aria-label={label} onKeyDown={onKeyDown}>
      {items.map((item, i) => (item.sep ? (
        <div key={item.key ?? `sep-${i}`} className="island-menu__sep" role="separator" />
      ) : (
        <button
          key={item.key ?? i}
          type="button"
          data-menuitem=""
          disabled={!!item.disabled}
          role={item.on === undefined ? 'menuitem' : 'menuitemradio'}
          aria-checked={item.on === undefined ? undefined : !!item.on}
          className={cx('island-menu__item', item.on && 'is-current', item.danger && 'is-danger')}
          style={{ '--i': Math.min(i, 10) }}
          onClick={(e) => {
            if (e.detail !== 0 && performance.now() - openedAt.current < 280) return;
            onChoose(item);
          }}
        >
          <span className="island-menu__label">{item.label}</span>
          {item.meta !== undefined ? <span className="island-menu__meta">{item.meta}</span> : null}
          <span className="island-menu__mark" aria-hidden="true">
            {item.on ? <Check size={13} strokeWidth={1.9} /> : null}
          </span>
        </button>
      )))}
      {!items.length ? <span className="island-menu__empty">Nothing here yet</span> : null}
    </div>
  );
}

export default function IslandMenu({ items = [], label = 'Options', className, children, align = 'start',
  disabled = false, id, name, minWidth }) {
  const trigger = useRef(null);
  const [open, setOpen] = useState(false);
  const keyed = useRef(false);
  const menuId = useId();

  const close = useCallback((restore) => {
    setOpen(false);
    if (restore) trigger.current?.focus({ preventScroll: true });
  }, []);

  const onKeyDown = (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    if (open) {
      document.getElementById(menuId)?.querySelector('[data-menuitem]:not(:disabled)')?.focus({ preventScroll: true });
      return;
    }
    keyed.current = true;
    setOpen(true);
  };

  return (
    <>
      <button
        ref={trigger}
        id={id}
        name={name}
        type="button"
        disabled={disabled}
        className={cx(className, 'island-trigger', open && 'is-open')}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={(e) => {
          if (disabled) return;
          // Enter and Space arrive as a click with no pointer: open into the list.
          keyed.current = e.detail === 0;
          setOpen((o) => !o);
        }}
        onKeyDown={onKeyDown}
      >
        {children}
      </button>
      {open ? (
        <IslandSurface
          anchorRef={trigger}
          align={align}
          label={label}
          minWidth={minWidth}
          onDismiss={() => close(false)}
          onEscape={() => close(true)}
        >
          <MenuList
            items={items}
            label={label}
            menuId={menuId}
            focusOnOpen={keyed.current}
            onTab={() => close(false)}
            onChoose={(item) => {
              close(true);
              item.onClick?.();
            }}
          />
        </IslandSurface>
      ) : null}
    </>
  );
}
