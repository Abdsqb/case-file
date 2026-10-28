import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import app from './app.js';

/* index.js — the app on your PC: every route from app.js, plus the built
 * frontend, on one port. Hosted, Vercel does both of those jobs itself and
 * this file is not used (see api/index.js). */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(__dirname, '..', 'dist');

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
