/**
 * Rail.jsx — the details panel down the side of a page, as Linear has one on
 * a project: the work in the middle, and everything measured about it in one
 * quiet column at the side (the right, as Linear has it) — its properties, its progress, its graphs — all
 * on show at once rather than paged behind tabs.
 *
 *   <WithRail rail={<Rail label="…">…sections…</Rail>}>…the page…</WithRail>
 *
 * On a wide screen the rail is fixed to the page's right edge and scrolls on
 * its own; the pagebar's panel button hides it (settings: casefile.rail).
 * Narrower, it drops under the page and its sections tile.
 */

import { useEffect, useRef, useState } from 'react'

const cx = (...c) => c.filter(Boolean).join(' ')

export function WithRail({ rail, children }) {
  if (!rail) return children
  return (
    <div className="withrail">
      <div className="withrail__main">{children}</div>
      {rail}
    </div>
  )
}

export function Rail({ label, children }) {
  return (
    <aside className="rail" aria-label={label}>
      <div className="rail__inner">{children}</div>
    </aside>
  )
}

/** One block of the rail: a small grey heading, an optional control on the
    right of it, then its contents. */
export function RailSection({ title, right, children, className }) {
  return (
    <section className={cx('rail__sec', className)}>
      <header className="rail__head">
        <h2 className="rail__title">{title}</h2>
        {right ? <div className="rail__right">{right}</div> : null}
      </header>
      <div className="rail__body">{children}</div>
    </section>
  )
}

/** A property row: the name in grey on the left, its value on the right. */
export function RailProp({ label, children, tone, onClick, title }) {
  const Tag = onClick ? 'button' : 'div'
  return (
    <Tag
      className={cx('rail__prop', onClick && 'is-action')}
      onClick={onClick}
      type={onClick ? 'button' : undefined}
      title={title}
    >
      <span className="rail__key">{label}</span>
      <span className={cx('rail__val', tone && `is-${tone}`)}>{children}</span>
    </Tag>
  )
}

/** A few words to pick between, Linear's small segmented control. */
export function RailSeg({ options, value, onChange, label }) {
  return (
    <div className="rail__seg" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          className={cx('rail__segitem', o.value === value && 'is-on')}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

/** Progress as Linear draws a project's: a ring, the percent beside it. */
export function RailRing({ value, size = 40 }) {
  const v = Math.max(0, Math.min(1, Number(value) || 0))
  const r = (size - 5) / 2
  const c = 2 * Math.PI * r
  return (
    <svg className="rail__ring" width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
      <circle cx={size / 2} cy={size / 2} r={r} className="rail__ringtrack" />
      {v > 0 ? (
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        className="rail__ringfill"
        strokeDasharray={`${c * v} ${c}`}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
      ) : null}
    </svg>
  )
}

const dayLabel = (daysAgo, now) => {
  if (daysAgo === 0) return 'Today'
  if (daysAgo === 1) return 'Yesterday'
  const d = new Date(now)
  d.setDate(d.getDate() - daysAgo)
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
}

/**
 * A day-by-day column chart sized for the rail: one series, oldest on the
 * left and today on the right, rounded tops on a baseline, and a readout of
 * whichever day the pointer (or a tap) is on. No legend — the section's
 * heading names it.
 */
export function RailBars({ data, now, tone, height: tall = 64, unit = 'entries', label }) {
  const ref = useRef(null)
  const [w, setW] = useState(0)
  const [hot, setHot] = useState(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return undefined
    const ro = new ResizeObserver(([e]) => setW(Math.round(e.contentRect.width)))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const values = (Array.isArray(data) ? data : []).map((v) => (Number.isFinite(v) ? v : 0))
  const n = values.length
  const max = Math.max(1, ...values)
  const total = values.reduce((a, b) => a + b, 0)
  /* Nothing in the window: a baseline and a line saying so, not a tall
     empty box. */
  const height = total ? tall : 10
  const slot = n ? w / n : 0
  const gap = slot > 8 ? 2 : 1
  const bw = Math.max(1, slot - gap)
  const r = Math.min(2, bw / 2)
  const i = hot ?? n - 1
  const shown = n ? values[i] : 0

  const pick = (clientX) => {
    const box = ref.current?.getBoundingClientRect()
    if (!box || !n) return
    setHot(Math.max(0, Math.min(n - 1, Math.floor(((clientX - box.left) / box.width) * n))))
  }

  return (
    <div className={cx('railbars', tone && `is-${tone}`)}>
      <div className="railbars__read" aria-live="polite">
        {total ? (
          <>
            <span className="railbars__num">{shown}</span>
            <span className="railbars__when">{n ? dayLabel(n - 1 - i, now) : ''}</span>
            <span className="railbars__total">{total} in {n}d</span>
          </>
        ) : (
          <span className="railbars__when">None in {n} days</span>
        )}
      </div>
      <div
        className="railbars__plot"
        ref={ref}
        onMouseMove={(e) => pick(e.clientX)}
        onMouseLeave={() => setHot(null)}
        onClick={(e) => pick(e.clientX)}
        role="img"
        aria-label={label || `${total} ${unit} over ${n} days`}
      >
        {w ? (
          <svg width={w} height={height} aria-hidden="true">
            <line className="railbars__base" x1={0} x2={w} y1={height - 0.5} y2={height - 0.5} />
            {values.map((v, k) => {
              if (!v) return null
              const h = Math.max(2, (v / max) * (height - 4))
              const x = k * slot + gap / 2
              const y = height - h
              return (
                <path
                  key={k}
                  className={cx('railbars__bar', k === i && 'is-hot')}
                  d={`M${x},${height} V${y + r} Q${x},${y} ${x + r},${y} H${x + bw - r} Q${x + bw},${y} ${x + bw},${y + r} V${height} Z`}
                />
              )
            })}
            {hot !== null ? (
              <line className="railbars__cursor" x1={hot * slot + slot / 2} x2={hot * slot + slot / 2} y1={0} y2={height} />
            ) : null}
          </svg>
        ) : null}
      </div>
    </div>
  )
}
