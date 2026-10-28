import { createClient } from '@libsql/client';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/* Where the archive lives.
 *
 * Two places, one code path. On your PC it is a file right here, next to this
 * file, and that is the only path anyone running the app locally needs to know
 * about. Hosted, it is a Turso database: DATABASE_URL (libsql://…) and
 * DATABASE_AUTH_TOKEN say which. The client speaks to both the same way, so
 * nothing below this block knows or cares which one it has.
 *
 * CASE_FILE_DB still overrides the local file, and exists for one reason: this
 * database holds real work, and anything that writes — a test of the filing
 * path, a scratch run, a migration being tried out — must be able to point
 * somewhere else WITHOUT editing code. A test suite that has to remember to
 * clean up after itself against the live file is one forgotten DELETE away
 * from costing you a case.
 *
 * A fresh local path is created and seeded on first open, so pointing at a new
 * file gives a working app with sample data rather than an error. A remote
 * database is never seeded: sample cases landing in the real archive before
 * the real data does is the one way an empty Turso database could hurt. */
const localFile = (process.env.CASE_FILE_DB || '').trim()
  || path.join(__dirname, 'case-file.sqlite');

export const dbUrl = (process.env.DATABASE_URL || '').trim() || pathToFileURL(localFile).href;
export const isLocal = dbUrl.startsWith('file:');
/** The file on disk when there is one (the memory panel measures it), else null. */
export const dbPath = isLocal ? fileOf(dbUrl) : null;

/* file:///C:/… is a URL; file:server/x.sqlite (which the client also takes)
   is a path relative to where the process was started. */
function fileOf(u) {
  try { return fileURLToPath(u); } catch { return path.resolve(u.replace(/^file:(\/\/)?/, '')); }
}

export const client = createClient({
  url: dbUrl,
  authToken: (process.env.DATABASE_AUTH_TOKEN || '').trim() || undefined,
});

/* ------------------------------------------------------------------ helpers
 *
 * The same three verbs the code used with node:sqlite — get one row, get all
 * rows, run a write — now awaited. Rows come back as plain objects keyed by
 * column, so `row.title` and JSON.stringify(row) behave exactly as before.
 * `run` reports `changes` and `lastInsertRowid` under the old names too. */

const plain = (rs) => rs.rows.map((row) => {
  const o = {};
  rs.columns.forEach((c, i) => { o[c] = row[i]; });
  return o;
});

function verbs(exec) {
  return {
    all: async (sql, args = []) => plain(await exec({ sql, args })),
    get: async (sql, args = []) => plain(await exec({ sql, args }))[0],
    run: async (sql, args = []) => {
      const rs = await exec({ sql, args });
      return {
        changes: rs.rowsAffected,
        lastInsertRowid: rs.lastInsertRowid === undefined ? undefined : Number(rs.lastInsertRowid),
      };
    },
  };
}

const raw = verbs((stmt) => client.execute(stmt));

/* Every public verb waits for the schema to be in place first. On a warm
   instance that promise has long since settled and costs nothing. */
const gated = (fn) => async (...args) => { await ready; return fn(...args); };

export const all = gated(raw.all);
export const get = gated(raw.get);
export const run = gated(raw.run);

/**
 * Several statements that must land together and do not depend on each
 * other's results — one round trip, all or nothing. Each item is [sql, args].
 * → one array of plain rows per statement.
 */
export const batch = gated(async (statements, mode = 'write') => {
  const results = await client.batch(statements.map(([sql, args = []]) => ({ sql, args })), mode);
  return results.map(plain);
});

/**
 * A transaction for writes where a later statement needs an earlier one's
 * result (a subtask needs the id of the entry it was just filed under). `fn`
 * gets the same get/all/run verbs, bound to the transaction; anything it
 * throws rolls the whole thing back.
 */
export const tx = gated(async (fn) => {
  const t = await client.transaction('write');
  try {
    const out = await fn(verbs((stmt) => t.execute(stmt)));
    await t.commit();
    return out;
  } catch (err) {
    try { await t.rollback(); } catch { /* already gone */ }
    throw err;
  } finally {
    t.close();
  }
});

/* ------------------------------------------------------------------- schema
 *
 * The schema is a list of migrations, applied in order, and the database
 * records how far along it is in a one-row `meta` table. Starting up costs one
 * query when it is current — which matters hosted, where every cold start
 * would otherwise pay a dozen round trips to re-check tables that exist.
 *
 * Migration 1 is everything up to and including the to-do list, written so it
 * is safe to run over a database that already has some or all of it: the
 * archive that predates this file passes through it and comes out unchanged. */

const MIGRATIONS = [
  async (db) => {
    await client.executeMultiple(`
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

      -- Folders for cases. A case folder is purely a grouping in the bar — it is
      -- NOT a parent case, so the cases inside it stay standalone, with their own
      -- screen, their own entries and their own diagram.
      CREATE TABLE IF NOT EXISTS case_folders (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      -- One free-text scratchpad for the whole app. The CHECK is what makes it a
      -- single row rather than a table of notes — there is one pad, it is always
      -- row 1, and writing it is an UPSERT rather than a decision about which note
      -- the caller meant.
      CREATE TABLE IF NOT EXISTS notes (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        body TEXT NOT NULL DEFAULT '',
        updated_at INTEGER NOT NULL
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

      -- The clerk's last brief, and the fingerprint of the facts it was written from.
      CREATE TABLE IF NOT EXISTS clerk_brief (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        cache_key TEXT NOT NULL,
        body TEXT NOT NULL,
        model TEXT,
        made_at INTEGER NOT NULL
      );

      -- Today's to-do: which entries (or subtasks) you picked for a day, in the
      -- order you put them. Keyed by the day as the browser reads it, YYYY-MM-DD in
      -- local time, so "today" is the reader's day and not the server's. Nothing is
      -- copied out of tasks: a row is only a pointer, so ticking it off in the
      -- window and closing it in its case are the same write.
      CREATE TABLE IF NOT EXISTS today_items (
        day TEXT NOT NULL,
        task_id INTEGER NOT NULL REFERENCES tasks(id),
        sort_order INTEGER NOT NULL,
        PRIMARY KEY (day, task_id)
      );

      -- Remembers that the morning question (bring yesterday's unfinished items
      -- over, or start fresh) has been answered for a day, so it is asked once.
      CREATE TABLE IF NOT EXISTS today_days (
        day TEXT PRIMARY KEY,
        decided INTEGER NOT NULL DEFAULT 0
      );
    `);

    // Columns added after the first release, for archives that predate them.
    const columns = async (table) => (await db.all(`PRAGMA table_info(${table})`)).map((c) => c.name);

    const projectColumns = await columns('projects');
    if (!projectColumns.includes('parent_id')) {
      await db.run('ALTER TABLE projects ADD COLUMN parent_id TEXT REFERENCES projects(id)');
    }
    if (!projectColumns.includes('sort_order')) {
      await db.run('ALTER TABLE projects ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0');
      const existing = await db.all('SELECT id FROM projects ORDER BY opened_at DESC');
      for (const [i, row] of existing.entries()) {
        await db.run('UPDATE projects SET sort_order = ? WHERE id = ?', [i, row.id]);
      }
    }
    // A project can sit in a case folder. Nullable, because "not filed" is the
    // normal state and must not require inventing a folder first.
    if (!projectColumns.includes('folder_id')) {
      await db.run('ALTER TABLE projects ADD COLUMN folder_id TEXT REFERENCES case_folders(id)');
    }
    // Tasks gain an optional parent task, making them subtasks.
    if (!(await columns('tasks')).includes('parent_task_id')) {
      await db.run('ALTER TABLE tasks ADD COLUMN parent_task_id INTEGER REFERENCES tasks(id)');
    }

    /* The lookups every edit makes: a case's entries, an entry's subtasks (to
       count them, move them or delete them with it). Without these each is a
       scan of the whole table. */
    await client.executeMultiple(`
      CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_parent  ON tasks(parent_task_id);
    `);
  },

  /* 2: failed sign-ins, by address, for the lockout in auth.js. */
  async () => {
    await client.executeMultiple(`
      CREATE TABLE IF NOT EXISTS login_attempts (
        ip TEXT NOT NULL,
        at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_login_attempts ON login_attempts(ip, at);
    `);
  },

  /* 3: the class timetable, as the registrar's own .ics text. One row, like
     the notes pad. Empty, the app falls back to the file in src/data. */
  async () => {
    await client.execute(`
      CREATE TABLE IF NOT EXISTS timetable (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        ics TEXT NOT NULL,
        name TEXT,
        updated_at INTEGER NOT NULL
      )
    `);
  },
];

async function schemaVersion() {
  try {
    const row = await raw.get("SELECT value FROM meta WHERE key = 'schema'");
    return row ? Number(row.value) || 0 : 0;
  } catch {
    return 0;   // no meta table yet: a database from before versioning, or a new one
  }
}

async function migrate() {
  const from = await schemaVersion();
  if (from < MIGRATIONS.length) {
    await raw.run('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    for (let v = from; v < MIGRATIONS.length; v += 1) {
      await MIGRATIONS[v](raw);
      await raw.run(
        "INSERT INTO meta (key, value) VALUES ('schema', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [String(v + 1)],
      );
    }
  }

  /* CASE_FILE_NO_SEED: set by the import script, which must never find
     sample cases in the database it is about to fill. */
  if (isLocal && !process.env.CASE_FILE_NO_SEED) {
    const { n } = await raw.get('SELECT COUNT(*) AS n FROM projects');
    if (n === 0) await seed();
  }
}

/** Resolves once the schema is current. Every verb above waits on it. */
export const ready = migrate();

/* Logged here as well as surfaced through every query that waits on it, so a
   bad DATABASE_URL reads as one clear line at start-up and not as a 500 on
   the first click. */
ready.catch((err) => console.error('Case File: could not open the archive —', err.message));

async function seed() {
  const now = Date.now();
  const DAY = 86400000;

  const insertProject = (...args) => raw.run(
    'INSERT INTO projects (id, name, opened_at, sort_order) VALUES (?, ?, ?, ?)', args,
  );
  const insertTask = (...args) => raw.run(`
    INSERT INTO tasks (project_id, title, priority, created_at, due_date, completed, blocked_by)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `, args);

  await insertProject('p1', 'SpotFill', now - 60 * DAY, 0);
  await insertProject('p2', 'ASH Motors Pitch', now - 10 * DAY, 1);
  await insertProject('p3', 'Protogramma', now - 90 * DAY, 2);
  await insertProject('p4', 'School', now - 30 * DAY, 3);

  await insertTask('p1', 'Fix SMS webhook retry logic', 'high', now - 6 * DAY, now + 1 * DAY, 0, null);
  await insertTask('p1', 'Rotate hardcoded Square token', 'high', now - 8 * DAY, now - 1 * DAY, 0, null);
  await insertTask('p1', 'Merge HTML email templates', 'normal', now - 2 * DAY, now + 5 * DAY, 0, null);
  await insertTask('p1', 'DNS cutover for luxedigitalcollective.co', 'normal', now - 20 * DAY, null, 1, null);

  const leadTask = await insertTask('p2', 'Finalize Airtable lead-capture schema', 'high', now - 3 * DAY, now + 2 * DAY, 0, null);
  const leadCaseNumber = `CASE-${String(leadTask.lastInsertRowid).padStart(4, '0')}`;
  await insertTask('p2', 'Record demo walkthrough for owner', 'normal', now - 1 * DAY, now + 4 * DAY, 0, leadCaseNumber);

  await insertTask('p3', 'Expand KB sample to 300 articles', 'normal', now - 12 * DAY, now + 10 * DAY, 0, null);
  await insertTask('p3', 'QA pass with Eva on KB accuracy', 'low', now - 4 * DAY, null, 0, null);

  await insertTask('p4', 'Database course syllabus review', 'low', now - 1 * DAY, now + 14 * DAY, 0, null);
}
