/**
 * Settings.jsx — the app's preference surface, and the single owner of every
 * persisted client-side setting.
 *
 * Nothing here is decorative. Each control writes a real value to
 * localStorage under the `casefile.` namespace, broadcasts a
 * `casefile:settings` event so live consumers (IsoCase, the other views)
 * re-read immediately, and — for reduced motion — stamps the <html> element
 * so the stylesheet override takes effect app-wide.
 *
 * Keys owned here (all optional; absent always means "follow the default"):
 *   casefile.reducedMotion   'on' | 'off'   — force reduced motion
 *   casefile.parallax        'on' | 'off'   — IsoCase pointer parallax
 *   casefile.weekStart       '1'  | '0'     — Monday (default) or Sunday
 *
 * Other views read these with the exported `useSetting(key, fallback)` hook.
 * Every read is wrapped in try/catch: a corrupt value, a disabled storage
 * quota or private-browsing mode must never throw.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { Card, CardHead, Metric, Pill, Segmented, Toggle } from '../ui/primitives.jsx'
import { listProjects } from '../lib/api.js'
import { globalStats } from '../lib/metrics.js'

/* ------------------------------------------------------------------ *
 * storage
 * ------------------------------------------------------------------ */

const NS = 'casefile.'
const EVENT = 'casefile:settings'

export const KEY_REDUCED_MOTION = 'reducedMotion'
export const KEY_PARALLAX = 'parallax'
export const KEY_WEEK_START = 'weekStart'

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

// Applied at import time so the preference survives a reload even when the
// user never opens this view, and re-applied whenever anything (including
// another tab) changes it.
if (typeof window !== 'undefined') {
  applyMotionPreference()
  window.addEventListener(EVENT, applyMotionPreference)
  window.addEventListener('storage', applyMotionPreference)
}

/* ------------------------------------------------------------------ *
 * small local helpers
 * ------------------------------------------------------------------ */

const APP_VERSION =
  (typeof import.meta !== 'undefined' &&
    import.meta.env &&
    import.meta.env.VITE_APP_VERSION) ||
  '0.2.0'

const BUILD_MODE =
  (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.MODE) || 'development'

/** One clock for the view: the app's if it passed one, ours otherwise. */
function useClock(external, interval = 30000) {
  const fixed =
    external instanceof Date
      ? external.getTime()
      : Number.isFinite(external)
        ? external
        : null
  const [tick, setTick] = useState(() => Date.now())

  useEffect(() => {
    if (fixed !== null) return undefined
    const id = setInterval(() => setTick(Date.now()), interval)
    return () => clearInterval(id)
  }, [fixed, interval])

  return fixed === null ? tick : fixed
}

/**
 * Cases, from the prop when the app supplies them and from the API when it
 * does not — so this view is correct however it is mounted.
 */
function useProjects(external) {
  const provided = Array.isArray(external)
  const [state, setState] = useState({ data: [], status: provided ? 'ready' : 'loading' })
  const gen = useRef(0)

  useEffect(() => {
    if (provided) return undefined
    const id = gen.current + 1
    gen.current = id
    let alive = true
    listProjects()
      .then((rows) => {
        if (!alive || gen.current !== id) return
        setState({ data: Array.isArray(rows) ? rows.filter(Boolean) : [], status: 'ready' })
      })
      .catch(() => {
        if (!alive || gen.current !== id) return
        setState({ data: [], status: 'error' })
      })
    return () => {
      alive = false
    }
  }, [provided])

  return provided ? { data: external, status: 'ready' } : state
}

/** True when this browser has anything to clear. */
function cacheSupported() {
  if (typeof window === 'undefined') return false
  const sw = typeof navigator !== 'undefined' && !!navigator.serviceWorker
  const cache = typeof window.caches !== 'undefined'
  return sw || cache
}

async function purgeAppCache() {
  const jobs = []
  if (typeof navigator !== 'undefined' && navigator.serviceWorker) {
    jobs.push(
      Promise.resolve()
        .then(() =>
          navigator.serviceWorker.getRegistrations
            ? navigator.serviceWorker.getRegistrations()
            : []
        )
        .then((regs) => Promise.all((regs || []).map((r) => r.unregister())))
    )
  }
  if (typeof window !== 'undefined' && typeof window.caches !== 'undefined') {
    jobs.push(
      Promise.resolve()
        .then(() => window.caches.keys())
        .then((keys) => Promise.all((keys || []).map((k) => window.caches.delete(k))))
    )
  }
  await Promise.all(jobs)
}

/* ------------------------------------------------------------------ *
 * pieces
 * ------------------------------------------------------------------ */

/**
 * The switch's visible text is its state; the name is carried invisibly so
 * the accessible name reads "Reduce motion — On" rather than just "On".
 */
function SwitchState({ name, on }) {
  return (
    <>
      <span className="sr-only">{name} — </span>
      {on ? 'On' : 'Off'}
    </>
  )
}

function SettingRow({ title, hint, children }) {
  return (
    <div className="settings-row">
      <div className="settings-row__text">
        <span className="settings-row__title">{title}</span>
        {hint ? <span className="settings-row__hint">{hint}</span> : null}
      </div>
      {children}
    </div>
  )
}

function StatTile({ label, value, sub }) {
  return (
    <div className="tile">
      <span className="micro muted">{label}</span>
      <Metric value={value} sub={sub} size="sm" />
    </div>
  )
}

/**
 * A destructive action behind one deliberate confirm step. Arms on the first
 * click, disarms itself after ten seconds of hesitation, and reports whatever
 * the action threw rather than failing silently.
 */
function ConfirmAction({
  label,
  confirmLabel,
  busyLabel,
  onRun,
  disabled = false,
  disabledHint,
}) {
  const [armed, setArmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const timer = useRef(null)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      if (timer.current) clearTimeout(timer.current)
    }
  }, [])

  const disarm = () => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    setArmed(false)
  }

  const arm = () => {
    setError(null)
    setArmed(true)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      if (alive.current) setArmed(false)
    }, 10000)
  }

  const run = async () => {
    disarm()
    setBusy(true)
    setError(null)
    try {
      await onRun()
      // a successful run usually reloads the page; if it did not, release.
      if (alive.current) setBusy(false)
    } catch (err) {
      if (!alive.current) return
      setBusy(false)
      setError(err && err.message ? err.message : 'that did not work.')
    }
  }

  return (
    <div className="col col--tight" style={{ alignItems: 'flex-end' }}>
      <div className="row" style={{ gap: '8px' }}>
        {armed ? (
          <>
            <Pill className="pill--ghost" onClick={disarm}>
              Cancel
            </Pill>
            <Pill className="pill--danger" onClick={run}>
              {confirmLabel}
            </Pill>
          </>
        ) : (
          <Pill onClick={arm} disabled={disabled || busy}>
            {busy ? busyLabel : label}
          </Pill>
        )}
      </div>
      {armed ? <span className="micro dim">this cannot be undone.</span> : null}
      {disabled && disabledHint ? <span className="micro dim">{disabledHint}</span> : null}
      {error ? <span className="micro hot">{error}</span> : null}
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * view
 * ------------------------------------------------------------------ */

export function Settings({ projects, now }) {
  const clock = useClock(now)
  const { data: cases, status } = useProjects(projects)

  const reducedMotion = useSetting(KEY_REDUCED_MOTION, false)
  const parallax = useSetting(KEY_PARALLAX, true)
  const weekStart = useSetting(KEY_WEEK_START, 1)

  const stats = useMemo(() => globalStats(cases, clock), [cases, clock])
  const caseCount = Array.isArray(cases) ? cases.length : 0
  const unknown = status === 'error'

  const supported = useMemo(() => cacheSupported(), [])

  const weekItems = useMemo(
    () => [
      { value: 1, label: 'Monday' },
      { value: 0, label: 'Sunday' },
    ],
    []
  )

  return (
    <>
      <div className="viewhead">
        <div className="viewhead__left">
          <span className="section-label">Settings</span>
          <span className="micro dim">stored in this browser only</span>
        </div>
        <div className="viewhead__right">
          <span className="micro muted">Case</span>
          <span className="micro dim">v{APP_VERSION}</span>
        </div>
      </div>

      <div className="bento">
        <Card className="span-7">
          <CardHead
            className="card__head"
            title="Interface"
            subtitle="Motion and calendar preferences"
          />
          <div className="card__body">
            <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
              <SettingRow
                title="Reduce motion"
                hint="Overrides the system setting. Kills the parallax, the ambient pulse and every transition."
              >
                <Toggle
                  checked={reducedMotion}
                  onChange={(next) => writeSetting(KEY_REDUCED_MOTION, next)}
                  label={<SwitchState name="Reduce motion" on={reducedMotion} />}
                />
              </SettingRow>

              <SettingRow
                title="Pointer parallax"
                hint={
                  reducedMotion
                    ? 'Held off while reduce motion is on.'
                    : 'The case render tilts toward the pointer while it is over the card.'
                }
              >
                <Toggle
                  checked={parallax && !reducedMotion}
                  disabled={reducedMotion}
                  onChange={(next) => writeSetting(KEY_PARALLAX, next)}
                  label={
                    <SwitchState name="Pointer parallax" on={parallax && !reducedMotion} />
                  }
                />
              </SettingRow>

              <SettingRow
                title="Week starts on"
                hint="Used by the weekly table, the reporting window and the date picker."
              >
                <Segmented
                  items={weekItems}
                  value={weekStart}
                  onChange={(next) => writeSetting(KEY_WEEK_START, next)}
                  label="Week starts on"
                />
              </SettingRow>
            </div>
          </div>
          <div className="card__foot">
            <span>Changes apply immediately.</span>
            <span className="dim">localStorage · casefile.*</span>
          </div>
        </Card>

        <Card className="span-5">
          <CardHead className="card__head" title="This install" subtitle="Read only" />
          <div className="card__body">
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
                gap: '10px',
              }}
            >
              <StatTile label="Version" value={APP_VERSION} sub={BUILD_MODE} />
              <StatTile label="Cases" value={unknown ? '—' : caseCount} sub="open files" />
              <StatTile
                label="Entries"
                value={unknown ? '—' : stats.total}
                sub={unknown ? 'unavailable' : `${stats.subs} sub`}
              />
              <StatTile
                label="Open"
                value={unknown ? '—' : stats.open}
                sub={unknown ? 'unavailable' : `${stats.overdue} overdue`}
              />
            </div>
          </div>
          <div className="card__foot">
            <span>{unknown ? 'Counts unavailable — the server did not answer.' : 'Counts include subtasks.'}</span>
          </div>
        </Card>

        <Card className="span-12">
          <CardHead
            className="card__head"
            title="Maintenance"
            subtitle="Local state only — nothing on the server is touched"
          />
          <div className="card__body">
            <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
              <SettingRow
                title="Clear cached app"
                hint="Unregisters the service worker, empties its caches and reloads. Use it when a build looks stale."
              >
                <ConfirmAction
                  label="Clear cache"
                  confirmLabel="Confirm reset"
                  busyLabel="Clearing…"
                  disabled={!supported}
                  disabledHint="No service worker or Cache API in this browser."
                  onRun={async () => {
                    await purgeAppCache()
                    if (typeof window !== 'undefined') window.location.reload()
                  }}
                />
              </SettingRow>

              <SettingRow
                title="Reset preferences"
                hint="Forgets every setting above and returns to the defaults: motion follows the system, parallax on, week starts Monday."
              >
                <ConfirmAction
                  label="Reset"
                  confirmLabel="Confirm reset"
                  busyLabel="Resetting…"
                  onRun={async () => {
                    clearSettings()
                    applyMotionPreference()
                  }}
                />
              </SettingRow>
            </div>
          </div>
        </Card>
      </div>
    </>
  )
}

export default Settings
