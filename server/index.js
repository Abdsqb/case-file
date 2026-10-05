import express from 'express';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, dbPath } from './db.js';
import { getHeadlines, resolveHeadlineLocation } from './news.js';
import { loadProjects, projectRowToJson, taskRowToJson } from './archive.js';
import * as clerk from './clerk.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(__dirname, '..', 'dist');

const app = express();
app.use(express.json());

/* taskRowToJson / projectRowToJson / loadProjects now live in archive.js, so
   the clerk reads the archive in exactly the shape the browser does. Two
   definitions of "a case, as JSON" is one more than this app can keep true. */

function deleteProjectRecursive(id) {
  const children = db.prepare('SELECT id FROM projects WHERE parent_id = ?').all(id);
  for (const child of children) deleteProjectRecursive(child.id);
  db.prepare('DELETE FROM tasks WHERE project_id = ?').run(id);
  db.prepare('DELETE FROM projects WHERE id = ?').run(id);
}

app.get('/api/projects', (req, res) => {
  res.json(loadProjects());
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
      const f = db.prepare('SELECT id FROM case_folders WHERE id = ?').get(nextFolder);
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
    db.prepare('UPDATE projects SET name = ?, parent_id = ?, sort_order = ?, folder_id = ? WHERE id = ?')
      .run(nextName, nextParent, (max ?? -1) + 1, nextFolder, projectId);
  } else {
    db.prepare('UPDATE projects SET name = ?, folder_id = ? WHERE id = ?')
      .run(nextName, nextFolder, projectId);
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
      const parent = db.prepare('SELECT * FROM tasks WHERE id = ?').get(wanted);
      if (!parent) {
        return res.status(404).json({ error: 'the entry it was dropped on no longer exists' });
      }
      if (parent.parent_task_id) {
        return res.status(400).json({ error: 'subtasks only go one level deep' });
      }
      const kids = db
        .prepare('SELECT COUNT(*) AS n FROM tasks WHERE parent_task_id = ?')
        .get(taskId).n;
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

  db.prepare(`
    UPDATE tasks
       SET title = ?, completed = ?, priority = ?, due_date = ?,
           parent_task_id = ?, project_id = ?
     WHERE id = ?
  `).run(title, completed, priority, dueDate, parentTaskId, projectId, taskId);

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

// ---------- the scratchpad ----------

/* Always answers, even before anything has ever been written — an empty pad is
   a perfectly good pad, and the client should not have to treat "nothing yet"
   as a different case from "nothing in it". */
app.get('/api/notes', (req, res) => {
  const row = db.prepare('SELECT body, updated_at FROM notes WHERE id = 1').get();
  res.json({ body: row ? row.body : '', updatedAt: row ? row.updated_at : null });
});

app.put('/api/notes', (req, res) => {
  const body = req.body && typeof req.body.body === 'string' ? req.body.body : '';
  const now = Date.now();
  db.prepare(`
    INSERT INTO notes (id, body, updated_at) VALUES (1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at
  `).run(body, now);
  res.json({ body, updatedAt: now });
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
/* ------------------------------------------------------------------ *
 * flashcards                                                          *
 * ------------------------------------------------------------------ */

const deckToJson = (r, counts) => ({
  id: r.id,
  name: r.name,
  folderId: r.folder_id ?? null,
  createdAt: r.created_at,
  updatedAt: r.updated_at ?? null,
  sourceName: r.source_name ?? null,
  // The source text itself is deliberately NOT in the list payload — it is the
  // whole imported file, and sending every deck's copy on every list would
  // dwarf the rest of the response. GET /decks/:id/source fetches one.
  hasSource: !!r.source_text,
  cardCount: counts ? counts.total : undefined,
  dueCount: counts ? counts.due : undefined,
});

const folderToJson = (r) => ({ id: r.id, name: r.name, createdAt: r.created_at });

const cardToJson = (r) => ({
  id: r.id,
  deckId: r.deck_id,
  front: r.front,
  back: r.back,
  ef: r.ef,
  interval: r.interval_days,
  reps: r.reps,
  due: r.due,
  lastReviewed: r.last_reviewed,
});

/* Counted in one grouped pass rather than a query per deck: a term of lecture
   decks is dozens of rows, and N+1 here would be paid on every dashboard load. */
function deckCounts(now) {
  const rows = db.prepare(
    'SELECT deck_id, COUNT(*) AS total, SUM(CASE WHEN due <= ? THEN 1 ELSE 0 END) AS due FROM cards GROUP BY deck_id'
  ).all(now);
  const map = new Map();
  for (const r of rows) map.set(r.deck_id, { total: r.total, due: r.due || 0 });
  return map;
}

app.get('/api/decks', (req, res) => {
  const now = Date.now();
  const counts = deckCounts(now);
  const rows = db.prepare('SELECT * FROM decks ORDER BY created_at DESC').all();
  res.json(rows.map((r) => deckToJson(r, counts.get(r.id) || { total: 0, due: 0 })));
});

app.post('/api/decks', (req, res) => {
  const { name, cards, folderId = null, sourceText = null, sourceName = null } = req.body ?? {};
  if (!name || !String(name).trim()) {
    return res.status(400).json({ error: 'name is required' });
  }
  if (!Array.isArray(cards) || cards.length === 0) {
    return res.status(400).json({ error: 'cards must be a non-empty array' });
  }

  const clean = [];
  for (const c of cards) {
    const front = c && c.front !== undefined && c.front !== null ? String(c.front).trim() : '';
    const back = c && c.back !== undefined && c.back !== null ? String(c.back).trim() : '';
    if (front && back) clean.push({ front, back });
  }
  if (!clean.length) {
    return res.status(400).json({ error: 'no card had both a front and a back' });
  }

  const id = randomUUID();
  const now = Date.now();

  /* One transaction: a deck that half-imported would look complete in the list
     and be missing cards in the session, with nothing to point at why. */
  if (folderId) {
    const f = db.prepare('SELECT id FROM folders WHERE id = ?').get(folderId);
    if (!f) return res.status(404).json({ error: 'folder not found' });
  }

  db.exec('BEGIN');
  try {
    db.prepare(
      'INSERT INTO decks (id, name, created_at, updated_at, folder_id, source_text, source_name) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(id, String(name).trim(), now, now, folderId || null, sourceText, sourceName);
    const insert = db.prepare(
      'INSERT INTO cards (id, deck_id, front, back, ef, interval_days, reps, due, last_reviewed) VALUES (?, ?, ?, ?, 2.5, 0, 0, ?, NULL)'
    );
    // Every imported card is due immediately, which is what makes a fresh deck
    // studyable the moment it lands.
    for (const c of clean) insert.run(randomUUID(), id, c.front, c.back, now);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    return res.status(500).json({ error: 'import failed: ' + err.message });
  }

  res.status(201).json({
    id,
    name: String(name).trim(),
    folderId: folderId || null,
    createdAt: now,
    updatedAt: now,
    sourceName,
    hasSource: !!sourceText,
    cardCount: clean.length,
    dueCount: clean.length,
  });
});

app.patch('/api/decks/:deckId', (req, res) => {
  const { deckId } = req.params;
  const existing = db.prepare('SELECT * FROM decks WHERE id = ?').get(deckId);
  if (!existing) return res.status(404).json({ error: 'deck not found' });

  const body = req.body ?? {};
  const renaming = body.name !== undefined;
  const moving = Object.prototype.hasOwnProperty.call(body, 'folderId');
  if (!renaming && !moving) return res.status(400).json({ error: 'name or folderId is required' });
  if (renaming && !String(body.name).trim()) return res.status(400).json({ error: 'name is required' });

  // null is a real destination here: it means "out of every folder".
  let folderId = existing.folder_id ?? null;
  if (moving) {
    folderId = body.folderId === null || body.folderId === '' ? null : body.folderId;
    if (folderId) {
      const f = db.prepare('SELECT id FROM folders WHERE id = ?').get(folderId);
      if (!f) return res.status(404).json({ error: 'folder not found' });
    }
  }
  const name = renaming ? String(body.name).trim() : existing.name;

  db.prepare('UPDATE decks SET name = ?, folder_id = ? WHERE id = ?').run(name, folderId, deckId);
  res.json(deckToJson({ ...existing, name, folder_id: folderId }));
});

/* The file this deck was imported from, fetched on demand. */
app.get('/api/decks/:deckId/source', (req, res) => {
  const row = db.prepare('SELECT * FROM decks WHERE id = ?').get(req.params.deckId);
  if (!row) return res.status(404).json({ error: 'deck not found' });
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM cards WHERE deck_id = ?').get(row.id);
  res.json({
    id: row.id,
    name: row.name,
    sourceName: row.source_name ?? null,
    sourceText: row.source_text ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at ?? null,
    cardCount: n,
  });
});

/**
 * Replace a deck's cards from a corrected file.
 *
 * Matched on the FRONT text, and this is the whole point of the endpoint. The
 * obvious implementation — delete every card, insert the new ones — silently
 * throws away every ease factor, interval and streak in the deck, so fixing one
 * typo would cost a term of review history. Instead:
 *
 *   front unchanged -> keep the card and its schedule, update only its back
 *   front is new    -> insert, due immediately
 *   front is gone   -> delete that card
 *
 * The counts come back so the UI can say what actually happened rather than
 * claiming a flat "replaced".
 */
app.post('/api/decks/:deckId/replace', (req, res) => {
  const { deckId } = req.params;
  const deck = db.prepare('SELECT * FROM decks WHERE id = ?').get(deckId);
  if (!deck) return res.status(404).json({ error: 'deck not found' });

  const { cards, sourceText = null, sourceName = null, name = null } = req.body ?? {};
  if (!Array.isArray(cards) || cards.length === 0) {
    return res.status(400).json({ error: 'cards must be a non-empty array' });
  }

  const incoming = [];
  const seen = new Set();
  for (const c of cards) {
    const front = c && c.front != null ? String(c.front).trim() : '';
    const back = c && c.back != null ? String(c.back).trim() : '';
    if (!front || !back) continue;
    // A file with the same question twice would otherwise keep one and delete
    // the other on the next replace, which looks like data loss.
    const key = front.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    incoming.push({ front, back, key });
  }
  if (!incoming.length) {
    return res.status(400).json({ error: 'no card had both a front and a back' });
  }

  const now = Date.now();
  const existing = db.prepare('SELECT * FROM cards WHERE deck_id = ?').all(deckId);
  const byFront = new Map();
  for (const row of existing) byFront.set(String(row.front).trim().toLowerCase(), row);

  let kept = 0;
  let added = 0;
  let removed = 0;

  db.exec('BEGIN');
  try {
    const updateBack = db.prepare('UPDATE cards SET back = ? WHERE id = ?');
    const insert = db.prepare(
      'INSERT INTO cards (id, deck_id, front, back, ef, interval_days, reps, due, last_reviewed) VALUES (?, ?, ?, ?, 2.5, 0, 0, ?, NULL)'
    );
    const drop = db.prepare('DELETE FROM cards WHERE id = ?');

    for (const c of incoming) {
      const match = byFront.get(c.key);
      if (match) {
        if (String(match.back) !== c.back) updateBack.run(c.back, match.id);
        kept += 1;
        byFront.delete(c.key);
      } else {
        insert.run(randomUUID(), deckId, c.front, c.back, now);
        added += 1;
      }
    }
    for (const orphan of byFront.values()) {
      drop.run(orphan.id);
      removed += 1;
    }

    db.prepare('UPDATE decks SET name = ?, source_text = ?, source_name = ?, updated_at = ? WHERE id = ?')
      .run(name && String(name).trim() ? String(name).trim() : deck.name, sourceText, sourceName, now, deckId);

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    return res.status(500).json({ error: 'replace failed: ' + err.message });
  }

  res.json({ id: deckId, kept, added, removed, total: incoming.length });
});

/* ----------------------------------------------------------- case folders */

const caseFolderToJson = (r) => ({ id: r.id, name: r.name, createdAt: r.created_at });

app.get('/api/case-folders', (req, res) => {
  res.json(db.prepare('SELECT * FROM case_folders ORDER BY created_at ASC').all().map(caseFolderToJson));
});

app.post('/api/case-folders', (req, res) => {
  const { name } = req.body ?? {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'name is required' });
  const id = randomUUID();
  const now = Date.now();
  db.prepare('INSERT INTO case_folders (id, name, created_at) VALUES (?, ?, ?)')
    .run(id, String(name).trim(), now);
  res.status(201).json({ id, name: String(name).trim(), createdAt: now });
});

app.patch('/api/case-folders/:folderId', (req, res) => {
  const row = db.prepare('SELECT * FROM case_folders WHERE id = ?').get(req.params.folderId);
  if (!row) return res.status(404).json({ error: 'folder not found' });
  const { name } = req.body ?? {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'name is required' });
  db.prepare('UPDATE case_folders SET name = ? WHERE id = ?').run(String(name).trim(), row.id);
  res.json(caseFolderToJson({ ...row, name: String(name).trim() }));
});

/* Deleting a folder never deletes cases — they are unfiled. A folder is a label
   for a group of work; losing the work because you tidied the label would be the
   worst possible surprise, and the same rule the flashcard folders follow. */
app.delete('/api/case-folders/:folderId', (req, res) => {
  const row = db.prepare('SELECT id FROM case_folders WHERE id = ?').get(req.params.folderId);
  if (!row) return res.status(404).json({ error: 'folder not found' });
  db.exec('BEGIN');
  try {
    db.prepare('UPDATE projects SET folder_id = NULL WHERE folder_id = ?').run(row.id);
    db.prepare('DELETE FROM case_folders WHERE id = ?').run(row.id);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    return res.status(500).json({ error: 'delete failed: ' + err.message });
  }
  res.status(204).end();
});

/* ---------------------------------------------------------------- folders */

app.get('/api/folders', (req, res) => {
  res.json(db.prepare('SELECT * FROM folders ORDER BY created_at ASC').all().map(folderToJson));
});

app.post('/api/folders', (req, res) => {
  const { name } = req.body ?? {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'name is required' });
  const id = randomUUID();
  const now = Date.now();
  db.prepare('INSERT INTO folders (id, name, created_at) VALUES (?, ?, ?)').run(id, String(name).trim(), now);
  res.status(201).json({ id, name: String(name).trim(), createdAt: now });
});

app.patch('/api/folders/:folderId', (req, res) => {
  const row = db.prepare('SELECT * FROM folders WHERE id = ?').get(req.params.folderId);
  if (!row) return res.status(404).json({ error: 'folder not found' });
  const { name } = req.body ?? {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'name is required' });
  db.prepare('UPDATE folders SET name = ? WHERE id = ?').run(String(name).trim(), row.id);
  res.json(folderToJson({ ...row, name: String(name).trim() }));
});

/* Deleting a folder never deletes decks. A folder is a label for a course, and
   losing a term of cards because you tidied up the labelling would be the
   worst kind of surprise — the decks are unfiled instead. */
app.delete('/api/folders/:folderId', (req, res) => {
  const row = db.prepare('SELECT id FROM folders WHERE id = ?').get(req.params.folderId);
  if (!row) return res.status(404).json({ error: 'folder not found' });
  db.exec('BEGIN');
  try {
    db.prepare('UPDATE decks SET folder_id = NULL WHERE folder_id = ?').run(row.id);
    db.prepare('DELETE FROM folders WHERE id = ?').run(row.id);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    return res.status(500).json({ error: 'delete failed: ' + err.message });
  }
  res.status(204).end();
});

app.delete('/api/decks/:deckId', (req, res) => {
  const { deckId } = req.params;
  const existing = db.prepare('SELECT id FROM decks WHERE id = ?').get(deckId);
  if (!existing) return res.status(404).json({ error: 'deck not found' });
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM cards WHERE deck_id = ?').run(deckId);
    db.prepare('DELETE FROM decks WHERE id = ?').run(deckId);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    return res.status(500).json({ error: 'delete failed: ' + err.message });
  }
  res.status(204).end();
});

/* The review queue. Omit deckId to study everything due across every deck.
   Ordered by due ascending, so the most overdue card is always next. */
app.get('/api/cards/due', (req, res) => {
  const now = Date.now();
  const { deckId, folderId } = req.query;
  let rows;
  if (deckId) {
    rows = db.prepare('SELECT * FROM cards WHERE deck_id = ? AND due <= ? ORDER BY due ASC').all(deckId, now);
  } else if (folderId) {
    // Everything due across one course.
    rows = db.prepare(
      'SELECT c.* FROM cards c JOIN decks d ON d.id = c.deck_id WHERE d.folder_id = ? AND c.due <= ? ORDER BY c.due ASC'
    ).all(folderId, now);
  } else {
    rows = db.prepare('SELECT * FROM cards WHERE due <= ? ORDER BY due ASC').all(now);
  }
  res.json(rows.map(cardToJson));
});

app.patch('/api/cards/:cardId', (req, res) => {
  const { cardId } = req.params;
  const existing = db.prepare('SELECT * FROM cards WHERE id = ?').get(cardId);
  if (!existing) return res.status(404).json({ error: 'card not found' });

  const b = req.body ?? {};
  const num = (v, fallback) => (Number.isFinite(Number(v)) ? Number(v) : fallback);
  const ef = num(b.ef, existing.ef);
  const interval = Math.round(num(b.interval, existing.interval_days));
  const reps = Math.round(num(b.reps, existing.reps));
  const due = Math.round(num(b.due, existing.due));
  const lastReviewed = b.lastReviewed === null ? null : Math.round(num(b.lastReviewed, existing.last_reviewed));

  db.prepare(
    'UPDATE cards SET ef = ?, interval_days = ?, reps = ?, due = ?, last_reviewed = ? WHERE id = ?'
  ).run(ef, interval, reps, due, lastReviewed, cardId);

  res.json(cardToJson({
    ...existing, ef, interval_days: interval, reps, due, last_reviewed: lastReviewed,
  }));
});

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
 * Note the shape of the write path: /file and /deck RETURN proposals and touch
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

app.post('/api/clerk/apply', (req, res) => {
  /* Not behind the key check: applying is pure database work on rows the
     reader approved, and it must keep working if a key is pulled mid-session. */
  try {
    res.json(clerk.apply(req.body?.proposals, Date.now()));
  } catch (err) {
    clerkFail(res, err, 'file what you approved');
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
    const fallback = clerk.cachedBrief(Date.now());
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

app.post('/api/clerk/deck', async (req, res) => {
  if (!clerk.ready()) return res.status(503).json({ error: 'the clerk is off duty.' });
  try {
    res.json(await clerk.deck(req.body?.text, { name: req.body?.name, count: req.body?.count }));
  } catch (err) {
    clerkFail(res, err, 'build a deck');
  }
});

/* What this app is costing the machine, for the panel in Settings.
 *
 * Only what the server can actually see: its own process, the archive on disk,
 * and the machine's RAM for scale. The browser tab is a separate process the
 * server knows nothing about, so the page measures that half itself.
 *
 * rss is the number Task Manager shows for node.exe — everything resident,
 * not just the JavaScript heap. The database is the file plus its journal
 * sidecars, which exist only while SQLite is mid-write but are part of the
 * same archive when they do. */
app.get('/api/system/memory', (req, res) => {
  const mem = process.memoryUsage();
  let dbBytes = 0;
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    try { dbBytes += fs.statSync(dbPath + suffix).size; } catch { /* absent is normal */ }
  }
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    server: {
      rss: mem.rss,
      heapUsed: mem.heapUsed,
      heapTotal: mem.heapTotal,
      uptime: Math.round(process.uptime()),
    },
    database: { bytes: dbBytes },
    machine: { total: os.totalmem(), free: os.freemem() },
  });
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
