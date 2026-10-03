import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react'

/* ------------------------------------------------------------------ *
 * helpers
 * ------------------------------------------------------------------ */

function cx(...parts) {
  return parts.filter(Boolean).join(' ')
}

const EDGE = 8 // viewport padding kept around a popover
const GAP = 6 // distance between trigger and popover

/**
 * Escape ownership. Only the most recently opened popover reacts, so a
 * nested popover never dismisses its parent instead of itself.
 */
const popStack = []

function computePosition(rect, el, align) {
  const vw = window.innerWidth
  const vh = window.innerHeight
  const pw = el ? el.offsetWidth : 0
  const ph = el ? el.offsetHeight : 0

  let top = rect.bottom + GAP
  let flipped = false
  if (top + ph > vh - EDGE && rect.top - GAP - ph > EDGE) {
    top = rect.top - GAP - ph
    flipped = true
  }
  if (ph > 0) top = Math.max(EDGE, Math.min(top, vh - EDGE - ph))
  else top = Math.max(EDGE, top)

  let left = align === 'end' ? rect.right - pw : rect.left
  if (pw > 0) left = Math.max(EDGE, Math.min(left, vw - EDGE - pw))
  else left = Math.max(EDGE, left)

  return { top, left, width: rect.width, flipped }
}

function samePos(a, b) {
  return (
    !!a &&
    !!b &&
    a.top === b.top &&
    a.left === b.left &&
    a.width === b.width &&
    a.flipped === b.flipped
  )
}

/**
 * Every floating surface in the app goes through here: portalled to
 * document.body (the cards are overflow:hidden and would clip it),
 * position:fixed from the trigger rect, re-measured on scroll / resize /
 * content resize, flipped above the trigger when it would overflow the
 * bottom of the viewport.
 */
function Popover({
  anchorRef,
  open,
  onClose,
  onDismiss,
  align = 'start',
  matchWidth = false,
  className,
  role,
  ariaLabel,
  children,
}) {
  const ref = useRef(null)
  const [pos, setPos] = useState(null)

  // keep the callbacks in refs so an inline arrow from the caller does not
  // resubscribe (and re-stack) the popover on every parent render
  const closeRef = useRef(onClose)
  const dismissRef = useRef(onDismiss)
  closeRef.current = onClose
  dismissRef.current = onDismiss

  const place = useCallback(() => {
    const anchor = anchorRef && anchorRef.current
    if (!anchor) return
    const next = computePosition(anchor.getBoundingClientRect(), ref.current, align)
    setPos((prev) => (samePos(prev, next) ? prev : next))
  }, [anchorRef, align])

  useLayoutEffect(() => {
    if (!open) {
      setPos(null)
      return undefined
    }
    place()
    let ro = null
    if (typeof ResizeObserver !== 'undefined' && ref.current) {
      ro = new ResizeObserver(() => place())
      ro.observe(ref.current)
    }
    return () => {
      if (ro) ro.disconnect()
    }
  }, [open, place])

  useEffect(() => {
    if (!open) return undefined

    const token = {}
    popStack.push(token)

    const onScrollOrResize = () => place()
    const onDown = (e) => {
      if (ref.current && ref.current.contains(e.target)) return
      const anchor = anchorRef && anchorRef.current
      // the trigger's own click handler owns the toggle
      if (anchor && anchor.contains(e.target)) return
      const fn = dismissRef.current || closeRef.current
      if (fn) fn()
    }
    const onKey = (e) => {
      if (e.key !== 'Escape') return
      if (popStack[popStack.length - 1] !== token) return
      e.preventDefault()
      e.stopPropagation()
      if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation()
      if (closeRef.current) closeRef.current()
    }

    window.addEventListener('scroll', onScrollOrResize, true)
    window.addEventListener('resize', onScrollOrResize)
    document.addEventListener('mousedown', onDown, true)
    // capture phase: a popover eats Escape before any page-level handler
    document.addEventListener('keydown', onKey, true)

    return () => {
      const i = popStack.indexOf(token)
      if (i !== -1) popStack.splice(i, 1)
      window.removeEventListener('scroll', onScrollOrResize, true)
      window.removeEventListener('resize', onScrollOrResize)
      document.removeEventListener('mousedown', onDown, true)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [open, place, anchorRef])

  if (!open || typeof document === 'undefined') return null

  return createPortal(
    <div
      ref={ref}
      className={cx('pop', pos && pos.flipped && 'pop--flip', className)}
      role={role}
      aria-label={ariaLabel}
      style={{
        position: 'fixed',
        top: pos ? pos.top : -9999,
        left: pos ? pos.left : -9999,
        minWidth: matchWidth && pos ? pos.width : undefined,
      }}
    >
      {children}
    </div>,
    document.body
  )
}

/** shared arrow-key handling for the two portalled menus */
function handleMenuKeys(e, container, close) {
  if (!container) return
  const items = Array.from(container.querySelectorAll('[data-menuitem]')).filter(
    (el) => !el.disabled
  )
  if (!items.length) return
  const current = items.indexOf(document.activeElement)

  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault()
    const step = e.key === 'ArrowDown' ? 1 : -1
    const next = current === -1 ? (step === 1 ? 0 : items.length - 1) : (current + step + items.length) % items.length
    items[next].focus()
  } else if (e.key === 'Home') {
    e.preventDefault()
    items[0].focus()
  } else if (e.key === 'End') {
    e.preventDefault()
    items[items.length - 1].focus()
  } else if (e.key === 'Tab') {
    // the menu lives at the end of <body>; tabbing out would be nonsense
    e.preventDefault()
    close()
  }
}

function useMenuAutofocus(open, menuRef) {
  useEffect(() => {
    if (!open) return
    const id = requestAnimationFrame(() => {
      const node = menuRef.current
      if (!node) return
      const selected = node.querySelector('[data-menuitem][data-on="true"]')
      const first = node.querySelector('[data-menuitem]:not([disabled])')
      const target = selected && !selected.disabled ? selected : first
      if (target) target.focus()
    })
    return () => cancelAnimationFrame(id)
  }, [open, menuRef])
}

function normalizeOptions(options) {
  return (options || []).map((o) =>
    o !== null && typeof o === 'object'
      ? { value: o.value, label: o.label === undefined ? String(o.value) : o.label, disabled: !!o.disabled }
      : { value: o, label: String(o), disabled: false }
  )
}

/* ------------------------------------------------------------------ *
 * Card / CardHead
 * ------------------------------------------------------------------ */

/* One surface, for every card on every screen.
 *
 * A card used to be able to ask for a `sage` tone, which gave it a breath of
 * the accent in its fill and an accent hairline — a way of saying "this is the
 * one to look at" in a grid of six. That was a judgement the card made about
 * itself, and in a row of panels it read as one of them being broken rather
 * than as one of them mattering. It is also at odds with the glass: a panel's
 * whole job now is to let the light behind it through unchanged.
 *
 * Emphasis is still available, and it is made of content — a metric at size, a
 * lit status dot, the accent on the one control that is live. */
export const Card = forwardRef(function Card(
  { span, className, style, children, as: As = 'section', ...rest },
  ref
) {
  const merged = span ? { gridColumn: `span ${span}`, ...style } : style
  return (
    <As
      ref={ref}
      className={cx('card', className)}
      style={merged}
      {...rest}
    >
      {children}
    </As>
  )
})

export function CardHead({ title, subtitle, right, className }) {
  return (
    <div className={cx('card__head', className)}>
      <div className="card__headtext">
        {title !== undefined && title !== null && title !== '' ? (
          <div className="card__title">{title}</div>
        ) : null}
        {subtitle ? <div className="card__sub">{subtitle}</div> : null}
      </div>
      {right ? <div className="card__right">{right}</div> : null}
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * Pill
 * ------------------------------------------------------------------ */

export const Pill = forwardRef(function Pill(
  { onClick, children, active = false, disabled = false, className, type = 'button', ...rest },
  ref
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cx('pill', active && 'pill--active', className)}
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active ? true : undefined}
      {...rest}
    >
      {children}
    </button>
  )
})

/* ------------------------------------------------------------------ *
 * PillSelect
 * ------------------------------------------------------------------ */

export function PillSelect({
  value,
  options,
  onChange,
  placeholder = 'Select',
  disabled = false,
  className,
  label,
  align = 'start',
}) {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef(null)
  const menuRef = useRef(null)
  const opts = useMemo(() => normalizeOptions(options), [options])
  const selected = opts.find((o) => o.value === value)

  const close = useCallback(() => setOpen(false), [])
  const closeAndFocus = useCallback(() => {
    setOpen(false)
    if (triggerRef.current) triggerRef.current.focus()
  }, [])

  useMenuAutofocus(open, menuRef)

  const pick = (opt) => {
    if (opt.disabled) return
    if (onChange) onChange(opt.value)
    closeAndFocus()
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={cx('pill', 'pillselect', open && 'pillselect--open', className)}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
            e.preventDefault()
            setOpen(true)
          }
        }}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
      >
        <span className="pillselect__value">{selected ? selected.label : placeholder}</span>
        <ChevronDown className="pillselect__chev" size={12} strokeWidth={1.5} aria-hidden="true" />
      </button>
      <Popover
        anchorRef={triggerRef}
        open={open}
        onClose={closeAndFocus}
        onDismiss={close}
        align={align}
        matchWidth
        className="menu-pop"
        role="menu"
        ariaLabel={label}
      >
        <div
          ref={menuRef}
          className="menu-pop__list"
          onKeyDown={(e) => handleMenuKeys(e, menuRef.current, closeAndFocus)}
        >
          {opts.map((opt) => {
            const on = opt.value === value
            return (
              <button
                key={String(opt.value)}
                type="button"
                data-menuitem=""
                data-on={on ? 'true' : 'false'}
                className={cx('menu-pop__item', on && 'menu-pop__item--on')}
                role="menuitemradio"
                aria-checked={on}
                disabled={opt.disabled}
                onClick={() => pick(opt)}
              >
                <span className="menu-pop__label">{opt.label}</span>
                {on ? (
                  <Check className="menu-pop__check" size={12} strokeWidth={1.75} aria-hidden="true" />
                ) : null}
              </button>
            )
          })}
        </div>
      </Popover>
    </>
  )
}

/* ------------------------------------------------------------------ *
 * IconMenu
 * ------------------------------------------------------------------ */

export function IconMenu({ items, label = 'More actions', align = 'end', className, disabled = false }) {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef(null)
  const menuRef = useRef(null)
  const list = items || []

  const close = useCallback(() => setOpen(false), [])
  const closeAndFocus = useCallback(() => {
    setOpen(false)
    if (triggerRef.current) triggerRef.current.focus()
  }, [])

  useMenuAutofocus(open, menuRef)

  const run = (item) => {
    if (item.disabled) return
    closeAndFocus()
    if (item.onClick) item.onClick()
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={cx('iconmenu', open && 'iconmenu--open', className)}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
            e.preventDefault()
            setOpen(true)
          }
        }}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
      >
        <span className="iconmenu__dot" />
        <span className="iconmenu__dot" />
        <span className="iconmenu__dot" />
      </button>
      <Popover
        anchorRef={triggerRef}
        open={open}
        onClose={closeAndFocus}
        onDismiss={close}
        align={align}
        className="menu-pop"
        role="menu"
        ariaLabel={label}
      >
        <div
          ref={menuRef}
          className="menu-pop__list"
          onKeyDown={(e) => handleMenuKeys(e, menuRef.current, closeAndFocus)}
        >
          {list.map((item, i) => (
            <button
              key={item.key || `${item.label}-${i}`}
              type="button"
              data-menuitem=""
              className={cx('menu-pop__item', item.danger && 'menu-pop__item--danger')}
              role="menuitem"
              disabled={!!item.disabled}
              onClick={() => run(item)}
            >
              <span className="menu-pop__label">{item.label}</span>
            </button>
          ))}
          {list.length === 0 ? <div className="menu-pop__empty">No actions</div> : null}
        </div>
      </Popover>
    </>
  )
}

/* ------------------------------------------------------------------ *
 * Toggle
 * ------------------------------------------------------------------ */

export function Toggle({ checked = false, onChange, label, disabled = false, className, id }) {
  const auto = useId()
  const labelId = label ? `${id || auto}-label` : undefined
  return (
    <span className={cx('toggle', checked && 'toggle--on', className)}>
      {label ? (
        <span className="toggle__label" id={labelId}>
          {label}
        </span>
      ) : null}
      <button
        type="button"
        id={id}
        role="switch"
        aria-checked={checked}
        aria-labelledby={labelId}
        disabled={disabled}
        className="toggle__track"
        onClick={() => onChange && onChange(!checked)}
      >
        <span className="toggle__knob" />
      </button>
    </span>
  )
}

/* ------------------------------------------------------------------ *
 * Metric / Trend
 * ------------------------------------------------------------------ */

const SETTLE_MS = 380

function prefersStill() {
  if (typeof window === 'undefined') return true
  if (document.documentElement.dataset.motion === 'reduced') return true
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/**
 * Cycles the digits of a value for a moment before settling on the real one, so
 * a metric reads as a readout locking on rather than a number that was always
 * simply there. Only digits churn — dashes, dots, percent signs and en dashes
 * hold still, so the glyph count never changes and nothing reflows.
 *
 * Returns [display, settling]. Falls straight through for non-scalar values and
 * whenever motion is reduced.
 */
function useSettle(value) {
  const scalar = typeof value === 'string' || typeof value === 'number'
  const target = scalar ? String(value) : ''
  const [display, setDisplay] = useState(target)
  const [settling, setSettling] = useState(false)

  useEffect(() => {
    if (!scalar) return undefined
    if (prefersStill() || !/\d/.test(target)) { setDisplay(target); setSettling(false); return undefined }

    let raf = 0
    const t0 = performance.now()
    setSettling(true)

    const step = now => {
      const t = Math.min((now - t0) / SETTLE_MS, 1)
      // Reveal left-to-right; every digit still to the right of the front churns.
      const front = t * t * (3 - 2 * t) * target.length
      let out = ''
      for (let i = 0; i < target.length; i++) {
        const c = target[i]
        out += c >= '0' && c <= '9' && i >= front
          ? String.fromCharCode(48 + ((Math.random() * 10) | 0))
          : c
      }
      setDisplay(out)
      if (t < 1) raf = requestAnimationFrame(step)
      else { setDisplay(target); setSettling(false) }
    }

    raf = requestAnimationFrame(step)
    return () => { cancelAnimationFrame(raf); setSettling(false) }
  }, [target, scalar])

  return scalar ? [display, settling] : [value, false]
}

export function Metric({ value, unit, sub, tone, size, className }) {
  const [shown, settling] = useSettle(value)
  return (
    <div className={cx('metric', tone && `metric--${tone}`, size === 'sm' && 'metric--sm', className)}>
      <div className="metric__value">
        <span className={cx('metric__num', settling && 'is-settling')}>{shown}</span>
        {unit ? <span className="metric__unit">{unit}</span> : null}
      </div>
      {sub ? <div className="metric__sub">{sub}</div> : null}
    </div>
  )
}

export function Trend({ dir = 'up', className }) {
  const up = dir === 'up'
  return (
    <span className={cx('trend', up ? 'trend--up' : 'trend--down', className)} aria-hidden="true">
      {up ? '↑' : '↓'}
    </span>
  )
}

/* ------------------------------------------------------------------ *
 * Field
 * ------------------------------------------------------------------ */

export const Field = forwardRef(function Field(
  {
    label,
    value,
    onChange,
    onCommit,
    onCancel,
    placeholder,
    disabled = false,
    autoFocus = false,
    className,
    id,
    ...rest
  },
  ref
) {
  const auto = useId()
  const inputId = id || auto
  const handled = useRef(false)

  return (
    <div className={cx('field', className)}>
      {label ? (
        <label className="field__label" htmlFor={inputId}>
          {label}
        </label>
      ) : null}
      <input
        ref={ref}
        id={inputId}
        className="field__input"
        type="text"
        value={value === undefined || value === null ? '' : value}
        placeholder={placeholder}
        disabled={disabled}
        autoFocus={autoFocus}
        autoComplete="off"
        spellCheck="false"
        onChange={(e) => onChange && onChange(e.target.value)}
        onFocus={() => {
          handled.current = false
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            handled.current = true
            if (onCommit) onCommit(e.currentTarget.value)
            e.currentTarget.blur()
          } else if (e.key === 'Escape') {
            e.stopPropagation()
            handled.current = true
            if (onCancel) onCancel()
            else e.currentTarget.blur()
          }
        }}
        onBlur={(e) => {
          if (handled.current) {
            handled.current = false
            return
          }
          if (onCommit) onCommit(e.currentTarget.value)
        }}
        {...rest}
      />
    </div>
  )
})

/* ------------------------------------------------------------------ *
 * Segmented
 * ------------------------------------------------------------------ */

const DRAG_THRESHOLD = 5   // px before a press becomes a drag rather than a click

/**
 * Segmented control.
 *
 * The selected option is marked by a single thumb that SLIDES between options
 * rather than each option toggling its own background — one moving object reads
 * as one control, and it gives the switch its continuity.
 *
 * Pass `onReorder(value, toIndex)` to make the options draggable. Reordering is
 * pointer-driven with a live preview: the dragged option tracks the pointer and
 * the others slide aside to open the gap.
 */
export function Segmented({ items, value, onChange, className, label, onReorder }) {
  const opts = useMemo(
    () =>
      (items || []).map((o) =>
        o !== null && typeof o === 'object'
          ? {
              value: o.value,
              label: o.label === undefined ? String(o.value) : o.label,
              disabled: !!o.disabled,
              menu: o.menu,
              // `fixed` options cannot be dragged, and no drag may cross them —
              // for pseudo-entries like "All cases" that are not really in the
              // list being ordered.
              fixed: !!o.fixed,
            }
          : { value: o, label: String(o), disabled: false, menu: undefined, fixed: false }
      ),
    [items]
  )

  const listRef = useRef(null)
  const itemRefs = useRef(new Map())
  const dragRef = useRef(null)
  const clickBlocked = useRef(false)

  const [thumb, setThumb] = useState(null)
  const [drag, setDrag] = useState(null)

  // Dragging is a fine-pointer affordance. On touch the strip itself pans, and
  // stealing that gesture to reorder would break scrolling; the option menu's
  // move actions remain the path there (and for the keyboard).
  // The movable span. Anything outside it is anchored, and drops are clamped
  // inside it so a fixed option can never be jumped over.
  const firstMovable = opts.findIndex((o) => !o.fixed)
  const lastMovable = opts.reduce((acc, o, i) => (o.fixed ? acc : i), -1)
  const movableCount = opts.filter((o) => !o.fixed).length

  const canDrag = !!onReorder && movableCount > 1 &&
    (typeof window === 'undefined' || window.matchMedia('(pointer: fine)').matches)

  /* ---- the sliding thumb ------------------------------------------- */
  // Measured with getBoundingClientRect rather than offsetLeft, whose origin is
  // ambiguous across engines, then converted into the strip's content space so
  // it stays correct when the strip is scrolled.
  const measure = useCallback(() => {
    const host = listRef.current
    const el = itemRefs.current.get(String(value))
    if (!host || !el) { setThumb(null); return }
    const hostRect = host.getBoundingClientRect()
    const rect = el.getBoundingClientRect()
    const padLeft = parseFloat(getComputedStyle(host).paddingLeft) || 0
    setThumb({
      left: rect.left - hostRect.left + host.scrollLeft - padLeft,
      width: rect.width,
    })
  }, [value])

  useLayoutEffect(() => { measure() }, [measure, opts])

  useEffect(() => {
    const host = listRef.current
    if (!host) return undefined
    const onScroll = () => measure()
    host.addEventListener('scroll', onScroll, { passive: true })
    let ro = null
    if (typeof ResizeObserver === 'function') {
      ro = new ResizeObserver(() => measure())
      ro.observe(host)
      for (const el of itemRefs.current.values()) if (el) ro.observe(el)
    } else {
      window.addEventListener('resize', onScroll)
    }
    return () => {
      host.removeEventListener('scroll', onScroll)
      if (ro) ro.disconnect()
      else window.removeEventListener('resize', onScroll)
    }
  }, [measure, opts])

  /* ---- drag to reorder --------------------------------------------- */

  // A press is tracked on `window`, NOT via setPointerCapture. Capturing the
  // pointer makes the browser dispatch the subsequent `click` at the capture
  // target — the item <div> — so the inner <button>'s onClick never fires and
  // options become undismissably drag-only. Window listeners give the same
  // tracking without touching click dispatch.
  const releaseRef = useRef(null)

  const onPointerDown = (e, index) => {
    if (!canDrag) return
    if (opts[index] && opts[index].fixed) return
    if (e.pointerType === 'mouse' && e.button !== 0) return
    // The row's ⋯ menu is its own control; pressing it must not arm a drag.
    if (e.target.closest && e.target.closest('.segmented__menu')) return

    const rects = opts.map((o) => {
      const el = itemRefs.current.get(String(o.value))
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { left: r.left, width: r.width, center: r.left + r.width / 2 }
    })
    if (rects.some((r) => !r)) return

    const startX = e.clientX
    dragRef.current = { index, to: index, startX, rects, moved: false }

    const move = (ev) => {
      const d = dragRef.current
      if (!d) return
      const dx = ev.clientX - d.startX
      if (!d.moved && Math.abs(dx) < DRAG_THRESHOLD) return
      d.moved = true

      // Target slot: how far the dragged option's centre has travelled past
      // the centres of the others.
      const centre = d.rects[d.index].center + dx
      let to = d.index
      for (let k = 0; k < d.rects.length; k++) {
        if (k === d.index || opts[k].fixed) continue
        if (k < d.index && centre < d.rects[k].center) to = Math.min(to, k)
        if (k > d.index && centre > d.rects[k].center) to = Math.max(to, k)
      }
      to = Math.max(firstMovable, Math.min(lastMovable, to))
      d.to = to
      setDrag({ index: d.index, dx, to })
    }

    const up = () => {
      const d = dragRef.current
      dragRef.current = null
      release()
      setDrag(null)
      if (!d || !d.moved) return
      // Only a press that actually became a drag suppresses the click.
      clickBlocked.current = true
      if (d.to !== d.index) onReorder(opts[d.index].value, d.to)
    }

    const release = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      releaseRef.current = null
    }

    releaseRef.current = release
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  }

  // A drag in flight when this unmounts would otherwise leak its listeners.
  useEffect(() => () => { if (releaseRef.current) releaseRef.current() }, [])

  const shiftFor = (k) => {
    if (!drag) return 0
    const { index, to, dx } = drag
    if (k === index) return dx
    const gap = 4
    const w = (dragRef.current ? dragRef.current.rects[index].width : 0) + gap
    if (index < to && k > index && k <= to) return -w
    if (index > to && k < index && k >= to) return w
    return 0
  }

  /* ---- keyboard ---------------------------------------------------- */

  const onKeyDown = (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    const node = listRef.current
    if (!node) return
    const btns = Array.from(node.querySelectorAll('.segmented__btn')).filter((b) => !b.disabled)
    const i = btns.indexOf(document.activeElement)
    if (i === -1) return
    e.preventDefault()
    const step = e.key === 'ArrowRight' ? 1 : -1
    btns[(i + step + btns.length) % btns.length].focus()
  }

  const activeIndex = opts.findIndex((o) => o.value === value)

  return (
    <div
      ref={listRef}
      className={cx('segmented', className)}
      role="group"
      aria-label={label}
      onKeyDown={onKeyDown}
      data-reorder={canDrag ? 'on' : undefined}
    >
      {thumb ? (
        <span
          aria-hidden="true"
          className={cx('segmented__thumb', drag && 'is-instant')}
          style={{
            width: `${thumb.width}px`,
            transform: `translate3d(${thumb.left + (activeIndex >= 0 ? shiftFor(activeIndex) : 0)}px,0,0)`,
          }}
        />
      ) : null}

      {opts.map((opt, index) => {
        const active = opt.value === value
        const dragging = !!drag && drag.index === index
        return (
          <div
            key={String(opt.value)}
            ref={(el) => {
              if (el) itemRefs.current.set(String(opt.value), el)
              else itemRefs.current.delete(String(opt.value))
            }}
            className={cx(
              'segmented__item',
              active && 'segmented__item--active',
              dragging && 'is-dragging'
            )}
            style={drag ? { transform: `translate3d(${shiftFor(index)}px,0,0)` } : undefined}
            onPointerDown={(e) => onPointerDown(e, index)}
          >
            <button
              type="button"
              className="segmented__btn"
              aria-pressed={active}
              disabled={opt.disabled}
              onClick={() => {
                if (clickBlocked.current) { clickBlocked.current = false; return }
                if (onChange) onChange(opt.value)
              }}
            >
              {opt.label}
            </button>
            {opt.menu && opt.menu.length ? (
              <IconMenu
                items={opt.menu}
                label={`Actions for ${opt.label}`}
                className="segmented__menu"
              />
            ) : null}
          </div>
        )
      })}
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * Meter
 * ------------------------------------------------------------------ */

export function Meter({ value = 0, label, className }) {
  const raw = Number(value)
  const frac = Number.isFinite(raw) ? (raw > 1 ? raw / 100 : raw) : 0
  const pct = Math.round(Math.max(0, Math.min(1, frac)) * 100)
  return (
    <div
      className={cx('meter', className)}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
    >
      <span className="meter__track">
        <span className="meter__fill" style={{ width: `${pct}%` }} />
      </span>
      <span className="meter__value">{pct}%</span>
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * EmptyState
 * ------------------------------------------------------------------ */

/* The accent face, applied in exactly one place in the app.
 *
 * An empty state's lead is a short sentence — "nothing past due — the queue is
 * clean." — and its last word is the one carrying the news. That word is set
 * in the italic serif, which is the whole of the accent typography: a change
 * of voice on one word, never a highlight and never a whole line.
 *
 * Done here rather than at forty call sites so that every empty state in the
 * app gets it without any of them having to know about it, and so that a lead
 * passed as markup rather than as a string is simply left alone. */
function withAccent(lead) {
  if (typeof lead !== 'string') return lead
  const m = /^([\s\S]*\s)(\S+)$/.exec(lead.trim())
  if (!m) return lead
  return (
    <>
      {m[1]}
      <em className="serif">{m[2]}</em>
    </>
  )
}

export function EmptyState({ lead, hint, action, className }) {
  return (
    <div className={cx('empty', className)}>
      {lead ? <div className="empty__lead">{withAccent(lead)}</div> : null}
      {hint ? <div className="empty__hint">{hint}</div> : null}
      {action ? <div className="empty__action">{action}</div> : null}
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * DatePopover
 * ------------------------------------------------------------------ */

const DAY_MS = 86400000

function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}

export function parseISODate(v) {
  if (!v) return null
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : startOfDay(v)
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v))
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? null : startOfDay(d)
}

export function toISODate(d) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function sameDay(a, b) {
  return (
    !!a &&
    !!b &&
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  )
}

const DOW_BASE = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']

/**
 * The native date input cannot be themed, so this is ours: a portalled
 * month calendar anchored to whatever opened it. Rendered only while open —
 * the caller mounts and unmounts it.
 */
export function DatePopover({ anchorRef, value, onSelect, onClear, onClose, weekStart = 1, align = 'end' }) {
  const today = useMemo(() => startOfDay(new Date()), [])
  const selected = useMemo(() => parseISODate(value), [value])
  const [cursor, setCursor] = useState(() => selected || today)
  const [month, setMonth] = useState(() => {
    const base = selected || today
    return new Date(base.getFullYear(), base.getMonth(), 1)
  })
  const gridRef = useRef(null)
  const mounted = useRef(false)
  const cursorIso = toISODate(cursor)

  // keep the cursor inside the visible month when the month changes
  useEffect(() => {
    if (cursor.getFullYear() === month.getFullYear() && cursor.getMonth() === month.getMonth()) return
    const last = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate()
    setCursor(new Date(month.getFullYear(), month.getMonth(), Math.min(cursor.getDate(), last)))
  }, [month, cursor])

  // focus the cursor day on open, and thereafter only while the grid already
  // holds focus — so clicking the month arrows does not yank focus away
  useEffect(() => {
    const node = gridRef.current
    if (!node) return
    const first = !mounted.current
    mounted.current = true
    if (!first && !node.contains(document.activeElement)) return
    const btn = node.querySelector(`[data-date="${cursorIso}"]`)
    if (btn) btn.focus()
  }, [cursorIso])

  const days = useMemo(() => {
    const first = new Date(month.getFullYear(), month.getMonth(), 1)
    const lead = (first.getDay() - weekStart + 7) % 7
    const count = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate()
    const cells = []
    for (let i = 0; i < lead; i += 1) cells.push(null)
    for (let d = 1; d <= count; d += 1) cells.push(new Date(month.getFullYear(), month.getMonth(), d))
    while (cells.length % 7 !== 0) cells.push(null)
    return cells
  }, [month, weekStart])

  const dow = useMemo(() => {
    const out = []
    for (let i = 0; i < 7; i += 1) out.push(DOW_BASE[(weekStart + i) % 7])
    return out
  }, [weekStart])

  const monthLabel = useMemo(
    () => month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }),
    [month]
  )

  const shiftMonth = (delta) => {
    setMonth((m) => new Date(m.getFullYear(), m.getMonth() + delta, 1))
  }

  const moveCursor = (deltaDays) => {
    const next = startOfDay(new Date(cursor.getTime() + deltaDays * DAY_MS))
    setCursor(next)
    if (next.getFullYear() !== month.getFullYear() || next.getMonth() !== month.getMonth()) {
      setMonth(new Date(next.getFullYear(), next.getMonth(), 1))
    }
  }

  const choose = (d) => {
    if (onSelect) onSelect(toISODate(d), d)
    if (onClose) onClose()
  }

  const onGridKeyDown = (e) => {
    const steps = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }
    if (e.key in steps) {
      e.preventDefault()
      moveCursor(steps[e.key])
      return
    }
    if (e.key === 'Home') {
      e.preventDefault()
      moveCursor(-((cursor.getDay() - weekStart + 7) % 7))
      return
    }
    if (e.key === 'End') {
      e.preventDefault()
      moveCursor(6 - ((cursor.getDay() - weekStart + 7) % 7))
      return
    }
    if (e.key === 'PageUp') {
      e.preventDefault()
      shiftMonth(-1)
      return
    }
    if (e.key === 'PageDown') {
      e.preventDefault()
      shiftMonth(1)
    }
  }

  return (
    <Popover
      anchorRef={anchorRef}
      open
      onClose={onClose}
      align={align}
      className="datepop"
      role="dialog"
      ariaLabel="Choose a date"
    >
      <div className="datepop__head">
        <button
          type="button"
          className="datepop__nav"
          onClick={() => shiftMonth(-1)}
          aria-label="Previous month"
        >
          <ChevronLeft size={13} strokeWidth={1.5} aria-hidden="true" />
        </button>
        <div className="datepop__month" aria-live="polite">
          {monthLabel}
        </div>
        <button
          type="button"
          className="datepop__nav"
          onClick={() => shiftMonth(1)}
          aria-label="Next month"
        >
          <ChevronRight size={13} strokeWidth={1.5} aria-hidden="true" />
        </button>
      </div>

      <div className="datepop__dow" aria-hidden="true">
        {dow.map((d, i) => (
          <span key={`${d}-${i}`} className="datepop__dowcell">
            {d}
          </span>
        ))}
      </div>

      <div ref={gridRef} className="datepop__grid" role="grid" onKeyDown={onGridKeyDown}>
        {days.map((d, i) => {
          if (!d) return <span key={`pad-${i}`} className="datepop__pad" />
          const iso = toISODate(d)
          const on = sameDay(d, selected)
          const isToday = sameDay(d, today)
          return (
            <button
              key={iso}
              type="button"
              data-date={iso}
              className={cx(
                'datepop__day',
                on && 'datepop__day--selected',
                isToday && 'datepop__day--today'
              )}
              tabIndex={iso === cursorIso ? 0 : -1}
              aria-pressed={on}
              aria-current={isToday ? 'date' : undefined}
              onClick={() => choose(d)}
            >
              {d.getDate()}
            </button>
          )
        })}
      </div>

      <div className="datepop__foot">
        <button
          type="button"
          className="datepop__act"
          onClick={() => {
            if (onClear) onClear()
            if (onClose) onClose()
          }}
        >
          CLEAR
        </button>
        <button type="button" className="datepop__act" onClick={() => choose(today)}>
          TODAY
        </button>
      </div>
    </Popover>
  )
}
