/**
 * Plan — boards of steps, laid out top to bottom on a canvas.
 *
 * Each board is a set of chains. The first is the main line, running down;
 * every other chain hangs off a card (its `from`) to that card's left or
 * right (its `side`, right when unset) and runs down from there, so a step
 * can fork either way. Cards snap into place — there is nothing to drag or
 * line up — and the arrows are drawn from where the cards land.
 *
 *   data = { chains: [{ id, from: cardId | null, side?: 'left' | 'right',
 *                       cards: [{ id, title, body }] }] }
 *
 * A card is one box of plain text that grows as it is written in (the user
 * found a title and a separate body one box too many). Older cards may still
 * carry a `body`: it is shown in the same box under the title, and folded into
 * the title the first time that card is edited.
 * The canvas pans (drag the background, or scroll) and zooms (pinch, or
 * Ctrl + scroll, or the buttons); where you left it is remembered per board.
 * Boards are saved whole, a moment after the last change.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Trash2 } from 'lucide-react'
import { Card, EmptyState, Field, IconMenu, Pill } from '../ui/primitives.jsx'
import { SegmentIsland } from '../ui/CaseIslands.jsx'
import { createBoard, deleteBoard, getBoards, orderBoards, saveBoard } from '../lib/api.js'
import { onRemoteChange, typingSomewhere } from '../lib/live.js'

function cx(...parts) {
  return parts.filter(Boolean).join(' ')
}

const uid = () => Math.random().toString(36).slice(2, 9)
const blankCard = () => ({ id: uid(), title: '', body: '' })

const CARD_W = 260
const GAP_X = 72
const GAP_Y = 52
const ANCHOR = 21          // px down a card where arrows meet it: its first line
const SAVE_AFTER_MS = 600
const MIN_K = 0.3
const MAX_K = 2
const PAD = 40

const ACTIVE_KEY = 'casefile.planBoard'
const viewKey = (id) => `casefile.planView.${id}`
const readStore = (k) => { try { return localStorage.getItem(k) } catch { return null } }
const writeStore = (k, v) => { try { localStorage.setItem(k, v) } catch { /* private window */ } }

const clampK = (k) => Math.min(MAX_K, Math.max(MIN_K, k))

/* --------------------------------------------------------------------------
   where every card lands
   -------------------------------------------------------------------------- */

/* Columns and rows: the main line down column 0 from row 0; a branch starts
   in the column beside the card it hangs from (left or right), level with it
   if that column has room for all of it (and its "+" slot) there, or on the
   first row below that does. Parents are placed before branches; columns to
   the left of the main line are shifted back to start at 0 at the end. */
function layoutOf(chains) {
  const cardAt = new Map()
  for (const ch of chains) for (const c of ch.cards) cardAt.set(c.id, ch)
  const pos = new Map()
  const slots = new Map()
  const cells = new Map()
  const free = (col, a, b) => {
    const s = cells.get(col)
    if (!s) return true
    for (let r = a; r <= b; r++) if (s.has(r)) return false
    return true
  }
  const take = (col, a, b) => {
    if (!cells.has(col)) cells.set(col, new Set())
    for (let r = a; r <= b; r++) cells.get(col).add(r)
  }

  let pending = [...chains]
  for (let guard = 0; pending.length && guard < 500; guard++) {
    const next = []
    for (const ch of pending) {
      let col = 0
      let minRow = 0
      if (ch.from && cardAt.has(ch.from)) {
        const p = pos.get(ch.from)
        if (!p) { next.push(ch); continue }
        col = p.col + (ch.side === 'left' ? -1 : 1)
        minRow = p.row
      }
      const len = ch.cards.length                 // the row after the last card is the "+" slot
      let r = minRow
      while (!free(col, r, r + len)) r++
      take(col, r, r + len)
      ch.cards.forEach((c, i) => pos.set(c.id, { col, row: r + i }))
      slots.set(ch.id, { col, row: r + len })
    }
    if (next.length === pending.length) break   // a cycle in damaged data: leave the rest out
    pending = next
  }
  let min = 0
  for (const p of [...pos.values(), ...slots.values()]) min = Math.min(min, p.col)
  if (min < 0) for (const p of [...pos.values(), ...slots.values()]) p.col -= min
  let cols = 1
  let nrows = 1
  for (const p of [...pos.values(), ...slots.values()]) {
    cols = Math.max(cols, p.col + 1)
    nrows = Math.max(nrows, p.row + 1)
  }
  return { pos, slots, cols, rows: nrows }
}

/* --------------------------------------------------------------------------
   changes to a board's data — each takes a copy and changes it in place
   -------------------------------------------------------------------------- */

function findCard(data, id) {
  for (const ch of data.chains) {
    const i = ch.cards.findIndex((c) => c.id === id)
    if (i >= 0) return { ch, i }
  }
  return null
}

/* Removing a card: anything branching off it moves to the card before it
   (or the one its chain hangs from, or the one after); with nowhere to go,
   those branches go too. A branch left empty is dropped. */
function removeCard(data, id) {
  const at = findCard(data, id)
  if (!at) return
  const { ch, i } = at
  const heir = ch.cards[i - 1]?.id || ch.from || ch.cards[i + 1]?.id || null
  ch.cards.splice(i, 1)
  const orphans = data.chains.filter((x) => x.from === id)
  for (const o of orphans) o.from = heir
  if (!heir) dropChains(data, orphans.map((o) => o.id))
  if (!ch.cards.length && ch !== data.chains[0]) {
    const subs = data.chains.filter((x) => x.from && !findCard(data, x.from))
    dropChains(data, [ch.id, ...subs.map((s) => s.id)])
  }
}

function dropChains(data, ids) {
  const gone = new Set(ids)
  let grew = true
  while (grew) {
    grew = false
    for (const ch of data.chains) {
      if (gone.has(ch.id)) continue
      const parent = ch.from && data.chains.find((x) => x.cards.some((c) => c.id === ch.from))
      if (parent && gone.has(parent.id)) { gone.add(ch.id); grew = true }
    }
  }
  data.chains = data.chains.filter((ch, i) => i === 0 || !gone.has(ch.id))
}

/* --------------------------------------------------------------------------
   a bar that unfolds: grows open from nothing and folds away again, keeping
   what it showed on screen while it closes
   -------------------------------------------------------------------------- */

const REVEAL_MS = 260

function Reveal({ open, children }) {
  const [mounted, setMounted] = useState(open)
  const [expanded, setExpanded] = useState(false)
  const last = useRef(children)
  if (open) last.current = children

  useEffect(() => {
    if (open) {
      setMounted(true)
      /* Two frames: one to lay it out folded, one to unfold it. */
      let b = 0
      const a = requestAnimationFrame(() => { b = requestAnimationFrame(() => setExpanded(true)) })
      return () => { cancelAnimationFrame(a); cancelAnimationFrame(b) }
    }
    setExpanded(false)
    const t = setTimeout(() => setMounted(false), REVEAL_MS)
    return () => clearTimeout(t)
  }, [open])

  if (!mounted && !open) return null
  return (
    <div className={cx('plan-reveal', expanded && open && 'is-open')} aria-hidden={open ? undefined : true}>
      <div className="plan-reveal__inner">{open ? children : last.current}</div>
    </div>
  )
}

/* --------------------------------------------------------------------------
   the screen
   -------------------------------------------------------------------------- */

export default function Plan() {
  /* undefined while loading. */
  const [boards, setBoards] = useState(undefined)
  const [activeId, setActiveId] = useState(() => Number(readStore(ACTIVE_KEY)) || null)
  const [error, setError] = useState(null)
  const [saving, setSaving] = useState('saved')

  const boardsRef = useRef(boards)
  boardsRef.current = boards
  const timers = useRef(new Map())

  const savingRef = useRef(saving)
  savingRef.current = saving

  useEffect(() => {
    let live = true
    getBoards()
      .then((list) => { if (live) setBoards(Array.isArray(list) ? list : []) })
      .catch((err) => { if (live) { setBoards([]); setError(err?.message || 'The boards could not be loaded.') } })
    /* A board changed on another device. Loaded again only when everything
       here is saved and nothing is being typed: an edit in hand, or one that
       failed to save, is never written over. */
    const off = onRemoteChange(
      () => getBoards()
        .then((list) => {
          if (!live || !Array.isArray(list) || timers.current.size || savingRef.current !== 'saved') return
          if (JSON.stringify(list) !== JSON.stringify(boardsRef.current)) setBoards(list)
        })
        .catch(() => { /* the next change will try again */ }),
      () => timers.current.size > 0 || savingRef.current !== 'saved' || typingSomewhere(),
    )
    return () => { live = false; off() }
  }, [])

  const active = boards?.find((b) => b.id === activeId) || boards?.[0] || null
  useEffect(() => { if (active) writeStore(ACTIVE_KEY, String(active.id)) }, [active])

  const flush = useCallback(async (id) => {
    clearTimeout(timers.current.get(id))
    timers.current.delete(id)
    const b = boardsRef.current?.find((x) => x.id === id)
    if (!b) return
    try {
      await saveBoard(id, { data: b.data })
      if (!timers.current.size) setSaving('saved')
      setError(null)
    } catch (err) {
      setSaving('error')
      setError(err?.message || 'The board could not be saved.')
    }
  }, [])

  /* Every pending save goes out when the screen does. */
  useEffect(() => () => { for (const id of [...timers.current.keys()]) flush(id) }, [flush])
  useEffect(() => {
    const out = (e) => { if (timers.current.size) { for (const id of [...timers.current.keys()]) flush(id); e.preventDefault() } }
    window.addEventListener('beforeunload', out)
    return () => window.removeEventListener('beforeunload', out)
  }, [flush])

  /* A change to a board's cards: a copy, changed, shown, saved behind. */
  const edit = useCallback((id, fn) => {
    const list = boardsRef.current
    const b = list?.find((x) => x.id === id)
    if (!b) return
    const data = structuredClone(b.data)
    if (!Array.isArray(data.chains)) data.chains = []
    fn(data)
    const next = list.map((x) => (x.id === id ? { ...x, data } : x))
    boardsRef.current = next
    setBoards(next)
    setSaving('saving')
    clearTimeout(timers.current.get(id))
    timers.current.set(id, setTimeout(() => flush(id), SAVE_AFTER_MS))
  }, [flush])

  /* Naming a board — a new one or this one — happens in a bar under the
     header, as a case is named in Case files; deleting one asks there too. */
  const [form, setForm] = useState(null)        // { mode: 'new' | 'rename', value }
  const [confirming, setConfirming] = useState(false)

  const startNew = () => {
    setConfirming(false)
    setForm({ mode: 'new', value: '' })
  }
  const startRename = () => {
    if (!active) return
    setConfirming(false)
    setForm({ mode: 'rename', value: active.name })
  }

  const submitForm = useCallback(async () => {
    if (!form) return
    const name = form.value.trim()
    if (!name) return
    setForm(null)
    if (form.mode === 'rename') {
      if (!active || name === active.name) return
      setBoards((list) => list.map((x) => (x.id === active.id ? { ...x, name } : x)))
      try { await saveBoard(active.id, { name }) } catch (err) { setError(err?.message || 'The name could not be saved.') }
      return
    }
    try {
      const b = await createBoard(name, { chains: [{ id: uid(), from: null, cards: [blankCard()] }] })
      setBoards((list) => [...(list || []), b])
      setActiveId(b.id)
    } catch (err) {
      setError(err?.message || 'The board could not be made.')
    }
  }, [form, active])

  const remove = useCallback(async () => {
    if (!active) return
    setConfirming(false)
    clearTimeout(timers.current.get(active.id))
    timers.current.delete(active.id)
    try {
      await deleteBoard(active.id)
      setBoards((list) => list.filter((x) => x.id !== active.id))
      setActiveId(null)
    } catch (err) {
      setError(err?.message || 'The board could not be deleted.')
    }
  }, [active])

  const reorder = useCallback((id, to) => {
    const list = [...(boardsRef.current || [])]
    const from = list.findIndex((x) => x.id === id)
    if (from < 0) return
    const [b] = list.splice(from, 1)
    list.splice(to, 0, b)
    setBoards(list)
    orderBoards(list.map((x) => x.id)).catch((err) => setError(err?.message || 'The order could not be saved.'))
  }, [])

  const head = (
    <div className="viewhead">
      <div className="viewhead__left">
        <span className="section-label">Plan</span>
        {boards?.length ? (
          <SegmentIsland
            items={boards.map((b) => ({ value: b.id, label: b.name }))}
            value={active?.id}
            onChange={(id) => {
              if (active && timers.current.has(active.id)) flush(active.id)
              setActiveId(id)
            }}
            onReorder={reorder}
            label="Which board"
          />
        ) : null}
      </div>
      <div className="viewhead__right">
        {active ? (
          <span className={cx('micro', saving === 'error' ? 'plan-saving is-error' : 'muted')} aria-live="polite">
            {saving === 'saving' ? 'saving…' : saving === 'error' ? 'not saved' : 'saved'}
          </span>
        ) : null}
        <Pill onClick={startNew}>New board</Pill>
        {active ? (
          <IconMenu
            label="Board options"
            items={[
              { key: 'rename', label: 'Rename board', onClick: startRename },
              { key: 'delete', label: 'Delete board', danger: true, onClick: () => { setForm(null); setConfirming(true) } },
            ]}
          />
        ) : null}
      </div>
    </div>
  )

  const cardCount = active ? active.data.chains.reduce((k, ch) => k + ch.cards.length, 0) : 0
  const bars = (
    <>
      <Reveal open={!!form}>
      {form ? (
        <div className="composer plan-bar">
          <Field
            className="composer__field"
            label={form.mode === 'rename' ? 'Rename board' : 'New board'}
            value={form.value}
            onChange={(v) => setForm((f) => (f ? { ...f, value: v } : f))}
            placeholder="Board name"
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                submitForm()
              } else if (e.key === 'Escape') {
                e.preventDefault()
                e.stopPropagation()
                setForm(null)
              }
            }}
          />
          <div className="composer__actions">
            <Pill active onClick={submitForm} disabled={!form.value.trim()}>
              {form.mode === 'rename' ? 'Save' : 'Create'}
            </Pill>
            <Pill className="pill--ghost" onClick={() => setForm(null)}>Cancel</Pill>
          </div>
        </div>
      ) : null}
      </Reveal>
      <Reveal open={confirming && !!active}>
      {confirming && active ? (
        <div className="composer plan-bar" role="alert">
          <span className="grow micro">
            delete board {active.name} and its {cardCount} {cardCount === 1 ? 'card' : 'cards'}? this cannot be undone.
          </span>
          <div className="composer__actions">
            <Pill className="pill--danger" onClick={remove}>
              <Trash2 size={13} strokeWidth={1.5} aria-hidden="true" />
              Delete board
            </Pill>
            <Pill className="pill--ghost" onClick={() => setConfirming(false)}>Cancel</Pill>
          </div>
        </div>
      ) : null}
      </Reveal>
    </>
  )

  if (boards === undefined) return head

  if (!active) {
    return (
      <>
        {head}
        {bars}
        <div className="bento">
          <Card className="span-12">
            <div className="card__body">
              <EmptyState
                lead="No boards yet."
                hint={error || 'A board is a line of steps, top to bottom, that can branch left or right. Start one and write the first step.'}
                action={form ? null : <Pill onClick={startNew} active>New board</Pill>}
              />
            </div>
          </Card>
        </div>
      </>
    )
  }

  return (
    <>
      {head}
      {bars}
      <div className="bento">
        <Card className="span-12 planboard">
          <Board key={active.id} board={active} edit={edit} />
          {error ? <p className="plan-error">{error}</p> : null}
        </Card>
      </div>
    </>
  )
}

/* --------------------------------------------------------------------------
   one board: the canvas, its cards and their arrows
   -------------------------------------------------------------------------- */

function Board({ board, edit }) {
  const chains = board.data.chains || []
  const layout = useMemo(() => layoutOf(chains), [chains])
  const change = useCallback((fn) => edit(board.id, fn), [edit, board.id])

  /* Which card was just made. */
  const [fresh, setFresh] = useState(null)

  /* ---- the view: pan and zoom ---------------------------------------- */
  const [view, setView] = useState(() => {
    try {
      const v = JSON.parse(readStore(viewKey(board.id)) || 'null')
      if (v && [v.x, v.y, v.k].every(Number.isFinite)) return { x: v.x, y: v.y, k: clampK(v.k) }
    } catch { /* fall through */ }
    return { x: PAD, y: PAD, k: 1 }
  })
  useEffect(() => {
    const t = setTimeout(() => writeStore(viewKey(board.id), JSON.stringify(view)), 300)
    return () => clearTimeout(t)
  }, [view, board.id])

  const portRef = useRef(null)
  const gridRef = useRef(null)
  const stageRef = useRef(null)
  const dotsRef = useRef(null)

  /* Moving the view never re-renders the board.
     ----------------------------------------------------------------------
     A pan or a pinch is a stream of events, and setting React state on each
     one re-rendered every card (its markdown included) and re-measured them
     all, per event: the lag, worst on a phone. So the live view lives in a
     ref, and each frame writes it straight onto the stage's transform and
     the dots' layer. While it moves the stage is one composited layer the
     GPU slides and scales; a moment after it stops, the view is committed
     to state once (the zoom readout, the saved position) and the layer is
     let go, so the text is drawn sharp again at the new size. */
  const viewRef = useRef(view)
  const paintRaf = useRef(0)
  const settleT = useRef(0)
  const paint = useCallback(() => {
    paintRaf.current = 0
    const { x, y, k } = viewRef.current
    if (stageRef.current) stageRef.current.style.transform = `translate(${x}px, ${y}px) scale(${k})`
    const dots = dotsRef.current
    if (dots) {
      const g = 24 * k
      const mod = (v) => (((v + 60) % g) + g) % g
      dots.style.backgroundSize = `${g}px ${g}px`
      dots.style.transform = `translate(${mod(x)}px, ${mod(y)}px)`
    }
  }, [])
  const moveTo = useCallback((next) => {
    viewRef.current = typeof next === 'function' ? next(viewRef.current) : next
    if (!paintRaf.current) paintRaf.current = requestAnimationFrame(paint)
    portRef.current?.classList.add('is-moving')
    clearTimeout(settleT.current)
    settleT.current = setTimeout(() => {
      portRef.current?.classList.remove('is-moving')
      setView(viewRef.current)
    }, 160)
  }, [paint])
  useLayoutEffect(paint, [paint])
  useEffect(() => () => { cancelAnimationFrame(paintRaf.current); clearTimeout(settleT.current) }, [])

  const zoomAt = useCallback((k, px, py) => {
    moveTo((v) => {
      const nk = clampK(k)
      return { k: nk, x: px - (px - v.x) * (nk / v.k), y: py - (py - v.y) * (nk / v.k) }
    })
  }, [moveTo])

  const zoomBy = (f) => {
    const r = portRef.current.getBoundingClientRect()
    zoomAt(viewRef.current.k * f, r.width / 2, r.height / 2)
  }

  const fit = useCallback(() => {
    const port = portRef.current
    const grid = gridRef.current
    if (!port || !grid) return
    const pw = port.clientWidth
    const ph = port.clientHeight
    const gw = grid.offsetWidth
    const gh = grid.offsetHeight
    const k = clampK(Math.min(1, (pw - PAD * 2) / gw, (ph - PAD * 2) / gh))
    moveTo({ k, x: Math.max(PAD, (pw - gw * k) / 2), y: Math.max(PAD, (ph - gh * k) / 2) })
  }, [moveTo])

  /* Scroll pans; Ctrl or ⌘ with it (a trackpad pinch arrives that way) zooms
     at the pointer. Not passive, so the page itself does not scroll. Inside a
     card that is being written, the editor keeps its own scrolling. */
  useEffect(() => {
    const port = portRef.current
    if (!port) return undefined
    const onWheel = (e) => {
      e.preventDefault()
      const r = port.getBoundingClientRect()
      if (e.ctrlKey || e.metaKey) {
        zoomAt(viewRef.current.k * Math.exp(-e.deltaY * 0.0025), e.clientX - r.left, e.clientY - r.top)
      } else {
        moveTo((v) => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }))
      }
    }
    port.addEventListener('wheel', onWheel, { passive: false })
    return () => port.removeEventListener('wheel', onWheel)
  }, [zoomAt, moveTo])

  /* Dragging the background pans; two fingers pinch. A card, a button or a
     field keeps its own pointer. */
  const pointers = useRef(new Map())
  const gesture = useRef(null)
  const onPointerDown = (e) => {
    if (e.target.closest('.plan-card, .plan-add, .plan-insert, .plan-zoom, button, input, textarea')) return
    /* A drag on the background is a pan, never a text selection: without
       this the browser selected every card's words as the pointer swept. */
    e.preventDefault()
    document.getSelection()?.removeAllRanges()
    if (portRef.current.contains(document.activeElement)) document.activeElement.blur()
    portRef.current.classList.add('is-panning')
    portRef.current.setPointerCapture(e.pointerId)
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    const pts = [...pointers.current.values()]
    const v = viewRef.current
    if (pts.length === 1) gesture.current = { kind: 'pan', x0: e.clientX, y0: e.clientY, v }
    else if (pts.length === 2) {
      const r = portRef.current.getBoundingClientRect()
      const [a, b] = pts
      gesture.current = {
        kind: 'pinch',
        d0: Math.hypot(a.x - b.x, a.y - b.y) || 1,
        mx: (a.x + b.x) / 2 - r.left,
        my: (a.y + b.y) / 2 - r.top,
        v,
      }
    }
  }
  const onPointerMove = (e) => {
    if (!pointers.current.has(e.pointerId)) return
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    const g = gesture.current
    if (!g) return
    if (g.kind === 'pan') {
      moveTo({ ...g.v, x: g.v.x + e.clientX - g.x0, y: g.v.y + e.clientY - g.y0 })
    } else {
      const [a, b] = [...pointers.current.values()]
      const k = clampK(g.v.k * (Math.hypot(a.x - b.x, a.y - b.y) / g.d0))
      moveTo({ k, x: g.mx - (g.mx - g.v.x) * (k / g.v.k), y: g.my - (g.my - g.v.y) * (k / g.v.k) })
    }
  }
  const onPointerUp = (e) => {
    pointers.current.delete(e.pointerId)
    const pts = [...pointers.current.values()]
    gesture.current = pts.length === 1 ? { kind: 'pan', x0: pts[0].x, y0: pts[0].y, v: viewRef.current } : null
    if (!pts.length) portRef.current?.classList.remove('is-panning')
  }

  /* ---- where the cards landed, for the arrows ------------------------- */
  const [boxes, setBoxes] = useState(() => new Map())
  const measure = useCallback(() => {
    const grid = gridRef.current
    if (!grid) return
    const next = new Map()
    for (const el of grid.querySelectorAll('[data-at]')) {
      next.set(el.dataset.at, { x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight })
    }
    next.set('#grid', { w: grid.offsetWidth, h: grid.offsetHeight })
    setBoxes((prev) => {
      if (prev.size === next.size && [...next].every(([k, b]) => {
        const p = prev.get(k)
        return p && p.x === b.x && p.y === b.y && p.w === b.w && p.h === b.h
      })) return prev
      return next
    })
  }, [])
  useLayoutEffect(measure)

  /* A card just made, if it landed outside the view, is panned into it. */
  useEffect(() => {
    const b = fresh && boxes.get(fresh)
    const port = portRef.current
    if (!b || !port) return
    const { x, y, k } = viewRef.current
    const left = x + b.x * k
    const top = y + b.y * k
    const right = left + b.w * k
    const bottom = top + b.h * k
    let dx = 0
    let dy = 0
    if (right > port.clientWidth - PAD) dx = port.clientWidth - PAD - right
    if (left + dx < PAD) dx = PAD - left
    if (bottom > port.clientHeight - PAD) dy = port.clientHeight - PAD - bottom
    if (top + dy < PAD) dy = PAD - top
    if (dx || dy) moveTo((v) => ({ ...v, x: v.x + dx, y: v.y + dy }))
  }, [fresh, boxes, moveTo])
  /* A card grows as it is written in; the arrows follow. */
  useEffect(() => {
    const grid = gridRef.current
    if (!grid) return undefined
    const ro = new ResizeObserver(() => measure())
    ro.observe(grid)
    for (const el of grid.querySelectorAll('[data-at]')) ro.observe(el)
    return () => ro.disconnect()
  }, [measure, layout])

  /* ---- the actions ----------------------------------------------------- */
  const insertAt = (chainId, index) => {
    const card = blankCard()
    change((d) => {
      const ch = d.chains.find((x) => x.id === chainId)
      if (ch) ch.cards.splice(index, 0, card)
    })
    setFresh(card.id)
  }
  const startMain = () => {
    const card = blankCard()
    change((d) => {
      if (!d.chains.length) d.chains.push({ id: uid(), from: null, cards: [] })
      d.chains[0].cards.push(card)
    })
    setFresh(card.id)
  }
  const branch = (cardId, side = 'right') => {
    const card = blankCard()
    change((d) => { d.chains.push({ id: uid(), from: cardId, side, cards: [card] }) })
    setFresh(card.id)
  }
  const move = (cardId, dir) => change((d) => {
    const at = findCard(d, cardId)
    if (!at) return
    const j = at.i + dir
    if (j < 0 || j >= at.ch.cards.length) return
    const [c] = at.ch.cards.splice(at.i, 1)
    at.ch.cards.splice(j, 0, c)
  })
  /* A card with nothing written in it goes at once; one with words asks
     first, on the card itself. */
  const [doomed, setDoomed] = useState(null)
  const remove = (card) => {
    const hasWords = card.title.trim() || card.body.trim()
    if (hasWords && doomed !== card.id) { setDoomed(card.id); return }
    setDoomed(null)
    change((d) => removeCard(d, card.id))
  }
  /* The card's one box: everything typed is its title, and an old body,
     shown in the box under it, becomes part of it here. */
  const setText = (cardId, value) => change((d) => {
    const at = findCard(d, cardId)
    if (!at) return
    at.ch.cards[at.i].title = value
    at.ch.cards[at.i].body = ''
  })

  /* ---- the arrows ------------------------------------------------------ */
  const links = []
  const inserts = []
  const anchorOf = (b) => b.y + Math.min(ANCHOR, b.h / 2)
  for (const ch of chains) {
    const seq = [...ch.cards.map((c) => c.id), `+${ch.id}`]
    /* A branch: out of the side of the card it hangs from, along its title
       line; straight across when the branch sits level with it, otherwise
       down the gap between the columns and in at the branch's title. */
    if (ch.from) {
      const p = boxes.get(ch.from)
      const q = boxes.get(seq[0])
      if (p && q) {
        const left = q.x < p.x
        const sx = left ? -1 : 1
        const x0 = left ? p.x : p.x + p.w
        const x1 = left ? q.x + q.w + 4 : q.x - 4
        const y0 = anchorOf(p)
        const y1 = anchorOf(q)
        const mx = x0 + (sx * GAP_X) / 2
        const rr = Math.min(10, Math.abs(y1 - y0) / 2)
        links.push({
          key: `${ch.id}-from`,
          d: Math.abs(y1 - y0) < 1
            ? `M${x0},${y0} H${x1}`
            : `M${x0},${y0} H${mx - sx * rr} Q${mx},${y0} ${mx},${y0 + rr} V${y1 - rr} Q${mx},${y1} ${mx + sx * rr},${y1} H${x1}`,
          faint: !ch.cards.length,
        })
      }
    }
    /* Down the chain: from the foot of one card to the head of the next. */
    for (let i = 0; i < seq.length - 1; i++) {
      const a = boxes.get(seq[i])
      const b = boxes.get(seq[i + 1])
      if (!a || !b) continue
      const toSlot = i === seq.length - 2
      const x = a.x + a.w / 2
      links.push({ key: `${seq[i]}>${seq[i + 1]}`, d: `M${x},${a.y + a.h} V${b.y - 4}`, faint: toSlot })
      if (!toSlot) inserts.push({ key: `${ch.id}:${i + 1}`, chainId: ch.id, index: i + 1, x, y: (a.y + a.h + b.y) / 2 })
    }
  }
  const gridBox = boxes.get('#grid') || { w: 0, h: 0 }

  const numberOf = useMemo(() => {
    const n = new Map()
    chains[0]?.cards.forEach((c, i) => n.set(c.id, String(i + 1).padStart(2, '0')))
    return n
  }, [chains])

  return (
    <div
      ref={portRef}
      className="planboard__port"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <div ref={dotsRef} className="planboard__dots" aria-hidden="true" />
      <div ref={stageRef} className="planboard__stage">
        <div
          ref={gridRef}
          className="plan-grid"
          style={{
            gridTemplateColumns: `repeat(${layout.cols}, ${CARD_W}px)`,
            gridTemplateRows: `repeat(${layout.rows}, auto)`,
            columnGap: GAP_X,
            rowGap: GAP_Y,
          }}
        >
          <svg className="plan-links" width={gridBox.w} height={gridBox.h} aria-hidden="true">
            <defs>
              <marker id="plan-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="8" markerHeight="8" orient="auto">
                <path d="M1,1 L7,4 L1,7" className="plan-links__head" />
              </marker>
            </defs>
            {links.map((l) => (
              <path key={l.key} d={l.d} className={cx('plan-links__line', l.faint && 'is-faint')} markerEnd={l.faint ? undefined : 'url(#plan-arrow)'} />
            ))}
          </svg>

          {chains.map((ch, chIndex) => ch.cards.map((c, i) => {
            const p = layout.pos.get(c.id)
            if (!p) return null
            return (
              <PlanCard
                key={c.id}
                card={c}
                place={p}
                number={numberOf.get(c.id)}
                branchCard={chIndex > 0}
                side={ch.side === 'left' ? 'left' : 'right'}
                first={i === 0}
                last={i === ch.cards.length - 1}
                fresh={fresh === c.id}
                onText={(v) => setText(c.id, v)}
                onAddAfter={() => insertAt(ch.id, i + 1)}
                onBranch={(side) => branch(c.id, side)}
                onMove={(dir) => move(c.id, dir)}
                onDelete={() => remove(c)}
                confirming={doomed === c.id}
                onKeep={() => setDoomed(null)}
              />
            )
          }))}

          {chains.map((ch, chIndex) => {
            const s = layout.slots.get(ch.id)
            if (!s) return null
            const empty = !ch.cards.length
            return (
              <button
                key={`+${ch.id}`}
                type="button"
                data-at={`+${ch.id}`}
                className={cx('plan-add', empty && 'is-empty')}
                style={{ gridColumn: s.col + 1, gridRow: s.row + 1 }}
                onClick={() => (chIndex === 0 && empty ? startMain() : insertAt(ch.id, ch.cards.length))}
              >
                {empty && chIndex === 0 ? '+ First step' : '+ Step'}
              </button>
            )
          })}

          {!chains.length ? (
            <button type="button" data-at="+start" className="plan-add is-empty" style={{ gridColumn: 1, gridRow: 1 }} onClick={startMain}>
              + First step
            </button>
          ) : null}

          {inserts.map((s) => (
            <button
              key={s.key}
              type="button"
              className="plan-insert"
              style={{ left: s.x, top: s.y }}
              aria-label="Insert a step here"
              title="Insert a step here"
              onClick={() => insertAt(s.chainId, s.index)}
            >
              +
            </button>
          ))}
        </div>
      </div>

      <div className="plan-zoom" role="group" aria-label="Zoom">
        <button type="button" onClick={() => zoomBy(1 / 1.2)} aria-label="Zoom out">−</button>
        <button type="button" className="plan-zoom__k" onClick={() => zoomAt(1, portRef.current.clientWidth / 2, portRef.current.clientHeight / 2)} title="Back to 100%">
          {Math.round(view.k * 100)}%
        </button>
        <button type="button" onClick={() => zoomBy(1.2)} aria-label="Zoom in">+</button>
        <button type="button" onClick={fit} title="Fit the board in view">Fit</button>
      </div>
    </div>
  )
}

/* --------------------------------------------------------------------------
   a card
   -------------------------------------------------------------------------- */

function PlanCard({
  card, place, number, branchCard, side, first, last, fresh,
  onText, onAddAfter, onBranch, onMove, onDelete,
  confirming, onKeep,
}) {
  /* A new card takes the cursor without the browser scrolling the canvas to
     it: Board pans the view there instead. */
  const titleRef = useRef(null)
  useEffect(() => {
    if (fresh) titleRef.current?.focus({ preventScroll: true })
  }, [fresh])

  const text = card.body?.trim() ? `${card.title}\n${card.body}` : card.title
  /* As tall as its words: a box that grows, never one that scrolls. */
  useLayoutEffect(() => {
    const el = titleRef.current
    if (!el) return
    el.style.height = '0px'
    el.style.height = `${el.scrollHeight}px`
  }, [text])

  return (
    <article
      data-at={card.id}
      className={cx('plan-card', branchCard && 'is-branch')}
      style={{ gridColumn: place.col + 1, gridRow: place.row + 1 }}
    >
      <header className="plan-card__head">
        {number ? <span className="plan-card__n">{number}</span> : <span className="plan-card__n is-branch" aria-hidden="true">{side === 'left' ? '↲' : '↳'}</span>}
        <textarea
          className="plan-card__title"
          value={text}
          rows={1}
          placeholder="Step"
          aria-label="Step"
          ref={titleRef}
          onChange={(e) => onText(e.target.value)}
        />
        <IconMenu
          label="Card options"
          items={[
            { key: 'after', label: 'Add a step below', onClick: onAddAfter },
            { key: 'branch-right', label: 'Branch to the right', onClick: () => onBranch('right') },
            { key: 'branch-left', label: 'Branch to the left', onClick: () => onBranch('left') },
            { key: 'up', label: 'Move up', disabled: first, onClick: () => onMove(-1) },
            { key: 'down', label: 'Move down', disabled: last, onClick: () => onMove(1) },
            { key: 'delete', label: 'Delete card', danger: true, onClick: onDelete },
          ]}
        />
      </header>
      <button
        type="button"
        className="plan-side is-left"
        onClick={() => onBranch('left')}
        aria-label="Branch to the left"
        title="Branch to the left"
      >
        +
      </button>
      <button
        type="button"
        className="plan-side is-right"
        onClick={() => onBranch('right')}
        aria-label="Branch to the right"
        title="Branch to the right"
      >
        +
      </button>
      {confirming ? (
        <div className="plan-card__confirm" role="alert">
          <span className="micro plan-card__ask">delete step?</span>
          <span className="plan-card__confirm-actions">
            <Pill className="pill--danger" onClick={onDelete}>Delete</Pill>
            <Pill className="pill--ghost" onClick={onKeep}>Keep</Pill>
          </span>
        </div>
      ) : null}
    </article>
  )
}
