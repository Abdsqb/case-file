import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronRight, FolderPlus, Plus, RotateCcw, Trash2 } from 'lucide-react'

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
import CaseFlow from '../ui/CaseFlow.jsx'
import useDeck from '../ui/useDeck.js'
import { buildGraph } from '../lib/graph.js'
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
  urgencyTone,
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
  canDrag = false,
  dragging = false,
  accepts = false,
  dragHint = null,
  onToggleSubs,
  onPatch,
  onDelete,
  onAddSub,
  onDragStart,
  onDragEnd,
  onDropEntry,
}) {
  const [editing, setEditing] = useState(false)
  const [over, setOver] = useState(false)
  /* dragenter and dragleave fire again for every child the pointer crosses, so
     a plain boolean flickers the highlight off the moment the cursor moves from
     the row onto the title inside it. Counting enters against leaves is what
     makes the state describe the row rather than whatever is under the cursor. */
  const overDepth = useRef(0)
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
  // Same convention as the case pins: the status square on a row and the pin on
  // the diagram are the same fact, and must never disagree about it.
  const tone = completed ? 'done' : urgencyTone(effectiveDue, now)
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

  /* Editing has to switch dragging off: a draggable ancestor swallows the
     press-and-sweep that selects text, so the title field would become
     impossible to select inside. */
  const grabbable = canDrag && !editing && !disabled

  const leaveDrop = () => { overDepth.current = 0; setOver(false) }

  return (
    <div
      className={cx(
        'entry',
        completed && 'entry--done',
        !completed && tone === 'overdue' && 'entry--overdue',
        (confirm || dateOpen || editing) && 'is-open',
        dragging && 'entry--dragging',
        accepts && over && 'entry--drop'
      )}
      draggable={grabbable || undefined}
      title={dragHint || undefined}
      onDragStart={grabbable ? (e) => {
        e.dataTransfer.effectAllowed = 'move'
        /* Some browsers refuse to start a drag with no payload at all. */
        try { e.dataTransfer.setData('text/plain', String(entry.id)) } catch { /* ignore */ }
        if (onDragStart) onDragStart()
      } : undefined}
      onDragEnd={grabbable ? () => { leaveDrop(); if (onDragEnd) onDragEnd() } : undefined}
      /* Always attached, and each one asks whether it should act. Hanging them
         off `accepts` instead meant a row only became a drop target once React
         had re-rendered from the dragstart — fine for a hand-held drag, which
         has frames to spare, but it made the target depend on a render landing
         between two events that can arrive back to back. */
      onDragOver={(e) => {
        if (!accepts) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
      }}
      onDragEnter={() => { if (accepts) { overDepth.current += 1; setOver(true) } }}
      onDragLeave={() => {
        if (!accepts) return
        overDepth.current -= 1
        if (overDepth.current <= 0) leaveDrop()
      }}
      onDrop={(e) => {
        if (!accepts) return
        e.preventDefault()
        leaveDrop()
        if (onDropEntry) onDropEntry()
      }}
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
  const loadFolders = useCallback(async () => {
    try {
      setFolders(await api.listCaseFolders())
    } catch {
      // A folder list that will not load must not take the whole screen with
      // it — the cases are the point, the grouping is a convenience.
      setFolders([])
    }
  }, [])

  useEffect(() => { loadFolders() }, [loadFolders])

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

  /* Case folders. A folder groups cases in the strip and nothing more — the
     cases inside it stay standalone, each with its own screen, entries and
     diagram. That is the whole difference from a sub-case, which is scoped
     INSIDE its parent and rolls its entries up into it. */
  const [folders, setFolders] = useState([])
  /* Which folders are shut. Persisted, because a folder you collapsed to get the
     bar under control should stay collapsed next time you open the app —
     otherwise the tidying has to be redone every reload. */
  const [shut, setShut] = useState(() => {
    try {
      const raw = window.localStorage.getItem('case-folders-shut')
      return new Set(raw ? JSON.parse(raw) : [])
    } catch {
      return new Set()
    }
  })

  /* Expanding a folder can push the case bar onto a second line, and the whole
     page below it used to jump by exactly one row height. Nothing animates an
     auto height, so the head's measured height is written onto a wrapper that
     does have a transition — the layout still reflows instantly underneath, but
     the wrapper takes ~300ms to hand the space over. */
  const headRef = useRef(null)
  const [headH, setHeadH] = useState(null)

  useLayoutEffect(() => {
    const el = headRef.current
    if (!el || typeof ResizeObserver !== 'function') return undefined
    const ro = new ResizeObserver(() => setHeadH(el.offsetHeight))
    ro.observe(el)
    setHeadH(el.offsetHeight)
    return () => ro.disconnect()
  }, [])

  /* Switching case replays the arrival — the flanking cards fly back in from
     their own side, the deck's title lifts — so a switch reads as the screen
     being rebuilt for the new case rather than text quietly changing.

     Deliberately NOT a remount. Keying the panels on the case is exactly what
     used to tear the whole screen down and make it flicker, and it would also
     throw the diagram's morph away — the ground is meant to flow from one
     case's shape into the next, not pop. So the class goes onto the bento that
     is already standing, and only the cards around the diagram replay.

     Removing the class, reading offsetWidth and re-adding it is the part that
     actually matters: without that forced reflow the browser coalesces the two
     class changes into no change at all, and the animation never restarts. */
  const bentoRef = useRef(null)
  const lastCase = useRef(activeId)

  useLayoutEffect(() => {
    if (lastCase.current === activeId) return undefined
    lastCase.current = activeId

    const el = bentoRef.current
    if (!el) return undefined
    // The first case can land after the data does, mid-build. Letting both run
    // would start the cards, then restart them a frame later.
    if (el.closest('.view.is-building')) return undefined

    el.classList.remove('is-swapping')
    void el.offsetWidth
    el.classList.add('is-swapping')

    /* Dropped once spent — the same fail-safe as every other gated animation
       here. A class left on forever is how `both` fill strands content at
       opacity 0 when an animation cannot run. */
    const done = window.setTimeout(() => el.classList.remove('is-swapping'), 1000)
    return () => window.clearTimeout(done)
  }, [activeId])

  const toggleFolder = useCallback((id) => {
    setShut((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      try {
        window.localStorage.setItem('case-folders-shut', JSON.stringify([...next]))
      } catch {
        // A browser refusing storage is not a reason to refuse the collapse.
      }
      return next
    })
  }, [])
  const [folderForm, setFolderForm] = useState(null)     // {mode:'new'|'rename', id, value}
  const [folderConfirm, setFolderConfirm] = useState(null)

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

  /* The graph, built from the WHOLE project list rather than from flat.
     flat is scoped to the open case's own tasks, which was right for a diagram
     that only ever drew pins — but a graph has to show this case's sub-cases
     and their entries too, and those live in `list` as separate projects with
     parentId set. buildGraph walks that; see lib/graph.js. */
  const graph = useMemo(
    /* focus mirrors what the entries list beside it is showing: with the filter
       on "open only" the old diagram dropped closed pins, and the graph drops
       closed nodes for the same reason — the two halves of this panel are the
       same data and must not disagree. "done only" left the diagram whole, and
       still does. */
    () => buildGraph(list, { rootId: activeId, now, focus: filter === 'open' }),
    [list, activeId, now, filter]
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

  const submitFolderForm = async () => {
    if (!folderForm) return
    const value = folderForm.value.trim()
    if (!value) return
    const res = await write(() =>
      folderForm.mode === 'rename'
        ? api.renameCaseFolder(folderForm.id, value)
        : api.createCaseFolder(value)
    )
    if (res.ok) {
      setFolderForm(null)
      await loadFolders()
      // A folder you just made is the one you want to be looking at.
      if (folderForm.mode === 'new' && res.result && res.result.id) setFolderScope(res.result.id)
    }
  }

  const deleteFolder = async () => {
    const id = folderConfirm
    if (!id) return
    const res = await write(() => api.deleteCaseFolder(id))
    if (res.ok) {
      setFolderConfirm(null)
      await loadFolders()
      // The cases were unfiled rather than deleted, so the list itself changed.
      if (onMutate) await onMutate()
    }
  }

  const fileCase = async (caseId, folderId) => {
    const res = await write(() => api.fileProject(caseId, folderId))
    if (res.ok) {
      await loadFolders()
      if (onMutate) await onMutate()
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
      ...folders
        .filter((f) => f.id !== (activeCase.folderId ?? null))
        .map((f) => ({
          key: `file-${f.id}`,
          label: `Move to ${f.name}`,
          onClick: () => fileCase(activeCase.id, f.id),
        })),
      ...(activeCase.folderId
        ? [{
            key: 'unfile',
            label: 'Move out of folder',
            onClick: () => fileCase(activeCase.id, null),
          }]
        : []),
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
  }, [activeCase, ordered, write, folders])

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

  /* The bar, as groups. Folders come first in creation order, then everything
     unfiled — an unsorted case belongs at the end of the bar, not the front.
     This is ONE bar: a folder is a chip inside it that expands to show its
     cases, not a filter that hides the rest. */
  const roots = useMemo(() => ordered.filter(({ depth }) => depth === 0), [ordered])

  const chipFor = useCallback(
    ({ project }) => ({
      value: project.id,
      label: project.name || 'Untitled',
      menu: project.id === activeId ? caseMenu : undefined,
    }),
    [activeId, caseMenu]
  )

  const groups = useMemo(() => {
    const out = folders.map((f) => ({
      key: f.id,
      folder: f,
      items: roots.filter(({ project }) => (project.folderId ?? null) === f.id),
    }))
    const loose = roots.filter(({ project }) => !project.folderId)
    return { folders: out, loose }
  }, [folders, roots])

  /* A case cannot be open and invisible at the same time, so the folder holding
     it is marked even while shut — the chip itself carries the active state. */
  const activeFolderId = useMemo(() => {
    const found = roots.find(({ project }) => project.id === activeId)
    return found ? found.project.folderId ?? null : null
  }, [roots, activeId])

  const segItems = useMemo(() => groups.loose.map(chipFor), [groups, chipFor])

  /* ---- entry writes ----------------------------------------------- */

  const createEntry = async ({ title, priority, dueDate }) => {
    if (!entryProject) return false
    const res = await write(() => api.createTask(entryProject.id, { title, priority, dueDate }))
    return res.ok
  }

  /* Dragging one entry onto another files it under it.

     Only the id being dragged is kept here, plus the parent it already has, so
     a row can tell whether accepting the drop would actually change anything.
     Nothing is done optimistically: nesting moves a row from one list into
     another, and a guess at that which then had to be taken back would be worse
     than the refetch, which is immediate anyway. */
  const [drag, setDrag] = useState(null)   // { id, parentId }

  const nestTask = useCallback(
    async (childId, parentId) => {
      setDrag(null)
      if (!childId || !parentId || childId === parentId) return false
      const res = await write(() => api.updateTask(childId, { parentTaskId: parentId }))
      return res.ok
    },
    [write]
  )

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

  /* THE READINGS.
     ======================================================================
     Seven measurements of the open case, and they used to flank the screen in
     two columns of small panels. All seven at once is seven things asking to
     be read and no answer to which one you were meant to read first — and six
     of them are a number and a word, laid out as though they were charts.

     So they take turns. One at a time, each at its own height, paged with the
     wheel — the same deck the dashboard runs, from the same hook. What that
     buys is the room: the entries take the left of the screen and the drawing
     takes the right, and the measurements sit under the drawing rather than
     having two columns cut out of both.

     The order is the order you would ask them in: how far along, what is open,
     what is late, what is nested under it, the shape of the last month, the
     shape of the last few weeks, and last the one that is written rather than
     counted. */
  const readings = [
    { key: 'completion', label: 'Completion', node: (
        <Card aria-label="Completion">
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
      ) },

    { key: 'open', label: 'Open', node: (
        <Card aria-label="Open">
          <CardHead
            className="card__head"
            title="Open"
            subtitle={caseName}
            right={
              <HeadRight>
                <Trend dir={seriesDir(series.opened)} />
                <IconMenu items={filterMenu('open')} label="Open entries actions" />
              </HeadRight>
            }
          />
          <div className="card__body card__body--tight">
            <Metric value={stats.open} unit="entries" sub={`${stats.total} logged`} />
          </div>
        </Card>
      ) },

    { key: 'overdue', label: 'Overdue', node: (
        <Card aria-label="Overdue">
          <CardHead
            className="card__head"
            title="Overdue"
            subtitle={caseName}
            right={
              <HeadRight>
                <Trend dir={seriesDir(series.overdue)} />
                <IconMenu items={filterMenu('overdue')} label="Overdue actions" />
              </HeadRight>
            }
          />
          <div className="card__body card__body--tight">
            <Metric
              tone={stats.overdue > 0 ? 'hot' : undefined}
              value={stats.overdue}
              unit="entries"
              sub={`${stats.dueSoon} due soon`}
            />
          </div>
        </Card>
      ) },

    { key: 'subtasks', label: 'Subtasks', node: (
        <Card aria-label="Subtasks">
          <CardHead
            className="card__head"
            title="Subtasks"
            subtitle={caseName}
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
            <Metric value={stats.subs} unit="nested" sub={`under ${rows.length} entries`} />
          </div>
        </Card>
      ) },

    { key: 'logged', label: 'Open entries', node: (
        <Card aria-label="Open entries">
          <CardHead
            className="card__head"
            title="Open entries"
            subtitle="Logged per day · 30d"
            right={<Trend dir={seriesDir(series.opened)} />}
          />
          <div className="card__body card__body--tight">
            <MiniBars
              data={series.opened}
              height={72}
              label={`Entries logged per day over the last 30 days in ${caseName}`}
            />
            <Metric
              value={stats.open}
              unit="open"
              sub={`${openedRange.label} logged per day`}
            />
          </div>
        </Card>
      ) },

    { key: 'matrix', label: 'Entries / week', node: (
        <Card aria-label="Entries per week">
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
            {/* Ten rows rather than the eight it had in a quarter-width
                column: the block is as wide as the board above it now, and
                eight rows across that width is a strip rather than a matrix.
                DotMatrix places its columns proportionally, so this is the
                only number that had to change. */}
            <DotMatrix
              columns={matrixColumns}
              rows={10}
              labels={matrixLabels}
              label={`Entries logged per day over the last ${matrixDays} days`}
            />
          </div>
        </Card>
      ) },

    { key: 'analysis', label: 'Analysis', node: (
        <Card aria-label="Analysis">
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
      ) },
  ]

  /* A shorter throw than the dashboard's. That deck is a full-height panel and
     62px of offset is a fraction of it; this frame is a third the height, and
     the same number would have thrown the card behind clean out of the top. */
  const reading = useDeck(readings.length, { shift: 34 })

  /* ---- render ------------------------------------------------------ */

  return (
    <>
      {folderForm ? (
        <div className="composer" style={{ margin: '0 0 12px' }}>
          <Field
            className="grow"
            value={folderForm.value}
            onChange={(v) => setFolderForm({ ...folderForm, value: v })}
            placeholder={folderForm.mode === 'rename' ? 'New folder name' : 'Folder name, e.g. University'}
            autoFocus
            aria-label={folderForm.mode === 'rename' ? 'Rename folder' : 'New folder name'}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); submitFolderForm() }
              if (e.key === 'Escape') { e.preventDefault(); setFolderForm(null) }
            }}
          />
          <div className="composer__actions">
            <Pill active onClick={submitFolderForm} disabled={disabled || !folderForm.value.trim()}>
              {folderForm.mode === 'rename' ? 'Save' : 'Create'}
            </Pill>
            <Pill className="pill--ghost" onClick={() => setFolderForm(null)}>Cancel</Pill>
          </div>
        </div>
      ) : null}

      {folderConfirm ? (
        <div className="composer" role="alert" style={{ margin: '0 0 12px' }}>
          <span className="grow micro">
            delete the folder "{(folders.find((f) => f.id === folderConfirm) || {}).name || ''}"?
            its {ordered.filter((o) => o.project.folderId === folderConfirm).length} case(s) stay —
            they just move out of it.
          </span>
          <div className="composer__actions">
            <Pill className="pill--danger" onClick={deleteFolder} disabled={disabled}>
              <Trash2 size={13} strokeWidth={1.5} aria-hidden="true" />
              Delete folder
            </Pill>
            <Pill className="pill--ghost" onClick={() => setFolderConfirm(null)}>Cancel</Pill>
          </div>
        </div>
      ) : null}

      <div className="headshift" style={headH == null ? undefined : { height: headH }}>
      <div className="viewhead" ref={headRef}>
        <div className="viewhead__left">
          <span className="section-label">My cases</span>

          <div className="casebar">
            {groups.folders.map((g) => {
              const closed = shut.has(g.folder.id)
              const holds = activeFolderId === g.folder.id
              return (
                <div
                  key={g.folder.id}
                  className={cx('casefold', closed && 'is-shut', holds && 'holds-active')}
                >
                  <button
                    type="button"
                    className="casefold__tab"
                    onClick={() => toggleFolder(g.folder.id)}
                    aria-expanded={!closed}
                    title={closed ? `Show ${g.items.length} case(s)` : 'Collapse'}
                  >
                    <ChevronRight
                      size={12}
                      strokeWidth={1.8}
                      className={cx('casefold__chev', !closed && 'is-open')}
                      aria-hidden="true"
                    />
                    <span className="casefold__name truncate">{g.folder.name}</span>
                    {closed ? <span className="casefold__n">{g.items.length}</span> : null}
                  </button>

                  <IconMenu
                    label={`Actions for ${g.folder.name}`}
                    items={[
                      {
                        key: 'rename',
                        label: 'Rename folder',
                        onClick: () => {
                          setFolderConfirm(null)
                          setFolderForm({ mode: 'rename', id: g.folder.id, value: g.folder.name })
                        },
                      },
                      {
                        key: 'delete',
                        label: 'Delete folder',
                        danger: true,
                        onClick: () => {
                          setFolderForm(null)
                          setFolderConfirm(g.folder.id)
                        },
                      },
                    ]}
                  />

                  {/* 0fr -> 1fr on the inline axis: collapses to nothing without
                      anyone having to measure the strip's width in JS. */}
                  <div className="casefold__wrap">
                    <div className="casefold__inner">
                      {g.items.length ? (
                        <Segmented
                          items={g.items.map(chipFor)}
                          value={activeId}
                          onChange={(id) => onSelectCase && onSelectCase(id)}
                          onReorder={reorderCase}
                          label={g.folder.name}
                        />
                      ) : (
                        <span className="micro dim casefold__empty">empty</span>
                      )}
                    </div>
                  </div>
                </div>
              )
            })}

            {segItems.length ? (
              <Segmented
                items={segItems}
                value={activeId}
                onChange={(id) => onSelectCase && onSelectCase(id)}
                onReorder={reorderCase}
                label="Cases"
              />
            ) : null}

            {!roots.length ? <span className="micro dim">no cases yet</span> : null}

            <Pill
              className="pill--micro pill--ghost casebar__add"
              onClick={() => {
                setFolderConfirm(null)
                setFolderForm({ mode: 'new', id: null, value: '' })
              }}
              aria-label="New folder"
            >
              <FolderPlus size={12} strokeWidth={1.5} aria-hidden="true" />
              <span className="pill__label">Folder</span>
            </Pill>
          </div>
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
           the screen, which meant a switch tore the whole thing down and
           rebuilt it — cards flashing, numbers re-settling, the diagram
           re-assembling — when almost all of it was about to show the same
           thing in the same place. Now only what actually differs re-renders,
           and the ground in the case board flows from one case's shape to the
           next. The one thing the remount did want is preserved: see the key
           on Composer. */
        <div className="bento casework" ref={bentoRef}>
          {/* ---------------- left: the case itself ---------------- */}
          {/* The entries are what this screen is FOR, and for most of its life
              they shared a slot with the diagram — two panels folding over
              each other, one visible at a time. Having to flip a card over to
              read the list on the back of it was the cost of fitting both into
              the middle third of the page. They are not in the middle third
              any more, so neither of them has to hide. */}
          <div className="span-7 col col--left casework__main">
            <Card className="casecard">
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
                            /* An entry holding subtasks cannot itself become
                               one — that would be a third level — so it is not
                               offered as something to drag, and says why. */
                            canDrag={subs.length === 0}
                            dragHint={
                              subs.length === 0
                                ? 'Drag onto another entry to file it as a subtask'
                                : 'Has subtasks of its own, so it cannot be filed under another entry'
                            }
                            dragging={!!drag && drag.id === task.id}
                            accepts={!!drag && drag.id !== task.id && drag.parentId !== task.id}
                            onDragStart={() => setDrag({ id: task.id, parentId: null })}
                            onDragEnd={() => setDrag(null)}
                            onDropEntry={() => nestTask(drag && drag.id, task.id)}
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
                                      /* A subtask can be dragged to a different
                                         entry, but nothing may be filed under
                                         it. */
                                      canDrag
                                      dragHint="Drag onto another entry to move it there"
                                      dragging={!!drag && drag.id === sub.id}
                                      onDragStart={() => setDrag({ id: sub.id, parentId: task.id })}
                                      onDragEnd={() => setDrag(null)}
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

          {/* ---------------- right: the drawing, and one reading at a time ---- */}
          <div className="span-5 casework__side">
            {/* The board. A card now rather than a bare panel, which is what
                lets it stand: the turn in section 2 is `.card:has(.flow)`, and
                it is a card it looks for because a turn needs an edge you can
                see turning. A drawing shearing on its own, with no frame
                around it to say why, is the stretch that rule exists to
                prevent. */}
            <Card className="flowcard caseboard" aria-label="Case structure">
              <CardHead
                className="card__head"
                title="Case structure"
                subtitle={caseName}
                right={
                  <HeadRight>
                    <span className="micro dim nowrap">
                      {graph.nodes.length} {graph.nodes.length === 1 ? 'step' : 'steps'}
                    </span>
                    <IconMenu items={caseMenu} label={`Actions for ${caseName}`} />
                  </HeadRight>
                }
              />

              {/* A direct child of the card, not wrapped in a body: the rules
                  that carry the third dimension down to the step cards run
                  `.flowcard > .flow`, and a padded box in between would both
                  break the chain and letterbox the canvas.

                  The same flow the dashboard draws, from the same builder —
                  two screens showing one case must not disagree about its
                  shape. No width cap: the flow lays itself out and scales to
                  whatever box it is handed. */}
              <CaseFlow
                cases={list}
                rootId={activeId}
                now={now}
                focus={filter === 'open'}
                chrome={false}
                overhang={0}
                className="caseboard__flow"
              />

              <div className="card__foot">
                <span className="nowrap">{nextDueText}</span>
                <span className="caseboard__meter">
                  <Meter value={stats.completion} label={`Completion of ${caseName}`} />
                </span>
              </div>
            </Card>

            {/* The readings, one at a time. Built above; this is only the
                frame they are paged in. */}
            <section
              className="readdeck"
              ref={reading.frameRef}
              onKeyDown={reading.onKeyDown}
              tabIndex={0}
              aria-roledescription="carousel"
              aria-label="Readings from this case"
            >
              <div className="readdeck__stack" ref={reading.stackRef}>
                {readings.map((r, i) => (
                  <div
                    key={r.key}
                    className={cx('readdeck__slide', i === reading.index && 'is-on')}
                    aria-hidden={i === reading.index ? undefined : true}
                    /* Out of the tab order while it is behind, or the keyboard
                       would walk into six cards nobody can see. */
                    inert={i === reading.index ? undefined : true}
                  >
                    {r.node}
                  </div>
                ))}
              </div>

              <nav className="readdeck__dots" aria-label="Choose a reading">
                {readings.map((r, i) => (
                  <button
                    key={r.key}
                    type="button"
                    className={cx('readdeck__dot', i === reading.index && 'is-on')}
                    aria-current={i === reading.index ? 'true' : undefined}
                    aria-label={r.label}
                    title={r.label}
                    onClick={() => reading.goTo(i)}
                  />
                ))}
              </nav>
            </section>
          </div>
        </div>
      )}
    </>
  )
}

export default CaseFiles
