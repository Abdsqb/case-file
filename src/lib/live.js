/**
 * live.js — keeps every open copy of the app in step with the others.
 *
 * The server moves one number, its `rev`, on every write (server/app.js).
 * While this page is visible it reads that number every few seconds, and at
 * once whenever the page comes back into view or the network returns. When
 * the number has moved since it last looked, something was changed somewhere
 * else, and it says so on the window as REMOTE_CHANGE; whatever holds data
 * listens and reloads its own (the cases in App, today's list, the folders,
 * the boards, the study plan, the notes).
 *
 * The device that made a change hears of it too, in the X-Rev header on the
 * write's own response (api.js passes it to noteRev). It takes that number
 * only when it is exactly the next one, so its own changes do not make it
 * reload, and a change from elsewhere that landed in between still does.
 */

export const REMOTE_CHANGE = 'casefile:remote-change';

const EVERY_MS = 8000;

let known = null;
let timer = 0;
let asking = false;
let started = false;

/** A write's own response carried this rev: our change, already on screen. */
export function noteRev(rev) {
  const n = Number(rev);
  if (!Number.isFinite(n)) return;
  if (known !== null && n === known + 1) known = n;
}

async function check() {
  if (asking || document.hidden) return;
  asking = true;
  try {
    const res = await fetch('/api/rev', { cache: 'no-store' });
    if (!res.ok) return;
    const { rev } = await res.json();
    const n = Number(rev);
    if (!Number.isFinite(n)) return;
    if (known !== null && n !== known) window.dispatchEvent(new Event(REMOTE_CHANGE));
    known = n;
  } catch {
    /* Offline or asleep: the next look will catch up. */
  } finally {
    asking = false;
  }
}

function schedule() {
  clearInterval(timer);
  timer = document.hidden ? 0 : setInterval(check, EVERY_MS);
}

/** Starts watching. Safe to call more than once. */
export function startLive() {
  if (started || typeof window === 'undefined') return;
  started = true;
  const wake = () => { schedule(); check(); };
  document.addEventListener('visibilitychange', wake);
  window.addEventListener('focus', () => check());
  window.addEventListener('online', () => check());
  wake();
}

/** A field has the caret: something is being typed that a reload could undo. */
export function typingSomewhere() {
  const el = typeof document === 'undefined' ? null : document.activeElement;
  if (!el) return false;
  if (el.isContentEditable || el.tagName === 'TEXTAREA') return true;
  return el.tagName === 'INPUT' && !/^(checkbox|radio|button|submit|range|color|file)$/.test(el.type);
}

/**
 * Runs `reload` on every change from elsewhere — but never over work in
 * hand: while `busy()` says so (an unsaved edit, a field being typed in),
 * the reload waits and runs once it is clear. Returns the unsubscribe.
 */
export function onRemoteChange(reload, busy = () => false) {
  let waiting = 0;
  const tryNow = () => {
    clearTimeout(waiting);
    if (busy()) { waiting = setTimeout(tryNow, 1500); return; }
    reload();
  };
  window.addEventListener(REMOTE_CHANGE, tryNow);
  return () => { clearTimeout(waiting); window.removeEventListener(REMOTE_CHANGE, tryNow); };
}
