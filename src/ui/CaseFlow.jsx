/**
 * CaseFlow.jsx — a case drawn as a flow, not as a constellation.
 *
 * The case is the first step, its entries are the steps that come off it, and
 * a subtask is a step that comes off an entry. Each one is a card with a name
 * and a line of data under it, and the lines between them are curves that
 * leave one card's right edge and arrive at the next one's left.
 *
 * It replaces a force-directed graph, and the difference is the point: a
 * simulation decides where things go and you read the result, while a flow is
 * laid out — left to right, parents above the middle of their children — so
 * the same case comes out the same shape every time and the drawing says what
 * belongs to what rather than what is near what.
 *
 * Built as HTML cards over one SVG of wires rather than as a single SVG. Text
 * in SVG cannot wrap, cannot ellipsis and does not inherit the app's type
 * scale, and every one of those is a thing a card full of real words needs.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowUpRight, ChevronRight, Crosshair, Layers } from 'lucide-react';

import { buildGraph } from '../lib/graph.js';
import { IconMenu } from './primitives.jsx';

/* Card geometry, in layout pixels. The whole drawing is laid out at this size
   and then scaled as one piece to fit whatever box it is given, so these are
   proportions rather than measurements of anything on screen. */
const NODE_W = 178;
const NODE_H = 56;
const COL_GAP = 86;
const ROW_GAP = 14;
const PAD = 18;

/* Never blown up past its natural size: a case with two entries should sit
   quietly in the middle of the panel, not fill it with two enormous cards. */
const MAX_SCALE = 1;

function cx(...parts) {
  return parts.filter(Boolean).join(' ');
}

const DAY = 86400000;

/** The line of data under a card's name. Lower case, like every readout. */
function subline(node, now) {
  if (node.kind === 'case') return null;
  if (node.completed) return 'closed';
  if (!node.dueDate) return 'no date';
  const days = Math.round((startOfDay(node.dueDate) - startOfDay(now)) / DAY);
  if (days < 0) return `${-days}d overdue`;
  if (days === 0) return 'due today';
  if (days === 1) return 'due tomorrow';
  return `due in ${days}d`;
}

function startOfDay(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * Where every card goes.
 *
 * Depth is the column — a case, then its entries, then their subtasks — and
 * the vertical order is a tidy tree: leaves take the next free row, and a
 * parent sits level with the middle of its own children. That is the one rule
 * that makes a tree readable, and it is why the lines never cross.
 */
function layout(nodes, links) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const kids = new Map();
  const hasParent = new Set();
  for (const l of links) {
    if (!byId.has(l.source) || !byId.has(l.target)) continue;
    if (!kids.has(l.source)) kids.set(l.source, []);
    kids.get(l.source).push(l.target);
    hasParent.add(l.target);
  }

  const roots = nodes.filter((n) => !hasParent.has(n.id)).map((n) => n.id);
  const pos = new Map();
  const depth = new Map();

  let cursor = 0;
  /* Iterative rather than recursive: a parent chain that somehow points at
     itself would take the stack with it, and `seen` makes that a drawing with
     a missing branch instead of a blank screen. */
  const seen = new Set();
  const place = (id, d) => {
    if (seen.has(id)) return 0;
    seen.add(id);
    depth.set(id, d);
    const children = kids.get(id) || [];
    if (!children.length) {
      const y = cursor;
      cursor += NODE_H + ROW_GAP;
      pos.set(id, { x: d * (NODE_W + COL_GAP), y });
      return y;
    }
    let first = Infinity;
    let last = -Infinity;
    for (const c of children) {
      const y = place(c, d + 1);
      if (!pos.has(c)) continue;
      first = Math.min(first, y);
      last = Math.max(last, y);
    }
    const y = Number.isFinite(first) ? (first + last) / 2 : cursor;
    pos.set(id, { x: d * (NODE_W + COL_GAP), y });
    return y;
  };

  for (const r of roots) {
    place(r, 0);
    /* A gap between two separate trees, if a payload ever brings more than
       one — the dashboard asks for one case at a time, but nothing here
       depends on that being true. */
    cursor += ROW_GAP * 2;
  }
  /* Anything the walk never reached — an orphan, or a cycle — still gets
     drawn rather than silently dropped. */
  for (const n of nodes) {
    if (pos.has(n.id)) continue;
    pos.set(n.id, { x: 0, y: cursor });
    depth.set(n.id, 0);
    cursor += NODE_H + ROW_GAP;
  }

  let w = 0;
  let h = 0;
  for (const { x, y } of pos.values()) {
    w = Math.max(w, x + NODE_W);
    h = Math.max(h, y + NODE_H);
  }
  return { pos, depth, width: w + PAD * 2, height: h + PAD * 2 };
}

/** `09:43:02` — the time a thing was logged, to the second, like a run log. */
function clock(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '--:--:--';
  const two = (n) => String(n).padStart(2, '0');
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}

/**
 * Next case — one click moves the board on to the next top-level case.
 *
 * Wraps after the last one. Eight cases is a short loop, and a button that
 * stops working at the end reads as broken. The count says where in the loop
 * you are, so the wrap is never a surprise.
 */
function CaseDial({ cases, rootId, onPick }) {
  const list = useMemo(() => (cases || []).filter((c) => c && !c.parentId), [cases]);
  const index = Math.max(0, list.findIndex((c) => c.id === rootId));

  if (list.length < 2) return null;

  const next = list[(index + 1) % list.length];
  return (
    <button
      type="button"
      className="flow__dial"
      onClick={() => onPick(next.id)}
      title={`Next case: ${next.name}`}
      aria-label={`Case ${index + 1} of ${list.length}. Next case: ${next.name}`}
    >
      <span className="flow__dialpos">
        {String(index + 1).padStart(2, '0')}
        <span className="flow__sep">/</span>
        {String(list.length).padStart(2, '0')}
      </span>
      <ChevronRight size={12} strokeWidth={1.8} aria-hidden="true" />
    </button>
  );
}

export default function CaseFlow({
  cases,
  rootId = null,
  now = Date.now(),
  focus = false,
  onFocus = null,
  onPickCase = null,
  onOpenCase = null,
  /* The title bar, the tools and the run log. On the Case files deck the panel
     it sits in already has a header and a footer of its own, and two of each
     is a panel arguing with itself — there it is handed the canvas alone. */
  chrome = true,
  /* Pixels the first card sits past the left edge of the PANEL, instead of
     the drawing being centred. With the drawing lifted off the glass in 3D,
     the turn carries a card anchored at the edge a little way out over it,
     which is what says it is standing in front of the panel rather than
     printed on it. null centres it as before. */
  overhang = null,
  className = '',
}) {
  const data = useMemo(
    () => buildGraph(cases, { rootId, now, focus }),
    [cases, rootId, now, focus]
  );

  /* The mesh is every node joined to every other, which was the old drawing's
     whole idea and is exactly what a flow is not. Only the spine — parent to
     child — is a step. */
  const spine = useMemo(() => data.links.filter((l) => l.tier !== 'mesh'), [data]);

  const { pos, depth, width, height } = useMemo(
    () => layout(data.nodes, spine),
    [data.nodes, spine]
  );

  /* How many entries hang off the case, for the first card's own subline. */
  const childCount = useMemo(() => {
    const n = new Map();
    for (const l of spine) n.set(l.source, (n.get(l.source) || 0) + 1);
    return n;
  }, [spine]);

  /* The case this is a picture of, for the panel's title bar and its log. */
  const root = useMemo(
    () => (cases || []).find((c) => c && c.id === rootId) || null,
    [cases, rootId]
  );

  /* A change of case, counted. The count keys the scene below, so a new case
     mounts a fresh drawing whose step cards play their arrival — and only a
     change does: the first case on the board arrives with the board itself.
     Derived during render rather than in an effect, so the new case is never
     painted for one frame before the scene that animates it in. */
  const [swap, setSwap] = useState({ root: rootId, n: 0 });
  if (swap.root !== rootId) setSwap({ root: rootId, n: swap.n + 1 });

  /* The run log. Every app with a canvas in it has one of these along the
     bottom, and ours has something true to put in it: what was logged on this
     case, newest first, with the time it happened. */
  const runs = useMemo(() => {
    if (!root) return [];
    const out = [];
    for (const task of root.tasks || []) {
      if (!task) continue;
      out.push({ id: `t:${task.id}`, at: task.createdAt, title: task.title, done: !!task.completed });
      for (const sub of task.subtasks || []) {
        if (!sub) continue;
        out.push({ id: `s:${sub.id}`, at: sub.createdAt, title: sub.title, done: !!sub.completed, nested: true });
      }
    }
    return out
      .filter((r) => Number.isFinite(r.at))
      .sort((a, c) => c.at - a.at)
      .slice(0, 3);
  }, [root]);

  /* The word in the corner — "running", in the reference. Ours says how the
     case is standing, and the worst thing it can find comes first. */
  const standing = useMemo(() => {
    if (!data.counts.entries) return { tone: 'idle', text: 'empty' };
    if (data.counts.overdue) return { tone: 'overdue', text: `${data.counts.overdue} late` };
    const open = data.counts.entries + data.counts.subtasks - data.counts.done;
    if (open > 0) return { tone: 'soon', text: `${open} open` };
    return { tone: 'ok', text: 'all closed' };
  }, [data.counts]);

  const hostRef = useRef(null);
  const panelRef = useRef(null);
  const [fit, setFit] = useState({ s: 1, ox: 0, oy: 0 });

  /* One transform on one element. The cards and the wires are laid out in the
     same coordinates, so fitting them is a single scale rather than a size
     negotiation between two drawings. */
  const measure = useCallback(() => {
    const host = hostRef.current;
    if (!host) return;
    /* clientWidth, not getBoundingClientRect: the rect is the box as PAINTED,
       and this panel is routinely painted through a transform — folded away on
       the Case files deck, turned in perspective on the dashboard. Measuring
       that gives the size of a squashed box, and the flow fits itself into a
       sliver and stays there, because a transform does not change layout and
       the resize observer never fires to correct it. The layout size is the
       honest one. */
    const bw = host.clientWidth;
    const bh = host.clientHeight;
    if (!bw || !bh || !width || !height) return;
    if (overhang == null) {
      const s = Math.min(MAX_SCALE, bw / width, bh / height);
      setFit({ s, ox: (bw - width * s) / 2, oy: (bh - height * s) / 2 });
      return;
    }
    /* Measured from the panel's edge, not the canvas's: on the dashboard the
       canvas starts after the tools down the left, and an overhang taken from
       there would land on the tools rather than past the card. Layout
       offsets, for the same reason as clientWidth above. */
    const panel = panelRef.current;
    let inset = 0;
    let el = host;
    while (el && el !== panel) { inset += el.offsetLeft; el = el.offsetParent; }
    if (el !== panel) inset = 0;
    /* The room the overhang and the inset give back is room the drawing may
       use, so it fits a little larger by that much. */
    const s = Math.min(MAX_SCALE, (bw + inset + overhang) / width, bh / height);
    /* The first card's edge is PAD in from the drawing's, so the anchor is
       that card, not the drawing's invisible margin. */
    setFit({ s, ox: -PAD * s - inset - overhang, oy: (bh - height * s) / 2 });
  }, [width, height, overhang]);

  useLayoutEffect(() => { measure(); }, [measure]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || typeof ResizeObserver !== 'function') return undefined;
    const ro = new ResizeObserver(measure);
    ro.observe(host);
    return () => ro.disconnect();
  }, [measure]);

  /* Which card the pointer is on. Its own wires come up with it, and
     everything else steps back — the same gesture the old graph made, which is
     the one thing about it worth keeping. */
  const [hot, setHot] = useState(null);

  /* Where the pointer is over THIS panel, as -1 to 1, published for CSS.
     ----------------------------------------------------------------------
     The panel turns to face the pointer while you are on it, and that turn is
     a CSS rule on the card — so the only thing React has to do is say where
     the pointer is. The app already keeps a pointer field, but it is measured
     against the window: this panel covers about a third of it, so crossing the
     panel moves that field barely a tenth of its range and the card would sit
     at one angle the whole time it was hovered.

     Written straight onto the card rather than held in state, because a
     re-render per pointermove is a frame's work to produce a number that only
     CSS reads. Onto the CARD, not the document element: a custom property
     changed on the root restyles every element on the page, which measured at
     20-30ms a pointer frame. On the card, and registered non-inheriting in
     styles.css, it restyles the card and nothing else. Throttled onto a frame,
     with a trailing pass so the last position of a flick is not the one that
     gets dropped. */
  const fieldRaf = useRef(0);
  const fieldAt = useRef(null);

  const publish = useCallback(() => {
    fieldRaf.current = 0;
    const el = panelRef.current;
    if (!el) return;
    const card = el.closest('.card') || el;
    const at = fieldAt.current;
    card.style.setProperty('--gx', at ? at.x.toFixed(3) : '0');
    card.style.setProperty('--gy', at ? at.y.toFixed(3) : '0');
  }, []);

  const onField = useCallback(
    (e) => {
      const el = panelRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return;
      const unit = (v) => Math.max(-1, Math.min(1, v));
      fieldAt.current = {
        x: unit(((e.clientX - r.left) / r.width - 0.5) * 2),
        y: unit(((e.clientY - r.top) / r.height - 0.5) * 2),
      };
      if (!fieldRaf.current) fieldRaf.current = requestAnimationFrame(publish);
    },
    [publish]
  );

  const leaveField = useCallback(() => {
    fieldAt.current = null;
    if (fieldRaf.current) cancelAnimationFrame(fieldRaf.current);
    fieldRaf.current = 0;
    publish();
  }, [publish]);

  /* And it lets go of the angle when it unmounts, or a card left mid-turn
     would hand the next panel its leftover numbers. */
  useEffect(() => () => {
    if (fieldRaf.current) cancelAnimationFrame(fieldRaf.current);
    const el = panelRef.current;
    const card = el && (el.closest('.card') || el);
    if (card) {
      card.style.removeProperty('--gx');
      card.style.removeProperty('--gy');
    }
  }, []);

  const wires = useMemo(() => {
    const out = [];
    for (const l of spine) {
      const a = pos.get(l.source);
      const b = pos.get(l.target);
      if (!a || !b) continue;
      const x1 = a.x + NODE_W + PAD;
      const y1 = a.y + NODE_H / 2 + PAD;
      const x2 = b.x + PAD;
      const y2 = b.y + NODE_H / 2 + PAD;
      /* Flat where the cards are level and bowed where they are not, which is
         what a bezier with horizontal handles does on its own. */
      const dx = Math.max(28, (x2 - x1) * 0.5);
      out.push({
        key: `${l.source}>${l.target}`,
        source: l.source,
        target: l.target,
        tier: l.tier,
        d: `M${x1} ${y1}C${x1 + dx} ${y1} ${x2 - dx} ${y2} ${x2} ${y2}`,
        x1, y1, x2, y2,
        mx: (x1 + x2) / 2,
        my: (y1 + y2) / 2,
      });
    }
    return out;
  }, [spine, pos]);


  const empty = !data.nodes.length;

  const lit = (id) => {
    if (!hot) return null;
    if (hot === id) return 'hot';
    for (const w of wires) {
      if (w.source === hot && w.target === id) return 'near';
      if (w.target === hot && w.source === id) return 'near';
    }
    return null;
  };

  return (
    <div
      className={cx('flow', className)}
      ref={panelRef}
      onPointerMove={onField}
      onPointerLeave={leaveField}
    >
      {/* --- the title bar ---------------------------------------------- */}
      {chrome ? (
      <header className="flow__bar">
        <span key={`n${swap.n}`} className={cx('flow__name truncate', swap.n && 'is-swap')}>
          {root ? root.name : 'No case'}
        </span>
        <span className="flow__count">
          {data.nodes.length} steps
          <span className="flow__sep">/</span>
          {data.counts.entries} {data.counts.entries === 1 ? 'entry' : 'entries'}
          {data.counts.subtasks ? (
            <>
              <span className="flow__sep">/</span>
              {data.counts.subtasks} sub
            </>
          ) : null}
        </span>
        <span className={cx('statpill', `statpill--${standing.tone}`, 'flow__state')}>
          {standing.text}
        </span>
        {onPickCase ? <CaseDial cases={cases} rootId={rootId} onPick={onPickCase} /> : null}
      </header>
      ) : null}

      {/* --- the canvas, with its tools down the left side ---------------- */}
      <div className="flow__body">
        {chrome ? (
        <div className="flow__tools">
          {/* Three buttons and all three do something. The reference's are a
              canvas's own tools; ours are the three things there are to do to
              a picture of a case. */}
          <button
            type="button"
            className={cx('flow__tool', focus && 'is-on')}
            onClick={() => onFocus && onFocus(!focus)}
            disabled={!onFocus}
            aria-pressed={focus}
            title={focus ? 'Showing open entries only' : 'Show open entries only'}
          >
            <Crosshair size={14} strokeWidth={1.6} aria-hidden="true" />
          </button>

          <IconMenu
            className="flow__tool"
            label="Switch case"
            align="start"
            items={(cases || [])
              .filter((c) => c && !c.parentId)
              .map((c) => ({
                key: String(c.id),
                label: c.name,
                disabled: c.id === rootId,
                onClick: () => onPickCase && onPickCase(c.id),
              }))}
          />

          <button
            type="button"
            className="flow__tool"
            onClick={() => onOpenCase && root && onOpenCase(root.id)}
            disabled={!onOpenCase || !root}
            title="Open this case"
          >
            <ArrowUpRight size={14} strokeWidth={1.6} aria-hidden="true" />
          </button>

          <span className="flow__orb" aria-hidden="true" />
        </div>
        ) : null}

        <div
          className={cx('flow__canvas', empty && 'is-empty')}
          ref={hostRef}
          data-hot={hot ? '1' : undefined}
          onPointerLeave={() => setHot(null)}
        >
          <div
            key={`s${swap.n}`}
            className={cx('flow__scene', swap.n && 'is-swap')}
            style={{
              width: `${width}px`,
              height: `${height}px`,
              transform: `translate(${fit.ox.toFixed(1)}px, ${fit.oy.toFixed(1)}px) scale(${fit.s.toFixed(4)})`,
            }}
          >
            <svg
              className="flow__wires"
              viewBox={`0 0 ${width} ${height}`}
              width={width}
              height={height}
              aria-hidden="true"
            >
              {wires.map((w) => (
                <g
                  key={w.key}
                  className={cx('flow__wire', `flow__wire--${w.tier}`)}
                  data-lit={hot && (w.source === hot || w.target === hot) ? 'hot' : undefined}
                >
                  <path className="flow__line" d={w.d} />
                  <circle className="flow__port" cx={w.x1} cy={w.y1} r="2.6" />
                  <circle className="flow__port" cx={w.x2} cy={w.y2} r="2.6" />
                </g>
              ))}
            </svg>

            {/* The branch labels, in HTML rather than in the SVG, so they are
                the same monospace pill as every other label in the app. Only
                on the links that say something: an entry hanging off its case
                is the ordinary case and needs no word for it. */}
            {wires
              .filter((w) => w.tier === 'subtask' || w.tier === 'subcase')
              .map((w) => (
                <span
                  key={`l:${w.key}`}
                  className="flow__tag"
                  style={{ left: `${w.mx}px`, top: `${w.my}px` }}
                >
                  {w.tier === 'subtask' ? 'subtask' : 'sub-case'}
                </span>
              ))}

            {empty ? <span className="flow__none">Nothing to map yet</span> : null}

            {data.nodes.map((n) => {
              const at = pos.get(n.id);
              if (!at) return null;
              const sub = subline(n, now);
              const kids = childCount.get(n.id) || 0;
              return (
                <article
                  key={n.id}
                  className={cx('flow__node', `flow__node--${n.kind}`, `flow__node--${n.tone}`)}
                  data-lit={lit(n.id) || undefined}
                  style={{
                    '--col': depth.get(n.id) || 0,
                    left: `${at.x + PAD}px`,
                    top: `${at.y + PAD}px`,
                    width: `${NODE_W}px`,
                    height: `${NODE_H}px`,
                  }}
                  onPointerEnter={() => setHot(n.id)}
                  tabIndex={0}
                  onFocus={() => setHot(n.id)}
                  onBlur={() => setHot((h) => (h === n.id ? null : h))}
                >
                  <span className="flow__head">
                    <span className="flow__dot" aria-hidden="true" />
                    <span className="flow__title">{n.label}</span>
                  </span>
                  <span className="flow__sub">
                    {n.kind === 'case' ? `${kids} ${kids === 1 ? 'entry' : 'entries'}` : sub}
                  </span>
                </article>
              );
            })}
          </div>
        </div>
      </div>

      {/* --- what was logged, newest first ------------------------------- */}
      {chrome ? (
      <footer className="flow__runs">
        <span className="flow__runhead">last logged</span>
        {runs.length ? (
          runs.map((r) => (
            <div key={r.id} className="flow__run">
              <span
                className={cx('status-dot', r.done ? 'status-dot--live' : 'status-dot--idle')}
                aria-hidden="true"
              />
              <span className="flow__runat">{clock(r.at)}</span>
              <span className="flow__runwhat truncate">
                {r.done ? 'closed' : r.nested ? 'nested' : 'logged'}
                <span className="flow__sep">/</span>
                {r.title}
              </span>
            </div>
          ))
        ) : (
          <span className="flow__runnone">nothing logged yet</span>
        )}
      </footer>
      ) : null}
    </div>
  );
}

export { CaseFlow };
