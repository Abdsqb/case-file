/**
 * Filing.jsx — what the clerk proposes, before any of it is true.
 *
 * The clerk reads the pad and comes back with rows. This is where you read
 * them: every proposed case, entry and subtask, with the few words from your
 * own text that produced it, and a tick you can take off. Nothing in the
 * archive has changed yet and nothing will until the button at the bottom.
 *
 * It is an editor, not a confirmation dialog. The common correction is not
 * "no, discard everything" — it is "that one is the wrong week" or "that
 * belongs under the other case", and having to go and fix those afterwards
 * would make filing slower than typing. So the title, the date, the priority
 * and the case are all editable here, and what is written is what is on
 * screen, not what the model said.
 *
 * `why` is the load-bearing column. A proposed row you have to go back to the
 * source to check is a row you will accept without checking.
 */

import { useCallback, useMemo, useRef, useState } from 'react'
import { Check, CornerDownRight, FolderPlus, X } from 'lucide-react'

import { DatePopover, Pill, PillSelect, parseISODate } from './primitives.jsx'

function cx(...parts) {
  return parts.filter(Boolean).join(' ')
}

const PRIORITY_OPTIONS = [
  { value: 'low', label: 'Low' },
  { value: 'normal', label: 'Normal' },
  { value: 'high', label: 'High' },
]

const NEW_CASE = '__new__'

/* How a date reads in a review list: the day, and how far off it is. The
   distance is the part that catches a mistake — "2026-11-04" looks fine and
   "in 32d" is what tells you the clerk read the wrong month. */
function whenOf(iso, now) {
  const d = parseISODate(iso)
  if (!d) return null
  const today = new Date(now)
  today.setHours(0, 0, 0, 0)
  const days = Math.round((d.getTime() - today.getTime()) / 86400000)
  const label = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
  const far = days < 0 ? `${-days}d ago` : days === 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${days}d`
  return { label, far, late: days < 0, soon: days >= 0 && days <= 2 }
}

/* ------------------------------------------------------------------- a row */

function Row({ row, cases, proposedCases, now, onChange, onToggle }) {
  const dateRef = useRef(null)
  const [dateOpen, setDateOpen] = useState(false)

  const on = row.include !== false
  const when = whenOf(row.dueText, now)

  /* A subtask's case is its parent's, and its date is the parent's problem —
     so it gets a narrower row rather than four controls that do nothing. */
  const isSub = row.kind === 'subtask'
  const isCase = row.kind === 'case'

  const caseOptions = useMemo(() => [
    ...proposedCases.map((c) => ({ value: `ref:${c.ref}`, label: `${c.name} · new` })),
    ...cases.map((c) => ({ value: `id:${c.id}`, label: c.name })),
  ], [cases, proposedCases])

  const caseValue = row.caseRef ? `ref:${row.caseRef}` : row.caseId ? `id:${row.caseId}` : ''

  const pickCase = (value) => {
    if (String(value).startsWith('ref:')) onChange({ caseRef: String(value).slice(4), caseId: null })
    else onChange({ caseId: String(value).slice(3), caseRef: null })
  }

  return (
    <li className={cx('filing__row', !on && 'is-off', isSub && 'filing__row--sub', isCase && 'filing__row--case')}>
      <button
        type="button"
        className="filing__tick"
        role="checkbox"
        aria-checked={on}
        onClick={onToggle}
        title={on ? 'Leave this one out' : 'Put this one back'}
      >
        {on ? <Check size={13} aria-hidden="true" /> : null}
      </button>

      <div className="filing__main">
        <div className="filing__titleline">
          {isSub ? <CornerDownRight size={13} className="filing__sub" aria-hidden="true" /> : null}
          {isCase ? <FolderPlus size={13} className="filing__new" aria-hidden="true" /> : null}

          <input
            className="filing__title"
            value={isCase ? row.name : row.title}
            disabled={!on}
            spellCheck="false"
            onChange={(e) => onChange(isCase ? { name: e.target.value } : { title: e.target.value })}
            aria-label={isCase ? 'Name of the new case' : 'Entry title'}
          />

          {isCase ? <span className="filing__kind">new case</span> : null}
        </div>

        {!isCase && !isSub ? (
          <div className="filing__meta">
            <PillSelect
              className="pill--micro"
              value={caseValue}
              options={caseOptions}
              onChange={pickCase}
              placeholder="Pick a case"
              disabled={!on}
              label="Which case this goes in"
            />

            <span className="filing__dateslot">
              <Pill
                ref={dateRef}
                className={cx(
                  'pill--micro',
                  'filing__date',
                  when && when.late && 'filing__date--late',
                  when && when.soon && 'filing__date--soon',
                )}
                onClick={() => setDateOpen((v) => !v)}
                disabled={!on}
                active={dateOpen}
              >
                {when ? `${when.label} · ${when.far}` : 'No date'}
              </Pill>
              {dateOpen ? (
                <DatePopover
                  anchorRef={dateRef}
                  value={row.dueText}
                  onSelect={(iso) => { onChange({ dueText: iso }); setDateOpen(false) }}
                  onClear={() => { onChange({ dueText: null }); setDateOpen(false) }}
                  onClose={() => setDateOpen(false)}
                />
              ) : null}
            </span>

            <PillSelect
              className="pill--micro"
              value={row.priority || 'normal'}
              options={PRIORITY_OPTIONS}
              onChange={(v) => onChange({ priority: v })}
              disabled={!on}
              label="Priority"
              align="end"
            />
          </div>
        ) : null}

        {row.why ? <p className="filing__why">{row.why}</p> : null}
      </div>
    </li>
  )
}

/* ----------------------------------------------------------------- the sheet */

export default function Filing({ result, cases, now, busy, error, onApply, onDiscard }) {
  const [rows, setRows] = useState(() =>
    (result.proposals || []).map((p) => ({ ...p, include: true })))

  const patch = useCallback((id, next) => {
    setRows((list) => list.map((r) => (r.id === id ? { ...r, ...next } : r)))
  }, [])

  /* A row cannot be filed without the rows it depends on, so the tick has to
     move in both directions.
     ----------------------------------------------------------------------
     DOWN, when you turn one off: a case takes its entries with it and an
     entry takes its subtasks, because filing an entry into a case that was
     never created is not an error the server can report usefully — it just
     writes fewer rows than you approved, and you are left reading "6 filed"
     having ticked 9 with no way to tell which three went missing.

     UP, when you turn one back on: an entry brings back the case it belongs
     to. Without this you can untick a case (taking its entry down with it),
     decide you want the entry after all, and re-tick it — leaving an entry
     pointing at a case that is not being created. Same silent shortfall,
     reached from the other side.

     What does NOT travel is downwards-on: re-ticking a case does not revive
     its subtasks, because turning one off was a deliberate "not that one" a
     moment earlier and undoing it would be the sheet arguing with you. */
  const toggle = useCallback((id) => {
    setRows((list) => {
      const target = list.find((r) => r.id === id)
      if (!target) return list
      const next = target.include === false

      const byRef = new Map(list.map((r) => [r.ref, r]))
      const changed = new Set([target.ref])

      if (next) {
        // on: walk up through caseRef / under to the root
        let cursor = target
        const guard = new Set()
        while (cursor && !guard.has(cursor.ref)) {
          guard.add(cursor.ref)
          const parentRef = cursor.caseRef || cursor.under
          if (!parentRef) break
          const parent = byRef.get(parentRef)
          if (!parent) break
          changed.add(parent.ref)
          cursor = parent
        }
      } else {
        // off: everything that hangs from it, to any depth
        let grew = true
        while (grew) {
          grew = false
          for (const r of list) {
            if (changed.has(r.ref)) continue
            if ((r.caseRef && changed.has(r.caseRef)) || (r.under && changed.has(r.under))) {
              changed.add(r.ref)
              grew = true
            }
          }
        }
      }

      return list.map((r) => (changed.has(r.ref) ? { ...r, include: next } : r))
    })
  }, [])

  const chosen = rows.filter((r) => r.include !== false)
  const proposedCases = rows.filter((r) => r.kind === 'case' && r.include !== false)

  const counts = useMemo(() => ({
    cases: chosen.filter((r) => r.kind === 'case').length,
    entries: chosen.filter((r) => r.kind === 'entry').length,
    subtasks: chosen.filter((r) => r.kind === 'subtask').length,
  }), [chosen])

  const tally = [
    counts.cases ? `${counts.cases} ${counts.cases === 1 ? 'case' : 'cases'}` : '',
    counts.entries ? `${counts.entries} ${counts.entries === 1 ? 'entry' : 'entries'}` : '',
    counts.subtasks ? `${counts.subtasks} ${counts.subtasks === 1 ? 'subtask' : 'subtasks'}` : '',
  ].filter(Boolean).join(', ')

  /* Only the fields the server reads, and only the rows still ticked. Sending
     the whole row back would hand the server `include` and `why` to ignore;
     sending exactly what will be written keeps the wire honest about what this
     button does. */
  const payload = () => chosen.map((r) => ({
    ref: r.ref,
    kind: r.kind,
    name: r.kind === 'case' ? String(r.name || '').trim() : undefined,
    title: r.kind === 'case' ? undefined : String(r.title || '').trim(),
    caseId: r.caseId || undefined,
    caseRef: r.caseRef || undefined,
    under: r.under || undefined,
    dueText: r.dueText || null,
    priority: r.priority || 'normal',
  }))

  if (!rows.length) {
    return (
      <div className="filing filing--none">
        <p className="filing__summary">{result.summary || 'nothing on the pad looked like work to file.'}</p>
        <div className="filing__foot">
          <Pill onClick={onDiscard}>Back to the pad</Pill>
        </div>
      </div>
    )
  }

  return (
    <div className="filing">
      <header className="filing__head">
        <div className="filing__headline">
          <span className="filing__count">{rows.length} proposed</span>
          <button type="button" className="filing__close" onClick={onDiscard} title="Back to the pad">
            <X size={14} aria-hidden="true" />
          </button>
        </div>
        {result.summary ? <p className="filing__summary">{result.summary}</p> : null}
        <p className="filing__note">nothing is written until you file it.</p>
      </header>

      <ul className="filing__list">
        {rows.map((row) => (
          <Row
            key={row.id}
            row={row}
            cases={cases}
            proposedCases={proposedCases}
            now={now}
            onChange={(next) => patch(row.id, next)}
            onToggle={() => toggle(row.id)}
          />
        ))}
      </ul>

      {error ? <p className="filing__error">{error}</p> : null}

      <footer className="filing__foot">
        <span className="filing__tally">{tally || 'nothing selected'}</span>
        <Pill onClick={onDiscard} disabled={busy}>Discard</Pill>
        <Pill
          active
          disabled={busy || !chosen.length}
          onClick={() => onApply(payload())}
        >
          {busy ? 'filing…' : `File ${chosen.length}`}
        </Pill>
      </footer>
    </div>
  )
}
