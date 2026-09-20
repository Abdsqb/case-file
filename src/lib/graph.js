/**
 * graph.js — turning cases into nodes and links.
 *
 * The Case-structure diagram is a node graph, and this is the one place that
 * decides what a node IS. Both screens call it, so the Case files view and the
 * dashboard can never disagree about the shape of the same case.
 *
 * The hierarchy in this app is four deep and the middle level is easy to get
 * wrong:
 *
 *   case        a project with parentId === null
 *   sub-case    a SEPARATE project whose parentId is the case — not nested
 *   entry       a task belonging to either of the above
 *   subtask     a task with parentTaskId set
 *
 * Every link runs between a parent and its child, so links are within a case by
 * construction. That matters: the dashboard is asked to show every case at once
 * with links only between nodes of the same case, and rather than filter for
 * that afterwards — which would be a rule that could drift out of step with the
 * builder — there is simply never an edge that could cross.
 */

import { urgencyTone } from './metrics.js';

/** Node ids are namespaced: a project and a task can share a numeric id. */
const projectNode = (id) => `p:${id}`;
const taskNode = (id) => `t:${id}`;

/* The five states a pin used to carry, unchanged — the diagram is different but
   what it says about an entry is not. statusTone owns the windows, so this can
   never disagree with the "due within Nd" copy elsewhere. */
function toneOf(task, now) {
  if (task.completed) return 'done';
  const t = urgencyTone(task.dueDate, now);
  if (t === 'overdue') return 'overdue';
  if (t === 'urgent') return 'urgent';
  if (t === 'soon') return 'soon';
  return 'normal';
}

function toTime(value) {
  if (value == null) return null;
  const n = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * buildGraph(projects, { rootId, now, focus })
 *
 *   rootId  a case id  → that case and its sub-cases, one cluster
 *           null       → every case, one cluster each
 *   focus   true       → closed entries are left out entirely
 *
 * Returns { nodes, links, groups, counts }. `groups` is the ordered list of
 * root case ids, which the layout uses to seed cluster positions.
 */
export function buildGraph(projects, { rootId = null, now = Date.now(), focus = false } = {}) {
  const all = Array.isArray(projects) ? projects.filter(Boolean) : [];
  const byId = new Map(all.map((p) => [p.id, p]));

  /* A project is a root if it has no parent, or if its parent is missing from
     the payload — an orphan is still worth drawing, and dropping it silently is
     how a case disappears with no error anywhere. */
  const isRoot = (p) => !p.parentId || !byId.has(p.parentId);

  const roots = rootId
    ? all.filter((p) => p.id === rootId)
    : all.filter(isRoot);

  const nodes = [];
  const links = [];
  const groups = [];
  const counts = { cases: 0, subcases: 0, entries: 0, subtasks: 0, overdue: 0, done: 0 };

  for (const root of roots) {
    const group = root.id;
    groups.push(group);
    counts.cases += 1;

    /* Every node this case ends up owning, so the mesh below can join each of
       them to all the others. */
    const mine = [];

    mine.push(projectNode(root.id));
    nodes.push({
      id: projectNode(root.id),
      label: root.name || 'Untitled',
      kind: 'case',
      tone: 'structure',
      group,
      caseName: root.name || 'Untitled',
      parentLabel: null,
      dueDate: null,
      completed: false,
    });

    const subs = all.filter((p) => p.parentId === root.id);

    /* The case's own entries hang off the case; a sub-case's entries hang off
       the sub-case. Same walk either way, so it is one function. */
    const addTasks = (owner, ownerNodeId, ownerLabel) => {
      const tasks = Array.isArray(owner.tasks) ? owner.tasks : [];
      for (const task of tasks) {
        if (!task) continue;
        const done = !!task.completed;
        if (focus && done) continue;

        const due = toTime(task.dueDate);
        const tone = toneOf({ completed: done, dueDate: due }, now);
        if (tone === 'overdue') counts.overdue += 1;
        if (tone === 'done') counts.done += 1;
        counts.entries += 1;

        const nodeId = taskNode(task.id);
        mine.push(nodeId);
        nodes.push({
          id: nodeId,
          label: task.title || 'Untitled',
          kind: 'entry',
          tone,
          group,
          caseName: ownerLabel,
          parentLabel: null,
          dueDate: due,
          completed: done,
        });
        /* The tier an edge lands in, so the drawing can say in the line itself
           how deep a thing hangs — solid down to an entry, dashed below it. */
        links.push({ source: ownerNodeId, target: nodeId, group, tier: 'entry' });

        const subtasks = Array.isArray(task.subtasks) ? task.subtasks : [];
        for (const sub of subtasks) {
          if (!sub) continue;
          const subDone = !!sub.completed;
          if (focus && subDone) continue;

          const subDue = toTime(sub.dueDate);
          const subTone = toneOf({ completed: subDone, dueDate: subDue }, now);
          if (subTone === 'overdue') counts.overdue += 1;
          if (subTone === 'done') counts.done += 1;
          counts.subtasks += 1;

          const subId = taskNode(sub.id);
          mine.push(subId);
          nodes.push({
            id: subId,
            label: sub.title || 'Untitled',
            kind: 'subtask',
            tone: subTone,
            group,
            caseName: ownerLabel,
            parentLabel: task.title || 'Untitled',
            dueDate: subDue,
            completed: subDone,
          });
          links.push({ source: nodeId, target: subId, group, tier: 'subtask' });
        }
      }
    };

    addTasks(root, projectNode(root.id), root.name || 'Untitled');

    for (const sub of subs) {
      counts.subcases += 1;
      const subNodeId = projectNode(sub.id);
      mine.push(subNodeId);
      nodes.push({
        id: subNodeId,
        label: sub.name || 'Untitled',
        kind: 'subcase',
        tone: 'structure',
        group,
        caseName: root.name || 'Untitled',
        parentLabel: root.name || 'Untitled',
        dueDate: null,
        completed: false,
      });
      links.push({ source: projectNode(root.id), target: subNodeId, group, tier: 'subcase' });
      addTasks(sub, subNodeId, sub.name || 'Untitled');
    }

    /* The mesh: inside a case, everything joins everything.

       The parent-to-child edges above are kept and stay marked with their tier,
       because they are what the layout leans on and what tells a reader the
       hierarchy — the mesh is drawn far fainter on top of them. Pairs already
       joined by the spine are skipped, so no two nodes carry a doubled line.

       This is still within one case: the mesh is built from one case's own node
       list, so no edge it adds can cross to another. */
    const spine = new Set();
    for (const l of links) {
      if (l.group !== group) continue;
      spine.add(l.source < l.target ? `${l.source}|${l.target}` : `${l.target}|${l.source}`);
    }
    for (let i = 0; i < mine.length; i += 1) {
      for (let j = i + 1; j < mine.length; j += 1) {
        const a = mine[i];
        const c = mine[j];
        const key = a < c ? `${a}|${c}` : `${c}|${a}`;
        if (spine.has(key)) continue;
        links.push({ source: a, target: c, group, tier: 'mesh' });
      }
    }
  }

  return { nodes, links, groups, counts };
}

/**
 * An adjacency map, built once, so hovering a node can light its neighbours
 * without walking every link on every pointer move.
 */
export function neighbourMap(links) {
  const map = new Map();
  const touch = (a, b) => {
    let set = map.get(a);
    if (!set) { set = new Set(); map.set(a, set); }
    set.add(b);
  };
  for (const l of links) { touch(l.source, l.target); touch(l.target, l.source); }
  return map;
}
