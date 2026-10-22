/**
 * Settings.jsx — the app's preference surface.
 *
 * Every control writes through lib/settings.js, which owns the storage, the
 * `casefile:settings` event and the stamps on <html>; this file is only the
 * view. Its old exports are re-exported, so `from '../views/Settings.jsx'`
 * still works, but anything outside this view should import the store from
 * lib/settings.js so it does not drag the view into the first bundle.
 */

import {
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { Card, CardHead, Metric, Pill, PillSelect, Toggle } from '../ui/primitives.jsx'
import { getMemory, listProjects } from '../lib/api.js'
import * as clerk from '../lib/clerk.js'
import { globalStats } from '../lib/metrics.js'
import { BACKDROPS, DEFAULT_BACKDROP, paintStill, readColours } from '../ui/backdrops.js'
import {
  ACCENTS,
  BLURS,
  DEFAULT_ACCENT,
  DEFAULT_BLUR,
  DEFAULT_POINTER,
  KEY_ACCENT,
  KEY_BACKDROP,
  KEY_BACKDROP_BLUR,
  KEY_PARALLAX,
  KEY_POINTER,
  KEY_REDUCED_MOTION,
  KEY_WEEK_START,
  POINTERS,
  applyAccentPreference,
  applyMotionPreference,
  applyPreferences,
  clearSettings,
  readAccent,
  readBackdrop,
  readBackdropBlur,
  readSetting,
  useSetting,
  writeSetting,
} from '../lib/settings.js'

export * from '../lib/settings.js'

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
 * memory
 * ------------------------------------------------------------------ */

const MEMORY_POLL_MS = 5000

/** Bytes as { value, unit } for a Metric: KB under a megabyte, GB over a gigabyte. */
function sizeOf(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return { value: '—', unit: null }
  const KB = 1024
  const MB = KB * 1024
  const GB = MB * 1024
  if (bytes >= GB) return { value: (bytes / GB).toFixed(1), unit: 'GB' }
  if (bytes >= MB) return { value: (bytes / MB).toFixed(bytes < 10 * MB ? 1 : 0), unit: 'MB' }
  return { value: Math.max(1, Math.round(bytes / KB)), unit: 'KB' }
}

function sizeText(bytes) {
  const s = sizeOf(bytes)
  return s.unit ? `${s.value} ${s.unit}` : s.value
}

/**
 * The tab's JavaScript heap, where the browser will say. Chromium only —
 * `performance.memory` is non-standard, and the standard replacement needs a
 * cross-origin-isolated page, which this one is not. Null everywhere else,
 * and the panel says so rather than showing a zero.
 */
function readTabHeap() {
  try {
    const m = typeof performance !== 'undefined' ? performance.memory : null
    return m && Number.isFinite(m.usedJSHeapSize) ? m.usedJSHeapSize : null
  } catch {
    return null
  }
}

/**
 * Both halves of the reading, refreshed every few seconds while Settings is
 * open and the tab is in front. A hidden tab is not looked at, and polling it
 * would be the panel adding to the number it reports.
 */
function useMemoryReading() {
  const [reading, setReading] = useState({ server: null, tab: readTabHeap(), status: 'loading' })

  useEffect(() => {
    let alive = true
    let timer = null
    // One chain of polls, ever: coming back to the tab mid-request must not
    // start a second one alongside it.
    let inFlight = false

    const tick = () => {
      if (timer) clearTimeout(timer)
      timer = null
      if (inFlight || (typeof document !== 'undefined' && document.hidden)) return
      inFlight = true
      getMemory()
        .then((server) => {
          if (alive) setReading({ server, tab: readTabHeap(), status: 'ready' })
        })
        .catch(() => {
          if (alive) setReading((r) => ({ ...r, tab: readTabHeap(), status: 'error' }))
        })
        .finally(() => {
          inFlight = false
          if (alive) timer = setTimeout(tick, MEMORY_POLL_MS)
        })
    }

    const onVisible = () => {
      if (!document.hidden) tick()
    }

    tick()
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      alive = false
      if (timer) clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [])

  return reading
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

/**
 * One swatch per accent, as a radio group: arrows move the choice, the way a
 * native radio set does, and each swatch is named for a screen reader since
 * its only visible content is the colour.
 */
function AccentPicker({ value, onChange }) {
  const refs = useRef([])
  const index = Math.max(0, ACCENTS.findIndex((a) => a.id === value))

  const onKeyDown = (e) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key]
    if (!step) return
    e.preventDefault()
    const next = (index + step + ACCENTS.length) % ACCENTS.length
    onChange(ACCENTS[next].id)
    refs.current[next]?.focus()
  }

  return (
    <div className="accent-picker" role="radiogroup" aria-label="Accent colour" onKeyDown={onKeyDown}>
      {ACCENTS.map((a, i) => (
        <button
          key={a.id}
          ref={(el) => { refs.current[i] = el }}
          type="button"
          role="radio"
          className="accent-swatch"
          data-accent={a.id}
          aria-checked={i === index}
          aria-label={a.label}
          title={a.label}
          tabIndex={i === index ? 0 : -1}
          onClick={() => onChange(a.id)}
        />
      ))}
    </div>
  )
}

/**
 * One live miniature per backdrop, as a radio group. Each is the real shape
 * painted small in the current accent, held still until the pointer rests on
 * it — then it plays, so you can see how it moves before you pick it.
 */
function BackdropPicker({ value, accent, reduced, blur, onChange }) {
  const refs = useRef([])
  const index = Math.max(0, BACKDROPS.findIndex((b) => b.id === value))

  const onKeyDown = (e) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key]
    if (!step) return
    e.preventDefault()
    const next = (index + step + BACKDROPS.length) % BACKDROPS.length
    onChange(BACKDROPS[next].id)
    refs.current[next]?.focus()
  }

  return (
    <div className="backdrop-grid" role="radiogroup" aria-label="Background" onKeyDown={onKeyDown}>
      {BACKDROPS.map((b, i) => (
        <BackdropTile
          key={b.id}
          backdrop={b}
          accent={accent}
          reduced={reduced}
          blur={blur}
          checked={i === index}
          buttonRef={(el) => { refs.current[i] = el }}
          onPick={() => onChange(b.id)}
        />
      ))}
    </div>
  )
}

const PREVIEW_W = 320
const PREVIEW_H = 180

/* The resting miniatures. Painting all eleven in the frame Settings opened in
   was a 200ms hitch, and even spread out the painting is most of what makes
   opening Settings stutter: each still is a hundred-odd glowing curves in
   Canvas 2D, and the GPU pays for every one. So a still is painted once, ever:
   kept for the session as a bitmap, and saved in IndexedDB so the next load
   shows the picture instead of drawing it. A saved still carries a mark of
   the code and colours that drew it, so a changed design or accent paints
   fresh rather than showing a stale picture. When one does need painting, it
   is a few at a time, at most ~6ms a frame. Measured on opening Settings from
   a fresh load: ~780ms spent in slow frames when painting, ~350ms without. */
const stills = new Map()
const stillQueue = []
let stillPumping = false

function pumpStills() {
  const start = performance.now()
  while (stillQueue.length && performance.now() - start < 6) stillQueue.shift()()
  if (stillQueue.length) requestAnimationFrame(pumpStills)
  else stillPumping = false
}

/** FNV-1a, as hex: a short mark that changes when its input does. */
function fingerprint(text) {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16)
}

const codeMarks = new WeakMap()
/** What would change a still's picture in the code: the painter and the design. */
function codeMark(backdrop) {
  let mark = codeMarks.get(backdrop)
  if (mark === undefined) {
    mark = fingerprint(String(paintStill) + String(backdrop.shape) + String(backdrop.preview) + JSON.stringify(backdrop))
    codeMarks.set(backdrop, mark)
  }
  return mark
}

/* Read once per accent: the tokens do not change while the page is open, and
   reading them is a style lookup per tile otherwise. */
const accentColours = new Map()
function coloursFor(accent) {
  let colours = accentColours.get(accent)
  if (!colours) {
    colours = readColours()
    accentColours.set(accent, colours)
  }
  return colours
}

/* One record per backdrop and pixel ratio, { mark, blob }: a new accent or a
   new build overwrites it rather than piling up beside it. Any failure here
   (private mode, storage off, quota) just means painting, as before. */
let stillDb = null
const storedMarks = new Map() // slot → the mark the store holds, as far as this page knows
function openStills() {
  if (!stillDb) {
    stillDb = new Promise((resolve) => {
      try {
        const req = indexedDB.open('casefile-stills', 1)
        req.onupgradeneeded = () => req.result.createObjectStore('stills')
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => resolve(null)
        req.onblocked = () => resolve(null)
      } catch {
        resolve(null)
      }
    })
  }
  return stillDb
}
function loadSaved(slot) {
  return openStills().then((db) => db && new Promise((resolve) => {
    try {
      const req = db.transaction('stills').objectStore('stills').get(slot)
      req.onsuccess = () => resolve(req.result || null)
      req.onerror = () => resolve(null)
    } catch {
      resolve(null)
    }
  }))
}
function save(slot, record) {
  openStills().then((db) => {
    try {
      db?.transaction('stills', 'readwrite').objectStore('stills').put(record, slot)
    } catch {
      /* not kept; it will be painted again next time */
    }
  })
}

/** Show a backdrop's still on the canvas; returns a cancel for the effect. */
function showStill(canvas, backdrop, accent, size) {
  const ratio = window.devicePixelRatio || 1
  const key = `${backdrop.id}|${accent}|${ratio}`
  const put = (image) => {
    canvas.width = image.width
    canvas.height = image.height
    canvas.getContext('2d')?.drawImage(image, 0, 0)
  }
  const colours = coloursFor(accent)
  const mark = fingerprint(`${codeMark(backdrop)}|${JSON.stringify(colours)}|${size.width}x${size.height}`)
  const slot = `${backdrop.id}|${ratio}`

  const kept = stills.get(key)
  if (kept) {
    put(kept)
    // Back on an accent seen earlier this session: the store may still hold
    // the other one, so the next load would paint for nothing. Save this one.
    if (storedMarks.get(slot) !== mark) {
      storedMarks.set(slot, mark)
      canvas.toBlob((blob) => { if (blob) save(slot, { mark, blob }) })
    }
    return undefined
  }

  let live = true

  const paint = () => {
    stillQueue.push(() => {
      if (!live) return
      paintStill(canvas, backdrop, colours, size)
      createImageBitmap(canvas).then((bitmap) => stills.set(key, bitmap)).catch(() => {})
      storedMarks.set(slot, mark)
      canvas.toBlob((blob) => { if (blob) save(slot, { mark, blob }) })
    })
    if (!stillPumping) {
      stillPumping = true
      requestAnimationFrame(pumpStills)
    }
  }

  loadSaved(slot)
    .then((saved) => (saved && saved.mark === mark && saved.blob ? createImageBitmap(saved.blob) : null))
    .catch(() => null)
    .then((bitmap) => {
      if (bitmap) {
        stills.set(key, bitmap)
        storedMarks.set(slot, mark)
        if (live) put(bitmap)
      } else if (live) {
        paint()
      }
    })
  return () => { live = false }
}

function BackdropTile({ backdrop, accent, reduced, blur, checked, buttonRef, onPick }) {
  const canvasRef = useRef(null)
  const [playing, setPlaying] = useState(false)

  /* The accent lands on <html> before this re-renders, so reading the tokens
     here picks up the new colour. */
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return undefined
    const size = { width: PREVIEW_W, height: PREVIEW_H }
    if (!playing || reduced || backdrop.off) return showStill(canvas, backdrop, accent, size)
    const colours = readColours()
    let raf = 0
    let last = 0
    const t0 = performance.now()
    const tick = (now) => {
      raf = requestAnimationFrame(tick)
      if (now - last < 33) return
      last = now
      // The same clock Streak runs on: one undulation every fifteen seconds,
      // and the light pouring in over the first few, as it does on the dashboard.
      const secs = (now - t0) / 1000
      const reveal = 0.5 - 0.5 * Math.cos(Math.PI * Math.min(1, secs / 3.8))
      paintStill(canvas, backdrop, colours, { ...size, time: 2.1 + (secs / 15) * Math.PI * 2, secs, reveal })
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [backdrop, accent, playing, reduced])

  return (
    <button
      ref={buttonRef}
      type="button"
      role="radio"
      aria-checked={checked}
      tabIndex={checked ? 0 : -1}
      className="backdrop-tile"
      onClick={onPick}
      onPointerEnter={() => setPlaying(true)}
      onPointerLeave={() => setPlaying(false)}
      onFocus={() => setPlaying(true)}
      onBlur={() => setPlaying(false)}
    >
      <span className="backdrop-tile__view">
        <canvas
          ref={canvasRef}
          className="backdrop-tile__canvas"
          aria-hidden="true"
          // The swatch is about a fifth of the window, so a fifth of the blur
          // gives it the same look.
          style={blur ? { filter: `blur(${(blur * 0.25).toFixed(2)}px)` } : undefined}
        />
        {backdrop.off ? <span className="backdrop-tile__off" aria-hidden="true">off</span> : null}
      </span>
      <span className="backdrop-tile__text">
        <span className="backdrop-tile__name">{backdrop.name}</span>
        <span className="backdrop-tile__line">{backdrop.line}</span>
      </span>
    </button>
  )
}

function StatTile({ label, value, unit, sub }) {
  return (
    <div className="tile">
      <span className="micro muted">{label}</span>
      <Metric value={value} unit={unit} sub={sub} size="sm" />
    </div>
  )
}

/** Seconds as '42s', '17m', '3h 05m', '2d 4h'. */
function uptimeText(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ${String(m % 60).padStart(2, '0')}m`
  return `${Math.floor(h / 24)}d ${h % 24}h`
}

/**
 * What Case File is using on this computer, live. Two processes make up the
 * app — the server and this browser tab — and each is measured by the only
 * party that can see it: the server reports itself, the page reports itself.
 */
function MemoryCard() {
  const { server, tab, status } = useMemoryReading()
  const down = status === 'error' && !server

  const rss = server?.server?.rss
  const db = server?.database?.bytes
  const total = server?.machine?.total
  const free = server?.machine?.free
  const together = Number.isFinite(rss) ? rss + (Number.isFinite(tab) ? tab : 0) : null
  const share = together !== null && total > 0 ? (together / total) * 100 : null

  const serverSize = sizeOf(rss)
  const tabSize = sizeOf(tab)
  const togetherSize = sizeOf(together)
  const dbSize = sizeOf(db)

  return (
    <Card className="span-12">
      <CardHead
        className="card__head"
        title="Memory"
        subtitle={status === 'loading' ? 'Measuring…' : down ? 'The server did not answer' : 'Live, while this screen is open'}
      />
      <div className="card__body">
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
            gap: '10px',
          }}
        >
          <StatTile
            label="Server"
            value={serverSize.value}
            unit={serverSize.unit}
            sub={server ? `node · up ${uptimeText(server.server.uptime)}` : 'unavailable'}
          />
          <StatTile
            label="This tab"
            value={tabSize.value}
            unit={tabSize.unit}
            sub={Number.isFinite(tab) ? 'JavaScript heap' : 'not reported by this browser'}
          />
          <StatTile
            label="Together"
            value={togetherSize.value}
            unit={togetherSize.unit}
            sub={share === null ? 'unavailable' : `${share < 0.1 ? '<0.1' : share.toFixed(1)}% of RAM`}
          />
          <StatTile
            label="Database"
            value={dbSize.value}
            unit={dbSize.unit}
            sub="on disk, not in RAM"
          />
        </div>
        <p className="settings-row__hint" style={{ maxWidth: '72ch', marginBottom: 0 }}>
          The server figure is everything its process holds, the same number Task Manager
          shows for node. The tab figure is only the page&rsquo;s own JavaScript; the
          browser&rsquo;s share of drawing it is on top, and its Task Manager
          (Shift+Esc in Chrome) shows the whole tab.
        </p>
      </div>
      <div className="card__foot">
        <span>
          {Number.isFinite(total)
            ? `${sizeText(total)} of RAM on this computer, ${sizeText(free)} free.`
            : 'Machine totals unavailable.'}
        </span>
        <span className="dim">every {MEMORY_POLL_MS / 1000}s</span>
      </div>
    </Card>
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
  const accent = useSetting(KEY_ACCENT, DEFAULT_ACCENT)
  const backdrop = useSetting(KEY_BACKDROP, DEFAULT_BACKDROP)
  useSetting(KEY_BACKDROP_BLUR, '')
  const blur = readBackdropBlur()
  const pointer = useSetting(KEY_POINTER, DEFAULT_POINTER)

  const stats = useMemo(() => globalStats(cases, clock), [cases, clock])
  /* Asked once. The answer is a function of .env, which cannot change without
     a server restart, so there is nothing to poll for. */
  const [clerkState, setClerkState] = useState(null)
  useEffect(() => {
    let alive = true
    clerk.status().then((st) => { if (alive) setClerkState(st) })
    return () => { alive = false }
  }, [])

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
            subtitle="Colour, motion and calendar preferences"
          />
          <div className="card__body">
            <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
              <SettingRow
                title="Accent colour"
                hint="Buttons, the active tab, finished work and the light behind the dashboard."
              >
                <AccentPicker
                  value={accent}
                  onChange={(next) => writeSetting(KEY_ACCENT, next === DEFAULT_ACCENT ? null : next)}
                />
              </SettingRow>

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
                title="Pointer"
                hint="A soft disc that wraps round buttons and turns into a caret over text, or the system arrow."
              >
                <PillSelect
                  className="island-select"
                  align="end"
                  options={POINTERS}
                  value={pointer === 'system' ? 'system' : DEFAULT_POINTER}
                  onChange={(next) => writeSetting(KEY_POINTER, next === DEFAULT_POINTER ? null : next)}
                  label="Pointer"
                />
              </SettingRow>

              <SettingRow
                title="Week starts on"
                hint="Used by the weekly table, the reporting window and the date picker."
              >
                <PillSelect
                  className="island-select"
                  align="end"
                  options={weekItems}
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
            title="Background"
            subtitle="The light behind the glass. Rest the pointer on one to see it move."
          />
          <div className="card__body">
            <BackdropPicker
              value={backdrop}
              accent={accent}
              reduced={reducedMotion}
              blur={blur}
              onChange={(next) => writeSetting(KEY_BACKDROP, next === DEFAULT_BACKDROP ? null : next)}
            />
            <SettingRow
              title="Diffusion"
              hint="A blur laid over the background. Crisp draws every line sharp; Smoke melts it into a soft glow."
            >
              <PillSelect
                className="island-select"
                align="end"
                options={BLURS}
                value={blur}
                onChange={(next) => writeSetting(KEY_BACKDROP_BLUR, next === DEFAULT_BLUR ? null : next)}
                label="Background diffusion"
              />
            </SettingRow>
          </div>
          <div className="card__foot">
            <span>Drawn in your accent colour. Reduce motion holds it still.</span>
            <span className="dim">casefile.backdrop · casefile.backdropBlur</span>
          </div>
        </Card>

        <MemoryCard />

        {/* ---------------------------------------------------------------
            The clerk, and what it costs you in privacy.

            This is the only feature in the app that sends anything anywhere,
            so it gets a panel that says so in the plainest terms available —
            what is sent, to whom, and when. It is read-only on purpose: the
            switch for this is the API key in .env, which cannot be flipped by
            accident from a settings screen, and which is the honest place for
            it because the key is what actually makes the calls possible.
            ---------------------------------------------------------------- */}
        <Card className="span-12">
          <CardHead
            className="card__head"
            title="The clerk"
            subtitle={clerkState === null
              ? 'Checking…'
              : clerkState.ready
                ? 'On duty'
                : 'Off — no API key configured'}
          />
          <div className="card__body">
            <p className="settings-row__hint" style={{ maxWidth: '72ch', marginTop: 0 }}>
              Everything else in Case File runs on this machine against a local
              database. The clerk does not. When you ask it something or file the
              pad, the text involved is sent to whichever provider is
              configured below, together with your case names, the entries in them
              and the courses on your timetable. Nothing is sent at any other time —
              there is no background call, no analytics and no sync. Turn it off by
              removing the key and restarting.
            </p>

            <div className="fc-providers">
              {(clerkState?.providers || []).map((pr) => (
                <div key={pr.id} className={`fc-provider${pr.configured ? ' is-on' : ''}`}>
                  <span className="status-dot" aria-hidden="true" />
                  <span className="fc-provider__name">{pr.label}</span>
                  <span className="fc-provider__env mono">{pr.env}</span>
                  <span className="fc-provider__state">{pr.configured ? 'configured' : 'not set'}</span>
                </div>
              ))}
            </div>

            {clerkState?.ready ? (
              <div className="fc-routing">
                <SettingRow
                  title="Filing"
                  hint="The long jobs — a syllabus plus your whole archive in one call. Routed to the biggest context window available."
                >
                  <span className="mono dim">
                    {clerkState.routing?.deep
                      ? `${clerkState.routing.deep.label} · ${clerkState.routing.deep.model}`
                      : '—'}
                  </span>
                </SettingRow>
                <SettingRow
                  title="The brief and the chat"
                  hint="The interactive ones, where speed is most of the experience. Routed to the fastest provider you have a key for."
                >
                  <span className="mono dim">
                    {clerkState.routing?.fast
                      ? `${clerkState.routing.fast.label} · ${clerkState.routing.fast.model}`
                      : '—'}
                  </span>
                </SettingRow>
              </div>
            ) : clerkState ? (
              <p className="settings-row__hint" style={{ maxWidth: '72ch' }}>
                Add <span className="mono">GEMINI_API_KEY</span> or{' '}
                <span className="mono">GROQ_API_KEY</span> to <span className="mono">.env</span>{' '}
                and restart the server. Both have a free tier. Set{' '}
                <span className="mono">CLERK_PROVIDER</span> to pin every job to one of them.
              </p>
            ) : null}
          </div>
          <div className="card__foot">
            <span>{clerkState?.ready
              ? 'Keys are read on the server and never sent to this page.'
              : 'With no key, the clerk never appears anywhere in the app.'}</span>
            <span className="dim">.env</span>
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
                hint="Forgets every setting above and returns to the defaults: violet accent, motion follows the system, parallax on, the soft pointer, week starts Monday."
              >
                <ConfirmAction
                  label="Reset"
                  confirmLabel="Confirm reset"
                  busyLabel="Resetting…"
                  onRun={async () => {
                    clearSettings()
                    applyPreferences()
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
