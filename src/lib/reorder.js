/* ============================================================================
   Turning a drag into API calls.

   The strips show cases in tree order — roots, each followed by its children —
   but `POST /api/projects/:id/move` can only swap a case with an ADJACENT
   SIBLING. So the index something was dropped at is not, on its own, a
   destination the server can act on.

   This translates one into the other: simulate the move in strip order, read
   back what position that implies among the dragged case's own siblings, and
   report the single-step swaps needed to get there.

   Shared by the Case files strip and the Reporting filter so the two can never
   disagree about what a drag means.
============================================================================ */

/**
 * @param {Array<{id: string|number, parentId?: string|number|null}>} ordered
 *        The cases exactly as the strip lists them, pseudo-entries excluded.
 * @param {string|number} id      the case being moved
 * @param {number} toIndex        its destination index within `ordered`
 * @returns {{direction: 'up'|'down', steps: number} | null}
 *          null when nothing should move — including a drop that would only
 *          shuffle it past another parent's children, which must NOT silently
 *          reparent anything.
 */
export function siblingWalk(ordered, id, toIndex) {
  if (!Array.isArray(ordered) || ordered.length < 2) return null;

  const from = ordered.findIndex((p) => p && p.id === id);
  if (from === -1) return null;

  const target = Math.max(0, Math.min(Number(toIndex), ordered.length - 1));
  if (target === from) return null;

  const moved = ordered[from];
  const next = ordered.slice();
  next.splice(from, 1);
  next.splice(target, 0, moved);

  const parent = moved.parentId ?? null;
  const sibs = (arr) => arr.filter((p) => p && (p.parentId ?? null) === parent);

  const oldPos = sibs(ordered).findIndex((p) => p.id === id);
  const newPos = sibs(next).findIndex((p) => p.id === id);
  const steps = newPos - oldPos;
  if (!steps || oldPos === -1 || newPos === -1) return null;

  return { direction: steps > 0 ? 'down' : 'up', steps: Math.abs(steps) };
}

/**
 * Run a walk against the API. `move` is called once per step and awaited in
 * order — each swap depends on the previous one having landed.
 *
 * @param {(id, direction) => Promise<unknown>} move
 */
export async function applyWalk(move, id, walk) {
  if (!walk) return false;
  for (let i = 0; i < walk.steps; i += 1) {
    await move(id, walk.direction);
  }
  return true;
}
