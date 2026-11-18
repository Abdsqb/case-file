/**
 * backdrops.js — the backgrounds the app can sit on.
 *
 * Two, each drawn by its own component, loaded only when it is picked:
 *
 *   Undertow       a dark sea of slats on WebGL2 (MicroSlats.jsx)
 *   Glass Current  ribbons of glass shards ray-traced on WebGPU (AeroShards.jsx)
 *
 * Streak.jsx mounts whichever is chosen. A backdrop is:
 *
 *   id, name, line   what Settings shows
 *   component        which component Streak mounts
 *   preview(ctx, W, H, colours, secs, reveal)
 *                    a sketch of it for the swatch in Settings, drawn on a full
 *                    window's geometry: neither component paints small
 */

/* The swatch sketch for the glass: three ribbons at three depths, drawing in
   from the left. Hands each shard's place, size, turn and weight to `draw`,
   which paints it. */
function currentSketch(W, H, secs, reveal, draw) {
  const ribbons = [
    { y0: 0.82, y1: 0.66, depth: 2, size: 10, alpha: 0.3 },
    { y0: 0.3, y1: 0.55, depth: 1, size: 15, alpha: 0.55 },
    { y0: 0.62, y1: 0.18, depth: 0, size: 22, alpha: 0.9 },
  ];
  for (const rb of ribbons) {
    for (let i = 0; i < 70; i += 1) {
      const h = (k) => { const v = Math.sin((i + 1) * k + rb.depth * 7.1) * 43758.5453; return v - Math.floor(v); };
      const s = (i / 70 + secs * 0.01 * (3 - rb.depth)) % 1;
      if (s > reveal * 1.15) continue;
      const x = W * (-0.05 + s * 1.1);
      const y = H * (rb.y0 + (rb.y1 - rb.y0) * s + 0.06 * Math.sin(s * 6.3 + rb.depth)) + (h(12.9) - 0.5) * H * 0.16;
      draw(x, y, rb.size * (0.6 + h(78.2)), h(39.4) * Math.PI * 2 + secs * 0.2, rb.alpha);
    }
  }
}

/* ===========================================================================
   The backdrops. The first is the default.
   =========================================================================== */

export const BACKDROPS = [
  /* ---- Undertow -----------------------------------------------------------
     A dark sea made of slats, swelling toward you from a horizon above the
     top edge, drawn by React Bits' MicroSlats on WebGL2 (MicroSlats.jsx).
     It ignores the cursor: the sea rolls on its own. */
  {
    id: 'slats',
    name: 'Undertow',
    line: 'A dark sea of tiny slats, rolling in.',
    component: 'slats',
    preview: (ctx, W, H, colours, secs, reveal) => {
      /* Half again the real slat size: at a fifth of the window, the real
         ones would read as a texture rather than slats. */
      const sw = 9;
      const sh = 27;
      const gap = 9;
      for (let y = 0; y < H; y += sh + gap) {
        if (y / H > reveal * 1.35) break;
        for (let x = 0; x < W; x += sw + gap) {
          const wave =
            0.6 * Math.sin(x * 0.011 + y * 0.006 - secs * 0.65) +
            0.4 * Math.sin(x * 0.004 - y * 0.012 + secs * 0.4);
          const level = Math.max(0, Math.min(1, 0.5 + 0.5 * wave));
          const lit = Math.pow(level, 1.6) * 0.9 + 0.06;
          ctx.fillStyle = `rgba(150, 142, 160, ${lit})`;
          ctx.beginPath();
          ctx.roundRect(x, y, sw, sh, sw / 2);
          ctx.fill();
        }
      }
    },
  },

  /* ---- Glass Current ------------------------------------------------------
     Objects riding ribbons at several depths: React Bits' AeroShards,
     ray-tracing real glass on WebGPU (AeroShards.jsx). Where WebGPU is not
     there, Streak falls back to Undertow. */
  {
    id: 'shards',
    name: 'Glass Current',
    line: 'Ribbons of glass shards drifting through depth.',
    component: 'shards',
    preview: (ctx, W, H, colours, secs, reveal) => {
      const [r, g, b] = colours.main;
      currentSketch(W, H, secs, reveal, (x, y, size, turn, alpha) => {
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(turn);
        ctx.beginPath();
        ctx.moveTo(size, 0);
        ctx.lineTo(-size * 0.6, size * 0.32);
        ctx.lineTo(-size * 0.6, -size * 0.32);
        ctx.closePath();
        ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${alpha * 0.35})`;
        ctx.fill();
        ctx.strokeStyle = `rgba(255, 255, 255, ${alpha * 0.55})`;
        ctx.lineWidth = 1.6;
        ctx.stroke();
        ctx.restore();
      });
    },
  },
];

export const DEFAULT_BACKDROP = BACKDROPS[0].id;

/** A backdrop by id; anything unknown (one since removed, say) is the default. */
export function backdropById(id) {
  return BACKDROPS.find((b) => b.id === id) || BACKDROPS[0];
}

/* Read from the stylesheet. Every colour in this app is written down in
   exactly one place, and the canvas is not exempt. Parsed to channels once. */
export function readColours() {
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
  const hex = /^#([0-9a-f]{6})$/i.exec(raw);
  if (!hex) return { main: [169, 139, 255] };
  const n = parseInt(hex[1], 16);
  return { main: [(n >> 16) & 255, (n >> 8) & 255, n & 255] };
}

/**
 * One still frame of a backdrop, in miniature, through Canvas 2D — for the
 * swatches in Settings. Laid out on a full window's geometry and scaled down,
 * so the composition is the real one.
 */
export function paintStill(canvas, backdrop, colours, { width, height, secs = 0, reveal = 1 } = {}) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const W = 1440;
  const H = (W * height) / width;
  const k = (width / W) * dpr;
  ctx.setTransform(k, 0, 0, k, 0, 0);
  backdrop.preview(ctx, W, H, colours, secs, reveal);
}
