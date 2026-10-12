/**
 * FlowFullscreen.jsx — a case's structure, the whole window to itself.
 *
 * The Case files board is a turned panel sharing the screen with the entries,
 * and a busy case drawn small enough to fit it is a case you cannot read. A
 * click on the board lifts the drawing out of it: it grows from where it sat
 * on the board to fill the window, over a blur of the page, and tilts a little
 * toward the pointer so the cards, standing off the wires, move against them.
 * Esc or another click sends it back into the board the way it came.
 *
 * Three things, three elements, because they cannot share one:
 *
 *   veil   the blur, and the only thing that fades. An opacity on anything
 *          holding the drawing would flatten its 3D for the length of the fade.
 *   morph  the grow and the shrink — one transform, run by the Web Animations
 *          API from the board's box to the window's and back (a FLIP).
 *   tilt   the parallax. A rotation driven by --gx / --gy, written on this
 *          element only, never on the root (a custom property on <html>
 *          restyles the whole page every frame).
 *
 * The board's copy is turned in 3D and this one is flat, so the two can never
 * line up exactly. Rather than swap one for the other in a frame — which read
 * as a snap from flat to turned at the end of the trip back — they crossfade
 * where they overlap: at the start of the grow, and over the last stretch of
 * the shrink. Only the leaves fade (each card, the wires, the labels), never
 * the layers holding them, for the reason above. And the
 * streak is held still: a blur the size of the window over a moving picture is
 * the most expensive thing the app can draw, every frame it moves.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'

import CaseFlow from './CaseFlow.jsx'
import { STREAK_HOLD_EVENT } from './Streak.jsx'

const OPEN_MS = 560
const CLOSE_MS = 440
/* How far into the shrink the crossfade back to the board begins. Late enough
   that the drawing is nearly the board's size, early enough that the fade has
   finished by the time it lands. */
const HANDBACK_AT = 0.5
const EASE_OUT = 'cubic-bezier(0.16, 1, 0.3, 1)'
const EASE_IN_OUT = 'cubic-bezier(0.55, 0, 0.25, 1)'

function stillMotion() {
  try {
    return document.documentElement.dataset.motion === 'reduced'
      || window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}

function holdStreak(on) {
  window.dispatchEvent(new CustomEvent(STREAK_HOLD_EVENT, { detail: { on } }))
}

/* The transform that puts the full-window drawing exactly over the board's.
   Both drawings are centred in their boxes, so matching their centres and
   their widths matches them. Origin at the morph's top-left, so the arithmetic
   is in page coordinates and does not depend on its size. The board is turned
   in 3D, so its box is the projected one — close enough that the eye takes the
   handover as one object moving. */
function boardTransform(fromEl, morphEl) {
  const from = fromEl && fromEl.querySelector('.flow__scene')
  const to = morphEl && morphEl.querySelector('.flow__scene')
  if (!from || !to) return null
  const a = from.getBoundingClientRect()
  const b = to.getBoundingClientRect()
  const o = morphEl.getBoundingClientRect()
  if (!a.width || !b.width) return null
  const k = a.width / b.width
  const tx = (a.left + a.width / 2) - o.left - k * ((b.left + b.width / 2) - o.left)
  const ty = (a.top + a.height / 2) - o.top - k * ((b.top + b.height / 2) - o.top)
  return `translate(${tx.toFixed(1)}px, ${ty.toFixed(1)}px) scale(${k.toFixed(4)})`
}

export default function FlowFullscreen({ cases, rootId, now, focus, title, subtitle, from, onClose }) {
  const [on, setOn] = useState(false)
  /* Whether this drawing's leaves are showing — separate from `on`, because
     on the way out the veil goes at once but the drawing stays until the
     handback. */
  const [shown, setShown] = useState(false)
  const morphRef = useRef(null)
  const tiltRef = useRef(null)
  const closeRef = useRef(null)
  const returnTo = useRef(null)
  const closing = useRef(false)
  const board = from ? from.closest('.caseboard') : null

  /* ---- arriving --------------------------------------------------------- */

  useLayoutEffect(() => {
    const morph = morphRef.current
    returnTo.current = document.activeElement
    holdStreak(true)

    if (stillMotion() || !morph) {
      if (board) board.classList.add('is-lifted')
      setOn(true)
      setShown(true)
      return undefined
    }

    /* Hidden for one frame: the drawing fits itself to the window in a layout
       effect of its own, and the start of the grow has to be measured off the
       fitted drawing, not the unfitted one. */
    morph.style.visibility = 'hidden'
    const raf = requestAnimationFrame(() => {
      const start = boardTransform(from, morph)
      morph.style.visibility = ''
      /* The handover: the board's drawing fades out as this one fades in,
         while this one is still sitting on top of it. */
      if (board) board.classList.add('is-lifted')
      setOn(true)
      setShown(true)
      if (start) {
        morph.animate([{ transform: start }, { transform: 'none' }], {
          duration: OPEN_MS,
          easing: EASE_OUT,
        })
      }
    })
    return () => cancelAnimationFrame(raf)
    // Once, on arrival.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (closeRef.current) closeRef.current.focus({ preventScroll: true })
    return () => {
      holdStreak(false)
      if (board) board.classList.remove('is-lifted')
      const back = returnTo.current
      if (back && typeof back.focus === 'function') back.focus({ preventScroll: true })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /* ---- leaving ---------------------------------------------------------- */

  const close = useCallback(() => {
    if (closing.current) return
    closing.current = true
    setOn(false)

    const tilt = tiltRef.current
    if (tilt) {
      tilt.style.setProperty('--gx', '0')
      tilt.style.setProperty('--gy', '0')
    }

    const morph = morphRef.current
    const end = !stillMotion() && morph ? boardTransform(from, morph) : null
    if (!end) {
      onClose()
      return
    }

    /* The handback, part way down: this drawing fades out over the board's
       as the board's fades back in, turned, where it always was. */
    setTimeout(() => {
      setShown(false)
      if (board) board.classList.remove('is-lifted')
    }, CLOSE_MS * HANDBACK_AT)
    const run = morph.animate([{ transform: 'none' }, { transform: end }], {
      duration: CLOSE_MS,
      easing: EASE_IN_OUT,
      fill: 'forwards',
    })
    /* Finished, or a little after it should have — an animation can stall
       (a tab sent to the background mid-close), and a view that never goes
       away is worse than one that goes a frame early. */
    let done = false
    const finish = () => {
      if (done) return
      done = true
      onClose()
    }
    run.onfinish = finish
    setTimeout(finish, CLOSE_MS + 250)
  }, [from, onClose, board])

  /* Capture phase, so Escape closes this before anything underneath —
     the scratchpad drawer listens for it too. */
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      close()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [close])

  /* ---- the parallax ----------------------------------------------------- */

  /* Where the pointer is over the window, -1 to 1, written onto the tilt and
     nowhere else, once a frame at most. CSS turns it into the rotation and
     smooths it, so a flick of the mouse is a lean rather than a jerk. */
  const field = useRef({ raf: 0, x: 0, y: 0 })
  const onMove = useCallback((e) => {
    if (closing.current) return
    const f = field.current
    f.x = Math.max(-1, Math.min(1, (e.clientX / window.innerWidth) * 2 - 1))
    f.y = Math.max(-1, Math.min(1, (e.clientY / window.innerHeight) * 2 - 1))
    if (f.raf) return
    f.raf = requestAnimationFrame(() => {
      f.raf = 0
      const tilt = tiltRef.current
      if (!tilt) return
      tilt.style.setProperty('--gx', f.x.toFixed(3))
      tilt.style.setProperty('--gy', f.y.toFixed(3))
    })
  }, [])

  useEffect(() => () => cancelAnimationFrame(field.current.raf), [])

  return createPortal(
    <div
      className={`flowfull${on ? ' is-on' : ''}${shown ? ' is-shown' : ''}`}
      role="dialog"
      aria-modal="true"
      aria-label={`Case structure: ${title}`}
      onPointerMove={onMove}
    >
      <div className="flowfull__veil" aria-hidden="true" onClick={close} />

      <header className="flowfull__bar">
        <div className="flowfull__titles">
          <span className="flowfull__kicker">case structure</span>
          <h2 className="flowfull__title">{title}</h2>
          {subtitle ? <span className="flowfull__sub">{subtitle}</span> : null}
        </div>
        <span className="flowfull__hint">esc</span>
        <button
          ref={closeRef}
          type="button"
          className="flowfull__close"
          onClick={close}
          aria-label="Close"
          title="Close"
        >
          <X size={16} strokeWidth={1.8} aria-hidden="true" />
        </button>
      </header>

      <div className="flowfull__stage">
        <div className="flowfull__morph" ref={morphRef}>
          <div className="flowfull__tilt" ref={tiltRef}>
            <CaseFlow
              cases={cases}
              rootId={rootId}
              now={now}
              focus={focus}
              chrome={false}
              maxScale={1.6}
              onExpand={close}
              expandTitle="Click to put it back"
              className="flowfull__flow"
            />
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}
