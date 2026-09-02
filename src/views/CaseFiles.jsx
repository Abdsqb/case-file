import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Check, Plus, RotateCcw, Trash2 } from 'lucide-react'

import {
  Card,
  CardHead,
  DatePopover,
  EmptyState,
  Field,
  IconMenu,
  Metric,
  Meter,
  Pill,
  PillSelect,
  Segmented,
  Toggle,
  Trend,
} from '../ui/primitives.jsx'
import { DotMatrix, MiniBars } from '../ui/charts.jsx'
import IsoCase from '../ui/IsoCase.jsx'
import api from '../lib/api.js'
import { applyWalk, siblingWalk } from '../lib/reorder.js'
import {
  caseStats,
  globalStats,
  dailySeries,
  dayDiff,
  flattenEntries,
  rangeOf,
  recommendations,
  statusTone,
} from '../lib/metrics.js'

/* ============================================================================
   CaseFiles — the case detail screen, and the app's real CRUD surface.

   Everything above the entry list is instrumentation for the selected case;
   everything in the entry list is a write. Writes go through src/lib/api.js and
   are followed by the parent's `onMutate()` refetch. Row-level writes are
   optimistic, but the optimism is always released — on success the overlay is
   dropped once the refetch has landed, on failure it is dropped immediately and
   the error surfaces. A failed write never leaves a lie on screen.
============================================================================ */

const PRIORITY_OPTIONS = [
  { value: 'low', label: 'Low' },
  { value: 'normal', label: 'Normal' },
  { value: 'high', label: 'High' },
]

const FILTER_OPTIONS = [
  { value: 'all', label: 'All' },
  { value: 'open', label: 'Open' },
  { value: 'overdue', label: 'Overdue' },
  { value: 'done', label: 'Closed' },
]

const MATRIX_OPTIONS = [
  { value: 14, label: '2 weeks' },
  { value: 28, label: '4 weeks' },
  { value: 56, label: '8 weeks' },
]

const SORTS = [
  { value: 'due', label: 'Due date' },
  { value: 'priority', label: 'Priority' },
  { value: 'newest', label: 'Newest first' },
]

const PRIORITY_RANK = { high: 0, normal: 1, low: 2 }

const DAY_ABBR = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function cx(...parts) {
  return parts.filter(Boolean).join(' ')
}

function toMs(value) {
  if (value === null || value === undefined || value === '') return null
  const n = typeof value === 'number' ? value : Number(value)
  if (Number.isFinite(n)) return n
  const parsed = Date.parse(String(value))
  return Number.isFinite(parsed) ? parsed : null
}

function shortDate(ms) {
  const t = toMs(ms)
  if (t === null) return ''
  const d = new Date(t)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

/** the sentence under a title: how this entry stands relative to now. */
function dueSentence(due, now, completed, inherited) {
  if (completed) return 'closed'
  const t = toMs(due)
  if (t === null) return 'no due date'
  const diff = dayDiff(t, now)
  const prefix = inherited ? 'inherited · ' : ''
  if (!Number.isFinite(diff)) return `${prefix}no due date`
  if (diff < 0) return `${prefix}${Math.abs(diff)}d late`
  if (diff === 0) return `${prefix}due today`
  if (diff === 1) return `${prefix}due tomorrow`
  return `${prefix}due in ${diff}d`
}

function sum(list) {
  let total = 0
  for (const v of list) total += Number.isFinite(v) ? v : 0
  return total
}

/** direction of a series: the trailing window against the one before it. */
function seriesDir(series, window = 7) {
  const arr = Array.isArray(series) ? series : []
  if (arr.length < 2) return 'up'
  const w = Math.max(1, Math.min(window, Math.floor(arr.length / 2)))
  const recent = sum(arr.slice(arr.length - w))
  const prior = sum(arr.slice(arr.length - 2 * w, arr.length - w))
  return recent >= prior ? 'up' : 'down'
}

/**
 * Cases in tree order: roots by sortOrder, each followed by its children.
 * Cycles and orphans are tolerated — this data comes off the wire.
 */
function orderCases(projects) {
  const list = Array.isArray(projects) ? projects.filter(Boolean) : []
  const byParent = new Map()
  const ids = new Set()

  for (const p of list) ids.add(p.id)
  for (const p of list) {
    const key = p.parentId !== null && p.parentId !== undefined && ids.has(p.parentId) ? p.parentId : null
    if (!byParent.has(key)) byParent.set(key, [])
    byParent.get(key).push(p)
  }
  for (const arr of byParent.values()) {
    arr.sort((a, b) => {
      const sa = Number.isFinite(a.sortOrder) ? a.sortOrder : 0
      const sb = Number.isFinite(b.sortOrder) ? b.sortOrder : 0
      if (sa !== sb) return sa - sb
      return String(a.id).localeCompare(String(b.id), undefined, { numeric: true })
    })
  }

  const seen = new Set()
  const out = []
  const walk = (key, depth) => {
    const kids = byParent.get(key) || []
    for (const p of kids) {
      if (seen.has(p.id)) continue
      seen.add(p.id)
      out.push({ project: p, depth })
      if (depth < 4) walk(p.id, depth + 1)
    }
  }
  walk(null, 0)
  for (const p of list) {
    if (seen.has(p.id)) continue
    seen.add(p.id)
    out.push({ project: p, depth: 0 })
  }
  return out
}

/** siblings of a case, in the order the server will move it through. */
function siblingIndex(ordered, id) {
  const self = ordered.find((o) => o.project.id === id)
  if (!self) return { index: -1, count: 0 }
  const parent = self.project.parentId ?? null
  const sibs = ordered.filter((o) => (o.project.parentId ?? null) === parent)
  return { index: sibs.findIndex((o) => o.project.id === id), count: sibs.length }
}

function HeadRight({ children }) {
  return <span className="row">{children}</span>
}

/* ------------------------------------------------------------------ *
 * Composer — one row that creates an entry. Local state, so typing
 * does not re-render the entry list underneath it.
 * ------------------------------------------------------------------ */

function Composer({ disabled, onCreate }) {
  const [title, setTitle] = useState('')
  const [priority, setPriority] = useState('normal')
  const [due, setDue] = useState(null)
  const [dateOpen, setDateOpen] = useState(false)
  const dueRef = useRef(null)

  const submit = async () => {
    const text = title.trim()
    if (!text || disabled) return
    const ok = await onCreate({ title: text, priority, dueDate: due })
    if (ok) {
      setTitle('')
      setDue(null)
    }
  }

  return (
    <div className="composer">
      <Field
        className="composer__field"
        value={title}
        onChange={setTitle}
        placeholder="Log an entry"
        disabled={disabled}
        aria-label="New entry title"
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            submit()
          }
        }}
      />
      <div className="composer__actions">
        <Pill
          ref={dueRef}
          className="pill--micro"
          disabled={disabled}
          onClick={() => setDateOpen((v) => !v)}
          aria-label={due === null ? 'Set a due date' : `Due ${shortDate(due)}. Change the due date`}
        >
          {due === null ? 'no date' : shortDate(due)}
        </Pill>
        {dateOpen ? (
          <DatePopover
            anchorRef={dueRef}
            value={due}
            onSelect={(iso, date) => setDue(date.getTime())}
            onClear={() => setDue(null)}
            onClose={() => setDateOpen(false)}
          />
        ) : null}
        <PillSelect
          className="pill--micro"
          value={priority}
          options={PRIORITY_OPTIONS}
          onChange={setPriority}
          label="Priority for the new entry"
          align="end"
        />
        <Pill active onClick={submit} disabled={disabled || !title.trim()}>
          <Plus size={13} strokeWidth={1.5} aria-hidden="true" />
          Add
        </Pill>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * SubComposer — the dashed row that adds one subtask.
 * ------------------------------------------------------------------ */

function SubComposer({ disabled, onCreate, onCancel }) {
  const [title, setTitle] = useState('')

  const submit = async () => {
    const text = title.trim()
    if (!text || disabled) return
    const ok = await onCreate(text)
    if (ok) setTitle('')
  }

  return (
    <div className="composer composer--sub">
      <Field
        className="composer__field"
        value={title}
        onChange={setTitle}
        placeholder="Add a subtask"
        autoFocus
        disabled={disabled}
        aria-label="New subtask title"
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            submit()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            onCancel()
          }
        }}
      />
      <div className="composer__actions">
        <Pill active onClick={submit} disabled={disabled || !title.trim()}>
          Add
        </Pill>
        <Pill className="pill--ghost" onClick={onCancel}>
          Cancel
        </Pill>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * EntryRow — one line of the CRUD surface.
 * ------------------------------------------------------------------ */

function EntryRow({
  entry,
  now,
  isSub = false,
  inheritedDue = null,
  disabled = false,
  subCount = 0,
  subsOpen = true,
  from = null,
  onToggleSubs,
  onPatch,
  onDelete,
  onAddSub,
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(entry.title || '')
  const [dateOpen, setDateOpen] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const dueRef = useRef(null)
  const inputRef = useRef(null)
  const confirmRef = useRef(false)
  confirmRef.current = confirm

  useEffect(() => {
    if (!editing) setDraft(entry.title || '')
  }, [entry.title, editing])

  useEffect(() => {
    if (!editing) return
    const node = inputRef.current
    if (!node) return
    node.focus()
    node.select()
  }, [editing])

  // an armed delete disarms itself, so a stray click never leaves a live trap
  useEffect(() => {
    if (!confirm) return undefined
    const id = setTimeout(() => setConfirm(false), 5000)
    return () => clearTimeout(id)
  }, [confirm])

  const ownDue = toMs(entry.dueDate)
  const effectiveDue = ownDue === null ? toMs(inheritedDue) : ownDue
  const inherited = ownDue === null && effectiveDue !== null
  const completed = !!entry.completed
  const tone = completed ? 'done' : statusTone(effectiveDue, now)
  const statusMod = completed ? 'done' : tone === 'none' ? 'open' : tone

  const commit = () => {
    const next = draft.trim()
    setEditing(false)
    if (!next || next === entry.title) {
      setDraft(entry.title || '')
      return
    }
    onPatch({ title: next })
  }

  const dueLabel = effectiveDue === null ? 'no date' : shortDate(effectiveDue)
  const dueAria =
    effectiveDue === null
      ? 'No due date. Set one'
      : inherited
        ? `Due ${dueLabel}, inherited from the parent entry. Set an own due date`
        : `Due ${dueLabel}. Change the due date`

  return (
    <div
      className={cx(
        'entry',
        completed && 'entry--done',
        !completed && tone === 'overdue' && 'entry--overdue',
        (confirm || dateOpen || editing) && 'is-open'
      )}
    >
      <span className={`entry__status entry__status--${statusMod}`} aria-hidden="true" />

      <div className="entry__main">
        {editing ? (
          <input
            ref={inputRef}
            className="entry__title-input"
            type="text"
            value={draft}
            autoComplete="off"
            spellCheck="false"
            aria-label="Entry title"
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                commit()
              } else if (e.key === 'Escape') {
                e.preventDefault()
                e.stopPropagation()
                setDraft(entry.title || '')
                setEditing(false)
              }
            }}
          />
        ) : (
          <button
            type="button"
            className="entry__title"
            onClick={() => setEditing(true)}
            aria-label={`${entry.title || 'Untitled entry'} — edit title`}
          >
            {entry.title || 'Untitled entry'}
          </button>
        )}

        <div className={cx('entry__meta', !completed && tone === 'overdue' && 'entry__meta--hot')}>
          <span className={cx(inherited && 'dim')}>{dueSentence(effectiveDue, now, completed, inherited)}</span>
          {from ? <span className="entry__case">{from}</span> : null}
          {!completed && entry.priority === 'high' ? <span className="entry__case">high</span> : null}
          {isSub ? <span className="entry__case">subtask</span> : null}
          {!isSub && subCount > 0 ? (
            <button
              type="button"
              className="subtasks__toggle"
              onClick={onToggleSubs}
              aria-expanded={subsOpen}
            >
              {subsOpen ? 'hide' : 'show'} {subCount} {subCount === 1 ? 'subtask' : 'subtasks'}
            </button>
          ) : null}
        </div>
      </div>

      <div className="entry__cluster">
        <Pill
          ref={dueRef}
          className={cx('pill--micro', inherited && 'dim')}
          disabled={disabled}
          onClick={() => setDateOpen((v) => !v)}
          aria-label={dueAria}
        >
          {dueLabel}
        </Pill>
        {dateOpen ? (
          <DatePopover
            anchorRef={dueRef}
            value={ownDue}
            onSelect={(iso, date) => onPatch({ dueDate: date.getTime() })}
            onClear={() => onPatch({ dueDate: null })}
            onClose={() => setDateOpen(false)}
          />
        ) : null}
        <PillSelect
          className="pill--micro"
          value={entry.priority || 'normal'}
          options={PRIORITY_OPTIONS}
          onChange={(p) => onPatch({ priority: p })}
          label={`Priority for ${entry.title || 'this entry'}`}
          align="end"
          disabled={disabled}
        />
      </div>

      <div className="entry__actions">
        {!isSub ? (
          <button type="button" className="entry__action" onClick={onAddSub} disabled={disabled}>
            <Plus size={13} strokeWidth={1.5} aria-hidden="true" />
            Sub
          </button>
        ) : null}

        <button
          type="button"
          className="entry__action"
          onClick={() => onPatch({ completed: !completed })}
          disabled={disabled}
        >
          {completed ? (
            <>
              <RotateCcw size={13} strokeWidth={1.5} aria-hidden="true" />
              Reopen
            </>
          ) : (
            <>
              <Check size={13} strokeWidth={1.5} aria-hidden="true" />
              Close
            </>
          )}
        </button>

        <button
          type="button"
          className={cx('entry__action', confirm && 'entry__action--danger')}
          disabled={disabled}
          aria-label={
            confirm
              ? `Confirm deleting ${entry.title || 'this entry'}`
              : `Delete ${entry.title || 'this entry'}`
          }
          onKeyDown={(e) => {
            if (e.key === 'Escape' && confirmRef.current) {
              e.preventDefault()
              e.stopPropagation()
              setConfirm(false)
            }
          }}
          onClick={() => {
            if (confirmRef.current) {
              setConfirm(false)
              onDelete()
            } else {
              setConfirm(true)
            }
          }}
        >
          {confirm ? 'Confirm' : <Trash2 size={13} strokeWidth={1.5} aria-hidden="true" />}
        </button>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * CaseFiles
 * ------------------------------------------------------------------ */

export function CaseFiles({ projects, now, activeCaseId, onSelectCase, onMutate }) {
  const list = useMemo(() => (Array.isArray(projects) ? projects.filter(Boolean) : []), [projects])
  const ordered = useMemo(() => orderCases(list), [list])

  const activeId = useMemo(() => {
    if (list.some((p) => p.id === activeCaseId)) return activeCaseId
    return ordered.length ? ordered[0].project.id : null
  }, [list, ordered, activeCaseId])

  const activeCase = useMemo(() => list.find((p) => p.id === activeId) || null, [list, activeId])

  /* ---- write plumbing -------------------------------------------- */

  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(0)
  const [patches, setPatches] = useState({})
  const [removed, setRemoved] = useState([])
  const alive = useRef(true)
  const timers = useRef([])

  useEffect(
    () => () => {
      alive.current = false
      for (const id of timers.current) clearTimeout(id)
      timers.current = []
    },
    []
  )

  const later = useCallback((fn) => {
    const id = setTimeout(() => {
      timers.current = timers.current.filter((t) => t !== id)
      if (alive.current) fn()
    }, 0)
    timers.current.push(id)
  }, [])

  const write = useCallback(
    async (fn) => {
      setError(null)
      setBusy((b) => b + 1)
      try {
        const result = await fn()
        if (onMutate) await onMutate()
        return { ok: true, result }
      } catch (err) {
        if (alive.current) {
          setError(err && err.message ? err.message : 'the write failed.')
        }
        return { ok: false, error: err }
      } finally {
        if (alive.current) setBusy((b) => b - 1)
      }
    },
    [onMutate]
  )

  const dropPatch = useCallback((taskId) => {
    setPatches((prev) => {
      const key = String(taskId)
      if (!(key in prev)) return prev
      const next = { ...prev }
      delete next[key]
      return next
    })
  }, [])

  /** optimistic entry patch; the overlay is always released. */
  const patchTask = useCallback(
    async (taskId, patch) => {
      const key = String(taskId)
      setPatches((prev) => ({ ...prev, [key]: { ...(prev[key] || {}), ...patch } }))
      const res = await write(() => api.updateTask(taskId, patch))
      if (res.ok) later(() => dropPatch(taskId))
      else dropPatch(taskId)
      return res.ok
    },
    [write, later, dropPatch]
  )

  const dropRemoved = useCallback((taskId) => {
    setRemoved((prev) => (prev.includes(taskId) ? prev.filter((id) => id !== taskId) : prev))
  }, [])

  const removeTask = useCallback(
    async (taskId) => {
      setRemoved((prev) => (prev.includes(taskId) ? prev : [...prev, taskId]))
      const res = await write(() => api.deleteTask(taskId))
      if (res.ok) later(() => dropRemoved(taskId))
      else dropRemoved(taskId)
      return res.ok
    },
    [write, later, dropRemoved]
  )

  /* ---- view state ------------------------------------------------ */

  const [filter, setFilter] = useState('all')
  const [sort, setSort] = useState('due')
  const [collapsed, setCollapsed] = useState([])
  const [subComposer, setSubComposer] = useState(null)
  const [caseForm, setCaseForm] = useState(null) // { mode:'new'|'sub'|'rename', id, value }
  const [caseConfirm, setCaseConfirm] = useState(null)
  const [matrixDays, setMatrixDays] = useState(28)
  // Which project's entries the list shows: the case itself, or one of its
  // sub-cases. null means the case itself.
  const [subScope, setSubScope] = useState(null)

  // a case swap must not carry another case's row state with it
  useEffect(() => {
    setSubComposer(null)
    setCollapsed([])
    setCaseConfirm(null)
    setSubScope(null)
  }, [activeId])

  /* ---- metrics --------------------------------------------------- */

  /* Sub-cases of the open case, and the project the entry list is pointed at.
     Entries belong to a project, so switching sub-case switches which project
     you are reading and writing — it is a scope, not a filter. */
  const subCases = useMemo(
    () =>
      list
        .filter((p) => p && p.parentId === activeId)
        .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0)),
    [list, activeId]
  )

  const entryProject = useMemo(() => {
    if (subScope !== null && subScope !== activeId) {
      const found = list.find((p) => p && p.id === subScope)
      if (found) return found
    }
    return activeCase
  }, [list, subScope, activeId, activeCase])

  /* The "All" slot is an aggregate, not just the parent's own entries: it lists
     the case's entries plus every sub-case's, so nothing is hidden behind a tab
     you did not think to open. A named sub-case slot shows only its own. */
  const aggregating = subScope === null
  const entrySources = useMemo(
    () => (aggregating ? [activeCase, ...subCases].filter(Boolean) : [entryProject].filter(Boolean)),
    [aggregating, activeCase, subCases, entryProject]
  )

  const entryStats = useMemo(
    () => (aggregating ? globalStats(entrySources, now) : caseStats(entryProject, now)),
    [aggregating, entrySources, entryProject, now]
  )

  const scope = useMemo(() => (activeCase ? [activeCase] : []), [activeCase])
  const stats = useMemo(() => caseStats(activeCase, now), [activeCase, now])
  const series = useMemo(() => dailySeries(scope, now, 30), [scope, now])
  const matrixSeries = useMemo(() => dailySeries(scope, now, matrixDays), [scope, now, matrixDays])
  const openedRange = useMemo(() => rangeOf(series.opened), [series])
  const flat = useMemo(() => flattenEntries(scope), [scope])

  const subDir = useMemo(() => {
    let recent = 0
    let prior = 0
    for (const e of flat) {
      if (!e.isSub) continue
      const age = dayDiff(now, e.createdAt)
      if (!Number.isFinite(age)) continue
      if (age < 7) recent += 1
      else if (age < 14) prior += 1
    }
    return recent >= prior ? 'up' : 'down'
  }, [flat, now])

  const tip = useMemo(() => {
    const tips = recommendations(scope, now)
    return tips.find((t) => t.meta === 'Analysis') || tips[0] || null
  }, [scope, now])

  const isoEntries = useMemo(
    () =>
      flat
        .map((e) => ({
          id: e.id,
          title: e.title,
          tone: e.completed
            ? 'done'
            : statusTone(e.dueDate, now) === 'overdue'
              ? 'overdue'
              : 'normal',
          // Carried so a node can identify itself on hover. IsoCase formats it.
          dueDate: e.dueDate,
          priority: e.priority,
          completed: e.completed,
          isSub: e.isSub,
        }))
        .filter((e) => filter !== 'open' || e.tone !== 'done'),
    [flat, now, filter]
  )

  const matrixColumns = useMemo(() => {
    const arr = matrixSeries.opened
    const peak = arr.reduce((m, v) => (v > m ? v : m), 0)
    return peak > 0 ? arr.map((v) => v / peak) : arr.map(() => 0)
  }, [matrixSeries])

  const matrixLabels = useMemo(() => {
    const first = new Date(now)
    if (Number.isNaN(first.getTime())) return DAY_ABBR
    first.setHours(0, 0, 0, 0)
    first.setDate(first.getDate() - (matrixDays - 1))
    const out = []
    for (let i = 0; i < 7; i += 1) out.push(DAY_ABBR[(first.getDay() + i) % 7])
    return out
  }, [now, matrixDays])

  /* ---- the entry list -------------------------------------------- */

  const overlay = useCallback(
    (task) => {
      const patch = patches[String(task.id)]
      return patch ? { ...task, ...patch } : task
    },
    [patches]
  )

  const matches = useCallback(
    (entry, due) => {
      if (filter === 'all') return true
      if (filter === 'done') return !!entry.completed
      if (filter === 'open') return !entry.completed
      return !entry.completed && statusTone(due, now) === 'overdue'
    },
    [filter, now]
  )

  const rows = useMemo(() => {
    const built = []

    for (const project of entrySources) {
      const source = Array.isArray(project.tasks) ? project.tasks : []
      // Only worth naming when the list is mixing projects together.
      const from = aggregating && project.id !== activeId ? project.name || 'Untitled' : null

      for (const raw of source) {
        if (!raw || removed.includes(raw.id)) continue
        const task = overlay(raw)
        const taskDue = toMs(task.dueDate)

        const subs = (Array.isArray(raw.subtasks) ? raw.subtasks : [])
          .filter((s) => s && !removed.includes(s.id))
          .map(overlay)
          .map((s) => ({ sub: s, due: toMs(s.dueDate) === null ? taskDue : toMs(s.dueDate) }))

        const keptSubs = subs.filter(({ sub, due }) => matches(sub, due))
        if (!matches(task, taskDue) && keptSubs.length === 0) continue

        built.push({ task, due: taskDue, subs: filter === 'all' ? subs : keptSubs, from })
      }
    }

    const rank = (r) => PRIORITY_RANK[r.task.priority] ?? 1
    built.sort((a, b) => {
      if (sort === 'newest') {
        return (toMs(b.task.createdAt) ?? 0) - (toMs(a.task.createdAt) ?? 0)
      }
      if (sort === 'priority') {
        const d = rank(a) - rank(b)
        if (d !== 0) return d
      }
      const ad = a.due
      const bd = b.due
      if (ad === null && bd === null) return (toMs(a.task.createdAt) ?? 0) - (toMs(b.task.createdAt) ?? 0)
      if (ad === null) return 1
      if (bd === null) return -1
      if (ad !== bd) return ad - bd
      return (toMs(a.task.createdAt) ?? 0) - (toMs(b.task.createdAt) ?? 0)
    })

    return built
  }, [entrySources, aggregating, activeId, removed, overlay, matches, filter, sort])

  /* ---- case writes ------------------------------------------------ */

  const openNewCase = () => {
    setCaseConfirm(null)
    setCaseForm({ mode: 'new', id: null, value: '' })
  }

  const submitCaseForm = async () => {
    if (!caseForm) return
    const name = caseForm.value.trim()
    if (!name) return

    if (caseForm.mode === 'rename') {
      const res = await write(() => api.renameProject(caseForm.id, name))
      if (res.ok) setCaseForm(null)
      return
    }

    const parentId = caseForm.mode === 'sub' ? caseForm.id : null
    const res = await write(() => api.createProject(name, parentId))
    if (res.ok) {
      setCaseForm(null)
      const created = res.result
      if (created && created.id !== undefined) {
        // A new sub-case becomes the entry scope. A new top-level case becomes
        // the open case. Promoting a sub-case to "open case" would strand it,
        // since the top strip lists roots only.
        if (parentId !== null) setSubScope(created.id)
        else if (onSelectCase) onSelectCase(created.id)
      }
    }
  }

  const deleteCase = async () => {
    const id = caseConfirm
    if (id === null || id === undefined) return
    const index = ordered.findIndex((o) => o.project.id === id)
    const fallback = ordered.filter((o) => o.project.id !== id)[Math.max(0, index - 1)]
    const res = await write(() => api.deleteProject(id))
    if (res.ok) {
      setCaseConfirm(null)
      if (id === subScope) setSubScope(null)
      // Only re-point the open case if the open case is what went away.
      if (id === activeId && onSelectCase) onSelectCase(fallback ? fallback.project.id : null)
    }
  }

  const moveCase = (id, direction) => {
    write(() => api.moveProject(id, direction))
  }

  /**
   * Commit a drag. The strip is shown in tree order (roots, each followed by its
   * children) but the API can only swap a case with an adjacent SIBLING, so a
   * raw strip index is not a valid destination on its own.
   *
   * So: simulate the move in strip order, read back what position that implies
   * among the case's own siblings, and walk it there one swap at a time. A drop
   * that does not change sibling order — dragging across another parent's
   * children, say — resolves to zero steps and is simply a no-op rather than a
   * write that would reparent something the user did not ask to reparent.
   */
  const reorderCase = (id, toIndex) => {
    const walk = siblingWalk(ordered.map((o) => o.project), id, toIndex)
    if (!walk) return
    write(() => applyWalk(api.moveProject, id, walk))
  }

  const caseMenu = useMemo(() => {
    if (!activeCase) return []
    const { index, count } = siblingIndex(ordered, activeCase.id)
    return [
      {
        key: 'rename',
        label: 'Rename case',
        onClick: () => {
          setCaseConfirm(null)
          setCaseForm({ mode: 'rename', id: activeCase.id, value: activeCase.name || '' })
        },
      },
      {
        key: 'up',
        label: 'Move up',
        disabled: index <= 0,
        onClick: () => moveCase(activeCase.id, 'up'),
      },
      {
        key: 'down',
        label: 'Move down',
        disabled: index === -1 || index >= count - 1,
        onClick: () => moveCase(activeCase.id, 'down'),
      },
      {
        key: 'sub',
        label: 'Add sub-case',
        onClick: () => {
          setCaseConfirm(null)
          setCaseForm({ mode: 'sub', id: activeCase.id, value: '' })
        },
      },
      {
        key: 'delete',
        label: 'Delete case',
        danger: true,
        onClick: () => {
          setCaseForm(null)
          setCaseConfirm(activeCase.id)
        },
      },
    ]
    // moveCase / write are stable enough for this menu; rebuilt on every data change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeCase, ordered, write])

  /* The sub-case bar. Slot 0 is the case itself — it is the parent, not a
     sub-case, so it is anchored: it cannot be dragged and nothing can be
     dropped ahead of it. */
  const subMenuFor = (project) => [
    {
      key: 'rename',
      label: 'Rename sub-case',
      onClick: () => {
        setCaseConfirm(null)
        setCaseForm({ mode: 'rename', id: project.id, value: project.name || '' })
      },
    },
    {
      key: 'delete',
      label: 'Delete sub-case',
      danger: true,
      onClick: () => {
        setCaseForm(null)
        setCaseConfirm(project.id)
      },
    },
  ]

  const subItems = useMemo(
    () => [
      { value: activeId, label: 'All', fixed: true },
      ...subCases.map((project) => ({
        value: project.id,
        label: project.name || 'Untitled',
        menu: entryProject && entryProject.id === project.id ? subMenuFor(project) : undefined,
      })),
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeId, activeCase, subCases, entryProject]
  )

  // Strip index 0 is the anchored parent, so sub-case n sits at index n + 1.
  const reorderSub = (id, toIndex) => {
    const walk = siblingWalk(subCases, id, toIndex - 1)
    if (!walk) return
    write(() => applyWalk(api.moveProject, id, walk))
  }

  const segItems = useMemo(
    () =>
      ordered
        .filter(({ depth }) => depth === 0)
        .map(({ project }) => ({
          value: project.id,
          label: project.name || 'Untitled',
          menu: project.id === activeId ? caseMenu : undefined,
        })),
    [ordered, activeId, caseMenu]
  )

  /* ---- entry writes ----------------------------------------------- */

  const createEntry = async ({ title, priority, dueDate }) => {
    if (!entryProject) return false
    const res = await write(() => api.createTask(entryProject.id, { title, priority, dueDate }))
    return res.ok
  }

  const createSub = async (parentId, title) => {
    const res = await write(() => api.createSubtask(parentId, title))
    if (res.ok) {
      setCollapsed((prev) => prev.filter((id) => id !== parentId))
      setSubComposer(null)
    }
    return res.ok
  }

  const disabled = busy > 0
  const pct = Math.round((stats.completion || 0) * 100)
  const caseName = activeCase ? activeCase.name || 'Untitled case' : 'No case'

  /* What the delete confirmation is actually about.
     It used to print `caseName` — the OPEN case — while caseConfirm can hold a
     sub-case id, so choosing "Delete sub-case" asked you to confirm deleting the
     whole parent case instead. On a destructive, irreversible action, naming the
     wrong target is the worst possible bug: cancel and you cannot delete the
     sub-case at all, trust it and you delete something you were not shown. */
  const confirmTarget = useMemo(() => {
    if (caseConfirm === null || caseConfirm === undefined) return null
    const found = ordered.find((o) => o.project.id === caseConfirm)
    if (!found) return null
    const entries = flattenEntries([found.project]).length
    return {
      name: found.project.name || 'Untitled case',
      nested: found.depth > 0,
      entries,
      subs: ordered.filter((o) => o.project.parentId === found.project.id).length,
    }
  }, [caseConfirm, ordered])
  const nextDueText =
    stats.nextDue === null || stats.nextDue === undefined
      ? 'nothing scheduled'
      : `next due ${shortDate(stats.nextDue)}`

  const filterMenu = (target) => [
    { key: 'only', label: `Show ${target} only`, onClick: () => setFilter(target) },
    { key: 'all', label: 'Show everything', onClick: () => setFilter('all') },
  ]

  const sortMenu = SORTS.map((s) => ({
    key: s.value,
    label: `${sort === s.value ? '• ' : '  '}${s.label}`,
    onClick: () => setSort(s.value),
  }))

  /* ---- render ------------------------------------------------------ */

  return (
    <>
      <div className="viewhead">
        <div className="viewhead__left">
          <span className="section-label">My cases</span>
          {ordered.length ? (
            <Segmented
              items={segItems}
              value={activeId}
              onChange={(id) => onSelectCase && onSelectCase(id)}
              onReorder={reorderCase}
              label="Cases"
            />
          ) : (
            <span className="micro dim">no cases yet</span>
          )}
        </div>
        <div className="viewhead__right">
          <Toggle
            checked={filter === 'open'}
            onChange={(v) => setFilter(v ? 'open' : 'all')}
            label="Focus"
          />
          <Pill onClick={openNewCase}>
            <Plus size={13} strokeWidth={1.5} aria-hidden="true" />
            New case
          </Pill>
        </div>
      </div>

      {error ? (
        <div className="composer" role="alert" style={{ margin: '0 0 12px', borderColor: 'var(--hot)' }}>
          <span className="grow micro hot">{error}</span>
          <div className="composer__actions">
            <Pill className="pill--ghost" onClick={() => setError(null)}>
              Dismiss
            </Pill>
          </div>
        </div>
      ) : null}

      {caseForm ? (
        <div className="composer" style={{ margin: '0 0 12px' }}>
          <Field
            className="composer__field"
            label={
              caseForm.mode === 'rename'
                ? 'Rename case'
                : caseForm.mode === 'sub'
                  ? `New sub-case under ${caseName}`
                  : 'New case'
            }
            value={caseForm.value}
            onChange={(v) => setCaseForm((f) => (f ? { ...f, value: v } : f))}
            placeholder="Case name"
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                submitCaseForm()
              } else if (e.key === 'Escape') {
                e.preventDefault()
                e.stopPropagation()
                setCaseForm(null)
              }
            }}
          />
          <div className="composer__actions">
            <Pill active onClick={submitCaseForm} disabled={disabled || !caseForm.value.trim()}>
              {caseForm.mode === 'rename' ? 'Save' : 'Create'}
            </Pill>
            <Pill className="pill--ghost" onClick={() => setCaseForm(null)}>
              Cancel
            </Pill>
          </div>
        </div>
      ) : null}

      {confirmTarget ? (
        <div className="composer" role="alert" style={{ margin: '0 0 12px' }}>
          <span className="grow micro">
            delete {confirmTarget.nested ? 'sub-case' : 'case'} {confirmTarget.name}
            {confirmTarget.subs > 0
              ? `, its ${confirmTarget.subs} sub-${confirmTarget.subs === 1 ? 'case' : 'cases'}`
              : ''}
            {confirmTarget.entries > 0
              ? ` and ${confirmTarget.entries} ${confirmTarget.entries === 1 ? 'entry' : 'entries'}`
              : ''}
            ? this cannot be undone.
          </span>
          <div className="composer__actions">
            <Pill className="pill--danger" onClick={deleteCase} disabled={disabled}>
              <Trash2 size={13} strokeWidth={1.5} aria-hidden="true" />
              Delete {confirmTarget.nested ? 'sub-case' : 'case'}
            </Pill>
            <Pill className="pill--ghost" onClick={() => setCaseConfirm(null)}>
              Cancel
            </Pill>
          </div>
        </div>
      ) : null}

      {!activeCase ? (
        <div className="bento">
          <Card className="span-12">
            <div className="card__body">
              <EmptyState
                lead="No case is open."
                hint="Create a case and its entries, dates and structure appear here."
                action={
                  <Pill onClick={openNewCase}>
                    <Plus size={13} strokeWidth={1.5} aria-hidden="true" />
                    New case
                  </Pill>
                }
              />
            </div>
          </Card>
        </div>
      ) : (
        /* Deliberately NOT keyed on the case. Keying remounted every panel on
           the strip, which meant a switch tore the whole screen down and rebuilt
           it — cards flashing, numbers re-settling, the diagram re-assembling —
           when almost all of it was about to show the same thing in the same
           place. Now only what actually differs re-renders, and the ground in
           Case structure flows from one case's shape to the next. The one thing
           the remount did want is preserved: see the key on Composer. */
        <div className="bento">
          {/* ---------------- left column ---------------- */}
          <div className="span-3 stack">
            <Card tone="sage">
              <CardHead
                className="card__head"
                title="Completion"
                subtitle={caseName}
                right={
                  <IconMenu
                    items={[
                      { key: 'done', label: 'Show closed only', onClick: () => setFilter('done') },
                      { key: 'open', label: 'Show open only', onClick: () => setFilter('open') },
                      { key: 'all', label: 'Show everything', onClick: () => setFilter('all') },
                    ]}
                    label="Completion actions"
                  />
                }
              />
              <div className="card__body">
                {/* The % rides inside the value so it hugs the digits. `unit` is
                    spaced off the number, which is right for a word and wrong
                    for a symbol. */}
                <Metric
                  value={`${pct}%`}
                  sub={`${stats.done}/${stats.total} entries closed`}
                  tone="sage"
                />
                <div className="micro">
                  {stats.open} open · {stats.overdue} late
                </div>
              </div>
            </Card>

            <Card>
              <CardHead
                className="card__head"
                title="Open entries"
                subtitle="Logged per day · 30d"
                right={<Trend dir={seriesDir(series.opened)} />}
              />
              <div className="card__body card__body--tight">
                <MiniBars
                  data={series.opened}
                  height={64}
                  label={`Entries logged per day over the last 30 days in ${caseName}`}
                />
                <Metric
                  value={stats.open}
                  unit="open"
                  sub={`${openedRange.label} logged per day`}
                />
              </div>
            </Card>

            <Card>
              <CardHead className="card__head" title="Analysis" subtitle="Read from this case" />
              <div className="card__body">
                {tip ? (
                  <div className="tip">
                    <div className="tip__body">{tip.body}</div>
                    <div className="tip__meta">
                      <span>{tip.meta}</span>
                      <span className="tip__note">{tip.note}</span>
                    </div>
                    {tip.ref ? <div className="tip__note truncate">{tip.ref}</div> : null}
                  </div>
                ) : (
                  <EmptyState lead="Nothing to report." hint="Log an entry and the read updates." />
                )}
              </div>
            </Card>
          </div>

          {/* ---------------- centre ---------------- */}
          <Card className="span-6">
            <CardHead
              className="card__head"
              title={caseName}
              subtitle="Case structure"
              right={
                <HeadRight>
                  <span className="micro dim nowrap">
                    {isoEntries.length} {isoEntries.length === 1 ? 'node' : 'nodes'}
                  </span>
                  <IconMenu items={caseMenu} label={`Actions for ${caseName}`} />
                </HeadRight>
              }
            />
            <div className="card__body card__body--center">
              <div style={{ width: '100%', maxWidth: '560px', margin: '0 auto' }}>
                <IsoCase entries={isoEntries} completion={stats.completion} seed={activeCase.id} />
              </div>
            </div>
            <div className="card__foot">
              <span className="nowrap">{nextDueText}</span>
              <span style={{ flex: '0 1 220px', minWidth: '120px' }}>
                <Meter value={stats.completion} label={`Completion of ${caseName}`} />
              </span>
            </div>
          </Card>

          {/* ---------------- right column ---------------- */}
          <div className="span-3 stack">
            <Card>
              <CardHead
                className="card__head"
                title="Open"
                right={
                  <HeadRight>
                    <Trend dir={seriesDir(series.opened)} />
                    <IconMenu items={filterMenu('open')} label="Open entries actions" />
                  </HeadRight>
                }
              />
              <div className="card__body card__body--tight">
                <Metric size="sm" value={stats.open} unit="entries" sub={`${stats.total} logged`} />
              </div>
            </Card>

            <Card>
              <CardHead
                className="card__head"
                title="Overdue"
                right={
                  <HeadRight>
                    <Trend dir={seriesDir(series.overdue)} />
                    <IconMenu items={filterMenu('overdue')} label="Overdue actions" />
                  </HeadRight>
                }
              />
              <div className="card__body card__body--tight">
                <Metric
                  size="sm"
                  tone={stats.overdue > 0 ? 'hot' : undefined}
                  value={stats.overdue}
                  unit="entries"
                  sub={`${stats.dueSoon} due soon`}
                />
              </div>
            </Card>

            <Card>
              <CardHead
                className="card__head"
                title="Subtasks"
                right={
                  <HeadRight>
                    <Trend dir={subDir} />
                    <IconMenu
                      items={[
                        { key: 'expand', label: 'Expand all subtasks', onClick: () => setCollapsed([]) },
                        {
                          key: 'collapse',
                          label: 'Collapse all subtasks',
                          onClick: () => setCollapsed(rows.map((r) => r.task.id)),
                        },
                      ]}
                      label="Subtask actions"
                    />
                  </HeadRight>
                }
              />
              <div className="card__body card__body--tight">
                <Metric size="sm" value={stats.subs} unit="nested" sub={`under ${rows.length} entries`} />
              </div>
            </Card>

            {/* The matrix lives in this column rather than on a full-width row
                of its own: at 12 columns wide it was mostly empty ground, and
                the space under Subtasks was going unused. DotMatrix places its
                columns proportionally, so it reflows to the narrow slot. Rows
                drop from 12 to 8 to keep the block in proportion here. */}
            <Card>
              <CardHead
                className="card__head"
                title="Entries / week"
                subtitle="Logged per day"
                right={
                  <PillSelect
                    value={matrixDays}
                    options={MATRIX_OPTIONS}
                    onChange={setMatrixDays}
                    label="Matrix window"
                    align="end"
                  />
                }
              />
              <div className="card__body">
                <DotMatrix
                  columns={matrixColumns}
                  rows={8}
                  labels={matrixLabels}
                  label={`Entries logged per day over the last ${matrixDays} days`}
                />
              </div>
            </Card>
          </div>

          {/* ---------------- the entry list ---------------- */}
          <Card className="span-12">
            <CardHead
              className="card__head"
              title="Entries"
              subtitle={
                `${entryStats.open} open · ${entryStats.overdue} late · ${entryStats.total} logged` +
                (entryProject && entryProject.id !== activeId ? ` · in ${entryProject.name || 'sub-case'}` : '')
              }
              right={
                <HeadRight>
                  <PillSelect
                    value={filter}
                    options={FILTER_OPTIONS}
                    onChange={setFilter}
                    label="Filter entries"
                    align="end"
                  />
                  <IconMenu items={sortMenu} label="Sort entries" />
                </HeadRight>
              }
            />
            <div className="card__body">
              <div className="subbar">
                <span className="section-label">Sub-cases</span>
                <Segmented
                  items={subItems}
                  value={entryProject ? entryProject.id : activeId}
                  onChange={(id) => setSubScope(id === activeId ? null : id)}
                  onReorder={reorderSub}
                  label="Sub-cases"
                />
                <Pill
                  className="pill--micro"
                  disabled={disabled}
                  onClick={() => {
                    setCaseConfirm(null)
                    setCaseForm({ mode: 'sub', id: activeId, value: '' })
                  }}
                >
                  <Plus size={12} strokeWidth={1.5} aria-hidden="true" />
                  Sub-case
                </Pill>
              </div>

              {/* The single thing worth remounting on a switch: a half-typed
                  entry must not follow you into a different case. */}
              <Composer key={activeCase.id} disabled={disabled} onCreate={createEntry} />

              {rows.length === 0 ? (
                <EmptyState
                  lead={filter === 'all' ? 'No entries in this case yet.' : 'Nothing matches this filter.'}
                  hint={
                    filter === 'all'
                      ? 'Log the first one above — it lands here immediately.'
                      : 'Widen the filter to see the rest of the case.'
                  }
                  action={
                    filter === 'all' ? null : (
                      <Pill onClick={() => setFilter('all')}>Show everything</Pill>
                    )
                  }
                />
              ) : (
                <div className="entrylist">
                  {rows.map(({ task, due, subs, from }) => {
                    const open = !collapsed.includes(task.id)
                    const composing = subComposer === task.id
                    const showBlock = (open && subs.length > 0) || composing
                    return (
                      <Fragment key={task.id}>
                        <EntryRow
                          entry={task}
                          now={now}
                          disabled={disabled}
                          subCount={subs.length}
                          subsOpen={open}
                          from={from}
                          onToggleSubs={() =>
                            setCollapsed((prev) =>
                              prev.includes(task.id)
                                ? prev.filter((id) => id !== task.id)
                                : [...prev, task.id]
                            )
                          }
                          onPatch={(patch) => patchTask(task.id, patch)}
                          onDelete={() => removeTask(task.id)}
                          onAddSub={() => {
                            setCollapsed((prev) => prev.filter((id) => id !== task.id))
                            setSubComposer(task.id)
                          }}
                        />

                        {showBlock ? (
                          <div className="subtasks">
                            {open
                              ? subs.map(({ sub }) => (
                                  <EntryRow
                                    key={sub.id}
                                    entry={sub}
                                    now={now}
                                    isSub
                                    inheritedDue={due}
                                    disabled={disabled}
                                    onPatch={(patch) => patchTask(sub.id, patch)}
                                    onDelete={() => removeTask(sub.id)}
                                  />
                                ))
                              : null}
                            {composing ? (
                              <SubComposer
                                disabled={disabled}
                                onCreate={(title) => createSub(task.id, title)}
                                onCancel={() => setSubComposer(null)}
                              />
                            ) : null}
                          </div>
                        ) : null}
                      </Fragment>
                    )
                  })}
                </div>
              )}
            </div>
          </Card>
        </div>
      )}
    </>
  )
}

export default CaseFiles
