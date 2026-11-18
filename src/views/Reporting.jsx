/**
 * Reporting.jsx — the queue, read-only, in three tables plus the wire.
 *
 *   Overdue · This week · Later   — every open entry, bucketed by its due day
 *   Signals                        — GET /api/headlines, as tip cards
 *
 * The headline feed is an outside dependency and it is frequently down. That
 * is a normal state here, not a crash: it loads, it empties and it fails in
 * the same card, with the same typography, and the last good copy stays on
 * screen when a refresh fails. It polls every five minutes and never faster.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ExternalLink, RefreshCw } from 'lucide-react'
import { Card, CardHead, EmptyState, Meter, Pill } from '../ui/primitives.jsx'
import { SegmentIsland } from '../ui/CaseIslands.jsx'
import { listHeadlines, listProjects, moveProject } from '../lib/api.js'
import { dayDiff, flattenEntries, startOfDay, statusTone } from '../lib/metrics.js'
import { applyWalk, siblingWalk } from '../lib/reorder.js'
import { useSetting } from '../lib/settings.js'
import { caseColor } from '../ui/nav.js'

/** the wire is polled no more often than this. */
const POLL_MS = 300000

/* ------------------------------------------------------------------ *
 * helpers
 * ------------------------------------------------------------------ */

function cx(...parts) {
  return parts.filter(Boolean).join(' ')
}

function toMs(value) {
  if (value === null || value === undefined || value === '') return NaN
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN
  const n = Number(value)
  if (Number.isFinite(n) && String(value).trim() !== '') return n
  return Date.parse(value)
}

function addDays(ts, n) {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() + n)
  return d.getTime()
}

function fmtDate(ts) {
  const t = toMs(ts)
  if (!Number.isFinite(t)) return '—'
  try {
    return new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
  } catch {
    return '—'
  }
}

function fmtWeekday(ts) {
  const t = toMs(ts)
  if (!Number.isFinite(t)) return '—'
  try {
    return new Date(t).toLocaleDateString(undefined, { weekday: 'short' })
  } catch {
    return '—'
  }
}

/** '2m ago' … '3d ago', then a plain date. */
function relTime(value, now) {
  const t = toMs(value)
  if (!Number.isFinite(t)) return ''
  const diff = now - t
  if (diff < 60000) return 'just now'
  const mins = Math.floor(diff / 60000)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`
  return fmtDate(t)
}

/** Feed URLs come from outside the app — only ever follow http(s). */
function safeUrl(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return /^https?:\/\//i.test(trimmed) ? trimmed : null
}

/** An ApiError, said out loud in the app's voice. */
function describeError(err) {
  if (!err) return 'the feed did not answer.'
  if (err.status === 0) return 'the feed is unreachable — the server did not answer.'
  if (err.status === 404) return 'the feed endpoint is missing on this server.'
  if (err.status >= 500) return 'the feed is erroring upstream — try again shortly.'
  if (err.status) return `the feed returned ${err.status}.`
  return 'the feed did not answer.'
}

/* ------------------------------------------------------------------ *
 * data
 * ------------------------------------------------------------------ */

/** One clock: the app's if it passed one, ours otherwise. */
function useClock(external, interval = 30000) {
  const fixed =
    external instanceof Date
      ? external.getTime()
      : Number.isFinite(external)
        ? external
        : null
  const [tick, setTick] = useState(() => Date.now())

  useEffect(() => {
    if (fixed !== null) return undefined
    const id = setInterval(() => setTick(Date.now()), interval)
    return () => clearInterval(id)
  }, [fixed, interval])

  return fixed === null ? tick : fixed
}

/**
 * Cases from the prop when the app supplies them, from the API when it does
 * not — so this view is correct however it is mounted.
 */
function useProjects(external, onRefresh) {
  const provided = Array.isArray(external)
  const [state, setState] = useState({ data: [], status: provided ? 'ready' : 'loading', error: null })
  const gen = useRef(0)

  const load = useCallback(() => {
    const id = gen.current + 1
    gen.current = id
    setState((prev) => ({ ...prev, status: prev.data.length ? 'ready' : 'loading' }))
    listProjects()
      .then((rows) => {
        if (gen.current !== id) return
        setState({ data: Array.isArray(rows) ? rows.filter(Boolean) : [], status: 'ready', error: null })
      })
      .catch((err) => {
        if (gen.current !== id) return
        setState((prev) => ({ data: prev.data, status: 'error', error: err }))
      })
  }, [])

  useEffect(() => {
    if (provided) return undefined
    load()
    return () => {
      gen.current += 1
    }
  }, [provided, load])

  if (provided) {
    return {
      data: external,
      status: 'ready',
      error: null,
      reload: onRefresh || (() => {}),
    }
  }
  return { ...state, reload: load }
}

/** The wire. Polls every five minutes, keeps the last good copy on failure. */
function useHeadlines() {
  const [state, setState] = useState({
    items: [],
    status: 'loading',
    error: null,
    fetchedAt: 0,
  })
  const gen = useRef(0)
  const lastRun = useRef(0)

  const load = useCallback(() => {
    const id = gen.current + 1
    gen.current = id
    lastRun.current = Date.now()
    setState((prev) => ({ ...prev, status: prev.items.length ? 'refreshing' : 'loading' }))
    listHeadlines()
      .then((rows) => {
        if (gen.current !== id) return
        const items = (Array.isArray(rows) ? rows : []).filter(
          (row) => row && typeof row === 'object'
        )
        setState({ items, status: 'ready', error: null, fetchedAt: Date.now() })
      })
      .catch((err) => {
        if (gen.current !== id) return
        setState((prev) => ({
          items: prev.items,
          status: 'error',
          error: err,
          fetchedAt: prev.fetchedAt,
        }))
      })
  }, [])

  useEffect(() => {
    load()
    const id = setInterval(load, POLL_MS)
    // returning to the tab refetches only if a poll interval has already gone by
    const onFocus = () => {
      if (Date.now() - lastRun.current >= POLL_MS) load()
    }
    window.addEventListener('focus', onFocus)
    return () => {
      gen.current += 1
      clearInterval(id)
      window.removeEventListener('focus', onFocus)
    }
  }, [load])

  return { ...state, reload: load }
}

/* ------------------------------------------------------------------ *
 * table
 * ------------------------------------------------------------------ */

function ReportTable({ head, rows, cols }) {
  return (
    <div className="rtable" role="table" style={cols ? { '--rtable-cols': cols } : undefined}>
      <div className="rtable__head" role="row">
        <span className="rtable__cell" role="columnheader">
          {head[0]}
        </span>
        <span className="rtable__cell" role="columnheader">
          {head[1]}
        </span>
        <span className="rtable__cell rtable__cell--case" role="columnheader">
          {head[2]}
        </span>
        <span className="rtable__cell rtable__cell--right" role="columnheader">
          {head[3]}
        </span>
      </div>
      {rows.map((row) => (
        <div className="rtable__row" role="row" key={row.id}>
          <span className="rtable__cell rtable__cell--dim" role="cell">
            {row.day}
          </span>
          <span className="rtable__cell rtable__cell--strong" role="cell" title={row.title}>
            {row.sub ? '↳ ' : ''}
            {row.title}
          </span>
          <span className="rtable__cell rtable__cell--case" role="cell" title={row.caseName}>
            {row.caseId !== undefined ? (
              <span className="rtable__dot" style={{ '--dot': caseColor(row.caseId) }} aria-hidden="true" />
            ) : null}
            {row.caseName}
          </span>
          <span
            className={cx('rtable__cell', 'rtable__cell--right', row.tailClass)}
            role="cell"
          >
            {row.tail}
          </span>
        </div>
      ))}
    </div>
  )
}

function QueueCard({ title, subtitle, head, rows, cols, empty, span = 'span-4' }) {
  return (
    <Card className={span}>
      <CardHead
        className="card__head"
        title={title}
        subtitle={subtitle}
        right={<span className="micro dim">{rows.length}</span>}
      />
      <div className="card__body card__body--tight">
        {rows.length ? (
          <ReportTable head={head} rows={rows} cols={cols} />
        ) : (
          empty
        )}
      </div>
    </Card>
  )
}

/* ------------------------------------------------------------------ *
 * signals
 * ------------------------------------------------------------------ */

function Signal({ item, now, tone }) {
  const url = safeUrl(item.url)
  const source = typeof item.source === 'string' && item.source.trim() ? item.source.trim() : 'Wire'
  const title =
    typeof item.title === 'string' && item.title.trim() ? item.title.trim() : 'Untitled dispatch'
  const when = relTime(item.publishedAt, now)

  return (
    <article className={cx('tip', tone === 'sage' && 'tip--sage')}>
      <div className="tip__head">
        <span className="pill pill--micro">
          <span className="pill__label">{source}</span>
        </span>
        {when ? <span className="tip__note nowrap">{when}</span> : null}
      </div>
      <div className="tip__body">{title}</div>
      <div className="tip__meta">
        {url ? (
          <a className="tip__link" href={url} target="_blank" rel="noopener noreferrer">
            Open
            <ExternalLink size={12} strokeWidth={1.5} aria-hidden="true" />
            <span className="sr-only"> — {title} (opens in a new tab)</span>
          </a>
        ) : (
          <span className="tip__note">no link</span>
        )}
      </div>
    </article>
  )
}

/* ------------------------------------------------------------------ *
 * insights — Linear's way of reading a project: a row of numbers, then
 * the shape of the work as a bar chart
 * ------------------------------------------------------------------ */

function Stat({ label, value, sub, tone, meter }) {
  return (
    <Card className="span-3 stat">
      <div className="card__body">
        <span className="stat__label">{label}</span>
        <span className={cx('stat__value', tone === 'late' && 'is-late')}>{value}</span>
        {meter !== undefined ? <Meter value={meter} label={label} /> : null}
        <span className="stat__sub">{sub}</span>
      </div>
    </Card>
  )
}

/* Open work by when it is due: one bar a bucket, overdue first in red and
   undated last in grey. One series, so no legend — the card's title names
   it; a hover (or a tap) reads out a bar. */
function WorkloadBars({ bars }) {
  const ref = useRef(null)
  const [w, setW] = useState(0)
  const [hover, setHover] = useState(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return undefined
    const ro = new ResizeObserver(([e]) => setW(Math.round(e.contentRect.width)))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const H = 208
  const pad = { l: 28, r: 4, t: 14, b: 28 }
  const max = Math.max(1, ...bars.map((b) => b.value))
  const step = max <= 4 ? 1 : max <= 10 ? 2 : max <= 25 ? 5 : 10
  const top = Math.ceil(max / step) * step
  const ticks = []
  for (let v = 0; v <= top; v += step) ticks.push(v)
  const plotW = Math.max(0, w - pad.l - pad.r)
  const slot = plotW / bars.length
  const bw = Math.min(40, slot * 0.58)
  const compact = slot < 46
  const y = (v) => pad.t + (1 - v / top) * (H - pad.t - pad.b)
  const base = y(0)

  return (
    <div className="wbars" ref={ref} onMouseLeave={() => setHover(null)}>
      {w ? (
        <svg width={w} height={H} role="img" aria-label={bars.map((b) => `${b.tip}: ${b.value}`).join(', ')}>
          {ticks.map((v) => (
            <g key={v} className="wbars__grid">
              <line x1={pad.l} x2={w - pad.r} y1={y(v)} y2={y(v)} />
              <text x={pad.l - 8} y={y(v)} dy="0.32em" textAnchor="end">{v}</text>
            </g>
          ))}
          {bars.map((b, i) => {
            const mid = pad.l + slot * i + slot / 2
            const x = mid - bw / 2
            const yt = y(b.value)
            const h = base - yt
            const r = Math.min(4, bw / 2, h)
            return (
              <g key={b.key}>
                {h > 0 ? (
                  <path
                    className={cx('wbars__bar', b.tone && `is-${b.tone}`, hover === i && 'is-hot')}
                    d={`M${x},${base} V${yt + r} Q${x},${yt} ${x + r},${yt} H${x + bw - r} Q${x + bw},${yt} ${x + bw},${yt + r} V${base} Z`}
                  />
                ) : null}
                <text className={cx('wbars__x', hover === i && 'is-hot')} x={mid} y={H - 9} textAnchor="middle">
                  {/* Too narrow for every date: the weeks label every other one. */}
                  {compact ? (slot < 40 && b.key.startsWith('w') && i % 2 === 0 ? '' : b.short) : b.label}
                </text>
                <rect
                  className="wbars__hit"
                  x={pad.l + slot * i}
                  y={0}
                  width={slot}
                  height={H}
                  onMouseEnter={() => setHover(i)}
                  onClick={() => setHover(i)}
                />
              </g>
            )
          })}
        </svg>
      ) : null}
      {hover !== null && w ? (
        <div
          className={cx('wbars__tip', hover > bars.length / 2 && 'is-left')}
          style={{ left: pad.l + slot * hover + slot / 2, top: y(bars[hover].value) }}
        >
          <span className="wbars__tipv">{bars[hover].value}</span>
          <span>{bars[hover].tip}</span>
        </div>
      ) : null}
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * view
 * ------------------------------------------------------------------ */

export function Reporting({ projects, now, onRefresh }) {
  const clock = useClock(now)
  const weekStart = useSetting('weekStart', 1)
  const cases = useProjects(projects, onRefresh)
  const wire = useHeadlines()
  const [scope, setScope] = useState('all')

  const list = Array.isArray(cases.data) ? cases.data : []

  const scopeItems = useMemo(
    () => [
      // Anchored: it is a filter mode, not a case, so it must not be dragged
      // and nothing may be dropped ahead of it.
      { value: 'all', label: 'All cases', fixed: true },
      ...list.map((project) => ({
        value: String(project.id),
        label:
          typeof project.name === 'string' && project.name.trim()
            ? project.name.trim()
            : 'Untitled case',
      })),
    ],
    [list]
  )

  /* Reordering here moves the same cases the Case files strip moves — the two
     read from one order, so they must be able to change it the same way.
     Strip index is offset by one for the anchored "All cases" entry. */
  const [reorderError, setReorderError] = useState(null)
  const reorderScope = useCallback(
    async (value, toIndex) => {
      const walk = siblingWalk(list, value, toIndex - 1)
      if (!walk) return
      setReorderError(null)
      try {
        await applyWalk(moveProject, value, walk)
        await cases.reload()
      } catch (err) {
        setReorderError(err && err.message ? err.message : 'could not reorder the cases.')
      }
    },
    [list, cases]
  )

  // a case that disappears (deleted elsewhere) must not strand the filter
  useEffect(() => {
    if (scope === 'all') return
    if (!list.some((project) => String(project.id) === scope)) setScope('all')
  }, [list, scope])

  const weekEnd = useMemo(() => {
    const today = startOfDay(clock)
    if (!Number.isFinite(today)) return NaN
    const start = weekStart === 0 ? 0 : 1
    const offset = (new Date(today).getDay() - start + 7) % 7
    return addDays(today, 6 - offset)
  }, [clock, weekStart])

  const buckets = useMemo(() => {
    const entries = flattenEntries(list).filter(
      (entry) => !entry.completed && (scope === 'all' || String(entry.projectId) === scope)
    )

    const overdue = []
    const week = []
    const later = []
    const undated = []

    for (const entry of entries) {
      const tone = statusTone(entry.dueDate, clock)
      if (tone === 'overdue') overdue.push(entry)
      else if (tone === 'none') undated.push(entry)
      else if (Number.isFinite(weekEnd) && startOfDay(entry.dueDate) <= weekEnd) week.push(entry)
      else later.push(entry)
    }

    const byDue = (a, b) => toMs(a.dueDate) - toMs(b.dueDate)
    overdue.sort(byDue)
    week.sort(byDue)
    later.sort(byDue)
    undated.sort((a, b) => (toMs(b.createdAt) || 0) - (toMs(a.createdAt) || 0))

    return { overdue, week, later, undated, open: entries.length }
  }, [list, scope, clock, weekEnd])

  /* The insights: how much of the scope is done, and its open work by the
     week it is due — this week and the five after, then later, with overdue
     before and the undated after. */
  const insights = useMemo(() => {
    const scoped = flattenEntries(list).filter((e) => scope === 'all' || String(e.projectId) === scope)
    const total = scoped.length
    const done = scoped.filter((e) => e.completed).length
    const WEEKS = 6
    const first = Number.isFinite(weekEnd) ? addDays(weekEnd, -6) : startOfDay(clock)
    const weeks = Array.from({ length: WEEKS }, (_, i) => ({ start: addDays(first, i * 7), value: 0 }))
    let later = 0
    for (const e of [...buckets.week, ...buckets.later]) {
      const i = Math.floor(dayDiff(startOfDay(e.dueDate), first) / 7)
      if (i >= 0 && i < WEEKS) weeks[i].value += 1
      else later += 1
    }
    const day = (ms) => new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    const num = (ms) => {
      const d = new Date(ms)
      return `${d.getMonth() + 1}/${d.getDate()}`
    }
    const bars = [
      { key: 'overdue', label: 'Overdue', short: 'Late', tip: 'Overdue', value: buckets.overdue.length, tone: 'late' },
      ...weeks.map((wk, i) => ({
        key: `w${i}`,
        label: i === 0 ? 'This week' : day(wk.start),
        short: i === 0 ? 'Now' : num(wk.start),
        tip: i === 0 ? 'Due this week' : `Due the week of ${day(wk.start)}`,
        value: wk.value,
      })),
      { key: 'later', label: 'Later', short: 'Later', tip: `Due after ${day(addDays(first, WEEKS * 7 - 1))}`, value: later },
      { key: 'none', label: 'No date', short: 'None', tip: 'No due date', value: buckets.undated.length, tone: 'none' },
    ]
    return { total, done, completion: total ? done / total : 0, bars }
  }, [list, scope, clock, weekEnd, buckets])

  const rowBase = (entry) => ({
    id: entry.id,
    title:
      typeof entry.title === 'string' && entry.title.trim() ? entry.title.trim() : 'Untitled entry',
    caseName: entry.projectName || '—',
    caseId: entry.projectId,
    sub: !!entry.isSub,
  })

  const overdueRows = buckets.overdue.map((entry) => {
    const late = Math.max(1, dayDiff(clock, entry.dueDate) || 1)
    return {
      ...rowBase(entry),
      day: fmtDate(entry.dueDate),
      tail: `${late}d`,
      tailClass: 'rtable__cell--hot',
    }
  })

  const weekRowsOut = buckets.week.map((entry) => {
    const left = Math.max(0, dayDiff(entry.dueDate, clock) || 0)
    return {
      ...rowBase(entry),
      day: fmtWeekday(entry.dueDate),
      tail: left === 0 ? 'today' : `in ${left}d`,
      tailClass: left === 0 ? 'rtable__cell--strong' : undefined,
    }
  })

  const laterRows = [
    ...buckets.later.map((entry) => {
      const left = Math.max(0, dayDiff(entry.dueDate, clock) || 0)
      return {
        ...rowBase(entry),
        day: fmtDate(entry.dueDate),
        tail: `in ${left}d`,
        tailClass: undefined,
      }
    }),
    ...buckets.undated.map((entry) => ({
      ...rowBase(entry),
      day: '—',
      tail: 'no date',
      tailClass: 'rtable__cell--dim',
    })),
  ]

  const loading = cases.status === 'loading'
  const failed = cases.status === 'error' && list.length === 0

  const weekLabel = Number.isFinite(weekEnd)
    ? `Through ${fmtWeekday(weekEnd)} ${fmtDate(weekEnd)}`
    : 'The rest of this week'

  const emptyFor = (lead, hint) =>
    loading ? (
      <EmptyState lead="Reading the file…" hint="loading entries." />
    ) : (
      <EmptyState lead={lead} hint={hint} />
    )

  const wireBusy = wire.status === 'loading' || wire.status === 'refreshing'
  const wireChecked = wire.fetchedAt ? relTime(wire.fetchedAt, clock) : ''

  let wireBody
  if (wire.items.length) {
    wireBody = (
      <>
        {wire.status === 'error' ? (
          <div className="micro hot">
            {describeError(wire.error)} showing the last copy received.
          </div>
        ) : null}
        <div className="tiplist signals__list">
          {wire.items.map((item, i) => (
            <Signal
              key={item.id !== undefined && item.id !== null ? String(item.id) : `signal-${i}`}
              item={item}
              now={clock}
              tone={i === 0 ? 'sage' : 'dark'}
            />
          ))}
        </div>
      </>
    )
  } else if (wire.status === 'loading') {
    wireBody = <EmptyState lead="Reading the wire…" hint="waiting on the feed." />
  } else if (wire.status === 'error') {
    wireBody = <EmptyState lead="No signal" hint={describeError(wire.error)} />
  } else {
    wireBody = <EmptyState lead="The wire is quiet" hint="no headlines were returned." />
  }

  return (
    <>
      <div className="viewhead">
        <div className="viewhead__left">
          <span className="section-label">Reporting</span>
          {scopeItems.length > 2 ? (
            <SegmentIsland
              items={scopeItems}
              value={scope}
              onChange={setScope}
              onReorder={reorderScope}
              label="Filter by case"
            />
          ) : null}
          {reorderError ? (
            <span className="micro hot" role="alert">{reorderError}</span>
          ) : null}
        </div>
        <div className="viewhead__right">
          <span className="micro muted">Open {buckets.open}</span>
          <span className="micro dim">·</span>
          <span className="micro hot">Overdue {buckets.overdue.length}</span>
          <span className="micro dim">·</span>
          <span className="micro muted">This week {buckets.week.length}</span>
        </div>
      </div>

      {failed ? null : (
        <div className="bento insights">
          <Stat label="Open" value={buckets.open} sub={`${insights.total} logged in all`} />
          <Stat
            label="Overdue"
            value={buckets.overdue.length}
            tone={buckets.overdue.length ? 'late' : undefined}
            sub={buckets.overdue.length ? 'past their due date' : 'nothing late'}
          />
          <Stat label="Due this week" value={buckets.week.length} sub={weekLabel} />
          <Stat
            label="Completion"
            value={`${Math.round(insights.completion * 100)}%`}
            sub={`${insights.done} of ${insights.total} closed`}
            meter={insights.completion}
          />
          <Card className="span-12 insights__chart">
            <CardHead
              className="card__head"
              title="Open work by due date"
              subtitle="Entries still open, by the week they are due"
            />
            <div className="card__body">
              <WorkloadBars bars={insights.bars} />
            </div>
          </Card>
        </div>
      )}

      {failed ? (
        <div className="bento">
          <Card className="span-12">
            <CardHead
              className="card__head"
              title="Queue unavailable"
              subtitle="The case list could not be read"
              right={
                <Pill className="pill--micro" onClick={cases.reload}>
                  <RefreshCw size={12} strokeWidth={1.5} aria-hidden="true" />
                  <span className="pill__label">Retry</span>
                </Pill>
              }
            />
            <div className="card__body">
              <EmptyState
                lead="No connection to the case store"
                hint={
                  cases.error && cases.error.message
                    ? cases.error.message
                    : 'the server did not answer.'
                }
              />
            </div>
          </Card>
        </div>
      ) : (
        <div className="bento bento--fit">
          <QueueCard
            title="Overdue"
            subtitle="Past due, oldest first"
            head={['Due', 'Entry', 'Case', 'Late']}
            rows={overdueRows}
            empty={emptyFor('Nothing overdue', 'the queue is clean.')}
          />
          <QueueCard
            title="This week"
            subtitle={weekLabel}
            head={['Day', 'Entry', 'Case', 'Due']}
            rows={weekRowsOut}
            empty={emptyFor('Nothing due this week', 'no dated work left before the week turns.')}
          />
          <QueueCard
            title="Later"
            subtitle="Beyond this week, and undated"
            head={['Due', 'Entry', 'Case', 'In']}
            rows={laterRows}
            empty={emptyFor('Nothing scheduled later', 'every open entry lands this week.')}
          />
        </div>
      )}

      <div className="bento">
        <Card className="span-12 signals">
          <CardHead
            className="card__head"
            title="Signals"
            subtitle="Wire headlines, refreshed every five minutes"
            right={
              <>
                {wireChecked ? <span className="micro dim nowrap">{wireChecked}</span> : null}
                <Pill className="pill--micro" onClick={wire.reload} disabled={wireBusy}>
                  <RefreshCw size={12} strokeWidth={1.5} aria-hidden="true" />
                  <span className="pill__label">{wireBusy ? 'Syncing' : 'Refresh'}</span>
                </Pill>
              </>
            }
          />
          <div className="card__body card__body--tight" aria-busy={wireBusy || undefined}>
            {wireBody}
          </div>
          <div className="card__foot">
            <span>
              {wire.items.length
                ? `${wire.items.length} ${wire.items.length === 1 ? 'headline' : 'headlines'}`
                : 'No headlines'}
            </span>
            <span className="dim">GET /api/headlines</span>
          </div>
        </Card>
      </div>
    </>
  )
}

export default Reporting
