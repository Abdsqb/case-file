import express from 'express';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from './db.js';
import { getHeadlines, resolveHeadlineLocation } from './news.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(__dirname, '..', 'dist');

const app = express();
app.use(express.json());

function taskRowToJson(row, subtasks = []) {
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

function projectRowToJson(p, tasks) {
  return {
    id: p.id,
    name: p.name,
    openedAt: p.opened_at,
    parentId: p.parent_id,
    sortOrder: p.sort_order,
    tasks,
  };
}

function deleteProjectRecursive(id) {
  const children = db.prepare('SELECT id FROM projects WHERE parent_id = ?').all(id);
  for (const child of children) deleteProjectRecursive(child.id);
  db.prepare('DELETE FROM tasks WHERE project_id = ?').run(id);
  db.prepare('DELETE FROM projects WHERE id = ?').run(id);
}

app.get('/api/projects', (req, res) => {
  const projects = db.prepare('SELECT * FROM projects ORDER BY sort_order ASC').all();
  const taskStmt = db.prepare('SELECT * FROM tasks WHERE project_id = ? AND parent_task_id IS NULL ORDER BY created_at DESC');
  const subtaskStmt = db.prepare('SELECT * FROM tasks WHERE parent_task_id = ? ORDER BY created_at ASC');

  const result = projects.map(p => projectRowToJson(
    p,
    taskStmt.all(p.id).map(t => taskRowToJson(t, subtaskStmt.all(t.id).map(s => taskRowToJson(s)))),
  ));

  res.json(result);
});

app.post('/api/projects', (req, res) => {
  const { name, parentId = null } = req.body ?? {};
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'name is required' });
  }

  if (parentId) {
    const parent = db.prepare('SELECT id FROM projects WHERE id = ?').get(parentId);
    if (!parent) {
      return res.status(404).json({ error: 'parent project not found' });
    }
  }

  const id = randomUUID();
  const openedAt = Date.now();
  const { max } = db.prepare('SELECT MAX(sort_order) AS max FROM projects WHERE parent_id IS ?').get(parentId);
  const sortOrder = (max ?? -1) + 1;

  db.prepare('INSERT INTO projects (id, name, opened_at, parent_id, sort_order) VALUES (?, ?, ?, ?, ?)')
    .run(id, name.trim(), openedAt, parentId, sortOrder);

  res.status(201).json({ id, name: name.trim(), openedAt, parentId, sortOrder, tasks: [] });
});

app.patch('/api/projects/:projectId', (req, res) => {
  const { projectId } = req.params;
  const existing = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
  if (!existing) {
    return res.status(404).json({ error: 'project not found' });
  }

  const body = req.body ?? {};
  const { name } = body;
  const renaming = name !== undefined;
  const reparenting = Object.prototype.hasOwnProperty.call(body, 'parentId');

  if (renaming && (!name || !name.trim())) {
    return res.status(400).json({ error: 'name is required' });
  }
  if (!renaming && !reparenting) {
    return res.status(400).json({ error: 'name or parentId is required' });
  }

  /* Re-parenting. A sub-case could be created but never un-nested, so the only
     way out was delete-and-recreate — which throws away every entry inside it.
     Moving the row keeps them. */
  let nextParent = existing.parent_id;
  if (reparenting) {
    nextParent = body.parentId === null || body.parentId === '' ? null : body.parentId;

    if (nextParent !== null) {
      const parent = db.prepare('SELECT id FROM projects WHERE id = ?').get(nextParent);
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
        const row = db.prepare('SELECT parent_id FROM projects WHERE id = ?').get(cursor);
        cursor = row ? row.parent_id : null;
      }
    }
  }

  const nextName = renaming ? name.trim() : existing.name;

  if (reparenting && nextParent !== existing.parent_id) {
    // Land at the end of its new sibling list, the same place a new case lands.
    const { max } = db
      .prepare('SELECT MAX(sort_order) AS max FROM projects WHERE parent_id IS ?')
      .get(nextParent);
    db.prepare('UPDATE projects SET name = ?, parent_id = ?, sort_order = ? WHERE id = ?')
      .run(nextName, nextParent, (max ?? -1) + 1, projectId);
  } else {
    db.prepare('UPDATE projects SET name = ? WHERE id = ?').run(nextName, projectId);
  }

  const after = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
  res.json(projectRowToJson(after, undefined));
});

app.post('/api/projects/:projectId/move', (req, res) => {
  const { projectId } = req.params;
  const { direction } = req.body ?? {};
  if (direction !== 'up' && direction !== 'down') {
    return res.status(400).json({ error: 'direction must be "up" or "down"' });
  }

  const current = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
  if (!current) {
    return res.status(404).json({ error: 'project not found' });
  }

  const siblings = db.prepare('SELECT * FROM projects WHERE parent_id IS ? ORDER BY sort_order ASC').all(current.parent_id);
  const idx = siblings.findIndex(s => s.id === projectId);
  const swapIdx = direction === 'up' ? idx - 1 : idx + 1;

  if (swapIdx < 0 || swapIdx >= siblings.length) {
    return res.json({ moved: false });
  }

  const other = siblings[swapIdx];
  const setOrder = db.prepare('UPDATE projects SET sort_order = ? WHERE id = ?');
  setOrder.run(other.sort_order, current.id);
  setOrder.run(current.sort_order, other.id);

  res.json({ moved: true });
});

app.delete('/api/projects/:projectId', (req, res) => {
  const { projectId } = req.params;
  const existing = db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId);
  if (!existing) {
    return res.status(404).json({ error: 'project not found' });
  }

  deleteProjectRecursive(projectId);
  res.status(204).end();
});

app.post('/api/projects/:projectId/tasks', (req, res) => {
  const { projectId } = req.params;
  const { title, priority = 'normal', dueDate = null } = req.body ?? {};

  if (!title || !title.trim()) {
    return res.status(400).json({ error: 'title is required' });
  }

  const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId);
  if (!project) {
    return res.status(404).json({ error: 'project not found' });
  }

  const result = db.prepare(`
    INSERT INTO tasks (project_id, title, priority, created_at, due_date, completed, blocked_by)
    VALUES (?, ?, ?, ?, ?, 0, NULL)
  `).run(projectId, title.trim(), priority, Date.now(), dueDate);

  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json(taskRowToJson(row));
});

app.post('/api/tasks/:taskId/subtasks', (req, res) => {
  const parentTaskId = Number(req.params.taskId);
  const { title } = req.body ?? {};

  if (!title || !title.trim()) {
    return res.status(400).json({ error: 'title is required' });
  }

  const parent = db.prepare('SELECT * FROM tasks WHERE id = ?').get(parentTaskId);
  if (!parent) {
    return res.status(404).json({ error: 'task not found' });
  }
  if (parent.parent_task_id) {
    return res.status(400).json({ error: 'a subtask cannot have subtasks of its own' });
  }

  const result = db.prepare(`
    INSERT INTO tasks (project_id, title, priority, created_at, due_date, completed, blocked_by, parent_task_id)
    VALUES (?, ?, 'normal', ?, NULL, 0, NULL, ?)
  `).run(parent.project_id, title.trim(), Date.now(), parentTaskId);

  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json(taskRowToJson(row));
});

app.patch('/api/tasks/:taskId', (req, res) => {
  const taskId = Number(req.params.taskId);
  const existing = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
  if (!existing) {
    return res.status(404).json({ error: 'task not found' });
  }

  const body = req.body ?? {};
  const title = body.title !== undefined ? String(body.title) : existing.title;
  const completed = body.completed !== undefined ? (body.completed ? 1 : 0) : existing.completed;
  const priority = body.priority !== undefined ? body.priority : existing.priority;
  const dueDate = body.dueDate !== undefined ? body.dueDate : existing.due_date;

  db.prepare('UPDATE tasks SET title = ?, completed = ?, priority = ?, due_date = ? WHERE id = ?')
    .run(title, completed, priority, dueDate, taskId);

  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
  res.json(taskRowToJson(row));
});

app.delete('/api/tasks/:taskId', (req, res) => {
  const taskId = Number(req.params.taskId);
  const existing = db.prepare('SELECT id FROM tasks WHERE id = ?').get(taskId);
  if (!existing) {
    return res.status(404).json({ error: 'task not found' });
  }

  db.prepare('DELETE FROM tasks WHERE parent_task_id = ?').run(taskId);
  db.prepare('DELETE FROM tasks WHERE id = ?').run(taskId);
  res.status(204).end();
});

// ---------- the wire (global headlines) ----------

app.get('/api/headlines', async (req, res) => {
  try {
    res.json(await getHeadlines());
  } catch (err) {
    console.error('Failed to load headlines', err);
    res.status(502).json({ error: 'could not reach the wire' });
  }
});

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

// serve the built frontend too, so the installed app runs from a single origin without
// needing the Vite dev server. Checked per request, so building while the server is
// already running just works.
const indexFile = path.join(distDir, 'index.html');

/* Caching, and why it is spelled out rather than left to the default.
 *
 * Served with no cache headers at all, the browser is free to reuse index.html
 * indefinitely — and because every route in this app is a #hash, navigating
 * never re-fetches it either. The result is a tab that keeps loading the
 * PREVIOUS build's bundle after a rebuild: you act, the app appears to ignore
 * you, and nothing in the UI says why. It cost real debugging time, and it is
 * the likeliest explanation for any "I did that and nothing happened".
 *
 * So: asset filenames carry a content hash and change whenever their contents
 * do, which makes them safe to cache forever. index.html is the map to those
 * names and must always be re-validated. */
const IMMUTABLE = 'public, max-age=31536000, immutable';
const ALWAYS_FRESH = 'no-cache';

app.use(express.static(distDir, {
  setHeaders(res, filePath) {
    if (path.basename(filePath) === 'index.html') res.setHeader('Cache-Control', ALWAYS_FRESH);
    else if (filePath.includes(`${path.sep}assets${path.sep}`)) res.setHeader('Cache-Control', IMMUTABLE);
  },
}));

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/') || !fs.existsSync(indexFile)) return next();
  // The SPA fallback hands out index.html too, so it needs the same rule.
  res.setHeader('Cache-Control', ALWAYS_FRESH);
  res.sendFile(indexFile);
});

const PORT = process.env.PORT || 4001;
app.listen(PORT, () => {
  console.log(`Case File API listening on http://localhost:${PORT}`);
  console.log(fs.existsSync(indexFile)
    ? `Case File app ready at  http://localhost:${PORT}`
    : 'No build yet — run "npm run build", then reload http://localhost:' + PORT);
});
