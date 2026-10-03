import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

import {
  Card,
  CardHead,
  EmptyState,
  IconMenu,
  Meter,
  Metric,
  Pill,
  PillSelect,
  Toggle,
  Trend,
} from '../ui/primitives.jsx'
import { MiniBars, TimelineDots, WeekTable } from '../ui/charts.jsx'
import CaseFlow from '../ui/CaseFlow.jsx'
import ClerkChat from '../ui/ClerkChat.jsx'
import * as clerk from '../lib/clerk.js'
import { buildGraph } from '../lib/graph.js'
import {
  caseStats,
  completionTimeline,
  dailySeries,
  dayDiff,
  flattenEntries,
  globalStats,
  rangeOf,
  recommendations,
  statusTone,
  weekRows,
} from '../lib/metrics.js'

/* ============================================================================
   Dashboard — the Overview screen.

   Six bento cards in two rows of twelve columns:
     row 1   Total workload (5) · Case structure (4) · Recommendations (3)
     row 2   Tracking (2) · Detailed report (4) · Completion rate (6)

   Every number on this screen comes out of src/lib/metrics.js, driven by the
   single `now` the app owns. Nothing here reads the system clock and nothing
   here does its own arithmetic on task rows.

   The deck's cards are all one surface now — Tracking and Completion rate
   surfaces. They re-point --fg / --bg / --bar locally, so their children use
   the ordinary token classes and invert for free.
============================================================================ */

function cx(...parts) {
  return parts.filter(Boolean).join(' ')
}

/* The window offered by the "Change module" pill and the sub-panel menus.
   Capped at 45 days: the three sub-panels are ~130px wide, and MiniBars holds
   its bars at a true 2px, so past ~45 buckets the texture fuses into a slab. */
const WINDOWS = [14, 30, 45]

/* Direction glyph for a daily series. Deliberately the same rule weekRows()
   uses for its own `dir` — last bucket against the one before it — so the
   arrows on this screen all mean the same thing. */
function seriesDir(series) {
  if (!Array.isArray(series) || series.length < 2) return 'up'
  return series[series.length - 1] >= series[series.length - 2] ? 'up' : 'down'
}

/* Open entries whose due date lands `from`..`to` calendar days from now.
   dayDiff comes from metrics.js — this is a filter, not a second clock. */
function dueBetween(entries, now, from, to) {
  let n = 0
  for (const entry of entries) {
    if (!entry || entry.completed || entry.dueDate == null) continue
    const d = dayDiff(entry.dueDate, now)
    if (Number.isFinite(d) && d >= from && d <= to) n += 1
  }
  return n
}

const TRACK_WINDOWS = {
  today: { label: 'Due today', from: 0, to: 0 },
  tomorrow: { label: 'Due tomorrow', from: 1, to: 1 },
  week: { label: 'Due this week', from: 0, to: 6 },
}

/* The Settings view writes `casefile.weekStart` and fires 'casefile:settings',
   the same channel IsoCase listens on for its motion overrides. Absent means
   Monday. Reads are guarded so private mode cannot break the dashboard. */
function readWeekStart() {
  if (typeof window === 'undefined') return 1
  try {
    const v = window.localStorage.getItem('casefile.weekStart')
    return v === '0' || v === 'sun' || v === 'sunday' ? 0 : 1
  } catch {
    return 1
  }
}

function useWeekStart() {
  const [weekStart, setWeekStart] = useState(readWeekStart)

  useEffect(() => {
    const sync = () => setWeekStart(readWeekStart())
    window.addEventListener('storage', sync)
    window.addEventListener('casefile:settings', sync)
    sync()
    return () => {
      window.removeEventListener('storage', sync)
      window.removeEventListener('casefile:settings', sync)
    }
  }, [])

  return weekStart
}

/* --------------------------------------------------------------------------
   Total workload — three sub-panels, each its own label + trend + menu above
   its own MiniBars, with the range below the chart and a unit caption under
   that. The spacer pins the range to the bottom so all three read on one line
   however tall the bento row grows.
   -------------------------------------------------------------------------- */

function WorkloadPanel({ label, series, days, onWindow }) {
  const range = rangeOf(series)

  return (
    <div className="subpanel">
      <div className="subpanel__head">
        <span className="subpanel__label">
          {label}
          <Trend dir={seriesDir(series)} />
        </span>
        <IconMenu
          label={`${label} options`}
          items={WINDOWS.map((n) => ({
            key: `w${n}`,
            label: `Last ${n} days`,
            disabled: n === days,
            onClick: () => onWindow(n),
          }))}
        />
      </div>

      <div className="chart">
        <MiniBars
          data={series}
          height={92}
          label={`${label}, last ${days} days — ${range.label} per day`}
        />
      </div>

      <div className="spacer" />

      <Metric value={range.label} sub="entries per day" />
    </div>
  )
}

/* --------------------------------------------------------------------------
   Recommendations — the generated commentary, in the reference's tip form.
   The first tip is sage; the rest are dark wells.
   -------------------------------------------------------------------------- */

function Tip({ tip }) {
  return (
    <article className={cx('tip', tip.tone === 'sage' && 'tip--sage')}>
      {tip.ref ? (
        <div className="tip__head">
          <span className="micro truncate">{tip.ref}</span>
        </div>
      ) : null}
      <p className="tip__body">{tip.body}</p>
      <div className="tip__meta">
        <span>{tip.meta}</span>
        <span className="tip__note">{tip.note}</span>
      </div>
    </article>
  )
}

/* ========================================================================== */

/* Two ways to name a case, and they are not the same thing.
 *
 *   onSelectCase — go and work on it. Opens the Case files screen.
 *   onPickCase   — show me that one instead. Changes what the card is a
 *                  picture of and leaves you where you are.
 *
 * The structure card has both, because both are things you want from it: the
 * menu changes the subject, the arrow goes there. Collapsing them into one is
 * what made every pick in that menu throw you off the dashboard. */
export default function Dashboard({ projects, now, activeCaseId, onSelectCase, onPickCase }) {
  const cases = useMemo(
    () => (Array.isArray(projects) ? projects.filter(Boolean) : []),
    [projects]
  )

  const weekStart = useWeekStart()

  const [days, setDays] = useState(30)
  const [urgentOnly, setUrgentOnly] = useState(false)
  const [focus, setFocus] = useState(false)
  const [reportMode, setReportMode] = useState('week')
  const [trackKey, setTrackKey] = useState('tomorrow')
  const [rateScope, setRateScope] = useState('all')

  /* ---- the clerk -------------------------------------------------------
     `onDuty` is null until the server has answered. Three states rather than
     two, because rendering "off" for the half second before the answer comes
     back would make a working install flash a disabled card on every load. */
  const [onDuty, setOnDuty] = useState(null)
  const [read, setRead] = useState(null)
  const [readBusy, setReadBusy] = useState(false)

  useEffect(() => {
    let alive = true
    clerk.status().then((st) => { if (alive) setOnDuty(!!st.ready) })
    return () => { alive = false }
  }, [])

  /* The brief is fetched once on arrival and cached on the server against the
     facts that produced it — so this is one request per visit, and it only
     costs a model call when something it would have mentioned has changed. */
  const fetchBrief = useCallback(async (force = false) => {
    setReadBusy(true)
    try {
      setRead(await clerk.brief({ force }))
    } catch {
      /* Silent. The brief is an addition to the left column, not the column
         itself — a dashboard that renders an error where a sentence should be
         is worse than one that simply does not have the sentence today. */
      setRead(null)
    } finally {
      setReadBusy(false)
    }
  }, [])

  useEffect(() => { if (onDuty) fetchBrief(false) }, [onDuty, fetchBrief])

  /* ---- derived ---------------------------------------------------------- */

  const stats = useMemo(() => globalStats(cases, now), [cases, now])
  const entries = useMemo(() => flattenEntries(cases), [cases])
  const series = useMemo(() => dailySeries(cases, now, days), [cases, now, days])
  const monthSeries = useMemo(() => dailySeries(cases, now, 30), [cases, now])
  const rows = useMemo(() => weekRows(cases, now, weekStart), [cases, now, weekStart])
  const timeline = useMemo(() => completionTimeline(cases, now), [cases, now])
  const tips = useMemo(() => recommendations(cases, now), [cases, now])

  const activeCase = useMemo(
    () => cases.find((p) => p.id === activeCaseId) || cases[0] || null,
    [cases, activeCaseId]
  )
  const active = useMemo(() => caseStats(activeCase, now), [activeCase, now])

  /* One case at a time. The all-cases scope is gone: it was a constellation
     of eight clusters, which the force layout could arrange but nobody could
     read, and the flow it is drawn as now is the shape of ONE case. The case
     is whichever one the app has open, so the card and the Case files screen
     always agree. */
  const structureStats = active

  const graph = useMemo(
    () => buildGraph(cases, { rootId: activeCase ? activeCase.id : null, now, focus }),
    [cases, activeCase, now, focus]
  )

  const shownTips = urgentOnly
    ? tips.filter((t) => t.meta === 'Today recommendation')
    : tips

  const track = TRACK_WINDOWS[trackKey] || TRACK_WINDOWS.tomorrow
  const trackCount = dueBetween(entries, now, track.from, track.to)

  const rateStats = rateScope === 'case' && activeCase ? active : stats
  const rateLabel =
    rateScope === 'case' && activeCase
      ? activeCase.name
      : `All cases · ${stats.total} logged`
  const ratePct = Math.round(rateStats.completion * 100)

  /* the status word next to the structure card's title */
  let caseDot = 'idle'
  let caseWord = 'Idle'
  if (!activeCase) {
    caseWord = 'No case'
  } else if (structureStats.overdue > 0) {
    caseDot = 'overdue'
    caseWord = `${structureStats.overdue} past due`
  } else if (structureStats.open > 0) {
    caseDot = 'live'
    caseWord = `${structureStats.open} open`
  } else if (structureStats.total > 0) {
    caseWord = 'All closed'
  } else {
    caseWord = 'Empty'
  }

  /* No cap any more, so no two-number hedge. The old diagram planted at most 40
     pins and had to say so; the graph draws every node — measured flat 60fps to
     2000 of them, sixteen times this data's load. */
  const pinTotal = graph.nodes.length
  const pinLabel = `${pinTotal} ${pinTotal === 1 ? 'step' : 'steps'}`

  /* ---- the brief -------------------------------------------------------- */

  /* The greeting is the one piece of copy in the app that is written FOR the
     reader rather than about the data, so it carries the accent face — one
     word, in the italic serif, the way every empty state does. */
  const hour = new Date(now).getHours()
  const partOfDay =
    hour < 5 ? 'night' : hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : hour < 22 ? 'evening' : 'night'

  /* What the reader needs to know before anything else, in one sentence, and
     the worst thing first — a line that said "7 open" while three were late
     would be telling the truth and still be wrong. */
  const headline = stats.overdue
    ? `${stats.overdue} past due. ${stats.open} open across ${cases.length} ${cases.length === 1 ? 'case' : 'cases'}.`
    : stats.open
      ? `Nothing is late. ${stats.open} open across ${cases.length} ${cases.length === 1 ? 'case' : 'cases'}.`
      : 'Nothing open. The archive is clear.'

  /* The next few things with a date on them, soonest first — the "last runs"
     readout from the reference, pointed forwards instead of back. */
  const upNext = useMemo(() => {
    const day = new Date(now)
    day.setHours(0, 0, 0, 0)
    return entries
      .filter((e) => !e.completed && Number.isFinite(e.dueDate))
      .sort((a, c) => a.dueDate - c.dueDate)
      .slice(0, 5)
      .map((e) => {
        const d = new Date(e.dueDate)
        d.setHours(0, 0, 0, 0)
        const days = Math.round((d.getTime() - day.getTime()) / 86400000)
        return {
          ...e,
          when: days < 0 ? `${-days}d late` : days === 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${days}d`,
          late: days < 0,
          soon: days >= 0 && days <= 1,
        }
      })
  }, [entries, now])

  /* ---- the deck ---------------------------------------------------------- */

  /* One card on screen at a time, and the structure first: it is the thing
     this screen is for, and everything else on it is a measurement of the
     same work from another angle. */
  const slides = [
    { key: 'structure', label: 'Case structure', node: (
        <Card className="dash__card dash__card--flow" aria-label="Case structure">
          {/* No card head and no body padding: the flow IS the panel — its own
              title bar, its own tools, its own log along the bottom. A card
              header above a panel header is a panel arguing with itself. */}
          <CaseFlow
            cases={cases}
            rootId={activeCase ? activeCase.id : null}
            now={now}
            focus={focus}
            onFocus={setFocus}
            onPickCase={(id) => onPickCase && onPickCase(id)}
            onOpenCase={(id) => onSelectCase && onSelectCase(id)}
          />

          <div className="card__foot">
            <span className="nowrap">Completion</span>
            <Meter
              value={structureStats.completion}
              label="Case completion"
              className="grow"
            />
          </div>
        </Card>
      ) },
    /* Second, and deliberately: the card after the drawing is the one you
       reach by a single scroll, which is the right distance for the thing you
       open when you have a question rather than a number to read. The six
       measurement cards keep their order behind it. */
    { key: 'clerk', label: 'Ask the clerk', node: (
        <Card className="dash__card dash__card--chat" aria-label="Ask the clerk">
          <CardHead
            title="The clerk"
            subtitle="Reads the archive before it answers"
          />
          <div className="card__body card__body--flush">
            {/* The tri-state, not a boolean: null means "the server has not
                said yet", and flattening that to false makes the card announce
                that the clerk is off for a frame on every single visit. */}
            <ClerkChat onDuty={onDuty} />
          </div>
        </Card>
      ) },
    { key: 'workload', label: 'Total workload', node: (
        <Card className="dash__card" aria-label="Total workload">
          <CardHead
            title="Total workload"
            subtitle={`Last ${days} days`}
            right={
              <Pill
                onClick={() =>
                  setDays((d) => WINDOWS[(WINDOWS.indexOf(d) + 1) % WINDOWS.length])
                }
              >
                Change module
              </Pill>
            }
          />
          <div className="card__body">
            <div className="subpanels subpanels--3 grow">
              <WorkloadPanel
                label="Opened"
                series={series.opened}
                days={days}
                onWindow={setDays}
              />
              <WorkloadPanel
                label="Closed"
                series={series.closed}
                days={days}
                onWindow={setDays}
              />
              <WorkloadPanel
                label="Overdue"
                series={series.overdue}
                days={days}
                onWindow={setDays}
              />
            </div>
          </div>
        </Card>
      ) },
    { key: 'tips', label: 'Recommendations', node: (
        <Card className="dash__card" aria-label="Recommendations">
          <CardHead
            title="Recommendations"
            subtitle="Personalized tips for staying on top"
            right={
              <IconMenu
                label="Filter tips"
                items={[
                  {
                    key: 'all',
                    label: 'All tips',
                    disabled: !urgentOnly,
                    onClick: () => setUrgentOnly(false),
                  },
                  {
                    key: 'urgent',
                    label: 'Urgent only',
                    disabled: urgentOnly,
                    onClick: () => setUrgentOnly(true),
                  },
                ]}
              />
            }
          />
          <div className="card__body">
            {shownTips.length > 0 ? (
              <div className="tiplist grow">
                {shownTips.map((tip) => (
                  <Tip key={tip.id} tip={tip} />
                ))}
              </div>
            ) : (
              <EmptyState
                lead="Nothing urgent."
                hint="No entry needs attention today."
              />
            )}
          </div>
        </Card>
      ) },
    { key: 'tracking', label: 'Tracking', node: (
        <Card className="dash__card" aria-label="Tracking">
          <CardHead
            title="Tracking"
            subtitle={track.label}
            right={
              <IconMenu
                label="Tracking window"
                items={Object.keys(TRACK_WINDOWS).map((key) => ({
                  key,
                  label: TRACK_WINDOWS[key].label,
                  disabled: key === trackKey,
                  onClick: () => setTrackKey(key),
                }))}
              />
            }
          />
          <div className="card__body card__body--center">
            <Metric
              value={trackCount}
              unit="entries"
              sub={`${stats.open} open in total`}
            />
          </div>
        </Card>
      ) },
    { key: 'report', label: 'Detailed report', node: (
        <Card className="dash__card" aria-label="Detailed report">
          <CardHead
            title="Detailed report"
            subtitle="Entries logged per day"
            right={
              <PillSelect
                label="Report range"
                value={reportMode}
                onChange={setReportMode}
                options={[
                  { value: 'week', label: 'Week' },
                  { value: 'month', label: 'Month' },
                ]}
              />
            }
          />
          <div className="card__body card__body--center">
            {reportMode === 'week' ? (
              <WeekTable rows={rows} />
            ) : (
              <div className="col col--tight">
                <div className="chart">
                  <MiniBars
                    data={monthSeries.opened}
                    height={92}
                    label={`Entries logged per day, last 30 days — ${rangeOf(monthSeries.opened).label}`}
                  />
                </div>
                <div className="row row--between micro">
                  <span>30 days ago</span>
                  <span>{rangeOf(monthSeries.opened).label} per day</span>
                  <span>Today</span>
                </div>
              </div>
            )}
          </div>
        </Card>
      ) },
    { key: 'rate', label: 'Completion rate', node: (
        <Card className="dash__card" aria-label="Completion rate">
          <CardHead
            title="Completion rate"
            right={
              <Pill
                onClick={() => setRateScope((s) => (s === 'all' ? 'case' : 'all'))}
                disabled={!activeCase}
              >
                Change
              </Pill>
            }
          />
          <div className="card__body card__body--center">
            <div className="row row--between row--wrap" style={{ gap: '24px' }}>
              <Metric value={`${ratePct}%`} sub={rateLabel} />
              <div className="grow" style={{ minWidth: '200px' }}>
                <TimelineDots points={timeline} />
              </div>
            </div>
          </div>
        </Card>
      ) },
  ]

  /* THE DECK GLIDES.
     ======================================================================
     It used to latch: one card per gesture, and anything you did inside the
     next 420ms was thrown away. That is the right behaviour for a deck you
     flick through on a trackpad and the wrong one for a wheel — keep turning
     the wheel and the deck ignored most of it, so a six-card deck took six
     deliberate gestures and felt stuck between each of them.

     So there is no latch. The deck has a position, which is a REAL number,
     and the wheel moves where that position is aiming for. The position
     itself chases the aim a fraction of the remaining distance every frame,
     which is what makes a long scroll one continuous movement through the
     deck rather than six separate jumps: spin the wheel and the aim runs
     ahead, and the cards stream after it and catch up when you stop.

     Everything on the way is drawn straight onto the elements. A card's
     opacity and offset are a function of how far it is from the position, and
     recomputing that in React sixty times a second would be sixty renders of
     six cards to move two numbers. The only thing that goes through state is
     WHICH card is settled on, which changes once per card and decides the
     dots, the tab order and what a screen reader is told. */
  const [at, setAt] = useState(0)
  const index = Math.min(at, slides.length - 1)

  const stackRef = useRef(null)
  const posRef = useRef(0)
  const aimRef = useRef(0)
  const rafRef = useRef(0)
  const settleRef = useRef(0)

  /* How much wheel is one card. A mouse notch arrives as a single large delta
     and is worth exactly one card; a trackpad arrives as a stream of small
     ones and accumulates, or a flick would throw the deck end to end. */
  const NOTCH = 90
  const GLIDE = 170

  const lay = useCallback(() => {
    const stack = stackRef.current
    if (!stack) return
    const pos = posRef.current
    const kids = stack.children
    for (let i = 0; i < kids.length; i += 1) {
      const el = kids[i]
      const d = i - pos
      const m = Math.abs(d)
      /* Two cards either side is all anyone can see through; the rest are not
         worth a style write per frame. */
      if (m > 1.3) {
        if (el.style.visibility !== 'hidden') {
          el.style.visibility = 'hidden'
          el.style.opacity = '0'
        }
        continue
      }
      el.style.visibility = 'visible'
      el.style.opacity = String(Math.max(0, 1 - m * 1.15).toFixed(3))
      el.style.transform = `translateY(${(d * 62).toFixed(1)}px) scale(${(1 - Math.min(m, 1) * 0.055).toFixed(4)})`
    }
  }, [])

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

  const aimAt = useCallback(
    (next) => {
      const n = slides.length
      aimRef.current = Math.max(0, Math.min(n - 1, next))
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
    [lay, slides.length, tick]
  )

  const onWheel = useCallback(
    (e) => {
      const step = Math.abs(e.deltaY) > Math.abs(e.deltaX) ? e.deltaY : e.deltaX
      if (!step) return
      e.preventDefault()
      const bump = Math.abs(step) >= NOTCH ? Math.sign(step) : step / GLIDE
      aimAt(aimRef.current + bump)
      /* A trackpad can leave the aim between two cards. Once it stops coming,
         the deck takes the nearer one. A wheel never needs this — its notches
         are whole cards — but it costs nothing to let it settle too. */
      clearTimeout(settleRef.current)
      settleRef.current = setTimeout(() => aimAt(Math.round(aimRef.current)), 150)
    },
    [aimAt]
  )

  /* preventDefault has to be told it is coming, and React's onWheel is
     passive, so the listener is attached by hand. */
  const deckRef = useRef(null)
  useEffect(() => {
    const el = deckRef.current
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
    const n = slides.length
    if (posRef.current > n - 1) {
      posRef.current = n - 1
      aimRef.current = n - 1
    }
    lay()
  }, [lay, slides.length])

  const onKey = useCallback(
    (e) => {
      const back = e.key === 'ArrowUp' || e.key === 'ArrowLeft' || e.key === 'PageUp'
      const fwd = e.key === 'ArrowDown' || e.key === 'ArrowRight' || e.key === 'PageDown'
      if (!back && !fwd) return
      e.preventDefault()
      aimAt(Math.round(aimRef.current) + (fwd ? 1 : -1))
    },
    [aimAt]
  )

  return (
    <div className="dash">
      {/* ---- left: who is reading, and what they need to know -------------- */}
      <aside className="dash__brief">
        <span className="statpill statpill--idle dash__chip">
          {cases.length} {cases.length === 1 ? 'case' : 'cases'} / {stats.total} logged
        </span>

        <h1 className="dash__greet">
          Good <em className="serif">{partOfDay}</em>.
        </h1>

        <p className="dash__line">{headline}</p>

        {/* The clerk's read of the day, written rather than carded.

            It goes here, under the headline, because this column is the only
            prose on the screen — everything to the right is a measurement. The
            headline above says what is true; this says what to do about it,
            which is the one thing on the dashboard that arithmetic cannot
            produce. When there is no key, or the call failed, the column is
            simply what it always was. */}
        {onDuty && (read || readBusy) ? (
          <div className={cx('dash__read', readBusy && 'is-reading')}>
            {read ? (
              <>
                <p className="dash__readtext">{read.body}</p>
                <button
                  type="button"
                  className="dash__readagain"
                  onClick={() => fetchBrief(true)}
                  disabled={readBusy}
                >
                  {readBusy ? 'reading…' : 'read again'}
                </button>
              </>
            ) : (
              <p className="dash__readtext dash__readtext--wait">reading the archive…</p>
            )}
          </div>
        ) : null}

        <div className="dash__up">
          <span className="dash__uphead">up next</span>
          {upNext.length ? (
            upNext.map((e) => (
              <button
                key={`${e.isSub ? 's' : 'e'}:${e.id}`}
                type="button"
                className="dash__row"
                onClick={() => onSelectCase && onSelectCase(e.projectId)}
                title={`${e.title} — ${e.projectName}`}
              >
                <span
                  className={cx(
                    'status-dot',
                    e.late && 'status-dot--overdue',
                    e.soon && !e.late && 'status-dot--live'
                  )}
                  aria-hidden="true"
                />
                <span className="dash__when">{e.when}</span>
                <span className="dash__what truncate">{e.title}</span>
                <span className="dash__case truncate">{e.projectName}</span>
              </button>
            ))
          ) : (
            <span className="dash__none">nothing dated ahead</span>
          )}
        </div>
      </aside>

      {/* ---- right: one card at a time ------------------------------------- */}
      <section
        className="dash__deck"
        ref={deckRef}
        onKeyDown={onKey}
        tabIndex={0}
        aria-roledescription="carousel"
        aria-label="Dashboard cards"
      >
        <div className="dash__stack" ref={stackRef}>
          {slides.map((sl, i) => (
            <div
              key={sl.key}
              className={cx('dash__slide', i === index && 'is-on')}
              aria-hidden={i === index ? undefined : true}
              /* Out of the tab order while it is behind, or the keyboard would
                 walk into five cards nobody can see. */
              inert={i === index ? undefined : true}
            >
              {sl.node}
            </div>
          ))}
        </div>

        <nav className="dash__dots" aria-label="Choose a card">
          {slides.map((sl, i) => (
            <button
              key={sl.key}
              type="button"
              className={cx('dash__dot', i === index && 'is-on')}
              aria-current={i === index ? 'true' : undefined}
              aria-label={sl.label}
              title={sl.label}
              onClick={() => aimAt(i)}
            />
          ))}
        </nav>
      </section>
    </div>
  )
}
