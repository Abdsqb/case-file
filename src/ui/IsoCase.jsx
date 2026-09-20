import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';

/* ============================================================================
   IsoCase — the centrepiece.

   A softly lit isometric wireframe room that depicts the active case as a
   structure: a floor plate, four corner posts, a lit back grid wall washed in
   --glow, and one floating node per entry standing on the floor.

   Pure inline SVG. No 3D library, no dependencies. 30 degree axonometric:
       x -> (+0.866, +0.5)
       y -> (-0.866, +0.5)
       z -> ( 0.000, -1.0)

   <IsoCase entries={[{ id, title, tone:'normal'|'soon'|'urgent'|'overdue'|'done' }]}
            completion={0..1} />

   `soon` is "inside the deadline window" — the caller decides what that means
   (see statusTone), this only renders it.
============================================================================ */

/* --------------------------------------------------------------- geometry */

const S = 10;        // floor plate: S x S units
const U = 21;        // px per unit
const OX = 230;      // projection origin — the back corner of the plate
const OY = 150;      // centres the cage's vertical span in the 400 viewBox
const KX = 0.8660254037844386 * U;
const KY = 0.5 * U;

const VB_W = 460;
const VB_H = 400;

/** Project a point in case-space to screen px. */
function px(x, y, z = 0) {
  return [OX + KX * (x - y), OY + KY * (x + y) - U * z];
}

/** Project to an SVG "x,y" pair for polygon/polyline point lists. */
/* Rounded by arithmetic rather than toFixed: a morph frame calls this ~3500
   times, and toFixed is the single most expensive thing in that loop. */
const r2 = (v) => Math.round(v * 100) / 100;
function pt(x, y, z = 0) {
  return `${r2(OX + KX * (x - y))},${r2(OY + KY * (x + y) - U * z)}`;
}

/** Project a segment to { x1, y1, x2, y2 } screen px. */
function seg(ax, ay, az, bx, by, bz) {
  const a = px(ax, ay, az);
  const b = px(bx, by, bz);
  return { x1: +a[0].toFixed(2), y1: +a[1].toFixed(2), x2: +b[0].toFixed(2), y2: +b[1].toFixed(2) };
}

/* ---------------------------------------------------------------- the surface
   A mathematical surface plot suspended in a wireframe cage: a gridded floor
   and two gridded back walls, with a wireframe relief floating inside them.

   Everything here is computed once per seed. The parallax is a CSS transform on
   one group, so none of this is recomputed per frame.
   ------------------------------------------------------------------------- */

const GRID_N = 24;      // surface cells per axis
const CELL = S / GRID_N;
const CAGE_H = 5.6;     // cage height, in units
const CAGE_DIV = 8;     // cage grid divisions per axis
const MID = 2.75;       // the height the sheet floats at
const AMP = 2.05;       // relief either side of MID

/* The light for the sheet's shading: from the back-left and above, which is
   where the cage's lit corner is. */
const LIGHT = (() => {
  const v = [-0.44, -0.32, 0.84];
  const m = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / m, v[1] / m, v[2] / m];
})();

/* ---- the cage. Seed-independent, so it is built once at module scope. ---- */

const CAGE_FLOOR = [];
for (let k = 0; k <= CAGE_DIV; k += 1) {
  const t = (S * k) / CAGE_DIV;
  CAGE_FLOOR.push({ key: `fx${k}`, ...seg(t, 0, 0, t, S, 0) });
  CAGE_FLOOR.push({ key: `fy${k}`, ...seg(0, t, 0, S, t, 0) });
}

/* Back-right wall is the y = 0 plane, back-left is x = 0 — the two planes that
   face the viewer from behind the sheet. */
const CAGE_WALL = [];
for (let k = 0; k <= CAGE_DIV; k += 1) {
  const t = (S * k) / CAGE_DIV;
  CAGE_WALL.push({ key: `wrv${k}`, ...seg(t, 0, 0, t, 0, CAGE_H) });
  CAGE_WALL.push({ key: `wlv${k}`, ...seg(0, t, 0, 0, t, CAGE_H) });
}
for (let k = 1; k <= 5; k += 1) {
  const z = (CAGE_H * k) / 5;
  CAGE_WALL.push({ key: `wrh${k}`, ...seg(0, 0, z, S, 0, z) });
  CAGE_WALL.push({ key: `wlh${k}`, ...seg(0, 0, z, 0, S, z) });
}

/* The box's own edges, brighter than the grid inside it. */
const CAGE_EDGE = [
  { key: 'e-floor', pts: [pt(S, 0), pt(S, S), pt(0, S)].join(' ') },
  { key: 'e-back', pts: [pt(0, 0), pt(S, 0)].join(' ') },
  { key: 'e-back2', pts: [pt(0, 0), pt(0, S)].join(' ') },
  { key: 'e-top-r', pts: [pt(0, 0, CAGE_H), pt(S, 0, CAGE_H)].join(' ') },
  { key: 'e-top-l', pts: [pt(0, 0, CAGE_H), pt(0, S, CAGE_H)].join(' ') },
  { key: 'e-post-b', pts: [pt(0, 0, 0), pt(0, 0, CAGE_H)].join(' ') },
  { key: 'e-post-r', pts: [pt(S, 0, 0), pt(S, 0, CAGE_H)].join(' ') },
  { key: 'e-post-l', pts: [pt(0, S, 0), pt(0, S, CAGE_H)].join(' ') },
];

/** A small integer hash, so a seed string picks a stable surface. */
function hash01(seed) {
  const str = seed === null || seed === undefined ? '0' : String(seed);
  let h = 2166136261;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 100000) / 100000;
}

/**
 * The surface. A sum of incommensurate waves — smooth, and a pure function of
 * position and seed. It must NOT depend on entry data: adding an entry may not
 * reshape the sheet under pins already standing on it.
 *
 * No edge taper here, unlike the old slab: the sheet runs to the footprint edges
 * and its rim curves freely, which is what gives the plot its silhouette.
 */
function makeHeight(seed) {
  const h = hash01(seed);
  const p1 = h * 6.2832;
  const p2 = h * 11.7 + 1.3;
  const p3 = h * 4.1 + 2.7;

  return function heightAt(x, y) {
    const u = x / S;
    const v = y / S;
    const z =
      0.74 * Math.sin(u * 4.6 + p1) * Math.cos(v * 3.9 + p2) +
      0.28 * Math.sin(u * 7.4 + v * 5.2 + p3) +
      0.12 * Math.cos(u * 10.8 - v * 8.1 + p1 * 2);
    return Math.max(0.35, Math.min(CAGE_H - 0.35, MID + z * AMP));
  };
}


/* The order the painter's algorithm needs — far to near, by x + y. It does not
   depend on the heightfield, so it is settled once here and EVERY seed's faces
   are built by walking it. That is the whole basis of the morph below: the
   polygon at DOM index k is the same cell for every case, so switching cases
   can rewrite the points of the polygons already on screen instead of mounting
   new ones. Deriving the order per-seed would have left it resting on
   Array#sort stability, which is a promise about the sort, not about this. */
const FACE_ORDER = [];
for (let j = 0; j < GRID_N; j += 1) {
  for (let i = 0; i < GRID_N; i += 1) FACE_ORDER.push({ i, j });
}
FACE_ORDER.sort((a, b) => a.i + a.j - (b.i + b.j));

/* One polyline per grid line: the rows first, then the columns. */
const MESH_LINES = [];
for (let j = 0; j <= GRID_N; j += 1) MESH_LINES.push({ key: `mx${j}`, row: true, idx: j });
for (let i = 0; i <= GRID_N; i += 1) MESH_LINES.push({ key: `my${i}`, row: false, idx: i });

/* A cell's fill is black lifted a few percent toward --fg by the light. Saying
   that as color-mix() is the honest way to write it and costs nothing on a static
   render — but a morph rewrites 576 of them a frame and the style engine
   re-resolves the colour function on every one. Measured: 33ms a frame, exactly
   double the budget, where the same 576 writes carrying a plain rgb() held
   vsync. So the tokens are read once off the live element and the whole ramp is
   resolved up front into strings a morph can simply index. styles.css stays the
   only place these colours are written down; nothing is duplicated here.

   The percentage is a whole number for the same reason: quantised, most cells
   keep the same fill from one frame to the next and the write can be skipped. */
const faceFill = (pct, ramp) =>
  (ramp ? ramp[pct] : `color-mix(in srgb, var(--fg) ${pct}%, var(--bg))`);

function parseInk(v) {
  const t = (v || '').trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(t);
  if (hex) {
    const h = hex[1].length === 3 ? hex[1].replace(/./g, (c) => c + c) : hex[1];
    const n = parseInt(h, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const nums = t.match(/[\d.]+/g);
  return nums && nums.length >= 3 ? nums.slice(0, 3).map(Number) : null;
}

/* Read from the element rather than :root, so the ramp reflects whatever token
   context the diagram is actually sitting in. Returns null if the tokens cannot
   be read, and faceFill falls back to color-mix — slower, but never wrong. */
function buildRamp(el) {
  if (!el) return null;
  try {
    const cs = getComputedStyle(el);
    const fg = parseInk(cs.getPropertyValue('--fg'));
    const bg = parseInk(cs.getPropertyValue('--bg'));
    if (!fg || !bg) return null;
    const ramp = new Array(101);
    for (let k = 0; k <= 100; k += 1) {
      const t = k / 100;
      ramp[k] =
        `rgb(${Math.round(bg[0] + (fg[0] - bg[0]) * t)},` +
        `${Math.round(bg[1] + (fg[1] - bg[1]) * t)},` +
        `${Math.round(bg[2] + (fg[2] - bg[2]) * t)})`;
    }
    return ramp;
  } catch {
    return null;
  }
}

/** Vertex heights, then the shaded cells and the mesh that rides over them. */
function buildTerrain(seed) {
  const heightAt = makeHeight(seed);

  const H = [];
  for (let j = 0; j <= GRID_N; j += 1) {
    const row = [];
    for (let i = 0; i <= GRID_N; i += 1) row.push(heightAt(i * CELL, j * CELL));
    H.push(row);
  }
  const hv = (i, j) => H[j][i];

  let zMin = Infinity;
  let zMax = -Infinity;
  for (const row of H) for (const z of row) { if (z < zMin) zMin = z; if (z > zMax) zMax = z; }

  /* Painter's algorithm: in this projection screen y grows with (x + y), so
     larger (x + y) is nearer the viewer. Sorting ascending draws far-to-near, so
     a near crest correctly hides what is behind it. */
  const faces = [];
  for (const { i, j } of FACE_ORDER) {
    const x0 = i * CELL;
    const y0 = j * CELL;
    const x1 = x0 + CELL;
    const y1 = y0 + CELL;
    const h00 = hv(i, j);
    const h10 = hv(i + 1, j);
    const h11 = hv(i + 1, j + 1);
    const h01 = hv(i, j + 1);

    const dzdx = (h10 + h11 - (h00 + h01)) / (2 * CELL);
    const dzdy = (h01 + h11 - (h00 + h10)) / (2 * CELL);
    const nx = -dzdx;
    const ny = -dzdy;
    const nm = Math.hypot(nx, ny, 1) || 1;   // never 0: nz is 1
    const lambert = Math.max(0, (nx * LIGHT[0] + ny * LIGHT[1] + LIGHT[2]) / nm);

    const mid = (h00 + h10 + h11 + h01) / 4;
    const rel = zMax > zMin ? (mid - zMin) / (zMax - zMin) : 0.5;

    /* This is a wireframe, so a cell is an opaque black occluder, not a lit
       surface — that is the only reason the faces exist. But painting them flat
       costs the relief all sense of form, so the lambert term survives as a
       whisper: a crest facing the light lifts a few percent off black, just
       enough to feel like a solid. */
    faces.push({
      key: `f${i}-${j}`,
      pts: [pt(x0, y0, h00), pt(x1, y0, h10), pt(x1, y1, h11), pt(x0, y1, h01)].join(' '),
      pct: Math.round(3 + 10 * lambert + 4 * rel),
    });
  }

  const mesh = MESH_LINES.map((m) => {
    const out = [];
    if (m.row) for (let i = 0; i <= GRID_N; i += 1) out.push(pt(i * CELL, m.idx * CELL, hv(i, m.idx)));
    else for (let j = 0; j <= GRID_N; j += 1) out.push(pt(m.idx * CELL, j * CELL, hv(m.idx, j)));
    return { key: m.key, pts: out.join(' ') };
  });

  return { heightAt, faces, mesh, H, pct: faces.map((f) => f.pct) };
}



/* ------------------------------------------------------------- the morph */

const MORPH_MS = 300;

/* Eased both ends. The ground has to leave and arrive at rest, or a case switch
   reads as a jolt rather than a landscape flowing into a new shape. */
const easeMorph = (p) => (p < 0.5 ? 4 * p * p * p : 1 - (-2 * p + 2) ** 3 / 2);

/** A scratch shape to lerp into, allocated once per morph rather than per frame. */
function blankShape() {
  const H = [];
  for (let j = 0; j <= GRID_N; j += 1) H.push(new Float64Array(GRID_N + 1));
  // -1 is "nothing written yet", so the first frame always paints.
  return { H, pct: new Int16Array(FACE_ORDER.length).fill(-1) };
}

/**
 * Flow one terrain into another by rewriting attributes on the elements already
 * on screen — nothing mounts, nothing reconciles, React is not involved at all.
 * `live` receives the interpolated shape, so a morph cut short can be picked up
 * from exactly what is displayed instead of snapping.
 */
function writeMorph(a, b, e, faceEls, meshEls, live, ramp) {
  for (let j = 0; j <= GRID_N; j += 1) {
    const ra = a.H[j];
    const rb = b.H[j];
    const rl = live.H[j];
    for (let i = 0; i <= GRID_N; i += 1) rl[i] = ra[i] + (rb[i] - ra[i]) * e;
  }

  for (let k = 0; k < FACE_ORDER.length; k += 1) {
    const cell = FACE_ORDER[k];
    const i = cell.i;
    const j = cell.j;
    const x0 = i * CELL;
    const y0 = j * CELL;
    const x1 = x0 + CELL;
    const y1 = y0 + CELL;
    const el = faceEls[k];
    el.setAttribute(
      'points',
      pt(x0, y0, live.H[j][i]) + ' ' + pt(x1, y0, live.H[j][i + 1]) + ' ' +
        pt(x1, y1, live.H[j + 1][i + 1]) + ' ' + pt(x0, y1, live.H[j + 1][i])
    );
    // Whole percent, so most cells hold the same fill frame to frame and the
    // write — the expensive half of this loop — is skipped outright.
    const q = Math.round(a.pct[k] + (b.pct[k] - a.pct[k]) * e);
    if (q !== live.pct[k]) {
      live.pct[k] = q;
      el.style.fill = faceFill(q, ramp);
    }
  }

  for (let k = 0; k < MESH_LINES.length; k += 1) {
    const m = MESH_LINES[k];
    const out = [];
    if (m.row) {
      for (let i = 0; i <= GRID_N; i += 1) out.push(pt(i * CELL, m.idx * CELL, live.H[m.idx][i]));
    } else {
      for (let j = 0; j <= GRID_N; j += 1) out.push(pt(m.idx * CELL, j * CELL, live.H[j][m.idx]));
    }
    meshEls[k].setAttribute('points', out.join(' '));
  }
}

/* --------------------------------------------------------------- the nodes */

/* Hard cap — 200 entries must not choke. Exported because a caller that reports
   a pin count has to know when the cap bites, or it will claim pins that are not
   on the surface. */
export const MAX_NODES = 40;
const GOLDEN = 2.399963229728653;        // golden angle, radians
const MAX_R = S / 2 - 0.95;              // keeps every node on the plate
const NODE_M = 0.3;                      // node half-size, units

/* The spiral's spacing is quantised into these buckets rather than tracking the
   entry count continuously. Within a bucket every node keeps its exact spot, so
   adding or closing an entry usually moves nothing at all; the structure only
   re-scales when the case crosses a threshold. */
const SPIRAL_BUCKETS = [4, 9, 16, 25, MAX_NODES];

function spiralScale(n) {
  const b = SPIRAL_BUCKETS.find((v) => n <= v) || MAX_NODES;
  return Math.min(1.2, MAX_R / Math.sqrt(Math.max(b - 1, 1)));
}

/**
 * Deterministic phyllotaxis spiral. Position depends ONLY on the entry's index
 * and the bucketed count — never on randomness, time or render order — so a node
 * never jumps between renders.
 */
function spiralPos(i, a) {
  const r = Math.min(MAX_R, a * Math.sqrt(i));
  const th = i * GOLDEN;
  return [S / 2 + r * Math.cos(th), S / 2 + r * Math.sin(th)];
}

/** Deterministic float height, so the cluster has relief without randomness. */
function nodeHeight(i) {
  return 0.55 + ((i * 7) % 5) * 0.16;
}

/** An axis-aligned unit square at height z, projected to a rhombus. */
function squarePts(x, y, z, m) {
  return [pt(x - m, y - m, z), pt(x + m, y - m, z), pt(x + m, y + m, z), pt(x - m, y + m, z)].join(' ');
}

/* How many pins get their own step in the pop sequence before the rest share
   the last one. At 50ms a step this keeps the tail inside the build window
   (660 + 16*50 + 460 = 1920ms) rather than being cut off mid-pop. */
const PIN_STAGGER_CAP = 16;
const PIN_STEP = 50;        // ms between consecutive pins, cold build
const PIN_STEP_SWAP = 20;   // ...and on a switch, where the wait is the whole cost
const PIN_POP_MS = 460;     // one pin's pop
const PIN_BASE_COLD = 660;  // cold screen: hold back for the room to assemble
const PIN_BASE_SWAP = 140;  // case switch: the room is already standing

/** Trimmed so a long entry title cannot stretch the readout off the plate. */
const TIP_MAX = 30;

function tipTitle(t) {
  const s = String(t || 'Untitled entry');
  return s.length > TIP_MAX ? `${s.slice(0, TIP_MAX - 1)}…` : s;
}

/**
 * The second line of a node's readout. Built here rather than by the caller so
 * both views get the identical wording from one place.
 */
function tipMeta(e) {
  const bits = [];
  if (e.completed || e.tone === 'done') bits.push('closed');
  else if (e.dueDate) {
    const d = new Date(e.dueDate);
    bits.push(
      Number.isNaN(d.getTime())
        ? 'no date'
        : `due ${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
    );
  } else bits.push('no date');
  if (e.tone === 'overdue') bits.push('overdue');
  else if (e.tone === 'soon') bits.push('due soon');
  if (e.priority === 'high') bits.push('high');
  if (e.isSub) bits.push('subtask');
  return bits.join(' · ');
}

function buildNodes(entries, count, heightAt) {
  const out = [];
  const a = spiralScale(count);
  for (let i = 0; i < count; i += 1) {
    const e = entries[i] || {};
    /* Anything unrecognised falls back to `normal` rather than throwing away the
       pin, so an older caller that knows nothing of `soon` still renders. */
    const tone =
      e.tone === 'overdue' ? 'overdue'
      : e.tone === 'done' ? 'done'
      : e.tone === 'urgent' ? 'urgent'
      : e.tone === 'soon' ? 'soon'
      : 'normal';
    const [x, y] = spiralPos(i, a);
    // The ground under this pin. Every part of the pin is measured from here, so
    // it stands ON the terrain instead of floating at the old z = 0 plane.
    const g = heightAt ? heightAt(x, y) : 0;
    const float = tone === 'done' ? 0.34 : nodeHeight(i);
    const h = g + float;
    const top = px(x, y, h);
    out.push({
      id: e.id != null ? `${e.id}` : `n${i}`,
      cls:
        tone === 'overdue' ? 'hot'
        : tone === 'done' ? 'done'
        : tone === 'urgent' ? 'urgent'
        : tone === 'soon' ? 'soon'
        : '',
      depth: x + y,
      ground: g,
      stem: seg(x, y, g, x, y, h),
      shadow: squarePts(x, y, g + 0.02, NODE_M * 0.85),
      cap: squarePts(x, y, h, NODE_M),
      cx: +top[0].toFixed(2),
      cy: +top[1].toFixed(2),
      label: tipTitle(e.title),
      meta: tipMeta(e),
    });
  }
  // Painter's algorithm: far corner first, nearest last.
  out.sort((a, b) => a.depth - b.depth);
  return out;
}

/* --------------------------------------------------------- motion settings */

/*
 * Two optional overrides. Both are read-only and both are safely absent:
 *   localStorage['casefile.reducedMotion'] === 'on'   -> force reduced motion
 *   localStorage['casefile.parallax']      === 'off'  -> kill parallax only
 * After writing either key, dispatch:
 *   window.dispatchEvent(new Event('casefile:settings'))
 * The cross-tab 'storage' event is honoured too.
 */
const RM_QUERY = '(prefers-reduced-motion: reduce)';

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

/* ---------------------------------------------------------------- the CSS */

const CSS = `
.ic-svg{display:block;width:100%;height:auto}
.ic-g{transform-box:fill-box;transform-origin:50% 50%;will-change:transform}
.ic-ln{fill:none;stroke-width:1;vector-effect:non-scaling-stroke;stroke-linecap:round}
/* A wireframe. The cell is an opaque black occluder so a near crest hides the
   ridges behind it — the mesh alone would read as a flat lattice. Its exact fill
   is set per cell: black lifted a few percent toward --fg by the light, so the
   relief still reads as form rather than a silhouette. */
.ic-face{fill:var(--bg);stroke:none}
.ic-mesh{stroke:var(--fg);opacity:.6;stroke-width:.75}
.ic-cage{stroke:var(--fg-dim);opacity:.3}
.ic-cage-edge{stroke:var(--fg-dim);opacity:.5;fill:none}
.ic-struct{stroke:var(--line)}
.ic-course{stroke:var(--line-soft);opacity:.7}
.ic-floorgrid{stroke:var(--line-soft);opacity:.85}
.ic-grid{stroke:var(--line)}
.ic-grid-lit{stroke:var(--glow);opacity:.5}
.ic-grid-far{stroke:var(--line-soft)}
.ic-lit{stroke:var(--glow);opacity:.5}
.ic-frame{stroke:var(--line-soft);opacity:.55}
.ic-plate{fill:var(--card-hi);stroke:var(--line-soft);stroke-width:1;vector-effect:non-scaling-stroke}
.ic-plate-edge{fill:none;stroke:var(--line);stroke-width:1;vector-effect:non-scaling-stroke}
.ic-hollow{fill:none;stroke:var(--line);stroke-width:1;vector-effect:non-scaling-stroke;opacity:.55;stroke-dasharray:3 4}
/* One hue per state, declared once on the pin group. Every part of a pin reads
   --pin from its parent, so hover and the build animation never have to know
   which state they are dressing, and a fourth state would be one line. */
.ic-pin-g        {--pin:var(--pin-open)}   /* open, nothing imminent */
.ic-pin-g.soon   {--pin:var(--pin-soon)}   /* due inside the window */
/* Urgent and overdue share the red. What separates them is that overdue
   breathes — see the blink below. */
.ic-pin-g.urgent {--pin:var(--pin-late)}   /* due today or tomorrow */
.ic-pin-g.hot    {--pin:var(--pin-late)}   /* past due */
.ic-pin-g.done   {--pin:var(--pin-done)}   /* closed */

/* Overdue blinks. A slow breath rather than a strobe: anything faster than
   about 3Hz is a seizure risk, and this needs to nag without being a hazard.
   Scoped with :not(.ic-armed) because this rule out-specifies the pin-pop
   entrance, and would otherwise replace it while the screen is still building. */
@keyframes pin-blink{0%,100%{opacity:1}50%{opacity:.3}}
.ic-still-pins .ic-pin-g.hot .ic-node,
.ic-still-pins .ic-pin-g.hot .ic-pip,
.ic-still-pins .ic-pin-g.hot .ic-stem{animation:none !important;opacity:1}
.ic-svg:not(.ic-armed) .ic-pin-g.hot .ic-node,
.ic-svg:not(.ic-armed) .ic-pin-g.hot .ic-pip,
.ic-svg:not(.ic-armed) .ic-pin-g.hot .ic-stem{
  animation:pin-blink 1500ms ease-in-out infinite}

/* An opaque fill punches a black hole in the wireframe, so a pin is a
   translucent plate — the mesh still shows through it. */
.ic-node{fill:var(--pin);fill-opacity:.72;stroke:var(--pin);stroke-width:2;vector-effect:non-scaling-stroke}
/* The white state sits closest in value to the --fg mesh it stands on, so it
   carries less fill and leans on its outline to stay a marker, not a blob. */
.ic-pin-g:not(.soon):not(.hot):not(.done) .ic-node{fill-opacity:.5}
.ic-pin-g:not(.soon):not(.hot):not(.done) .ic-shadow{fill-opacity:.4}
.ic-stem{fill:none;stroke:var(--pin);stroke-width:1.3;vector-effect:non-scaling-stroke;opacity:.9}
.ic-shadow{fill:var(--pin);fill-opacity:.55;stroke:none}
/* The plate is near-opaque now, so a pip in the plate's own colour was dead ink.
   Punched dark instead: it reads as a pin head without adding any brightness. */
.ic-pip{fill:var(--bg)}

/* While the ground flows into its new shape the pins would be standing at
   heights that no longer exist, so they step off and re-plant once it settles. */
.ic-morphing .ic-node,.ic-morphing .ic-pip,
.ic-morphing .ic-stem,.ic-morphing .ic-shadow{opacity:0;transition:opacity 80ms linear}
.ic-morphing .ic-label{opacity:.3;transition:opacity 120ms linear}
.ic-label{fill:var(--fg-dim);font-family:var(--font,ui-monospace,monospace);font-size:10px;letter-spacing:.02em}

/* hover readout */
.ic-hit{fill:transparent;stroke:none;pointer-events:all;cursor:default}
/* Hover brightens the hue a pin is already wearing rather than recolouring it
   grey, which used to throw the state away exactly when it was being read. */
.ic-node.is-active{fill-opacity:.95;stroke-width:2.7}
.ic-tip{pointer-events:none}
.ic-tip-box{fill:var(--card-hi);stroke:var(--line);stroke-width:1;vector-effect:non-scaling-stroke}
.ic-tip-t{fill:var(--fg);font-family:var(--font,ui-monospace,monospace);font-size:11px}
.ic-tip-m{fill:var(--fg-mid);font-family:var(--font,ui-monospace,monospace);font-size:9.5px}
.ic-s-halo{stop-color:var(--glow);stop-opacity:.17}
.ic-s-halo0{stop-color:var(--glow);stop-opacity:0}
.ic-s-wall{stop-color:var(--glow);stop-opacity:.15}
.ic-s-wallm{stop-color:var(--glow);stop-opacity:.05}
.ic-s-wall0{stop-color:var(--glow);stop-opacity:0}
.ic-s-fill{stop-color:var(--glow);stop-opacity:.24}
.ic-s-fillm{stop-color:var(--glow);stop-opacity:.08}
.ic-s-fill0{stop-color:var(--glow);stop-opacity:.01}
.ic-s-floor{stop-color:var(--glow);stop-opacity:.13}
.ic-s-floor0{stop-color:var(--glow);stop-opacity:0}
@keyframes ic-pulse{0%,100%{opacity:.5}50%{opacity:.8}}
.ic-pulse{opacity:.5;animation:ic-pulse 6s ease-in-out infinite}
.ic-still{opacity:.62;animation:none}

/* ---- assembly -----------------------------------------------------------
   The room builds floor-up: a clip reveal sweeps along the isometric vertical,
   so the plate lands first and the wall knits upward out of it. Layers then
   fade in sequence, and the entry nodes drop in last. Everything replays on
   navigation because the whole view subtree is remounted by key. */
@keyframes ic-layer{from{opacity:0}to{opacity:var(--ic-o,1)}}
/* The surface landing. transform + opacity only, so it stays on the compositor. */
@keyframes ic-rise{from{opacity:0;transform:translateY(7px)}to{opacity:1;transform:none}}
/* A pin being planted: it rises out of the plate, overshoots, and settles.
   The overshoot is what makes it read as a pop rather than a fade. */
@keyframes ic-pin{
  0%{opacity:0;transform:translateY(8px) scale(.2)}
  58%{opacity:1;transform:translateY(-2.5px) scale(1.15)}
  100%{opacity:1;transform:none}
}
/* Its stem grows upward out of the floor to meet it. */
@keyframes ic-stemup{from{transform:scaleY(0)}to{transform:scaleY(1)}}

/* Deliberately NOT a clip-path reveal on .ic-svg any more. clip-path cannot be
   composited, so animating it on the root re-rasterised all ~740 child nodes on
   every frame for 880ms. The staged group fades below already read as the thing
   assembling; the face layer keeps a short rise so it still lands rather than
   merely appearing. */

/* One animation per stage, on the wrapping group. The children keep their own
   resting opacity (.ic-cage is .3, .ic-mesh is .6) and group opacity multiplies
   with it, so nothing needed a per-element target value — which is why --ic-o
   is gone from these four. */
.is-building .ic-l-cage{animation:ic-layer 420ms linear 60ms both}
.is-building .ic-l-edge{animation:ic-layer 420ms linear 140ms both}
.is-building .ic-l-face{animation:ic-rise 460ms cubic-bezier(0.16,1,0.3,1) 240ms both}
.is-building .ic-l-mesh{animation:ic-layer 460ms linear 340ms both}

/* Pins arrive after the structure exists to receive them, and one at a time.
   --i is set inline per node; because the node list is depth-sorted for
   painting, the stagger runs from the far corner of the plate toward the viewer.

   --i is capped by the caller so a 40-entry case cannot run the tail of the
   sequence past the window in which these rules still apply.
   (No backticks in this comment: it lives inside a JS template literal.) */
/* Gated on .ic-armed, which this component sets on itself for the length of one
   pin sequence — NOT on the app's .is-building. That is what makes the pins
   replay every time the render mounts, including a case switch, rather than only
   on the initial screen build.

   --pin-base is set inline: long enough to wait out the room on first load,
   short on a case switch where the room is already standing. Computing it in JS
   rather than via a .is-building descendant selector matters — that class is
   removed partway through, and a selector keyed on it would swap the delay
   mid-flight and restart the animation. */
.ic-armed .ic-node,.ic-armed .ic-pip{
  transform-box:fill-box;transform-origin:50% 50%;
  animation:ic-pin 460ms cubic-bezier(0.34,1.4,0.5,1)
            calc(var(--pin-base,660ms) + var(--i,0) * var(--pin-step,50ms)) both}
.ic-armed .ic-stem{
  transform-box:fill-box;transform-origin:50% 100%;
  animation:ic-stemup 300ms cubic-bezier(0.16,1,0.3,1)
            calc(var(--pin-base,660ms) - 30ms + var(--i,0) * var(--pin-step,50ms)) both}
.ic-armed .ic-shadow{
  --ic-o:.55;
  animation:ic-layer 300ms linear
            calc(var(--pin-base,660ms) + 40ms + var(--i,0) * var(--pin-step,50ms)) both}
.is-building .ic-label{animation:ic-layer 420ms linear 820ms both}

@media (prefers-reduced-motion: reduce){
  .ic-pin-g.hot .ic-node,.ic-pin-g.hot .ic-pip,.ic-pin-g.hot .ic-stem{
    animation:none !important;opacity:1}
  .ic-pulse{animation:none;opacity:.62}
  .ic-g{transform:none !important}
  .ic-svg,.ic-face,.ic-mesh,.ic-cage,.ic-cage-edge,
  .ic-l-cage,.ic-l-edge,.ic-l-face,.ic-l-mesh,
  .ic-node,.ic-pip,.ic-stem,.ic-shadow,
  .ic-label{animation:none !important;clip-path:none !important;transform:none !important}
}
`;

/* --------------------------------------------------------------- component */

export default function IsoCase({ entries = [], completion = 0, className = '', seed = 0 }) {
  const rawId = useId();
  const uid = `ic${rawId.replace(/[^a-zA-Z0-9_-]/g, '')}`;

  const svgRef = useRef(null);
  const groupRef = useRef(null);

  const [prefs, setPrefs] = useState(readMotionPrefs);

  /* --- live subscription to the motion preferences ----------------------- */
  const sync = useCallback(() => {
    setPrefs((prev) => {
      const next = readMotionPrefs();
      return prev.reduced === next.reduced && prev.parallax === next.parallax ? prev : next;
    });
  }, []);

  useEffect(() => {
    let mql = null;
    try {
      mql = window.matchMedia(RM_QUERY);
    } catch {
      mql = null;
    }
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

  /* --- the parallax spring -----------------------------------------------
     One rAF loop. It writes style.transform imperatively and never touches
     state, so it can never cause a React re-render. It sleeps as soon as the
     spring reaches rest and is woken by the next pointer event.              */
  useEffect(() => {
    const g = groupRef.current;
    if (!g) return undefined;

    if (!prefs.parallax) {
      g.style.transform = '';
      return undefined;
    }

    const svg = svgRef.current;
    const host = (svg && svg.closest('.card')) || (svg && svg.parentElement) || svg;
    if (!host) return undefined;

    const MAX_Y = 7; // degrees on Y
    const MAX_X = 4; // degrees on X
    const STIFF = 0.08;
    const DAMP = 0.82;

    // A drift, coupled to the same spring, layered under the rotation. It keeps
    // the parallax legible if a browser declines to apply the SVG perspective
    // (where the tilt alone would flatten to a sub-1% squash). Scaled with the
    // rotation above so the two stay in proportion.
    const DRIFT_X = 8; // viewBox units
    const DRIFT_Y = 5;

    const s = { rx: 0, ry: 0, vx: 0, vy: 0, tx: 0, ty: 0 };
    let raf = 0;
    let alive = true;

    const write = () => {
      const dx = (s.ry / MAX_Y) * DRIFT_X;
      const dy = -(s.rx / MAX_X) * DRIFT_Y;
      g.style.transform =
        `translate(${dx.toFixed(3)}px, ${dy.toFixed(3)}px) ` +
        `rotateX(${s.rx.toFixed(3)}deg) rotateY(${s.ry.toFixed(3)}deg)`;
    };

    const step = () => {
      if (!alive) return;
      s.vx += (s.tx - s.rx) * STIFF;
      s.vx *= DAMP;
      s.rx += s.vx;
      s.vy += (s.ty - s.ry) * STIFF;
      s.vy *= DAMP;
      s.ry += s.vy;

      const settled =
        Math.abs(s.vx) < 0.0015 &&
        Math.abs(s.vy) < 0.0015 &&
        Math.abs(s.tx - s.rx) < 0.004 &&
        Math.abs(s.ty - s.ry) < 0.004;

      if (settled) {
        s.rx = s.tx;
        s.ry = s.ty;
        s.vx = 0;
        s.vy = 0;
        write();
        raf = 0;
        return;
      }
      write();
      raf = requestAnimationFrame(step);
    };

    const wake = () => {
      if (!alive || raf) return;
      raf = requestAnimationFrame(step);
    };

    const onMove = (e) => {
      const r = host.getBoundingClientRect();
      if (!r.width || !r.height) return;
      const nx = Math.max(-1, Math.min(1, ((e.clientX - r.left) / r.width) * 2 - 1));
      const ny = Math.max(-1, Math.min(1, ((e.clientY - r.top) / r.height) * 2 - 1));
      s.ty = nx * MAX_Y;
      s.tx = -ny * MAX_X;
      wake();
    };

    const onRest = () => {
      s.tx = 0;
      s.ty = 0;
      wake();
    };

    host.addEventListener('pointermove', onMove, { passive: true });
    host.addEventListener('pointerleave', onRest, { passive: true });
    host.addEventListener('pointercancel', onRest, { passive: true });

    return () => {
      alive = false;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      host.removeEventListener('pointermove', onMove);
      host.removeEventListener('pointerleave', onRest);
      host.removeEventListener('pointercancel', onRest);
      g.style.transform = '';
    };
  }, [prefs.parallax]);

  /* --- derived ------------------------------------------------------------ */
  const list = Array.isArray(entries) ? entries : [];
  const shown = Math.min(list.length, MAX_NODES);
  const overflow = list.length - shown;

  /* --- the pin sequence -------------------------------------------------
     While the gate is on the pins hold their first frame via `both`, so it is
     dropped once the sequence is spent — leaving it armed forever would strand
     them invisible if the animation could not run. Same fail-safe as the shell. */
  const [armed, setArmed] = useState(false);
  const [pinBase, setPinBase] = useState(PIN_BASE_COLD);
  const [pinStep, setPinStep] = useState(PIN_STEP);
  const armTimer = useRef(0);

  const armPins = useCallback((base, step) => {
    clearTimeout(armTimer.current);
    setPinBase(base);
    setPinStep(step);
    setArmed(true);
    // The gate has to outlast the animation it is gating, stagger included.
    const spent = base + PIN_STAGGER_CAP * step + PIN_POP_MS + 140;
    armTimer.current = setTimeout(() => setArmed(false), spent);
  }, []);

  /* --- the ground --------------------------------------------------------
     Depends on the seed and nothing else, so it survives every entry edit — it
     does not move when you log something. State rather than a memo because a
     case switch flows it into its new shape instead of replacing it. */
  const [terrain, setTerrain] = useState(() => buildTerrain(seed));
  const [morphing, setMorphing] = useState(false);

  /* Resolved after mount, since it has to be read off a live element. The first
     paint therefore goes out on color-mix and swaps to the ramp a frame later —
     the same colours either way, to within a rounding step nobody can see. */
  const [ramp, setRamp] = useState(null);
  const rampRef = useRef(null);
  useLayoutEffect(() => {
    const next = buildRamp(svgRef.current);
    rampRef.current = next;
    setRamp(next);
  }, [prefs.reduced]);
  // Read by the morph, which must not re-run just because the ground committed.
  const terrainRef = useRef(terrain);
  terrainRef.current = terrain;
  const seedRef = useRef(seed);

  useEffect(() => {
    if (seedRef.current === seed) return undefined;
    seedRef.current = seed;

    const from = terrainRef.current;
    const to = buildTerrain(seed);
    const svg = svgRef.current;
    const faceEls = svg ? svg.querySelectorAll('.ic-face') : null;
    const meshEls = svg ? svg.querySelectorAll('.ic-mesh') : null;

    /* Motion is off, or the DOM is not the shape this expects. Writing
       attributes into elements whose meaning is unverified would be worse than
       not animating, so take the plain swap instead. */
    if (
      prefs.reduced ||
      !faceEls || faceEls.length !== FACE_ORDER.length ||
      !meshEls || meshEls.length !== MESH_LINES.length
    ) {
      setTerrain(to);
      armPins(PIN_BASE_SWAP, PIN_STEP_SWAP);
      return undefined;
    }

    // A pop still in flight would out-rank the step-off, since an animation beats
    // a plain declaration.
    setArmed(false);
    setMorphing(true);

    const live = blankShape();
    let raf = 0;
    let t0 = 0;
    let landed = false;

    const step = (now) => {
      if (!t0) t0 = now;
      const p = Math.min(1, (now - t0) / MORPH_MS);
      writeMorph(from, to, easeMorph(p), faceEls, meshEls, live, rampRef.current);
      if (p < 1) {
        raf = requestAnimationFrame(step);
        return;
      }
      landed = true;
      // At p = 1 the DOM already holds `to` exactly, so this commit changes
      // nothing on screen — it only brings React's picture back in line with it.
      setTerrain(to);
      setMorphing(false);
      armPins(0, PIN_STEP_SWAP);   // the ground has settled: plant the new pins
    };
    raf = requestAnimationFrame(step);

    return () => {
      cancelAnimationFrame(raf);
      if (landed) return;
      /* Cut short, by a second switch or by unmount. The DOM is holding a shape
         React knows nothing about, so hand it the halfway ground as the new
         truth: the next morph then starts from what is actually on screen
         instead of snapping to a shape the eye never saw. heightAt stays with
         the case the pins were placed for, since they are hidden either way. */
      setTerrain({ ...to, H: live.H, heightAt: from.heightAt });
      setMorphing(false);
    };
  }, [seed, prefs.reduced, armPins]);

  const nodes = useMemo(
    () => buildNodes(list, shown, terrain.heightAt),
    [list, shown, terrain]
  );

  const c = Number.isFinite(completion) ? Math.max(0, Math.min(1, completion)) : 0;

  const idHalo = `${uid}-halo`;

  const open = list.filter((e) => e && e.tone !== 'done').length;
  const label =
    list.length === 0
      ? 'Isometric case view — no entries'
      : `Isometric case view — ${open} open ${open === 1 ? 'entry' : 'entries'}, ${Math.round(
          c * 100
        )}% complete`;

  const haloClass = prefs.reduced ? 'ic-still' : 'ic-pulse';

  // Which node is under the pointer, held as an ID and re-resolved against the
  // current nodes every render.
  //
  // Deliberately NOT the node object with an effect that clears it when `nodes`
  // changes: the caller's entry list is memoised on the app clock, so `nodes`
  // gets a fresh identity every second, and clearing on that wiped the readout
  // roughly once a second while you were still reading it. Resolving by ID
  // survives the churn, and a node that genuinely disappears resolves to null
  // on its own with no effect needed.
  const [hotId, setHotId] = useState(null);
  const hot = hotId == null ? null : nodes.find((n) => n.id === hotId) || null;

  /* Armed once on mount. A case switch no longer remounts this component, so the
     re-plant is driven off the morph landing instead.

     The wait is measured, not assumed: on a cold screen the room is still
     assembling and the pins hold back for it; otherwise they land almost at once. */
  useLayoutEffect(() => {
    const svg = svgRef.current;
    const cold = !!(svg && svg.closest('.view.is-building'));
    armPins(cold ? PIN_BASE_COLD : PIN_BASE_SWAP, cold ? PIN_STEP : PIN_STEP_SWAP);
    return () => clearTimeout(armTimer.current);
  }, [armPins]);

  return (
    <svg
      ref={svgRef}
      className={
        `ic-svg${armed ? ' ic-armed' : ''}${morphing ? ' ic-morphing' : ''}` +
        /* The blink is the one animation here that runs forever, so the app's
           own reduced-motion setting has to be able to stop it — a media query
           alone would only honour the OS preference. */
        `${prefs.reduced ? ' ic-still-pins' : ''}${className ? ` ${className}` : ''}`
      }
      viewBox={`0 0 ${VB_W} ${VB_H}`}
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label={label}
      style={{
        perspective: '1100px',
        perspectiveOrigin: '50% 42%',
        '--pin-base': `${pinBase}ms`,
        '--pin-step': `${pinStep}ms`,
      }}
    >
      <style>{CSS}</style>

      <defs>
        {/* An elliptical wash behind the lit panel. Painted on a full-bleed rect
            so it fades to nothing well inside the viewBox — no clipped edge —
            and so the group's fill-box is exactly the viewBox, which puts the
            parallax pivot dead centre. */}
        <radialGradient
          id={idHalo}
          gradientUnits="userSpaceOnUse"
          cx="230"
          cy="112"
          r="215"
          gradientTransform="matrix(1 0 0 0.493 0 56.78)"
        >
          <stop offset="0" className="ic-s-halo" />
          <stop offset="0.55" className="ic-s-wallm" />
          <stop offset="1" className="ic-s-halo0" />
        </radialGradient>
      </defs>

      {/* everything that moves lives inside this single wrapper group */}
      <g ref={groupRef} className="ic-g">
        {/* ambient halo behind the structure — the slow 6s pulse */}
        <rect
          x="0"
          y="0"
          width={VB_W}
          height={VB_H}
          fill={`url(#${idHalo})`}
          className={haloClass}
        />

        {/* ---- the cage: gridded back walls and floor, behind the sheet */}
        {/* Each build stage is wrapped in one group so the assembly can animate
            four elements instead of ~740. Measured: the flat version put 736
            individual opacity animations on screen at once, which was most of
            the 852 running animations during a screen build and cost frames up
            to 100ms. Group opacity also composites as a single layer, where
            per-node opacity repainted every node every frame.

            Document order is untouched, so the painter's far-to-near ordering
            and the .ic-face index-to-cell mapping the morph relies on both
            still hold. */}
        <g className="ic-l-cage">
          {CAGE_WALL.map((l) => (
            <line key={l.key} className="ic-ln ic-cage" x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2} />
          ))}
          {CAGE_FLOOR.map((l) => (
            <line key={l.key} className="ic-ln ic-cage" x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2} />
          ))}
        </g>

        <g className="ic-l-edge">
          {CAGE_EDGE.map((e) => (
            <polyline key={e.key} className="ic-ln ic-cage-edge" points={e.pts} />
          ))}
        </g>

        {/* ---- the surface, far to near ------------------------------------
             Shaded cells first (painter's algorithm — SVG has no z-buffer, so a
             wrong order shows as a far crest drawn over a near one), then the
             mesh riding over them. */}
        <g className="ic-l-face">
          {terrain.faces.map((f) => (
            <polygon
              key={f.key}
              className="ic-face"
              points={f.pts}
              style={{ fill: faceFill(f.pct, ramp) }}
            />
          ))}
        </g>

        <g className="ic-l-mesh">
          {terrain.mesh.map((l) => (
            <polyline key={l.key} className="ic-ln ic-mesh" points={l.pts} />
          ))}
        </g>

        {/* ---- entries ---- */}
        {nodes.length === 0 ? (
          <polygon className="ic-hollow" points={squarePts(S / 2, S / 2, 0, 0.85)} />
        ) : (
          nodes.map((n, i) => {
            const on = hot && hot.id === n.id;
            return (
              // --i drives the per-pin stagger. Capped so the tail of a large
              // case still starts inside the build window.
              <g
                key={n.id}
                className={`ic-pin-g ${n.cls}`}
                style={{ '--i': Math.min(i, PIN_STAGGER_CAP) }}
              >
                <polygon className={`ic-shadow ${n.cls}`} points={n.shadow} />
                <line
                  className={`ic-stem ${n.cls}`}
                  x1={n.stem.x1}
                  y1={n.stem.y1}
                  x2={n.stem.x2}
                  y2={n.stem.y2}
                />
                <polygon className={`ic-node ${n.cls}${on ? ' is-active' : ''}`} points={n.cap} />
                <circle
                  className={`ic-pip ${n.cls}${on ? ' is-active' : ''}`}
                  cx={n.cx}
                  cy={n.cy}
                  r="1.4"
                />
                {/* A node cap is only ~12px across, so it gets a taller
                    invisible target spanning its stem — otherwise this is a
                    pixel hunt.

                    Deliberately no <title> here. The svg root is role="img",
                    which makes every descendant presentational, so a title
                    would buy nothing for assistive tech while still firing a
                    native browser tooltip on top of our own readout. The
                    accessible path is the root's aria-label plus the Entries
                    list, which already exposes every field in reading order —
                    which is also why these are not 40 extra tab stops. */}
                <rect
                  className="ic-hit"
                  x={n.cx - 17}
                  y={n.cy - 13}
                  width="34"
                  height={Math.max(22, n.stem.y1 + 9 - (n.cy - 13))}
                  onPointerEnter={() => setHotId(n.id)}
                  onPointerLeave={() => setHotId((p) => (p === n.id ? null : p))}
                />
              </g>
            );
          })
        )}
      </g>

      {/* The readout sits OUTSIDE the parallax group on purpose: glued to the
          tilt it would shear with it, and sheared 11px type is unreadable. It
          anchors to the node's untilted position, which is within a few px of
          where the pointer already is. */}
      {hot ? (
        <g className="ic-tip" aria-hidden="true">
          {(() => {
            const w = Math.max(hot.label.length * 6.5, hot.meta.length * 5.6) + 22;
            const h = 38;
            const x = Math.min(Math.max(hot.cx - w / 2, 8), VB_W - w - 8);
            const y = Math.max(hot.cy - h - 12, 8);
            return (
              <>
                <rect className="ic-tip-box" x={x} y={y} width={w} height={h} rx="7" />
                <text className="ic-tip-t" x={x + 11} y={y + 16}>
                  {hot.label}
                </text>
                <text className="ic-tip-m" x={x + 11} y={y + 29}>
                  {hot.meta}
                </text>
              </>
            );
          })()}
        </g>
      ) : null}

      {overflow > 0 ? (
        <text className="ic-label" x={VB_W - 10} y={VB_H - 8} textAnchor="end">
          {`+${overflow} more`}
        </text>
      ) : null}
    </svg>
  );
}

export { IsoCase };
