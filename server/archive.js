/**
 * archive.js — reading the archive, in one place.
 *
 * The row-to-JSON shape used to live inside index.js, which was fine while the
 * routes were the only reader. The clerk is a second one, and it has to see
 * EXACTLY what the browser sees or it will give advice about a different
 * archive than the one on screen. So the shape moved here and both import it.
 *
 * It also answers the two questions the clerk asks that no route does: what the
 * numbers say (`snapshot`) and what the week looks like (`classes`).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { all, batch, get } from './db.js';

/* The app's own arithmetic, imported rather than reimplemented.
   ---------------------------------------------------------------------------
   These two modules are plain ESM with no imports and no browser globals,
   which is what makes this legal from Node. It is also the only honest option:
   if the clerk counted overdue entries itself, there would be two definitions
   of "overdue" in the repo and the day they disagreed the clerk would be
   confidently wrong about a number the reader can see on the same screen. */
import { flattenEntries, globalStats, recommendations, statusTone, dayDiff } from '../src/lib/metrics.js';
import { parseCalendar } from '../src/lib/ics.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function taskRowToJson(row, subtasks = []) {
  return {
    id: row.id,
    title: row.title,
    priority: row.priority,
    createdAt: row.created_at,
    dueDate: row.due_date,
    completed: !!row.completed,
    blockedBy: row.blocked_by,
    parentTaskId: row.parent_task_id ?? null,
    subtasks,
  };
}

export function projectRowToJson(p, tasks) {
  return {
    id: p.id,
    folderId: p.folder_id ?? null,
    name: p.name,
    openedAt: p.opened_at,
    parentId: p.parent_id,
    sortOrder: p.sort_order,
    tasks,
  };
}

/** Every case with its entries and their subtasks — the GET /api/projects body. */
export async function loadProjects() {
  /* Three queries, grouped here, rather than one per case and another per
     entry: the archive is read on every load and after every edit, and the
     old shape cost a round of SQLite work for each row it returned. The
     orders are the same ones the per-row queries used. Sent as one batch, so
     hosted it is one round trip to the database rather than three. */
  const [projects, entries, subtasks] = await batch([
    ['SELECT * FROM projects ORDER BY sort_order ASC'],
    ['SELECT * FROM tasks WHERE parent_task_id IS NULL ORDER BY created_at DESC'],
    ['SELECT * FROM tasks WHERE parent_task_id IS NOT NULL ORDER BY created_at ASC'],
  ], 'read');

  const group = (rows, key) => {
    const by = new Map();
    for (const row of rows) {
      const list = by.get(row[key]);
      if (list) list.push(row);
      else by.set(row[key], [row]);
    }
    return by;
  };
  const entriesOf = group(entries, 'project_id');
  const subtasksOf = group(subtasks, 'parent_task_id');

  return projects.map((p) => projectRowToJson(
    p,
    (entriesOf.get(p.id) || []).map((t) => taskRowToJson(t, (subtasksOf.get(t.id) || []).map((s) => taskRowToJson(s)))),
  ));
}

export async function loadCaseFolders() {
  return (await all('SELECT * FROM case_folders ORDER BY created_at ASC'))
    .map((f) => ({ id: f.id, name: f.name }));
}

/* ------------------------------------------------------------------ classes */

/* Same precedence as the frontend: the timetable you uploaded (stored in the
   database, so the hosted app has it too) wins, then a local file, and the
   sample is what makes a fresh clone work at all. */
const ICS_CANDIDATES = [
  path.join(__dirname, '..', 'src', 'data', 'class-calendar.local.ics'),
  path.join(__dirname, '..', 'src', 'data', 'class-calendar.ics'),
];

let fileCache = null;
let icsCache = null;
let storedAt = undefined;   // the stored timetable's updated_at the cache was parsed from

function readFiles() {
  if (fileCache) return fileCache;
  for (const file of ICS_CANDIDATES) {
    try {
      if (!fs.existsSync(file)) continue;
      const parsed = parseCalendar(fs.readFileSync(file, 'utf8'));
      fileCache = { ...parsed, sample: file.endsWith('class-calendar.ics') };
      return fileCache;
    } catch {
      /* A malformed timetable must not take the clerk down with it — the brief
         is still worth reading without the classes in it. */
    }
  }
  fileCache = { calendarName: '', series: [], meetings: [], sample: true };
  return fileCache;
}

/**
 * Brings the parsed timetable up to date with the database. One small query
 * when nothing has changed; the .ics is only fetched and re-expanded when the
 * stored one is newer than the copy in memory, which matters hosted, where an
 * upload lands on one server instance and the others have to notice.
 * Called by snapshot() and by the clerk's timetable tool before reading.
 */
export async function loadCalendar() {
  try {
    const row = await get('SELECT updated_at FROM timetable WHERE id = 1');
    const at = row ? row.updated_at : null;
    if (at === storedAt && icsCache) return icsCache;
    if (at === null) {
      icsCache = readFiles();
    } else {
      const full = await get('SELECT ics FROM timetable WHERE id = 1');
      icsCache = { ...parseCalendar(full ? full.ics : ''), sample: false };
    }
    storedAt = at;
  } catch {
    if (!icsCache) icsCache = readFiles();
  }
  return icsCache;
}

/* The synchronous readers below use whatever loadCalendar() last settled on. */
function readCalendar() {
  return icsCache || readFiles();
}

const dayKey = (d) => {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x.getTime();
};

const hhmm = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

/**
 * Classes on a given day, in order. Wall-clock, like everywhere else in this
 * app — a 09:30 class reads 09:30, and the clerk says 09:30.
 */
export function classesOn(ts) {
  const { meetings } = readCalendar();
  const want = dayKey(ts);
  return meetings
    .filter((m) => dayKey(m.start) === want)
    .map((m) => ({
      course: m.summary,
      where: m.location || '',
      from: hhmm(m.start),
      to: hhmm(m.end),
      startMinutes: m.start.getHours() * 60 + m.start.getMinutes(),
      endMinutes: m.end.getHours() * 60 + m.end.getMinutes(),
    }));
}

/** The courses the timetable knows about — what "CS 341" can be matched against. */
export function courses() {
  const { series } = readCalendar();
  return [...new Set(series.map((s) => s.summary).filter(Boolean))];
}

/** Classes across a window, grouped by day. Used by filing to resolve "week 9". */
export function classWeek(ts, days = 7) {
  const out = [];
  for (let i = 0; i < days; i += 1) {
    const d = new Date(dayKey(ts) + i * 86400000);
    const on = classesOn(d.getTime());
    if (on.length) out.push({ date: d.toISOString().slice(0, 10), classes: on });
  }
  return out;
}

/* ------------------------------------------------------------------ the facts */

const ymd = (ts) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/**
 * Everything true about the archive right now, counted by the app's own code.
 *
 * This is what the clerk is HANDED. It is never asked to count — a model that
 * tallies overdue entries will eventually say four when the screen says three,
 * and one visibly wrong number costs more trust than the whole feature earns.
 * It is asked to read these numbers and say what to do about them.
 */
export async function snapshot(now = Date.now(), { limit = 24 } = {}) {
  const [projects] = await Promise.all([loadProjects(), loadCalendar()]);
  const entries = flattenEntries(projects);
  const stats = globalStats(projects, now);

  const open = entries.filter((e) => !e.completed);

  const dated = open
    .filter((e) => Number.isFinite(e.dueDate))
    .sort((a, b) => a.dueDate - b.dueDate)
    .slice(0, limit)
    .map((e) => ({
      id: e.id,
      title: e.title,
      case: e.projectName,
      due: ymd(e.dueDate),
      inDays: dayDiff(e.dueDate, now),
      state: statusTone(e.dueDate, now),
      priority: e.priority,
      isSubtask: !!e.isSub,
    }));

  const undated = open
    .filter((e) => !Number.isFinite(e.dueDate))
    .slice(0, 10)
    .map((e) => ({ id: e.id, title: e.title, case: e.projectName, priority: e.priority }));

  return {
    today: ymd(now),
    weekday: new Date(now).toLocaleDateString('en-GB', { weekday: 'long' }),
    clock: hhmm(new Date(now)),
    counts: {
      cases: projects.filter((p) => !p.parentId).length,
      logged: stats.total,
      open: stats.open,
      done: stats.done,
      overdue: stats.overdue,
      dueSoon: stats.dueSoon,
      completionPct: Math.round(stats.completion * 100),
      oldestIdleDays: stats.oldestIdle,
    },
    cases: projects.map((p) => ({
      id: p.id,
      name: p.name,
      parentId: p.parentId ?? null,
      open: (p.tasks || []).filter((t) => !t.completed).length,
      total: (p.tasks || []).length,
    })),
    dueNext: dated,
    undated,
    classesToday: classesOn(now),
    /* The rule-based commentary, handed over as a starting point rather than
       replaced. It is already correct; the clerk's job is to say the part it
       cannot — what the day should look like given all of it at once. */
    signals: recommendations(projects, now).map((t) => t.body),
  };
}
