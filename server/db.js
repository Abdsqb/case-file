import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/* Where the archive lives.
 *
 * Normally right here, next to this file, and that is the only path anyone
 * running the app needs to know about. CASE_FILE_DB overrides it, and exists
 * for one reason: this database holds real work, and anything that writes —
 * a test of the filing path, a scratch run, a migration being tried out —
 * must be able to point somewhere else WITHOUT editing code. A test suite
 * that has to remember to clean up after itself against the live file is one
 * forgotten DELETE away from costing you a case.
 *
 * A fresh path is created and seeded on first open, so pointing at a new file
 * gives a working app with sample data rather than an error. */
export const dbPath = (process.env.CASE_FILE_DB || '').trim()
  || path.join(__dirname, 'case-file.sqlite');

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
  /* Flashcards. A deck is an imported file; a card carries its own SM-2 state,
     so scheduling never has to be recomputed from a review log. The due column
     is a ms timestamp and is the only thing a review queue reads, which is why
     it is indexed. Named interval_days rather than interval because the unit is
     the part that keeps being got wrong. */
  /* A folder is a course; decks are its lectures. Nullable on the deck, because
     a deck that belongs nowhere in particular is the normal starting state and
     should not require inventing a folder first. */
  /* Folders for CASES, kept separate from the flashcard folders below. They are
     the same idea but not the same thing: reorganising your decks should not
     silently reorganise your cases, and a shared table would make that the
     default. A case folder is purely a grouping in the strip — it is NOT a
     parent case, so the cases inside it stay standalone, with their own screen,
     their own entries and their own diagram. */
  CREATE TABLE IF NOT EXISTS case_folders (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS folders (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS decks (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS cards (
    id TEXT PRIMARY KEY,
    deck_id TEXT NOT NULL REFERENCES decks(id),
    front TEXT NOT NULL,
    back TEXT NOT NULL,
    ef REAL NOT NULL DEFAULT 2.5,
    interval_days INTEGER NOT NULL DEFAULT 0,
    reps INTEGER NOT NULL DEFAULT 0,
    due INTEGER NOT NULL,
    last_reviewed INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_cards_deck ON cards(deck_id);
  CREATE INDEX IF NOT EXISTS idx_cards_due  ON cards(due);

  /* One free-text scratchpad for the whole app. The CHECK is what makes it a
     single row rather than a table of notes — there is one pad, it is always
     row 1, and writing it is an UPSERT rather than a decision about which note
     the caller meant. */
  CREATE TABLE IF NOT EXISTS notes (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    body TEXT NOT NULL DEFAULT '',
    updated_at INTEGER NOT NULL
  );

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

// migrate: a project can sit in a case folder. Nullable, because "not filed"
// is the normal state and must not require inventing a folder first.
const projectFolderColumns = db.prepare('PRAGMA table_info(projects)').all().map(c => c.name);
if (!projectFolderColumns.includes('folder_id')) {
  db.exec('ALTER TABLE projects ADD COLUMN folder_id TEXT REFERENCES case_folders(id)');
}

// migrate: tasks gain an optional parent task, making them subtasks
const taskColumns = db.prepare('PRAGMA table_info(tasks)').all().map(c => c.name);
if (!taskColumns.includes('parent_task_id')) {
  db.exec('ALTER TABLE tasks ADD COLUMN parent_task_id INTEGER REFERENCES tasks(id)');
}

/* migrate: decks gain a folder, and keep the file they were imported from.
   Holding the source text is what makes "show me what this deck came from" and
   "replace it with a corrected file" possible at all — without it an import is
   a one-way door. */
const deckColumns = db.prepare('PRAGMA table_info(decks)').all().map(c => c.name);
if (!deckColumns.includes('folder_id')) {
  db.exec('ALTER TABLE decks ADD COLUMN folder_id TEXT REFERENCES folders(id)');
}
if (!deckColumns.includes('source_text')) {
  db.exec('ALTER TABLE decks ADD COLUMN source_text TEXT');
}
if (!deckColumns.includes('source_name')) {
  db.exec('ALTER TABLE decks ADD COLUMN source_name TEXT');
}
if (!deckColumns.includes('updated_at')) {
  db.exec('ALTER TABLE decks ADD COLUMN updated_at INTEGER');
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
