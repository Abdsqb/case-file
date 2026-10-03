/**
 * prefs.js — what the reader has asked for about motion.
 *
 * Two questions, one answer each: is motion reduced, and may the app follow
 * the pointer. Both are read from the same two places every time — the
 * system's own setting, and the two overrides Settings writes to
 * localStorage — so no two parts of the app can end up disagreeing about what
 * the reader wants.
 *
 * It lives here rather than in whichever component happened to need it first:
 * three copies of this function is three chances for one of them to drift.
 */

export const RM_QUERY = '(prefers-reduced-motion: reduce)';

/* Settings writes these; nothing else does. */
const FORCED_KEY = 'casefile.reducedMotion';
const PARALLAX_KEY = 'casefile.parallax';

/* What Settings fires when a preference changes in this tab. The `storage`
   event only reaches OTHER tabs, so without this the screen you changed it on
   would be the last one to find out. */
export const PREFS_EVENT = 'casefile:settings';

export function readMotionPrefs() {
  /* Server-side or pre-mount: assume the most conservative answer. Nothing
     should start moving on the strength of a guess. */
  if (typeof window === 'undefined') return { reduced: true, parallax: false };

  let sysReduced = false;
  try {
    sysReduced = window.matchMedia(RM_QUERY).matches;
  } catch {
    sysReduced = false;
  }

  let forced = false;
  let parallaxOff = false;
  try {
    forced = window.localStorage.getItem(FORCED_KEY) === 'on';
    parallaxOff = window.localStorage.getItem(PARALLAX_KEY) === 'off';
  } catch {
    /* storage unavailable — fall through to defaults */
  }

  const reduced = sysReduced || forced;
  /* Reduced motion wins outright: it is not a preference about pointers, it is
     a statement that the screen should hold still. */
  return { reduced, parallax: !reduced && !parallaxOff };
}

/**
 * Calls back whenever the answer might have changed — the system setting, a
 * change made in another tab, or one made in this one. Returns the unsubscribe.
 */
export function watchMotionPrefs(onChange) {
  if (typeof window === 'undefined') return () => {};

  let mql = null;
  try { mql = window.matchMedia(RM_QUERY); } catch { mql = null; }
  if (mql) {
    if (typeof mql.addEventListener === 'function') mql.addEventListener('change', onChange);
    else if (typeof mql.addListener === 'function') mql.addListener(onChange);
  }
  window.addEventListener('storage', onChange);
  window.addEventListener(PREFS_EVENT, onChange);

  return () => {
    if (mql) {
      if (typeof mql.removeEventListener === 'function') mql.removeEventListener('change', onChange);
      else if (typeof mql.removeListener === 'function') mql.removeListener(onChange);
    }
    window.removeEventListener('storage', onChange);
    window.removeEventListener(PREFS_EVENT, onChange);
  };
}
