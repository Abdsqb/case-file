import { useId } from 'react'

/* ---------------------------------------------------------------------------
 * charts.jsx — every chart in the dashboard, as pure inline SVG.
 *
 * No dependencies, no measurement, no layout effects: each chart is responsive
 * by construction (viewBox scaling or percentage geometry) so it fills its
 * bento card at any width and never overflows it.
 *
 * Colour NEVER appears as a literal here. Marks paint from the design tokens
 * (var(--bar), var(--bar-dim), var(--sage), …) or from `currentColor` so a
 * chart dropped on a sage card inverts with the card instead of disappearing.
 * ------------------------------------------------------------------------- */

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

const list = (v) => (Array.isArray(v) ? v : [])
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v)
const cx = (...parts) => parts.filter(Boolean).join(' ')

/* The Trend glyph is redrawn here rather than imported from primitives.jsx so
 * that charts.jsx stays a leaf module with zero internal dependencies. It is
 * visually identical: a 7px chevron-arrow that inherits currentColor. */
function TrendGlyph({ dir }) {
  if (dir !== 'up' && dir !== 'down') return null
  const up = dir === 'up'
  return (
    <svg
      className={cx('trendglyph', up ? 'trendglyph--up' : 'trendglyph--down')}
      width="7"
      height="8"
      viewBox="0 0 7 8"
      fill="none"
      focusable="false"
      aria-hidden="true"
      style={{ display: 'block', flex: '0 0 auto' }}
    >
      <path
        d={up ? 'M3.5 7.5V0.8' : 'M3.5 0.5v6.7'}
        stroke="currentColor"
        strokeWidth="1"
        strokeLinecap="round"
      />
      <path
        d={up ? 'M0.9 3.2 3.5 0.6l2.6 2.6' : 'M0.9 4.8 3.5 7.4l2.6-2.6'}
        stroke="currentColor"
        strokeWidth="1"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/* ===========================================================================
 * MiniBars — the signature chart.
 * 2px bars, 3px gaps, bottom-aligned, no axis, no labels. Bars under 12% of
 * max still render at 12% so the baseline reads as a texture, not as gaps.
 *
 * The viewBox is sized from the data length (2px bar + 3px gap pitch) and
 * stretched with preserveAspectRatio="none", so the run of bars always fills
 * the card. Bars are drawn as strokes with vector-effect="non-scaling-stroke"
 * so that horizontal stretching spreads them across the width without ever
 * fattening them: they stay exactly 2px at any card width. The vertical scale
 * is 1:1 (viewBox height === rendered height), so bar heights are exact px.
 * ========================================================================= */
const BAR_W = 2
const BAR_GAP = 3
const BAR_FLOOR = 0.12

export function MiniBars({ data, height = 92, className, label }) {
  const values = list(data).map(num)
  const n = values.length
  const pitch = BAR_W + BAR_GAP
  const vbWidth = n > 0 ? n * BAR_W + (n - 1) * BAR_GAP : 1
  const max = values.reduce((m, v) => (v > m ? v : m), 0)

  return (
    <svg
      className={cx('minibars', className)}
      viewBox={`0 0 ${vbWidth} ${height}`}
      preserveAspectRatio="none"
      shapeRendering="geometricPrecision"
      focusable="false"
      role={label ? 'img' : 'presentation'}
      aria-label={label || undefined}
      aria-hidden={label ? undefined : 'true'}
      style={{
        display: 'block',
        width: '100%',
        maxWidth: '100%',
        height: `${height}px`,
      }}
    >
      {label ? <title>{label}</title> : null}
      {values.map((v, i) => {
        const frac = max > 0 ? Math.max(BAR_FLOOR, v / max) : BAR_FLOOR
        const h = Math.max(1, frac * height)
        const x = i * pitch + BAR_W / 2
        return (
          <line
            key={i}
            className="minibars__bar"
            x1={x}
            x2={x}
            y1={height}
            y2={height - h}
            strokeWidth={BAR_W}
            vectorEffect="non-scaling-stroke"
            style={{ stroke: 'var(--bar)' }}
          />
        )
      })}
    </svg>
  )
}

/* ===========================================================================
 * WeekTable — seven equal columns, one per day.
 * Day name + trend glyph on one line, the value below. The active column is a
 * full-height sage block with dark text. A single continuous 6px bar sits
 * under the row in --bar-dim, with the active column's segment in --sage.
 * ========================================================================= */
export function WeekTable({ rows, className }) {
  const cols = list(rows)
  const n = cols.length
  if (n === 0) return null

  const track = `repeat(${n}, minmax(0, 1fr))`

  return (
    <div
      className={cx('weektable', className)}
      style={{ width: '100%', maxWidth: '100%', boxSizing: 'border-box' }}
    >
      <div
        className="weektable__row"
        style={{
          display: 'grid',
          gridTemplateColumns: track,
          alignItems: 'stretch',
          gap: '2px',
        }}
      >
        {cols.map((row, i) => {
          const active = !!(row && row.active)
          return (
            <div
              key={(row && row.key) || i}
              className={cx('weektable__col', active && 'weektable__col--active')}
              style={{
                minWidth: 0,
                boxSizing: 'border-box',
                display: 'flex',
                flexDirection: 'column',
                gap: '8px',
                padding: '10px 6px 12px',
                borderRadius: active ? 'var(--radius-sm)' : 0,
                background: active ? 'var(--sage)' : 'transparent',
                color: active ? 'var(--on-sage)' : 'var(--fg-mid)',
              }}
            >
              <span
                className="weektable__day"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '4px',
                  fontSize: '11px',
                  lineHeight: 1,
                  minWidth: 0,
                  overflow: 'hidden',
                }}
              >
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {row && row.key}
                </span>
                <TrendGlyph dir={row && row.dir} />
              </span>
              <span
                className="weektable__value"
                style={{
                  fontSize: '11px',
                  lineHeight: 1.35,
                  textAlign: 'center',
                  fontVariantNumeric: 'tabular-nums',
                  color: active ? 'var(--on-sage)' : 'var(--fg)',
                  overflowWrap: 'anywhere',
                }}
              >
                {row && row.value != null ? row.value : '—'}
                {row && row.unit ? (
                  <span
                    className="weektable__unit"
                    style={{ color: active ? 'var(--on-sage-dim)' : 'var(--fg-dim)' }}
                  >
                    {' '}
                    {row.unit}
                  </span>
                ) : null}
              </span>
            </div>
          )
        })}
      </div>

      <div
        className="weektable__bar"
        style={{
          display: 'grid',
          gridTemplateColumns: track,
          height: '6px',
          marginTop: '10px',
          borderRadius: '3px',
          overflow: 'hidden',
          background: 'var(--bar-dim)',
        }}
      >
        {cols.map((row, i) => {
          const active = !!(row && row.active)
          return (
            <span
              key={(row && row.key) || i}
              className={cx('weektable__seg', active && 'weektable__seg--active')}
              style={{
                display: 'block',
                height: '6px',
                background: active ? 'var(--sage)' : 'transparent',
              }}
            />
          )
        })}
      </div>
    </div>
  )
}

/* ===========================================================================
 * DotMatrix — the bottom-of-page printed matrix.
 * A real grid of 3px dots, `rows` tall, one column per bucket, lit from the
 * bottom. Row pitch is fixed at 8px (3px dot + 5px gap); column pitch is a
 * percentage of the container so the dots stay perfectly round and the matrix
 * fills the card at any width — at the reference density that lands on the
 * specified 6px column gap.
 * ========================================================================= */
const DOT = 3
const DOT_R = DOT / 2
const DOT_ROW_GAP = 5
const DOT_ROW_PITCH = DOT + DOT_ROW_GAP

export function DotMatrix({ columns, rows = 12, labels = DAYS, className, label }) {
  const cols = list(columns).map(num)
  const n = cols.length
  const rowCount = Math.max(1, Math.round(num(rows)) || 1)
  const height = rowCount * DOT + (rowCount - 1) * DOT_ROW_GAP
  const heads = list(labels)

  /* Values are 0..1 per the contract; if a caller hands us raw counts we
   * normalise against the tallest column instead of clipping everything. */
  const peak = cols.reduce((m, v) => (v > m ? v : m), 0)
  const scale = peak > 1 ? peak : 1

  return (
    <div
      className={cx('dotmatrix', className)}
      style={{ width: '100%', maxWidth: '100%', boxSizing: 'border-box' }}
    >
      {heads.length > 0 ? (
        <div
          className="dotmatrix__head"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            marginBottom: '12px',
            fontSize: '11px',
            lineHeight: 1,
            color: 'var(--fg-mid)',
          }}
        >
          <span className="dotmatrix__arrow" aria-hidden="true">
            &#8592;
          </span>
          <span
            style={{
              flex: '1 1 auto',
              minWidth: 0,
              display: 'flex',
              justifyContent: 'space-between',
              gap: '6px',
              overflow: 'hidden',
            }}
          >
            {heads.map((d, i) => (
              <span key={`${d}-${i}`} className="dotmatrix__day">
                {d}
              </span>
            ))}
          </span>
          <span className="dotmatrix__arrow" aria-hidden="true">
            &#8594;
          </span>
        </div>
      ) : null}

      <svg
        className="dotmatrix__grid"
        width="100%"
        height={height}
        focusable="false"
        role={label ? 'img' : 'presentation'}
        aria-label={label || undefined}
        aria-hidden={label ? undefined : 'true'}
        style={{ display: 'block', width: '100%', maxWidth: '100%', height: `${height}px` }}
      >
        {label ? <title>{label}</title> : null}
        {cols.map((v, c) => {
          const lit = Math.round(clamp01(v / scale) * rowCount)
          const left = `${(((c + 0.5) / n) * 100).toFixed(4)}%`
          return (
            <g key={c} className="dotmatrix__col">
              {Array.from({ length: rowCount }, (_, r) => (
                <circle
                  key={r}
                  className={cx('dotmatrix__dot', r < lit && 'dotmatrix__dot--on')}
                  cx={left}
                  cy={height - DOT_R - r * DOT_ROW_PITCH}
                  r={DOT_R}
                  style={{ fill: r < lit ? 'var(--bar)' : 'var(--bar-dim)' }}
                />
              ))}
            </g>
          )
        })}
      </svg>
    </div>
  )
}

/* ===========================================================================
 * TimelineDots — a 1px rule with 13px circles, labels below.
 * Filled dots are solid, unfilled are a 1px ring; the rule is masked out
 * behind every dot so nothing draws through the rings. Everything paints from
 * currentColor, so the component reads correctly on a dark card and on sage.
 * ========================================================================= */
const TD_R = 6
const TD_H = 14

export function TimelineDots({ points, className }) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '')
  const pts = list(points)
  const n = pts.length
  if (n === 0) return null

  const maskId = `td-${uid}`
  const centre = (i) => `${(((i + 0.5) / n) * 100).toFixed(4)}%`

  return (
    <div
      className={cx('timelinedots', className)}
      style={{ width: '100%', maxWidth: '100%', boxSizing: 'border-box' }}
    >
      <svg
        className="timelinedots__track"
        width="100%"
        height={TD_H}
        focusable="false"
        aria-hidden="true"
        style={{ display: 'block', width: '100%', maxWidth: '100%', height: `${TD_H}px` }}
      >
        <defs>
          <mask id={maskId} maskUnits="userSpaceOnUse">
            <rect x="0" y="0" width="100%" height={TD_H} fill="#fff" />
            {pts.map((_, i) => (
              <circle key={i} cx={centre(i)} cy={TD_H / 2} r={TD_R + 1.5} fill="#000" />
            ))}
          </mask>
        </defs>

        <line
          className="timelinedots__rule"
          x1="0"
          x2="100%"
          y1={TD_H / 2}
          y2={TD_H / 2}
          stroke="currentColor"
          strokeWidth="1"
          strokeOpacity="0.22"
          mask={`url(#${maskId})`}
        />

        {pts.map((p, i) => {
          const filled = !!(p && p.filled)
          return (
            <circle
              key={i}
              className={cx('timelinedots__dot', filled && 'timelinedots__dot--filled')}
              cx={centre(i)}
              cy={TD_H / 2}
              r={filled ? TD_R + 0.5 : TD_R}
              fill={filled ? 'currentColor' : 'none'}
              stroke={filled ? 'none' : 'currentColor'}
              strokeWidth={filled ? 0 : 1}
              strokeOpacity={filled ? 1 : 0.38}
            />
          )
        })}
      </svg>

      <div
        className="timelinedots__labels"
        style={{
          display: 'grid',
          gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))`,
          marginTop: '10px',
        }}
      >
        {pts.map((p, i) => (
          <span
            key={i}
            className={cx(
              'timelinedots__label',
              p && p.filled && 'timelinedots__label--active'
            )}
            style={{
              fontSize: '11px',
              lineHeight: 1,
              textAlign: 'center',
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              fontVariantNumeric: 'tabular-nums',
              color: 'currentColor',
              opacity: p && p.filled ? 1 : 0.55,
            }}
          >
            {p && p.label != null ? p.label : ''}
          </span>
        ))}
      </div>
    </div>
  )
}

/* ===========================================================================
 * Sparkline — a 1px polyline in --fg-mid, no fill, no markers.
 * Stretched horizontally with preserveAspectRatio="none"; the stroke is held
 * at a true 1px with vector-effect so the scaling never thickens it.
 * ========================================================================= */
export function Sparkline({ data, height = 28, className, label }) {
  const values = list(data).map(num)
  const n = values.length
  const pad = 1
  const inner = Math.max(1, height - pad * 2)

  let points = ''
  if (n === 1) {
    const y = pad + inner / 2
    points = `0,${y} 100,${y}`
  } else if (n > 1) {
    let min = values[0]
    let max = values[0]
    for (const v of values) {
      if (v < min) min = v
      if (v > max) max = v
    }
    const flat = max === min
    const span = flat ? 1 : max - min
    points = values
      .map((v, i) => {
        const x = (i / (n - 1)) * 100
        const y = flat ? pad + inner / 2 : pad + (1 - (v - min) / span) * inner
        return `${x.toFixed(3)},${y.toFixed(3)}`
      })
      .join(' ')
  }

  return (
    <svg
      className={cx('sparkline', className)}
      viewBox={`0 0 100 ${height}`}
      preserveAspectRatio="none"
      focusable="false"
      role={label ? 'img' : 'presentation'}
      aria-label={label || undefined}
      aria-hidden={label ? undefined : 'true'}
      style={{ display: 'block', width: '100%', maxWidth: '100%', height: `${height}px` }}
    >
      {label ? <title>{label}</title> : null}
      {points ? (
        <polyline
          className="sparkline__line"
          points={points}
          fill="none"
          stroke="var(--fg-mid)"
          strokeWidth="1"
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      ) : null}
    </svg>
  )
}
