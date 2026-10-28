import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { get, run } from './db.js';

/* auth.js — one password, for one person, in front of the whole API.
 *
 * On your PC there is no login: APP_PASSWORD is unset, and the app is only
 * reachable from your own machine. Hosted, the app is on the open internet,
 * so every /api route except the three below needs a session cookie.
 *
 * The session is stateless: the cookie carries its own expiry, signed with
 * SESSION_SECRET. Nothing to store, so it works the same on whichever server
 * instance answers, and changing the secret signs every device out at once.
 *
 * Fails closed. Hosted with the password or the secret missing, every route
 * answers 503 rather than quietly serving an open archive. */

const COOKIE = 'cf_session';
const DAY = 86400000;
const SESSION_DAYS = 180;          // a phone stays signed in for half a year
const RENEW_BELOW_DAYS = 90;       // and is quietly re-issued when it is past halfway

/* Brute force: this many wrong passwords from one address inside the window
   locks that address out for the rest of the window. Counted in the database
   rather than in memory, because hosted there is no single process to count in. */
const MAX_FAILURES = 8;
const WINDOW_MS = 15 * 60 * 1000;

const password = () => process.env.APP_PASSWORD || '';
const secret = () => process.env.SESSION_SECRET || '';
const hosted = () => !!process.env.VERCEL;

/** Whether this install asks for a password at all. */
export const required = () => !!password() || hosted();

const misconfigured = () => required() && (!password() || secret().length < 32);

const sign = (payload) => createHmac('sha256', secret()).update(payload).digest('base64url');

function issue(res) {
  const exp = Date.now() + SESSION_DAYS * DAY;
  const value = `${exp}.${sign(`v1.${exp}`)}`;
  res.cookie(COOKIE, value, {
    httpOnly: true,
    secure: hosted(),
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_DAYS * DAY,
  });
}

function readCookie(req) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i !== -1 && part.slice(0, i).trim() === COOKIE) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return '';
}

/** The session's expiry if the cookie is genuine and current, else 0. */
function session(req) {
  const [exp, sig] = readCookie(req).split('.');
  const when = Number(exp);
  if (!sig || !Number.isFinite(when) || when < Date.now()) return 0;
  const want = Buffer.from(sign(`v1.${exp}`));
  const got = Buffer.from(sig);
  return want.length === got.length && timingSafeEqual(want, got) ? when : 0;
}

/* Compared as hashes so the two buffers are always the same length — the
   comparison takes the same time whatever was typed. */
function matches(attempt) {
  const a = createHash('sha256').update(String(attempt ?? '')).digest();
  const b = createHash('sha256').update(password()).digest();
  return timingSafeEqual(a, b);
}

/* Hosted, Vercel's edge sets x-real-ip (and rewrites x-forwarded-for) itself,
   so a client cannot pick an address to dodge the lockout with. */
const clientIp = (req) =>
  String(req.headers['x-real-ip'] || '').trim()
  || String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()
  || req.socket?.remoteAddress
  || 'unknown';

const OPEN = new Set(['/api/login', '/api/logout', '/api/session']);

/** Mounted before every route. */
export function guard(req, res, next) {
  if (!req.path.startsWith('/api/') || OPEN.has(req.path)) return next();
  if (!required()) return next();
  if (misconfigured()) {
    return res.status(503).json({ error: 'sign-in is not configured on this server (APP_PASSWORD, SESSION_SECRET).' });
  }
  const exp = session(req);
  if (!exp) return res.status(401).json({ error: 'sign in to continue.' });
  if (exp - Date.now() < RENEW_BELOW_DAYS * DAY) issue(res);
  next();
}

export function mount(app, wrap) {
  /* What the app asks first: does this install want a password, and is this
     browser already signed in? Always 200, so the answer is never an error. */
  app.get('/api/session', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!required()) return res.json({ required: false, authenticated: true });
    res.json({ required: true, authenticated: !misconfigured() && !!session(req), misconfigured: misconfigured() });
  });

  app.post('/api/login', wrap(async (req, res) => {
    if (!required()) return res.json({ authenticated: true });
    if (misconfigured()) return res.status(503).json({ error: 'sign-in is not configured on this server.' });

    const ip = clientIp(req);
    const since = Date.now() - WINDOW_MS;
    const { n } = await get('SELECT COUNT(*) AS n FROM login_attempts WHERE ip = ? AND at > ?', [ip, since]);
    if (n >= MAX_FAILURES) {
      return res.status(429).json({ error: 'too many wrong passwords. try again in 15 minutes.' });
    }

    if (!matches(req.body?.password)) {
      await run('INSERT INTO login_attempts (ip, at) VALUES (?, ?)', [ip, Date.now()]);
      // Old rows are only ever read inside the window; nothing older is worth keeping.
      await run('DELETE FROM login_attempts WHERE at < ?', [Date.now() - DAY]);
      return res.status(401).json({ error: 'that is not the password.' });
    }

    await run('DELETE FROM login_attempts WHERE ip = ?', [ip]);
    issue(res);
    res.json({ authenticated: true });
  }));

  app.post('/api/logout', (req, res) => {
    res.clearCookie(COOKIE, { path: '/', httpOnly: true, secure: hosted(), sameSite: 'lax' });
    res.json({ authenticated: false });
  });
}
