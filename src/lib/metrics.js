/**
 * metrics.js — every number the dashboard shows, derived from the raw
 * `/api/projects` payload. Pure functions only: no React, no fetch, no module
 * level state, and NO `Date.now()` anywhere outside a function body.
 *
 * `now` is always passed in by the caller (the app owns one clock, ticking on
 * an interval) so that a dashboard rendered at 23:59 is correct at 00:01.
 *
 * Shapes this file consumes (see the API contract):
 *   project = { id, name, openedAt, parentId, sortOrder, tasks[] }
 *   task    = { id, title, priority:'low'|'normal'|'high', createdAt,
 *               dueDate|null, completed, blockedBy, parentTaskId, subtasks[] }
 *
 * Everything here tolerates a fresh, empty database: null projects, missing
 * `tasks` arrays, missing `subtasks` arrays, null `dueDate`, garbage
 * timestamps. Nothing in this file may throw.
 */

export const DAY_MS = 86400000;

/** an open entry due within this many days counts as 'soon'. */
export const SOON_DAYS = 2;

/** due today or tomorrow. Past this the deadline is not yet immediate. */
export const URGENT_DAYS = 1;

/** an open entry older than this reads as stalled in the commentary. */
export const STALE_DAYS = 14;

const WEEKDAY_KEYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** the six points of the working day used by the completion timeline. */
const WORKING_HOURS = [9, 11, 13, 15, 17, 19];

const EN_DASH = '–';

/* ------------------------------------------------------------------ *
 * time helpers — local calendar days, DST safe                        *
 * ------------------------------------------------------------------ */

/** coerce anything the API (or a stale cache) might hand us to epoch ms, or NaN. */
function toTime(value) {
  if (value === null || value === undefined || value === '') return NaN;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
  if (typeof value === 'string') {
    const asNumber = Number(value);
    if (Number.isFinite(asNumber) && value.trim() !== '') return asNumber;
    return Date.parse(value);
  }
  return NaN;
}

/** the clock the caller passed, coerced; falls back to 0 rather than throwing. */
function nowMs(now) {
  const t = toTime(now);
  return Number.isFinite(t) ? t : 0;
}

/** midnight, local time, of the calendar day containing `ts`. NaN in → NaN out. */
export function startOfDay(ts) {
  const t = toTime(ts);
  if (!Number.isFinite(t)) return NaN;
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** midnight `n` calendar days after the day containing `ts` (survives DST). */
function addDays(ts, n) {
  const t = toTime(ts);
  if (!Number.isFinite(t)) return NaN;
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + n);
  return d.getTime();
}

/**
 * whole calendar days from `b` to `a` (positive when `a` is later).
 * Rounded, so the 23h and 25h days either side of a DST switch still read as 1.
 */
export function dayDiff(a, b) {
  const x = startOfDay(a);
  const y = startOfDay(b);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return NaN;
  return Math.round((x - y) / DAY_MS);
}

/* ------------------------------------------------------------------ *
 * entries                                                             *
 * ------------------------------------------------------------------ */

/**
 * Flatten every case into a single list of entries, subtasks included, each
 * tagged with the case it belongs to.
 *
 * Subtasks are real entries — they can be completed and they carry their own
 * createdAt — so they are counted in every statistic below. `isSub` lets a
 * view separate them again when it wants to (the CaseFiles "Subtasks" tile).
 */
export function flattenEntries(projects) {
  const list = [];
  if (!Array.isArray(projects)) return list;

  for (const project of projects) {
    if (!project || typeof project !== 'object') continue;
    const projectId = project.id;
    const projectName = typeof project.name === 'string' ? project.name : '';
    const tasks = Array.isArray(project.tasks) ? project.tasks : [];

    for (const task of tasks) {
      if (!task || typeof task !== 'object') continue;
      list.push({
        ...task,
        completed: !!task.completed,
        dueDate: Number.isFinite(toTime(task.dueDate)) ? toTime(task.dueDate) : null,
        projectId,
        projectName,
        isSub: false,
      });

      const subtasks = Array.isArray(task.subtasks) ? task.subtasks : [];
      for (const sub of subtasks) {
        if (!sub || typeof sub !== 'object') continue;
        list.push({
          ...sub,
          completed: !!sub.completed,
          dueDate: Number.isFinite(toTime(sub.dueDate)) ? toTime(sub.dueDate) : null,
          parentTaskId: sub.parentTaskId ?? task.id,
          projectId,
          projectName,
          isSub: true,
        });
      }
    }
  }

  return list;
}

/**
 * How a due date reads right now.
 *   'none'    — no due date set
 *   'overdue' — the due day is behind us
 *   'soon'    — due today or within SOON_DAYS days
 *   'later'   — further out than that
 * Compared by calendar day, not by clock: something due "today" is not late
 * until tomorrow.
 */
export function statusTone(dueDate, now) {
  const due = toTime(dueDate);
  if (!Number.isFinite(due)) return 'none';
  const diff = dayDiff(due, nowMs(now));
  if (!Number.isFinite(diff)) return 'none';
  if (diff < 0) return 'overdue';
  if (diff <= SOON_DAYS) return 'soon';
  return 'later';
}

/**
 * The same reading, one band finer, for anything that colour-codes a deadline.
 *
 *   'overdue' — the due day is behind us
 *   'urgent'  — due today or tomorrow
 *   'soon'    — due inside the SOON_DAYS window but not yet immediate
 *   'later'   — further out
 *   'none'    — no due date
 *
 * Deliberately NOT folded into statusTone: Reporting buckets its queue on that
 * function, and splitting 'soon' there would silently re-sort the whole screen.
 * Two callers wanting different granularity is a reason for two functions.
 */
export function urgencyTone(dueDate, now) {
  const due = toTime(dueDate);
  if (!Number.isFinite(due)) return 'none';
  const diff = dayDiff(due, nowMs(now));
  if (!Number.isFinite(diff)) return 'none';
  if (diff < 0) return 'overdue';
  if (diff <= URGENT_DAYS) return 'urgent';
  if (diff <= SOON_DAYS) return 'soon';
  return 'later';
}

/* ------------------------------------------------------------------ *
 * stats                                                               *
 * ------------------------------------------------------------------ */

function emptyStats() {
  return {
    open: 0,
    done: 0,
    overdue: 0,
    dueSoon: 0,
    total: 0,
    completion: 0,
    nextDue: null,
    nextDueEntry: null,
    oldestIdle: 0,
    oldestIdleEntry: null,
    subs: 0,
    high: 0,
  };
}

function statsFromEntries(entries, now) {
  const stats = emptyStats();
  if (!Array.isArray(entries) || entries.length === 0) return stats;

  const t = nowMs(now);
  const today = startOfDay(t);

  for (const entry of entries) {
    if (!entry) continue;
    stats.total += 1;
    if (entry.isSub) stats.subs += 1;

    if (entry.completed) {
      stats.done += 1;
      continue;
    }

    stats.open += 1;
    if (entry.priority === 'high') stats.high += 1;

    const tone = statusTone(entry.dueDate, t);
    if (tone === 'overdue') stats.overdue += 1;
    if (tone === 'soon') stats.dueSoon += 1;

    // next due = the soonest date still ahead of us (overdue is its own metric)
    const due = toTime(entry.dueDate);
    if (Number.isFinite(due) && startOfDay(due) >= today) {
      if (stats.nextDue === null || due < stats.nextDue) {
        stats.nextDue = due;
        stats.nextDueEntry = entry;
      }
    }

    // oldest idle = age in days of the longest-open entry
    const created = toTime(entry.createdAt);
    if (Number.isFinite(created)) {
      const age = Math.max(0, dayDiff(t, created));
      if (Number.isFinite(age) && (!stats.oldestIdleEntry || age > stats.oldestIdle)) {
        stats.oldestIdle = age;
        stats.oldestIdleEntry = entry;
      }
    }
  }

  stats.completion = stats.total > 0 ? stats.done / stats.total : 0;
  return stats;
}

/** Stats for one case (subtasks included). Safe on a null / task-less project. */
export function caseStats(project, now) {
  if (!project || typeof project !== 'object') return emptyStats();
  return statsFromEntries(flattenEntries([project]), now);
}

/** The same shape, across every case. */
export function globalStats(projects, now) {
  return statsFromEntries(flattenEntries(projects), now);
}

/* ------------------------------------------------------------------ *
 * series                                                              *
 * ------------------------------------------------------------------ */

/**
 * The API stores no `completedAt` — a task row only knows whether it is
 * completed *now*. So "closed on day X" cannot be read from the data. Rather
 * than invent a field, we bucket a completed entry by the best signal it
 * actually carries: its due date when it has one (the day the work was aimed
 * at), otherwise the day it was created. It is an approximation, and it is the
 * honest one available.
 */
function closedSignal(entry) {
  const due = toTime(entry.dueDate);
  if (Number.isFinite(due)) return due;
  return toTime(entry.createdAt);
}

/**
 * Counts per local calendar day, oldest first, always exactly `days` long —
 * zero-filled where there is no data, so a chart is never a stub two bars wide.
 * The last bucket is today.
 *
 *   opened  — entries created that day
 *   closed  — completed entries, bucketed by closedSignal() above
 *   overdue — a RUNNING count: how many entries stood past due on that day,
 *             not how many went past due that day
 */
export function dailySeries(projects, now, days = 30) {
  const span = Number.isFinite(days) && days > 0 ? Math.floor(days) : 30;
  const t = nowMs(now);
  const today = startOfDay(t);

  const dayStarts = new Array(span);
  const index = new Map();
  for (let i = 0; i < span; i += 1) {
    const start = addDays(today, i - (span - 1));
    dayStarts[i] = start;
    index.set(start, i);
  }

  const opened = new Array(span).fill(0);
  const closed = new Array(span).fill(0);
  const overdue = new Array(span).fill(0);

  const entries = flattenEntries(projects);

  for (const entry of entries) {
    const createdBucket = index.get(startOfDay(entry.createdAt));
    if (createdBucket !== undefined) opened[createdBucket] += 1;

    if (entry.completed) {
      const closedBucket = index.get(startOfDay(closedSignal(entry)));
      if (closedBucket !== undefined) closed[closedBucket] += 1;
    }
  }

  for (let i = 0; i < span; i += 1) {
    const dayStart = dayStarts[i];
    let count = 0;

    for (const entry of entries) {
      const due = startOfDay(entry.dueDate);
      // not yet late on this day (something due on day D is late from D+1)
      if (!Number.isFinite(due) || due >= dayStart) continue;

      // it did not exist yet on this day
      const created = startOfDay(entry.createdAt);
      if (Number.isFinite(created) && created > dayStart) continue;

      // if it is closed now, assume it was still open up to its closed signal
      if (entry.completed) {
        const done = startOfDay(closedSignal(entry));
        if (Number.isFinite(done) && done < dayStart) continue;
      }

      count += 1;
    }

    overdue[i] = count;
  }

  return { opened, closed, overdue };
}

/** '52–71' with an EN DASH, or plain '47' when the range is a single value. */
export function fmtRange(min, max) {
  const lo = Number.isFinite(min) ? Math.round(min) : 0;
  const hi = Number.isFinite(max) ? Math.round(max) : 0;
  const a = Math.min(lo, hi);
  const b = Math.max(lo, hi);
  return a === b ? String(a) : `${a}${EN_DASH}${b}`;
}

/** { min, max, label } for a numeric series. Empty / junk series → 0, 0, '0'. */
export function rangeOf(series) {
  if (!Array.isArray(series) || series.length === 0) {
    return { min: 0, max: 0, label: fmtRange(0, 0) };
  }

  let min = Infinity;
  let max = -Infinity;
  for (const value of series) {
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(n)) continue;
    if (n < min) min = n;
    if (n > max) max = n;
  }

  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return { min: 0, max: 0, label: fmtRange(0, 0) };
  }

  return { min, max, label: fmtRange(min, max) };
}

/**
 * Mon..Sun rows for the current week, "entries logged per day".
 * `active` is today. `dir` compares each day with the one before it (the first
 * row compares against the last day of the previous week, so it is never
 * arbitrary). `weekStart` is 1 for Monday (default) or 0 for Sunday, which is
 * what the Settings week-start control feeds in.
 */
export function weekRows(projects, now, weekStart = 1) {
  const t = nowMs(now);
  const today = startOfDay(t);
  const start = weekStart === 0 ? 0 : 1;

  const todayDow = new Date(today).getDay();
  const offset = (todayDow - start + 7) % 7;
  const firstDay = addDays(today, -offset);

  const entries = flattenEntries(projects);

  // count of entries created per day, keyed by the day's midnight
  const counts = new Map();
  for (const entry of entries) {
    const key = startOfDay(entry.createdAt);
    if (!Number.isFinite(key)) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const rows = [];
  for (let i = 0; i < 7; i += 1) {
    const dayStart = addDays(firstDay, i);
    const value = counts.get(dayStart) ?? 0;
    const prev = counts.get(addDays(firstDay, i - 1)) ?? 0;
    rows.push({
      key: WEEKDAY_KEYS[new Date(dayStart).getDay()],
      value,
      unit: '',
      dir: value >= prev ? 'up' : 'down',
      active: dayStart === today,
    });
  }

  return rows;
}

/**
 * Six points across the working day (9AM → 7PM). A point is `filled` once that
 * hour has passed today — the API records no completion times, so this is a
 * clock, honestly, not a claim about when work got done.
 */
export function completionTimeline(projects, now) {
  const t = nowMs(now);
  const today = startOfDay(t);

  return WORKING_HOURS.map(hour => {
    const at = Number.isFinite(today) ? today + hour * 3600000 : NaN;
    const label = hour === 12 ? '12PM' : hour > 12 ? `${hour - 12}PM` : `${hour}AM`;
    return { label, filled: Number.isFinite(at) ? t >= at : false };
  });
}

/* ------------------------------------------------------------------ *
 * commentary                                                          *
 * ------------------------------------------------------------------ */

function plural(n, one, many) {
  return n === 1 ? one : many;
}

/**
 * The app's generated commentary, in its existing voice: lowercase sentences,
 * an em dash, no exclamation marks. Most urgent first, at most four, and the
 * first one always renders on a sage card.
 *
 * Each tip: { id, tone:'sage'|'dark', body, meta, note, ref }
 *   body — the sentence
 *   meta — 'Today recommendation' for things to act on, 'Analysis' otherwise
 *   note — the duration / quantity that produced the sentence
 *   ref  — the entry title behind the tip, when one entry drove it (may be '')
 */
export function recommendations(projects, now) {
  const t = nowMs(now);
  const entries = flattenEntries(projects);
  const stats = statsFromEntries(entries, t);
  const tips = [];

  if (stats.total === 0) {
    tips.push({
      id: 'empty',
      body: 'no entries yet — open a case and log the first one.',
      meta: 'Today recommendation',
      note: 'nothing tracked',
      ref: '',
    });
  }

  if (stats.overdue > 0) {
    let worstLate = 1;
    for (const entry of entries) {
      if (entry.completed) continue;
      if (statusTone(entry.dueDate, t) !== 'overdue') continue;
      const late = dayDiff(t, entry.dueDate);
      if (Number.isFinite(late) && late > worstLate) worstLate = late;
    }
    tips.push({
      id: 'overdue',
      body: `${stats.overdue} ${plural(stats.overdue, 'entry', 'entries')} past due — needs attention.`,
      meta: 'Today recommendation',
      note: `oldest ${worstLate}d late`,
      ref: '',
    });
  }

  const imminent = entries
    .filter(e => !e.completed && e.priority === 'high' && statusTone(e.dueDate, t) === 'soon')
    .sort((a, b) => toTime(a.dueDate) - toTime(b.dueDate))[0];

  if (imminent) {
    const left = Math.max(0, dayDiff(imminent.dueDate, t));
    const when = left === 0 ? 'due today' : `due in ${left}d`;
    tips.push({
      id: 'imminent',
      body: `${when} and marked high. don't let this slip.`,
      meta: 'Today recommendation',
      note: left === 0 ? 'today' : `${left}d left`,
      ref: typeof imminent.title === 'string' ? imminent.title : '',
    });
  }

  if (stats.open > 0 && stats.oldestIdle >= STALE_DAYS) {
    tips.push({
      id: 'stalled',
      body: `stalled — oldest open entry sitting ${stats.oldestIdle}d.`,
      meta: 'Analysis',
      note: `${stats.oldestIdle}d idle`,
      ref: stats.oldestIdleEntry && typeof stats.oldestIdleEntry.title === 'string'
        ? stats.oldestIdleEntry.title
        : '',
    });
  }

  if (stats.dueSoon > 0) {
    const window = SOON_DAYS + 1;
    tips.push({
      id: 'due-soon',
      body: `${stats.dueSoon} ${plural(stats.dueSoon, 'entry', 'entries')} due within ${window}d — plan the run.`,
      meta: 'Analysis',
      note: `${window}d window`,
      ref: '',
    });
  }

  if (stats.total > 0 && stats.open === 0) {
    tips.push({
      id: 'clear',
      body: 'every entry is closed — nothing open right now.',
      meta: 'Analysis',
      note: `${stats.done} closed`,
      ref: '',
    });
  } else if (stats.open > 0 && stats.overdue === 0 && stats.dueSoon === 0) {
    tips.push({
      id: 'calm',
      body: 'nothing past due — the queue is clean.',
      meta: 'Analysis',
      note: `${stats.open} open`,
      ref: '',
    });
  }

  if (stats.total > 0) {
    tips.push({
      id: 'progress',
      body: `${Math.round(stats.completion * 100)}% of everything logged is closed.`,
      meta: 'Analysis',
      note: `${stats.done}/${stats.total} closed`,
      ref: '',
    });
  }

  return tips.slice(0, 4).map((tip, i) => ({ ...tip, tone: i === 0 ? 'sage' : 'dark' }));
}
