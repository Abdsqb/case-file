import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check } from 'lucide-react';
import { SPRINGS, CLOSE_DELAY } from './island.js';
import './IslandMenu.css';

const cx = (...parts) => parts.filter(Boolean).join(' ');
const reduced = () => document.documentElement.dataset.motion === 'reduced'
  || window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// All choice and action dropdowns use one portal. The surface grows from the
// trigger's measured rectangle, so clipping/3D transforms on cards cannot cut
// it off. Closing keeps the surface mounted until it has folded back.
export default function IslandMenu({ items = [], label = 'Options', className, children,
  align = 'start', disabled = false, id, name }) {
  const trigger = useRef(null);
  const surface = useRef(null);
  const body = useRef(null);
  const timer = useRef(0);
  const keyboard = useRef(false);
  const hoverOpened = useRef(false);
  const [open, setOpen] = useState(false);
  const [present, setPresent] = useState(false);
  const [geometry, setGeometry] = useState(null);
  const menuId = useId();
  const active = open && !disabled;

  const close = useCallback((restore = false) => {
    clearTimeout(timer.current);
    hoverOpened.current = false;
    setOpen(false);
    if (restore) trigger.current?.focus({ preventScroll: true });
  }, []);

  const show = (fromKeyboard = false) => {
    if (disabled) return;
    clearTimeout(timer.current);
    keyboard.current = fromKeyboard;
    document.dispatchEvent(new CustomEvent('casefile:menu-open', { detail: menuId }));
    setPresent(true);
    setOpen(true);
  };

  const scheduleClose = () => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      if (surface.current?.matches(':hover') || trigger.current?.matches(':hover')) return;
      if (keyboard.current && surface.current?.contains(document.activeElement)) return;
      close();
    }, CLOSE_DELAY);
  };

  // Natural content determines the final width and height. Resize and nested
  // scrolling reposition the panel without restarting its entrance animation.
  useLayoutEffect(() => {
    if (!present) return undefined;
    const place = () => {
      const a = trigger.current;
      const s = surface.current;
      if (!a || !s || !body.current) return;
      const r = a.getBoundingClientRect();
      const width = Math.min(window.innerWidth - 16, Math.max(200, r.width, body.current.scrollWidth + 12));
      const height = Math.min(window.innerHeight - 16, Math.max(36, r.height) + body.current.scrollHeight + 12);
      const flip = r.top + height > window.innerHeight - 8 && r.bottom - height >= 8;
      const top = Math.max(8, Math.min(flip ? r.bottom - height : r.top, window.innerHeight - height - 8));
      const left = Math.max(8, Math.min(align === 'end' ? r.right - width : r.left, window.innerWidth - width - 8));
      setGeometry({ left, top, width, height, flip, startWidth: r.width, startHeight: r.height,
        dx: r.left - left, dy: r.top - top });
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(body.current);
    ro.observe(trigger.current);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [present, align]);

  const positioned = !!geometry;
  useLayoutEffect(() => {
    if (!present || !positioned) return undefined;
    const s = surface.current;
    const a = trigger.current;
    const g = geometry;
    a.dataset.islandPresent = 'true';
    const folded = { width: `${g.startWidth}px`, height: `${g.startHeight}px`,
      transform: `translate(${g.dx}px, ${g.dy}px)`, borderRadius: `${g.startHeight / 2}px`, opacity: 0.75 };
    const expanded = { width: `${g.width}px`, height: `${g.height}px`, transform: 'translate(0px, 0px)',
      borderRadius: '24px', opacity: 1 };
    const animation = s.animate(active ? [folded, expanded] : [expanded, folded], {
      duration: reduced() ? 0 : active ? 560 : 280,
      easing: (active ? SPRINGS['--pn-open'] : SPRINGS['--pn-close']) || 'cubic-bezier(0.22,1,0.36,1)',
      fill: 'none',
    });
    if (!active) animation.onfinish = () => {
      delete a.dataset.islandPresent;
      setPresent(false);
      setGeometry(null);
    };
    if (active && keyboard.current) {
      const options = [...body.current.querySelectorAll('[data-menuitem]:not(:disabled)')];
      const target = options.find(e => e.getAttribute('aria-checked') === 'true') || options[0];
      target?.focus({ preventScroll: true });
    }
    return () => animation.cancel();
    // Geometry updates on scrolling should not replay the spring.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, present, positioned]);

  useEffect(() => {
    if (!active) return undefined;
    const away = e => {
      if (!trigger.current?.contains(e.target) && !surface.current?.contains(e.target)) close();
    };
    const escape = e => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      close(true);
    };
    const blur = () => close();
    document.addEventListener('pointerdown', away, true);
    document.addEventListener('keydown', escape, true);
    window.addEventListener('blur', blur);
    return () => {
      document.removeEventListener('pointerdown', away, true);
      document.removeEventListener('keydown', escape, true);
      window.removeEventListener('blur', blur);
    };
  }, [active, close]);

  useEffect(() => {
    const other = e => { if (e.detail !== menuId) close(); };
    const standby = e => { if (e.detail?.on) close(); };
    document.addEventListener('casefile:menu-open', other);
    window.addEventListener('casefile:standby', standby);
    return () => {
      document.removeEventListener('casefile:menu-open', other);
      window.removeEventListener('casefile:standby', standby);
    };
  }, [close, menuId]);

  useEffect(() => {
    const a = trigger.current;
    return () => {
      clearTimeout(timer.current);
      if (a) delete a.dataset.islandPresent;
    };
  }, []);

  const keys = e => {
    const options = [...(body.current?.querySelectorAll('[data-menuitem]:not(:disabled)') || [])];
    const i = options.indexOf(document.activeElement);
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
      e.preventDefault();
      const next = e.key === 'Home' ? 0 : e.key === 'End' ? options.length - 1
        : (i + (e.key === 'ArrowUp' ? -1 : 1) + options.length) % options.length;
      options[next]?.focus({ preventScroll: true });
    } else if (e.key === 'Tab') {
      e.preventDefault();
      close(true);
    } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const ordered = [...options.slice(i + 1), ...options.slice(0, i + 1)];
      const next = ordered.find(o => o.textContent.trim().toLowerCase().startsWith(e.key.toLowerCase()));
      if (next) { e.preventDefault(); next.focus({ preventScroll: true }); }
    }
  };

  return <>
    <button ref={trigger} id={id} name={name} type="button" disabled={disabled}
      className={cx(className, 'island-trigger', active && 'is-open')}
      aria-label={label} aria-haspopup="menu" aria-expanded={active}
      aria-controls={present ? menuId : undefined}
      onPointerEnter={e => {
        if (e.pointerType !== 'mouse' || disabled) return;
        // Give intent a beat, so moving across a row of actions doesn't open all of them.
        clearTimeout(timer.current);
        timer.current = setTimeout(() => { hoverOpened.current = true; show(); }, 120);
      }}
      onPointerLeave={scheduleClose}
      onClick={() => {
        if (hoverOpened.current) { hoverOpened.current = false; return; }
        if (active) close(true); else show();
      }}
      onKeyDown={e => {
        if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) {
          e.preventDefault(); show(true);
        }
      }}>
      {children}
    </button>
    {present && createPortal(
      <div ref={surface} className={cx('island-menu', active && 'is-open', geometry?.flip && 'is-flipped')}
        style={{ ...SPRINGS, left: geometry?.left ?? -9999, top: geometry?.top ?? -9999,
          width: geometry?.width ?? 'max-content', height: geometry?.height,
          visibility: geometry ? 'visible' : 'hidden', pointerEvents: active ? 'auto' : 'none' }}
        onPointerEnter={() => clearTimeout(timer.current)} onPointerLeave={scheduleClose}
        onBlur={e => {
          if (!surface.current?.contains(e.relatedTarget) && e.relatedTarget !== trigger.current) close();
        }}>
        <button type="button" className="island-menu__cap" tabIndex={-1} aria-label={`Close ${label}`}
          style={{ minHeight: Math.max(36, geometry?.startHeight || 36) }} onClick={() => close(true)}>
          {children}
        </button>
        <div id={menuId} ref={body} className="island-menu__body" role="menu" aria-label={label}
          aria-hidden={!active} inert={!active ? true : undefined} onKeyDown={keys}>
          {items.map((item, i) => item.sep
            ? <div key={item.key ?? i} className="island-menu__sep" role="separator" />
            : <button key={item.key ?? i} type="button" data-menuitem="" disabled={!!item.disabled}
                role={item.on === undefined ? 'menuitem' : 'menuitemradio'}
                aria-checked={item.on === undefined ? undefined : !!item.on}
                className={cx('island-menu__item', item.on && 'is-current', item.danger && 'is-danger')}
                style={{ '--i': Math.min(i, 8) }} onClick={() => {
                  close(true);
                  item.onClick?.();
                }}>
                <span className="island-menu__label">{item.label}</span>
                {item.meta !== undefined && <span className="island-menu__meta">{item.meta}</span>}
                {item.on && <Check size={12} strokeWidth={1.75} aria-hidden="true" />}
              </button>)}
          {!items.length && <span className="island-menu__empty">No actions</span>}
        </div>
      </div>, document.body)}
  </>;
}
