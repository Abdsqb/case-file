/**
 * theme.js — the app's colours, generated from three numbers, the way
 * Linear's custom themes work.
 *
 *   base      the colour of the window: everything neutral is built from it,
 *             and its lightness decides light or dark
 *   accent    what is selected, primary and done
 *   contrast  30–100: how far apart the greys sit, the text from the ground
 *             and every border from the panel it edges
 *
 * The maths is in OKLCH, where a step in lightness looks like the same step
 * whatever the hue, so a plum base and a grey one come out equally balanced.
 *
 * The result is a set of custom properties stamped on <html> (settings.js
 * does the stamping). Only source values go there — the stylesheet derives
 * the glass, the scrims and the washes from them, so a backdrop or the card
 * setting still changes what it should.
 */

/* ------------------------------------------------------------------ *
 * colour maths — sRGB ⇄ OKLab ⇄ OKLCH
 * ------------------------------------------------------------------ */

const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
const toGamma = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055)

export function parseHex(hex) {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(hex || '').trim())
  if (!m) return null
  let h = m[1]
  if (h.length === 3) h = h.split('').map((c) => c + c).join('')
  const n = parseInt(h, 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

export function normalizeHex(hex) {
  const rgb = parseHex(hex)
  return rgb ? toHex(rgb) : null
}

function toHex(rgb) {
  return '#' + rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('').toUpperCase()
}

function rgbToOklch([r8, g8, b8]) {
  const r = toLinear(r8 / 255)
  const g = toLinear(g8 / 255)
  const b = toLinear(b8 / 255)
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  return { l: L, c: Math.hypot(A, B), h: ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360 }
}

/* Linear-light channels, unclamped: out of 0..1 means out of gamut. */
function oklchToLinear({ l: L, c, h }) {
  const A = c * Math.cos((h * Math.PI) / 180)
  const B = c * Math.sin((h * Math.PI) / 180)
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ]
}

const inGamut = (lin) => lin.every((v) => v >= -0.0005 && v <= 1.0005)

/* Into sRGB, giving up chroma (never lightness or hue) until it fits. */
function oklchToRgb({ l, c, h }) {
  const L = Math.min(1, Math.max(0, l))
  let col = { l: L, c, h }
  if (!inGamut(oklchToLinear(col))) {
    let lo = 0
    let hi = c
    for (let i = 0; i < 20; i++) {
      const mid = (lo + hi) / 2
      if (inGamut(oklchToLinear({ l: L, c: mid, h }))) lo = mid
      else hi = mid
    }
    col = { l: L, c: lo, h }
  }
  return oklchToLinear(col).map((v) => Math.round(toGamma(Math.min(1, Math.max(0, v))) * 255))
}

function luminance([r, g, b]) {
  return 0.2126 * toLinear(r / 255) + 0.7152 * toLinear(g / 255) + 0.0722 * toLinear(b / 255)
}

export function contrastRatio(a, b) {
  const la = luminance(a)
  const lb = luminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

/* ------------------------------------------------------------------ *
 * the themes on offer
 * ------------------------------------------------------------------ */

export const CONTRAST_MIN = 30
export const CONTRAST_MAX = 100

/* `linear` is the stylesheet's own palette: choosing it stamps nothing, so
   the app looks exactly as linear.css writes it. The others are generated. */
export const THEMES = [
  { id: 'linear', label: 'Linear', base: '#08090A', accent: '#6C78E6', contrast: 30 },
  { id: 'midnight', label: 'Midnight', base: '#090B16', accent: '#5E6AD2', contrast: 34 },
  { id: 'graphite', label: 'Graphite', base: '#17181B', accent: '#E6E6E8', contrast: 36 },
  { id: 'forest', label: 'Forest', base: '#0A1210', accent: '#4CB782', contrast: 32 },
  { id: 'ocean', label: 'Ocean', base: '#08131F', accent: '#4EA7FC', contrast: 34 },
  { id: 'plum', label: 'Plum', base: '#130D18', accent: '#BB87FC', contrast: 32 },
  { id: 'ember', label: 'Ember', base: '#140E0B', accent: '#F2994A', contrast: 32 },
  { id: 'contrast', label: 'High contrast', base: '#000000', accent: '#7C88FF', contrast: 100 },
  { id: 'light', label: 'Light', base: '#F4F5F8', accent: '#5E6AD2', contrast: 30 },
  { id: 'paper', label: 'Paper', base: '#F3EFE7', accent: '#C2621C', contrast: 34 },
  { id: 'mint', label: 'Mint', base: '#EEF4F1', accent: '#2E9E6A', contrast: 32 },
]

export const DEFAULT_THEME = { preset: 'linear', base: THEMES[0].base, accent: THEMES[0].accent, contrast: THEMES[0].contrast }

export function themeById(id) {
  return THEMES.find((t) => t.id === id) || null
}

/** Any stored value into a whole theme; anything unreadable is the default. */
export function normalizeTheme(raw) {
  let t = raw
  if (typeof t === 'string') {
    try { t = JSON.parse(t) } catch { t = null }
  }
  if (!t || typeof t !== 'object') return { ...DEFAULT_THEME }
  const preset = t.preset === 'custom' ? 'custom' : themeById(t.preset) ? t.preset : 'linear'
  if (preset !== 'custom') {
    const p = themeById(preset)
    return { preset, base: p.base, accent: p.accent, contrast: p.contrast }
  }
  const contrast = Math.round(Number(t.contrast))
  return {
    preset: 'custom',
    base: normalizeHex(t.base) || DEFAULT_THEME.base,
    accent: normalizeHex(t.accent) || DEFAULT_THEME.accent,
    contrast: Number.isFinite(contrast) ? Math.min(CONTRAST_MAX, Math.max(CONTRAST_MIN, contrast)) : DEFAULT_THEME.contrast,
  }
}

/** Light when the base is: decides the ink, the borders and color-scheme. */
export function isLightBase(base) {
  const rgb = parseHex(base)
  return rgb ? rgbToOklch(rgb).l > 0.6 : false
}

/* ------------------------------------------------------------------ *
 * the generator
 * ------------------------------------------------------------------ */

const lerp = (a, b, t) => a + (b - a) * t
const ch = (rgb) => rgb.join(', ')

/**
 * The custom properties for a theme, as { name: value }, and whether it is
 * light. Calibrated so the Linear preset's base, accent and contrast come
 * out within a step of linear.css's hand-set greys.
 */
export function generateTheme(theme) {
  const t = normalizeTheme(theme)
  const baseRgb = parseHex(t.base)
  const base = rgbToOklch(baseRgb)
  const light = base.l > 0.6
  const k = (t.contrast - CONTRAST_MIN) / (CONTRAST_MAX - CONTRAST_MIN)
  const hue = base.h
  /* The ground keeps the base's colour; the surfaces on it a little less,
     and the ink barely any, so a coloured theme reads as tinted, not dyed. */
  const tint = Math.min(base.c, light ? 0.05 : 0.07)
  const at = (l, cScale = 1) => oklchToRgb({ l, c: tint * cScale, h: hue })

  let surf
  let text
  let ink
  let alpha
  if (!light) {
    /* Each surface a lightness step above the ground: the page, the cards
       on it, then the menus and raised controls over those. More contrast,
       longer steps. */
    const s = lerp(1, 1.6, k)
    const up = (d, c = 0.9) => at(base.l + d * s, c)
    surf = {
      bg: baseRgb,
      page: up(0.03),
      drawer: up(0.014),
      card: up(0.055, 0.85),
      panel: up(0.062, 0.85),
      solid: up(0.075, 0.8),
      solidHi: up(0.11, 0.8),
      overlay: up(0.09, 0.8),
      raised: up(0.105, 0.8),
      raisedHi: up(0.135, 0.8),
    }
    const tc = 0.12
    text = {
      text: at(lerp(0.975, 0.99, k), tc),
      text2: at(lerp(0.875, 0.93, k), tc * 1.4),
      muted: at(lerp(0.655, 0.8, k), tc * 2),
      faint: at(lerp(0.51, 0.66, k), tc * 2),
    }
    ink = [255, 255, 255]
    alpha = {
      elevated: lerp(0.03, 0.045, k),
      border: lerp(0.075, 0.16, k),
      strong: lerp(0.13, 0.24, k),
      soft: lerp(0.05, 0.1, k),
      hover: lerp(0.045, 0.07, k),
      selected: lerp(0.075, 0.11, k),
    }
  } else {
    /* Light: the page and the cards are the base lifted toward white, and
       depth is the border's job, as Linear's light theme does it. */
    const toward = (f, c = 0.6) => at(base.l + (1 - base.l) * f, c)
    surf = {
      bg: baseRgb,
      page: toward(0.72, 0.5),
      drawer: toward(0.25, 0.9),
      card: toward(0.9, 0.35),
      panel: toward(0.9, 0.35),
      solid: toward(0.9, 0.35),
      solidHi: at(base.l + (1 - base.l) * 0.9 - 0.02, 0.4),
      overlay: toward(1, 0),
      raised: at(base.l + (1 - base.l) * 0.9 - 0.025, 0.45),
      raisedHi: at(base.l + (1 - base.l) * 0.9 - 0.045, 0.5),
    }
    const tc = 0.35
    text = {
      text: at(lerp(0.22, 0.14, k), tc),
      text2: at(lerp(0.34, 0.24, k), tc),
      muted: at(lerp(0.52, 0.4, k), tc),
      faint: at(lerp(0.65, 0.52, k), tc),
    }
    ink = at(lerp(0.2, 0.1, k), tc)
    alpha = {
      elevated: lerp(0.025, 0.04, k),
      border: lerp(0.1, 0.2, k),
      strong: lerp(0.17, 0.3, k),
      soft: lerp(0.065, 0.12, k),
      hover: lerp(0.045, 0.07, k),
      selected: lerp(0.075, 0.11, k),
    }
  }

  /* The accent: as given, a step brighter (darker on light) on hover, and
     whichever of white or near-black reads on a fill of it. */
  const accRgb = parseHex(t.accent)
  const acc = rgbToOklch(accRgb)
  const hoverRgb = oklchToRgb({ l: acc.l + (light ? -0.05 : 0.05), c: acc.c, h: acc.h })
  const coolRgb = oklchToRgb({ l: light ? acc.l : Math.max(acc.l, 0.72), c: Math.max(acc.c, 0.08), h: (acc.h + 330) % 360 })
  const dark = [11, 11, 13]
  const accentInk = contrastRatio([255, 255, 255], accRgb) >= 3 || contrastRatio([255, 255, 255], accRgb) >= contrastRatio(dark, accRgb)
    ? '#FFFFFF'
    : toHex(dark)

  const a = (v) => `rgba(${ch(ink)}, ${v.toFixed(3)})`
  return {
    light,
    vars: {
      '--bg': toHex(surf.bg),
      '--bg-rgb': ch(surf.bg),
      '--page-rgb': ch(surf.page),
      '--drawer': toHex(surf.drawer),
      '--card-rgb': ch(surf.card),
      '--panel-rgb': ch(surf.panel),
      '--solid-rgb': ch(surf.solid),
      '--solid-hi-rgb': ch(surf.solidHi),
      '--overlay-rgb': ch(surf.overlay),
      '--raised-rgb': ch(surf.raised),
      '--raised-hi-rgb': ch(surf.raisedHi),

      '--text': toHex(text.text),
      '--text-rgb': ch(text.text),
      '--text-2': toHex(text.text2),
      '--text-muted': toHex(text.muted),
      '--text-faint': toHex(text.faint),

      '--ink-rgb': ch(ink),
      '--bg-elevated': a(alpha.elevated),
      '--border': a(alpha.border),
      '--border-strong': a(alpha.strong),
      '--line-soft': a(alpha.soft),
      '--hover': a(alpha.hover),
      '--selected': a(alpha.selected),
      '--sunken': light ? a(0.035) : 'rgba(0, 0, 0, 0.18)',
      '--bar': `rgba(${ch(text.text)}, 0.82)`,

      '--accent': toHex(accRgb),
      '--accent-hover': toHex(hoverRgb),
      '--accent-ink': accentInk,
      '--accent-rgb': ch(accRgb),
      '--accent-cool': toHex(coolRgb),
    },
  }
}

/** Every property generateTheme can set, so a reset can take them all off. */
export const THEME_VARS = Object.keys(generateTheme(DEFAULT_THEME).vars)
