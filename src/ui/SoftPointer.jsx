/**
 * SoftPointer.jsx — the pointer, drawn by the app: a soft grey disc in the
 * manner of the iPad's, in place of the system arrow.
 *
 * It has three shapes and glides between them:
 *   dot   — an 11px blurred disc that sits exactly on the pointer
 *   snap  — over a button, tab or link it lets go of the pointer and becomes
 *           a faint highlight wrapped round the control, leaning a little
 *           toward where the pointer actually is
 *   text  — over a field it narrows to a caret the height of the type
 *
 * One fixed element, moved with a transform. The loop runs only while
 * something is still settling, so a pointer at rest costs nothing; width and
 * height are written only while the shape is changing. Nothing per-frame goes
 * on <html> (root custom properties restyle the whole document).
 *
 * Off for touch and pen, off for any device without a fine hovering pointer,
 * and off when Settings says System. Reduce motion keeps the shapes and drops
 * the glide.
 */

import { useEffect, useMemo, useRef } from 'react';
import { DEFAULT_POINTER, KEY_POINTER, useSetting } from '../lib/settings.js';

const DOT = 11;            // px across, at rest
const PRESS = 0.78;        // the dot's size while a button is held
const PAD = 5;             // how far the highlight sits outside the control
const LEAN = 0.12;         // how far the highlight follows the pointer off centre
const SNAP_W = 280;        // controls bigger than this keep the dot: wrapping a
const SNAP_H = 72;         //   whole card in a highlight reads as a selection
const MORPH = 18;          // settle rate, per second, for shape and the glide
const GLIDE_MS = 240;      // after leaving a control, how long the dot eases back

const ALPHA = { dot: 0.4, snap: 0.11, text: 0.75 };

const SNAP = [
  'button',
  'a[href]',
  'summary',
  'select',
  '[role="button"]',
  '[role="tab"]',
  '[role="menuitem"]',
  '[role="option"]',
  '[role="switch"]',
  'label:has(> input[type="checkbox"])',
  'label:has(> input[type="radio"])',
].join(',');

const TEXT = [
  'textarea',
  '[contenteditable=""]',
  '[contenteditable="true"]',
  'input:not([type="checkbox"]):not([type="radio"]):not([type="range"])'
    + ':not([type="button"]):not([type="submit"]):not([type="reset"])'
    + ':not([type="color"]):not([type="file"])',
].join(',');

export default function SoftPointer() {
  const mode = useSetting(KEY_POINTER, DEFAULT_POINTER);
  const fine = useMemo(
    () => typeof window !== 'undefined'
      && window.matchMedia('(hover: hover) and (pointer: fine)').matches,
    []
  );
  const on = mode !== 'system' && fine;
  const ref = useRef(null);

  useEffect(() => {
    const el = ref.current;
    if (!on || !el) return undefined;
    const root = document.documentElement;
    root.classList.add('soft-pointer');

    const still = () =>
      root.dataset.motion === 'reduced'
      || window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const p = { x: -100, y: -100 };                      // the real pointer
    const cur = { x: -100, y: -100, w: DOT, h: DOT, r: DOT / 2, a: ALPHA.dot };
    const aim = { ...cur };
    let kind = 'dot';
    let target = null;
    let radius = 8;        // the snapped control's own corner
    let caret = 18;        // the text caret's height
    let pressed = false;
    let shown = false;
    let glideUntil = 0;
    let raf = 0;
    let last = 0;

    const resolve = (node) => {
      const t = node instanceof Element ? node : null;
      const field = t && t.closest(TEXT);
      if (field && !field.disabled) {
        if (target !== field) {
          const size = parseFloat(getComputedStyle(field).fontSize) || 14;
          caret = Math.round(size * 1.35);
        }
        if (kind === 'snap') glideUntil = performance.now() + GLIDE_MS;
        kind = 'text';
        target = field;
        return;
      }
      const control = t && t.closest(SNAP);
      if (control && !control.matches(':disabled, [aria-disabled="true"]')) {
        const b = control.getBoundingClientRect();
        if (b.width <= SNAP_W && b.height <= SNAP_H) {
          if (target !== control) {
            radius = parseFloat(getComputedStyle(control).borderTopLeftRadius) || 8;
          }
          kind = 'snap';
          target = control;
          return;
        }
      }
      if (kind === 'snap') glideUntil = performance.now() + GLIDE_MS;
      kind = 'dot';
      target = null;
    };

    const place = () => {
      // The control went away under it (a view changed, a row was deleted).
      if (target && !target.isConnected) resolve(document.elementFromPoint(p.x, p.y));
      if (kind === 'snap' && target) {
        const b = target.getBoundingClientRect();
        const cx = b.left + b.width / 2;
        const cy = b.top + b.height / 2;
        const lean = still() ? 0 : LEAN;
        aim.x = cx + (p.x - cx) * lean;
        aim.y = cy + (p.y - cy) * lean;
        aim.w = b.width + PAD * 2;
        aim.h = b.height + PAD * 2;
        aim.r = Math.min(radius + PAD, aim.h / 2);
        aim.a = pressed ? ALPHA.snap * 1.8 : ALPHA.snap;
      } else if (kind === 'text') {
        aim.x = p.x;
        aim.y = p.y;
        aim.w = 2;
        aim.h = caret;
        aim.r = 1;
        aim.a = ALPHA.text;
      } else {
        const d = pressed ? DOT * PRESS : DOT;
        aim.x = p.x;
        aim.y = p.y;
        aim.w = d;
        aim.h = d;
        aim.r = d / 2;
        aim.a = pressed ? ALPHA.dot * 1.25 : ALPHA.dot;
      }
    };

    let painted = { w: 0, h: 0, r: 0, a: 0 };
    const paint = () => {
      el.style.transform =
        `translate3d(${(cur.x - cur.w / 2).toFixed(2)}px, ${(cur.y - cur.h / 2).toFixed(2)}px, 0)`;
      if (cur.w !== painted.w || cur.h !== painted.h || cur.r !== painted.r) {
        el.style.width = `${cur.w.toFixed(2)}px`;
        el.style.height = `${cur.h.toFixed(2)}px`;
        el.style.borderRadius = `${cur.r.toFixed(2)}px`;
      }
      if (cur.a !== painted.a) el.style.setProperty('--a', cur.a.toFixed(3));
      painted = { w: cur.w, h: cur.h, r: cur.r, a: cur.a };
    };

    const frame = (now) => {
      const dt = last ? Math.min(0.05, (now - last) / 1000) : 1 / 60;
      last = now;
      place();
      const instant = still();
      const k = instant ? 1 : 1 - Math.exp(-dt * MORPH);
      // On a dot or a caret the position is the pointer's, with no lag at
      // all; it only eases while snapping in, and for a moment after leaving.
      const glide = !instant && (kind === 'snap' || now < glideUntil);
      const kp = glide ? k : 1;

      let busy = false;
      const step = (key, rate, eps) => {
        const d = aim[key] - cur[key];
        if (Math.abs(d) <= eps) { cur[key] = aim[key]; return; }
        cur[key] += d * rate;
        busy = true;
      };
      step('x', kp, 0.05);
      step('y', kp, 0.05);
      step('w', k, 0.05);
      step('h', k, 0.05);
      step('r', k, 0.05);
      step('a', k, 0.002);
      paint();

      if (busy || now < glideUntil) raf = requestAnimationFrame(frame);
      else { raf = 0; last = 0; }
    };
    const kick = () => { if (!raf) raf = requestAnimationFrame(frame); };

    const show = () => {
      if (shown) return;
      shown = true;
      // Arrive where the pointer is, not glide in from wherever it left.
      place();
      Object.assign(cur, aim);
      paint();
      el.classList.add('is-shown');
    };
    const hide = () => {
      if (!shown) return;
      shown = false;
      el.classList.remove('is-shown');
    };

    const onMove = (e) => {
      if (e.pointerType && e.pointerType !== 'mouse') { hide(); return; }
      p.x = e.clientX;
      p.y = e.clientY;
      resolve(e.target);
      show();
      kick();
    };
    // HTML drag and drop swallows pointermove; dragover still knows where it is.
    const onDrag = (e) => {
      p.x = e.clientX;
      p.y = e.clientY;
      kick();
    };
    const onDown = (e) => {
      if (e.pointerType && e.pointerType !== 'mouse') return;
      pressed = true;
      kick();
    };
    const onUp = () => { pressed = false; kick(); };
    // Content scrolls under a still pointer: what it is over has changed.
    const onScroll = () => {
      if (!shown) return;
      resolve(document.elementFromPoint(p.x, p.y));
      kick();
    };
    const onOut = (e) => { if (!e.relatedTarget) hide(); };
    // A click usually changes the page under a still pointer; look again once
    // React has drawn the result.
    const onClick = () => {
      requestAnimationFrame(() => {
        if (!shown) return;
        resolve(document.elementFromPoint(p.x, p.y));
        kick();
      });
    };

    window.addEventListener('pointermove', onMove, { passive: true });
    window.addEventListener('pointerdown', onDown, { passive: true });
    window.addEventListener('pointerup', onUp, { passive: true });
    window.addEventListener('pointercancel', onUp, { passive: true });
    window.addEventListener('scroll', onScroll, { passive: true, capture: true });
    window.addEventListener('blur', hide);
    document.addEventListener('dragover', onDrag, { passive: true });
    document.addEventListener('pointerout', onOut, { passive: true });
    window.addEventListener('click', onClick, { passive: true });

    return () => {
      cancelAnimationFrame(raf);
      root.classList.remove('soft-pointer');
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      window.removeEventListener('scroll', onScroll, { capture: true });
      window.removeEventListener('blur', hide);
      document.removeEventListener('dragover', onDrag);
      document.removeEventListener('pointerout', onOut);
      window.removeEventListener('click', onClick);
      el.classList.remove('is-shown');
    };
  }, [on]);

  if (!on) return null;
  return <div ref={ref} className="softpointer" aria-hidden="true" />;
}
