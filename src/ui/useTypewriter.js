/**
 * useTypewriter.js — how much of a text has been "typed" so far.
 *
 * Returns a character count that climbs from 0 to text.length, one frame at a
 * time, and starts again from 0 whenever the text changes. The caller slices;
 * this only keeps time — which keeps the re-render to the one component that
 * calls it, not the dashboard around it.
 *
 * The rhythm is not flat. A steady 60 characters a second reads as a progress
 * bar; a beat after a full stop or a dash reads as someone writing. The pauses
 * are worked out once per text as a schedule of when each character lands, so
 * a slow frame catches up rather than slowing the sentence down.
 */

import { useEffect, useMemo, useState } from 'react'

const PAUSE = [
  [/\n/, 420],
  [/[.?!]/, 220],
  [/[—–:;]/, 140],
  [/,/, 70],
]

function schedule(text, perChar) {
  const at = new Array(text.length)
  let t = 0
  for (let i = 0; i < text.length; i++) {
    t += perChar
    at[i] = t
    /* The beat comes after the mark and before the next word, so it is only
       taken when the mark ends a word — "3.5" and "e.g." keep typing. A
       newline is a paragraph break and always takes its beat. */
    const next = text[i + 1]
    if (next === undefined || /\s/.test(next) || text[i] === '\n') {
      for (const [re, ms] of PAUSE) if (re.test(text[i])) { t += ms; break }
    }
  }
  return at
}

function reducedMotion() {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}

export default function useTypewriter(text, { cps = 65, delay = 0 } = {}) {
  const src = String(text || '')
  const at = useMemo(() => schedule(src, 1000 / cps), [src, cps])

  /* Keyed on the text, so a new brief starts at 0 on its first render rather
     than flashing the old count's worth of the new text for a frame. */
  const [state, setState] = useState({ src, n: 0 })
  const n = state.src === src ? state.n : 0

  useEffect(() => {
    if (!src.length || reducedMotion()) {
      setState({ src, n: src.length })
      return
    }
    setState({ src, n: 0 })

    let raf = 0
    let t0 = null
    let i = 0
    const tick = (now) => {
      if (t0 === null) t0 = now + delay
      const elapsed = now - t0
      while (i < at.length && at[i] <= elapsed) i++
      setState((s) => (s.src === src && s.n === i ? s : { src, n: i }))
      if (i < at.length) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [src, at, delay])

  return { n, done: n >= src.length }
}
