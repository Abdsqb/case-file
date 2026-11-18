/**
 * Plan — boards of steps, laid out left to right on a canvas.
 *
 * Each board is a set of chains. The first is the main line; every other
 * chain hangs off a card (its `from`) and runs on to the right one row
 * below, so a step can fork. Cards snap into place — there is nothing to
 * drag or line up — and the arrows are drawn from where the cards land.
 *
 *   data = { chains: [{ id, from: cardId | null, cards: [{ id, title, body }] }] }
 *
 * A card is a title and a body written in the same live markdown as the notes
 * pad. The canvas pans (drag the background, or scroll) and zooms (pinch, or
 * Ctrl + scroll, or the buttons); where you left it is remembered per board.
 * Boards are saved whole, a moment after the last change.
 */

import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Card, EmptyState, IconMenu, Pill } from '../ui/primitives.jsx'
import { SegmentIsland } from '../ui/CaseIslands.jsx'
import ChatMarkdown from '../ui/ChatMarkdown.jsx'
import { createBoard, deleteBoard, getBoards, orderBoards, saveBoard } from '../lib/api.js'

const LiveMarkdown = lazy(() => import('../ui/LiveMarkdown.jsx'))

function cx(...parts) {
  return parts.filter(Boolean).join(' ')
}

const uid = () => Math.random().toString(36).slice(2, 9)
const blankCard = () => ({ id: uid(), title: '', body: '' })

const CARD_W = 260
const GAP_X = 72
const GAP_Y = 44
const ANCHOR = 27          // px down a card where arrows meet it: its title line
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

/* Columns and rows: the main line on row 0 from column 0; a branch starts one
   column right of the card it hangs from, on the first row below that has
   room for all of it (and its "+" slot). Parents are placed before branches. */
function layoutOf(chains) {
  const cardAt = new Map()
  for (const ch of chains) for (const c of ch.cards) cardAt.set(c.id, ch)
  const pos = new Map()
  const slots = new Map()
  const rows = []
  const free = (r, a, b) => { for (let c = a; c <= b; c++) if (rows[r]?.has(c)) return false; return true }
  const take = (r, a, b) => { rows[r] = rows[r] || new Set(); for (let c = a; c <= b; c++) rows[r].add(c) }

  let pending = [...chains]
  for (let guard = 0; pending.length && guard < 500; guard++) {
    const next = []
    for (const ch of pending) {
      let start = 0
      let minRow = 0
      if (ch.from && cardAt.has(ch.from)) {
        const p = pos.get(ch.from)
        if (!p) { next.push(ch); continue }
        start = p.col + 1
        minRow = p.row + 1
      }
      const end = start + ch.cards.length       // the last column is the "+" slot
      let r = minRow
      while (!free(r, start, end)) r++
      take(r, start, end)
      ch.cards.forEach((c, i) => pos.set(c.id, { col: start + i, row: r }))
      slots.set(ch.id, { col: end, row: r })
    }
    if (next.length === pending.length) break   // a cycle in damaged data: leave the rest out
    pending = next
  }
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

  useEffect(() => {
    let live = true
    getBoards()
      .then((list) => { if (live) setBoards(Array.isArray(list) ? list : []) })
      .catch((err) => { if (live) { setBoards([]); setError(err?.message || 'The boards could not be loaded.') } })
    return () => { live = false }
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

  const newBoard = useCallback(async () => {
    const name = window.prompt('Name the new board', `Board ${(boardsRef.current?.length || 0) + 1}`)
    if (name === null) return
    try {
      const b = await createBoard(name.trim() || 'Untitled', { chains: [{ id: uid(), from: null, cards: [blankCard()] }] })
      setBoards((list) => [...(list || []), b])
      setActiveId(b.id)
    } catch (err) {
      setError(err?.message || 'The board could not be made.')
    }
  }, [])

  const rename = useCallback(async () => {
    if (!active) return
    const name = window.prompt('Rename the board', active.name)
    if (name === null || !name.trim()) return
    setBoards((list) => list.map((x) => (x.id === active.id ? { ...x, name: name.trim() } : x)))
    try { await saveBoard(active.id, { name: name.trim() }) } catch (err) { setError(err?.message || 'The name could not be saved.') }
  }, [active])

  const remove = useCallback(async () => {
    if (!active) return
    const n = active.data.chains.reduce((k, ch) => k + ch.cards.length, 0)
    if (!window.confirm(`Delete “${active.name}” and its ${n} card${n === 1 ? '' : 's'}? This cannot be undone.`)) return
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
        <Pill onClick={newBoard}>New board</Pill>
        {active ? (
          <IconMenu
            label="Board options"
            items={[
              { key: 'rename', label: 'Rename board', onClick: rename },
              { key: 'delete', label: 'Delete board', danger: true, onClick: remove },
            ]}
          />
        ) : null}
      </div>
    </div>
  )

  if (boards === undefined) return head

  if (!active) {
    return (
      <>
        {head}
        <div className="bento">
          <Card className="span-12">
            <div className="card__body">
              <EmptyState
                lead="No boards yet."
                hint={error || 'A board is a line of steps, left to right, that can fork. Start one and write the first step.'}
                action={<Pill onClick={newBoard} active>New board</Pill>}
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

  /* Which card's body is open for writing, and which card was just made. */
  const [writing, setWriting] = useState(null)
  const [fresh, setFresh] = useState(null)

  /* ---- the view: pan and zoom ---------------------------------------- */
  const [view, setView] = useState(() => {
    try {
      const v = JSON.parse(readStore(viewKey(board.id)) || 'null')
      if (v && [v.x, v.y, v.k].every(Number.isFinite)) return { x: v.x, y: v.y, k: clampK(v.k) }
    } catch { /* fall through */ }
    return { x: PAD, y: PAD, k: 1 }
  })
  const viewRef = useRef(view)
  viewRef.current = view
  useEffect(() => {
    const t = setTimeout(() => writeStore(viewKey(board.id), JSON.stringify(view)), 300)
    return () => clearTimeout(t)
  }, [view, board.id])

  const portRef = useRef(null)
  const gridRef = useRef(null)

  const zoomAt = useCallback((k, px, py) => {
    setView((v) => {
      const nk = clampK(k)
      return { k: nk, x: px - (px - v.x) * (nk / v.k), y: py - (py - v.y) * (nk / v.k) }
    })
  }, [])

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
    setView({ k, x: Math.max(PAD, (pw - gw * k) / 2), y: Math.max(PAD, (ph - gh * k) / 2) })
  }, [])

  /* Scroll pans; Ctrl or ⌘ with it (a trackpad pinch arrives that way) zooms
     at the pointer. Not passive, so the page itself does not scroll. Inside a
     card that is being written, the editor keeps its own scrolling. */
  useEffect(() => {
    const port = portRef.current
    if (!port) return undefined
    const onWheel = (e) => {
      if (e.target.closest?.('.plan-card.is-writing .cm-scroller')) return
      e.preventDefault()
      const r = port.getBoundingClientRect()
      if (e.ctrlKey || e.metaKey) {
        zoomAt(viewRef.current.k * Math.exp(-e.deltaY * 0.0025), e.clientX - r.left, e.clientY - r.top)
      } else {
        setView((v) => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }))
      }
    }
    port.addEventListener('wheel', onWheel, { passive: false })
    return () => port.removeEventListener('wheel', onWheel)
  }, [zoomAt])

  /* Dragging the background pans; two fingers pinch. A card, a button or a
     field keeps its own pointer. */
  const pointers = useRef(new Map())
  const gesture = useRef(null)
  const onPointerDown = (e) => {
    if (e.target.closest('.plan-card, .plan-add, .plan-insert, .plan-zoom, button, input, textarea')) return
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
      setView({ ...g.v, x: g.v.x + e.clientX - g.x0, y: g.v.y + e.clientY - g.y0 })
    } else {
      const [a, b] = [...pointers.current.values()]
      const k = clampK(g.v.k * (Math.hypot(a.x - b.x, a.y - b.y) / g.d0))
      setView({ k, x: g.mx - (g.mx - g.v.x) * (k / g.v.k), y: g.my - (g.my - g.v.y) * (k / g.v.k) })
    }
  }
  const onPointerUp = (e) => {
    pointers.current.delete(e.pointerId)
    const pts = [...pointers.current.values()]
    gesture.current = pts.length === 1 ? { kind: 'pan', x0: pts[0].x, y0: pts[0].y, v: viewRef.current } : null
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
    if (dx || dy) setView((v) => ({ ...v, x: v.x + dx, y: v.y + dy }))
  }, [fresh, boxes])
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
  const branch = (cardId) => {
    const card = blankCard()
    change((d) => { d.chains.push({ id: uid(), from: cardId, cards: [card] }) })
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
  const remove = (card) => {
    const hasWords = card.title.trim() || card.body.trim()
    if (hasWords && !window.confirm(`Delete “${card.title.trim() || 'this card'}”?`)) return
    change((d) => removeCard(d, card.id))
  }
  const setField = (cardId, key, value) => change((d) => {
    const at = findCard(d, cardId)
    if (at) at.ch.cards[at.i][key] = value
  })

  /* ---- the arrows ------------------------------------------------------ */
  const links = []
  const inserts = []
  const anchorOf = (b) => b.y + Math.min(ANCHOR, b.h / 2)
  for (const ch of chains) {
    const seq = [...ch.cards.map((c) => c.id), `+${ch.id}`]
    if (ch.from) {
      const p = boxes.get(ch.from)
      const q = boxes.get(seq[0])
      if (p && q) {
        const x0 = p.x + p.w
        const y0 = anchorOf(p)
        const y1 = anchorOf(q)
        const mx = x0 + GAP_X / 2
        const rr = Math.min(10, Math.abs(y1 - y0) / 2)
        links.push({
          key: `${ch.id}-from`,
          d: `M${x0},${y0} H${mx - rr} Q${mx},${y0} ${mx},${y0 + rr} V${y1 - rr} Q${mx},${y1} ${mx + rr},${y1} H${q.x - 4}`,
          faint: !ch.cards.length,
        })
      }
    }
    for (let i = 0; i < seq.length - 1; i++) {
      const a = boxes.get(seq[i])
      const b = boxes.get(seq[i + 1])
      if (!a || !b) continue
      const toSlot = i === seq.length - 2
      const y = anchorOf(a)
      links.push({ key: `${seq[i]}>${seq[i + 1]}`, d: `M${a.x + a.w},${y} H${b.x - 4}`, faint: toSlot })
      if (!toSlot) inserts.push({ key: `${ch.id}:${i + 1}`, chainId: ch.id, index: i + 1, x: a.x + a.w + GAP_X / 2, y })
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
      style={{
        backgroundSize: `${24 * view.k}px ${24 * view.k}px`,
        backgroundPosition: `${view.x}px ${view.y}px`,
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <div className="planboard__stage" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }}>
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
                first={i === 0}
                last={i === ch.cards.length - 1}
                writing={writing === c.id}
                fresh={fresh === c.id}
                onTitle={(v) => setField(c.id, 'title', v)}
                onBody={(v) => setField(c.id, 'body', v)}
                onWrite={() => setWriting(c.id)}
                onDoneWriting={() => setWriting((w) => (w === c.id ? null : w))}
                onAddAfter={() => insertAt(ch.id, i + 1)}
                onBranch={() => branch(c.id)}
                onMove={(dir) => move(c.id, dir)}
                onDelete={() => remove(c)}
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
  card, place, number, branchCard, first, last, writing, fresh,
  onTitle, onBody, onWrite, onDoneWriting, onAddAfter, onBranch, onMove, onDelete,
}) {
  /* A new card takes the cursor without the browser scrolling the canvas to
     it: Board pans the view there instead. */
  const titleRef = useRef(null)
  useEffect(() => {
    if (fresh) titleRef.current?.focus({ preventScroll: true })
  }, [fresh])

  return (
    <article
      data-at={card.id}
      className={cx('plan-card', writing && 'is-writing', branchCard && 'is-branch')}
      style={{ gridColumn: place.col + 1, gridRow: place.row + 1 }}
    >
      <header className="plan-card__head">
        {number ? <span className="plan-card__n">{number}</span> : <span className="plan-card__n is-branch" aria-hidden="true">↳</span>}
        <input
          className="plan-card__title"
          value={card.title}
          placeholder="Step"
          aria-label="Step title"
          ref={titleRef}
          onChange={(e) => onTitle(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); onWrite() } }}
        />
        <IconMenu
          label="Card options"
          items={[
            { key: 'after', label: 'Add a step after', onClick: onAddAfter },
            { key: 'branch', label: 'Branch from here', onClick: onBranch },
            { key: 'left', label: 'Move left', disabled: first, onClick: () => onMove(-1) },
            { key: 'right', label: 'Move right', disabled: last, onClick: () => onMove(1) },
            { key: 'delete', label: 'Delete card', danger: true, onClick: onDelete },
          ]}
        />
      </header>
      <div
        className="plan-card__body"
        onClick={writing ? undefined : onWrite}
        onKeyDown={writing ? undefined : (e) => { if (e.key === 'Enter') onWrite() }}
        role={writing ? undefined : 'button'}
        tabIndex={writing ? undefined : 0}
        aria-label={writing ? undefined : 'Write in this step'}
      >
        {writing ? (
          <Suspense fallback={<div className="plan-card__hint">…</div>}>
            <LiveMarkdown className="plan-card__editor" value={card.body} onChange={onBody} onBlur={onDoneWriting} autoFocus />
          </Suspense>
        ) : card.body.trim() ? (
          <ChatMarkdown className="chat__text--md plan-card__md" text={card.body} />
        ) : (
          <span className="plan-card__hint">Write…</span>
        )}
      </div>
    </article>
  )
}
