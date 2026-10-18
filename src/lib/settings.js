/**
 * settings.js — the single owner of every persisted client-side setting.
 *
 * Split out of views/Settings.jsx so that what reads a setting (the
 * background, the pointer, the case render) does not pull the whole Settings
 * view into the first bundle; the view itself is loaded when it is opened.
 *
 * Nothing here is decorative. Each control writes a real value to
 * localStorage under the `casefile.` namespace, broadcasts a
 * `casefile:settings` event so live consumers (IsoCase, the other views)
 * re-read immediately, and — for reduced motion — stamps the <html> element
 * so the stylesheet override takes effect app-wide. The accent is stamped
 * the same way, as data-accent.
 *
 * Keys owned here (all optional; absent always means "follow the default"):
 *   casefile.reducedMotion   'on' | 'off'   — force reduced motion
 *   casefile.parallax        'on' | 'off'   — IsoCase pointer parallax
 *   casefile.weekStart       '1'  | '0'     — Monday (default) or Sunday
 *   casefile.accent          'violet' (default) | 'white' | 'red' | 'green' | 'turquoise' | 'midnight'
 *   casefile.backdrop        'silk' (default) | any other id in ui/backdrops.js
 *   casefile.backdropBlur    '0' | '1.5' (default) | '3' | '6' | '12' — px of blur over it
 *   casefile.pointer         'soft' (default) | 'system'
 *
 * Other views read these with the exported `useSetting(key, fallback)` hook.
 * Every read is wrapped in try/catch: a corrupt value, a disabled storage
 * quota or private-browsing mode must never throw.
 */

import { useCallback, useSyncExternalStore } from 'react'
import { BACKDROPS, DEFAULT_BACKDROP } from '../ui/backdrops.js'

/* ------------------------------------------------------------------ *
 * storage
 * ------------------------------------------------------------------ */

const NS = 'casefile.'
const EVENT = 'casefile:settings'

export const KEY_REDUCED_MOTION = 'reducedMotion'
export const KEY_PARALLAX = 'parallax'
export const KEY_WEEK_START = 'weekStart'
export const KEY_ACCENT = 'accent'
export const KEY_BACKDROP = 'backdrop'
export const KEY_BACKDROP_BLUR = 'backdropBlur'
export const KEY_POINTER = 'pointer'

/* The pointer: the app's soft disc (ui/SoftPointer.jsx), or the system's own. */
export const POINTERS = [
  { value: 'soft', label: 'Soft dot' },
  { value: 'system', label: 'System' },
]
export const DEFAULT_POINTER = POINTERS[0].value

/* How much the light behind the glass is diffused, in CSS px of blur. The
   second is the default: a breath of haze, enough to soften the strands
   without losing them. */
export const BLURS = [
  { value: 0, label: 'Crisp' },
  { value: 1.5, label: 'Haze' },
  { value: 3, label: 'Mist' },
  { value: 6, label: 'Fog' },
  { value: 12, label: 'Smoke' },
]
export const DEFAULT_BLUR = BLURS[1].value

/** The stored diffusion, or the default when it is missing or not one we offer. */
export function readBackdropBlur() {
  const raw = Number(readRaw(KEY_BACKDROP_BLUR))
  return BLURS.some((b) => b.value === raw) && readRaw(KEY_BACKDROP_BLUR) !== null ? raw : DEFAULT_BLUR
}

/* The order the swatches sit in. Each id has a block in styles.css under
   ACCENTS; the first is the default and the one with no attribute at all. */
export const ACCENTS = [
  { id: 'violet', label: 'Violet' },
  { id: 'white', label: 'White' },
  { id: 'red', label: 'Red' },
  { id: 'green', label: 'Green' },
  { id: 'turquoise', label: 'Turquoise' },
  { id: 'midnight', label: 'Midnight' },
]
export const DEFAULT_ACCENT = ACCENTS[0].id

/** Fallback store for private mode / disabled storage — session-scoped. */
const memory = new Map()
let storageOk = null

function fullKey(key) {
  const k = String(key)
  return k.startsWith(NS) ? k : NS + k
}

/** localStorage when it is actually usable, otherwise null. */
function store() {
  if (storageOk === false) return null
  if (typeof window === 'undefined') return null
  try {
    const s = window.localStorage
    // touching a key is the only reliable availability probe
    s.getItem(`${NS}__probe`)
    storageOk = true
    return s
  } catch {
    storageOk = false
    return null
  }
}

function readRaw(key) {
  const k = fullKey(key)
  const s = store()
  if (s) {
    try {
      const v = s.getItem(k)
      if (v !== null && v !== undefined) return v
    } catch {
      /* fall through to memory */
    }
    return null
  }
  return memory.has(k) ? memory.get(k) : null
}

function broadcast() {
  if (typeof window === 'undefined') return
  try {
    window.dispatchEvent(new Event(EVENT))
  } catch {
    /* very old engines — nothing we can do, and nothing that should break */
  }
}

/**
 * Coerce a stored string against the shape of the fallback:
 *   boolean fallback → 'on' / 'true' / '1' are true, anything else false
 *   number  fallback → Number(), falling back when it is not finite
 *   otherwise        → the raw string
 */
function coerce(raw, fallback) {
  if (raw === null || raw === undefined) return fallback
  if (typeof fallback === 'boolean') {
    return raw === 'on' || raw === 'true' || raw === '1'
  }
  if (typeof fallback === 'number') {
    const n = Number(raw)
    return Number.isFinite(n) ? n : fallback
  }
  return raw
}

/** Read one setting once, outside React. */
export function readSetting(key, fallback) {
  return coerce(readRaw(key), fallback)
}

/**
 * Write one setting and tell the app. Booleans persist as 'on' / 'off' —
 * the format IsoCase reads. Passing null removes the key (back to default).
 */
export function writeSetting(key, value) {
  const k = fullKey(key)
  const raw =
    value === null || value === undefined
      ? null
      : typeof value === 'boolean'
        ? value ? 'on' : 'off'
        : String(value)

  const s = store()
  if (s) {
    try {
      if (raw === null) s.removeItem(k)
      else s.setItem(k, raw)
    } catch {
      /* quota / privacy — keep the session copy so the UI stays honest */
      if (raw === null) memory.delete(k)
      else memory.set(k, raw)
    }
  } else if (raw === null) {
    memory.delete(k)
  } else {
    memory.set(k, raw)
  }

  broadcast()
}

/** Drop every `casefile.` key and return the app to its defaults. */
export function clearSettings() {
  const s = store()
  if (s) {
    const doomed = []
    try {
      for (let i = 0; i < s.length; i += 1) {
        const k = s.key(i)
        if (k && k.startsWith(NS)) doomed.push(k)
      }
      for (const k of doomed) s.removeItem(k)
    } catch {
      /* ignore — the memory clear below still applies */
    }
  }
  memory.clear()
  broadcast()
}

function subscribe(callback) {
  if (typeof window === 'undefined') return () => {}
  window.addEventListener(EVENT, callback)
  window.addEventListener('storage', callback)
  return () => {
    window.removeEventListener(EVENT, callback)
    window.removeEventListener('storage', callback)
  }
}

/**
 * Read a persisted setting, live. `fallback` must be a primitive — its type
 * decides the coercion (boolean → 'on'/'off', number → Number(), else string).
 *
 *   const weekStart = useSetting('weekStart', 1)     // 1 | 0
 *   const parallax  = useSetting('parallax', true)   // boolean
 */
export function useSetting(key, fallback) {
  const snapshot = useCallback(() => coerce(readRaw(key), fallback), [key, fallback])
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}

/* ------------------------------------------------------------------ *
 * reduced motion — stamped on <html> so it applies app-wide
 * ------------------------------------------------------------------ */

export function applyMotionPreference() {
  if (typeof document === 'undefined') return
  const on = coerce(readRaw(KEY_REDUCED_MOTION), false)
  const root = document.documentElement
  root.classList.toggle('motion-reduced', on)
  if (on) root.dataset.motion = 'reduced'
  else root.removeAttribute('data-motion')
}

/* ------------------------------------------------------------------ *
 * accent — stamped on <html> as data-accent; the stylesheet does the rest
 * ------------------------------------------------------------------ */

/** The stored accent, or the default when it is missing or not one we know. */
export function readAccent() {
  const raw = readRaw(KEY_ACCENT)
  return ACCENTS.some((a) => a.id === raw) ? raw : DEFAULT_ACCENT
}

/** The stored backdrop, or the default when it is missing or not one we know. */
export function readBackdrop() {
  let raw = readRaw(KEY_BACKDROP)
  // Ember Current was retired: anyone on it goes back to Glass Current.
  if (raw === 'embers') raw = 'shards'
  return BACKDROPS.some((b) => b.id === raw) ? raw : DEFAULT_BACKDROP
}

export function applyAccentPreference() {
  if (typeof document === 'undefined') return
  const accent = readAccent()
  const root = document.documentElement
  if (accent === DEFAULT_ACCENT) root.removeAttribute('data-accent')
  else root.dataset.accent = accent
}

// Applied at import time so the preferences survive a reload even when the
// user never opens this view, and re-applied whenever anything (including
// another tab) changes them. Registered before any React subscriber, so the
// attribute is already on <html> by the time a component re-reads a token.
export function applyPreferences() {
  applyMotionPreference()
  applyAccentPreference()
}

if (typeof window !== 'undefined') {
  applyPreferences()
  window.addEventListener(EVENT, applyPreferences)
  window.addEventListener('storage', applyPreferences)
}
