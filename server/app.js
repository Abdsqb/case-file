import './tz.js';
import compression from 'compression';
import express from 'express';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import { all, batch, dbPath, get, run } from './db.js';
import { getHeadlines, resolveHeadlineLocation } from './news.js';
import { loadProjects, projectRowToJson, taskRowToJson } from './archive.js';
import * as clerk from './clerk.js';
import * as auth from './auth.js';
import { parseCalendar } from '../src/lib/ics.js';

/* app.js — every route, and nothing about where they run.
 *
 * The same Express app is started two ways: server/index.js listens on a port
 * and serves the built frontend on your PC, and api/index.js hands it to
 * Vercel, which serves the frontend from its CDN and calls this for /api/*.
 * So nothing in here listens, serves files or assumes a disk. */

const app = express();
/* Gzip (or Brotli, when the browser offers it) for everything over 1KB: the
   app bundle, the stylesheet, the archive JSON. Nothing here streams, so
   compressing whole responses holds nothing up. */
app.use(compression());
/* 2 MB rather than Express's 100 KB: a long notes pad or a full year's
   timetable is bigger than that, and Vercel's own cap (4.5 MB) is above it. */
app.use(express.json({ limit: '2mb' }));

/* Every route is async now that the archive is behind a network round trip,
   and Express 4 does not catch a rejected promise: a failed query would leave
   the request hanging until the platform timed it out. `wrap` hands the error
   to the handler at the bottom of this file instead. */
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/* The password, in front of everything below. A no-op on your PC, where no
   APP_PASSWORD is set; hosted, every route after this needs a session. */
app.use(auth.guard);
auth.mount(app, wrap);

/* taskRowToJson / projectRowToJson / loadProjects now live in archive.js, so
   the clerk reads the archive in exactly the shape the browser does. Two
   definitions of "a case, as JSON" is one more than this app can keep true. */

async function deleteProjectRecursive(id) {
  const children = await all('SELECT id FROM projects WHERE parent_id = ?', [id]);
  for (const child of children) await deleteProjectRecursive(child.id);
  await batch([
    ['DELETE FROM today_items WHERE task_id IN (SELECT id FROM tasks WHERE project_id = ?)', [id]],
    ['DELETE FROM tasks WHERE project_id = ?', [id]],
    ['DELETE FROM projects WHERE id = ?', [id]],
  ]);
}

app.get('/api/projects', wrap(async (req, res) => {
  res.json(await loadProjects());
}));

app.post('/api/projects', wrap(async (req, res) => {
  const { name, parentId = null } = req.body ?? {};
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'name is required' });
  }

  if (parentId) {
    const parent = await get('SELECT id FROM projects WHERE id = ?', [parentId]);
    if (!parent) {
      return res.status(404).json({ error: 'parent project not found' });
    }
  }

  const id = randomUUID();
  const openedAt = Date.now();
  const { max } = await get('SELECT MAX(sort_order) AS max FROM projects WHERE parent_id IS ?', [parentId]);
  const sortOrder = (max ?? -1) + 1;

  await run('INSERT INTO projects (id, name, opened_at, parent_id, sort_order) VALUES (?, ?, ?, ?, ?)',
    [id, name.trim(), openedAt, parentId, sortOrder]);

  res.status(201).json({ id, name: name.trim(), openedAt, parentId, sortOrder, tasks: [] });
}));

app.patch('/api/projects/:projectId', wrap(async (req, res) => {
  const { projectId } = req.params;
  const existing = await get('SELECT * FROM projects WHERE id = ?', [projectId]);
  if (!existing) {
    return res.status(404).json({ error: 'project not found' });
  }

  const body = req.body ?? {};
  const { name } = body;
  const renaming = name !== undefined;
  const reparenting = Object.prototype.hasOwnProperty.call(body, 'parentId');
  const refiling = Object.prototype.hasOwnProperty.call(body, 'folderId');

  if (renaming && (!name || !name.trim())) {
    return res.status(400).json({ error: 'name is required' });
  }
  if (!renaming && !reparenting && !refiling) {
    return res.status(400).json({ error: 'name, parentId or folderId is required' });
  }

  /* Filing is not parenting. folderId groups a case in the strip; parentId makes
     it a sub-case of another. They are independent, and this endpoint keeps them
     that way — moving a case into a folder never changes its parent. */
  let nextFolder = existing.folder_id ?? null;
  if (refiling) {
    nextFolder = body.folderId === null || body.folderId === '' ? null : body.folderId;
    if (nextFolder) {
      const f = await get('SELECT id FROM case_folders WHERE id = ?', [nextFolder]);
      if (!f) return res.status(404).json({ error: 'folder not found' });
    }
  }

  /* Re-parenting. A sub-case could be created but never un-nested, so the only
     way out was delete-and-recreate — which throws away every entry inside it.
     Moving the row keeps them. */
  let nextParent = existing.parent_id;
  if (reparenting) {
    nextParent = body.parentId === null || body.parentId === '' ? null : body.parentId;

    if (nextParent !== null) {
      const parent = await get('SELECT id FROM projects WHERE id = ?', [nextParent]);
      if (!parent) {
        return res.status(404).json({ error: 'parent project not found' });
      }
      if (nextParent === projectId) {
        return res.status(400).json({ error: 'a case cannot be its own parent' });
      }
      // Walking up from the proposed parent must not arrive back at this case,
      // or the subtree is detached from every root and disappears from the app.
      let cursor = parent.id;
      const guard = new Set();
      while (cursor) {
        if (cursor === projectId) {
          return res.status(400).json({ error: 'that move would nest a case inside itself' });
        }
        if (guard.has(cursor)) break;   // pre-existing cycle: stop rather than hang
        guard.add(cursor);
        const row = await get('SELECT parent_id FROM projects WHERE id = ?', [cursor]);
        cursor = row ? row.parent_id : null;
      }
    }
  }

  const nextName = renaming ? name.trim() : existing.name;

  if (reparenting && nextParent !== existing.parent_id) {
    // Land at the end of its new sibling list, the same place a new case lands.
    const { max } = await get('SELECT MAX(sort_order) AS max FROM projects WHERE parent_id IS ?', [nextParent]);
    await run('UPDATE projects SET name = ?, parent_id = ?, sort_order = ?, folder_id = ? WHERE id = ?',
      [nextName, nextParent, (max ?? -1) + 1, nextFolder, projectId]);
  } else {
    await run('UPDATE projects SET name = ?, folder_id = ? WHERE id = ?',
      [nextName, nextFolder, projectId]);
  }

  const after = await get('SELECT * FROM projects WHERE id = ?', [projectId]);
  res.json(projectRowToJson(after, undefined));
}));

app.post('/api/projects/:projectId/move', wrap(async (req, res) => {
  const { projectId } = req.params;
  const { direction } = req.body ?? {};
  if (direction !== 'up' && direction !== 'down') {
    return res.status(400).json({ error: 'direction must be "up" or "down"' });
  }

  const current = await get('SELECT * FROM projects WHERE id = ?', [projectId]);
  if (!current) {
    return res.status(404).json({ error: 'project not found' });
  }

  const siblings = await all('SELECT * FROM projects WHERE parent_id IS ? ORDER BY sort_order ASC', [current.parent_id]);
  const idx = siblings.findIndex(s => s.id === projectId);
  const swapIdx = direction === 'up' ? idx - 1 : idx + 1;

  if (swapIdx < 0 || swapIdx >= siblings.length) {
    return res.json({ moved: false });
  }

  const other = siblings[swapIdx];
  await batch([
    ['UPDATE projects SET sort_order = ? WHERE id = ?', [other.sort_order, current.id]],
    ['UPDATE projects SET sort_order = ? WHERE id = ?', [current.sort_order, other.id]],
  ]);

  res.json({ moved: true });
}));

app.delete('/api/projects/:projectId', wrap(async (req, res) => {
  const { projectId } = req.params;
  const existing = await get('SELECT id FROM projects WHERE id = ?', [projectId]);
  if (!existing) {
    return res.status(404).json({ error: 'project not found' });
  }

  await deleteProjectRecursive(projectId);
  res.status(204).end();
}));

app.post('/api/projects/:projectId/tasks', wrap(async (req, res) => {
  const { projectId } = req.params;
  const { title, priority = 'normal', dueDate = null } = req.body ?? {};

  if (!title || !title.trim()) {
    return res.status(400).json({ error: 'title is required' });
  }

  const project = await get('SELECT id FROM projects WHERE id = ?', [projectId]);
  if (!project) {
    return res.status(404).json({ error: 'project not found' });
  }

  const result = await run(`
    INSERT INTO tasks (project_id, title, priority, created_at, due_date, completed, blocked_by)
    VALUES (?, ?, ?, ?, ?, 0, NULL)
  `, [projectId, title.trim(), priority, Date.now(), dueDate]);

  const row = await get('SELECT * FROM tasks WHERE id = ?', [result.lastInsertRowid]);
  res.status(201).json(taskRowToJson(row));
}));

app.post('/api/tasks/:taskId/subtasks', wrap(async (req, res) => {
  const parentTaskId = Number(req.params.taskId);
  const { title } = req.body ?? {};

  if (!title || !title.trim()) {
    return res.status(400).json({ error: 'title is required' });
  }

  const parent = await get('SELECT * FROM tasks WHERE id = ?', [parentTaskId]);
  if (!parent) {
    return res.status(404).json({ error: 'task not found' });
  }
  if (parent.parent_task_id) {
    return res.status(400).json({ error: 'a subtask cannot have subtasks of its own' });
  }

  const result = await run(`
    INSERT INTO tasks (project_id, title, priority, created_at, due_date, completed, blocked_by, parent_task_id)
    VALUES (?, ?, 'normal', ?, NULL, 0, NULL, ?)
  `, [parent.project_id, title.trim(), Date.now(), parentTaskId]);

  const row = await get('SELECT * FROM tasks WHERE id = ?', [result.lastInsertRowid]);
  res.status(201).json(taskRowToJson(row));
}));

app.patch('/api/tasks/:taskId', wrap(async (req, res) => {
  const taskId = Number(req.params.taskId);
  const existing = await get('SELECT * FROM tasks WHERE id = ?', [taskId]);
  if (!existing) {
    return res.status(404).json({ error: 'task not found' });
  }

  const body = req.body ?? {};
  const title = body.title !== undefined ? String(body.title) : existing.title;
  const completed = body.completed !== undefined ? (body.completed ? 1 : 0) : existing.completed;
  const priority = body.priority !== undefined ? body.priority : existing.priority;
  const dueDate = body.dueDate !== undefined ? body.dueDate : existing.due_date;

  /* Re-parenting. `parentTaskId: <id>` makes this entry a subtask of that one;
     `parentTaskId: null` lifts it back to being an entry in its own right.
     Absent, nothing about its place changes.

     The same one-level-deep rule the subtask route enforces applies here, and
     it has to be checked from both ends: the entry being moved must have no
     subtasks of its own, and the one it is moving under must not already be a
     subtask. Either would make a grandchild. */
  let parentTaskId = existing.parent_task_id;
  let projectId = existing.project_id;

  if (body.parentTaskId !== undefined) {
    if (body.parentTaskId === null) {
      parentTaskId = null;
    } else {
      const wanted = Number(body.parentTaskId);
      if (!Number.isFinite(wanted)) {
        return res.status(400).json({ error: 'parentTaskId must be a task id or null' });
      }
      if (wanted === taskId) {
        return res.status(400).json({ error: 'an entry cannot be filed under itself' });
      }
      const parent = await get('SELECT * FROM tasks WHERE id = ?', [wanted]);
      if (!parent) {
        return res.status(404).json({ error: 'the entry it was dropped on no longer exists' });
      }
      if (parent.parent_task_id) {
        return res.status(400).json({ error: 'subtasks only go one level deep' });
      }
      const kids = (await get('SELECT COUNT(*) AS n FROM tasks WHERE parent_task_id = ?', [taskId])).n;
      if (kids > 0) {
        return res.status(400).json({
          error: 'this entry has subtasks of its own, so it cannot become one',
        });
      }
      parentTaskId = wanted;
      /* A subtask belongs to whatever case its parent is in — the same rule the
         subtask route applies when it copies the parent's project. Dragging
         across cases therefore moves the entry as well as nesting it. */
      projectId = parent.project_id;
    }
  }

  await run(`
    UPDATE tasks
       SET title = ?, completed = ?, priority = ?, due_date = ?,
           parent_task_id = ?, project_id = ?
     WHERE id = ?
  `, [title, completed, priority, dueDate ?? null, parentTaskId ?? null, projectId, taskId]);

  const row = await get('SELECT * FROM tasks WHERE id = ?', [taskId]);
  res.json(taskRowToJson(row));
}));

app.delete('/api/tasks/:taskId', wrap(async (req, res) => {
  const taskId = Number(req.params.taskId);
  const existing = await get('SELECT id FROM tasks WHERE id = ?', [taskId]);
  if (!existing) {
    return res.status(404).json({ error: 'task not found' });
  }

  await batch([
    ['DELETE FROM today_items WHERE task_id = ? OR task_id IN (SELECT id FROM tasks WHERE parent_task_id = ?)', [taskId, taskId]],
    ['DELETE FROM tasks WHERE parent_task_id = ?', [taskId]],
    ['DELETE FROM tasks WHERE id = ?', [taskId]],
  ]);
  res.status(204).end();
}));

// ---------- today's to-do ----------

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

/* The list for a day, in order, and — until the morning question has been
   answered — what is left over from the last day that had a list: the
   entries on it that are still open, still exist, and are not already on
   today's. Joined against tasks, so an entry deleted by any route (the clerk
   included) simply drops out rather than leaving a dangling row. */
async function readToday(day) {
  const [items, decidedRows, prevRows] = await batch([
    [`SELECT ti.task_id AS id FROM today_items ti JOIN tasks t ON t.id = ti.task_id
       WHERE ti.day = ? ORDER BY ti.sort_order ASC`, [day]],
    ['SELECT decided FROM today_days WHERE day = ?', [day]],
    ['SELECT MAX(day) AS day FROM today_items WHERE day < ?', [day]],
  ], 'read');
  const taskIds = items.map((r) => r.id);

  let offer = null;
  const decided = decidedRows[0];
  const prev = prevRows[0];
  if ((!decided || !decided.decided) && prev && prev.day) {
    const have = new Set(taskIds);
    const left = (await all(`
      SELECT ti.task_id AS id FROM today_items ti JOIN tasks t ON t.id = ti.task_id
       WHERE ti.day = ? AND t.completed = 0 ORDER BY ti.sort_order ASC
    `, [prev.day])).map((r) => r.id).filter((id) => !have.has(id));
    if (left.length) offer = { day: prev.day, taskIds: left };
  }
  return { day, taskIds, offer };
}

app.get('/api/today/:day', wrap(async (req, res) => {
  const { day } = req.params;
  if (!DAY_KEY.test(day)) return res.status(400).json({ error: 'day must be YYYY-MM-DD' });
  res.json(await readToday(day));
}));

/* Replaces the day's list wholesale with the order given: adding, removing
   and reordering are all this one write, so the server never has to merge
   two views of the order. `decided: true` records that the morning question
   was answered. Ids that are not entries are dropped rather than refused. */
app.put('/api/today/:day', wrap(async (req, res) => {
  const { day } = req.params;
  if (!DAY_KEY.test(day)) return res.status(400).json({ error: 'day must be YYYY-MM-DD' });
  const body = req.body ?? {};
  if (!Array.isArray(body.taskIds)) return res.status(400).json({ error: 'taskIds must be an array' });

  const wanted = [];
  const seen = new Set();
  for (const raw of body.taskIds.slice(0, 500)) {
    const id = Number(raw);
    if (!Number.isInteger(id) || seen.has(id)) continue;
    seen.add(id);
    wanted.push(id);
  }
  const existing = wanted.length
    ? new Set((await all(`SELECT id FROM tasks WHERE id IN (${wanted.map(() => '?').join(',')})`, wanted)).map((r) => r.id))
    : new Set();
  const ids = wanted.filter((id) => existing.has(id));

  /* One batch: the old list goes and the new one lands together, or not at
     all, in a single round trip. */
  await batch([
    ['DELETE FROM today_items WHERE day = ?', [day]],
    ...ids.map((id, i) => ['INSERT INTO today_items (day, task_id, sort_order) VALUES (?, ?, ?)', [day, id, i]]),
    ...(body.decided ? [[`
      INSERT INTO today_days (day, decided) VALUES (?, 1)
      ON CONFLICT(day) DO UPDATE SET decided = 1
    `, [day]]] : []),
  ]);
  res.json(await readToday(day));
}));

// ---------- the scratchpad ----------

/* Always answers, even before anything has ever been written — an empty pad is
   a perfectly good pad, and the client should not have to treat "nothing yet"
   as a different case from "nothing in it". */
app.get('/api/notes', wrap(async (req, res) => {
  const row = await get('SELECT body, updated_at FROM notes WHERE id = 1');
  res.json({ body: row ? row.body : '', updatedAt: row ? row.updated_at : null });
}));

app.put('/api/notes', wrap(async (req, res) => {
  const body = req.body && typeof req.body.body === 'string' ? req.body.body : '';
  const now = Date.now();
  await run(`
    INSERT INTO notes (id, body, updated_at) VALUES (1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at
  `, [body, now]);
  res.json({ body, updatedAt: now });
}));

// ---------- the timetable ----------

/* The registrar's .ics, stored as text so the hosted app has the same classes
   as the one on your PC. Absent, everything falls back to the file in
   src/data (the sample, on a fresh clone). Parsed before it is saved: a file
   with no classes in it is refused rather than quietly emptying the Calendar. */
app.get('/api/timetable', wrap(async (req, res) => {
  const row = await get('SELECT ics, name, updated_at FROM timetable WHERE id = 1');
  res.setHeader('Cache-Control', 'no-store');
  res.json(row ? { ics: row.ics, name: row.name, updatedAt: row.updated_at } : { ics: null });
}));

app.put('/api/timetable', wrap(async (req, res) => {
  const ics = typeof req.body?.ics === 'string' ? req.body.ics : '';
  const name = typeof req.body?.name === 'string' ? req.body.name.trim().slice(0, 200) : null;
  if (!ics.trim()) return res.status(400).json({ error: 'that file is empty.' });
  if (ics.length > 1_500_000) return res.status(413).json({ error: 'that file is too large for a timetable.' });

  let parsed;
  try { parsed = parseCalendar(ics); } catch { parsed = null; }
  if (!parsed || (!parsed.series.length && !parsed.meetings.length)) {
    return res.status(400).json({ error: 'that file has no classes in it — export the calendar as .ics from your registrar.' });
  }

  const now = Date.now();
  await run(`
    INSERT INTO timetable (id, ics, name, updated_at) VALUES (1, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET ics = excluded.ics, name = excluded.name, updated_at = excluded.updated_at
  `, [ics, name, now]);
  res.json({ name, updatedAt: now, calendarName: parsed.calendarName || '', courses: parsed.series.length });
}));

app.delete('/api/timetable', wrap(async (req, res) => {
  await run('DELETE FROM timetable WHERE id = 1');
  res.status(204).end();
}));

// ---------- the wire (global headlines) ----------

app.get('/api/headlines', async (req, res) => {
  try {
    res.json(await getHeadlines());
  } catch (err) {
    console.error('Failed to load headlines', err);
    res.status(502).json({ error: 'could not reach the wire' });
  }
});

/* ----------------------------------------------------------- case folders */

const caseFolderToJson = (r) => ({ id: r.id, name: r.name, createdAt: r.created_at });

app.get('/api/case-folders', wrap(async (req, res) => {
  res.json((await all('SELECT * FROM case_folders ORDER BY created_at ASC')).map(caseFolderToJson));
}));

app.post('/api/case-folders', wrap(async (req, res) => {
  const { name } = req.body ?? {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'name is required' });
  const id = randomUUID();
  const now = Date.now();
  await run('INSERT INTO case_folders (id, name, created_at) VALUES (?, ?, ?)',
    [id, String(name).trim(), now]);
  res.status(201).json({ id, name: String(name).trim(), createdAt: now });
}));

app.patch('/api/case-folders/:folderId', wrap(async (req, res) => {
  const row = await get('SELECT * FROM case_folders WHERE id = ?', [req.params.folderId]);
  if (!row) return res.status(404).json({ error: 'folder not found' });
  const { name } = req.body ?? {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'name is required' });
  await run('UPDATE case_folders SET name = ? WHERE id = ?', [String(name).trim(), row.id]);
  res.json(caseFolderToJson({ ...row, name: String(name).trim() }));
}));

/* Deleting a folder never deletes cases — they are unfiled. A folder is a label
   for a group of work; losing the work because you tidied the label would be the
   worst possible surprise. */
app.delete('/api/case-folders/:folderId', wrap(async (req, res) => {
  const row = await get('SELECT id FROM case_folders WHERE id = ?', [req.params.folderId]);
  if (!row) return res.status(404).json({ error: 'folder not found' });
  try {
    await batch([
      ['UPDATE projects SET folder_id = NULL WHERE folder_id = ?', [row.id]],
      ['DELETE FROM case_folders WHERE id = ?', [row.id]],
    ]);
  } catch (err) {
    return res.status(500).json({ error: 'delete failed: ' + err.message });
  }
  res.status(204).end();
}));

// Resolving is a POST because it can spend an LLM call and a geocode on a cache miss.
// The client sends the headline text rather than an id so this doesn't depend on the
// server's headline cache still holding the story the user is looking at.
app.post('/api/headlines/locate', async (req, res) => {
  const { title } = req.body ?? {};
  if (!title || !String(title).trim()) {
    return res.status(400).json({ error: 'title is required' });
  }

  try {
    res.json(await resolveHeadlineLocation(String(title).slice(0, 400)));
  } catch (err) {
    console.error('Failed to locate headline', err);
    res.status(502).json({ error: err.message ?? 'could not resolve a location' });
  }
});

/* ------------------------------------------------------------------ the clerk
 *
 * Every route here is behind a key the reader put in .env themselves. With no
 * key, /api/clerk answers `ready: false` and the UI never offers the feature —
 * so the default install is still an app that talks to nothing.
 *
 * Note the shape of the write path: /file RETURNS proposals and touches
 * nothing, and /apply takes back what the reader approved. The model is never
 * in the same request as a write.
 */

function clerkFail(res, err, what) {
  const status = Number.isFinite(err?.status) ? err.status : 502;
  if (status >= 500) console.error(`Clerk: ${what} failed`, err?.message || err);
  res.status(status).json({ error: err?.message || `the clerk could not ${what}.` });
}

/** What the UI needs to decide whether to offer any of this. Never a key. */
app.get('/api/clerk', (req, res) => {
  res.json(clerk.status());
});

app.post('/api/clerk/file', async (req, res) => {
  if (!clerk.ready()) return clerkFail(res, { status: 503, message: 'the clerk is off duty — no API key is configured.' }, 'file');
  try {
    res.json(await clerk.file(req.body?.text, Date.now()));
  } catch (err) {
    clerkFail(res, err, 'read the pad');
  }
});

app.post('/api/clerk/apply', async (req, res) => {
  /* Not behind the key check: applying is pure database work on rows the
     reader approved, and it must keep working if a key is pulled mid-session. */
  try {
    res.json(await clerk.apply(req.body?.proposals, Date.now()));
  } catch (err) {
    clerkFail(res, err, 'file what you approved');
  }
});

/* The chat's staged changes, applied. Same reasoning as /apply: no key check. */
app.post('/api/clerk/changes', async (req, res) => {
  try {
    res.json(await clerk.applyChanges(req.body?.changes, Date.now()));
  } catch (err) {
    clerkFail(res, err, 'make those changes');
  }
});

app.get('/api/clerk/brief', async (req, res) => {
  const force = req.query.force === '1';
  if (!clerk.ready()) return res.status(503).json({ error: 'the clerk is off duty.' });

  /* A cached brief is served even when `force` was not asked for and the model
     is unreachable — a day-old sentence beats an error box on the dashboard. */
  try {
    res.json(await clerk.brief(Date.now(), { force }));
  } catch (err) {
    const fallback = await clerk.cachedBrief(Date.now()).catch(() => null);
    if (fallback) return res.json({ ...fallback, stale: true });
    clerkFail(res, err, 'write the brief');
  }
});

app.post('/api/clerk/chat', async (req, res) => {
  if (!clerk.ready()) return res.status(503).json({ error: 'the clerk is off duty.' });
  try {
    res.json(await clerk.ask(req.body?.messages, Date.now()));
  } catch (err) {
    clerkFail(res, err, 'answer');
  }
});

/* What this app is costing the machine, for the panel in Settings.
 *
 * Only what the server can actually see: its own process, the archive, and the
 * machine's RAM for scale. The browser tab is a separate process the server
 * knows nothing about, so the page measures that half itself.
 *
 * rss is the number Task Manager shows for node.exe — everything resident,
 * not just the JavaScript heap. On your PC the database is the file plus its
 * journal sidecars, which exist only while SQLite is mid-write but are part of
 * the same archive when they do. Hosted there is no file to measure, so the
 * database reports its own size, and `hosted` tells the panel that the
 * "machine" is a platform's and not worth showing. */
app.get('/api/system/memory', wrap(async (req, res) => {
  const mem = process.memoryUsage();
  let dbBytes = 0;
  if (dbPath) {
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      try { dbBytes += fs.statSync(dbPath + suffix).size; } catch { /* absent is normal */ }
    }
  } else {
    try {
      const [[pages], [size]] = await batch([['PRAGMA page_count'], ['PRAGMA page_size']], 'read');
      dbBytes = Number(pages.page_count) * Number(size.page_size) || 0;
    } catch { /* not every host answers PRAGMA; the panel shows a dash */ }
  }
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    hosted: !!process.env.VERCEL,
    server: {
      rss: mem.rss,
      heapUsed: mem.heapUsed,
      heapTotal: mem.heapTotal,
      uptime: Math.round(process.uptime()),
    },
    database: { bytes: dbBytes },
    machine: { total: os.totalmem(), free: os.freemem() },
  });
}));

/* Anything thrown inside a route lands here: logged with its stack for the
   platform's logs, answered as JSON so the client shows a message rather than
   Express's HTML error page. */
app.use('/api', (err, req, res, next) => {   // eslint-disable-line no-unused-vars
  console.error(`${req.method} ${req.originalUrl} failed`, err);
  if (res.headersSent) return;
  res.status(500).json({ error: 'something went wrong on the server.' });
});

export default app;
