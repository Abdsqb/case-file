/**
 * StudyPlan — Calendar's third tab: the degree, term by term.
 *
 * The plan is one JSON document kept in the database (it holds grades, and
 * the bundle is public), imported whole from a file. This screen draws it and
 * writes back only one thing: ticking an open item off.
 *
 *   Degree progress — credits against 128, the GPA, when it ends
 *   Requirements    — core, major, minor, electives, each done / now / planned
 *   Terms           — every semester side by side, past ones with grades
 *   Registration    — what to register for next, and when
 *   Next term's week, the backups, and the open questions
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Card, CardHead, EmptyState, IconMenu, Meter, Metric, Pill } from '../ui/primitives.jsx'
import { clearStudyPlan, getStudyPlan, saveStudyPlan } from '../lib/api.js'

function cx(...parts) {
  return parts.filter(Boolean).join(' ')
}

const DAY_MS = 86400000
const WEEK = [
  { day: 1, label: 'Mon' },
  { day: 2, label: 'Tue' },
  { day: 3, label: 'Wed' },
  { day: 4, label: 'Thu' },
  { day: 5, label: 'Fri' },
]

/* Credits a course earns: a withdrawal is on the record and earns nothing. */
const creditOf = (c) => (c.noCredit ? 0 : Number(c.cr) || 0)

function minutes(hhmm) {
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

const STATUS_LABEL = { done: 'done', progress: 'in progress', planned: 'planned', todo: 'not planned' }

function Mark({ status }) {
  return <span className={cx('sp-mark', `sp-mark--${status}`)} aria-hidden="true" />
}

/* --------------------------------------------------------------------------
   the screen
   -------------------------------------------------------------------------- */

export default function StudyPlan({ now }) {
  const nowTs = now instanceof Date ? now.getTime() : Number(now) || Date.now()

  /* undefined while loading, null when none has been imported. */
  const [plan, setPlan] = useState(undefined)
  const [error, setError] = useState(null)
  const fileRef = useRef(null)

  useEffect(() => {
    let live = true
    getStudyPlan()
      .then((r) => { if (live) setPlan(r?.plan ?? null) })
      .catch(() => { if (live) setPlan(null) })
    return () => { live = false }
  }, [])

  const importFile = useCallback(async (e) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setError(null)
    try {
      const next = JSON.parse(await file.text())
      await saveStudyPlan(next)
      setPlan(next)
    } catch (err) {
      setError(err instanceof SyntaxError ? 'That file is not valid JSON.' : err?.message || 'The plan could not be saved.')
    }
  }, [])

  const download = useCallback(() => {
    if (!plan) return
    const blob = new Blob([JSON.stringify(plan, null, 2)], { type: 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = 'study-plan.json'
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 1000)
  }, [plan])

  const remove = useCallback(async () => {
    if (!window.confirm('Remove the study plan from the app? The file you imported it from is not touched.')) return
    await clearStudyPlan()
    setPlan(null)
  }, [])

  /* Ticking an open item: shown at once, saved behind it, put back if the
     save fails. */
  const planRef = useRef(plan)
  planRef.current = plan
  const toggleItem = useCallback((id) => {
    const prev = planRef.current
    if (!prev) return
    const next = {
      ...prev,
      openItems: prev.openItems.map((it) => (it.id === id ? { ...it, done: !it.done } : it)),
    }
    setPlan(next)
    saveStudyPlan(next).catch(() => setPlan(prev))
  }, [])

  const picker = (
    <input
      ref={fileRef}
      type="file"
      accept=".json,application/json"
      onChange={importFile}
      hidden
    />
  )

  if (plan === undefined) return <div className="bento">{picker}</div>

  if (!plan) {
    return (
      <div className="bento">
        <Card className="span-12">
          <div className="card__body">
            <EmptyState
              lead="No study plan yet."
              hint={error || 'Import the plan’s .json file — it is kept with your archive, behind the password.'}
              action={
                <Pill onClick={() => fileRef.current?.click()} active>
                  Import plan
                </Pill>
              }
            />
          </div>
        </Card>
        {picker}
      </div>
    )
  }

  const menu = (
    <IconMenu
      label="Study plan options"
      items={[
        { key: 'replace', label: 'Replace with a file…', onClick: () => fileRef.current?.click() },
        { key: 'download', label: 'Download as .json', onClick: download },
        { key: 'remove', label: 'Remove plan', danger: true, onClick: remove },
      ]}
    />
  )

  return (
    <div className="bento studyplan">
      <Progress plan={plan} right={menu} error={error} />
      <Requirements groups={plan.requirements || []} />
      <Terms terms={plan.terms} required={plan.credits?.required || 128} />
      {plan.registration ? <Registration reg={plan.registration} nowTs={nowTs} /> : null}
      <NextWeek term={plan.terms.find((t) => t.status === 'planned')} />
      {plan.backups?.length ? <Backups backups={plan.backups} /> : null}
      <OpenItems items={plan.openItems || []} rules={plan.rules || []} onToggle={toggleItem} />
      {picker}
    </div>
  )
}

/* --------------------------------------------------------------------------
   degree progress
   -------------------------------------------------------------------------- */

function Progress({ plan, right, error }) {
  const s = plan.student || {}
  const required = plan.credits?.required || 128
  const tally = useMemo(() => {
    let earned = 0
    let current = 0
    let planned = 0
    for (const t of plan.terms) {
      const sum = t.courses.reduce((n, c) => n + creditOf(c), 0)
      if (t.status === 'done') earned += sum
      else if (t.status === 'current') current += sum
      else planned += sum
    }
    return { earned, current, planned, total: earned + current + planned }
  }, [plan.terms])
  const secured = tally.earned + tally.current
  const spare = tally.total - required

  return (
    <Card className="span-4 sp-progress" aria-label="Degree progress">
      <CardHead
        title="Degree progress"
        subtitle={[s.program, s.home].filter(Boolean).join(' · ')}
        right={right}
      />
      <div className="card__body">
        <Metric value={secured} unit={`of ${required} credits`} sub={`${tally.earned} earned · ${tally.current} this term`} />
        <div className="sp-progress__bar" aria-hidden="true">
          <span className="sp-progress__seg sp-progress__seg--done" style={{ width: `${(tally.earned / required) * 100}%` }} />
          <span className="sp-progress__seg sp-progress__seg--now" style={{ width: `${(tally.current / required) * 100}%` }} />
        </div>
        <div className="row row--between micro">
          <span>{tally.total} planned</span>
          <span>{spare >= 0 ? `${spare} to spare` : `${-spare} short`}</span>
        </div>

        <dl className="sp-facts">
          {s.graduation ? (<><dt>graduating</dt><dd>{s.graduation}</dd></>) : null}
          {s.gpa ? (<><dt>gpa</dt><dd>{Number(s.gpa).toFixed(3)}{s.gpaAsOf ? <span className="dim"> · {s.gpaAsOf}</span> : null}</dd></>) : null}
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
   requirements
   -------------------------------------------------------------------------- */

function Requirements({ groups }) {
  const counts = useMemo(() => {
    let done = 0
    let all = 0
    for (const g of groups) for (const it of g.items) { all += 1; if (it.status === 'done') done += 1 }
    return { done, all }
  }, [groups])

  return (
    <Card className="span-8" aria-label="Requirements">
      <CardHead
        title="Requirements"
        subtitle={`${counts.done} of ${counts.all} met`}
        right={
          <span className="sp-legend micro">
            <span><Mark status="done" /> done</span>
            <span><Mark status="progress" /> now</span>
            <span><Mark status="planned" /> planned</span>
          </span>
        }
      />
      <div className="card__body">
        <div className="sp-reqs">
          {groups.map((g) => {
            const met = g.items.filter((it) => it.status === 'done').length
            return (
              <section key={g.group} className="sp-reqs__group">
                <div className="sp-reqs__head">
                  <span className="section-label">{g.group.toLowerCase()}</span>
                  <span className="micro dim">{met}/{g.items.length}</span>
                </div>
                <ul className="sp-reqs__list">
                  {g.items.map((it) => (
                    <li key={it.name} className={cx('sp-req', `is-${it.status}`)} title={STATUS_LABEL[it.status]}>
                      <Mark status={it.status} />
                      <span className="sp-req__text">
                        <span className="sp-req__name">{it.name}</span>
                        {it.by ? <span className="sp-req__by">{it.by}</span> : null}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            )
          })}
        </div>
      </div>
    </Card>
  )
}

/* --------------------------------------------------------------------------
   every term, side by side
   -------------------------------------------------------------------------- */

function Terms({ terms, required }) {
  const rows = useMemo(() => {
    let running = 0
    return terms.map((t) => {
      const cr = t.courses.reduce((n, c) => n + creditOf(c), 0)
      running += cr
      return { ...t, cr, running }
    })
  }, [terms])

  const railRef = useRef(null)
  /* The current term in view on a narrow screen, where the row scrolls. */
  useEffect(() => {
    const rail = railRef.current
    const now = rail?.querySelector('.sp-term.is-current')
    if (!rail || !now || rail.scrollWidth <= rail.clientWidth) return
    rail.scrollLeft = now.offsetLeft - 8
  }, [rows])

  return (
    <Card className="span-12" aria-label="Terms">
      <CardHead
        title="Terms"
        subtitle={`${rows.length} semesters · ${rows[rows.length - 1]?.running ?? 0} credits by the end`}
      />
      <div className="card__body">
        <div className="sp-terms" ref={railRef}>
          {rows.map((t) => (
            <section key={t.id} className={cx('sp-term', `is-${t.status}`)} aria-label={t.label}>
              <div className="sp-term__rail" aria-hidden="true"><span className="sp-term__node" /></div>
              <header className="sp-term__head">
                <span className="sp-term__label">{t.label}</span>
                {t.status === 'current' ? <span className="sp-term__now">now</span> : null}
              </header>
              <div className="sp-term__meta">
                {t.campus.toLowerCase()} · {t.cr} cr
              </div>
              <ul className="sp-term__courses">
                {t.courses.map((c, i) => (
                  <li key={`${c.code}-${i}`} className={cx('sp-course', c.tbd && 'is-tbd', c.noCredit && 'is-void')}>
                    <span className="sp-course__title">{c.title}</span>
                    <span className="sp-course__line">
                      <span className="sp-course__code">{c.code || c.counts}</span>
                      {c.grade ? (
                        <span className="sp-course__grade">{c.grade}</span>
                      ) : (
                        <span className="sp-course__cr">{c.cr}</span>
                      )}
                    </span>
                    {c.code && c.counts && !c.grade ? <span className="sp-course__counts">{c.counts}</span> : null}
                  </li>
                ))}
              </ul>
              <footer className="sp-term__foot">
                <span className="micro">{t.running}<span className="dim"> / {required}</span></span>
                <Meter value={Math.min(1, t.running / required)} label={`${t.running} of ${required} credits after ${t.label}`} />
              </footer>
            </section>
          ))}
        </div>
      </div>
    </Card>
  )
}

/* --------------------------------------------------------------------------
   registration
   -------------------------------------------------------------------------- */

function Registration({ reg, nowTs }) {
  return (
    <Card className="span-7" aria-label={`${reg.term} registration`}>
      <CardHead title="Registration" subtitle={`${reg.term} · when each course opens to you`} />
      <div className="card__body card__body--tight">
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
      </div>
    </Card>
  )
}

/* --------------------------------------------------------------------------
   next term's week
   -------------------------------------------------------------------------- */

function NextWeek({ term }) {
  const { blocks, from, to, extra } = useMemo(() => {
    const out = []
    const loose = []
    for (const c of term?.courses || []) {
      if (!c.meets?.length) { if (!c.tbd) loose.push(c); continue }
      for (const m of c.meets) out.push({ c, day: m.day, a: minutes(m.start), b: minutes(m.end) })
    }
    const lo = out.length ? Math.min(...out.map((x) => x.a)) : 9 * 60
    const hi = out.length ? Math.max(...out.map((x) => x.b)) : 17 * 60
    return { blocks: out, from: Math.floor(lo / 60) * 60, to: Math.ceil(hi / 60) * 60, extra: loose }
  }, [term])

  if (!term || !blocks.length) return null
  const span = to - from
  const hours = []
  for (let h = from; h <= to; h += 60) hours.push(h)

  return (
    <Card className="span-5" aria-label={`${term.label} week`}>
      <CardHead title={`${term.label} week`} subtitle={`${term.campus} · as planned`} />
      <div className="card__body">
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
                    key={`${x.c.code}-${x.a}`}
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
              <span key={c.code}>{c.title} — {c.time}</span>
            ))}
          </div>
        ) : null}
      </div>
    </Card>
  )
}

/* --------------------------------------------------------------------------
   backups
   -------------------------------------------------------------------------- */

function Backups({ backups }) {
  return (
    <Card className="span-7" aria-label="Backups">
      <CardHead title="Backups" subtitle="If a course fills" />
      <div className="card__body">
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
      </div>
    </Card>
  )
}

/* --------------------------------------------------------------------------
   open items and the rules
   -------------------------------------------------------------------------- */

function OpenItems({ items, rules, onToggle }) {
  const left = items.filter((it) => !it.done).length
  return (
    <Card className="span-5" aria-label="To confirm with your advisor">
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
          <div className="sp-rules">
            <span className="section-label">rules</span>
            <ul>
              {rules.map((r) => <li key={r}>{r}</li>)}
            </ul>
          </div>
        ) : null}
      </div>
    </Card>
  )
}
