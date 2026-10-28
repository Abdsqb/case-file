/**
 * db-import.mjs — copies the archive on this PC into the Turso database, once.
 *
 *   npm run db:import              copy, then compare every table's row count
 *   npm run db:import -- --dry-run say what would be copied, write nothing
 *   npm run db:import -- --force   copy even though Turso already has cases
 *
 * Reads the target from TURSO_DATABASE_URL and TURSO_AUTH_TOKEN (in .env).
 * Those are deliberately NOT the names the app reads (DATABASE_URL), so
 * putting them in .env never quietly points the local app at the live data.
 *
 * The local file is only read. Ids are kept exactly — today's list and every
 * subtask point at them — and rows go in an order that satisfies the
 * database's foreign keys (parents before children). Everything is written in
 * one batch: it all lands, or nothing does.
 */
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@libsql/client';

const args = new Set(process.argv.slice(2));
const DRY = args.has('--dry-run');
const FORCE = args.has('--force');

const url = (process.env.TURSO_DATABASE_URL || '').trim();
const authToken = (process.env.TURSO_AUTH_TOKEN || '').trim();
if (!url || !authToken) {
  console.error('Set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN in .env first.');
  process.exit(1);
}

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = (process.env.CASE_FILE_DB || '').trim() || path.join(root, 'server', 'case-file.sqlite');
const source = new DatabaseSync(sourcePath, { readOnly: true });

/* The target's schema comes from the app's own migrations: db.js is imported
   with DATABASE_URL pointed at Turso, which creates every table there exactly
   as the app expects them, and never seeds a remote database. */
process.env.DATABASE_URL = url;
process.env.DATABASE_AUTH_TOKEN = authToken;
process.env.CASE_FILE_NO_SEED = '1';
const db = await import('../server/db.js');
await db.ready;
const target = createClient({ url, authToken });

/* In foreign-key order. login_attempts and meta are the server's own
   bookkeeping and are not copied. */
const TABLES = ['case_folders', 'projects', 'tasks', 'notes', 'headline_places', 'clerk_brief', 'today_days', 'today_items', 'timetable'];

const sourceTables = new Set(source.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));
const columnsOf = async (table) => (await target.execute(`PRAGMA table_info(${table})`)).rows.map((r) => r.name);

/* Cases can be sub-cases of cases, so a parent has to land before its
   children; entries before their subtasks. */
function ordered(table, rows) {
  if (table === 'tasks') {
    return [...rows].sort((a, b) => (a.parent_task_id == null ? 0 : 1) - (b.parent_task_id == null ? 0 : 1) || a.id - b.id);
  }
  if (table === 'projects') {
    const byId = new Map(rows.map((r) => [r.id, r]));
    const out = [];
    const done = new Set();
    const visit = (r, trail = new Set()) => {
      if (done.has(r.id) || trail.has(r.id)) return;
      trail.add(r.id);
      const parent = r.parent_id && byId.get(r.parent_id);
      if (parent) visit(parent, trail);
      done.add(r.id);
      out.push(r);
    };
    rows.forEach((r) => visit(r));
    return out;
  }
  return rows;
}

const existing = Number((await target.execute('SELECT COUNT(*) AS n FROM projects')).rows[0].n);
if (existing > 0 && !FORCE) {
  console.error(`Turso already has ${existing} cases. Refusing to copy over them (use --force only if you mean to).`);
  process.exit(1);
}

const statements = [];
const plan = [];
for (const table of TABLES) {
  if (!sourceTables.has(table)) { plan.push([table, 0, 'not in the local archive']); continue; }
  const targetCols = await columnsOf(table);
  const rows = ordered(table, source.prepare(`SELECT * FROM ${table}`).all());
  const cols = rows.length ? Object.keys(rows[0]).filter((c) => targetCols.includes(c)) : [];
  if (FORCE) statements.push({ sql: `DELETE FROM ${table}`, args: [] });
  for (const row of rows) {
    statements.push({
      sql: `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
      args: cols.map((c) => (row[c] === undefined ? null : row[c])),
    });
  }
  plan.push([table, rows.length, '']);
}
/* --force deletes children before parents, so the deletes run in reverse. */
if (FORCE) {
  const deletes = statements.filter((s) => s.sql.startsWith('DELETE')).reverse();
  const inserts = statements.filter((s) => !s.sql.startsWith('DELETE'));
  statements.length = 0;
  statements.push(...deletes, ...inserts);
}

console.log(`From ${sourcePath}`);
console.log(`To   ${url}\n`);
for (const [table, n, note] of plan) console.log(`  ${table.padEnd(16)} ${String(n).padStart(5)}  ${note}`);

if (DRY) {
  console.log('\nDry run: nothing written.');
  process.exit(0);
}

await target.batch(statements, 'write');

console.log('\nCopied. Checking every table:\n');
let bad = 0;
for (const [table, n] of plan) {
  const got = Number((await target.execute(`SELECT COUNT(*) AS n FROM ${table}`)).rows[0].n);
  const ok = got === n;
  if (!ok) bad += 1;
  console.log(`  ${table.padEnd(16)} local ${String(n).padStart(5)}   turso ${String(got).padStart(5)}   ${ok ? 'ok' : 'MISMATCH'}`);
}
console.log(bad ? `\n${bad} table(s) do not match.` : '\nEverything matches.');
process.exit(bad ? 1 : 0);
