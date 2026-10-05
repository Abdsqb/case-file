/**
 * clerk.js — the browser's side of the clerk, and nothing else.
 *
 * Same contract as lib/api.js: no retries, no caching, no React. One addition —
 * `status()` is memoised for the life of the page, because every surface that
 * might offer the clerk has to ask whether it is on duty, and the answer only
 * changes when .env changes, which is a restart.
 *
 * Endpoints:
 *   GET  /api/clerk              → { ready, providers[], routing }
 *   POST /api/clerk/file         { text }              → { summary, proposals[] }
 *   POST /api/clerk/apply        { proposals }         → { cases, entries, subtasks }
 *   GET  /api/clerk/brief[?force=1]                    → { work, news, body, model, madeAt, cached }
 *   POST /api/clerk/chat         { messages }          → { reply, toolsUsed }
 *   POST /api/clerk/deck         { text, name, count } → { name, cards[] }
 */

const BASE = '/api/clerk';

export class ClerkError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'ClerkError';
    this.status = status;
    /* 503 is the one worth telling apart everywhere: it does not mean the
       clerk failed, it means there is no key and the feature is not on. */
    this.offDuty = status === 503;
  }
}

async function call(method, path, payload) {
  let res;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers: payload === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
  } catch {
    throw new ClerkError('the server is unreachable.', 0);
  }

  const text = await res.text();
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch { data = text; } }

  if (!res.ok) {
    const detail = data && typeof data === 'object' && typeof data.error === 'string'
      ? data.error
      : typeof data === 'string' && data.trim()
        ? data.trim().slice(0, 240)
        : res.statusText;
    throw new ClerkError(detail || 'the clerk could not answer.', res.status);
  }

  return data;
}

let statusPromise = null;

/**
 * Is the clerk on duty, and who is answering?
 *
 * Asked once per page load. Failing softly to `ready: false` rather than
 * throwing is deliberate: this is called during render on several screens, and
 * an old build talking to a server without these routes should quietly not
 * offer the feature rather than break the screen it is on.
 */
export function status() {
  if (!statusPromise) {
    statusPromise = call('GET', '').catch(() => ({ ready: false, providers: [], routing: {} }));
  }
  return statusPromise;
}

/** Only for Settings, after a change that could not have altered the server. */
export function forgetStatus() {
  statusPromise = null;
}

export function file(text) {
  return call('POST', '/file', { text });
}

export function apply(proposals) {
  return call('POST', '/apply', { proposals });
}

export function brief({ force = false } = {}) {
  return call('GET', `/brief${force ? '?force=1' : ''}`);
}

export function chat(messages) {
  return call('POST', '/chat', { messages });
}

export function buildDeck(text, { name = '', count = 0 } = {}) {
  return call('POST', '/deck', { text, name, count });
}

export default { status, forgetStatus, file, apply, brief, chat, buildDeck, ClerkError };
