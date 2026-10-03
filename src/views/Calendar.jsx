/**
 * Calendar.jsx — two calendars over the same days, read-only.
 *
 *   Entries    — a month at a time: every dated entry in the archive, on the day
 *                it is due, whatever case it belongs to
 *   Classes    — the timetable proper, a week at a time, one column per day
 *
 * Both sit beside Next class · Today · Term, the three things you check between
 * rooms, and the switch between them is in the header.
 *
 * The timetable's source of truth is the registrar's own .ics, imported raw and
 * parsed at load. Nothing there is transcribed by hand, which means next term is
 * a file swap: drop the new export over src/data/class-calendar.ics and the
 * whole screen follows — courses, rooms, holidays, term length. The entry month
 * is the archive itself, live from the API like every other screen.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronLeft, ChevronRight } from 'lucide-react'

import { Card, CardHead, EmptyState, Meter, Metric, Pill, Segmented } from '../ui/primitives.jsx'
import { addDays, fmtTime, minutesOf, parseCalendar, sameDay, startOfDay, weekStartOf } from '../lib/ics.js'
import { statusTone } from '../lib/metrics.js'
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

/* ---- course work, hung off the timetable ---------------------------------
   The entries on a case are a title and a date and nothing else, so which
   column of the course schedule an entry came from has to be read back off its
   title. A field would mean a migration for a distinction only this screen
   cares about, and the titles are the user's own words either way.

   Unrecognised falls through to 'due', which is the safe default: an entry
   nobody classified lands under the day header rather than vanishing. */
const KINDS = [
  /* Before the exam rule, and deliberately narrow: it wants "Midterm review"
     and "Final exam review", not a bare "Review" on some other course, which
     has no reason to be treated as sitting an exam. */
  [/\b(midterm|final)\b.*\breview\b|\breview\b.*\b(midterm|final)\b/i, 'review'],
  [/\b(exam|midterm|final)\b/i, 'exam'],
  [/^\s*quiz\b/i, 'quiz'],
  [/^\s*readings?\b|^\s*pre[-\s]?class\b/i, 'reading'],
  [/^\s*lab\b/i, 'lab'],
  [/^\s*(hw|homework)\b/i, 'hw'],
]

function kindOf(title) {
  for (const [re, kind] of KINDS) if (re.test(title)) return kind
  return 'due'
}

/* Exams, quizzes and the reading happen AT a class, so they ride its block.
   Labs and homework are 11:59 PM deadlines with no class attached, so they go
   under the day header where they read as "today, whenever". */
const ON_CLASS = new Set(['exam', 'review', 'quiz', 'reading'])

const KIND_LABEL = {
  exam: 'Exam',
  review: 'Review session',
  quiz: 'Quiz',
  reading: 'Reading, before class',
  lab: 'Lab',
  hw: 'Homework',
  due: 'Entry',
}

/* The same shape standing() returns for a meeting, so both readouts can wear
   the same state line. Measured in whole days rather than hours: an entry is
   dated, not timed, and "in 19 hours" would be inventing a precision the data
   does not have. */
/* What the chip says to a screen reader. The visual readout is aria-hidden like
   ScheduleTip's, so this is the only version that actually reaches assistive
   tech and the two must not drift apart in content. */
function workLabel(item, nowTs) {
  const when = item.due.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })
  const kind = KIND_LABEL[item.kind] || 'Entry'
  /* The wash that marks a high-priority entry on the month grid is colour and
     nothing else, so it has to be said here or it does not exist for anyone
     reading with the screen off. */
  const flag = item.priority === 'high' ? ' High priority.' : ''
  return `${kind}: ${item.title}.${flag} ${item.course}, ${when} — ${workStanding(item, nowTs).text}`
}

function workStanding(item, nowTs) {
  if (item.done) return { tone: 'past', text: 'closed' }
  const days = Math.round((startOfDay(item.due) - startOfDay(nowTs)) / 86400000)
  if (days < 0) {
    const late = -days
    return { tone: 'live', text: `${late} ${late === 1 ? 'day' : 'days'} overdue` }
  }
  if (days === 0) return { tone: 'soon', text: 'today' }
  if (days === 1) return { tone: 'soon', text: 'tomorrow' }
  return { tone: 'later', text: `in ${days} days` }
}

function norm(value) {
  return String(value || '').toLowerCase().replace(/\s+/g, ' ').trim()
}

/* Chips are narrow. The parenthetical is the first thing that can go — it is
   always the qualifier, never the name — and the full title stays in the
   tooltip and the aria-label. */
function chipLabel(title) {
  return String(title).replace(/\s*\([^)]*\)\s*$/, '').trim() || String(title)
}

function dayKeyOf(date) {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`
}

function fmtDay(date) {
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

/* ---- the entry month ------------------------------------------------------
   The timetable is about course work: entries on cases named after a course,
   hung on the class they belong to. The month asks the opposite question —
   what is due, on what day — and so it takes every dated entry in the archive
   whether or not its case has a class attached to it. */

function startOfMonth(ts) {
  const d = new Date(ts)
  return new Date(d.getFullYear(), d.getMonth(), 1)
}

/* How many entries a cell lists before it starts counting them instead. This
   and the cell's minimum height in the stylesheet are one decision in two
   places: the cell holds CELL_MAX rows plus the "+n more" line, and it has to
   be a fixed height or the weeks stop being the same size as each other. */
const CELL_MAX = 4

/* What colours a chip. statusTone is the app's one definition of the deadline
   window — the same call the entry rows and the case graph make — so a date
   that reads amber on the dashboard cannot read white here. */
function entryTone(item, nowTs) {
  if (item.done) return 'done'
  const tone = statusTone(item.due.getTime(), nowTs)
  if (tone === 'overdue') return 'late'
  if (tone === 'soon') return 'soon'
  return 'open'
}

/**
 * The month grid.
 *
 * Days from the months either side are drawn rather than left blank, dimmed and
 * with their entries still on them: the last three days of the month you are
 * leaving are exactly what you want to see on the first row of the next one.
 */
function MonthGrid({ month, nowTs, hot, onEnter, onLeave, onOpen }) {
  return (
    <div className="month">
      <div className="month__dow" aria-hidden="true">
        {WEEK_ORDER.map((d) => (
          <span key={d} className="month__dowcell">{DAY_LABEL[d]}</span>
        ))}
      </div>

      <div className="month__grid">
        {month.cells.map((cell) => (
          <div
            key={cell.date.getTime()}
            className={cx('moncell', cell.out && 'is-out', cell.today && 'is-today')}
          >
            <div className="moncell__head">
              <span className="moncell__num">{cell.date.getDate()}</span>
            </div>

            <div className="moncell__list">
              {cell.items.slice(0, CELL_MAX).map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={cx(
                    'enttag',
                    `enttag--${entryTone(item, nowTs)}`,
                    /* Priority is a second thing about an entry, so it is drawn
                       in a second channel: the left rule keeps saying when this
                       is due, and the wash behind it says it is a high one.
                       Only while it is open — a closed entry has no priority
                       worth shouting about. */
                    item.priority === 'high' && !item.done && 'is-high',
                    hot && hot.work === item && 'is-hot'
                  )}
                  /* The readout is decoration for the pointer; this is what
                     actually reaches assistive tech, and it is the same
                     sentence the chips on the timetable carry. */
                  aria-label={workLabel(item, nowTs)}
                  onMouseEnter={(e) => onEnter(item, e.currentTarget)}
                  onMouseLeave={onLeave}
                  onFocus={(e) => onEnter(item, e.currentTarget)}
                  onBlur={onLeave}
                  onClick={() => onOpen(item)}
                >
                  {chipLabel(item.title)}
                </button>
              ))}

              {/* The cell is a fixed height — it has to be, or the weeks stop
                  matching each other — so the entries past the fourth are
                  counted rather than left to slide out of a hidden overflow
                  where nothing says they exist. */}
              {cell.items.length > CELL_MAX ? (
                <span
                  className="enttag enttag--more"
                  title={cell.items.slice(CELL_MAX).map((i) => i.title).join(', ')}
                >
                  {`+${cell.items.length - CELL_MAX} more`}
                </span>
              ) : null}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

/**
 * Everything the hover readout shows, as one sentence.
 *
 * The visual tip is aria-hidden; this is what actually reaches assistive tech,
 * so the two must not drift apart in content.
 */
function blockLabel(meeting, series, nowTs) {
  const bits = [
    meeting.summary,
    meeting.start.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' }),
    `${fmtTime(meeting.start)} to ${fmtTime(meeting.end)}`,
    fmtDuration(Math.round((meeting.end - meeting.start) / 60000)),
    meeting.location || 'no room listed',
    /* The chips on the block are decoration to a screen reader unless they are
       said here — this label is what actually reaches assistive tech. */
    ...(meeting.marks || []).map((k) => (k.done ? `${k.title} (done)` : k.title)),
    `session ${meeting.seriesIndex} of ${meeting.seriesCount}`,
    standing(meeting, nowTs).text.replace(' · ', ', '),
  ]
  if (series) bits.splice(5, 0, `meets ${series.days.map((d) => DAY_LABEL[d]).join(' and ')}`)
  return bits.join('. ')
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

/** `75` → `1h 15m`, `180` → `3h`, `45` → `45m`. */
function fmtDuration(min) {
  const h = Math.floor(min / 60)
  const m = min % 60
  if (!h) return `${m}m`
  return m ? `${h}h ${m}m` : `${h}h`
}

/**
 * Where this meeting sits relative to now, in words.
 *
 * Returned as a tone plus a phrase so the readout can colour the live case
 * without the caller re-deriving which case it is.
 */
function standing(meeting, nowTs) {
  const start = meeting.start.getTime()
  const end = meeting.end.getTime()
  if (nowTs >= end) return { tone: 'past', text: 'ended' }
  if (nowTs >= start) return { tone: 'live', text: `in progress · ${fmtDuration(Math.max(1, Math.round((end - nowTs) / 60000)))} left` }

  const mins = Math.round((start - nowTs) / 60000)
  if (mins < 60) return { tone: 'soon', text: `starts in ${mins}m` }
  if (mins < 24 * 60) return { tone: 'soon', text: `starts in ${fmtDuration(mins)}` }
  const days = Math.round(mins / (24 * 60))
  return { tone: 'later', text: `in ${days} ${days === 1 ? 'day' : 'days'}` }
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

/**
 * The hover readout for one meeting.
 *
 * Portalled to the body because the lane it sits in is `overflow: hidden` — a
 * tip rendered inside a block would be clipped to the block. Position is
 * measured after a hidden first paint rather than assumed, so the tip can flip
 * to the other side of a block near the right edge and still be clamped into
 * the viewport vertically.
 */
function useTipPosition(anchor, subject) {
  const ref = useRef(null)
  const [pos, setPos] = useState(null)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el || !anchor) return
    const GAP = 10
    const EDGE = 8
    const { width: w, height: h } = el.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight

    // Beside the anchor, on whichever side has room; never on top of it.
    let left = anchor.right + GAP
    if (left + w > vw - EDGE) left = anchor.left - GAP - w
    if (left < EDGE) left = Math.min(Math.max(EDGE, anchor.left), vw - w - EDGE)

    let top = anchor.top + anchor.height / 2 - h / 2
    top = Math.min(Math.max(EDGE, top), vh - h - EDGE)
    setPos({ top, left })
  }, [subject, anchor])

  return [ref, pos]
}

/**
 * The hover readout for one piece of course work — the same object the chip
 * under a day header or on a class block stands for.
 *
 * Shares ScheduleTip's furniture and its positioning deliberately: a chip and a
 * block are both things on this grid you point at to ask "what is this", and
 * two readouts that looked different would imply a distinction that is not
 * there.
 */
function WorkTip({ item, anchor, nowTs }) {
  const [ref, pos] = useTipPosition(anchor, item)
  if (typeof document === 'undefined') return null

  const state = workStanding(item, nowTs)
  const dayLine = item.due.toLocaleDateString(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  })

  return createPortal(
    <div
      ref={ref}
      className="schedtip"
      aria-hidden="true"
      style={{ top: pos ? pos.top : -9999, left: pos ? pos.left : -9999 }}
    >
      <div className="schedtip__title">{item.title}</div>
      <div className={cx('schedtip__state', `schedtip__state--${state.tone}`)}>{state.text}</div>

      <dl className="schedtip__rows">
        <div className="schedtip__row">
          <dt>What</dt>
          <dd>{KIND_LABEL[item.kind] || 'Entry'}</dd>
        </div>
        <div className="schedtip__row">
          <dt>Course</dt>
          <dd>{item.course}</dd>
        </div>
        {item.priority === 'high' ? (
          <div className="schedtip__row">
            <dt>Priority</dt>
            <dd className="hot">High</dd>
          </div>
        ) : null}
        <div className="schedtip__row">
          <dt>{ON_CLASS.has(item.kind) ? 'On' : 'Due'}</dt>
          <dd>
            {dayLine}
            <span className="schedtip__sub">
              {ON_CLASS.has(item.kind)
                ? 'at the class that day'
                : 'by the end of the day'}
            </span>
          </dd>
        </div>
      </dl>
    </div>,
    document.body
  )
}

function ScheduleTip({ meeting, series, anchor, nowTs }) {
  const [ref, pos] = useTipPosition(anchor, meeting)

  if (typeof document === 'undefined') return null

  const state = standing(meeting, nowTs)
  const dayLine = meeting.start.toLocaleDateString(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  })
  const durationMin = Math.round((meeting.end - meeting.start) / 60000)

  return createPortal(
    <div
      ref={ref}
      className="schedtip"
      // The block carries the same content in its aria-label, so this is
      // decoration for the pointer and must not be announced twice.
      aria-hidden="true"
      style={{ top: pos ? pos.top : -9999, left: pos ? pos.left : -9999 }}
    >
      <div className="schedtip__title">{meeting.summary}</div>
      <div className={cx('schedtip__state', `schedtip__state--${state.tone}`)}>{state.text}</div>

      <dl className="schedtip__rows">
        <div className="schedtip__row">
          <dt>When</dt>
          <dd>
            {dayLine}
            <span className="schedtip__sub">
              {fmtRange(meeting.start, meeting.end)} · {fmtDuration(durationMin)}
            </span>
          </dd>
        </div>
        <div className="schedtip__row">
          <dt>Where</dt>
          <dd>{meeting.location || 'No room listed'}</dd>
        </div>
        {series ? (
          <>
            <div className="schedtip__row">
              <dt>Meets</dt>
              <dd>
                {series.days.map((d) => DAY_LABEL[d]).join(' · ')}
                <span className="schedtip__sub">
                  {fmtDay(series.first)} — {fmtDay(series.last)}
                </span>
              </dd>
            </div>
            <div className="schedtip__row">
              <dt>Session</dt>
              <dd>
                {meeting.seriesIndex} of {meeting.seriesCount}
                <span className="schedtip__sub">
                  {meeting.seriesCount - meeting.seriesIndex} left after this
                </span>
              </dd>
            </div>
          </>
        ) : null}
      </dl>
    </div>,
    document.body
  )
}

export default function Calendar({ now, projects, onSelectCase }) {
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

  /* Every dated entry from a case that shares a course's name, bucketed by the
     day it falls on. Only those cases: this is the class calendar, and a
     personal case's deadlines on it would be noise rather than context. */
  const work = useMemo(() => {
    const courses = new Set(series.map((x) => norm(x.summary)))
    const map = new Map()
    for (const project of projects || []) {
      const course = norm(project.name)
      if (!courses.has(course)) continue
      for (const task of project.tasks || []) {
        if (!task.dueDate) continue
        const key = dayKeyOf(new Date(task.dueDate))
        let slot = map.get(key)
        if (!slot) { slot = { onClass: new Map(), due: [] }; map.set(key, slot) }
        const kind = kindOf(task.title)
        const item = {
          id: task.id,
          title: task.title,
          kind,
          done: !!task.completed,
          priority: task.priority || 'normal',
          course: project.name,
          due: new Date(task.dueDate),
        }
        if (ON_CLASS.has(kind)) {
          const list = slot.onClass.get(course)
          if (list) list.push(item)
          else slot.onClass.set(course, [item])
        } else {
          slot.due.push(item)
        }
      }
    }
    return map
  }, [projects, series])

  /* Every dated entry in the archive, bucketed by the day it falls on — the
     month grid's whole source. Deliberately not the `work` map above: that one
     is limited to cases named after a course and splits by whether the thing
     happens AT a class, which is the timetable's question and not this one.
     Subtasks carry their own dates, so they are entries here too. */
  const dated = useMemo(() => {
    const map = new Map()
    const put = (task, project) => {
      if (!task.dueDate) return
      const due = new Date(task.dueDate)
      if (Number.isNaN(due.getTime())) return
      const item = {
        id: task.id,
        title: task.title,
        kind: kindOf(task.title),
        done: !!task.completed,
        priority: task.priority || 'normal',
        course: project.name,
        projectId: project.id,
        due,
      }
      const key = dayKeyOf(due)
      const list = map.get(key)
      if (list) list.push(item)
      else map.set(key, [item])
    }
    for (const project of projects || []) {
      for (const task of project.tasks || []) {
        put(task, project)
        for (const sub of task.subtasks || []) put(sub, project)
      }
    }
    /* Still-open first and, among those, high priority first: a day with more
       entries than the cell can draw should spend its rows on the ones that are
       still owed, and on the ones that matter most among them. */
    const rank = (x) => (x.done ? 2 : x.priority === 'high' ? 0 : 1)
    for (const list of map.values()) {
      list.sort((a, b) => rank(a) - rank(b) || a.title.localeCompare(b.title))
    }
    return map
  }, [projects])

  const datedCount = useMemo(() => {
    let n = 0
    for (const list of dated.values()) n += list.length
    return n
  }, [dated])

  /* An entry opens the case it belongs to — and for one filed under a sub-case,
     the case at the top of that chain, because the case bar lists roots and
     handing it a sub-case id would land on whichever case happened to be
     first. The depth guard is for a parent chain that somehow points at
     itself; a cycle here would hang the screen rather than mis-route a click. */
  const rootOf = useMemo(() => {
    const byId = new Map((projects || []).map((x) => [x.id, x]))
    const map = new Map()
    for (const project of projects || []) {
      let at = project
      for (let i = 0; i < 8 && at && at.parentId; i += 1) at = byId.get(at.parentId) || at
      map.set(project.id, at ? at.id : project.id)
    }
    return map
  }, [projects])

  const openEntry = useCallback(
    (item) => {
      if (!onSelectCase) return
      onSelectCase(rootOf.get(item.projectId) || item.projectId)
    },
    [onSelectCase, rootOf]
  )

  /* Which of the two calendars is showing. Entries is the default: it is the
     one that answers "what is due", and the timetable repeats itself every week
     anyway, so it is the thing you look up rather than the thing you check. */
  const [mode, setMode] = useState('entries')

  const [monthTs, setMonthTs] = useState(() => startOfMonth(nowTs).getTime())

  const shiftMonth = useCallback((n) => {
    setMonthTs((ts) => {
      const d = new Date(ts)
      return new Date(d.getFullYear(), d.getMonth() + n, 1).getTime()
    })
  }, [])

  const jumpMonthToToday = useCallback(() => {
    setMonthTs(startOfMonth(nowTs).getTime())
  }, [nowTs])

  const month = useMemo(() => {
    const first = new Date(monthTs)
    const y = first.getFullYear()
    const m = first.getMonth()
    /* Monday-first, to match the timetable and the rest of the app's week. */
    const lead = (first.getDay() + 6) % 7
    const start = addDays(first, -lead)
    const length = new Date(y, m + 1, 0).getDate()
    /* Only as many weeks as this month actually needs: a February that starts
       on a Monday is four rows, and padding it to six would leave a band of
       empty cells implying days that are not there. */
    const weeks = Math.ceil((lead + length) / 7)
    const today = new Date(nowTs)

    const cells = []
    let count = 0
    for (let i = 0; i < weeks * 7; i += 1) {
      const date = addDays(start, i)
      const items = dated.get(dayKeyOf(date)) || []
      const out = date.getMonth() !== m
      if (!out) count += items.length
      cells.push({ date, out, items, today: sameDay(date, today) })
    }

    return {
      cells,
      count,
      label: first.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }),
      isNow: y === today.getFullYear() && m === today.getMonth(),
    }
  }, [monthTs, dated, nowTs])

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
      const packed = packDay(dayList)

      /* Hang each course's in-class work on its block. packDay clones, so
         writing onto these does not touch the parsed calendar. A course that
         meets twice in a day gets it on the first block only — claimed is what
         stops the same quiz appearing at 9am and again at 2pm. */
      const slot = work.get(dayKeyOf(date))
      const claimed = new Set()
      if (slot) {
        for (const m of packed) {
          const course = norm(m.summary)
          if (claimed.has(course)) continue
          const marks = slot.onClass.get(course)
          if (marks) { m.marks = marks; claimed.add(course) }
        }
      }

      /* An exam on a day its course does not meet — the final sits outside the
         term entirely — has no block to ride. It falls through to the strip
         rather than being silently dropped. */
      const stranded = []
      if (slot) {
        for (const [course, list] of slot.onClass) {
          if (!claimed.has(course)) stranded.push(...list)
        }
      }

      return {
        dow,
        date,
        today: sameDay(date, new Date(nowTs)),
        // A weekday inside the term with nothing on it is a holiday, and the
        // grid should say so — otherwise the EXDATEs just look like a gap.
        off: dayList.length === 0 && term && date >= startOfDay(term.first) && date <= term.last,
        meetings: packed,
        due: slot ? [...slot.due, ...stranded] : stranded,
      }
    })
    /* Reserved on every column or none. The strip is a flex row above the lane,
       so giving it to only the days that have something due would start those
       lanes lower than the rest and put every hour out of line with the axis. */
    const hasDue = cols.some((c) => c.due.length > 0)
    return { start, end, cols, count: inWeek.length, hasDue }
  }, [weekTs, meetings, term, nowTs, work])

  /* Which block the pointer (or keyboard focus) is on. Held as the meeting plus
     the rect it was measured from, so the readout does not have to re-query the
     DOM and cannot disagree with what is under the cursor. */
  const [hot, setHot] = useState(null)

  const showTip = useCallback((meeting, el) => {
    if (!el) return
    const r = el.getBoundingClientRect()
    setHot({ meeting, anchor: { top: r.top, left: r.left, right: r.right, height: r.height } })
  }, [])

  /* A chip. `meeting` comes along when the chip is sitting on a block, purely
     so the block stays lit while the pointer is on one of its chips — without
     it the class would go cold the moment you reached for its quiz. */
  const showWork = useCallback((item, el, meeting) => {
    if (!el) return
    const r = el.getBoundingClientRect()
    setHot({ work: item, meeting, anchor: { top: r.top, left: r.left, right: r.right, height: r.height } })
  }, [])

  const hideTip = useCallback(() => setHot(null), [])

  /* A fixed-position tip would drift away from its block on scroll, and the
     pointer may well have left the block by then anyway. Cheaper to dismiss. */
  useEffect(() => {
    if (!hot) return undefined
    window.addEventListener('scroll', hideTip, { passive: true, capture: true })
    window.addEventListener('resize', hideTip, { passive: true })
    return () => {
      window.removeEventListener('scroll', hideTip, { capture: true })
      window.removeEventListener('resize', hideTip)
    }
  }, [hot, hideTip])

  const seriesById = useMemo(() => new Map(series.map((x) => [x.id, x])), [series])

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

  /* Built once and used by both returns below. The switch has to be reachable
     even when the timetable has nothing in it — a calendar file that holds no
     events is no reason to withhold the entries. */
  const head = (
    <div className="viewhead">
      <div className="viewhead__left">
        <span className="section-label">Calendar</span>
        <Segmented
          items={[
            { value: 'entries', label: 'Entries' },
            { value: 'classes', label: 'Classes' },
          ]}
          value={mode}
          onChange={setMode}
          label="Which calendar"
        />
        {mode === 'classes' ? (
          <span className="micro dim">{termLabel || calendarName || 'Schedule'}</span>
        ) : null}
        {mode === 'classes' && usingSample ? (
          <span className="micro dim" title="Add src/data/class-calendar.local.ics to use your own">
            sample data
          </span>
        ) : null}
      </div>
      <div className="viewhead__right">
        {mode === 'entries' ? (
          <span className="micro muted">
            {datedCount} dated {datedCount === 1 ? 'entry' : 'entries'}
          </span>
        ) : (
          <>
            <span className="micro muted">{series.length} courses</span>
            <span className="micro dim">·</span>
            <span className="micro muted">{meetings.length} meetings</span>
          </>
        )}
      </div>
    </div>
  )

  /* The month card, which both returns place — on its own when there is no
     timetable to sit beside, and in the nine columns next to the class cards
     when there is. */
  const monthCard = (klass) => (
    <Card className={klass} aria-label="Entries by month">
      <CardHead
        className="card__head"
        title={month.label}
        subtitle={
          month.count
            ? `${month.count} ${month.count === 1 ? 'entry' : 'entries'} due`
            : 'Nothing due this month'
        }
        right={
          <span className="row" style={{ gap: '6px' }}>
            <Pill className="pill--micro" onClick={() => shiftMonth(-1)} aria-label="Previous month">
              <ChevronLeft size={13} strokeWidth={1.5} aria-hidden="true" />
            </Pill>
            <Pill className="pill--micro" onClick={jumpMonthToToday} disabled={month.isNow}>
              <span className="pill__label">Today</span>
            </Pill>
            <Pill className="pill--micro" onClick={() => shiftMonth(1)} aria-label="Next month">
              <ChevronRight size={13} strokeWidth={1.5} aria-hidden="true" />
            </Pill>
          </span>
        }
      />
      <div className="card__body">
        {datedCount === 0 ? (
          <EmptyState
            lead="Nothing has a date on it."
            hint="Give an entry a due date and it turns up here."
          />
        ) : (
          <MonthGrid
            month={month}
            nowTs={nowTs}
            hot={hot}
            onEnter={showWork}
            onLeave={hideTip}
            onOpen={openEntry}
          />
        )}
      </div>
    </Card>
  )

  if (!term) {
    return (
      <>
        {head}
        <div className="bento">
          {mode === 'entries' ? (
            monthCard('span-12')
          ) : (
            <Card className="span-12">
              <CardHead className="card__head" title="No schedule" subtitle="The calendar file holds no events" />
              <div className="card__body">
                <EmptyState
                  lead="Nothing to show."
                  hint="Replace src/data/class-calendar.ics with a registrar export."
                />
              </div>
            </Card>
          )}
        </div>
        {hot && hot.work ? <WorkTip item={hot.work} anchor={hot.anchor} nowTs={nowTs} /> : null}
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
      {head}

      <div className="bento">
        {/* ---------------- left column ---------------- */}
        <div className="span-3 stack">
          <Card>
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

        {/* ---------------- the calendar itself ---------------- */}
        {mode === 'entries' ? monthCard('span-9') : (
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
            <div className="sched" data-due={week.hasDue ? 'on' : 'off'}>
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

                    {/* Rendered on every column once any day in the week has
                        something due, empty ones included — see week.hasDue.
                        An empty strip is what keeps the lanes level. */}
                    {week.hasDue ? (
                      <div className="sched__due">
                        {col.due.slice(0, 2).map((d) => (
                          <span
                            key={d.id}
                            className={cx('duetag', `duetag--${d.kind}`, d.done && 'is-done')}
                            /* Focusable so the readout is reachable without a
                               pointer, exactly as the class blocks are. */
                            tabIndex={0}
                            aria-label={workLabel(d, nowTs)}
                            onMouseEnter={(e) => showWork(d, e.currentTarget)}
                            onMouseLeave={hideTip}
                            onFocus={(e) => showWork(d, e.currentTarget)}
                            onBlur={hideTip}
                          >
                            {chipLabel(d.title)}
                          </span>
                        ))}
                        {/* The strip is one fixed row — it has to be, or the
                            lanes stop lining up. So rather than let the extras
                            slide out of a hidden overflow where nothing says
                            they exist, they are counted. */}
                        {col.due.length > 2 ? (
                          <span
                            className="duetag duetag--more"
                            title={col.due.slice(2).map((d) => d.title).join(', ')}
                          >
                            {`+${col.due.length - 2}`}
                          </span>
                        ) : null}
                      </div>
                    ) : null}

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
                            live && m.start.getTime() === live.start.getTime() && m.seriesId === live.seriesId && 'is-live',
                            hot && hot.meeting === m && 'is-hot'
                          )}
                          style={{
                            '--top': `${topOf(m)}%`,
                            '--h': `${heightOf(m)}%`,
                            '--lane': m.lane,
                            '--lanes': m.lanes,
                          }}
                          /* Focusable, so the detail is reachable without a
                             pointer, and labelled with the same content the tip
                             shows so a screen reader never needs the hover. */
                          tabIndex={0}
                          aria-label={blockLabel(m, seriesById.get(m.seriesId), nowTs)}
                          onMouseEnter={(e) => showTip(m, e.currentTarget)}
                          onMouseLeave={hideTip}
                          onFocus={(e) => showTip(m, e.currentTarget)}
                          onBlur={hideTip}
                        >
                          <span className="sched__title">{m.summary}</span>
                          <span className="sched__when">{fmtRange(m.start, m.end)}</span>
                          {/* Above the room deliberately: if the block is ever
                              too short for everything, the room is what the
                              block gives up first (see .sched__where). */}
                          {m.marks ? (
                            <span className="sched__marks">
                              {m.marks.map((k) => (
                                <span
                                  key={k.id}
                                  className={cx('duetag', `duetag--${k.kind}`, k.done && 'is-done')}
                                  tabIndex={0}
                                  aria-label={workLabel(k, nowTs)}
                                  onMouseEnter={(e) => showWork(k, e.currentTarget, m)}
                                  /* Sliding off a chip usually means going back
                                     onto the class under it, and the block's own
                                     onMouseEnter will not fire again — it was
                                     never left. So hand the readout back rather
                                     than blanking it. */
                                  onMouseLeave={(e) => {
                                    const block = e.currentTarget.closest('.sched__block')
                                    if (block) showTip(m, block)
                                    else hideTip()
                                  }}
                                  onFocus={(e) => showWork(k, e.currentTarget, m)}
                                  onBlur={hideTip}
                                >
                                  {chipLabel(k.title)}
                                </span>
                              ))}
                            </span>
                          ) : null}
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
        )}

        {/* ---------------- the courses ----------------
            Every meeting pattern in the term, which is furniture for the
            timetable and has nothing to say about a month of due dates. */}
        {mode === 'classes' ? (
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
        ) : null}
      </div>

      {hot && hot.work ? <WorkTip item={hot.work} anchor={hot.anchor} nowTs={nowTs} /> : null}
      {hot && !hot.work ? (
        <ScheduleTip
          meeting={hot.meeting}
          series={seriesById.get(hot.meeting.seriesId)}
          anchor={hot.anchor}
          nowTs={nowTs}
        />
      ) : null}
    </>
  )
}
