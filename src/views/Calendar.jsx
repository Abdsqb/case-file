/**
 * Calendar.jsx — the class timetable, read-only.
 *
 *   Next class · Today · Term        — the three things you check between rooms
 *   Week                             — the timetable proper, one column per day
 *   Courses                          — every series, with its days, time and room
 *
 * The source of truth is the registrar's own .ics, imported raw and parsed at
 * load. Nothing here is transcribed by hand, which means next term is a file
 * swap: drop the new export over src/data/class-calendar.ics and the whole
 * screen follows — courses, rooms, holidays, term length.
 */

import { useCallback, useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'

import { Card, CardHead, EmptyState, Meter, Metric, Pill } from '../ui/primitives.jsx'
import { addDays, fmtTime, minutesOf, parseCalendar, sameDay, startOfDay, weekStartOf } from '../lib/ics.js'
import sampleIcs from '../data/class-calendar.ics?raw'

/* The repo ships a fictional sample so a fresh clone builds and this screen has
   something to draw. A real schedule is personal — course names, buildings, room
   numbers — so it goes in `class-calendar.local.ics`, which is gitignored and
   wins whenever it is present. A glob rather than a plain import because the
   local file legitimately does not exist most of the time, and a static import
   of a missing file is a build error. */
const overrides = import.meta.glob('../data/*.local.ics', {
  query: '?raw',
  import: 'default',
  eager: true,
})
const icsText = Object.values(overrides)[0] ?? sampleIcs

const DAY_LABEL = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/* Monday first, and Sunday last rather than first — a class week reads Mon→Sun. */
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0]

function cx(...parts) {
  return parts.filter(Boolean).join(' ')
}

function fmtDay(date) {
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

/** `9:30am–10:45am`, the en dash tightened up so it fits a narrow block. */
function fmtRange(a, b) {
  return `${fmtTime(a)}–${fmtTime(b)}`
}

/**
 * `40 W 4th St (Tisch Hall) Room LC25` → `Tisch Hall · LC25`.
 *
 * The registrar leads with a postal address, which is the one part of that
 * string nobody standing on campus needs. In a column this narrow it pushed the
 * building and the room number — the only two things you actually walk toward —
 * out past the ellipsis. Falls back to the original whenever the shape does not
 * match, so an unfamiliar format loses nothing.
 */
function shortRoom(location) {
  if (!location) return ''
  const building = /\(([^)]+)\)/.exec(location)
  const room = /\broom\s+(\S+)/i.exec(location)
  if (!building && !room) return location
  return [building && building[1], room && room[1]].filter(Boolean).join(' · ')
}

/** The axis reads 9…12…8 to match the am/pm the blocks print, not 09…20. */
function hourLabel(min) {
  const h = Math.floor(min / 60) % 24
  return String(h % 12 === 0 ? 12 : h % 12)
}

/**
 * Lay overlapping meetings side by side.
 *
 * This schedule has no clashes, but a timetable that silently stacks two classes
 * on top of each other is worse than useless, so the grid is built to survive one
 * the day it appears. Meetings are grouped into clusters of mutual overlap and
 * each cluster is split into lanes; a lone meeting is a cluster of one and keeps
 * the full column width.
 */
function packDay(list) {
  const sorted = [...list].sort((a, b) => a.start - b.start || a.end - b.end)
  const out = []
  let cluster = []
  let clusterEnd = -Infinity

  const flush = () => {
    if (!cluster.length) return
    const lanes = []
    for (const m of cluster) {
      let lane = lanes.findIndex((endsAt) => endsAt <= m.start)
      if (lane === -1) { lane = lanes.length; lanes.push(0) }
      lanes[lane] = m.end
      m.lane = lane
    }
    for (const m of cluster) m.lanes = lanes.length
    out.push(...cluster)
    cluster = []
    clusterEnd = -Infinity
  }

  for (const m of sorted) {
    if (m.start >= clusterEnd) flush()
    cluster.push({ ...m })
    clusterEnd = Math.max(clusterEnd, m.end)
  }
  flush()
  return out
}

export default function Calendar({ now }) {
  const nowTs = Number.isFinite(now) ? now : Date.now()
  const usingSample = Object.keys(overrides).length === 0

  // The file never changes at runtime, so this is parsed once for the session.
  const { calendarName, series, meetings } = useMemo(() => parseCalendar(icsText), [])

  /* The export names itself "Class Calendar - Fall 2026", which next to the
     section label just stutters. Keep the part that says something. */
  const termLabel = useMemo(
    () => (calendarName || '').replace(/^\s*class\s*calendar\s*[-–—:]?\s*/i, '').trim(),
    [calendarName]
  )

  const term = useMemo(() => {
    if (!meetings.length) return null
    const first = meetings[0].start
    const last = meetings[meetings.length - 1].end

    // The grid's vertical extent, rounded out to whole hours so the axis reads
    // in round numbers rather than starting at 9:30.
    let lo = Infinity
    let hi = -Infinity
    const days = new Set()
    for (const m of meetings) {
      lo = Math.min(lo, minutesOf(m.start))
      hi = Math.max(hi, minutesOf(m.end))
      days.add(m.start.getDay())
    }
    const fromMin = Math.floor(lo / 60) * 60
    const toMin = Math.ceil(hi / 60) * 60

    return {
      first,
      last,
      fromMin,
      toMin,
      span: Math.max(60, toMin - fromMin),
      hours: Array.from({ length: Math.round((toMin - fromMin) / 60) + 1 }, (_, i) => fromMin + i * 60),
      cols: WEEK_ORDER.filter((d) => days.has(d)),
      weeks: Math.max(1, Math.round((weekStartOf(last) - weekStartOf(first)) / 604800000) + 1),
    }
  }, [meetings])

  /* The week on screen. Opens on the current week, but pinned inside the term so
     a glance in the summer lands on the first week of class rather than an empty
     grid with no clue where the term actually is. */
  const [weekTs, setWeekTs] = useState(() => {
    if (!meetings.length) return weekStartOf(Date.now()).getTime()
    const here = weekStartOf(nowTs).getTime()
    const lo = weekStartOf(meetings[0].start).getTime()
    const hi = weekStartOf(meetings[meetings.length - 1].start).getTime()
    return Math.min(Math.max(here, lo), hi)
  })

  const shiftWeek = useCallback((n) => {
    setWeekTs((ts) => addDays(ts, n * 7).getTime())
  }, [])

  const jumpToToday = useCallback(() => {
    setWeekTs(weekStartOf(nowTs).getTime())
  }, [nowTs])

  const week = useMemo(() => {
    const start = startOfDay(weekTs)
    const end = addDays(start, 7)
    const inWeek = meetings.filter((m) => m.start >= start && m.start < end)
    const cols = (term ? term.cols : WEEK_ORDER.slice(0, 5)).map((dow) => {
      const date = addDays(start, (dow + 6) % 7)
      const dayList = inWeek.filter((m) => sameDay(m.start, date))
      return {
        dow,
        date,
        today: sameDay(date, new Date(nowTs)),
        // A weekday inside the term with nothing on it is a holiday, and the
        // grid should say so — otherwise the EXDATEs just look like a gap.
        off: dayList.length === 0 && term && date >= startOfDay(term.first) && date <= term.last,
        meetings: packDay(dayList),
      }
    })
    return { start, end, cols, count: inWeek.length }
  }, [weekTs, meetings, term, nowTs])

  const today = useMemo(
    () => meetings.filter((m) => sameDay(m.start, new Date(nowTs))),
    [meetings, nowTs]
  )

  const live = useMemo(
    () => meetings.find((m) => m.start.getTime() <= nowTs && m.end.getTime() > nowTs) || null,
    [meetings, nowTs]
  )

  const next = useMemo(
    () => meetings.find((m) => m.start.getTime() > nowTs) || null,
    [meetings, nowTs]
  )

  const done = useMemo(
    () => meetings.filter((m) => m.end.getTime() <= nowTs).length,
    [meetings, nowTs]
  )

  if (!term) {
    return (
      <>
        <div className="viewhead">
          <div className="viewhead__left"><span className="section-label">Class calendar</span></div>
        </div>
        <div className="bento">
          <Card className="span-12">
            <CardHead className="card__head" title="No schedule" subtitle="The calendar file holds no events" />
            <div className="card__body">
              <EmptyState
                lead="Nothing to show."
                hint="Replace src/data/class-calendar.ics with a registrar export."
              />
            </div>
          </Card>
        </div>
      </>
    )
  }

  /* Two different weeks, and they must not be confused. `weekNo` is whatever the
     grid is showing; `nowWeekNo` is the real one. The Term card sits beside Next
     class and Today, so it reports the real one — otherwise paging the grid
     forward would quietly rewrite where you are in the term. */
  const weekNo = Math.round((week.start - weekStartOf(term.first)) / 604800000) + 1
  const inTerm = weekNo >= 1 && weekNo <= term.weeks
  const nowWeekNo = Math.round((weekStartOf(nowTs) - weekStartOf(term.first)) / 604800000) + 1
  const nowInTerm = nowWeekNo >= 1 && nowWeekNo <= term.weeks
  const nowMin = minutesOf(new Date(nowTs))
  const nowInGrid =
    week.cols.some((c) => c.today) && nowMin >= term.fromMin && nowMin <= term.toMin

  /* Position within the lane, as a percentage of the day's span. */
  const topOf = (m) => ((minutesOf(m.start) - term.fromMin) / term.span) * 100
  const heightOf = (m) => ((minutesOf(m.end) - minutesOf(m.start)) / term.span) * 100

  return (
    <>
      <div className="viewhead">
        <div className="viewhead__left">
          <span className="section-label">Class calendar</span>
          <span className="micro dim">{termLabel || calendarName || 'Schedule'}</span>
          {usingSample ? (
            <span className="micro dim" title="Add src/data/class-calendar.local.ics to use your own">
              sample data
            </span>
          ) : null}
        </div>
        <div className="viewhead__right">
          <span className="micro muted">{series.length} courses</span>
          <span className="micro dim">·</span>
          <span className="micro muted">{meetings.length} meetings</span>
        </div>
      </div>

      <div className="bento">
        {/* ---------------- left column ---------------- */}
        <div className="span-3 stack">
          <Card tone="sage">
            <CardHead
              className="card__head"
              title={live ? 'In class now' : 'Next class'}
              subtitle={live ? live.summary : next ? next.summary : 'Term complete'}
            />
            <div className="card__body">
              {live || next ? (
                <>
                  <Metric
                    value={fmtTime((live || next).start)}
                    sub={
                      live
                        ? `until ${fmtTime(live.end)}`
                        : sameDay(next.start, new Date(nowTs))
                          ? 'today'
                          : `${DAY_LABEL[next.start.getDay()]} ${fmtDay(next.start)}`
                    }
                  />
                  <span className="micro muted">{(live || next).location}</span>
                </>
              ) : (
                <Metric value="—" sub="no classes left" />
              )}
            </div>
          </Card>

          <Card>
            <CardHead
              className="card__head"
              title="Today"
              subtitle={new Date(nowTs).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short' })}
              right={<span className="micro dim">{today.length}</span>}
            />
            <div className="card__body card__body--tight">
              {today.length === 0 ? (
                <EmptyState lead="No classes today." hint="Next one is on the grid." />
              ) : (
                today.map((m) => (
                  <div
                    key={`${m.seriesId}-${m.start.getTime()}`}
                    className={cx('agenda', m.end.getTime() <= nowTs && 'agenda--past', m === live && 'agenda--live')}
                  >
                    <span className="agenda__time">{fmtTime(m.start)}</span>
                    <span className="agenda__body">
                      <span className="agenda__title truncate">{m.summary}</span>
                      <span className="agenda__meta truncate">{shortRoom(m.location)}</span>
                    </span>
                  </div>
                ))
              )}
            </div>
          </Card>

          <Card>
            <CardHead className="card__head" title="Term" subtitle={`${fmtDay(term.first)} — ${fmtDay(term.last)}`} />
            <div className="card__body">
              <Metric value={`${done}/${meetings.length}`} sub="meetings behind you" />
              <Meter value={meetings.length ? done / meetings.length : 0} label="Term progress" />
              <span className="micro muted">
                {nowInTerm ? `Week ${nowWeekNo} of ${term.weeks}` : `${term.weeks} weeks · not in session`}
              </span>
            </div>
          </Card>
        </div>

        {/* ---------------- the timetable ---------------- */}
        <Card className="span-9" aria-label="Weekly timetable">
          <CardHead
            className="card__head"
            title={`Week of ${fmtDay(week.start)}`}
            subtitle={inTerm ? `Week ${weekNo} · ${week.count} meetings` : 'Outside the term'}
            right={
              <span className="row" style={{ gap: '6px' }}>
                <Pill className="pill--micro" onClick={() => shiftWeek(-1)} aria-label="Previous week">
                  <ChevronLeft size={13} strokeWidth={1.5} aria-hidden="true" />
                </Pill>
                <Pill className="pill--micro" onClick={jumpToToday}>
                  <span className="pill__label">Today</span>
                </Pill>
                <Pill className="pill--micro" onClick={() => shiftWeek(1)} aria-label="Next week">
                  <ChevronRight size={13} strokeWidth={1.5} aria-hidden="true" />
                </Pill>
              </span>
            }
          />

          <div className="card__body">
            <div className="sched">
              <div className="sched__axis">
                <span className="sched__axishead" aria-hidden="true" />
                <div className="sched__ticks">
                  {term.hours.map((min) => (
                    <span
                      key={min}
                      className="sched__tick"
                      style={{ '--at': `${((min - term.fromMin) / term.span) * 100}%` }}
                    >
                      {hourLabel(min)}
                    </span>
                  ))}
                </div>
              </div>

              <div className="sched__cols">
                {week.cols.map((col) => (
                  <div key={col.dow} className={cx('sched__col', col.today && 'is-today')}>
                    <div className="sched__colhead">
                      <span className="sched__dow">{DAY_LABEL[col.dow]}</span>
                      <span className="sched__date">{col.date.getDate()}</span>
                    </div>

                    <div className="sched__lane">
                      {term.hours.map((min) => (
                        <span
                          key={min}
                          className="sched__rule"
                          style={{ '--at': `${((min - term.fromMin) / term.span) * 100}%` }}
                          aria-hidden="true"
                        />
                      ))}

                      {col.off ? <span className="sched__off">no classes</span> : null}

                      {col.meetings.map((m) => (
                        <article
                          key={`${m.seriesId}-${m.start.getTime()}`}
                          className={cx(
                            'sched__block',
                            m.end.getTime() <= nowTs && 'is-past',
                            live && m.start.getTime() === live.start.getTime() && m.seriesId === live.seriesId && 'is-live'
                          )}
                          style={{
                            '--top': `${topOf(m)}%`,
                            '--h': `${heightOf(m)}%`,
                            '--lane': m.lane,
                            '--lanes': m.lanes,
                          }}
                        >
                          <span className="sched__title">{m.summary}</span>
                          <span className="sched__when">{fmtRange(m.start, m.end)}</span>
                          <span className="sched__where truncate">{shortRoom(m.location)}</span>
                        </article>
                      ))}

                      {col.today && nowInGrid ? (
                        <span
                          className="sched__now"
                          style={{ '--at': `${((nowMin - term.fromMin) / term.span) * 100}%` }}
                          aria-label="Current time"
                        />
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </Card>

        {/* ---------------- the courses ---------------- */}
        <Card className="span-12">
          <CardHead
            className="card__head"
            title="Courses"
            subtitle="Every meeting pattern in the term"
            right={<span className="micro dim">{series.length}</span>}
          />
          <div className="card__body card__body--tight">
            {series.map((s) => (
              <div key={s.id} className="courserow">
                <span className="courserow__name truncate">{s.summary}</span>
                <span className="courserow__days">{s.days.map((d) => DAY_LABEL[d]).join(' · ')}</span>
                <span className="courserow__time nowrap">
                  {fmtTime(s.first)}–{fmtTime(new Date(s.first.getTime() + s.durationMin * 60000))}
                </span>
                <span className="courserow__where truncate">{s.location}</span>
                <span className="courserow__count micro dim nowrap">{s.count} meetings</span>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </>
  )
}
