import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

/**
 * useDeck — a stack of cards you page through with the wheel.
 *
 * Lifted out of Dashboard, which is where it was written and where the whole
 * argument for it lives. Repeating it here would be repeating it twice:
 *
 *   It used to latch — one card per gesture, and anything you did inside the
 *   next 420ms was thrown away. That is right for a deck you flick through on
 *   a trackpad and wrong for a wheel, which keeps coming. So there is no
 *   latch. The deck has a POSITION, which is a real number, and the wheel
 *   moves where that position is aiming for. The position chases the aim a
 *   fraction of the remaining distance every frame, which is what makes a long
 *   scroll one continuous movement through the deck rather than six jumps.
 *
 * Everything on the way is written straight onto the elements. A card's
 * opacity and offset are a function of how far it is from the position, and
 * recomputing that in React sixty times a second would be sixty renders to
 * move two numbers. The only thing that goes through state is WHICH card is
 * settled on — that changes once per card, and it decides the dots, the tab
 * order and what a screen reader is told.
 *
 * The caller owns the markup and the class names. All this owns is the
 * arithmetic, which is the part that took the tuning.
 *
 * @param count how many cards are in the stack
 * @param shift how far apart the cards sit, in pixels of vertical offset
 * @param shrink how much a card loses in scale as it goes behind
 * @returns { index, frameRef, stackRef, goTo, onKeyDown }
 */

/* How much wheel is one card. A mouse notch arrives as a single large delta
   and is worth exactly one card; a trackpad arrives as a stream of small ones
   and accumulates, or a flick would throw the deck end to end. */
const NOTCH = 90
const GLIDE = 170

/* Two cards either side is all anyone can see through; the rest are not worth
   a style write per frame. */
const REACH = 1.3

export default function useDeck(count, { shift = 62, shrink = 0.055 } = {}) {
  const [at, setAt] = useState(0)
  const index = Math.min(at, Math.max(0, count - 1))

  /* The element the wheel is read from, and the element the cards are in.
     Two, not one, because the frame usually holds the dots as well and a
     wheel over the dots should still page the deck. */
  const frameRef = useRef(null)
  const stackRef = useRef(null)

  const posRef = useRef(0)
  const aimRef = useRef(0)
  const rafRef = useRef(0)
  const settleRef = useRef(0)

  const lay = useCallback(() => {
    const stack = stackRef.current
    if (!stack) return
    const pos = posRef.current
    const kids = stack.children
    for (let i = 0; i < kids.length; i += 1) {
      const el = kids[i]
      const d = i - pos
      const m = Math.abs(d)
      if (m > REACH) {
        if (el.style.visibility !== 'hidden') {
          el.style.visibility = 'hidden'
          el.style.opacity = '0'
        }
        continue
      }
      el.style.visibility = 'visible'
      el.style.opacity = String(Math.max(0, 1 - m * 1.15).toFixed(3))
      el.style.transform =
        `translateY(${(d * shift).toFixed(1)}px) scale(${(1 - Math.min(m, 1) * shrink).toFixed(4)})`
    }
  }, [shift, shrink])

  const tick = useCallback(() => {
    rafRef.current = 0
    const aim = aimRef.current
    const gap = aim - posRef.current
    /* A fifth of what is left, every frame. Fast enough to keep up with a
       wheel being spun and slow enough that stopping is a glide rather than a
       stop. */
    posRef.current = Math.abs(gap) < 0.0015 ? aim : posRef.current + gap * 0.19
    lay()
    const now = Math.round(posRef.current)
    setAt((v) => (v === now ? v : now))
    if (posRef.current !== aim) rafRef.current = requestAnimationFrame(tick)
  }, [lay])

  const goTo = useCallback(
    (next) => {
      aimRef.current = Math.max(0, Math.min(count - 1, next))
      const still =
        document.documentElement.dataset.motion === 'reduced' ||
        window.matchMedia('(prefers-reduced-motion: reduce)').matches
      if (still) {
        /* No glide to watch: the position is the aim, and the only thing left
           is to put the cards where they belong. */
        posRef.current = aimRef.current
        lay()
        setAt(Math.round(posRef.current))
        return
      }
      if (!rafRef.current) rafRef.current = requestAnimationFrame(tick)
    },
    [count, lay, tick]
  )

  const onWheel = useCallback(
    (e) => {
      const step = Math.abs(e.deltaY) > Math.abs(e.deltaX) ? e.deltaY : e.deltaX
      if (!step) return
      e.preventDefault()
      const bump = Math.abs(step) >= NOTCH ? Math.sign(step) : step / GLIDE
      goTo(aimRef.current + bump)
      /* A trackpad can leave the aim between two cards. Once it stops coming,
         the deck takes the nearer one. A wheel never needs this — its notches
         are whole cards — but it costs nothing to let it settle too. */
      clearTimeout(settleRef.current)
      settleRef.current = setTimeout(() => goTo(Math.round(aimRef.current)), 150)
    },
    [goTo]
  )

  /* preventDefault has to be told it is coming, and React's onWheel is
     passive, so the listener is attached by hand. */
  useEffect(() => {
    const el = frameRef.current
    if (!el) return undefined
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [onWheel])

  useEffect(
    () => () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      clearTimeout(settleRef.current)
    },
    []
  )

  /* Where the cards start, and where they go if the deck changes length under
     them. Before paint, so the first card is never seen arriving. */
  useLayoutEffect(() => {
    if (posRef.current > count - 1) {
      posRef.current = Math.max(0, count - 1)
      aimRef.current = posRef.current
    }
    lay()
  }, [lay, count])

  const onKeyDown = useCallback(
    (e) => {
      const back = e.key === 'ArrowUp' || e.key === 'ArrowLeft' || e.key === 'PageUp'
      const fwd = e.key === 'ArrowDown' || e.key === 'ArrowRight' || e.key === 'PageDown'
      if (!back && !fwd) return
      e.preventDefault()
      goTo(Math.round(aimRef.current) + (fwd ? 1 : -1))
    },
    [goTo]
  )

  return { index, frameRef, stackRef, goTo, onKeyDown }
}
