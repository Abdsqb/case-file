/**
 * StudyPlan — Calendar's third tab: the degree, term by term.
 *
 * The plan is one JSON document kept in the database (it holds grades, and
 * the bundle is public). It is typed in here: Edit turns the cards into forms,
 * each change is saved a moment after the last keystroke, and every total is
 * worked out from the courses rather than typed — credits, the GPA, and which
 * requirements are met.
 *
 *   Degree progress — credits against the total, the GPA, when it ends
 *   Requirements    — groups of requirements, met by the courses marked as
 *                     counting toward them (or ticked "met" another way)
 *   Terms           — every semester side by side, past ones with grades
 *   Older plans may also carry registration, backups and open questions;
 *   those are shown when present.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { Card, CardHead, EmptyState, IconMenu, MenuButton, Meter, Metric, Pill, PillSelect, Segmented } from '../ui/primitives.jsx'
import { clearStudyPlan, getStudyPlan, saveStudyPlan } from '../lib/api.js'

function cx(...parts) {
  return parts.filter(Boolean).join(' ')
}

const uid = () => Math.random().toString(36).slice(2, 9)

const DAY_MS = 86400000
const SAVE_AFTER_MS = 600
const WEEK = [
  { day: 1, label: 'Mon' },
  { day: 2, label: 'Tue' },
  { day: 3, label: 'Wed' },
  { day: 4, label: 'Thu' },
  { day: 5, label: 'Fri' },
]

/* NYU's scale. P, W and I carry no grade points. */
const POINTS = { A: 4, 'A-': 3.667, 'B+': 3.333, B: 3, 'B-': 2.667, 'C+': 2.333, C: 2, 'C-': 1.667, 'D+': 1.333, D: 1, F: 0 }
const GRADE_OPTIONS = [{ value: 'none', label: '—' }, ...['A', 'A-', 'B+', 'B', 'B-', 'C+', 'C', 'C-', 'D+', 'D', 'F', 'P', 'W', 'I'].map((g) => ({ value: g, label: g }))]
const EARNS_NOTHING = new Set(['F', 'W', 'I'])
const STATUS_OPTIONS = [
  { value: 'done', label: 'Done' },
  { value: 'current', label: 'Now' },
  { value: 'planned', label: 'Planned' },
]
const PHASE = { done: 'done', current: 'now', planned: 'planned' }
const phaseOf = (t) => PHASE[t.status] || 'planned'

/* A grade's colour: the As lit, the Cs warm, the Ds and Fs hot. */
const gradeBand = (g) => (/^A/.test(g) ? 'is-a' : /^C/.test(g) ? 'is-c' : /^[DF]/.test(g) ? 'is-d' : null)

/* Credits a course earns: a withdrawal, a fail or an incomplete earns none. */
const creditOf = (c) => (c.noCredit || EARNS_NOTHING.has(c.grade) ? 0 : Number(c.cr) || 0)
const requiredOf = (plan) => Number(plan.credits?.required) || 128
const toNum = (v) => (v === '' ? '' : Math.max(0, Number(v) || 0))

/* --------------------------------------------------------------------------
   the plan as data
   -------------------------------------------------------------------------- */

function blankPlan() {
  return {
    version: 2,
    student: { program: '', home: '', minor: '', graduation: '', standing: '' },
    credits: { required: 128 },
    requirements: [
      { id: uid(), group: 'Core', items: [] },
      { id: uid(), group: 'Major', items: [] },
      { id: uid(), group: 'Minor', items: [] },
      { id: uid(), group: 'General electives', credits: '', items: [] },
    ],
    terms: [],
  }
}

/* Every term, course, group and requirement gets an id, and every course a
   list of what it counts toward, so the editor can address them. */
function normalize(plan) {
  return {
    ...plan,
    student: { ...(plan.student || {}) },
    credits: { required: 128, ...(plan.credits || {}) },
    requirements: (plan.requirements || []).map((g) => ({
      ...g,
      id: g.id || uid(),
      group: g.group ?? '',
      items: (g.items || []).map((it) => ({ ...it, id: it.id || uid(), name: it.name ?? '' })),
    })),
    terms: (plan.terms || []).map((t) => ({
      ...t,
      id: t.id || uid(),
      label: t.label ?? '',
      campus: t.campus ?? '',
      status: t.status || 'planned',
      courses: (t.courses || []).map((c) => ({ ...c, id: c.id || uid(), reqs: Array.isArray(c.reqs) ? c.reqs : [] })),
    })),
  }
}

/* Drop links to requirements that no longer exist. */
function unlink(plan, ids) {
  for (const t of plan.terms) for (const c of t.courses) c.reqs = c.reqs.filter((id) => !ids.has(id))
}

/* "Fall 2026" → "Spring 2027" → "Fall 2027". */
function nextLabel(prev, nowTs) {
  const m = /^(fall|spring|summer)\s+(\d{4})$/i.exec((prev || '').trim())
  if (!m) {
    const d = new Date(nowTs)
    return d.getMonth() >= 6 ? `Fall ${d.getFullYear()}` : `Spring ${d.getFullYear()}`
  }
  const y = Number(m[2])
  return m[1].toLowerCase() === 'fall' ? `Spring ${y + 1}` : `Fall ${y}`
}

/* Everything that is counted rather than typed. */
function tallyOf(plan) {
  const credits = { done: 0, now: 0, planned: 0 }
  let points = 0
  let graded = 0
  const slots = new Map()
  const groupOf = new Map()
  for (const g of plan.requirements) {
    groupOf.set(g.id, g.id)
    for (const it of g.items) groupOf.set(it.id, g.id)
  }
  const groupCr = new Map()
  const termCr = new Map()

  for (const t of plan.terms) {
    const ph = phaseOf(t)
    let sum = 0
    for (const c of t.courses) {
      const cr = creditOf(c)
      sum += cr
      credits[ph] += cr
      if (ph === 'done' && !c.noCredit && c.grade in POINTS) {
        points += POINTS[c.grade] * (Number(c.cr) || 0)
        graded += Number(c.cr) || 0
      }
      if (!cr) continue
      const groups = new Set()
      for (const id of c.reqs || []) {
        if (!groupOf.has(id)) continue
        let s = slots.get(id)
        if (!s) slots.set(id, (s = { done: 0, now: 0, planned: 0, courses: [] }))
        s[ph] += 1
        s.courses.push({ c, t, ph })
        groups.add(groupOf.get(id))
      }
      for (const gid of groups) {
        const g = groupCr.get(gid) || { done: 0, now: 0, planned: 0 }
        g[ph] += cr
        groupCr.set(gid, g)
      }
    }
    termCr.set(t.id, sum)
  }

  const items = new Map()
  const groups = new Map()
  let met = 0
  let all = 0
  for (const g of plan.requirements) {
    let gMet = 0
    for (const it of g.items) {
      const st = itemState(it, slots.get(it.id))
      items.set(it.id, st)
      if (st.status === 'done') gMet += 1
    }
    const cr = groupCr.get(g.id) || { done: 0, now: 0, planned: 0 }
    const target = Number(g.credits) || 0
    let crStatus = null
    if (target) {
      crStatus = cr.done >= target ? 'done' : cr.done + cr.now >= target ? 'progress'
        : cr.done + cr.now + cr.planned >= target ? 'planned' : 'todo'
      all += 1
      if (crStatus === 'done') met += 1
    }
    groups.set(g.id, { met: gMet, all: g.items.length, cr, target, crStatus })
    met += gMet
    all += g.items.length
  }

  return {
    credits,
    total: credits.done + credits.now + credits.planned,
    gpa: graded ? points / graded : null,
    graded,
    items,
    groups,
    met,
    all,
    termCr,
  }
}

function itemState(it, s) {
  const need = Math.max(1, Math.round(Number(it.need)) || 1)
  const d = s?.done || 0
  const n = s?.now || 0
  const p = s?.planned || 0
  let status = 'todo'
  if (it.met || d >= need) status = 'done'
  else if (d + n >= need) status = 'progress'
  else if (d + n + p >= need) status = 'planned'
  return { status, need, have: it.met ? need : Math.min(need, d + n + p), courses: s?.courses || [] }
}

/* "CSCI-SHU 210 · CSCI-UA 202 now · CSCI-SHU 420 Fall 2027" */
function byText(courses) {
  return courses
    .map(({ c, t, ph }) => {
      const name = c.code || c.title || 'a course'
      if (ph === 'done') return name
      if (ph === 'now') return `${name} now`
      return `${name} ${t.label}`.trim()
    })
    .join(' · ')
}

const STATUS_LABEL = { done: 'done', progress: 'in progress', planned: 'planned', todo: 'not planned' }

function Mark({ status }) {
  return <span className={cx('sp-mark', `sp-mark--${status}`)} aria-hidden="true" />
}

const minutes = (hhmm) => {
  const [h, m] = String(hhmm).split(':').map(Number)
  return h * 60 + (m || 0)
}

function clock(min) {
  const h = Math.floor(min / 60)
  const m = min % 60
  const h12 = ((h + 11) % 12) + 1
  return m ? `${h12}:${String(m).padStart(2, '0')}` : `${h12}`
}

/* "today", "tomorrow", "in 6 days", "nov 23" — relative while it is close. */
function whenOf(iso, nowTs) {
  if (!iso) return { text: 'appt', tone: 'idle' }
  const [y, mo, d] = iso.split('-').map(Number)
  const at = new Date(y, mo - 1, d).getTime()
  const today = new Date(nowTs)
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()
  const days = Math.round((at - start) / DAY_MS)
  const label = new Date(at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }).toLowerCase()
  if (days < 0) return { text: label, sub: 'open now', tone: 'ok' }
  if (days === 0) return { text: 'today', sub: label, tone: 'ok' }
  if (days === 1) return { text: 'tomorrow', sub: label, tone: 'soon' }
  if (days <= 7) return { text: `in ${days} days`, sub: label, tone: 'soon' }
  return { text: label, tone: 'idle' }
}

/* --------------------------------------------------------------------------
   the screen
   -------------------------------------------------------------------------- */

export default function StudyPlan({ now }) {
  const nowTs = now instanceof Date ? now.getTime() : Number(now) || Date.now()

  /* undefined while loading, null when there is none yet. */
  const [plan, setPlan] = useState(undefined)
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState('saved')
  const [error, setError] = useState(null)

  const planRef = useRef(plan)
  const timer = useRef(null)

  useEffect(() => {
    let live = true
    getStudyPlan()
      .then((r) => {
        if (!live) return
        const p = r?.plan ? normalize(r.plan) : null
        planRef.current = p
        setPlan(p)
      })
      .catch(() => { if (live) setPlan(null) })
    return () => { live = false }
  }, [])

  /* Saved a moment after the last change, and at once on the way out. */
  const flush = useCallback(async () => {
    clearTimeout(timer.current)
    timer.current = null
    const p = planRef.current
    if (!p) return
    try {
      await saveStudyPlan(p)
      if (planRef.current === p) { setSaving('saved'); setError(null) }
    } catch (err) {
      setSaving('error')
      setError(err?.message || 'The plan could not be saved.')
    }
  }, [])

  useEffect(() => () => { if (timer.current) flush() }, [flush])

  useEffect(() => {
    const warn = (e) => { if (timer.current) { flush(); e.preventDefault() } }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [flush])

  /* Every change goes through here: a copy, changed, shown, saved behind. */
  const edit = useCallback((fn) => {
    if (!planRef.current) return
    const next = structuredClone(planRef.current)
    fn(next)
    planRef.current = next
    setPlan(next)
    setSaving('saving')
    clearTimeout(timer.current)
    timer.current = setTimeout(flush, SAVE_AFTER_MS)
  }, [flush])

  const start = useCallback(async () => {
    const p = blankPlan()
    planRef.current = p
    setPlan(p)
    setEditing(true)
    setSaving('saving')
    await flush()
  }, [flush])

  const finish = useCallback(() => {
    setEditing(false)
    if (timer.current) flush()
  }, [flush])

  const download = useCallback(() => {
    if (!planRef.current) return
    const blob = new Blob([JSON.stringify(planRef.current, null, 2)], { type: 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = 'study-plan.json'
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 1000)
  }, [])

  const remove = useCallback(async () => {
    if (!window.confirm('Delete the whole study plan — every term, course and requirement? This cannot be undone.')) return
    clearTimeout(timer.current)
    timer.current = null
    await clearStudyPlan()
    planRef.current = null
    setPlan(null)
    setEditing(false)
  }, [])

  const toggleItem = useCallback((id) => {
    edit((p) => {
      const it = (p.openItems || []).find((x) => x.id === id)
      if (it) it.done = !it.done
    })
  }, [edit])

  const tally = useMemo(() => (plan ? tallyOf(plan) : null), [plan])

  if (plan === undefined) return <div className="bento" />

  if (!plan) {
    return (
      <div className="bento">
        <Card className="span-12">
          <div className="card__body">
            <EmptyState
              lead="No study plan yet."
              hint="Start one and type in your terms, courses and requirements. Credits, GPA and requirements add themselves up as you go."
              action={<Pill onClick={start} active>Start a plan</Pill>}
            />
          </div>
        </Card>
      </div>
    )
  }

  const right = (
    <span className="sp-head-actions">
      {editing ? (
        <span className={cx('sp-saving micro', saving === 'error' && 'is-error')} aria-live="polite">
          {saving === 'saving' ? 'saving…' : saving === 'error' ? 'not saved' : 'saved'}
        </span>
      ) : null}
      <Pill onClick={editing ? finish : () => setEditing(true)} active={editing}>
        {editing ? 'Done' : 'Edit'}
      </Pill>
      <IconMenu
        label="Study plan options"
        items={[
          { key: 'download', label: 'Download a copy (.json)', onClick: download },
          { key: 'remove', label: 'Delete plan', danger: true, onClick: remove },
        ]}
      />
    </span>
  )

  if (editing) {
    return (
      <div className="bento studyplan is-editing">
        <Progress plan={plan} tally={tally} right={right} error={error} />
        <DegreeEditor plan={plan} edit={edit} />
        <RequirementsEditor plan={plan} tally={tally} edit={edit} />
        <TermsEditor plan={plan} tally={tally} edit={edit} nowTs={nowTs} />
      </div>
    )
  }

  const nextTerm = plan.terms.find((t) => t.status === 'planned')
  const hasNext = !!(plan.registration?.items?.length || plan.backups?.length || nextTerm?.courses.some((c) => c.meets?.length))
  return (
    <div className="bento studyplan">
      <Progress plan={plan} tally={tally} right={right} error={error} />
      <Requirements plan={plan} tally={tally} onEdit={() => setEditing(true)} />
      <Terms plan={plan} tally={tally} onEdit={() => setEditing(true)} />
      <GpaCard plan={plan} className={hasNext ? 'span-5' : 'span-12'} />
      <NextTerm plan={plan} term={nextTerm} nowTs={nowTs} />
      {plan.openItems?.length ? (
        <OpenItems items={plan.openItems} rules={plan.rules || []} onToggle={toggleItem} wide />
      ) : null}
    </div>
  )
}

/* --------------------------------------------------------------------------
   degree progress
   -------------------------------------------------------------------------- */

/* The credits as a ring: earned, this term and planned, each its own arc
   with a small gap between, against what the degree needs. */
function Ring({ parts, total, size = 148, stroke = 9 }) {
  const r = (size - stroke) / 2
  const C = 2 * Math.PI * r
  const gap = 3
  let at = 0
  const arcs = []
  for (const [key, v] of parts) {
    const len = Math.max(0, Math.min(v, total - at)) / total * C
    if (len > gap) arcs.push({ key, len: len - gap, offset: (at / total) * C })
    at += Math.max(0, Math.min(v, total - at))
  }
  return (
    <svg className="sp-ring__svg" width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
      <circle className="sp-ring__track" cx={size / 2} cy={size / 2} r={r} strokeWidth={stroke} fill="none" />
      <g transform={`rotate(-90 ${size / 2} ${size / 2})`}>
        {arcs.map((a) => (
          <circle
            key={a.key}
            className={cx('sp-ring__arc', `is-${a.key}`)}
            cx={size / 2}
            cy={size / 2}
            r={r}
            strokeWidth={stroke}
            fill="none"
            strokeDasharray={`${a.len} ${C}`}
            strokeDashoffset={-a.offset}
          />
        ))}
      </g>
    </svg>
  )
}

function Progress({ plan, tally, right, error }) {
  const s = plan.student || {}
  const required = requiredOf(plan)
  const { credits } = tally
  const secured = credits.done + credits.now
  const spare = tally.total - required

  return (
    <Card className="span-4 sp-progress" aria-label="Degree progress">
      <CardHead
        title="Degree progress"
        subtitle={[s.program, s.home].filter(Boolean).join(' · ') || 'Your degree'}
        right={right}
      />
      <div className="card__body">
        <div className="sp-ring">
          <div className="sp-ring__dial" role="img" aria-label={`${secured} of ${required} credits: ${credits.done} earned, ${credits.now} this term, ${credits.planned} planned`}>
            <Ring parts={[['done', credits.done], ['now', credits.now], ['planned', credits.planned]]} total={required} />
            <div className="sp-ring__center">
              <span className="sp-ring__value">{secured}</span>
              <span className="sp-ring__unit">of {required} cr</span>
            </div>
          </div>
          <dl className="sp-ring__legend">
            <div><dt><i className="sp-key is-done" />earned</dt><dd>{credits.done}</dd></div>
            <div><dt><i className="sp-key is-now" />this term</dt><dd>{credits.now}</dd></div>
            <div><dt><i className="sp-key is-planned" />planned</dt><dd>{credits.planned}</dd></div>
            <div className="sp-ring__spare">
              <dt>{spare >= 0 ? 'to spare' : 'short'}</dt>
              <dd className={spare < 0 ? 'is-short' : undefined}>{Math.abs(spare)}</dd>
            </div>
          </dl>
        </div>

        <dl className="sp-facts">
          {s.graduation ? (<><dt>graduating</dt><dd>{s.graduation}</dd></>) : null}
          {s.standing ? (<><dt>standing</dt><dd>{s.standing}</dd></>) : null}
          {s.minor ? (<><dt>minor</dt><dd>{s.minor}</dd></>) : null}
          {s.location ? (<><dt>now</dt><dd>{s.location}</dd></>) : null}
        </dl>
        {error ? <p className="sp-error">{error}</p> : null}
      </div>
    </Card>
  )
}

/* --------------------------------------------------------------------------
   the GPA, term by term
   -------------------------------------------------------------------------- */

/* Each finished term's GPA, and the running GPA after it. */
function gpaSeries(plan) {
  const out = []
  let pts = 0
  let cr = 0
  for (const t of plan.terms) {
    if (t.status !== 'done') continue
    let tp = 0
    let tc = 0
    for (const c of t.courses) {
      if (c.noCredit || !(c.grade in POINTS)) continue
      tp += POINTS[c.grade] * (Number(c.cr) || 0)
      tc += Number(c.cr) || 0
    }
    if (!tc) continue
    pts += tp
    cr += tc
    out.push({ id: t.id, label: t.label, short: shortTerm(t.label), term: tp / tc, cum: pts / cr, cr: tc })
  }
  return out
}

/* "Fall 2024" → "fa 24" */
function shortTerm(label) {
  const m = /^(\w{2})\w*\s+\d{2}(\d{2})$/.exec(label || '')
  return m ? `${m[1].toLowerCase()} ${m[2]}` : label
}

function useWidth(ref) {
  const [w, setW] = useState(0)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setW(Math.round(e.contentRect.width)))
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref])
  return w
}

function GpaCard({ plan, className }) {
  const series = useMemo(() => gpaSeries(plan), [plan])
  const boxRef = useRef(null)
  const W = useWidth(boxRef)
  const [hover, setHover] = useState(null)

  const last = series[series.length - 1]
  const prev = series[series.length - 2]
  const H = 236
  const pad = { l: 30, r: 44, t: 12, b: 24 }
  const lo = series.length ? Math.min(2, Math.floor(Math.min(...series.map((p) => p.term)) * 2) / 2) : 2
  const hi = 4
  const x = (i) => pad.l + (series.length > 1 ? (i / (series.length - 1)) * (W - pad.l - pad.r) : (W - pad.l - pad.r) / 2)
  const y = (v) => pad.t + (1 - (v - lo) / (hi - lo)) * (H - pad.t - pad.b)
  const ticks = []
  for (let v = lo; v <= hi + 1e-9; v += 0.5) ticks.push(v)
  const path = (key) => series.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p[key]).toFixed(1)}`).join(' ')
  const h = hover != null ? series[hover] : null

  return (
    <Card className={className} aria-label="GPA by term">
      <CardHead
        title="GPA"
        subtitle={last ? `${series.length} graded terms` : 'No graded terms yet'}
        right={
          series.length > 1 ? (
            <span className="sp-legend sp-legend--keep micro">
              <span><i className="sp-key is-cum" />overall</span>
              <span><i className="sp-key is-term" />each term</span>
            </span>
          ) : null
        }
      />
      <div className="card__body">
        {!last ? (
          <EmptyState lead="Nothing graded yet." hint="Mark a term Done and give its courses grades." />
        ) : (
          <>
            <div className="sp-gpa__head">
              <span className="sp-gpa__value">{last.cum.toFixed(3)}</span>
              <span className="sp-gpa__sub micro">
                overall
                {prev ? <> · {last.cum >= prev.cum ? '▲' : '▼'} {Math.abs(last.cum - prev.cum).toFixed(3)} since {prev.label}</> : null}
              </span>
            </div>
            <div className="sp-gpa__chart" ref={boxRef} onMouseLeave={() => setHover(null)}>
              {W ? (
                <svg width={W} height={H} role="img" aria-label={series.map((p) => `${p.label}: term ${p.term.toFixed(2)}, overall ${p.cum.toFixed(2)}`).join('; ')}>
                  {ticks.map((v) => (
                    <g key={v} className="sp-gpa__grid">
                      <line x1={pad.l} x2={W - pad.r} y1={y(v)} y2={y(v)} />
                      <text x={pad.l - 8} y={y(v)} dy="0.32em" textAnchor="end">{v.toFixed(1)}</text>
                    </g>
                  ))}
                  {h ? <line className="sp-gpa__cross" x1={x(hover)} x2={x(hover)} y1={pad.t} y2={H - pad.b} /> : null}
                  <path className="sp-gpa__line is-term" d={path('term')} />
                  <path className="sp-gpa__line is-cum" d={path('cum')} />
                  {series.map((p, i) => (
                    <g key={p.id}>
                      <circle className="sp-gpa__dot is-term" cx={x(i)} cy={y(p.term)} r={hover === i ? 5 : 4} />
                      <circle className="sp-gpa__dot is-cum" cx={x(i)} cy={y(p.cum)} r={hover === i ? 5 : 4} />
                      <text className="sp-gpa__x" x={x(i)} y={H - 6} textAnchor="middle">{p.short}</text>
                      <rect
                        className="sp-gpa__hit"
                        x={x(i) - (W - pad.l - pad.r) / Math.max(1, series.length - 1) / 2}
                        y={0}
                        width={(W - pad.l - pad.r) / Math.max(1, series.length - 1)}
                        height={H}
                        onMouseEnter={() => setHover(i)}
                        onClick={() => setHover(i)}
                      />
                    </g>
                  ))}
                  <text className="sp-gpa__end" x={x(series.length - 1) + 10} y={y(last.cum)} dy="0.32em">{last.cum.toFixed(2)}</text>
                </svg>
              ) : null}
              {h ? (
                <div
                  className={cx('sp-gpa__tip', hover > series.length / 2 && 'is-left')}
                  style={{ left: x(hover), top: Math.min(y(h.term), y(h.cum)) }}
                >
                  <span className="sp-gpa__tip-title">{h.label}</span>
                  <span><i className="sp-key is-term" />term <b>{h.term.toFixed(2)}</b></span>
                  <span><i className="sp-key is-cum" />overall <b>{h.cum.toFixed(3)}</b></span>
                  <span className="dim">{h.cr} graded credits</span>
                </div>
              ) : null}
            </div>
          </>
        )}
      </div>
    </Card>
  )
}

/* --------------------------------------------------------------------------
   requirements
   -------------------------------------------------------------------------- */

/* A requirement as blocks, one per course it takes, filled in order: met,
   under way, planned, then still open. A credit target is blocks of four. */
function unitsOf(g, gs, tally) {
  const units = []
  if (!g.items.length) {
    const n = Math.max(1, Math.round(gs.target / 4))
    const d = Math.round(gs.cr.done / 4)
    const w = Math.round(gs.cr.now / 4)
    const p = Math.round(gs.cr.planned / 4)
    for (let i = 0; i < n; i++) {
      const status = i < d ? 'done' : i < d + w ? 'progress' : i < d + w + p ? 'planned' : 'todo'
      units.push({ key: i, status, tip: `${i * 4 + 1}–${i * 4 + 4} cr · ${STATUS_LABEL[status]}` })
    }
    return units
  }
  for (const it of g.items) {
    const st = tally.items.get(it.id)
    const phases = it.met ? Array(st.need).fill('done') : st.courses.map((c) => (c.ph === 'now' ? 'progress' : c.ph))
    const order = { done: 0, progress: 1, planned: 2 }
    phases.sort((a, b) => order[a] - order[b])
    for (let k = 0; k < st.need; k++) {
      const status = phases[k] || 'todo'
      const course = it.met ? null : st.courses.find((c) => (c.ph === 'now' ? 'progress' : c.ph) === status)
      units.push({
        key: `${it.id}-${k}`,
        status,
        tip: `${it.name || 'untitled'}${st.need > 1 ? ` (${k + 1} of ${st.need})` : ''} · ${STATUS_LABEL[status]}${course ? ` · ${course.c.code || course.c.title}` : ''}`,
      })
    }
  }
  return units
}

function Tiles({ units }) {
  return (
    <span className="sp-tiles">
      {units.map((u) => (
        <span key={u.key} className={cx('sp-tile', `is-${u.status}`)} data-tip={u.tip} aria-label={u.tip} />
      ))}
    </span>
  )
}

/* One line per group, and under it only what is still left to do; the full
   list, with which course meets each requirement, opens on a click. */
function Requirements({ plan, tally, onEdit }) {
  const [open, setOpen] = useState(() => new Set())
  const toggle = (id) => setOpen((s) => {
    const n = new Set(s)
    if (n.has(id)) n.delete(id)
    else n.add(id)
    return n
  })
  const groups = plan.requirements.filter((g) => g.items.length || Number(g.credits))

  return (
    <Card className="span-8" aria-label="Requirements">
      <CardHead
        title="Requirements"
        subtitle={tally.all ? `${tally.met} of ${tally.all} met` : 'None yet'}
        right={
          <span className="sp-legend micro">
            <span><Mark status="done" /> met</span>
            <span><Mark status="progress" /> now</span>
            <span><Mark status="planned" /> planned</span>
          </span>
        }
      />
      <div className="card__body">
        {!groups.length ? (
          <EmptyState lead="No requirements yet." hint="Add your core, major and minor requirements, then mark which courses count toward each." action={<Pill onClick={onEdit}>Edit plan</Pill>} />
        ) : (
          <div className="sp-groups">
            {groups.map((g) => {
              const gs = tally.groups.get(g.id)
              const isOpen = open.has(g.id)
              const byCredits = !g.items.length
              const left = g.items.filter((it) => tally.items.get(it.id).status !== 'done')

              return (
                <section key={g.id} className={cx('sp-group', isOpen && 'is-open')}>
                  <button type="button" className="sp-group__head" aria-expanded={isOpen} onClick={() => toggle(g.id)}>
                    <span className="sp-group__name">{g.group || 'Untitled'}</span>
                    <Tiles units={unitsOf(g, gs, tally)} />
                    <span className="sp-group__count">
                      {byCredits ? `${gs.cr.done + gs.cr.now} / ${gs.target} cr` : `${gs.met} / ${gs.all}`}
                    </span>
                    <ChevronDown className="sp-group__chev" size={14} strokeWidth={1.6} aria-hidden="true" />
                  </button>

                  {isOpen ? (
                    <ul className="sp-reqs__list sp-group__detail">
                      {g.items.map((it) => {
                        const st = tally.items.get(it.id)
                        const by = [byText(st.courses), it.met && !st.courses.length && !it.note ? 'met' : '', it.note].filter(Boolean).join(' — ')
                        return (
                          <li key={it.id} className={cx('sp-req', `is-${st.status}`)} title={STATUS_LABEL[st.status]}>
                            <Mark status={st.status} />
                            <span className="sp-req__text">
                              <span className="sp-req__name">
                                {it.name || 'untitled'}
                                {st.need > 1 ? <span className="sp-req__count"> {st.have}/{st.need}</span> : null}
                              </span>
                              {by ? <span className="sp-req__by">{by}</span> : null}
                            </span>
                          </li>
                        )
                      })}
                      {byCredits ? (
                        <li className="sp-req__by">{gs.cr.done} done · {gs.cr.now} now · {gs.cr.planned} planned</li>
                      ) : null}
                    </ul>
                  ) : byCredits ? null : left.length ? (
                    <ul className="sp-left">
                      {left.map((it) => {
                        const st = tally.items.get(it.id)
                        return (
                          <li key={it.id} className={cx('sp-left__item', `is-${st.status}`)} title={byText(st.courses) || STATUS_LABEL[st.status]}>
                            <Mark status={st.status} />
                            {it.name || 'untitled'}
                            {st.need > 1 ? <span className="sp-left__n">{st.have}/{st.need}</span> : null}
                          </li>
                        )
                      })}
                    </ul>
                  ) : (
                    <p className="sp-left__done micro">All met</p>
                  )}
                </section>
              )
            })}
          </div>
        )}
      </div>
    </Card>
  )
}

/* --------------------------------------------------------------------------
   every term, side by side
   -------------------------------------------------------------------------- */

/* Each requirement's short name; one that two groups share (Statistics, for
   the major and the minor) carries its group to tell them apart. */
function reqNames(plan) {
  const seen = new Map()
  for (const g of plan.requirements) for (const it of g.items) {
    const k = (it.name || '').trim().toLowerCase()
    seen.set(k, (seen.get(k) || 0) + 1)
  }
  const names = new Map()
  for (const g of plan.requirements) {
    names.set(g.id, g.group || 'untitled')
    for (const it of g.items) {
      const name = it.name || 'untitled'
      const shared = seen.get((it.name || '').trim().toLowerCase()) > 1
      names.set(it.id, shared && g.group ? `${g.group} · ${name}` : name)
    }
  }
  return names
}

function Terms({ plan, tally, onEdit }) {
  const required = requiredOf(plan)
  const names = useMemo(() => reqNames(plan), [plan])
  const rows = useMemo(() => {
    let running = 0
    return plan.terms.map((t) => {
      const cr = tally.termCr.get(t.id) || 0
      running += cr
      let pts = 0
      let graded = 0
      for (const c of t.courses) {
        if (c.noCredit || !(c.grade in POINTS)) continue
        pts += POINTS[c.grade] * (Number(c.cr) || 0)
        graded += Number(c.cr) || 0
      }
      return { ...t, cr, running, gpa: t.status === 'done' && graded ? pts / graded : null }
    })
  }, [plan.terms, tally])

  const railRef = useRef(null)
  /* The current term in view on a narrow screen, where the row scrolls. */
  useEffect(() => {
    const rail = railRef.current
    const cur = rail?.querySelector('.sp-term.is-current')
    if (!rail || !cur || rail.scrollWidth <= rail.clientWidth) return
    rail.scrollLeft = cur.offsetLeft - 8
  }, [rows])

  return (
    <Card className="span-12" aria-label="Terms">
      <CardHead
        title="Terms"
        subtitle={rows.length ? `${rows.length} semesters · ${rows[rows.length - 1].running} credits by the end` : 'None yet'}
      />
      <div className="card__body">
        {!rows.length ? (
          <EmptyState lead="No terms yet." hint="Add each semester and the courses in it." action={<Pill onClick={onEdit}>Edit plan</Pill>} />
        ) : (
          <div className="sp-terms" ref={railRef}>
            {rows.map((t) => (
              <section key={t.id} className={cx('sp-term', `is-${t.status}`)} aria-label={t.label}>
                <div className="sp-term__rail" aria-hidden="true"><span className="sp-term__node" /></div>
                <header className="sp-term__head">
                  <span className="sp-term__label">{t.label || 'Untitled term'}</span>
                  {t.status === 'current' ? <span className="sp-term__now">now</span> : null}
                </header>
                <div className="sp-term__meta">
                  {[t.campus?.toLowerCase(), `${t.cr} cr`, t.gpa != null ? `gpa ${t.gpa.toFixed(2)}` : null].filter(Boolean).join(' · ')}
                </div>
                <ul className="sp-term__courses">
                  {/* The name and the grade (or credits, ahead of a grade);
                      the code and what it counts toward are in the tooltip. */}
                  {t.courses.map((c) => {
                    const counts = c.reqs.map((id) => names.get(id)).filter(Boolean).join(', ') || c.counts
                    return (
                      <li
                        key={c.id}
                        className={cx('sp-course', c.tbd && 'is-tbd', !creditOf(c) && 'is-void')}
                        title={[c.code, `${c.cr} cr`, counts && `counts toward ${counts}`].filter(Boolean).join(' · ')}
                      >
                        <span className="sp-course__title">{c.title || c.code || 'Untitled course'}</span>
                        {c.grade ? (
                          <span className={cx('sp-course__grade', gradeBand(c.grade))}>{c.grade}</span>
                        ) : (
                          <span className="sp-course__cr">{c.cr}</span>
                        )}
                      </li>
                    )
                  })}
                </ul>
                <footer className="sp-term__foot">
                  <span className="micro">{t.running}<span className="dim"> / {required}</span></span>
                  <Meter value={Math.min(1, t.running / required)} label={`${t.running} of ${required} credits after ${t.label}`} />
                </footer>
              </section>
            ))}
          </div>
        )}
      </div>
    </Card>
  )
}

/* --------------------------------------------------------------------------
   the editor: the degree
   -------------------------------------------------------------------------- */

function Field({ label, className, value, ...input }) {
  return (
    <label className={cx('field', className)}>
      <span className="field__label">{label}</span>
      <input className="field__input" value={value ?? ''} {...input} />
    </label>
  )
}

function DegreeEditor({ plan, edit }) {
  const s = plan.student
  const set = (k) => (e) => {
    const v = e.target.value
    edit((p) => { p.student[k] = v })
  }
  return (
    <Card className="span-8" aria-label="Degree">
      <CardHead title="Degree" subtitle="What you study, and how many credits it takes to finish" />
      <div className="card__body">
        <div className="sp-form">
          <Field label="Program / major" className="sp-form__wide" value={s.program} onChange={set('program')} placeholder="Computer Science, BS" />
          <Field label="Home campus" value={s.home} onChange={set('home')} placeholder="NYU Shanghai" />
          <Field label="Minor" value={s.minor} onChange={set('minor')} placeholder="Business" />
          <Field label="Graduating" value={s.graduation} onChange={set('graduation')} placeholder="Spring 2028" />
          <Field label="Standing" value={s.standing} onChange={set('standing')} placeholder="Junior" />
          <Field
            label="Credits to graduate"
            type="number"
            min="0"
            inputMode="numeric"
            value={plan.credits.required}
            onChange={(e) => { const v = toNum(e.target.value); edit((p) => { p.credits.required = v }) }}
          />
        </div>
      </div>
    </Card>
  )
}

/* --------------------------------------------------------------------------
   the editor: requirements
   -------------------------------------------------------------------------- */

function RequirementsEditor({ plan, tally, edit }) {
  const [fresh, setFresh] = useState(null)
  const addGroup = () => {
    const id = uid()
    edit((p) => { p.requirements.push({ id, group: '', items: [] }) })
    setFresh(id)
  }
  return (
    <Card className="span-12" aria-label="Requirements">
      <CardHead
        title="Requirements"
        subtitle={`${tally.met} of ${tally.all} met · mark courses below as counting toward these`}
        right={<Pill onClick={addGroup}>Add group</Pill>}
      />
      <div className="card__body">
        {plan.requirements.length ? (
          <div className="sp-ed-groups">
            {plan.requirements.map((g) => (
              <GroupEditor key={g.id} g={g} state={tally.groups.get(g.id)} tally={tally} edit={edit} focus={fresh === g.id} />
            ))}
          </div>
        ) : (
          <EmptyState lead="No requirement groups." hint="A group is Core, Major, Minor, Electives — whatever your degree is split into." action={<Pill onClick={addGroup} active>Add group</Pill>} />
        )}
      </div>
    </Card>
  )
}

function GroupEditor({ g, state, tally, edit, focus }) {
  const [fresh, setFresh] = useState(null)
  const find = (p) => p.requirements.find((x) => x.id === g.id)
  const findItem = (p, id) => find(p).items.find((x) => x.id === id)

  const removeGroup = () => {
    if (g.items.length && !window.confirm(`Remove “${g.group || 'this group'}” and its ${g.items.length} requirement${g.items.length === 1 ? '' : 's'}?`)) return
    const ids = new Set([g.id, ...g.items.map((i) => i.id)])
    edit((p) => {
      p.requirements = p.requirements.filter((x) => x.id !== g.id)
      unlink(p, ids)
    })
  }
  const addItem = () => {
    const id = uid()
    edit((p) => { find(p).items.push({ id, name: '' }) })
    setFresh(id)
  }
  const removeItem = (id) => edit((p) => {
    find(p).items = find(p).items.filter((x) => x.id !== id)
    unlink(p, new Set([id]))
  })

  const summary = [
    g.items.length ? `${state.met} of ${state.all} met` : null,
    state.target ? `${state.cr.done + state.cr.now + state.cr.planned} of ${state.target} cr planned` : null,
  ].filter(Boolean).join(' · ')

  return (
    <section className="sp-ed-group">
      <div className="sp-ed-group__head">
        <input
          className="sp-in sp-in--head"
          value={g.group}
          placeholder="Group, e.g. Major"
          aria-label="Group name"
          autoFocus={focus}
          onChange={(e) => { const v = e.target.value; edit((p) => { find(p).group = v }) }}
        />
        <label className="sp-ed-unit" title="Credits this group needs, if it is counted in credits (e.g. 32 for electives)">
          <input
            className="sp-in sp-in--num"
            type="number"
            min="0"
            inputMode="numeric"
            value={g.credits ?? ''}
            placeholder="—"
            aria-label="Credits needed"
            onChange={(e) => { const v = toNum(e.target.value); edit((p) => { find(p).credits = v }) }}
          />
          <span>cr</span>
        </label>
        <button type="button" className="sp-x" aria-label={`Remove ${g.group || 'group'}`} onClick={removeGroup}>×</button>
      </div>
      <div className="sp-ed-group__sum micro">{summary || 'Add requirements, or a credit total'}</div>

      <ul className="sp-ed-items">
        {g.items.map((it) => {
          const st = tally.items.get(it.id)
          const by = byText(st.courses)
          return (
            <li key={it.id} className="sp-ed-item">
              <Mark status={st.status} />
              <div className="sp-ed-item__main">
                <input
                  className="sp-in"
                  value={it.name}
                  placeholder="e.g. Data Structures"
                  aria-label="Requirement"
                  autoFocus={fresh === it.id}
                  onChange={(e) => { const v = e.target.value; edit((p) => { findItem(p, it.id).name = v }) }}
                  onKeyDown={(e) => { if (e.key === 'Enter') addItem() }}
                />
                <span className="sp-ed-item__by">
                  {by || (it.met ? 'met another way' : 'no course counts toward it yet')}
                  {st.need > 1 ? ` · ${st.have}/${st.need}` : ''}
                </span>
              </div>
              <label className="sp-ed-unit" title="How many courses it takes">
                <span>×</span>
                <input
                  className="sp-in sp-in--num"
                  type="number"
                  min="1"
                  inputMode="numeric"
                  value={it.need ?? 1}
                  aria-label="Courses needed"
                  onChange={(e) => { const v = toNum(e.target.value); edit((p) => { findItem(p, it.id).need = v }) }}
                />
              </label>
              <button
                type="button"
                className={cx('sp-met', it.met && 'is-on')}
                aria-pressed={!!it.met}
                title="Met another way — placement, transfer credit, a waiver"
                onClick={() => edit((p) => { const x = findItem(p, it.id); x.met = !x.met })}
              >
                met
              </button>
              <button type="button" className="sp-x" aria-label={`Remove ${it.name || 'requirement'}`} onClick={() => removeItem(it.id)}>×</button>
            </li>
          )
        })}
      </ul>
      <button type="button" className="sp-add" onClick={addItem}>+ Add requirement</button>
    </section>
  )
}

/* --------------------------------------------------------------------------
   the editor: terms and courses
   -------------------------------------------------------------------------- */

function TermsEditor({ plan, tally, edit, nowTs }) {
  const [fresh, setFresh] = useState(null)
  const required = requiredOf(plan)
  const suggestion = nextLabel(plan.terms[plan.terms.length - 1]?.label, nowTs)

  const addTerm = () => {
    const last = plan.terms[plan.terms.length - 1]
    const id = uid()
    edit((p) => { p.terms.push({ id, label: suggestion, campus: last?.campus || '', status: 'planned', courses: [] }) })
    setFresh(id)
  }

  /* What a course can count toward: each group as a whole, then its items. */
  const options = useMemo(() => {
    const out = []
    for (const g of plan.requirements) {
      out.push({ id: g.id, label: g.group || 'untitled group', group: true })
      for (const it of g.items) out.push({ id: it.id, label: `${g.group ? `${g.group} · ` : ''}${it.name || 'untitled'}` })
    }
    return out
  }, [plan.requirements])
  const names = useMemo(() => reqNames(plan), [plan])

  let running = 0
  return (
    <Card className="span-12" aria-label="Terms">
      <CardHead
        title="Terms"
        subtitle={`${plan.terms.length} terms · ${tally.total} of ${required} credits planned`}
        right={<Pill onClick={addTerm}>Add {suggestion}</Pill>}
      />
      <div className="card__body">
        {!plan.terms.length ? (
          <EmptyState lead="No terms yet." hint="Start with your first semester and work forward." action={<Pill onClick={addTerm} active>Add {suggestion}</Pill>} />
        ) : (
          <div className="sp-ed-terms">
            {plan.terms.map((t) => {
              const cr = tally.termCr.get(t.id) || 0
              running += cr
              return (
                <TermEditor
                  key={t.id}
                  t={t}
                  cr={cr}
                  running={running}
                  required={required}
                  options={options}
                  names={names}
                  edit={edit}
                  focus={fresh === t.id}
                />
              )
            })}
          </div>
        )}
      </div>
    </Card>
  )
}

function TermEditor({ t, cr, running, required, options, names, edit, focus }) {
  const [fresh, setFresh] = useState(null)
  const find = (p) => p.terms.find((x) => x.id === t.id)
  const findCourse = (p, id) => find(p).courses.find((x) => x.id === id)

  const addCourse = () => {
    const id = uid()
    edit((p) => { find(p).courses.push({ id, code: '', title: '', cr: 4, grade: '', reqs: [] }) })
    setFresh(id)
  }
  const removeTerm = () => {
    if (t.courses.length && !window.confirm(`Remove ${t.label || 'this term'} and its ${t.courses.length} course${t.courses.length === 1 ? '' : 's'}?`)) return
    edit((p) => { p.terms = p.terms.filter((x) => x.id !== t.id) })
  }
  const setTerm = (k) => (e) => {
    const v = e.target.value
    edit((p) => { find(p)[k] = v })
  }

  return (
    <section className={cx('sp-ed-term', `is-${t.status}`)} aria-label={t.label || 'Term'}>
      <header className="sp-ed-term__head">
        <input className="sp-in sp-in--head" value={t.label} placeholder="Fall 2026" aria-label="Term" autoFocus={focus} onChange={setTerm('label')} />
        <input className="sp-in sp-ed-term__campus" value={t.campus} placeholder="Campus" aria-label="Campus" onChange={setTerm('campus')} />
        <PillSelect
          value={t.status}
          options={STATUS_OPTIONS}
          label="Term status"
          className="sp-ed-status"
          onChange={(v) => edit((p) => {
            /* Only one term can be the current one. */
            if (v === 'current') for (const x of p.terms) if (x.status === 'current') x.status = 'done'
            find(p).status = v
          })}
        />
        <span className="sp-ed-term__cr micro">
          {cr} cr<span className="dim"> · {running}/{required}</span>
        </span>
        <button type="button" className="sp-x" aria-label={`Remove ${t.label || 'term'}`} onClick={removeTerm}>×</button>
      </header>

      {t.courses.length ? (
        <div className="sp-ed-courses">
          <div className="sp-ed-course sp-ed-course--labels micro" aria-hidden="true">
            <span>code</span><span>course</span><span>cr</span><span>grade</span><span>counts toward</span><span />
          </div>
          {t.courses.map((c) => (
            <div key={c.id} className={cx('sp-ed-course', !creditOf(c) && 'is-void')}>
              <input
                className="sp-in sp-in--code"
                value={c.code ?? ''}
                placeholder="TBD"
                aria-label="Course code"
                autoFocus={fresh === c.id}
                onChange={(e) => { const v = e.target.value; edit((p) => { findCourse(p, c.id).code = v }) }}
              />
              <input
                className="sp-in sp-ed-course__title"
                value={c.title ?? ''}
                placeholder="Course title"
                aria-label="Course title"
                onChange={(e) => { const v = e.target.value; edit((p) => { findCourse(p, c.id).title = v }) }}
                onKeyDown={(e) => { if (e.key === 'Enter') addCourse() }}
              />
              <input
                className="sp-in sp-in--num"
                type="number"
                min="0"
                inputMode="numeric"
                value={c.cr ?? ''}
                aria-label="Credits"
                onChange={(e) => { const v = toNum(e.target.value); edit((p) => { findCourse(p, c.id).cr = v }) }}
              />
              <PillSelect
                value={c.grade || 'none'}
                options={GRADE_OPTIONS}
                label="Grade"
                className="sp-ed-grade"
                onChange={(v) => edit((p) => {
                  const x = findCourse(p, c.id)
                  x.grade = v === 'none' ? '' : v
                  if (x.noCredit && v !== 'W') delete x.noCredit
                })}
              />
              <div className="sp-ed-counts">
                {c.reqs.filter((id) => names.has(id)).map((id) => (
                  <button
                    key={id}
                    type="button"
                    className="sp-chip"
                    title="Stop counting it toward this"
                    onClick={() => edit((p) => { const x = findCourse(p, c.id); x.reqs = x.reqs.filter((r) => r !== id) })}
                  >
                    {names.get(id)}<span aria-hidden="true">×</span>
                  </button>
                ))}
                <MenuButton
                  label="Counts toward"
                  className="sp-chip sp-chip--add"
                  items={options.length ? options.map((o) => ({
                    key: o.id,
                    label: o.group ? `${o.label} (as a whole)` : o.label,
                    on: c.reqs.includes(o.id),
                    onClick: () => edit((p) => {
                      const x = findCourse(p, c.id)
                      x.reqs = x.reqs.includes(o.id) ? x.reqs.filter((r) => r !== o.id) : [...x.reqs, o.id]
                    }),
                  })) : [{ key: 'none', label: 'Add requirements above first', disabled: true }]}
                >
                  {c.reqs.length ? '+' : '+ counts toward'}
                </MenuButton>
              </div>
              <button
                type="button"
                className="sp-x"
                aria-label={`Remove ${c.code || c.title || 'course'}`}
                onClick={() => edit((p) => { find(p).courses = find(p).courses.filter((x) => x.id !== c.id) })}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      ) : null}
      <button type="button" className="sp-add" onClick={addCourse}>+ Add course</button>
    </section>
  )
}

/* --------------------------------------------------------------------------
   next term: registering, the week, the backups — one card, one at a time
   -------------------------------------------------------------------------- */

function NextTerm({ plan, term, nowTs, wide }) {
  const reg = plan.registration
  const backups = plan.backups || []
  const hasWeek = !!term?.courses.some((c) => c.meets?.length)
  const panes = [
    reg?.items?.length ? { value: 'register', label: 'Register' } : null,
    hasWeek ? { value: 'week', label: 'Week' } : null,
    backups.length ? { value: 'backups', label: 'Backups' } : null,
  ].filter(Boolean)
  const [pane, setPane] = useState(null)

  if (!panes.length) return null
  const cur = panes.some((p) => p.value === pane) ? pane : panes[0].value
  const label = term?.label || reg?.term || 'Next term'
  const subtitle = {
    register: 'When each course opens to you',
    week: [term?.campus, 'as planned'].filter(Boolean).join(' · '),
    backups: 'If a course fills',
  }[cur]

  return (
    <Card className={wide ? 'span-12' : 'span-7'} aria-label={label}>
      <CardHead
        className="sp-next__head"
        title={label}
        subtitle={subtitle}
        right={panes.length > 1 ? <Segmented items={panes} value={cur} onChange={setPane} label={`${label}: show`} /> : null}
      />
      <div className={cx('card__body', cur === 'register' && 'card__body--tight')}>
        {cur === 'register' ? <RegistrationList reg={reg} nowTs={nowTs} /> : null}
        {cur === 'week' ? <WeekGrid term={term} /> : null}
        {cur === 'backups' ? <BackupList backups={backups} /> : null}
      </div>
    </Card>
  )
}

function RegistrationList({ reg, nowTs }) {
  return (
    <>
      <ul className="sp-regs">
        {reg.items.map((it) => {
          const w = whenOf(it.date, nowTs)
          return (
            <li key={it.code} className="sp-reg">
              <span className={cx('sp-reg__when', `is-${w.tone}`)}>
                <span className={cx('status-dot', w.tone === 'ok' && 'status-dot--live', w.tone === 'soon' && 'status-dot--soon', w.tone === 'idle' && 'status-dot--idle')} aria-hidden="true" />
                <span className="sp-reg__day">{w.text}</span>
                {w.sub ? <span className="sp-reg__date">{w.sub}</span> : null}
              </span>
              <span className="sp-reg__what">
                <span className="sp-reg__title">{it.title} <span className="sp-reg__code">{it.code}</span></span>
                <span className="sp-reg__how">{it.when}{it.note ? ` · ${it.note}` : ''}</span>
              </span>
              {it.odds ? <span className={cx('sp-reg__odds', `is-${it.odds}`)}>{it.odds}</span> : null}
            </li>
          )
        })}
      </ul>
      {reg.warning ? <p className="sp-warn">{reg.warning}</p> : null}
    </>
  )
}

function WeekGrid({ term }) {
  const { blocks, from, to, extra } = useMemo(() => {
    const out = []
    const loose = []
    for (const c of term?.courses || []) {
      if (!c.meets?.length) { if (!c.tbd && c.time) loose.push(c); continue }
      for (const m of c.meets) out.push({ c, day: m.day, a: minutes(m.start), b: minutes(m.end) })
    }
    const lo = out.length ? Math.min(...out.map((x) => x.a)) : 9 * 60
    const hi = out.length ? Math.max(...out.map((x) => x.b)) : 17 * 60
    return { blocks: out, from: Math.floor(lo / 60) * 60, to: Math.ceil(hi / 60) * 60, extra: loose }
  }, [term])

  const span = to - from
  const hours = []
  for (let h = from; h <= to; h += 60) hours.push(h)

  return (
    <>
      <div className="sp-week">
        <div className="sp-week__hours" aria-hidden="true">
          {hours.map((h) => (
            <span key={h} style={{ top: `${((h - from) / span) * 100}%` }}>{clock(h)}</span>
          ))}
        </div>
        {WEEK.map((d) => (
          <div key={d.day} className="sp-week__day">
            <span className="sp-week__label">{d.label}</span>
            <div className="sp-week__lane">
              {hours.map((h) => (
                <i key={h} className="sp-week__tick" style={{ top: `${((h - from) / span) * 100}%` }} />
              ))}
              {blocks.filter((x) => x.day === d.day).map((x) => (
                <div
                  key={`${x.c.id}-${x.a}`}
                  className={cx('sp-block', x.c.mode === 'online' && 'is-online')}
                  style={{ top: `${((x.a - from) / span) * 100}%`, height: `${((x.b - x.a) / span) * 100}%` }}
                  title={`${x.c.title} · ${x.c.time}${x.c.mode ? ` · ${x.c.mode}` : ''}`}
                >
                  <span className="sp-block__title">{x.c.title}</span>
                  <span className="sp-block__time">{clock(x.a)}–{clock(x.b)}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
      {extra.length ? (
        <div className="sp-week__extra micro">
          {extra.map((c) => (
            <span key={c.id}>{c.title} — {c.time}</span>
          ))}
        </div>
      ) : null}
    </>
  )
}

function BackupList({ backups }) {
  return (
    <div className="sp-backups">
      {backups.map((b) => (
        <section key={b.for} className="sp-backups__group">
          <div className="sp-reqs__head">
            <span className="section-label">for {b.for.toLowerCase()}</span>
            <span className="micro dim">{b.slot}</span>
          </div>
          <ul className="sp-backups__list">
            {b.options.map((o) => (
              <li key={o.code} className="sp-backup">
                <span className="sp-backup__title truncate">{o.title}</span>
                <span className="sp-backup__time">{o.time}</span>
                <span className="sp-backup__code">{o.code} · #{o.classNo}</span>
                <span className={cx('sp-backup__note', /best/i.test(o.note) && 'is-best')}>{o.note}</span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}

/* --------------------------------------------------------------------------
   open items, with the planning rules folded away under them
   -------------------------------------------------------------------------- */

function OpenItems({ items, rules, onToggle, wide }) {
  const [showRules, setShowRules] = useState(false)
  const left = items.filter((it) => !it.done).length
  return (
    <Card className={cx(wide ? 'span-12 sp-open--wide' : 'span-5')} aria-label="To confirm with your advisor">
      <CardHead title="To confirm" subtitle={left ? `${left} open with your advisor` : 'All confirmed'} />
      <div className="card__body">
        <ul className="sp-items">
          {items.map((it) => (
            <li key={it.id}>
              <button
                type="button"
                className={cx('sp-item', it.done && 'is-done')}
                role="checkbox"
                aria-checked={it.done}
                onClick={() => onToggle(it.id)}
              >
                <span className="sp-item__box" aria-hidden="true">
                  <svg viewBox="0 0 12 12"><path d="M2.5 6.2 5 8.6l4.5-5" /></svg>
                </span>
                <span className="sp-item__text">{it.text}</span>
              </button>
            </li>
          ))}
        </ul>
        {rules.length ? (
          <div className={cx('sp-rules', showRules && 'is-open')}>
            <button type="button" className="sp-rules__toggle" aria-expanded={showRules} onClick={() => setShowRules((v) => !v)}>
              <span className="section-label">{rules.length} planning rules</span>
              <ChevronDown size={13} strokeWidth={1.6} aria-hidden="true" />
            </button>
            {showRules ? (
              <ul>
                {rules.map((r) => <li key={r}>{r}</li>)}
              </ul>
            ) : null}
          </div>
        ) : null}
      </div>
    </Card>
  )
}
