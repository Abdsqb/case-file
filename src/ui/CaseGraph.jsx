/**
 * CaseGraph.jsx — the Case structure, as a graph.
 *
 * A node per case, per sub-case, per entry and per subtask, linked parent to
 * child. One case is one connected component; the dashboard draws every case at
 * once and they separate themselves, because nothing links across a case and
 * repulsion pushes unconnected things apart. That is the whole trick — the
 * "links only within a case" rule is not enforced here, it is a property of how
 * buildGraph makes edges (see lib/graph.js).
 *
 * WHY SVG, AND WHY NO NODE CAP
 * The instinct in this codebase is that many moving SVG elements are the enemy:
 * 576 polygons re-writing their `points` each frame put the renderer at ~20fps
 * for half a second, which is why the terrain this replaces was so careful.
 * That lesson does not transfer, and it was worth measuring rather than
 * assuming. Animating every node and edge, at the real data's 123 nodes / 115
 * edges and then upward:
 *
 *        nodes     123     250     500    1000    2000
 *        svg     16.7ms  16.7ms  16.7ms  16.7ms  16.7ms   0 dropped frames
 *        canvas  16.7ms  16.7ms  16.7ms  16.7ms  16.7ms   0 dropped frames
 *
 * Flat 60fps to sixteen times the real load, on both. Re-parsing and
 * re-tessellating a polygon is expensive; setting cx/cy on a circle is not.
 * So SVG it is, and with it CSS colour tokens, real hit-testing, a focus ring
 * and the app's own hover readout — none of which canvas gives for free. The
 * old MAX_NODES = 40 cap has no reason to exist and is gone.
 *
 * HOW IT MOVES
 * React renders the elements ONCE, keyed by node id. The simulation then writes
 * transforms and line endpoints straight to the DOM through refs, outside React
 * — the same escape hatch the terrain used for its morph. Re-rendering 123
 * components per frame through state would be the actual performance problem.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { neighbourMap } from '../lib/graph.js';

/* ------------------------------------------------------------------ motion */

const RM_QUERY = '(prefers-reduced-motion: reduce)';

/* Matches IsoCase's contract exactly, including defaulting to reduced when
   there is no window — a server render must not claim motion it cannot do. */
function readMotionPrefs() {
  if (typeof window === 'undefined') return { reduced: true, parallax: false };
  let sysReduced = false;
  try {
    sysReduced = window.matchMedia(RM_QUERY).matches;
  } catch {
    sysReduced = false;
  }
  let forced = false;
  let parallaxOff = false;
  try {
    forced = window.localStorage.getItem('casefile.reducedMotion') === 'on';
    parallaxOff = window.localStorage.getItem('casefile.parallax') === 'off';
  } catch {
    /* storage unavailable — fall through to defaults */
  }
  const reduced = sysReduced || forced;
  return { reduced, parallax: !reduced && !parallaxOff };
}

/* ------------------------------------------------------------------- layout */

/* The drawing is done in a fixed 1000x1000 space and scaled by CSS, so nothing
   here has to know the element's pixel size and a resize costs nothing. */
const VB = 1000;
const MID = VB / 2;

const SIM = {
  /* Repulsion is an inverse square, so holding the same equilibrium at a wider
     spacing means scaling it by the square of that widening — it is not a free
     constant to leave behind when the nodes grow. */
  REPULSE: 4000,    // inverse-square push between every pair of nodes
  MIN_D2: 400,      // floor on distance² so a coincident pair cannot explode
  SPRING: 0.055,    // pull along a link toward REST
  /* A small case has no crowding to answer to, so its links sit at this length
     flat. It is set by the RATIO it makes against a 20-unit dot — 150:20 is
     7.5x, the same proportion a crowded case reaches through ARC — so a
     two-entry case and a forty-entry case read as the same drawing at
     different sizes. */
  REST: 150,
  /* Room one child takes up on its parent's ring. A case with 37 entries cannot
     fit them at REST — 37 nodes 26 units wide need ~165 units of radius, not 95 —
     and packing them in anyway is what turned the biggest case into a solid
     blob. Rest length is therefore per link, scaled by how many children the
     parent is trying to hold. */
  ARC: 34,
  REST_MAX: 420,    // even a huge case has to stay on the board
  /* Each case is pulled toward its OWN anchor rather than everything toward the
     middle. Repulsion alone does separate disconnected components, but slowly
     and not far — measured with eight cases it left them interleaved, with
     entries from a 28-node case sitting nearer another case's hub than their
     own. The anchor gives each case territory; repulsion and springs shape what
     happens inside it. Too strong and a cluster collapses into its anchor, so
     this is deliberately gentle. */
  ANCHOR: 0.011,
  /* The anchor exists to give each case its own territory when several are on
     screen. With only ONE case there is no territory to defend, and the force
     becomes a pull from every node toward a single point — which quietly rounds
     the case off into a disc no matter what shape its links would otherwise
     make. Measured side by side on the same data, relaxing it is the difference
     between one round blob and distinct lobes. So it is nearly switched off
     when there is nothing to separate. */
  ANCHOR_SOLO: 0.0015,
  DAMP: 0.84,
  MAX_V: 14,        // speed clamp; without it the first few ticks fling nodes
  SETTLED: 0.09,    // mean speed below this and the graph is done moving
  MAX_TICKS: 900,   // hard stop, in case a pathological graph never settles
  STATIC_TICKS: 500, // iterations run synchronously when motion is off
  /* How long a link is allowed to be once drawn, in viewBox units.

     Shortening the springs alone does nothing: the fit zooms whatever the
     simulation produces up to fill the card, so a tighter layout just gets
     magnified back to the same picture. This is the ceiling that makes
     "shorter" stick — the fit may shrink the drawing to fit the frame, but it
     may not stretch it past the point where links read this long. A small graph
     then sits compact in the middle of its card instead of being flung to the
     corners to fill it. */
  /* What actually sets the character of the drawing is not the node size or the
     link length on its own but the RATIO between them. Measured on screen, a
     105-unit link against a 28-unit dot read 3.6-4.1x, which is a huddle; the
     reference graph this is modelled on sits nearer 7-9x, which is what makes
     it read as a constellation with air in it. 155 against a 20-unit dot is
     7.8x. Change either of these two numbers and check the ratio, not the
     number. */
  /* Now that the fit is a true zoom, this no longer sets the proportions — it
     only caps how large the whole drawing may be blown up. The ratio is fixed
     by REST, ARC and the dot radii, so this can be generous enough to let a
     single case use its card without making that case look any different. */
  LINK_TARGET: 300,
  SEPARATION: 4,    // clear air left between two dots, in drawn units
  /* Separation is run more than once per tick because resolving one overlap can
     introduce another in a tight cluster; a single pass leaves a residue that
     the next tick's springs re-compress. Three passes converge and make the
     rule absolute, whatever the forces are doing. */
  SEPARATION_PASSES: 3,
  /* The mesh — every node in a case joined to every other — needs its own
     terms. Its rest length grows with the square root of the case's size,
     because that is how the radius of a packed disc of n things grows; a flat
     length would make a small case sprawl and a large one crush itself.

     Its pull is a small fraction of the spine's, and it has to be: there are
     O(n²) mesh links against O(n) spine links, so a node in a 38-node case
     carries 37 mesh springs against one spine link. At anything like the
     spine's strength the sum overwhelms every other force, the velocity clamp
     turns it into an oscillation that never settles, and dots end up pushed
     through each other — measured at 0.16, 52 pairs overlapped, the worst by
     58%. Held down here the mesh is what it should be: something the case is
     drawn wearing, not something that decides where anything goes. */
  /* Tuned so the mesh's rest length lands near the spread a case settles into
     on its own. Shorter and 37 springs per node quietly crush the cluster
     inward; longer and they inflate it. Near-neutral is what lets the mesh be
     decoration rather than a second, competing layout. */
  MESH_SPREAD: 40,
  MESH_SPRING: 0.003,
};

/* How far the drawing leans toward the pointer, in viewBox units. Small on
   purpose: this is a hint of depth, not a joystick. */
const PARALLAX = 16;

/* Size and furniture, not colour, are what separate the four kinds here — which
   is what white nodes demand, since colour is spent on urgency instead.

   A case wears a reticle: a hollow ring standing off from the dot, so a hub reads
   as a marker pinned to the board rather than as a bigger dot. Nothing else
   carries one.

   r: the drawn dot's radius. ring: a hollow circle at this radius, 0 for none. */
const SHAPE = {
  case:    { r: 26, ring: 0 },
  subcase: { r: 18, ring: 0 },
  entry:   { r: 12, ring: 0 },
  subtask: { r: 8.5, ring: 0 },
};

/* A node is drawn as a guilloche rosette rather than a plain dot: a ring of
   closed loops, a second band inside it on the two structural kinds, and a
   filled core that carries the state colour.

   It is an epitrochoid — the curve traced by a point on a small circle rolling
   around the outside of a larger one. `loops` is how many times the small
   circle goes round, `d` how far the traced point sits from its centre; d
   larger than the small radius is exactly what makes each petal close into a
   loop instead of merely scalloping the edge.

   `steps` is set per kind rather than globally: a subtask is drawn a few pixels
   across and detail there is invisible, so it would be paying for points nobody
   can see. The four strings are built once at module load and shared by every
   node of that kind — the geometry never changes, only the translate on the
   group that holds it. */
function guilloche(reach, loops, dRatio, steps) {
  const r = 1 / loops;
  const d = dRatio * r;
  /* The curve's true extent is 1 + r + d, so scale by that to land inside the
     radius the layout has reserved for this node. */
  const k = reach / (1 + r + d);
  const R = k;
  const rr = r * k;
  const dd = d * k;
  const turn = (R + rr) / rr;
  let out = '';
  for (let i = 0; i <= steps; i += 1) {
    const t = (i / steps) * Math.PI * 2;
    const x = (R + rr) * Math.cos(t) - dd * Math.cos(turn * t);
    const y = (R + rr) * Math.sin(t) - dd * Math.sin(turn * t);
    out += `${i ? 'L' : 'M'}${x.toFixed(2)} ${y.toFixed(2)}`;
  }
  return `${out}Z`;
}

/* loops / d / steps / how much of the radius the filled core takes / a second
   band at this fraction of the radius, 0 for none. */
const ROSETTE = {
  /* steps is ~13 points per loop, which is where a loop stops looking faceted;
     it was nearly twice that and the extra points bought nothing visible while
     costing 9 dropped frames per settle across sixty-odd rosettes. */
  case:    { loops: 13, d: 1.7, steps: 170, core: 0.3, inner: 0.62 },
  subcase: { loops: 11, d: 1.7, steps: 140, core: 0.32, inner: 0.6 },
  entry:   { loops: 9, d: 1.8, steps: 100, core: 0.42, inner: 0 },
  subtask: { loops: 7, d: 1.8, steps: 72, core: 0.44, inner: 0 },
};

const GLYPH = Object.fromEntries(
  Object.entries(SHAPE).map(([kind, sh]) => {
    const g = ROSETTE[kind] || ROSETTE.entry;
    return [kind, {
      outer: guilloche(sh.r, g.loops, g.d, g.steps),
      inner: g.inner ? guilloche(sh.r * g.inner, g.loops, g.d, g.steps) : null,
      core: sh.r * g.core,
    }];
  })
);

/* How far a node reaches from its centre — the reticle, where there is one,
   reaches further than the dot. The fit, the hit test and the label offset all
   measure against this, so it is derived from SHAPE rather than written out a
   second time and left to drift. */
const RADIUS = Object.fromEntries(
  Object.entries(SHAPE).map(([kind, sh]) => [kind, Math.max(sh.ring, sh.r)])
);

const MASS = { case: 9, subcase: 5, entry: 1.6, subtask: 1 };

/* Long case names are truncated on the surface — the hover readout carries the
   full one, and a 26-character name is wider than any cluster it labels. */
const LABEL_MAX = 18;
const short = (t) => (t.length > LABEL_MAX ? `${t.slice(0, LABEL_MAX - 1).trimEnd()}…` : t);

/** Deterministic PRNG, so the same case always lays out the same way. */
function rng(seedText) {
  let h = 2166136261;
  const s = String(seedText);
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return () => {
    h += 0x6d2b79f5;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Where each case sits.
 *
 * Anchors go on a ring, but the arc each case gets is proportional to the
 * square root of its size — a 28-node case and a 1-node case given equal arc
 * puts the big one on top of its neighbours. sqrt rather than linear because a
 * cluster's radius grows with the square root of its node count, not with the
 * count itself.
 */
/* The radius a case's cluster settles into — the same arithmetic the per-link
   rest length uses, so anchors are spaced by what the clusters will actually
   become rather than by a guess that goes stale the moment a size changes. */
function clusterRadius(count) {
  return Math.max(SIM.REST, ((count - 1) * SIM.ARC) / (2 * Math.PI));
}

function anchorsFor(nodes, groups) {
  const size = new Map(groups.map((g) => [g, 0]));
  for (const n of nodes) size.set(n.group, (size.get(n.group) || 0) + 1);

  /* Seat every case side by side around one circle: each wants its own full
     width of circumference, plus a margin so neighbours do not touch. Deriving
     the ring from the clusters is what keeps them apart as the nodes grow — a
     fixed ring would have let the biggest case swallow its neighbours the
     moment the spacing widened. */
  /* Generous, and it costs nothing: the zoom is capped by link length, so a
     wider ring pushes the cases apart on screen without making any link longer.
     It spends the card's empty margin on separating clusters, which is exactly
     what that space is for. */
  /* Just enough air to read the cases apart. It was near twice this when the
     dots did not scale with the layout and clusters kept colliding; now that
     separation is scale-invariant they cannot, so the ring can close up and let
     each case be large in the frame rather than a small knot far from its
     neighbours. */
  const GAP = 1.2;
  const width = groups.map((g) => clusterRadius(size.get(g) || 1) * 2 * GAP);
  const total = width.reduce((a, w) => a + w, 0) || 1;
  const ring = groups.length === 1 ? 0 : total / (2 * Math.PI);

  const out = new Map();
  let acc = 0;
  groups.forEach((g, i) => {
    /* Arc in proportion to the width each case asked for, so the circumference
       budget and the angles it hands out are the same measure. */
    const a = ((acc + width[i] / 2) / total) * Math.PI * 2;
    acc += width[i];
    out.set(g, { x: MID + Math.cos(a) * ring, y: MID + Math.sin(a) * ring });
  });
  return out;
}

/**
 * Starting positions: scattered around the case's own anchor. Seeding by
 * cluster rather than at random is what stops eight cases from starting as one
 * ball and having to shove each other apart for the first second.
 */
function seedPositions(nodes, groups, seedText) {
  const rand = rng(seedText);
  const anchors = anchorsFor(nodes, groups);

  return nodes.map((node) => {
    const a = anchors.get(node.group) || { x: MID, y: MID };
    const spread = node.kind === 'case' ? 8 : 70;
    return {
      x: a.x + (rand() - 0.5) * spread,
      y: a.y + (rand() - 0.5) * spread,
      vx: 0,
      vy: 0,
      sx: null,
      sy: null,
      ax: a.x,
      ay: a.y,
      m: MASS[node.kind] || 1,
    };
  });
}

/**
 * One step of the simulation, in place.
 *
 * All-pairs repulsion is O(n²) and that sounds alarming until you put the real
 * number on it: 123 nodes is 7,503 pairs, a few hundred microseconds. A
 * quadtree would be the right call at ten thousand nodes and pure ceremony
 * here. Returns the mean speed so the caller can tell when it has settled.
 */
/**
 * Push apart any two dots that would be drawn overlapping. Returns how many
 * pairs it had to fix, so a caller can iterate until the answer is zero.
 *
 * This is a position correction, not another force — a force lets a pair sit
 * inside each other for as long as it takes to argue them apart, and two
 * overlapping dots read as one misshapen blob rather than as two entries.
 *
 * The radii here are DRAWN sizes while the simulation works in its own units,
 * which the fit then scales; dividing by that scale is what puts the two in the
 * same space. Without it nodes would be held apart by the wrong amount in
 * exactly the dense graphs where it matters.
 */
function separate(pos, rad, passes) {
  const n = pos.length;
  let fixed = 0;
  for (let pass = 0; pass < passes; pass += 1) {
    let hit = 0;
    for (let i = 0; i < n; i += 1) {
      const a = pos[i];
      for (let j = i + 1; j < n; j += 1) {
        const b = pos[j];
        const need = rad[i] + rad[j] + SIM.SEPARATION;
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let d = Math.sqrt(dx * dx + dy * dy);
        if (d >= need) continue;
        if (d < 1e-6) {
          dx = (i % 5) - 2 || 1;
          dy = (j % 3) - 1 || 1;
          d = Math.sqrt(dx * dx + dy * dy);
        }
        const push = (need - d) / d / 2;
        const px = dx * push;
        const py = dy * push;
        a.x -= px; a.y -= py;
        b.x += px; b.y += py;
        hit += 1;
      }
    }
    fixed += hit;
    if (!hit) break;
  }
  return fixed;
}

function tick(pos, links, index, rests, springs, rad, anchorK) {
  const n = pos.length;

  for (let i = 0; i < n; i += 1) {
    const a = pos[i];
    for (let j = i + 1; j < n; j += 1) {
      const b = pos[j];
      let dx = a.x - b.x;
      let dy = a.y - b.y;
      let d2 = dx * dx + dy * dy;
      if (d2 < SIM.MIN_D2) {
        // Exactly coincident gives a zero vector and NaN forces; nudge instead.
        d2 = SIM.MIN_D2;
        if (dx === 0 && dy === 0) { dx = (i % 7) - 3 || 1; dy = (j % 5) - 2 || 1; }
      }
      const f = SIM.REPULSE / d2;
      const d = Math.sqrt(d2);
      const fx = (dx / d) * f;
      const fy = (dy / d) * f;
      a.vx += fx / a.m;
      a.vy += fy / a.m;
      b.vx -= fx / b.m;
      b.vy -= fy / b.m;
    }
  }

  for (let li = 0; li < links.length; li += 1) {
    const l = links[li];
    const a = pos[index.get(l.source)];
    const b = pos[index.get(l.target)];
    if (!a || !b) continue;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
    const f = (d - rests[li]) * springs[li];
    const fx = (dx / d) * f;
    const fy = (dy / d) * f;
    a.vx += fx / a.m;
    a.vy += fy / a.m;
    b.vx -= fx / b.m;
    b.vy -= fy / b.m;
  }

  let speed = 0;
  for (let i = 0; i < n; i += 1) {
    const p = pos[i];
    p.vx += (p.ax - p.x) * anchorK;
    p.vy += (p.ay - p.y) * anchorK;
    p.vx *= SIM.DAMP;
    p.vy *= SIM.DAMP;

    const v = Math.hypot(p.vx, p.vy);
    if (v > SIM.MAX_V) { p.vx = (p.vx / v) * SIM.MAX_V; p.vy = (p.vy / v) * SIM.MAX_V; }

    p.x += p.vx;
    p.y += p.vy;
    speed += Math.hypot(p.vx, p.vy);
  }

  separate(pos, rad, SIM.SEPARATION_PASSES);

  return speed / (n || 1);
}

/** Fit whatever the simulation settled on into the viewBox, with a margin. */
function frameOf(pos, nodes, cap) {
  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
  for (let i = 0; i < pos.length; i += 1) {
    const r = RADIUS[nodes[i].kind] || 5;
    if (pos[i].x - r < minX) minX = pos[i].x - r;
    if (pos[i].y - r < minY) minY = pos[i].y - r;
    if (pos[i].x + r > maxX) maxX = pos[i].x + r;
    if (pos[i].y + r > maxY) maxY = pos[i].y + r;
  }
  if (!Number.isFinite(minX)) return { s: 1, ox: 0, oy: 0 };

  const PAD = 58;
  const w = Math.max(1, maxX - minX);
  const h = Math.max(1, maxY - minY);
  /* Shrink to fit the frame, but never stretch past the density ceiling the
     caller worked out from the link lengths. */
  const s = Math.min((VB - PAD * 2) / w, (VB - PAD * 2) / h, cap);
  return {
    s,
    ox: MID - ((minX + maxX) / 2) * s,
    oy: MID - ((minY + maxY) / 2) * s,
  };
}

/* --------------------------------------------------------------- the readout */

function fmtDue(ts, now) {
  if (!Number.isFinite(ts)) return null;
  const a = new Date(ts); a.setHours(0, 0, 0, 0);
  const b = new Date(now); b.setHours(0, 0, 0, 0);
  const days = Math.round((a - b) / 86400000);
  if (days < 0) return `${-days} ${-days === 1 ? 'day' : 'days'} overdue`;
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  return `in ${days} days`;
}

const KIND_WORD = { case: 'Case', subcase: 'Sub-case', entry: 'Entry', subtask: 'Subtask' };
const TONE_WORD = {
  done: 'closed', overdue: 'overdue', urgent: 'due now', soon: 'due soon',
  normal: 'open', structure: '',
};

/**
 * Portalled, because the graph sits in a card with overflow clipping and a tip
 * rendered inside it would be cut off at the edge. Same furniture as the
 * calendar's readout — this is the app's one hover card, used on two screens.
 */
function GraphTip({ node, anchor, now }) {
  const ref = useRef(null);
  const [pos, setPos] = useState(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !anchor) return;
    const GAP = 14;
    const EDGE = 8;
    const { width: w, height: h } = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let left = anchor.x + GAP;
    if (left + w > vw - EDGE) left = anchor.x - GAP - w;
    if (left < EDGE) left = Math.min(Math.max(EDGE, anchor.x), vw - w - EDGE);

    let top = anchor.y - h / 2;
    top = Math.min(Math.max(EDGE, top), vh - h - EDGE);
    setPos({ top, left });
  }, [node, anchor]);

  if (typeof document === 'undefined' || !node) return null;

  const due = fmtDue(node.dueDate, now);
  const state = TONE_WORD[node.tone] || '';
  const tone = node.tone === 'overdue' || node.tone === 'urgent' ? 'live'
    : node.tone === 'soon' ? 'soon'
      : node.tone === 'done' ? 'past' : 'later';

  return createPortal(
    <div
      ref={ref}
      className="schedtip"
      aria-hidden="true"
      style={{ top: pos ? pos.top : -9999, left: pos ? pos.left : -9999 }}
    >
      <div className="schedtip__title">{node.label}</div>
      {state ? <div className={`schedtip__state schedtip__state--${tone}`}>{state}</div> : null}
      <dl className="schedtip__rows">
        <div className="schedtip__row">
          <dt>What</dt>
          <dd>{KIND_WORD[node.kind] || 'Node'}</dd>
        </div>
        {node.kind !== 'case' ? (
          <div className="schedtip__row">
            <dt>In</dt>
            <dd>
              {node.caseName}
              {node.parentLabel ? <span className="schedtip__sub">under {node.parentLabel}</span> : null}
            </dd>
          </div>
        ) : null}
        {due ? (
          <div className="schedtip__row">
            <dt>Due</dt>
            <dd>{due}</dd>
          </div>
        ) : null}
      </dl>
    </div>,
    document.body
  );
}

/* ---------------------------------------------------------------- the graph */

/**
 * graph — the output of buildGraph(), built by the VIEW rather than here.
 *
 * The view needs the counts for its own header ("123 nodes"), and having it
 * build the graph means those counts and this drawing are the same object
 * rather than two derivations that could drift.
 */
export default function CaseGraph({ graph, now = Date.now(), className = '', seed = 0 }) {
  const svgRef = useRef(null);
  const worldRef = useRef(null);
  const fitRef = useRef(null);
  const nodeRefs = useRef(new Map());
  const labelRefs = useRef(new Map());
  /* How far parallax has shifted the drawing. The hit test works in viewBox
     coordinates against the positions the simulation wrote, so it has to undo
     this shift or every node would be off by it. */
  const shiftRef = useRef({ x: 0, y: 0 });
  const linkRefs = useRef([]);
  const meshRef = useRef(null);
  const meshLitRef = useRef(null);
  const rafRef = useRef(0);
  const posRef = useRef([]);

  const [prefs, setPrefs] = useState(readMotionPrefs);

  const sync = useCallback(() => {
    setPrefs((prev) => {
      const next = readMotionPrefs();
      return prev.reduced === next.reduced && prev.parallax === next.parallax ? prev : next;
    });
  }, []);

  useEffect(() => {
    let mql = null;
    try { mql = window.matchMedia(RM_QUERY); } catch { mql = null; }
    if (mql) {
      if (typeof mql.addEventListener === 'function') mql.addEventListener('change', sync);
      else if (typeof mql.addListener === 'function') mql.addListener(sync);
    }
    window.addEventListener('storage', sync);
    window.addEventListener('casefile:settings', sync);
    sync();
    return () => {
      if (mql) {
        if (typeof mql.removeEventListener === 'function') mql.removeEventListener('change', sync);
        else if (typeof mql.removeListener === 'function') mql.removeListener(sync);
      }
      window.removeEventListener('storage', sync);
      window.removeEventListener('casefile:settings', sync);
    };
  }, [sync]);

  const nodes = graph && graph.nodes ? graph.nodes : [];
  const links = graph && graph.links ? graph.links : [];
  const groups = graph && graph.groups ? graph.groups : [];
  const counts = (graph && graph.counts) || { cases: 0, subcases: 0, entries: 0, subtasks: 0, overdue: 0 };

  const index = useMemo(() => new Map(nodes.map((n, i) => [n.id, i])), [nodes]);
  /* Only the structure carries a name on the surface. A hundred entry labels at
     once is not a graph, it is a wall of text — an entry gives its name on
     hover instead. */
  /* The spine keeps one element per link — there are only ever n of them, they
     carry their tier, and hover has to light them individually. The mesh is
     O(n²) of identical hairlines and becomes a SINGLE path: on real data that
     is 611 elements React no longer has to mount, which is what a case switch
     was spending 250ms doing. */
  const spineLinks = useMemo(() => links.filter((l) => l.tier !== 'mesh'), [links]);
  const meshLinks = useMemo(() => links.filter((l) => l.tier === 'mesh'), [links]);

  const labelled = useMemo(
    () => nodes.filter((n) => n.kind === 'case' || n.kind === 'subcase'),
    [nodes]
  );
  const near = useMemo(() => neighbourMap(links), [links]);

  /* The layout key answers "is this the same graph?". Node IDENTITY only: the
     app's clock ticks every minute and rebuilds the graph object with fresh
     tones, and if the simulation restarted on that the diagram would re-scatter
     itself once a minute for no reason. Recolouring is not relayout. */
  const layoutKey = useMemo(
    () => `${seed}|${nodes.map((n) => n.id).join(',')}`,
    [seed, nodes]
  );

  /* The effect below runs only when layoutKey changes, so it must not close
     over nodes/links directly — it would capture whichever array existed at
     that moment. This ref is always current. */
  const dataRef = useRef({ nodes, links, index, groups, spine: spineLinks, mesh: meshLinks });
  dataRef.current = { nodes, links, index, groups, spine: spineLinks, mesh: meshLinks };

  /* The pointer handler reads the preference through a ref: it fires constantly,
     and rebuilding it whenever a setting changes would churn the listener. */
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;

  const [hot, setHot] = useState(null);   // { node, anchor:{x,y} }

  /* ---- the simulation ---------------------------------------------------- */

  useLayoutEffect(() => {
    const svg = svgRef.current;
    const data = dataRef.current;
    if (!svg || !data.nodes.length) return undefined;

    const pos = seedPositions(data.nodes, data.groups, layoutKey);
    posRef.current = pos;

    /* A spine link's rest length is set by how crowded its parent is, so a case
       with many entries blooms wide instead of balling up. Only SPINE links
       count toward that crowding: under the mesh every node is joined to every
       other, so a raw degree reads n-1 for all of them and says nothing about
       who is actually a parent. */
    const deg = new Array(data.nodes.length).fill(0);
    for (const l of data.links) {
      if (l.tier === 'mesh') continue;
      deg[data.index.get(l.source)] += 1;
      deg[data.index.get(l.target)] += 1;
    }

    /* How many nodes each case holds, which sets how wide its mesh sits. */
    const groupSize = new Map();
    for (const n of data.nodes) groupSize.set(n.group, (groupSize.get(n.group) || 0) + 1);
    /* Drawn radii, in node order, for the separation pass. */
    const rad = data.nodes.map((n) => (SHAPE[n.kind] || SHAPE.entry).r);
    /* One case on screen needs no territory, so the anchor stands down. */
    const anchorK = data.groups.length > 1 ? SIM.ANCHOR : SIM.ANCHOR_SOLO;
    /* The scale the last paint settled on; separation needs it to convert drawn
       sizes into simulation units. It starts at 1 and is current from the
       second frame on. */
    let scale = 1;

    const rests = data.links.map((l) => {
      if (l.tier === 'mesh') {
        return SIM.MESH_SPREAD * Math.sqrt(groupSize.get(l.group) || 1);
      }
      return Math.min(
        SIM.REST_MAX,
        Math.max(SIM.REST, (deg[data.index.get(l.source)] * SIM.ARC) / (2 * Math.PI))
      );
    });
    const springs = data.links.map((l) => (l.tier === 'mesh' ? SIM.MESH_SPRING : SIM.SPRING));

    /* The zoom ceiling: the median link as it currently stands, against how long
       a link is allowed to be drawn. Measured rather than derived from REST,
       because repulsion stretches links well past their rest length and it is
       the drawn result that has to read tight. */
    const lens = new Array(data.links.length);
    const densityCap = () => {
      /* Measured over the SPINE only. The mesh joins every pair in a case, so
         its median length describes how wide a cluster is rather than how long
         a link is — zooming by that would be zooming by the wrong quantity. */
      let k = 0;
      for (let i = 0; i < data.links.length; i += 1) {
        if (data.links[i].tier === 'mesh') continue;
        const a = pos[data.index.get(data.links[i].source)];
        const b = pos[data.index.get(data.links[i].target)];
        lens[k] = a && b ? Math.hypot(b.x - a.x, b.y - a.y) : 0;
        k += 1;
      }
      if (!k) return 4.2;
      const spine = lens.slice(0, k).sort((x, y) => x - y);
      const med = spine[k >> 1] || 1;
      return SIM.LINK_TARGET / med;
    };

    /* `full` draws the mesh too. While the layout is still moving the mesh is
       skipped: it is O(n²) lines against O(n) of everything else — 776 against
       57 on real data — and updating all of them each frame cost 23 dropped
       frames out of 198 during a settle. It is decoration, it is a blur in
       motion anyway, and the spine alone carries the movement perfectly well.
       It gets one full paint and fades in once the graph stops. */
    const paint = () => {
      const { s, ox, oy } = frameOf(pos, data.nodes, densityCap());
      scale = s;

      /* The fit is ONE transform on one group rather than a multiplication
         baked into every coordinate. That is what makes the dots zoom along
         with their own layout, and it matters for more than tidiness: when a
         node's size and its distance from its neighbours scale together, the
         proportion between them — the thing that actually gives the drawing its
         character — is fixed by the layout and cannot drift with how many cases
         happen to be on screen. It also makes overlap scale-invariant, so
         separation becomes a plain fact about the layout instead of something
         that has to be re-argued against the current zoom every frame. */
      const fit = fitRef.current;
      if (fit) {
        fit.setAttribute('transform', `translate(${ox.toFixed(1)} ${oy.toFixed(1)}) scale(${s.toFixed(4)})`);
        fit.__s = s;
        fit.__ox = ox;
        fit.__oy = oy;
      }

      for (let i = 0; i < data.nodes.length; i += 1) {
        const el = nodeRefs.current.get(data.nodes[i].id);
        if (el) el.setAttribute('transform', `translate(${pos[i].x.toFixed(1)} ${pos[i].y.toFixed(1)})`);

        /* Labels stay OUTSIDE the zoomed group and are placed in final
           coordinates, so a name keeps its size whether one case is on screen
           or eight. Only its offset below the dot scales, because the dot it
           has to clear does. */
        const x = pos[i].x * s + ox;
        const y = pos[i].y * s + oy;
        pos[i].sx = x;
        pos[i].sy = y;
        const lab = labelRefs.current.get(data.nodes[i].id);
        if (lab) {
          lab.setAttribute('x', x.toFixed(1));
          lab.setAttribute('y', (y + (RADIUS[data.nodes[i].kind] || 5) * s + 20).toFixed(1));
        }
      }
      for (let i = 0; i < data.spine.length; i += 1) {
        const el = linkRefs.current[i];
        if (!el) continue;
        const a = pos[data.index.get(data.spine[i].source)];
        const b = pos[data.index.get(data.spine[i].target)];
        if (!a || !b) continue;
        el.setAttribute('x1', a.x.toFixed(1));
        el.setAttribute('y1', a.y.toFixed(1));
        el.setAttribute('x2', b.x.toFixed(1));
        el.setAttribute('y2', b.y.toFixed(1));
      }

      /* The mesh is drawn on every frame, from the first one.

         It used to be held back until the layout stopped, because updating it
         meant writing to hundreds of separate <line> elements and that cost
         real frames. It is one path now — a single string and a single
         setAttribute — so the reason for deferring it is gone, and holding it
         back only made the graph look like it was assembling itself twice. */
      if (meshRef.current) {
        const parts = new Array(data.mesh.length);
        for (let i = 0; i < data.mesh.length; i += 1) {
          const a = pos[data.index.get(data.mesh[i].source)];
          const b = pos[data.index.get(data.mesh[i].target)];
          parts[i] = a && b
            ? `M${a.x.toFixed(1)} ${a.y.toFixed(1)}L${b.x.toFixed(1)} ${b.y.toFixed(1)}`
            : '';
        }
        meshRef.current.setAttribute('d', parts.join(''));
      }
    };

    if (prefs.reduced) {
      /* No animation, but the graph must still be CORRECT — a reduced-motion
         user gets the settled layout, not an empty box. Run it to convergence
         in one synchronous pass and paint once. */
      for (let i = 0; i < SIM.STATIC_TICKS; i += 1) {
        if (tick(pos, data.links, data.index, rests, springs, rad, anchorK) < SIM.SETTLED) break;
      }
      /* The first pass ran with a guessed scale because nothing had been drawn
         yet. Paint to learn the real one, then let separation settle against it
         before the frame anyone sees. */
      paint();
      for (let i = 0; i < 80; i += 1) tick(pos, data.links, data.index, rests, springs, rad, anchorK);
      for (let i = 0; i < 40 && separate(pos, rad, 1); i += 1) { /* settle */ }
      paint();
      return undefined;
    }

    let ticks = 0;
    const loop = () => {
      /* Two steps a frame: the sim reaches its resting shape in about half the
         wall-clock time and the maths is nowhere near the frame budget. */
      tick(pos, data.links, data.index, rests, springs, rad, anchorK);
      const speed = tick(pos, data.links, data.index, rests, springs, rad, anchorK);
      ticks += 2;
      paint();
      if (speed < SIM.SETTLED || ticks > SIM.MAX_TICKS) {
        /* The springs stop where they stop, and in a tight case that can leave
           a few dots slightly inside each other. Nothing will run after this to
           tidy it, so resolve the overlaps outright and repaint before parking. */
        for (let i = 0; i < 40 && separate(pos, rad, 1); i += 1) { /* settle */ }
        paint();
        /* Parked, not spinning. An idle rAF loop on a settled graph is a wasted
           wake-up sixty times a second for as long as the tab is open. */
        rafRef.current = 0;
        return;
      }
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    };
  }, [layoutKey, prefs.reduced]);

  /* ---- hover ------------------------------------------------------------- */

  /* Hit-tested in JS against the painted positions rather than with 123 DOM
     listeners: one handler, and it can pick the NEAREST node rather than
     whichever 3px circle the pointer happened to land on. */
  const onMove = useCallback((e) => {
    const svg = svgRef.current;
    const pos = posRef.current;
    const data = dataRef.current;
    if (!svg || !pos.length) return;
    const r = svg.getBoundingClientRect();
    if (!r.width || !r.height) return;
    /* Pointer parallax: the whole drawing leans a few units toward the cursor.
       One transform on one group, so it is compositor work rather than a
       relayout — the codebase's own rule that only transform and opacity are
       cheap to animate is why this shifts the world instead of the nodes. */
    const px = (e.clientX - r.left) / r.width;
    const py = (e.clientY - r.top) / r.height;
    if (prefsRef.current.parallax) {
      const sx = (px - 0.5) * 2 * PARALLAX;
      const sy = (py - 0.5) * 2 * PARALLAX;
      shiftRef.current = { x: sx, y: sy };
      if (worldRef.current) worldRef.current.setAttribute('transform', `translate(${sx.toFixed(1)} ${sy.toFixed(1)})`);
    }

    /* Undo the parallax lean, then the fit, so the pointer arrives in the same
       coordinates the layout is stored in and the radii below mean what they
       say. The slack is divided by the zoom too, so the forgiving margin around
       a dot stays the same size on screen however far the view is zoomed out. */
    const fit = fitRef.current;
    const fs = (fit && fit.__s) || 1;
    const fox = (fit && fit.__ox) || 0;
    const foy = (fit && fit.__oy) || 0;
    const x = (px * VB - shiftRef.current.x - fox) / fs;
    const y = (py * VB - shiftRef.current.y - foy) / fs;
    const slack = 11 / fs;

    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < pos.length; i += 1) {
      const p = pos[i];
      const d = (p.x - x) ** 2 + (p.y - y) ** 2;
      const rad = (RADIUS[data.nodes[i].kind] || 5) + slack;
      if (d < bestD && d < rad * rad) { bestD = d; best = i; }
    }

    if (best === -1) { setHot((h) => (h ? null : h)); return; }
    const node = data.nodes[best];
    setHot((h) => (h && h.node.id === node.id ? h : { node, anchor: { x: e.clientX, y: e.clientY } }));
  }, []);

  const onLeave = useCallback(() => {
    setHot(null);
    shiftRef.current = { x: 0, y: 0 };
    if (worldRef.current) worldRef.current.setAttribute('transform', 'translate(0 0)');
  }, []);

  /* Lighting the neighbourhood touches only the few elements involved — not a
     re-render, and not a pass over every node.

     Written to dataset rather than classList on purpose: React owns className
     on these elements and rewrites it wholesale whenever a tone changes, which
     would silently wipe an imperative class mid-hover. It does not know about
     data-lit. */
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return undefined;
    if (!hot) { svg.removeAttribute('data-hot'); return undefined; }

    svg.setAttribute('data-hot', '1');
    const lit = near.get(hot.node.id) || new Set();
    const touched = [];

    const mark = (el, value) => {
      if (!el) return;
      el.dataset.lit = value;
      touched.push(el);
    };
    mark(nodeRefs.current.get(hot.node.id), 'hot');
    for (const id of lit) mark(nodeRefs.current.get(id), 'near');
    spineLinks.forEach((l, i) => {
      if (l.source === hot.node.id || l.target === hot.node.id) mark(linkRefs.current[i], 'near');
    });

    /* The mesh cannot be lit per element any more, so the segments meeting the
       hovered node are redrawn into their own path. With a case fully meshed
       this is the spider of links from that node to everything else it shares a
       case with — the clearest thing the mesh does, and worth keeping. */
    const litPath = meshLitRef.current;
    const pos = posRef.current;
    if (litPath && pos.length) {
      const idx = dataRef.current.index;
      const d = [];
      for (const l of dataRef.current.mesh) {
        if (l.source !== hot.node.id && l.target !== hot.node.id) continue;
        const a = pos[idx.get(l.source)];
        const b = pos[idx.get(l.target)];
        if (a && b) d.push(`M${a.x.toFixed(1)} ${a.y.toFixed(1)}L${b.x.toFixed(1)} ${b.y.toFixed(1)}`);
      }
      litPath.setAttribute('d', d.join(''));
      touched.push(litPath);
      litPath.dataset.lit = 'near';
    }

    return () => {
      for (const el of touched) delete el.dataset.lit;
      if (meshLitRef.current) meshLitRef.current.removeAttribute('d');
    };
  }, [hot, near, spineLinks]);

  /* ---- the render -------------------------------------------------------- */

  if (!nodes.length) {
    return (
      <div className={`cg cg--empty ${className}`.trim()}>
        <span className="cg__empty">Nothing to map yet</span>
      </div>
    );
  }

  const summary = [
    `${counts.cases} ${counts.cases === 1 ? 'case' : 'cases'}`,
    counts.subcases ? `${counts.subcases} sub-cases` : null,
    `${counts.entries} entries`,
    counts.subtasks ? `${counts.subtasks} subtasks` : null,
    counts.overdue ? `${counts.overdue} overdue` : null,
  ].filter(Boolean).join(', ');

  return (
    <>
      <svg
        ref={svgRef}
        className={`cg ${className}`.trim()}
        viewBox={`0 0 ${VB} ${VB}`}
        role="img"
        /* The graph is a picture of the entries list beside it, and that list is
           the keyboard-navigable version of the same data. So this describes the
           shape rather than pretending 123 circles are controls. */
        aria-label={`Case structure: ${summary}`}
        onPointerMove={onMove}
        onPointerLeave={onLeave}
      >
        {/* Everything the simulation draws lives in one group, so parallax is a
            single transform rather than a write per node. */}
        <g className="cg__world" ref={worldRef}>
        <g className="cg__fit" ref={fitRef}>
        {/* One path for every mesh segment in the graph, and a second holding
            just the ones meeting the hovered node. Two elements in place of
            hundreds. */}
        <path className="cg__mesh" ref={meshRef} />
        <path className="cg__mesh cg__mesh--lit" ref={meshLitRef} />
        <g className="cg__links">
          {spineLinks.map((l, i) => (
            <line
              key={`${l.source}>${l.target}`}
              ref={(el) => { linkRefs.current[i] = el; }}
              className={`cg__link cg__link--${l.tier || 'entry'}`}
            />
          ))}
        </g>
        <g className="cg__nodes">
          {nodes.map((n) => {
            const glyph = GLYPH[n.kind] || GLYPH.entry;
            return (
              <g
                key={n.id}
                ref={(el) => {
                  if (el) nodeRefs.current.set(n.id, el);
                  else nodeRefs.current.delete(n.id);
                }}
                className={`cg__node cg__node--${n.kind} cg__node--${n.tone}`}
              >
                <path className="cg__rose" d={glyph.outer} />
                {glyph.inner ? <path className="cg__rose cg__rose--inner" d={glyph.inner} /> : null}
                <circle className="cg__dot" r={glyph.core} />
              </g>
            );
          })}
        </g>
        </g>
        {/* Labels ride above every node, in their own layer. Inside the node
            group they were painted in node order, and buildGraph emits a case
            before its entries — so each case's own entries were drawn on top of
            its name. */}
        <g className="cg__labels">
          {labelled.map((n) => (
            <text
              key={n.id}
              ref={(el) => {
                if (el) labelRefs.current.set(n.id, el);
                else labelRefs.current.delete(n.id);
              }}
              className={`cg__label cg__label--${n.kind}`}
            >
              {short(n.label)}
            </text>
          ))}
        </g>
        </g>
      </svg>
      {hot ? <GraphTip node={hot.node} anchor={hot.anchor} now={now} /> : null}
    </>
  );
}

export { CaseGraph };
