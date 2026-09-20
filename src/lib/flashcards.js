/**
 * flashcards.js — importing card files, and the review schedule.
 *
 * Both halves are pure functions over plain data: no React, no fetch, no clock
 * of their own. `now` is always passed in, which is what makes the scheduler
 * testable and keeps it honest about time.
 *
 * This module never calls a model. Card files are written elsewhere and merely
 * read here.
 */

/* ------------------------------------------------------------------ *
 * the import parser                                                   *
 * ------------------------------------------------------------------ */

/* The same field can arrive under several names, because the files are written
   by hand or by a model following a prompt, and both drift. Listed in priority
   order — the first key present on an object wins. */
const DECK_KEYS = ['deck', 'name', 'title'];
const LIST_KEYS = ['cards', 'items'];
const FRONT_KEYS = ['question', 'front', 'q'];
const BACK_KEYS = ['answer', 'back', 'a'];

export class ImportError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ImportError';
  }
}

/** First present, non-empty value among `keys`, as a trimmed string. */
function pick(obj, keys) {
  for (const k of keys) {
    const v = obj[k];
    if (v === null || v === undefined) continue;
    // A number or boolean is a perfectly good answer; only objects are not.
    if (typeof v === 'object') continue;
    const s = String(v).trim();
    if (s) return s;
  }
  return '';
}

/** `Cell Biology - Lecture 4.json` → `Cell Biology - Lecture 4` */
export function deckNameFromFile(filename) {
  return String(filename || '')
    .replace(/\.[^.]+$/, '')
    .trim();
}

/**
 * Read a card file into `{ deck, cards }`.
 *
 * Throws ImportError with a message meant to be shown verbatim to the person
 * who picked the file — the two failures that actually happen are malformed
 * JSON and a file whose entries are the wrong shape, and neither is helped by
 * a stack trace.
 *
 * `fallbackName` is used when the file itself carries no deck name, which is
 * always the case for the bare-array form.
 */
export function parseDeckFile(text, fallbackName = '') {
  const raw = String(text == null ? '' : text).trim();
  if (!raw) throw new ImportError('Nothing to import — paste some JSON or choose a file.');

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new ImportError("That's not valid JSON — check for a stray comma or missing bracket.");
  }

  // Either a bare array of cards, or an object wrapping one.
  let list = null;
  let deck = '';
  if (Array.isArray(data)) {
    list = data;
  } else if (data && typeof data === 'object') {
    for (const k of LIST_KEYS) {
      if (Array.isArray(data[k])) { list = data[k]; break; }
    }
    deck = pick(data, DECK_KEYS);
  }

  if (!list) {
    throw new ImportError(
      'That JSON has no card list — expected an array, or an object with a "cards" array.'
    );
  }

  const cards = [];
  let dropped = 0;
  for (const item of list) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) { dropped += 1; continue; }
    const front = pick(item, FRONT_KEYS);
    const back = pick(item, BACK_KEYS);
    // A card missing either side cannot be reviewed, so it is dropped rather
    // than imported as a half-card the user would have to find and fix later.
    if (!front || !back) { dropped += 1; continue; }
    cards.push({ front, back });
  }

  if (!cards.length) {
    throw new ImportError('No valid cards found — each one needs a question and an answer.');
  }

  return { deck: deck || String(fallbackName || '').trim(), cards, dropped };
}

/* ------------------------------------------------------------------ *
 * the schedule                                                        *
 * ------------------------------------------------------------------ */

export const RATINGS = ['again', 'hard', 'good', 'easy'];

const MIN_EF = 1.3;
const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

/** A rated-"again" card comes back in this long, not tomorrow. */
export const AGAIN_DELAY_MS = 10 * MINUTE;

/** The state every imported card starts in: new, and due immediately. */
export function newCardState(now) {
  return { ef: 2.5, interval: 0, reps: 0, due: now, lastReviewed: null };
}

/**
 * Simplified SM-2 — the same family Anki uses, not the full original.
 *
 * Returns the card's next scheduling state; it does not mutate the input.
 *
 * `ef` is how easy this particular card is for this particular person. It
 * drifts down when they struggle and up when it is easy, and because the
 * interval is repeatedly multiplied by it, small drifts compound into much
 * longer or shorter gaps over a term.
 *
 * "Again" deliberately does not wipe progress — it resets the streak and asks
 * again in ten minutes rather than pushing the card a day out.
 */
export function scheduleCard(card, rating, now) {
  const at = Number.isFinite(now) ? now : Date.now();
  let ef = Number.isFinite(card.ef) ? card.ef : 2.5;
  let interval = Number.isFinite(card.interval) ? card.interval : 0;
  let reps = Number.isFinite(card.reps) ? card.reps : 0;

  if (rating === 'again') {
    reps = 0;
    ef = Math.max(MIN_EF, ef - 0.2);
    interval = 0;
    return { ef, interval, reps, due: at + AGAIN_DELAY_MS, lastReviewed: at };
  }

  if (rating === 'hard') {
    ef = Math.max(MIN_EF, ef - 0.15);
    interval = reps === 0 ? 1 : Math.max(1, Math.round(interval * 1.2));
    reps += 1;
  } else if (rating === 'good') {
    interval = reps === 0 ? 1 : reps === 1 ? 6 : Math.round(interval * ef);
    reps += 1;
  } else if (rating === 'easy') {
    // The bump lands before the multiply, so an easy card gets the benefit of
    // its new ease immediately.
    ef += 0.15;
    interval = reps === 0 ? 4 : Math.round(interval * ef * 1.3);
    reps += 1;
  } else {
    throw new Error(`unknown rating: ${rating}`);
  }

  return { ef, interval, reps, due: at + interval * DAY, lastReviewed: at };
}

/* ------------------------------------------------------------------ *
 * queue helpers                                                       *
 * ------------------------------------------------------------------ */

export function isDue(card, now) {
  return Number.isFinite(card.due) && card.due <= now;
}

/** Everything reviewable right now, soonest-due first. */
export function dueQueue(cards, now) {
  return cards.filter((c) => isDue(c, now)).sort((a, b) => a.due - b.due);
}

/** `in 6 days`, `in 10 min`, `today` — how the rating buttons preview a choice. */
export function fmtWhen(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return 'now';
  const mins = Math.round(ms / MINUTE);
  if (mins < 60) return `${mins} min`;
  const hours = Math.round(ms / (60 * MINUTE));
  if (hours < 24) return `${hours}h`;
  const days = Math.round(ms / DAY);
  if (days < 31) return `${days} ${days === 1 ? 'day' : 'days'}`;
  const months = Math.round(days / 30);
  return `${months} ${months === 1 ? 'month' : 'months'}`;
}

/** What each button would do to this card, for the preview under the label. */
export function previewIntervals(card, now) {
  const out = {};
  for (const r of RATINGS) {
    const next = scheduleCard(card, r, now);
    out[r] = fmtWhen(next.due - now);
  }
  return out;
}
