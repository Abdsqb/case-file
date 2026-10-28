# Case File on your phone — deployment plan

Goal: the app reachable from your phone (and any browser) with your PC off, for $0, with
no card, and with your real data intact. Hosting: **Vercel** (app + API) and **Turso**
(the database). Every push to `main` deploys automatically.

Status (28 Oct 2026): phases 0–4 and the phase 6 scripts are **done and tested locally**;
waiting on phase 5 (your Turso and Vercel accounts). Decisions: repo stays public, time zone
`America/New_York`, timetable in the database, Turso becomes the live copy.

What changed from the plan while doing it:
- The scripts read **`TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN`**, not `DATABASE_URL`, so
  having them in `.env` never points the local app at the live data. The hosted app (Vercel)
  is the only thing given `DATABASE_URL` / `DATABASE_AUTH_TOKEN`.
- The Turso client **enforces foreign keys** (the old driver did not). The live archive was
  checked: no violations. Deletes already run children-first; the import orders parents first.
- Schema versions are kept in a `meta` table: 1 = everything up to the to-do list,
  2 = `login_attempts`, 3 = `timetable`. The live local archive is at version 3.
- Pre-migration backup: `server/backups/case-file-2026-10-28-pre-turso.sqlite`.

---

## 1. What the pre-flight check found

A pass over every server file, the build, the service worker and the data. Each line is
something that would break, leak or misbehave if we simply "deployed it".

| # | Area | Finding | Impact if ignored | Fix (phase) |
|---|------|---------|-------------------|-------------|
| 1 | Database | Data lives in `server/case-file.sqlite`, opened with Node's built-in `node:sqlite`. | Vercel's disk is temporary: every write would vanish within minutes. | Move to Turso (P1, P6). |
| 2 | Database API | **96 synchronous DB calls** across 5 files (index.js 55, clerk.js 20, db.js 15, archive.js 4, news.js 2). Turso's client is asynchronous. | Nothing works until every call is converted. This is the bulk of the work. | Convert to `@libsql/client` with `await` (P1). |
| 3 | Transactions | 4 hand-rolled `BEGIN/COMMIT` blocks (today's list, clerk filing, clerk changes, case-folder delete). | A half-applied filing could leave orphaned entries. | `client.batch()` where statements are independent; `client.transaction()` where later inserts need earlier ids (P1). |
| 4 | Error handling | Express 4 does not catch errors thrown inside `async` routes. | Once routes are async, one DB hiccup hangs the request until the 300s timeout. | Wrap every route, add one JSON error handler (P1). |
| 5 | Start-up work | `db.js` runs ~10 schema checks (PRAGMAs, CREATE IF NOT EXISTS) on every start. | Each is a network round trip; on Vercel every cold start pays them. | Schema version in `PRAGMA user_version`; one query when up to date (P1). |
| 6 | Seeding | An empty database is auto-filled with sample cases. | If the app reaches Turso before your data does, sample cases land in your live database. | Seed only for local files, never for a remote URL (P1). |
| 7 | No login | No authentication anywhere; every `/api` route is open. | Public URL ⇒ anyone could read and edit your cases, notes and to-do. | Password login with a signed cookie (P3). **Must ship before the first deploy.** |
| 8 | Public repo | `Abdsqb/case-file` is **public** on GitHub. | Secrets or personal files committed by mistake would be public. | Secrets only in Vercel settings; keep `.env` and `*.local.ics` ignored (they are). Decide on private repo (§4). |
| 9 | Timetable | Your real timetable (`src/data/class-calendar.local.ics`) is git-ignored and baked into the frontend **at build time**; the server also reads it from disk for the clerk. | Vercel builds from GitHub, so the live Calendar would show the fictional sample. | Store the timetable in the database, upload from Settings (P4). |
| 10 | Time zone | Server-side code (clerk dates, "today", class times in `archive.js`, `clerk.js`, shared `metrics.js`/`ics.js`) uses the server's local time. Vercel runs in **UTC** and reserves the `TZ` variable. | After 8pm New York time the clerk thinks it is tomorrow; "due Friday" lands on Thursday 8pm; class times shift 4–5 hours. | Set `process.env.TZ` from our own `APP_TIMEZONE` at start-up, before any date work (P2). Verified on staging. |
| 11 | Static files | `server/index.js` serves `dist/` with `express.static`. | Vercel ignores `express.static`. | Vercel serves `dist/` from its CDN; the function only answers `/api/*` (P2). |
| 12 | Entry point | `server/index.js` calls `app.listen()`. | Fine locally; Vercel needs the app exported. | Split into `server/app.js` (routes, exported) + `server/index.js` (local: listen + static) + `api/index.js` (Vercel) (P2). |
| 13 | Files read at runtime | `archive.js` reads `.ics` files with `fs`. | May not be bundled into the function. | Becomes a DB read after P4; until then `includeFiles` in `vercel.json` (P2). |
| 14 | AI calls | Clerk requests can run 45s with retries. | Hobby limit is 300s; fine, but must be configured. | `maxDuration: 300` for the API function (P2). |
| 15 | Settings → memory panel | Reads the SQLite file size from disk, process RSS and machine RAM. | Meaningless or erroring on Vercel. | Database size from Turso; hide machine RAM when hosted (P2). |
| 16 | In-memory caches | `news.js` caches headlines in memory; geocoding is rate-limited in memory. | Cache is per server instance; harmless, a little more fetching. | No change; place lookups are already cached in the DB. |
| 17 | Service worker | Network-first, never caches `/api/*`. Cache version `v6`. | Good as is. | Bump to `v7` with the login screen so phones pick it up (P3). |
| 18 | Body size | Vercel caps requests at 4.5 MB. | Only matters for a very large notes pad or timetable. | Note it; the timetable upload checks size (P4). |
| 19 | Usage limits | Turso free: 500M rows read, 10M written / month, 5 GB. The archive is ~70 KB; a full load reads ~40 rows; Reporting polls while open. | Estimated use is well under 1% of the limits. | Nothing; watch the Turso dashboard the first week. |
| 20 | Backups | Turso free keeps 1 day of point-in-time restore only. | A bad write noticed after 24h is unrecoverable. | `npm run db:backup` pulls a dated copy to your PC; run weekly (P9). |

---

## 2. Target architecture

```
 Phone / browser ── HTTPS ──► Vercel
                               ├─ CDN: dist/  (the built app, fonts, icons, sw.js)   ← public, no data in it
                               └─ Function: api/index.js → server/app.js (Express)
                                     ├─ checks the login cookie on every /api call
                                     ├─ TZ set to APP_TIMEZONE before anything runs
                                     └─ @libsql/client ── HTTPS ──► Turso (your database)
                                                                    region: AWS us-east-1
 Your PC (development)
   npm run dev  → same code, database = local file (file:server/case-file.sqlite)
   npm run db:backup → copies Turso down to a dated local file
```

Vercel's functions run in `iad1` (Washington, D.C.) by default; the Turso database goes in
AWS `us-east-1` next to it, so each query is a few milliseconds.

---

## 3. What stays the same

- The whole UI, every feature, Shift+N, Shift+T, the to-do, the clerk.
- Local development: `npm run dev` still runs everything on your PC against a local file.
- How you ship: "push to main". After phase 7, that also updates the live app.

---

## 4. Decisions needed from you before we start

| Decision | Options | Recommendation |
|----------|---------|----------------|
| Repo visibility | Keep public, or make private (free on GitHub; Vercel Hobby supports private repos). | **Private.** The repo describes your app and its API in detail; private removes a whole class of mistakes. Your call — the plan works either way. |
| Time zone | Your IANA zone. | `America/New_York`, unless you say otherwise. |
| Password | You choose it; it is stored only in Vercel's settings (hashed in use). | A passphrase of 4+ words. Never sent to me. |
| Timetable | Upload in Settings (P4) or accept the sample Calendar online. | Do P4; it is small. |
| Which data is "live" after launch | Turso is the real copy; your PC copy becomes a test copy. | Yes. `db:backup` keeps a local copy fresh when you want one. |

---

## 5. Roadmap

Each phase leaves the app fully working on your PC and is pushed to `main` on its own.
Until phase 7 connects Vercel, pushing to `main` deploys nothing, so phases 1–4 are safe.

### Phase 0 — Safety net (me, 5 min)
1. Dated copy of the live database: `server/backups/case-file-YYYY-MM-DD.sqlite` (git-ignored).
2. Record row counts per table (projects, tasks, case_folders, notes, headline_places,
   today_items, today_days) to compare after the import.
3. Add `server/backups/` to `.gitignore`.

**Done when:** the backup opens and its counts match the live file.

### Phase 1 — Database layer to libSQL (me, the largest phase)
1. Add `@libsql/client`. `server/db.js` exports a client built from `DATABASE_URL`
   (`file:server/case-file.sqlite` by default, `libsql://…` in production) and
   `DATABASE_AUTH_TOKEN`.
2. Small helpers so call sites stay readable: `get(sql, args)`, `all(sql, args)`,
   `run(sql, args)` → `{ changes, lastInsertRowid }`.
3. Convert all 96 call sites to `await`, file by file: `archive.js`, `news.js`, `index.js`,
   `clerk.js`. Functions that become async (`loadProjects`, `snapshot`, …) are awaited by
   their callers.
4. `loadProjects()`: its three queries go in one `batch` → one round trip.
5. Transactions: today's list → `batch` (delete + inserts); clerk filing and clerk changes →
   `transaction('write')` because subtasks need the new entry's id; folder delete → `batch`.
6. Schema: one ordered list of migrations; `PRAGMA user_version` records how far a database
   is. Cold start = one query when current.
7. Seeding: only when the URL is a local file **and** the database has no projects.
8. Errors: `wrap(fn)` around every async route; a final handler returns
   `{ error }` JSON with status 500 and logs the stack.

**Verify (local):** the full test pass in §7 against the local file, plus: kill the server
mid-filing and confirm nothing half-written appears.
**Rollback:** revert the phase's commit; the local database file is untouched by the change.

### Phase 2 — Vercel shape (me)
1. Split: `server/app.js` (all routes, `export default app`), `server/index.js` (local:
   imports app, serves `dist/`, listens on 4001), `api/index.js` (Vercel: re-exports app).
2. First lines of `server/app.js`: `if (process.env.APP_TIMEZONE) process.env.TZ = …`.
3. `vercel.json`:
   - `rewrites`: `/api/(.*)` → `/api`
   - `functions["api/index.js"]`: `maxDuration: 300`, `includeFiles: "src/data/**"` (until P4)
   - `headers`: `sw.js` no-cache; `X-Robots-Tag: noindex`; `X-Frame-Options: DENY`;
     `X-Content-Type-Options: nosniff`; `Referrer-Policy: same-origin`
4. `package.json`: `"engines": { "node": "22.x" }`.
5. Settings memory panel: database size from Turso (`page_count × page_size`), machine RAM
   hidden when hosted.

**Verify:** `npm run dev` unchanged; `vercel dev`-equivalent run of `api/index.js` answers
`/api/projects`.

### Phase 3 — Login (me) — **required before going live**
1. Environment: `APP_PASSWORD` (your passphrase) and `SESSION_SECRET` (64 random bytes).
2. `POST /api/login` compares in constant time and sets cookie `cf_session`: an HMAC-signed
   expiry, `HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=180 days`. Stateless, so it
   works across serverless instances.
3. `POST /api/logout`; `GET /api/session` → 200 or 401.
4. Middleware: every `/api/*` except login/session requires a valid cookie; mutating
   requests must be JSON (blocks cross-site form posts).
5. Brute force: failed attempts recorded per IP in a `login_attempts` table; 8 failures in
   15 minutes locks that IP for 15 minutes.
6. Frontend: a login screen in the app's own glass style; on any 401 the app returns to it.
   "Sign out" in Settings.
7. Locally (no `APP_PASSWORD` set) login is skipped, so development is unchanged.
8. Service worker cache → `v7`.

**Verify:** wrong password refused and counted; right password lands in the app; every API
route returns 401 without the cookie (scripted check of all routes); cookie survives a
browser restart.

### Phase 4 — Timetable in the database (me)
1. Table `timetable (id = 1, ics TEXT, name TEXT, updated_at)`.
2. `GET /api/timetable`, `PUT /api/timetable` (size-checked, parsed before saving).
3. Calendar reads it from the API; the bundled sample stays as the fallback when empty.
4. The clerk reads the same row instead of the disk.
5. Settings: "Timetable — Upload .ics" and "Use sample".
6. On your PC, one click uploads the existing `class-calendar.local.ics`.

**Verify:** Calendar identical before and after; the clerk's brief still mentions classes.

### Phase 5 — Accounts (you, ~10 min; I give exact clicks)
1. **Turso** (turso.tech) → sign in with GitHub → create database `case-file`, location
   **AWS us-east-1** → create a database token. Keep the URL (`libsql://…`) and the token.
2. **Vercel** (vercel.com) → sign up with GitHub (Hobby plan). Don't import anything yet.
3. Optional: make the GitHub repo private (Settings → General → Danger Zone → Change
   visibility).

No card is requested by either. Credentials go into Vercel's settings by you, not into chat.

### Phase 6 — Move your data (me, with your Turso URL/token set locally)
1. Script `scripts/db-import.mjs`: reads the local file with `node:sqlite`, applies the
   schema to Turso, copies every table **keeping the original ids** (the to-do list and
   subtasks point at them), in one write batch.
2. Refuses to run if Turso already has projects, unless `--force`.
3. Compares counts table by table against Phase 0 and prints them.
4. Spot-check: three cases with their entries, notes text, today's list.

**Rollback:** delete and recreate the Turso database; the local file was only read.

### Phase 7 — First deploy (you click, I check)
1. Vercel → Add New Project → import `Abdsqb/case-file`. Framework: **Vite**. Build:
   `npm run build`. Output: `dist`.
2. Environment variables (Production): `DATABASE_URL`, `DATABASE_AUTH_TOKEN`,
   `APP_PASSWORD`, `SESSION_SECRET`, `APP_TIMEZONE`, and the AI keys you use
   (`GEMINI_API_KEY`, `GROQ_API_KEY`, `OPENROUTER_API_KEY`, optional `CLERK_PROVIDER`,
   `CLERK_OPENROUTER_MODEL`, `OPENROUTER_MODEL` — names as in `.env.example`).
3. Deploy. You get `https://<name>.vercel.app`.
4. Smoke test (§7) on the live URL, especially time zone (a "due tomorrow" entry), the
   clerk, and the to-do window.

**Rollback:** Vercel → Deployments → Instant Rollback, or remove the project. Your data is in
Turso either way.

### Phase 8 — Phone (you, 5 min)
- **iPhone:** Safari → the URL → sign in → Share → *Add to Home Screen*. Sign in once more
  inside the home-screen app (iOS keeps its cookies separate).
- **Android:** Chrome → the URL → sign in → ⋮ → *Install app*.

### Phase 9 — Living with it
- **Shipping changes:** we work on your PC as now; "push to main" → Vercel builds and the
  phone has it in about a minute. A build that fails never replaces the working version.
- **Undo a bad release:** Vercel → Deployments → Instant Rollback (seconds).
- **Backups:** `npm run db:backup` → `server/backups/case-file-YYYY-MM-DD.sqlite`. Weekly, or
  before anything risky. Turso also keeps 24h of point-in-time restore.
- **Testing with real data on your PC:** `npm run db:pull` copies Turso to the local file.
  There is no "push local to live" command on purpose.
- **Logs:** Vercel → Project → Logs, for any 500.
- **Limits:** glance at Turso's usage page after the first week.

---

## 6. Risk register

| Risk | Likelihood | Effect | Guard |
|------|-----------|--------|-------|
| A DB call missed in the async conversion | Medium | One feature errors | Grep for sync patterns returns zero; full §7 pass; route-by-route 401/200 script |
| Data copied incompletely | Low | Missing entries | Count comparison per table; import refuses a non-empty target |
| Sample data seeded into Turso | Low | Fake cases in your archive | Seeding only for local file URLs |
| App public without login | Low | Data exposed | Login lands in P3; P7 cannot start until P3 is merged |
| Time zone wrong on the server | Medium | Dates off by a day in the evening | `APP_TIMEZONE` → `process.env.TZ`; explicit evening test in P7 |
| Clerk request exceeds 300s | Low | One failed filing | 45s per-call timeout already; retries bounded |
| Free-tier policy changes | Low | Service paused | Weekly backup; the app still runs locally from a pulled copy |
| Lost Turso token / password | Low | Locked out | Both live in Vercel settings and can be regenerated |

---

## 7. Test pass (run after P1, P3 and P7)

1. Case files: create, rename, reorder, delete a case; sub-case; folder create/rename/delete.
2. Entries: add, edit title, due date, priority, close/reopen, subtask, drag to nest, delete.
3. To-do: Today on an entry and a subtask, Shift+T, tick (closes in case), reorder, ×,
   morning question on a test day.
4. Notes: type, wait, reload — text persists. Filing via the clerk, accept and discard.
5. Clerk: chat question, brief, changes.
6. Reporting and Calendar load; Calendar shows your timetable (after P4).
7. Settings: accent, background, reset; memory panel shows sensible numbers.
8. Login (P3+): wrong password, right password, sign out, 401 without cookie on every route.
9. Time zone (P7): an entry due tomorrow reads "due tomorrow" after 8pm New York time.
10. Phone: home-screen app opens, signs in, survives closing and reopening.

---

## 8. Effort and order

| Phase | Who | Rough size |
|-------|-----|-----------|
| 0 Safety net | me | minutes |
| 1 libSQL conversion | me | the bulk — a long session |
| 2 Vercel shape | me | short |
| 3 Login | me | medium |
| 4 Timetable in DB | me | short–medium |
| 5 Accounts | you | ~10 min |
| 6 Data import | me | short |
| 7 First deploy | you + me | ~15 min |
| 8 Phone | you | ~5 min |

Order is fixed for 1 → 2 → 3 (each builds on the last); 4 can sit anywhere before 7;
5 can be done any time before 6.

---

## Sources (checked October 2026)

- Vercel Functions limits (Hobby: 300s max duration, 2 GB, 4.5 MB body):
  https://vercel.com/docs/functions/limitations
- Express on Vercel (single function, `express.static` ignored):
  https://vercel.com/docs/frameworks/backend/express
- Vercel reserved environment variables (`TZ` reserved):
  https://vercel.com/docs/environment-variables/reserved-environment-variables
- Turso pricing (Free: 5 GB, 500M reads, 10M writes, no card, 1-day restore):
  https://turso.tech/pricing
