/**
 * db-backup.mjs — copies the live (Turso) archive down to this PC.
 *
 *   npm run db:backup   a dated copy in server/backups/, nothing else touched
 *   npm run db:pull     the same, and then it becomes the local archive too,
 *                       so `npm run dev` works against today's real data
 *                       (the local archive it replaces is backed up first)
 *
 * Reads TURSO_DATABASE_URL and TURSO_AUTH_TOKEN from .env. There is no
 * command that goes the other way: the live archive is only ever written by
 * the app, and once by db:import.
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@libsql/client';

const intoLocal = process.argv.includes('--into-local');

const url = (process.env.TURSO_DATABASE_URL || '').trim();
const authToken = (process.env.TURSO_AUTH_TOKEN || '').trim();
if (!url || !authToken) {
  console.error('Set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN in .env first.');
  process.exit(1);
}

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const backups = path.join(root, 'server', 'backups');
fs.mkdirSync(backups, { recursive: true });

const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, (c) => (c === 'T' ? '-' : c === ':' ? '' : '-'));
const out = path.join(backups, `case-file-turso-${stamp}.sqlite`);

const remote = createClient({ url, authToken });
const local = new DatabaseSync(out);

/* The schema exactly as Turso has it — tables first, then their indexes —
   then every row. Foreign keys are off while copying: rows arrive table by
   table, not in dependency order, and they were valid where they came from. */
local.exec('PRAGMA foreign_keys = OFF');
const objects = (await remote.execute(
  "SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END",
)).rows;

const counts = [];
for (const o of objects) {
  local.exec(o.sql);
  if (o.type !== 'table') continue;
  const rs = await remote.execute(`SELECT * FROM "${o.name}"`);
  const cols = rs.columns;
  if (rs.rows.length) {
    const insert = local.prepare(`INSERT INTO "${o.name}" (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`);
    local.exec('BEGIN');
    for (const row of rs.rows) insert.run(...cols.map((_, i) => row[i] ?? null));
    local.exec('COMMIT');
  }
  counts.push([o.name, rs.rows.length]);
}
local.close();

console.log(`Backed up to ${path.relative(root, out)}\n`);
for (const [t, n] of counts) console.log(`  ${t.padEnd(16)} ${String(n).padStart(5)}`);

if (intoLocal) {
  const live = (process.env.CASE_FILE_DB || '').trim() || path.join(root, 'server', 'case-file.sqlite');
  if (fs.existsSync(live)) {
    const kept = path.join(backups, `case-file-local-before-pull-${stamp}.sqlite`);
    fs.copyFileSync(live, kept);
    console.log(`\nThe local archive it replaces is kept at ${path.relative(root, kept)}`);
  }
  try {
    fs.copyFileSync(out, live);
  } catch (err) {
    console.error(`\nCould not replace ${live} (${err.code}). Stop the local server and run db:pull again.`);
    process.exit(1);
  }
  console.log(`The local archive is now a copy of the live one. Restart the local server to pick it up.`);
}
process.exit(0);
