/**
 * ThemeEditor.jsx — the Theme card in Settings, as Linear's theme settings
 * work: a row of ready-made themes, then a custom theme from three inputs —
 * a base colour, an accent colour and a contrast.
 *
 * Every change paints at once (previewTheme), so dragging a colour or the
 * contrast shows the whole app moving with it; the choice is stored a beat
 * after the last change, not on every step of a drag.
 */

import { useEffect, useRef, useState } from 'react'
import { RotateCcw } from 'lucide-react'
import { Card, CardHead } from '../ui/primitives.jsx'
import { KEY_THEME, previewTheme, readTheme, useSetting, writeTheme } from '../lib/settings.js'
import { CONTRAST_MAX, CONTRAST_MIN, THEMES, generateTheme, isLightBase, normalizeHex, normalizeTheme } from '../lib/theme.js'

const cx = (...c) => c.filter(Boolean).join(' ')
const SAVE_MS = 260

/* A theme in miniature: the window, a sidebar of grey lines, the page on
   its panel and an accent button — drawn from the theme's own tokens. */
function Thumb({ theme }) {
  const { vars } = generateTheme(theme)
  const page = `rgb(${vars['--page-rgb']})`
  return (
    <span className="themethumb" style={{ background: vars['--bg'] }} aria-hidden="true">
      <span className="themethumb__side">
        <i style={{ background: vars['--text-faint'] }} />
        <i style={{ background: vars['--text-faint'], width: '60%' }} />
        <i style={{ background: vars['--accent'], width: '45%' }} />
      </span>
      <span className="themethumb__page" style={{ background: page, borderColor: vars['--border'] }}>
        <i style={{ background: vars['--text'], width: '55%' }} />
        <i style={{ background: vars['--text-muted'], width: '80%' }} />
        <i style={{ background: vars['--text-muted'], width: '68%' }} />
        <b style={{ background: vars['--accent'] }} />
      </span>
    </span>
  )
}

/* One colour: the swatch opens the system picker, the hex can be typed or
   pasted. A half-typed hex is left alone until it is a colour. */
function ColorField({ label, value, onChange }) {
  const [draft, setDraft] = useState(value)
  const [typing, setTyping] = useState(false)
  useEffect(() => { if (!typing) setDraft(value) }, [value, typing])
  return (
    <div className="themefield">
      <span className="themefield__label">{label}</span>
      <span className="themefield__box">
        <span className="themefield__swatch" style={{ background: value }}>
          <input
            type="color"
            value={value.toLowerCase()}
            onChange={(e) => onChange(normalizeHex(e.target.value))}
            aria-label={`${label} colour`}
          />
        </span>
        <input
          className="themefield__hex"
          value={draft}
          spellCheck={false}
          maxLength={7}
          aria-label={`${label} colour, as hex`}
          onFocus={() => setTyping(true)}
          onBlur={() => { setTyping(false); setDraft(value) }}
          onChange={(e) => {
            const v = e.target.value.trim()
            setDraft(v)
            const hex = normalizeHex(v)
            if (hex && /^#?[0-9a-f]{6}$/i.test(v)) onChange(hex)
          }}
          onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
        />
      </span>
    </div>
  )
}

export default function ThemeEditor() {
  useSetting(KEY_THEME, '')
  const stored = readTheme()
  const storedKey = JSON.stringify(stored)
  const [theme, setTheme] = useState(stored)
  const pending = useRef(null)

  /* Follow the stored theme (another tab, a reset) unless a change of ours
     is still waiting to be written. */
  useEffect(() => {
    if (!pending.current) setTheme(JSON.parse(storedKey))
  }, [storedKey])

  /* Leaving the page mid-drag still keeps the last colour. */
  useEffect(() => () => {
    if (pending.current) {
      clearTimeout(pending.current.timer)
      writeTheme(pending.current.theme)
      pending.current = null
    }
  }, [])

  const commit = (next, now) => {
    setTheme(next)
    previewTheme(next)
    if (pending.current) clearTimeout(pending.current.timer)
    if (now) {
      pending.current = null
      writeTheme(next)
      return
    }
    const timer = setTimeout(() => {
      pending.current = null
      writeTheme(next)
    }, SAVE_MS)
    pending.current = { timer, theme: next }
  }

  const pick = (id) => commit(normalizeTheme({ preset: id }), true)
  const edit = (patch) => commit(normalizeTheme({ ...theme, ...patch, preset: 'custom' }), false)

  const custom = theme.preset === 'custom'
  const light = isLightBase(theme.base)
  const darks = THEMES.filter((t) => !isLightBase(t.base))
  const lights = THEMES.filter((t) => isLightBase(t.base))

  const tile = (t, label, checked, onClick, key) => (
    <button
      key={key}
      type="button"
      role="radio"
      aria-checked={checked}
      className={cx('themetile', checked && 'is-on')}
      onClick={onClick}
    >
      <Thumb theme={t.preset ? t : { preset: t.id }} />
      <span className="themetile__label">{label}</span>
    </button>
  )

  return (
    <Card className="span-12 themecard">
      <CardHead
        className="card__head"
        title="Theme"
        subtitle="Pick one, or make your own from a base colour, an accent and a contrast"
        right={
          theme.preset !== 'linear' ? (
            <button type="button" className="pill" onClick={() => pick('linear')}>
              <RotateCcw size={13} strokeWidth={1.75} aria-hidden="true" />
              Reset
            </button>
          ) : null
        }
      />
      <div className="card__body themecard__body">
        <div className="themegroup">
          <span className="themegroup__label">Dark</span>
          <div className="themegrid" role="radiogroup" aria-label="Dark themes">
            {darks.map((t) => tile(t, t.label, theme.preset === t.id, () => pick(t.id), t.id))}
          </div>
        </div>
        <div className="themegroup">
          <span className="themegroup__label">Light</span>
          <div className="themegrid" role="radiogroup" aria-label="Light themes">
            {lights.map((t) => tile(t, t.label, theme.preset === t.id, () => pick(t.id), t.id))}
          </div>
        </div>

        <div className={cx('themeedit', custom && 'is-custom')} role="radiogroup" aria-label="Custom theme">
          {tile({ ...theme, preset: 'custom' }, 'Custom', custom, () => edit({}), 'custom')}
          <div className="themeedit__head">
            <span className="themeedit__title">Custom theme</span>
            <span className="themeedit__hint">
              {custom
                ? `A ${light ? 'light' : 'dark'} theme, every grey built from your base.`
                : 'Change any of these to start one from the theme above.'}
            </span>
          </div>
          <div className="themeedit__fields">
            <ColorField label="Base" value={theme.base} onChange={(base) => base && edit({ base })} />
            <ColorField label="Accent" value={theme.accent} onChange={(accent) => accent && edit({ accent })} />
            <div className="themefield themefield--range">
              <span className="themefield__label">Contrast</span>
              <span className="themefield__box">
                <input
                  type="range"
                  min={CONTRAST_MIN}
                  max={CONTRAST_MAX}
                  step={1}
                  value={theme.contrast}
                  onChange={(e) => edit({ contrast: Number(e.target.value) })}
                  aria-label="Contrast"
                  style={{ '--fill': `${((theme.contrast - CONTRAST_MIN) / (CONTRAST_MAX - CONTRAST_MIN)) * 100}%` }}
                />
                <span className="themefield__num">{theme.contrast}</span>
              </span>
            </div>
          </div>
        </div>
      </div>
    </Card>
  )
}
