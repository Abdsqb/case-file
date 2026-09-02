import { useEffect, useMemo, useState } from 'react'

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
import IsoCase from '../ui/IsoCase.jsx'
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

   The two sage cards — Tracking and Completion rate — are the only bright
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

export default function Dashboard({ projects, now, activeCaseId, onSelectCase }) {
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

  const isoEntries = useMemo(() => {
    if (!activeCase) return []
    const all = flattenEntries([activeCase])
    const shown = focus ? all.filter((e) => !e.completed) : all
    return shown.map((e) => ({
      id: e.id,
      title: e.title,
      tone: e.completed
        ? 'done'
        : statusTone(e.dueDate, now) === 'overdue'
          ? 'overdue'
          : 'normal',
      // Carried so a node can identify itself on hover. IsoCase formats it.
      dueDate: e.dueDate,
      priority: e.priority,
      completed: e.completed,
      isSub: e.isSub,
    }))
  }, [activeCase, focus, now])

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

  /* the case-status word next to the active case name */
  let caseDot = 'idle'
  let caseWord = 'Idle'
  if (!activeCase) {
    caseWord = 'No case'
  } else if (active.overdue > 0) {
    caseDot = 'overdue'
    caseWord = `${active.overdue} past due`
  } else if (active.open > 0) {
    caseDot = 'live'
    caseWord = `${active.open} open`
  } else if (active.total > 0) {
    caseWord = 'All closed'
  } else {
    caseWord = 'Empty'
  }

  return (
    <div className="bento">
      {/* ---------------------------------------------------------------- 1 */}
      <Card className="span-5" aria-label="Total workload">
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

      {/* ---------------------------------------------------------------- 2 */}
      <Card className="span-4" aria-label="Case structure">
        <CardHead
          title="Case structure"
          subtitle={focus ? 'Open entries only' : 'Every entry'}
          right={
            <IconMenu
              label="Switch case"
              items={cases.map((p) => ({
                key: String(p.id),
                label: p.name,
                disabled: activeCase ? p.id === activeCase.id : false,
                onClick: () => {
                  if (onSelectCase) onSelectCase(p.id)
                },
              }))}
            />
          }
        />

        <div className="card__body">
          <div className="row row--between">
            <span className="row" style={{ gap: '8px', minWidth: 0 }}>
              <span className={`status-dot status-dot--${caseDot}`} aria-hidden="true" />
              <span className="truncate">{activeCase ? activeCase.name : 'No case selected'}</span>
              <span className="section-label">{caseWord}</span>
            </span>
            <Toggle checked={focus} onChange={setFocus} label="Focus" />
          </div>

          <div
            className="grow"
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          >
            {/* Fills the card. The cap is a safety rail for very wide columns,
                not a size choice — the first bento row's height is set by the
                Recommendations card, so the render has this slack to use. */}
            <div style={{ width: '100%', maxWidth: '440px' }}>
              {/* Keyed on the case so switching it from the card's menu
                  remounts the render and re-plants the pins, matching the
                  behaviour on the Case files screen. */}
              {/* No key: remounting rebuilt the diagram from nothing on every switch.
                  Passing the case as `seed` lets it morph instead. */}
              <IsoCase entries={isoEntries} completion={active.completion} seed={active.id} />
            </div>
          </div>
        </div>

        <div className="card__foot">
          <span className="nowrap">Completion</span>
          <Meter value={active.completion} label="Case completion" className="grow" />
        </div>
      </Card>

      {/* ---------------------------------------------------------------- 3 */}
      <Card className="span-3" aria-label="Recommendations">
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

      {/* ---------------------------------------------------------------- 4 */}
      <Card tone="sage" className="span-2" aria-label="Tracking">
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

      {/* ---------------------------------------------------------------- 5 */}
      <Card className="span-4" aria-label="Detailed report">
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

      {/* ---------------------------------------------------------------- 6 */}
      <Card tone="sage" className="span-6" aria-label="Completion rate">
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
    </div>
  )
}

export { Dashboard }
