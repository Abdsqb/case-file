import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.join(__dirname, 'case-file.sqlite');

export const db = new DatabaseSync(dbPath);

db.exec(`
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    opened_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL REFERENCES projects(id),
    title TEXT NOT NULL,
    priority TEXT NOT NULL DEFAULT 'normal',
    created_at INTEGER NOT NULL,
    due_date INTEGER,
    completed INTEGER NOT NULL DEFAULT 0,
    blocked_by TEXT
  );

  -- Resolved locations for wire headlines. Keyed by the headline text itself, so
  -- clicking the same story twice never re-spends an LLM call or a Nominatim hit.
  -- Misses are cached too (place NULL) — vague headlines are common and retrying
  -- them on every click would burn the free-tier rate limit for nothing.
  CREATE TABLE IF NOT EXISTS headline_places (
    headline_key TEXT PRIMARY KEY,
    place TEXT,
    lat REAL,
    lng REAL,
    zoom REAL,
    label TEXT,
    resolved_at INTEGER NOT NULL
  );
`);

// migrate: add parent_id / sort_order to projects if this db predates them
const projectColumns = db.prepare("PRAGMA table_info(projects)").all().map(c => c.name);
if (!projectColumns.includes('parent_id')) {
  db.exec('ALTER TABLE projects ADD COLUMN parent_id TEXT REFERENCES projects(id)');
}
if (!projectColumns.includes('sort_order')) {
  db.exec('ALTER TABLE projects ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0');
  const existing = db.prepare('SELECT id FROM projects ORDER BY opened_at DESC').all();
  const setOrder = db.prepare('UPDATE projects SET sort_order = ? WHERE id = ?');
  existing.forEach((row, i) => setOrder.run(i, row.id));
}

// migrate: tasks gain an optional parent task, making them subtasks
const taskColumns = db.prepare('PRAGMA table_info(tasks)').all().map(c => c.name);
if (!taskColumns.includes('parent_task_id')) {
  db.exec('ALTER TABLE tasks ADD COLUMN parent_task_id INTEGER REFERENCES tasks(id)');
}

const { n: projectCount } = db.prepare('SELECT COUNT(*) AS n FROM projects').get();
if (projectCount === 0) seed();

function seed() {
  const now = Date.now();
  const DAY = 86400000;

  const insertProject = db.prepare('INSERT INTO projects (id, name, opened_at, sort_order) VALUES (?, ?, ?, ?)');
  const insertTask = db.prepare(`
    INSERT INTO tasks (project_id, title, priority, created_at, due_date, completed, blocked_by)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  insertProject.run('p1', 'SpotFill', now - 60 * DAY, 0);
  insertProject.run('p2', 'ASH Motors Pitch', now - 10 * DAY, 1);
  insertProject.run('p3', 'Protogramma', now - 90 * DAY, 2);
  insertProject.run('p4', 'School', now - 30 * DAY, 3);

  insertTask.run('p1', 'Fix SMS webhook retry logic', 'high', now - 6 * DAY, now + 1 * DAY, 0, null);
  insertTask.run('p1', 'Rotate hardcoded Square token', 'high', now - 8 * DAY, now - 1 * DAY, 0, null);
  insertTask.run('p1', 'Merge HTML email templates', 'normal', now - 2 * DAY, now + 5 * DAY, 0, null);
  insertTask.run('p1', 'DNS cutover for luxedigitalcollective.co', 'normal', now - 20 * DAY, null, 1, null);

  const leadTask = insertTask.run('p2', 'Finalize Airtable lead-capture schema', 'high', now - 3 * DAY, now + 2 * DAY, 0, null);
  const leadCaseNumber = `CASE-${String(leadTask.lastInsertRowid).padStart(4, '0')}`;
  insertTask.run('p2', 'Record demo walkthrough for owner', 'normal', now - 1 * DAY, now + 4 * DAY, 0, leadCaseNumber);

  insertTask.run('p3', 'Expand KB sample to 300 articles', 'normal', now - 12 * DAY, now + 10 * DAY, 0, null);
  insertTask.run('p3', 'QA pass with Eva on KB accuracy', 'low', now - 4 * DAY, null, 0, null);

  insertTask.run('p4', 'Database course syllabus review', 'low', now - 1 * DAY, now + 14 * DAY, 0, null);
}
